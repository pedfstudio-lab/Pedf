import { LockPdfError, type LockProgress, type LockResponse } from './protocol';

/** One worker/realm per file. Termination drops its virtual files, WASM memory and password copies. */
export function lockPdf(bytes: Uint8Array, password: string, signal: AbortSignal,
  progress?: (phase: LockProgress) => void): Promise<Uint8Array> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    let worker: Worker;
    try { worker = new Worker(new URL('./lockPdfWorker.ts', import.meta.url), { type: 'module' }); }
    catch { reject(new LockPdfError('unsupported')); return; }
    let settled = false;
    const finish = (error?: unknown, result?: Uint8Array) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal.removeEventListener('abort', abort);
      worker.terminate();
      if (error) reject(error); else resolve(result!);
    };
    const abort = () => finish(new DOMException('Cancelled', 'AbortError'));
    const timeout = setTimeout(() => finish(new LockPdfError('failed')), 120_000);
    signal.addEventListener('abort', abort, { once: true });
    worker.onmessage = (event: MessageEvent<LockResponse>) => {
      if (settled) return;
      const result = event.data;
      if (result.type === 'progress') progress?.(result.phase);
      else if (result.type === 'done') finish(undefined, new Uint8Array(result.bytes));
      else if (result.type === 'error') finish(new LockPdfError(result.code));
    };
    worker.onerror = event => { event.preventDefault(); finish(new LockPdfError('failed')); };
    worker.onmessageerror = () => finish(new LockPdfError('failed'));
    try {
      const input = Uint8Array.from(bytes).buffer;
      worker.postMessage({ bytes: input, password }, [input]);
    } catch { finish(new LockPdfError('failed')); }
    if (signal.aborted) abort();
  });
}
