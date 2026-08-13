/**
 * Runs a compute part's wasm guest under Node's WebAssembly with the same
 * JSON ABI as the app's wasmtime host: der_alloc(len) -> ptr, then
 * der_run(ptr, len) -> i64 packing (out_ptr << 32) | out_len, response
 * {"ok": {...}} or {"err": "..."}. Fresh instance per call, like the host.
 */

export async function runGuest(
  wasmBytes: Uint8Array,
  operation: string,
  inputs: unknown
): Promise<Record<string, unknown>> {
  const module = await WebAssembly.compile(wasmBytes as BufferSource);
  const instance = await WebAssembly.instantiate(module, {});
  const memory = instance.exports.memory as WebAssembly.Memory;
  const derAlloc = instance.exports.der_alloc as (len: number) => number;
  const derRun = instance.exports.der_run as (ptr: number, len: number) => bigint;

  const request = new TextEncoder().encode(JSON.stringify({ operation, inputs }));
  const ptr = derAlloc(request.length);
  if (ptr === 0) {
    throw new Error('Part could not allocate the request');
  }
  new Uint8Array(memory.buffer, ptr, request.length).set(request);

  const packed = BigInt.asUintN(64, derRun(ptr, request.length));
  const outPtr = Number(packed >> 32n);
  const outLen = Number(packed & 0xffffffffn);
  if (outPtr === 0 || outLen === 0) {
    throw new Error('Part returned an empty result');
  }
  const text = new TextDecoder().decode(new Uint8Array(memory.buffer, outPtr, outLen));
  const parsed = JSON.parse(text) as { ok?: Record<string, unknown>; err?: string };
  if (parsed.err !== undefined) {
    throw new Error(String(parsed.err));
  }
  if (!parsed.ok || typeof parsed.ok !== 'object') {
    throw new Error('Part result must be {"ok": {...}} or {"err": "..."}');
  }
  return parsed.ok;
}

/** The der envelope against a live instance's exports. */
function callEnvelope(
  instance: WebAssembly.Instance,
  operation: string,
  inputs: unknown
): Record<string, unknown> {
  const memory = instance.exports.memory as WebAssembly.Memory;
  const derAlloc = instance.exports.der_alloc as (len: number) => number;
  const derRun = instance.exports.der_run as (ptr: number, len: number) => bigint;

  const request = new TextEncoder().encode(JSON.stringify({ operation, inputs }));
  const ptr = derAlloc(request.length);
  if (ptr === 0) {
    throw new Error('Part could not allocate the request');
  }
  new Uint8Array(memory.buffer, ptr, request.length).set(request);

  const packed = BigInt.asUintN(64, derRun(ptr, request.length));
  const outPtr = Number(packed >> 32n);
  const outLen = Number(packed & 0xffffffffn);
  if (outPtr === 0 || outLen === 0) {
    throw new Error('Part returned an empty result');
  }
  const text = new TextDecoder().decode(new Uint8Array(memory.buffer, outPtr, outLen));
  const parsed = JSON.parse(text) as { ok?: Record<string, unknown>; err?: string };
  if (parsed.err !== undefined) {
    throw new Error(String(parsed.err));
  }
  if (!parsed.ok || typeof parsed.ok !== 'object') {
    throw new Error('Part result must be {"ok": {...}} or {"err": "..."}');
  }
  return parsed.ok;
}

/** Same ABI, synchronous: the kernel's host_call cannot await, so compute
 * parts run from a precompiled module with the sync constructors. */
export function runGuestSync(
  module: WebAssembly.Module,
  operation: string,
  inputs: unknown
): Record<string, unknown> {
  return callEnvelope(new WebAssembly.Instance(module, {}), operation, inputs);
}

/**
 * A WASI-importing guest (media and future grant-flow parts), mirroring the
 * desktop host: preopened /in and /out, no env, no args, reactor
 * initialization before the ABI entry points. The instance stays usable
 * across calls so job-scoped operations keep their state, exactly like the
 * host's job registry.
 */
export class WasiGuest {
  private instance: WebAssembly.Instance;

  constructor(module: WebAssembly.Module, preopens: Record<string, string>) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { WASI } = require('node:wasi') as typeof import('node:wasi');
    const wasi = new WASI({ version: 'preview1', preopens, args: [], env: {} });
    this.instance = new WebAssembly.Instance(
      module,
      wasi.getImportObject() as WebAssembly.Imports
    );
    wasi.initialize(this.instance as Parameters<typeof wasi.initialize>[0]);
  }

  call(operation: string, inputs: unknown): Record<string, unknown> {
    return callEnvelope(this.instance, operation, inputs);
  }
}
