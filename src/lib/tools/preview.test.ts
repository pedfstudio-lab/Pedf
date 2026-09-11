// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { previewPdf, previewPdfPage, previewPdfPages } from './preview';

const { loadPdfJs, renderPage } = vi.hoisted(() => ({ loadPdfJs: vi.fn(), renderPage: vi.fn() }));
vi.mock('./pdfIo', () => ({ loadPdfJs }));
vi.mock('@/lib/pdf/renderPage', () => ({ renderPage }));
afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); });

function setup(promise = Promise.resolve()) {
  const destroy = vi.fn(async () => {});
  const page = { getViewport: () => ({ width: 500 }) };
  const cancel = vi.fn();
  loadPdfJs.mockResolvedValue({ doc: { getPage: vi.fn(async () => page), numPages: 3, destroy } });
  renderPage.mockReturnValue({ task: { promise, cancel } });
  vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/png;base64,AA==');
  return { destroy, cancel, page };
}

describe('local PDF previews', () => {
  it('renders a scaled first page, reports page count, and destroys the PDF', async () => {
    const { destroy, page } = setup();
    const result = await previewPdf(new File(['pdf'], 'test.pdf'), new AbortController().signal);
    expect(result).toEqual({ pages: 3, thumbnail: 'data:image/png;base64,AA==' });
    expect(renderPage).toHaveBeenCalledWith(page, expect.any(HTMLCanvasElement), 0.2);
    expect(destroy).toHaveBeenCalledTimes(1);
    const canvas = renderPage.mock.calls[0]?.[1] as HTMLCanvasElement;
    expect(canvas.width).toBe(0);
  });

  it('releases an opened PDF when removed before rendering starts', async () => {
    const { destroy } = setup();
    const controller = new AbortController(); controller.abort();
    await expect(previewPdf(new File(['pdf'], 'test.pdf'), controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(renderPage).not.toHaveBeenCalled();
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it('cancels an in-flight render and cleans up the document', async () => {
    let reject!: (error: Error) => void;
    const { destroy, cancel } = setup(new Promise<void>((_resolve, fail) => { reject = fail; }));
    const controller = new AbortController();
    cancel.mockImplementation(() => reject(new DOMException('Cancelled', 'AbortError')));
    const preview = previewPdf(new File(['pdf'], 'test.pdf'), controller.signal);
    const rejection = expect(preview).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(renderPage).toHaveBeenCalled());
    controller.abort();
    await rejection;
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(destroy).toHaveBeenCalledTimes(1);
  });
});

describe('streaming page previews', () => {
  function setupPages(count = 3) {
    const destroy = vi.fn(async () => {});
    const pages = Array.from({ length: count }, (_, index) => ({
      getViewport: vi.fn(({ scale }: { scale: number }) => ({ width: (300 + index * 10) * scale, height: 500 * scale })),
      render: vi.fn((options: { intent: string }) => ({
        promise: Promise.resolve(), cancel: vi.fn(), intent: options.intent,
      })),
      cleanup: vi.fn(),
    }));
    const getPage = vi.fn(async (pageNumber: number) => pages[pageNumber - 1]);
    loadPdfJs.mockResolvedValue({ doc: { getPage, numPages: count, destroy } });
    const context = { fillStyle: '', fillRect: vi.fn() };
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockImplementation(function (this: HTMLCanvasElement) {
      return `data:image/png;base64,${this.width}x${this.height}`;
    });
    return { destroy, getPage, pages, context };
  }

  it('renders pages sequentially with print intent and reports each size', async () => {
    const { destroy, getPage, pages, context } = setupPages(2);
    const onPage = vi.fn<(pageIndex: number, thumbnail: string, size: { w: number; h: number }) => void>();
    await previewPdfPages(new File(['pdf'], 'pages.pdf'), new AbortController().signal, onPage);
    expect(getPage.mock.calls.map(([pageNumber]) => pageNumber)).toEqual([1, 2]);
    expect(onPage.mock.calls.map(([pageIndex, , size]) => [pageIndex, size])).toEqual([
      [0, { w: 300, h: 500 }], [1, { w: 310, h: 500 }],
    ]);
    expect(pages.every((page) => page.render.mock.calls[0]?.[0].intent === 'print')).toBe(true);
    expect(pages.every((page) => page.cleanup.mock.calls.length === 1)).toBe(true);
    expect(context.fillRect).toHaveBeenCalledTimes(2);
    expect(destroy).toHaveBeenCalledOnce();
  });

  it('renders one requested page with print intent and releases its resources', async () => {
    const { destroy, getPage, pages, context } = setupPages(3);
    const result = await previewPdfPage(new File(['pdf'], 'pages.pdf'), 2, new AbortController().signal, 420);
    expect(getPage).toHaveBeenCalledWith(3);
    expect(result).toEqual({ thumbnail: 'data:image/png;base64,269x420', size: { w: 320, h: 500 } });
    expect(pages[2]!.render.mock.calls[0]?.[0].intent).toBe('print');
    expect(pages[2]!.cleanup).toHaveBeenCalledOnce();
    expect(context.fillRect).toHaveBeenCalledOnce();
    expect(destroy).toHaveBeenCalledOnce();
  });

  it('reports the page count once before the first thumbnail', async () => {
    setupPages(3);
    const calls: string[] = [];
    await previewPdfPages(
      new File(['pdf'], 'pages.pdf'),
      new AbortController().signal,
      (pageIndex) => calls.push(`page-${pageIndex}`),
      140,
      (count) => calls.push(`count-${count}`),
    );
    expect(calls).toEqual(['count-3', 'page-0', 'page-1', 'page-2']);
  });

  it('stops between pages when aborted and still destroys the document', async () => {
    const { destroy, getPage } = setupPages(3);
    const controller = new AbortController();
    const onPage = vi.fn(() => controller.abort());
    await expect(previewPdfPages(new File(['pdf'], 'pages.pdf'), controller.signal, onPage))
      .rejects.toMatchObject({ name: 'AbortError' });
    expect(onPage).toHaveBeenCalledOnce();
    expect(getPage).toHaveBeenCalledOnce();
    expect(destroy).toHaveBeenCalledOnce();
  });
});
