import { getQuickJS, shouldInterruptAfterDeadline, type QuickJSWASMModule } from "quickjs-emscripten";

export interface SandboxOptions {
  input?: unknown;
  timeoutMs?: number;
  memoryLimitBytes?: number;
}

let quickJsModulePromise: Promise<QuickJSWASMModule> | null = null;

export async function runCodeSandbox(code: string, options: SandboxOptions = {}): Promise<unknown> {
  const timeoutMs = Math.max(10, options.timeoutMs ?? 5000);
  const memoryLimitBytes = Math.max(8 * 1024 * 1024, options.memoryLimitBytes ?? 64 * 1024 * 1024);

  const transpiler = new Bun.Transpiler({ loader: "ts" });
  const js = transpiler.transformSync(code);

  const QuickJS = await getQuickJsModule();
  const runtime = QuickJS.newRuntime();
  const context = runtime.newContext();

  try {
    runtime.setMemoryLimit(memoryLimitBytes);
    runtime.setMaxStackSize(1024 * 1024);
    runtime.setInterruptHandler(shouldInterruptAfterDeadline(Date.now() + timeoutMs));

    const inputJson = JSON.stringify(options.input ?? null);
    const inputHandle = context.newString(inputJson);
    context.setProp(context.global, "__INPUT_JSON__", inputHandle);
    inputHandle.dispose();

    const wrapped = `"use strict";
const __deepFreeze = (value) => {
  if (value === null || typeof value !== "object") return value;
  Object.freeze(value);
  for (const key of Object.keys(value)) {
    __deepFreeze(value[key]);
  }
  return value;
};
const input = __deepFreeze(JSON.parse(globalThis.__INPUT_JSON__));
let output = null;
${js}
globalThis.__OUTPUT__ = output;
`;

    const evalResult = context.evalCode(wrapped, "sandbox.ts");
    const resultHandle = context.unwrapResult(evalResult);
    resultHandle.dispose();

    while (runtime.hasPendingJob()) {
      const pending = runtime.executePendingJobs();
      if ("error" in pending && pending.error) {
        throw new Error(context.dump(pending.error));
      }
    }

    const outputHandle = context.getProp(context.global, "__OUTPUT__");
    const output = context.dump(outputHandle);
    outputHandle.dispose();

    return output;
  } catch (error) {
    if (error instanceof Error) {
      if (error.message.toLowerCase().includes("interrupted")) {
        throw new Error(`Sandbox execution timed out after ${timeoutMs}ms`);
      }
      throw error;
    }

    throw new Error(String(error));
  } finally {
    context.dispose();
    runtime.dispose();
  }
}

async function getQuickJsModule(): Promise<QuickJSWASMModule> {
  if (!quickJsModulePromise) {
    quickJsModulePromise = getQuickJS();
  }

  return quickJsModulePromise;
}
