import { spawnSync } from "node:child_process";
import type { EmbedPriority, EmbeddingRuntimeProvider } from "./runtime.js";

type AccessTokenProvider = (opts?: { forceRefresh?: boolean }) => Promise<string>;

type SleepFn = (ms: number) => Promise<void>;

export interface VertexEmbeddingProviderOptions {
  projectId: string;
  location?: string;
  publisher?: string;
  model?: string;
  dimensions?: number;
  autoTruncate?: boolean;
  outputDimensions?: number;
  requestTimeoutMs?: number;
  maxRetries?: number;
  retryBaseDelayMs?: number;

  // testability / advanced overrides
  fetchImpl?: typeof fetch;
  tokenProvider?: AccessTokenProvider;
  sleepFn?: SleepFn;
}

/**
 * Vertex AI text embedding provider.
 *
 * Auth options (in order):
 * 1) VERTEX_ACCESS_TOKEN / GOOGLE_OAUTH_ACCESS_TOKEN env var
 * 2) `gcloud auth application-default print-access-token`
 */
export class VertexEmbeddingProvider implements EmbeddingRuntimeProvider {
  readonly modelId: string;
  readonly dimensions: number;

  private readonly projectId: string;
  private readonly location: string;
  private readonly publisher: string;
  private readonly model: string;
  private readonly autoTruncate: boolean;
  private readonly outputDimensions?: number;
  private readonly requestTimeoutMs: number;
  private readonly maxRetries: number;
  private readonly retryBaseDelayMs: number;

  private readonly fetchImpl: typeof fetch;
  private readonly tokenProvider: AccessTokenProvider;
  private readonly sleepFn: SleepFn;

  private inflight = 0;

  constructor(options: VertexEmbeddingProviderOptions) {
    this.projectId = options.projectId;
    this.location = options.location ?? "us-central1";
    this.publisher = options.publisher ?? "google";
    this.model = options.model ?? "text-embedding-005";
    this.autoTruncate = options.autoTruncate ?? true;
    this.outputDimensions = options.outputDimensions;

    this.requestTimeoutMs = Math.max(1000, options.requestTimeoutMs ?? 30000);
    this.maxRetries = Math.max(0, options.maxRetries ?? 2);
    this.retryBaseDelayMs = Math.max(25, options.retryBaseDelayMs ?? 250);

    this.fetchImpl = options.fetchImpl ?? fetch;
    this.tokenProvider = options.tokenProvider ?? defaultTokenProvider;
    this.sleepFn = options.sleepFn ?? sleep;

    this.dimensions = options.dimensions ?? options.outputDimensions ?? 768;
    this.modelId = `vertex/${this.model}`;
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    return this.embedWithPriority(texts, 1);
  }

  async embedWithPriority(texts: string[], _priority: EmbedPriority): Promise<Float32Array[]> {
    if (texts.length === 0) return [];

    this.inflight++;
    try {
      const endpoint = this.endpoint();
      const totalAttempts = this.maxRetries + 1;
      let token = await this.tokenProvider();

      for (let attempt = 0; attempt < totalAttempts; attempt++) {
        const responseOrError = await this.tryRequest(endpoint, token, texts);

        if (responseOrError instanceof Error) {
          if (attempt < totalAttempts - 1) {
            await this.sleepFn(this.backoffDelay(attempt));
            continue;
          }
          throw new Error(`Vertex embedding request failed: ${responseOrError.message}`);
        }

        const response = responseOrError;

        if (response.ok) {
          return this.parseEmbeddings(response, texts.length);
        }

        const status = response.status;
        const body = truncate(await safeText(response));

        // Token may be expired/revoked. Force refresh once before giving up.
        if ((status === 401 || status === 403) && attempt < totalAttempts - 1) {
          token = await this.tokenProvider({ forceRefresh: true });
          await this.sleepFn(this.backoffDelay(attempt));
          continue;
        }

        if (isRetriableStatus(status) && attempt < totalAttempts - 1) {
          await this.sleepFn(this.backoffDelay(attempt));
          continue;
        }

        throw new Error(
          `Vertex embedding request failed (${status}) [attempt ${attempt + 1}/${totalAttempts}]: ${body}`,
        );
      }

      throw new Error("Vertex embedding request exhausted retries");
    } finally {
      this.inflight--;
    }
  }

  isBusy(): boolean {
    return this.inflight > 0;
  }

  async close(): Promise<void> {
    // stateless
  }

  private endpoint(): string {
    return `https://${this.location}-aiplatform.googleapis.com/v1/projects/${this.projectId}/locations/${this.location}/publishers/${this.publisher}/models/${this.model}:predict`;
  }

  private async tryRequest(
    endpoint: string,
    token: string,
    texts: string[],
  ): Promise<Response | Error> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs);

    try {
      return await this.fetchImpl(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          instances: texts.map((text) => ({ content: text })),
          parameters: {
            autoTruncate: this.autoTruncate,
            ...(this.outputDimensions ? { outputDimensionality: this.outputDimensions } : {}),
          },
        }),
        signal: controller.signal,
      });
    } catch (error) {
      return error instanceof Error ? error : new Error(String(error));
    } finally {
      clearTimeout(timeout);
    }
  }

  private async parseEmbeddings(response: Response, expectedCount: number): Promise<Float32Array[]> {
    const json = (await response.json()) as { predictions?: unknown[] };

    const predictions = json.predictions ?? [];
    if (!Array.isArray(predictions) || predictions.length !== expectedCount) {
      throw new Error(
        `Vertex embedding response shape mismatch: expected ${expectedCount} predictions, got ${Array.isArray(predictions) ? predictions.length : "invalid"}`,
      );
    }

    return predictions.map((prediction, index) => {
      const values = extractEmbeddingValues(prediction);
      if (!values) {
        throw new Error(`Vertex embedding response missing vector for item ${index}`);
      }
      return new Float32Array(values);
    });
  }

  private backoffDelay(attempt: number): number {
    // exponential backoff capped at 4s
    const delay = Math.min(4000, this.retryBaseDelayMs * 2 ** attempt);
    return delay;
  }
}

function isRetriableStatus(status: number): boolean {
  return status === 408 || status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

async function defaultTokenProvider(_opts?: { forceRefresh?: boolean }): Promise<string> {
  const envToken = process.env.VERTEX_ACCESS_TOKEN ?? process.env.GOOGLE_OAUTH_ACCESS_TOKEN;
  if (envToken?.trim()) {
    return envToken.trim();
  }

  const gcloud = spawnSync("gcloud", ["auth", "application-default", "print-access-token"], {
    encoding: "utf-8",
  });

  if (gcloud.status !== 0 || !gcloud.stdout.trim()) {
    const stderr = gcloud.stderr?.toString().trim();
    throw new Error(
      "Unable to get Vertex access token. Set VERTEX_ACCESS_TOKEN (or GOOGLE_OAUTH_ACCESS_TOKEN) " +
      "or run `gcloud auth application-default login`." +
      (stderr ? ` gcloud error: ${stderr}` : ""),
    );
  }

  return gcloud.stdout.trim();
}

async function safeText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "<unable to read response body>";
  }
}

function truncate(text: string, max = 800): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}...`;
}

function extractEmbeddingValues(prediction: unknown): number[] | null {
  if (!prediction || typeof prediction !== "object") return null;
  const p = prediction as Record<string, unknown>;

  // observed shapes:
  // { embeddings: { values: number[] } }
  // { embedding: { values: number[] } }
  // { values: number[] }
  const candidates = [
    (p.embeddings as any)?.values,
    (p.embedding as any)?.values,
    p.values,
  ];

  for (const candidate of candidates) {
    if (Array.isArray(candidate) && candidate.every((v) => typeof v === "number")) {
      return candidate as number[];
    }
  }

  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
