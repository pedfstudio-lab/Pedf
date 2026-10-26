import wasmLocation from '@neslinesli93/qpdf-wasm/dist/qpdf.wasm?url';
import { encryptPdfBytes } from './engine';
import { LockPdfError, type LockRequest, type LockResponse } from './protocol';

// qpdf's CLI diagnostics belong to this disposable worker, never to application logs.
console.log = console.warn = console.error = () => {};
const workerScope = self as unknown as {
  onmessage: ((event: MessageEvent<LockRequest>) => void) | null;
  postMessage(message: LockResponse, transfer?: Transferable[]): void;
  close(): void;
};
workerScope.onmessage = async (event: MessageEvent<LockRequest>) => {
  const request = event.data;
  try {
    const output = await encryptPdfBytes(new Uint8Array(request.bytes), request.password, wasmLocation,
      phase => workerScope.postMessage({ type: 'progress', phase } satisfies LockResponse));
    const bytes = output.buffer as ArrayBuffer;
    workerScope.postMessage({ type: 'done', bytes } satisfies LockResponse, [bytes]);
  } catch (error) {
    workerScope.postMessage({ type: 'error', code: error instanceof LockPdfError ? error.code : 'failed' } satisfies LockResponse);
  } finally {
    request.password = '';
    new Uint8Array(request.bytes).fill(0);
    workerScope.close();
  }
};
