// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PageViewport } from 'pdfjs-dist';
import { CleanPageCache } from '@/lib/translate/cleanPages';
import { PageTranslationCache } from '@/lib/translate/pageTranslation';
import { TranslationLayer } from './TranslationLayer';

const mock = vi.hoisted(() => {
  const translate = vi.fn();
  return { translate, provider: { translate }, preview: vi.fn(), release: vi.fn(), language: 'hi-IN', cache: null as unknown,
    cleanPages: null as unknown, render: vi.fn(),
    opened: { loaded: { originalBytes: new Uint8Array([1]), pages: [], doc: {} } }, edits: [], pagePlan: [] };
});
vi.mock('@/state/translationStore', () => ({ useTranslation: () => ({ language: mock.language, cache: mock.cache,
  cleanPages: mock.cleanPages, provider: mock.provider }) }));
vi.mock('@/state/documentStore', () => ({ useDocumentStore: () => ({ document: mock.opened }) }));
vi.mock('@/state/editsStore', () => ({ useEdits: () => ({ edits: mock.edits, pagePlan: mock.pagePlan }) }));
vi.mock('@/lib/pdf/pagePreviewService', () => ({ acquirePagePreviewService: () => ({ service: { export: mock.preview }, release: mock.release }) }));
vi.mock('@/lib/pdf/worker', () => ({ pdfjs: { getDocument: () => ({ promise: Promise.resolve({ getPage: async () => ({}) }), destroy: vi.fn() }) } }));
vi.mock('@/lib/pdf/renderPage', () => ({ renderPage: mock.render }));
const boxes = [{ id: 'paragraph', text: 'Hello', rect: { x: 20, y: 30, w: 100, h: 20 },
  style: { fontName: 'Helvetica', fontSizePt: 12, bold: false, italic: false, color: { r: 0, g: 0, b: 0 } } }];
const viewport = { width: 600, height: 800, convertToViewportPoint: (x: number, y: number) => [x, 800 - y] } as unknown as PageViewport;
const layer = (eligible = true, zoom = 1) => <TranslationLayer boxes={boxes} pageIndex={0} viewport={viewport} dpr={1} zoom={zoom} eligible={eligible} />;
const patches = () => document.querySelectorAll('[data-translation-patch]').length;
const cleanPage = () => document.querySelector('[data-translation-page]');
beforeEach(() => {
  mock.translate.mockReset(); mock.preview.mockReset(); mock.release.mockClear();
  mock.render.mockReset().mockImplementation(() => ({ task: { promise: Promise.resolve(), cancel: vi.fn() } }));
  mock.cache = new PageTranslationCache(); mock.cleanPages = new CleanPageCache(); mock.language = 'hi-IN';
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage: vi.fn() } as unknown as CanvasRenderingContext2D);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
describe('screen-only TranslationLayer', () => {
  it('makes no request for an offscreen page or English original', () => {
    const view = render(layer(false));
    expect(mock.translate).not.toHaveBeenCalled();
    mock.language = 'en-IN'; view.rerender(layer(true));
    expect(mock.translate).not.toHaveBeenCalled();
    expect(mock.preview).not.toHaveBeenCalled();
  });
  it('keeps original page visible on failure and offers retry', async () => {
    mock.translate.mockRejectedValue(new Error('offline'));
    mock.preview.mockResolvedValue({ clean: true, bytes: new Uint8Array([1]) });
    render(layer());
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain("Couldn't translate this page"));
    expect(screen.queryByLabelText('Page 1 translation')).toBeNull();
    expect(patches()).toBe(0);
  });
  it('shows the words on patches as soon as they arrive, then fades in the clean page', async () => {
    mock.translate.mockResolvedValue({ text: 'नमस्ते' });
    let resolve!: (value: { clean: boolean; bytes: Uint8Array }) => void;
    mock.preview.mockReturnValue(new Promise(done => { resolve = done; }));
    render(layer());
    await waitFor(() => expect(screen.getByLabelText('Page 1 translation').textContent).toContain('नमस्ते'));
    expect(patches()).toBe(1);
    expect(cleanPage()).toBeNull();
    await act(async () => resolve({ clean: true, bytes: new Uint8Array([1]) }));
    await waitFor(() => expect(cleanPage()).toBeTruthy());
    expect(patches()).toBe(0);
  });
  it('keeps the words on patches when the English cannot be removed safely', async () => {
    mock.translate.mockResolvedValue({ text: 'नमस्ते' });
    mock.preview.mockResolvedValue({ clean: false });
    render(layer());
    await waitFor(() => expect(mock.preview).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByLabelText('Page 1 translation').textContent).toContain('नमस्ते'));
    await act(async () => undefined);
    expect(patches()).toBe(1);
    expect(cleanPage()).toBeNull();
  });
  it('a zoom keeps the translation on screen and only redraws the remembered clean page', async () => {
    mock.translate.mockResolvedValue({ text: 'नमस्ते' });
    mock.preview.mockResolvedValue({ clean: true, bytes: new Uint8Array([1]) });
    const view = render(layer(true, 1));
    await waitFor(() => expect(cleanPage()).toBeTruthy());
    let redraw!: () => void;
    mock.render.mockImplementation(() => ({ task: { promise: new Promise<void>(done => { redraw = done; }), cancel: vi.fn() } }));
    view.rerender(layer(true, 1.5));
    expect(screen.getByLabelText('Page 1 translation').textContent).toContain('नमस्ते');
    expect(cleanPage()).toBeTruthy();
    expect(screen.queryByRole('status')).toBeNull();
    await waitFor(() => expect(mock.render).toHaveBeenCalledTimes(2));
    expect(mock.render.mock.calls[1]![2]).toBe(1.5);
    await act(async () => redraw());
    expect(mock.preview).toHaveBeenCalledTimes(1);
    expect(mock.translate).toHaveBeenCalledTimes(1);
  });
  it('switching language asks only for the new words and reuses the clean page', async () => {
    mock.translate.mockResolvedValueOnce({ text: 'नमस्ते' }).mockResolvedValueOnce({ text: 'வணக்கம்' });
    mock.preview.mockResolvedValue({ clean: true, bytes: new Uint8Array([1]) });
    const view = render(layer());
    await waitFor(() => expect(cleanPage()).toBeTruthy());
    mock.language = 'ta-IN'; view.rerender(layer());
    await waitFor(() => expect(screen.getByLabelText('Page 1 translation').textContent).toContain('வணக்கம்'));
    expect(cleanPage()).toBeTruthy();
    expect(patches()).toBe(0);
    expect(mock.preview).toHaveBeenCalledTimes(1);
    expect(mock.render).toHaveBeenCalledTimes(1);
  });
  it('keeps a bullet visible even when the provider returns only translated words', async () => {
    mock.translate.mockResolvedValue({ text: 'નમસ્તે' });
    mock.preview.mockResolvedValue({ clean: true, bytes: new Uint8Array([1]) });
    render(<TranslationLayer boxes={[{ ...boxes[0]!, prefix: '•' }]} pageIndex={0} viewport={viewport} dpr={1} zoom={1} eligible />);
    await waitFor(() => expect(screen.getByLabelText('Page 1 translation')).toBeTruthy());
    expect(document.querySelector('[data-translation-marker]')?.textContent).toBe('• ');
    expect(mock.translate).toHaveBeenCalledWith(expect.objectContaining({ text: 'Hello' }));
  });
  it('never reuses the last page canvas for another page with identical text boxes', async () => {
    mock.translate.mockResolvedValue({ text: 'नमस्ते' });
    mock.preview.mockResolvedValue({ clean: true, bytes: new Uint8Array([1]) });
    const view = render(layer());
    await waitFor(() => expect(cleanPage()).toBeTruthy());
    let resolve!: (value: { clean: boolean; bytes: Uint8Array }) => void;
    mock.preview.mockReturnValue(new Promise(done => { resolve = done; }));
    view.rerender(<TranslationLayer boxes={boxes} pageIndex={1} viewport={viewport} dpr={1} zoom={1} eligible />);
    expect(screen.queryByLabelText('Page 1 translation')).toBeNull();
    await waitFor(() => expect(screen.getByLabelText('Page 2 translation')).toBeTruthy());
    expect(cleanPage()).toBeNull();
    expect(patches()).toBe(1);
    await waitFor(() => expect(mock.preview).toHaveBeenCalledTimes(2));
    await act(async () => resolve({ clean: true, bytes: new Uint8Array([2]) }));
    await waitFor(() => expect(cleanPage()).toBeTruthy());
    expect(mock.translate).toHaveBeenCalledTimes(1);
  });
});
