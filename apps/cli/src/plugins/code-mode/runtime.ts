import variant from "@jitl/quickjs-singlefile-browser-release-sync"
import {
  newQuickJSWASMModuleFromVariant,
  type QuickJSDeferredPromise,
  type QuickJSWASMModule,
} from "quickjs-emscripten-core"
import { withAbortSignal } from "../../lib/abort"
import { describeError } from "../../lib/error"
import { isJsonObject } from "../../lib/json"
import type { ToolInvoker } from "../../tools/programmatic"

let module: Promise<QuickJSWASMModule> | undefined

export async function runCode(code: string, callTool: ToolInvoker, signal: AbortSignal): Promise<string> {
  const quickjs = await (module ??= newQuickJSWASMModuleFromVariant(variant))
  signal.throwIfAborted()
  using vm = quickjs.newContext()
  vm.runtime.setMemoryLimit(64 * 1024 * 1024)
  vm.runtime.setMaxStackSize(512 * 1024)
  const controller = new AbortController()
  const childSignal = AbortSignal.any([signal, controller.signal])
  const pending = new Set<Promise<void>>()
  const deferred: QuickJSDeferredPromise[] = []
  const output: string[] = []
  let outputBytes = 0
  let cpuRemaining = 1_000
  let cpuDeadline = 0
  let failure: Error | undefined
  let closed = false
  vm.runtime.setInterruptHandler(() => childSignal.aborted || performance.now() >= cpuDeadline)

  const runGuest = <T>(run: () => T): T => {
    childSignal.throwIfAborted()
    if (cpuRemaining <= 0) throw new Error("Code Mode exceeded one second of JavaScript execution")
    const start = performance.now()
    cpuDeadline = start + cpuRemaining
    try {
      return run()
    } catch (error) {
      childSignal.throwIfAborted()
      if (performance.now() >= cpuDeadline) {
        throw new Error("Code Mode exceeded one second of JavaScript execution", { cause: error })
      }
      throw error
    } finally {
      cpuRemaining -= performance.now() - start
    }
  }
  const fail = (error: unknown): Error => {
    failure ??= new Error(describeError(error), { cause: error })
    return failure
  }

  using invoke = vm.newFunction("invoke", (nameHandle, argsHandle) => {
    try {
      if (failure) throw failure
      if (deferred.length >= 32) throw new Error("Code Mode allows at most 32 child tool calls")
      if (vm.typeof(nameHandle) !== "string" || vm.typeof(argsHandle) !== "string") {
        throw new Error("callTool requires a tool name and JSON object arguments")
      }
      const name = vm.getString(nameHandle)
      const encoded = vm.getString(argsHandle)
      if (name.length > 128 || Buffer.byteLength(encoded) > 32 * 1024) {
        throw new Error("Code Mode tool arguments exceed their size limit")
      }
      const args: unknown = JSON.parse(encoded)
      if (!isJsonObject(args)) throw new Error("callTool arguments must be a JSON object")
      const promise = vm.newPromise()
      deferred.push(promise)
      const task = callTool(name, args, childSignal)
        .then(
          (text) => {
            if (closed) return
            using value = vm.newString(text)
            promise.resolve(value)
          },
          (error: unknown) => {
            if (closed) return
            using value = vm.newError(fail(error))
            promise.reject(value)
          },
        )
        .catch((error: unknown) => {
          fail(error)
        })
        .finally(() => pending.delete(task))
      pending.add(task)
      return promise.handle
    } catch (error) {
      throw fail(error)
    }
  })
  using emit = vm.newFunction("emit", (textHandle) => {
    try {
      if (failure) throw failure
      if (vm.typeof(textHandle) !== "string") throw new Error("emit requires a JSON-serializable value")
      const text = vm.getString(textHandle)
      outputBytes += Buffer.byteLength(text) + 1
      if (outputBytes > 32 * 1024) throw new Error("Code Mode emitted output exceeds 32 KiB")
      output.push(text)
    } catch (error) {
      throw fail(error)
    }
  })
  using setup = runGuest(() =>
    vm.unwrapResult(
      vm.evalCode(
        `(invoke, publish) => {
    const stringify = JSON.stringify;
    const AsyncFunction = (async function() {}).constructor;
    globalThis.callTool = (name, args) => invoke(name, stringify(args));
    globalThis.emit = value => publish(typeof value === "string" ? value : stringify(value));
    return code => new AsyncFunction(code)();
  }`,
        "code-mode.js",
      ),
    ),
  )
  using evaluate = runGuest(() => vm.unwrapResult(vm.callFunction(setup, vm.undefined, invoke, emit)))
  using source = vm.newString(code)

  try {
    using result = runGuest(() => vm.unwrapResult(vm.callFunction(evaluate, vm.undefined, source)))
    while (true) {
      if (failure) throw failure
      runGuest(() => vm.unwrapResult(vm.runtime.executePendingJobs(1)))
      const state = runGuest(() => vm.getPromiseState(result))
      if (state.type === "rejected") runGuest(() => vm.unwrapResult(state))
      if (state.type === "fulfilled") {
        state.value.dispose()
        if (pending.size > 0) throw new Error("Code Mode finished with unawaited tool calls; await every call")
        if (failure) throw failure
        return output.join("\n") || "(no output; use emit(value) to return results)"
      }
      if (vm.runtime.hasPendingJob()) {
        await Bun.sleep(0)
        continue
      }
      if (pending.size === 0) throw new Error("Code Mode is awaiting a promise with no pending tool calls")
      await withAbortSignal(childSignal, () => Promise.race(pending))
    }
  } finally {
    closed = true
    controller.abort()
    for (const promise of deferred) promise.dispose()
  }
}
