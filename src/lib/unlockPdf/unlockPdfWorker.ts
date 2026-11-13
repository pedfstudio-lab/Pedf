import wasmLocation from '@neslinesli93/qpdf-wasm/dist/qpdf.wasm?url';
import { decryptPdfBytes } from './engine';
import { UnlockPdfError, type UnlockRequest, type UnlockResponse } from './protocol';

// qpdf's CLI diagnostics belong to this disposable worker, never to application logs.
console.log = console.warn = console.error = () => {};
const workerScope = self as unknown as {
  onmessage: ((event: MessageEvent<UnlockRequest>) => void) | null;
  postMessage(message: UnlockResponse, transfer?: Transferable[]): void;
  close(): void;
};
workerScope.onmessage = async (event: MessageEvent<UnlockRequest>) => {
  const request = event.data;
  try {
    const output = await decryptPdfBytes(new Uint8Array(request.bytes), request.password, wasmLocation);
    const bytes = output.buffer as ArrayBuffer;
    workerScope.postMessage({ type: 'done', bytes } satisfies UnlockResponse, [bytes]);
  } catch (error) {
    workerScope.postMessage({ type: 'error', code: error instanceof UnlockPdfError ? error.code : 'failed' } satisfies UnlockResponse);
  } finally {
    request.password = '';
    new Uint8Array(request.bytes).fill(0);
    workerScope.close();
  }
};
