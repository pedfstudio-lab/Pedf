import { exportPagePreview, PagePreviewSource } from './exportPagePreview';
import type { PagePreviewRequest } from './exportPagePreview';
import { registerPdfJsFontReference } from './embeddedFont';

let source: PagePreviewSource | undefined;
let queue = Promise.resolve();
const latest = new Map<number, number>();
const scope = globalThis as unknown as {
  onmessage: ((event: MessageEvent) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
};
scope.onmessage = (event) => {
  const { id, bytes, request, sourceIndex, fonts } = event.data as {
    id: number; bytes?: Uint8Array; request?: PagePreviewRequest; sourceIndex?: number;
    fonts?: readonly { ref: string; value: unknown }[];
  };
  if (request) latest.set(request.pageIndex, id);
  queue = queue.then(async () => {
    try {
      if (request && latest.get(request.pageIndex) !== id) {
        scope.postMessage({ id, superseded: true });
        return;
      }
      if (bytes) source = new PagePreviewSource(bytes);
      if (!source) throw new Error('Preview worker has no source document.');
      for (const font of fonts ?? []) registerPdfJsFontReference(font.ref, font.value);
      if (!request) { await source.prepare(sourceIndex); scope.postMessage({ id }); return; }
      const result = await exportPagePreview({ ...request, document: { ...request.document, originalBytes: source.bytes } }, source);
      scope.postMessage({ id, result }, [result.bytes.buffer as ArrayBuffer]);
    } catch (error) { scope.postMessage({ id, error: error instanceof Error ? error.message : String(error) }); }
  });
};
