import { parentPort, workerData } from "node:worker_threads";
import { MockEmbeddingProvider } from "./mock.js";

type EmbedRequest = {
  id: number;
  texts: string[];
};

type ResultMessage = {
  type: "result";
  id: number;
  vectors?: number[][];
  error?: string;
};

type ReadyMessage = {
  type: "ready";
  backend: "mock" | "onnx";
  modelId: string;
  warning?: string;
};

type WorkerMessage = ResultMessage | ReadyMessage;

type Backend = "mock" | "onnx";

type WorkerEmbeddingProvider = {
  embed(texts: string[]): Promise<Float32Array[]>;
};

const dimensions = (workerData?.dimensions as number | undefined) ?? 128;
const backend = ((workerData?.backend as Backend | undefined) ?? "mock") as Backend;
const model = (workerData?.model as string | undefined) ?? "Xenova/all-MiniLM-L6-v2";
const cacheDir = workerData?.cacheDir as string | undefined;
const fallbackToMock = (workerData?.fallbackToMock as boolean | undefined) ?? true;
const forceOnnxInitFailure = (workerData?.forceOnnxInitFailure as boolean | undefined) ?? false;

const providerPromise: Promise<{ provider: WorkerEmbeddingProvider; ready: ReadyMessage }> = createProvider();

if (!parentPort) {
  throw new Error("Embedding worker started without parentPort");
}

providerPromise
  .then((state) => {
    parentPort!.postMessage(state.ready satisfies WorkerMessage);
  })
  .catch((error) => {
    const ready: ReadyMessage = {
      type: "ready",
      backend,
      modelId: backend === "onnx" ? `local-onnx/${model}` : "local-mock/worker",
      warning: error instanceof Error ? error.message : String(error),
    };
    parentPort!.postMessage(ready satisfies WorkerMessage);
  });

parentPort.on("message", async (msg: EmbedRequest) => {
  const response: ResultMessage = { type: "result", id: msg.id };

  try {
    const state = await providerPromise;
    const vectors = await state.provider.embed(msg.texts);
    response.vectors = vectors.map((v) => Array.from(v));
  } catch (error) {
    response.error = error instanceof Error ? error.message : String(error);
  }

  parentPort!.postMessage(response satisfies WorkerMessage);
});

async function createProvider(): Promise<{ provider: WorkerEmbeddingProvider; ready: ReadyMessage }> {
  if (backend === "mock") {
    return {
      provider: new MockEmbeddingProvider(dimensions),
      ready: {
        type: "ready",
        backend: "mock",
        modelId: "local-mock/worker",
      },
    };
  }

  try {
    if (forceOnnxInitFailure) {
      throw new Error("Forced ONNX init failure");
    }

    const { LocalOnnxEmbedder } = await import("./local-onnx.js");
    const onnx = new LocalOnnxEmbedder({
      model,
      dimensions,
      cacheDir,
    });

    // Warmup once so we can fail fast and fallback before real requests.
    await onnx.embed(["warmup"]);

    return {
      provider: onnx,
      ready: {
        type: "ready",
        backend: "onnx",
        modelId: `local-onnx/${model}`,
      },
    };
  } catch (error) {
    if (!fallbackToMock) {
      throw error;
    }

    return {
      provider: new MockEmbeddingProvider(dimensions),
      ready: {
        type: "ready",
        backend: "mock",
        modelId: "local-mock/worker",
        warning: `ONNX unavailable, fallback to mock: ${error instanceof Error ? error.message : String(error)}`,
      },
    };
  }
}
