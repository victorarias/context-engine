import { Worker } from "node:worker_threads";
import type { EmbedPriority, EmbeddingRuntimeProvider } from "./runtime.js";

type Job = {
  id: number;
  texts: string[];
  priority: EmbedPriority;
  resolve: (vectors: Float32Array[]) => void;
  reject: (error: Error) => void;
};

type WorkerResultMessage = {
  type: "result";
  id: number;
  vectors?: number[][];
  error?: string;
};

type WorkerReadyMessage = {
  type: "ready";
  backend: "mock" | "onnx";
  modelId: string;
  warning?: string;
};

type WorkerMessage = WorkerResultMessage | WorkerReadyMessage;

export interface WorkerEmbeddingProviderOptions {
  dimensions?: number;
  maxPendingIndexJobs?: number;
  backend?: "mock" | "onnx";
  model?: string;
  cacheDir?: string;
  fallbackToMock?: boolean;
}

/**
 * Embedding provider backed by a worker thread.
 *
 * Priority queue:
 * - 0: search queries (latency-sensitive)
 * - 1: indexing batches (throughput-sensitive)
 */
export class WorkerEmbeddingProvider implements EmbeddingRuntimeProvider {
  modelId: string;
  readonly dimensions: number;

  private readonly worker: Worker;
  private readonly maxPendingIndexJobs: number;

  private queue: Job[] = [];
  private currentJob: Job | null = null;
  private nextId = 1;
  private waiters: Array<() => void> = [];

  private ready = false;
  private readyWarning?: string;

  constructor(options: WorkerEmbeddingProviderOptions = {}) {
    this.dimensions = options.dimensions ?? 128;
    this.maxPendingIndexJobs = Math.max(1, options.maxPendingIndexJobs ?? 2);

    const backend = options.backend ?? "mock";
    const model = options.model ?? "nomic-embed-text-v1.5";
    this.modelId = backend === "onnx" ? `local-onnx/${model}` : "local-mock/worker";

    const workerUrl = new URL("./worker-thread.ts", import.meta.url);
    this.worker = new Worker(workerUrl, {
      workerData: {
        dimensions: this.dimensions,
        backend,
        model,
        cacheDir: options.cacheDir,
        fallbackToMock: options.fallbackToMock ?? true,
      },
    });

    this.worker.on("message", (msg) => this.onWorkerMessage(msg as WorkerMessage));
    this.worker.on("error", (err) => this.failCurrentJob(err));
    this.worker.on("exit", (code) => {
      if (code !== 0) {
        this.failCurrentJob(new Error(`Embedding worker exited with code ${code}`));
      }
    });
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    return this.embedWithPriority(texts, 1);
  }

  async embedWithPriority(texts: string[], priority: EmbedPriority): Promise<Float32Array[]> {
    if (priority === 1) {
      await this.waitForIndexQueueCapacity();
    }

    return new Promise<Float32Array[]>((resolve, reject) => {
      const job: Job = {
        id: this.nextId++,
        texts,
        priority,
        resolve,
        reject,
      };

      this.queue.push(job);
      this.queue.sort((a, b) => a.priority - b.priority || a.id - b.id);
      this.schedule();
    });
  }

  isBusy(): boolean {
    return this.currentJob !== null || this.queue.length > 0;
  }

  getWarning(): string | undefined {
    return this.readyWarning;
  }

  async close(): Promise<void> {
    await this.worker.terminate();
  }

  private schedule(): void {
    if (this.currentJob || this.queue.length === 0 || !this.ready) return;

    const job = this.queue.shift()!;
    this.currentJob = job;
    this.worker.postMessage({ id: job.id, texts: job.texts });
  }

  private onWorkerMessage(msg: WorkerMessage): void {
    if (msg.type === "ready") {
      this.ready = true;
      this.modelId = msg.modelId;
      this.readyWarning = msg.warning;
      this.schedule();
      return;
    }

    if (!this.currentJob || this.currentJob.id !== msg.id) {
      return;
    }

    const job = this.currentJob;
    this.currentJob = null;

    if (msg.error) {
      job.reject(new Error(msg.error));
    } else {
      const vectors = (msg.vectors ?? []).map((arr) => new Float32Array(arr));
      job.resolve(vectors);
    }

    this.notifyQueueWaiter();
    this.schedule();
  }

  private failCurrentJob(error: Error): void {
    if (this.currentJob) {
      this.currentJob.reject(error);
      this.currentJob = null;
      this.notifyQueueWaiter();
    }

    while (this.queue.length > 0) {
      this.queue.shift()!.reject(error);
    }
  }

  private async waitForIndexQueueCapacity(): Promise<void> {
    while (this.pendingIndexJobs() >= this.maxPendingIndexJobs) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
  }

  private pendingIndexJobs(): number {
    const queued = this.queue.filter((job) => job.priority === 1).length;
    const active = this.currentJob?.priority === 1 ? 1 : 0;
    return queued + active;
  }

  private notifyQueueWaiter(): void {
    const waiter = this.waiters.shift();
    waiter?.();
  }
}
