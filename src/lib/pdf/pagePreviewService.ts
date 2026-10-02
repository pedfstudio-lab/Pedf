import type { LoadedDocument } from './loadDocument';
import { exportPagePreview, PagePreviewSource } from '@/lib/export/exportPagePreview';
import type { PagePreviewRequest, PagePreviewResult } from '@/lib/export/exportPagePreview';

/** One worker/source per open document, shared by its pages and released with the last page. */
export class PagePreviewService {
  private worker?: Worker;
  private sequence = 0;
  private pending = new Map<number, { resolve(value: PagePreviewResult | undefined): void; reject(error: Error): void }>();
  private initialized?: Promise<PagePreviewResult | undefined>;
  private prepared = new Map<number, Promise<void>>();
  private disposed = false;
  private workerAttempted = false;
  private mainSource: PagePreviewSource;

  get workerEnabled(): boolean { return this.worker !== undefined; }

  constructor(private readonly loaded: LoadedDocument) {
    this.mainSource = new PagePreviewSource(loaded.originalBytes, loaded.doc);
  }

  private startWorker(): void {
    if (this.workerAttempted || this.disposed) return;
    this.workerAttempted = true;
    if (typeof Worker === 'undefined') return;
    try {
      this.worker = new Worker(new URL('../export/pagePreviewWorker.ts', import.meta.url), { type: 'module' });
      this.worker.onmessage = (event: MessageEvent<{id:number; result?:PagePreviewResult; error?:string; superseded?:boolean}>) => {
        const pending = this.pending.get(event.data.id);
        if (!pending) return;
        this.pending.delete(event.data.id);
        if (event.data.superseded) pending.reject(new SupersededPreviewError());
        else if (event.data.error) pending.reject(new Error(event.data.error));
        else pending.resolve(event.data.result);
      };
      this.worker.onerror = () => this.stopWorker(new Error('The preview worker could not run.'));
    } catch {
      // A browser may prohibit workers; the same exporter remains available.
      this.worker = undefined;
    }
  }

  private send(message: Record<string, unknown>, transfer: Transferable[] = []) {
    return new Promise<PagePreviewResult | undefined>((resolve, reject) => {
      const id = ++this.sequence;
      this.pending.set(id, { resolve, reject });
      try { this.worker!.postMessage({ ...message, id }, transfer); }
      catch (error) { this.pending.delete(id); reject(error); }
    });
  }

  async prepare(sourceIndex?: number): Promise<void> {
    if (this.disposed) throw new Error('Preview document closed.');
    this.startWorker();
    if (!this.worker) { await this.mainSource.prepare(sourceIndex); return; }
    try {
      if (!this.initialized) {
        const bytes = this.loaded.originalBytes.slice();
        this.initialized = this.send({ bytes }, [bytes.buffer]);
      }
      await this.initialized;
      if (this.disposed) throw new Error('Preview document closed.');
      if (sourceIndex !== undefined) {
        let prepared = this.prepared.get(sourceIndex);
        if (!prepared) {
          prepared = this.send({ sourceIndex }).then(() => undefined);
          this.prepared.set(sourceIndex, prepared);
        }
        await prepared;
      }
    } catch {
      if (this.disposed) throw new Error('Preview document closed.');
      this.stopWorker(new Error('Preview worker preparation failed; using the main-thread path.'));
      await this.mainSource.prepare(sourceIndex);
    }
  }

  async export(request: PagePreviewRequest): Promise<PagePreviewResult> {
    const entry = request.document.plan?.[request.pageIndex];
    const sourceIndex = entry?.kind === 'blank' ? undefined : entry?.sourceIndex ?? request.pageIndex;
    await this.prepare(sourceIndex);
    if (this.disposed) throw new Error('Preview document closed.');
    if (!this.worker) return exportPagePreview(request, this.mainSource);
    const page = sourceIndex === undefined ? undefined : await this.loaded.doc.getPage(sourceIndex + 1);
    const fonts = new Map<string, unknown>();
    const pageEdits = request.document.edits.filter((edit) => edit.pageIndex === request.pageIndex);
    for (const edit of pageEdits) {
      if (edit.kind !== 'text') continue;
      for (const style of [edit.style, ...(edit.spans ?? [])]) {
        if (!style.fontRef || fonts.has(style.fontRef) || !page?.commonObjs.has(style.fontRef)) continue;
        const font = page.commonObjs.get(style.fontRef) as {name?:string;type?:string;isType3Font?:boolean;missingFile?:boolean};
        fonts.set(style.fontRef, { name: font.name, type: font.type, isType3Font: font.isType3Font, missingFile: font.missingFile });
      }
    }
    const wireDocument = { ...request.document, originalBytes: new Uint8Array(), sampleBackground: undefined,
      edits: pageEdits.map((edit) => edit.kind === 'cover' && !edit.color && edit.sampleBackground
        ? { ...edit, color: request.document.sampleBackground?.(request.pageIndex, edit.rect) ?? {r:1,g:1,b:1} }
        : edit),
    };
    try {
      const result = await this.send({ request: { ...request, document: wireDocument }, fonts: [...fonts].map(([ref,value]) => ({ref,value})) });
      if (!result) throw new Error('Preview worker returned no page.');
      return result;
    } catch (error) {
      if (error instanceof SupersededPreviewError || this.disposed) throw error;
      this.stopWorker(new Error('Preview worker failed; using the main-thread path.'));
      return exportPagePreview(request, this.mainSource);
    }
  }

  private stopWorker(error: Error) {
    this.worker?.terminate(); this.worker = undefined;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    this.prepared.clear();
  }
  dispose(): void { this.disposed = true; this.stopWorker(new Error('Preview document closed.')); this.mainSource.dispose(); }
}

class SupersededPreviewError extends Error {
  constructor() { super('A newer preview replaced this request.'); }
}

const services = new WeakMap<LoadedDocument, { service: PagePreviewService; users: number }>();
export function acquirePagePreviewService(loaded: LoadedDocument): { service: PagePreviewService; release(): void } {
  let entry = services.get(loaded);
  if (!entry) { entry = {service: new PagePreviewService(loaded),users:0}; services.set(loaded,entry); }
  entry.users += 1;
  const acquired = entry;
  let released = false;
  return { service: acquired.service, release() {
    if (released) return;
    released = true;
    acquired.users -= 1;
    if (acquired.users === 0) { services.delete(loaded); acquired.service.dispose(); }
  } };
}
