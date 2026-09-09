// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { previewPdf } from './preview';

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
