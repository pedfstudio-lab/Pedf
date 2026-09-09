// @vitest-environment jsdom
import { PDFDocument } from 'pdf-lib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EMPTY_PAGE_RANGE_ERROR } from './pageRanges';
import { PDF_ERRORS } from './pdfIo';
import {
  BIG_JOB_WARNING,
  DEVICE_MEMORY_WARNING,
  isBigJob,
  MAX_CANVAS_PIXELS,
  pdfToJpgTool,
  run,
  SINGLE_PDF_ERROR,
} from './pdfToJpg';
import {
  DEFAULT_PDF_TO_JPG_OPTIONS,
  pagePixelSize,
  selectedPageIndices,
} from './pdfToJpgOptions';

const { loadPdfJs } = vi.hoisted(() => ({ loadPdfJs: vi.fn() }));
vi.mock('./pdfIo', async (importOriginal) => ({
  ...await importOriginal<typeof import('./pdfIo')>(),
  loadPdfJs,
}));

interface FakePage {
  getViewport: ReturnType<typeof vi.fn>;
  render: ReturnType<typeof vi.fn>;
  cleanup: ReturnType<typeof vi.fn>;
}

interface EncodedCanvas { width: number; height: number; type: string; quality?: number }
let encoded: EncodedCanvas[] = [];
let contexts: Array<{ fillStyle: string; fillRect: ReturnType<typeof vi.fn> }> = [];
let canvases: HTMLCanvasElement[] = [];

function fakePage(width: number, height: number, rotation = 0): FakePage {
  const cancel = vi.fn();
  return {
    getViewport: vi.fn(({ scale }: { scale: number }) => ({
      width: (rotation % 180 ? height : width) * scale,
      height: (rotation % 180 ? width : height) * scale,
    })),
    render: vi.fn(() => ({ promise: Promise.resolve(), cancel })),
    cleanup: vi.fn(),
  };
}

function setupDocument(pages: FakePage[]) {
  const destroy = vi.fn(async () => {});
  const getPage = vi.fn(async (pageNumber: number) => pages[pageNumber - 1]);
  loadPdfJs.mockResolvedValue({ doc: { numPages: pages.length, getPage, destroy } });
  return { destroy, getPage };
}

async function generatedPdf(name = 'fixture.pdf') {
  const pdf = await PDFDocument.create();
  pdf.addPage([300, 400]);
  pdf.addPage([500, 200]);
  return new File([(await pdf.save()).slice().buffer], name, { type: 'application/pdf' });
}

function context(controller = new AbortController()) {
  return { signal: controller.signal, onProgress: vi.fn(), onWarning: vi.fn() };
}

beforeEach(() => {
  encoded = [];
  contexts = [];
  canvases = [];
  loadPdfJs.mockReset();
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { callback(0); return 1; });
  const originalCreate = document.createElement.bind(document);
  vi.spyOn(document, 'createElement').mockImplementation(((tagName: string) => {
    const element = originalCreate(tagName);
    if (tagName.toLowerCase() === 'canvas') canvases.push(element as HTMLCanvasElement);
    return element;
  }) as typeof document.createElement);
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => {
    const value = { fillStyle: '', fillRect: vi.fn() };
    contexts.push(value);
    return value as unknown as CanvasRenderingContext2D;
  });
  vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(function (this: HTMLCanvasElement, callback, type, quality) {
    encoded.push({ width: this.width, height: this.height, type: type ?? '', quality: quality ?? undefined });
    const bytes = type === 'image/png'
      ? new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])
      : new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
    callback(new Blob([bytes.slice().buffer], { type: type ?? '' }));
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('PDF to JPG option parsing', () => {
  it('flattens, de-duplicates and sorts selected ranges', () => {
    expect(selectedPageIndices({ pageSelection: 'custom', ranges: '5, 1-3, 3, 2' }, 6)).toEqual([0, 1, 2, 4]);
    expect(selectedPageIndices(DEFAULT_PDF_TO_JPG_OPTIONS, 3)).toEqual([0, 1, 2]);
  });

  it('calculates output pixels by DPI using ceiling', () => {
    expect(pagePixelSize(300, 400, 72)).toEqual({ width: 300, height: 400 });
    expect(pagePixelSize(300, 400, 150)).toEqual({ width: 625, height: 834 });
    expect(pagePixelSize(300, 400, 300)).toEqual({ width: 1250, height: 1667 });
  });
});

describe('PDF to JPG', () => {
  it.each([
    ['small', 300, 400, 500, 200],
    ['normal', 625, 834, 1042, 417],
    ['high', 1250, 1667, 2084, 834],
  ] as const)('renders a generated two-page PDF at %s quality to the expected pixels', async (quality, w1, h1, w2, h2) => {
    const pages = [fakePage(300, 400), fakePage(500, 200)];
    const { destroy } = setupDocument(pages);
    const outputs = await run([await generatedPdf()], { ...DEFAULT_PDF_TO_JPG_OPTIONS, quality }, context());
    expect(outputs).toHaveLength(2);
    expect(encoded.map(({ width, height }) => [width, height])).toEqual([[w1, h1], [w2, h2]]);
    expect(outputs.every(({ mime }) => mime === 'image/jpeg')).toBe(true);
    expect(outputs.every(({ bytes }) => bytes[0] === 0xff && bytes[1] === 0xd8)).toBe(true);
    expect(encoded.every(({ type, quality: jpegQuality }) => type === 'image/jpeg' && jpegQuality === 0.9)).toBe(true);
    expect(contexts.every(({ fillStyle, fillRect }) => fillStyle === '#fff' && fillRect.mock.calls[0]?.slice(0, 2).every((value) => value === 0))).toBe(true);
    expect(pages.every(({ cleanup }) => cleanup.mock.calls.length === 1)).toBe(true);
    expect(canvases.every((canvas) => canvas.width === 0 && canvas.height === 0)).toBe(true);
    expect(destroy).toHaveBeenCalledOnce();
  });

  it('keeps converting in a hidden tab: print intent, and no animation-frame waits', async () => {
    // A hidden tab never fires requestAnimationFrame; the conversion must not depend on it.
    vi.stubGlobal('requestAnimationFrame', vi.fn());
    const pages = [fakePage(300, 400), fakePage(500, 200)];
    setupDocument(pages);
    const outputs = await run([await generatedPdf()], DEFAULT_PDF_TO_JPG_OPTIONS, context());
    expect(outputs).toHaveLength(2);
    for (const page of pages) {
      expect(page.render).toHaveBeenCalledWith(expect.objectContaining({ intent: 'print' }));
    }
    expect(requestAnimationFrame).not.toHaveBeenCalled();
  });

  it('renders a rotated PDF page in its visible landscape orientation', async () => {
    setupDocument([fakePage(300, 500, 90)]);
    await run([await generatedPdf('rotated.pdf')], DEFAULT_PDF_TO_JPG_OPTIONS, context());
    expect(encoded[0]!.width).toBeGreaterThan(encoded[0]!.height);
  });

  it('uses sorted page ranges and sortable page-count padding in output names', async () => {
    setupDocument(Array.from({ length: 16 }, () => fakePage(100, 200)));
    const outputs = await run([await generatedPdf('GOA 2026.pdf')], {
      ...DEFAULT_PDF_TO_JPG_OPTIONS,
      pageSelection: 'custom', ranges: '16, 1-1, 16',
    }, context());
    expect(outputs.map(({ name }) => name)).toEqual(['GOA 2026-page-01.jpg', 'GOA 2026-page-16.jpg']);
  });

  it('uses unpadded page names for a two-page file and keeps one selected output direct', async () => {
    setupDocument([fakePage(300, 400), fakePage(500, 200)]);
    const first = await run([await generatedPdf()], {
      ...DEFAULT_PDF_TO_JPG_OPTIONS, pageSelection: 'custom', ranges: '1-1',
    }, context());
    expect(first.map(({ name }) => name)).toEqual(['fixture-page-1.jpg']);
    setupDocument([fakePage(300, 400), fakePage(500, 200)]);
    const second = await run([await generatedPdf()], {
      ...DEFAULT_PDF_TO_JPG_OPTIONS, pageSelection: 'custom', ranges: '2',
    }, context());
    expect(second.map(({ name }) => name)).toEqual(['fixture-page-2.jpg']);
  });

  it('encodes PNG output with the PNG signature and MIME', async () => {
    setupDocument([fakePage(300, 400)]);
    const [output] = await run([await generatedPdf()], { ...DEFAULT_PDF_TO_JPG_OPTIONS, format: 'png' }, context());
    expect(output?.name).toBe('fixture-page-1.png');
    expect(output?.mime).toBe('image/png');
    expect([...output!.bytes.slice(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    expect(encoded[0]).toMatchObject({ type: 'image/png', quality: undefined });
  });

  it('reuses the range parser errors and destroys the PDF after failure', async () => {
    const { destroy } = setupDocument([fakePage(300, 400), fakePage(500, 200)]);
    await expect(run([await generatedPdf()], {
      ...DEFAULT_PDF_TO_JPG_OPTIONS, pageSelection: 'custom', ranges: '3',
    }, context())).rejects.toThrow('Page numbers must be between 1 and 2.');
    expect(destroy).toHaveBeenCalledOnce();
    setupDocument([fakePage(300, 400)]);
    await expect(run([await generatedPdf()], {
      ...DEFAULT_PDF_TO_JPG_OPTIONS, pageSelection: 'custom', ranges: '',
    }, context())).rejects.toThrow(EMPTY_PAGE_RANGE_ERROR);
  });

  it('scales oversized canvases below 16 million pixels and warns only once', async () => {
    setupDocument([fakePage(5000, 5000), fakePage(6000, 4000)]);
    const ctx = context();
    const outputs = await run([await generatedPdf()], DEFAULT_PDF_TO_JPG_OPTIONS, ctx);
    expect(outputs).toHaveLength(2);
    expect(encoded.every(({ width, height }) => width * height <= MAX_CANVAS_PIXELS)).toBe(true);
    expect(ctx.onWarning).toHaveBeenCalledTimes(1);
    expect(ctx.onWarning).toHaveBeenCalledWith(DEVICE_MEMORY_WARNING);
  });

  it('identifies big jobs only above 100 selected pages at High quality', () => {
    expect(isBigJob(101, 300)).toBe(true);
    expect(isBigJob(100, 300)).toBe(false);
    expect(isBigJob(101, 150)).toBe(false);
    expect(BIG_JOB_WARNING).toContain('Consider Normal quality or a page range.');
  });

  it('honours cancellation between pages without returning partial outputs', async () => {
    const pages = [fakePage(300, 400), fakePage(500, 200)];
    const { getPage, destroy } = setupDocument(pages);
    const controller = new AbortController();
    const ctx = context(controller);
    ctx.onProgress.mockImplementation((done: number) => { if (done === 1) controller.abort(); });
    await expect(run([await generatedPdf()], DEFAULT_PDF_TO_JPG_OPTIONS, ctx)).rejects.toMatchObject({ name: 'AbortError' });
    expect(getPage).toHaveBeenCalledTimes(1);
    expect(destroy).toHaveBeenCalledOnce();
  });

  it('rejects missing or multiple inputs as ToolError before loading', async () => {
    await expect(run([], DEFAULT_PDF_TO_JPG_OPTIONS, context())).rejects.toThrow(SINGLE_PDF_ERROR);
    const file = await generatedPdf();
    await expect(run([file, file], DEFAULT_PDF_TO_JPG_OPTIONS, context())).rejects.toThrow(SINGLE_PDF_ERROR);
    expect(loadPdfJs).not.toHaveBeenCalled();
    expect(pdfToJpgTool).toMatchObject({ slug: 'pdf-to-jpg', accepts: 'pdf', multiple: false });
    expect(PDF_ERRORS.type).toBe('Choose a PDF file.');
  });
});
