import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ToolError } from './errors';
import { COMPRESS_INPUT_ERROR, COMPRESS_SIGNATURE_WARNING, compressTool, run } from './compress';

const mocks = vi.hoisted(() => ({
  analyzeFile: vi.fn(),
  compressPdf: vi.fn(),
  fitUnderSize: vi.fn(),
  estimateFileLevels: vi.fn(),
  estimateAllLevels: vi.fn(),
}));

vi.mock('@/lib/compress/analyze', () => ({ analyzeFile: mocks.analyzeFile }));
vi.mock('@/lib/compress/compressPdf', () => ({
  compressPdf: mocks.compressPdf,
  fitUnderSize: mocks.fitUnderSize,
}));
vi.mock('@/lib/compress/estimate', () => ({
  estimateFileLevels: mocks.estimateFileLevels,
  estimateAllLevels: mocks.estimateAllLevels,
}));

const baseAnalysis = {
  fileSize: 1_000,
  bytesInShrinkableImages: 800,
  photoCount: 3,
  skippedCount: 1,
  trailingBytes: 0,
  unusedPhotoBytes: 0,
  unusedPhotoCount: 0,
  duplicateBytes: 0,
  duplicateCount: 0,
  namesIncomplete: false,
  signed: false,
  images: [],
};

function file(name = 'scan.pdf'): File {
  return new File([new Uint8Array(1_000)], name, { type: 'application/pdf' });
}

function context(controller = new AbortController()) {
  return { signal: controller.signal, onProgress: vi.fn(), onWarning: vi.fn() };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.analyzeFile.mockResolvedValue(baseAnalysis);
  mocks.estimateFileLevels.mockResolvedValue({ light: 900, medium: 700, strong: 500, smallest: 400 });
  mocks.estimateAllLevels.mockReturnValue({ light: 900, medium: 700, strong: 500, smallest: 400 });
  mocks.compressPdf.mockResolvedValue({
    bytes: new Uint8Array(500), levelUsed: 'medium', madeSmaller: 2, leftAsTheyWere: 1, removedUnused: 0,
  });
  mocks.fitUnderSize.mockResolvedValue({
    bytes: new Uint8Array(480), levelUsed: 'strong', madeSmaller: 3, leftAsTheyWere: 0, removedUnused: 0,
    note: { text: '480 B, under your 500 KB limit (used Strong).', tone: 'ok' },
  });
});

describe('Compress PDF tool', () => {
  it('requires exactly one PDF before reading anything', async () => {
    await expect(run([], {}, context())).rejects.toEqual(new ToolError(COMPRESS_INPUT_ERROR));
    await expect(run([file('one.pdf'), file('two.pdf')], {}, context())).rejects.toThrow(COMPRESS_INPUT_ERROR);
    expect(mocks.analyzeFile).not.toHaveBeenCalled();
  });

  it('uses Medium by default and returns the output name, summary and final progress', async () => {
    const ctx = context();
    const [output] = await run([file('phone scan.pdf')], {}, ctx);
    expect(mocks.compressPdf).toHaveBeenCalledWith(expect.any(Uint8Array), 'medium', expect.objectContaining({ analysis: baseAnalysis }));
    expect(output).toMatchObject({ name: 'phone scan-compressed.pdf', mime: 'application/pdf' });
    expect(output?.note).toEqual({
      text: '1000 B → 500 B (50% smaller). 2 photos made smaller, 1 left as it was.', tone: 'ok',
    });
    expect(ctx.onProgress).toHaveBeenLastCalledWith(1, 1, 'Compressed PDF ready');
  });

  it('uses calibrated estimates for Fit under a size', async () => {
    const selected = file();
    await run([selected], { level: 'fit', limitValue: 500, limitUnit: 'KB' }, context());
    expect(mocks.estimateFileLevels).toHaveBeenCalledWith(selected, baseAnalysis, expect.any(AbortSignal));
    expect(mocks.fitUnderSize).toHaveBeenCalledWith(expect.any(Uint8Array), 500_000,
      expect.objectContaining({ estimates: { light: 900, medium: 700, strong: 500, smallest: 400 } }));
  });

  it('requires consent for signed input and repeats the warning after a changed output', async () => {
    mocks.analyzeFile.mockResolvedValue({ ...baseAnalysis, signed: true });
    await expect(run([file('signed.pdf')], {}, context())).rejects.toThrow('digital signature');
    const ctx = context();
    const [output] = await run([file('signed.pdf')], { acceptSignatureLoss: true }, ctx);
    expect(ctx.onWarning).toHaveBeenCalledWith(COMPRESS_SIGNATURE_WARNING);
    expect(output?.note?.text).toContain(COMPRESS_SIGNATURE_WARNING);
    expect(output?.note?.tone).toBe('warn');
  });

  it('keeps the runner note without inventing a size reduction when bytes are unchanged', async () => {
    const original = file('compact.pdf');
    mocks.compressPdf.mockImplementation(async (bytes: Uint8Array) => ({
      bytes, levelUsed: 'medium', madeSmaller: 0, leftAsTheyWere: 3, removedUnused: 0,
      note: { text: 'The photos in this file are already compressed, so Medium changed nothing. Strong would make it about 400 B (photos get a little softer).', tone: 'ok' },
    }));
    const [output] = await run([original], {}, context());
    expect(output?.note?.text).toContain('Medium changed nothing');
  });

  it('exposes the requested public definition', () => {
    expect(compressTool).toMatchObject({
      slug: 'compress', title: 'Compress PDF', accepts: 'pdf', multiple: false, icon: '🗜',
      description: 'Make a PDF smaller by shrinking the photos inside. Text stays sharp.',
    });
  });
});
