import { UnlockPdfError, type UnlockResponse } from './protocol';

/** One worker per file. Terminating it drops its virtual files, WASM memory and the password copy. */
export function unlockPdf(bytes: Uint8Array, password: string, signal?: AbortSignal): Promise<Uint8Array> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    let worker: Worker;
    try { worker = new Worker(new URL('./unlockPdfWorker.ts', import.meta.url), { type: 'module' }); }
    catch { reject(new UnlockPdfError('unsupported')); return; }
    let settled = false;
    const finish = (error?: unknown, result?: Uint8Array) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
      worker.terminate();
      if (error) reject(error); else resolve(result!);
    };
    const abort = () => finish(new DOMException('Cancelled', 'AbortError'));
    const timeout = setTimeout(() => finish(new UnlockPdfError('failed')), 120_000);
    signal?.addEventListener('abort', abort, { once: true });
    worker.onmessage = (event: MessageEvent<UnlockResponse>) => {
      if (settled) return;
      const result = event.data;
      if (result.type === 'done') finish(undefined, new Uint8Array(result.bytes));
      else if (result.type === 'error') finish(new UnlockPdfError(result.code));
    };
    worker.onerror = event => { event.preventDefault(); finish(new UnlockPdfError('failed')); };
    worker.onmessageerror = () => finish(new UnlockPdfError('failed'));
    try {
      const input = Uint8Array.from(bytes).buffer;
      worker.postMessage({ bytes: input, password }, [input]);
    } catch { finish(new UnlockPdfError('failed')); }
    if (signal?.aborted) abort();
  });
}
