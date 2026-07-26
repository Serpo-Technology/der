/**
 * Loader for the runtime kernel's wasm build: the same der_alloc/der_run
 * JSON envelope the parts speak, plus the one `env.host_call` import the
 * kernel uses for operation dispatch and entropy. Hosts hand in the binary
 * bytes (fs in Node, fetch in a browser) and a synchronous host handler;
 * everything semantic happens inside the module.
 */

export type KernelRequest = Record<string, unknown> & { operation: string };

export interface KernelHost {
  /** Answers dispatch and env requests; must be synchronous. */
  call(request: KernelRequest): { ok?: unknown; err?: string };
}

export interface KernelInstance {
  run(request: KernelRequest): unknown;
}

export async function instantiateKernel(
  bytes: BufferSource,
  host?: KernelHost
): Promise<KernelInstance> {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let exportsRef: Record<string, unknown> = {};
  const memory = (): WebAssembly.Memory => exportsRef.memory as WebAssembly.Memory;

  const imports = {
    env: {
      host_call: (ptr: number, len: number): number => {
        let response: { ok?: unknown; err?: string };
        try {
          const request = JSON.parse(
            decoder.decode(new Uint8Array(memory().buffer, ptr, len))
          ) as KernelRequest;
          response = host ? host.call(request) : { err: 'No kernel host attached' };
        } catch (error) {
          response = { err: error instanceof Error ? error.message : String(error) };
        }
        const payload = encoder.encode(JSON.stringify(response));
        const alloc = exportsRef.der_alloc as (len: number) => number;
        const out = alloc(payload.length + 4);
        new DataView(memory().buffer).setUint32(out, payload.length, true);
        new Uint8Array(memory().buffer, out + 4, payload.length).set(payload);
        return out;
      },
    },
  };

  const { instance } = await WebAssembly.instantiate(bytes, imports);
  exportsRef = instance.exports as unknown as Record<string, unknown>;

  const alloc = exportsRef.der_alloc as (len: number) => number;
  const run = exportsRef.der_run as (ptr: number, len: number) => bigint;
  const free = exportsRef.der_free as (ptr: number, len: number) => void;

  return {
    run(request: KernelRequest): unknown {
      const payload = encoder.encode(JSON.stringify(request));
      const ptr = alloc(payload.length);
      new Uint8Array(memory().buffer, ptr, payload.length).set(payload);
      const packed = run(ptr, payload.length);
      const outPtr = Number(packed >> 32n);
      const outLen = Number(packed & 0xffffffffn);
      const text = decoder.decode(new Uint8Array(memory().buffer, outPtr, outLen));
      free(outPtr, outLen);
      const parsed = JSON.parse(text) as { ok?: unknown; err?: string };
      if (parsed.err !== undefined) {
        throw new Error(parsed.err);
      }
      return parsed.ok;
    },
  };
}
