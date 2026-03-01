import { env, pipeline } from "@huggingface/transformers";

export interface LocalOnnxEmbedderOptions {
  model: string;
  dimensions?: number;
  cacheDir?: string;
}

/**
 * Local ONNX embedder using transformers.js.
 *
 * This class is intended to run inside the embedding worker thread.
 */
export class LocalOnnxEmbedder {
  private extractor: Awaited<ReturnType<typeof pipeline>> | null = null;

  constructor(private readonly options: LocalOnnxEmbedderOptions) {}

  async embed(texts: string[]): Promise<Float32Array[]> {
    if (texts.length === 0) return [];

    const extractor = await this.getExtractor();

    const output = await extractor(texts, {
      pooling: "mean",
      normalize: true,
    });

    const matrix = tensorToMatrix(output);
    const vectors = matrix.map((row) => {
      const v = new Float32Array(row);
      return this.options.dimensions ? trimOrPad(v, this.options.dimensions) : v;
    });

    return vectors;
  }

  private async getExtractor() {
    if (this.extractor) return this.extractor;

    // keep runtime deterministic/local
    env.allowRemoteModels = true;
    env.allowLocalModels = true;

    if (this.options.cacheDir) {
      env.cacheDir = this.options.cacheDir;
    }

    this.extractor = await pipeline("feature-extraction", this.options.model, {
      dtype: "fp32",
    });

    return this.extractor;
  }
}

function tensorToMatrix(value: any): number[][] {
  // Common transformers.js return shape: Tensor with tolist()
  if (value && typeof value.tolist === "function") {
    const asList = value.tolist();
    if (Array.isArray(asList) && Array.isArray(asList[0])) {
      return asList as number[][];
    }
    if (Array.isArray(asList)) {
      return [asList as number[]];
    }
  }

  // Sometimes data may already be array-ish
  if (Array.isArray(value) && Array.isArray(value[0])) {
    return value as number[][];
  }

  if (Array.isArray(value)) {
    return [value as number[]];
  }

  throw new Error("Unexpected ONNX embedding output format");
}

function trimOrPad(input: Float32Array, dimensions: number): Float32Array {
  if (input.length === dimensions) return input;
  if (input.length > dimensions) return input.slice(0, dimensions);

  const out = new Float32Array(dimensions);
  out.set(input);
  return out;
}
