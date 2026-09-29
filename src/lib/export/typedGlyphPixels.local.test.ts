import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { buildTextBlockEdits } from '@/lib/edit/buildTextEdits';
import { detectRuleLines } from '@/lib/pdf/ruleLines';
import { extractTextRuns, groupRunsIntoBlocks } from '@/lib/pdf/textContent';
import type { EditDocument } from './types';
import { exportPdf } from './exportPdf';

const file = process.env.TYPED_FILE ?? '';
const optionalCanvas = await import('@napi-rs/canvas').catch(() => undefined);
const enabled = process.env.TYPED_PIXELS === '1' && Boolean(file) && existsSync(file)
  && Boolean(optionalCanvas);
if (!enabled) process.stdout.write('Typed-glyph pixel check skipped.\n');

const fontDir = fileURLToPath(new URL('../../../node_modules/pdfjs-dist/standard_fonts/', import.meta.url));
const standardFontDataUrl = fontDir.endsWith(sep) ? fontDir : `${fontDir}${sep}`;

const TYPED = '0123456789 ABCDEFGHIJKLM';

async function pageGeometry(reader: PDFDocumentProxy): Promise<EditDocument['pages']> {
  const pages: EditDocument['pages'] = [];
  for (let index = 0; index < reader.numPages; index += 1) {
    const page = await reader.getPage(index + 1);
    const [left = 0, bottom = 0, right = 0, top = 0] = page.view;
    pages.push({
      pageIndex: index,
      widthPt: right - left,
      heightPt: top - bottom,
      rotation: ((page.rotate % 360) + 360) % 360 as 0 | 90 | 180 | 270,
      boxOffset: { x: left, y: bottom },
    });
  }
  return pages;
}

describe.runIf(enabled)('typed glyphs, in pixels', () => {
  it('renders what a page font actually draws for newly typed characters', { timeout: 300_000 }, async () => {
    const originalBytes = new Uint8Array(await readFile(file));
    const pageNumber = Number(process.env.TYPED_PAGE ?? '3');
    const pageIndex = pageNumber - 1;
    const find = process.env.TYPED_FIND ?? 'Rs. 182';
    const reader = await getDocument({ data: originalBytes.slice(), verbosity: 0 }).promise;
    let edits;
    let pages: EditDocument['pages'] = [];
    let rect;
    let styleNote = '';
    try {
      pages = await pageGeometry(reader);
      const page = await reader.getPage(pageNumber);
      const runs = await extractTextRuns(page, pageIndex);
      const rules = await detectRuleLines(page, pageIndex);
      const blocks = groupRunsIntoBlocks(runs, { ruleLines: rules });
      const block = blocks.find((b) => b.text.includes(find));
      expect(block, `a block containing ${JSON.stringify(find)}`).toBeDefined();
      if (!block) return;
      rect = block.rect;
      styleNote = `fontName=${JSON.stringify(block.style.fontName)} fontRef=${String(block.style.fontRef)}`
        + ` bold=${block.style.bold} size=${block.style.fontSizePt.toFixed(1)}`;
      // fontRef kept, exactly as the editor keeps it when the family is unchanged.
      const built = buildTextBlockEdits(block, {
        text: TYPED,
        style: block.style,
        width: 260,
        height: block.rect.h,
        dx: 0,
        dy: 0,
      }, [TYPED], 1);
      edits = [...built.covers, ...built.texts];
    } finally {
      await reader.destroy();
    }
    if (!edits || !rect) return;

    const out = await exportPdf({
      originalBytes,
      pages,
      edits,
      sampleBackground: () => ({ r: 1, g: 1, b: 1 }),
    });
    process.stdout.write(`\nTYPED PIXELS  ${styleNote}\n  warnings ${JSON.stringify(out.warnings)}\n`);

    const { createCanvas, loadImage } = optionalCanvas!;
    const doc = await getDocument({ data: out.bytes.slice(), standardFontDataUrl, verbosity: 0 }).promise;
    const page = await doc.getPage(pageNumber);
    const scale = 4;
    const viewport = page.getViewport({ scale });
    const full = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
    await page.render({
      canvasContext: full.getContext('2d') as unknown as CanvasRenderingContext2D,
      viewport,
    }).promise;
    await doc.destroy();

    const img = await loadImage(full.toBuffer('image/png'));
    const left = Math.max(0, (rect.x - 6) * scale);
    const top = Math.max(0, img.height - (rect.y + rect.h + 6) * scale);
    const w = Math.min(img.width - left, 280 * scale);
    const h = Math.min(img.height - top, (rect.h + 14) * scale);
    const crop = createCanvas(w, h);
    crop.getContext('2d').drawImage(img, left, top, w, h, 0, 0, w, h);
    await mkdir('tmp/dutees', { recursive: true });
    await writeFile('tmp/dutees/typed-glyphs.png', crop.toBuffer('image/png'));
    process.stdout.write(`  typed ${JSON.stringify(TYPED)}\n  wrote tmp/dutees/typed-glyphs.png\n`);
    expect(out.warnings).toEqual([]);
  });
});
