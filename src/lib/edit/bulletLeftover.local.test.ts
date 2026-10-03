import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { exportPdf } from '@/lib/export/exportPdf';
import type { CoverEdit, EditDocument, PdfRect } from '@/lib/export/types';
import { detectRuleLines } from '@/lib/pdf/ruleLines';
import { detectPageGraphicRegions } from '@/lib/pdf/shapeMarkers';
import {
  availableBulletListHeight,
  detectBulletListFromRegions,
  formatBulletEditorText,
} from '@/lib/pdf/bulletList';
import { extractTextRuns, groupRunsIntoBlocks } from '@/lib/pdf/textContent';
import { buildBulletListEdits } from './buildTextEdits';

const file = 'tmp/bullets/RAHUL_RAJPUT_RESUME.pdf';
const enabled = process.env.TASK74_REAL === '1' && existsSync(file);
const NEW = 'REPLACED FIRST ITEM';

// The file stores words in separate pieces, so spacing is not comparable: compare without it.
const squash = (text: string): string => text.replace(/\s+/g, '');

if (!enabled) {
  process.stdout.write(
    'Picture-dot bullet list check skipped: set TASK74_REAL=1 with RAHUL_RAJPUT_RESUME.pdf present.\n',
  );
}

const SCALE = 2;
const standardFontDataUrl = `${resolve('node_modules/pdfjs-dist/standard_fonts')}/`;

/** Page 1 rendered at SCALE, cropped to a PDF-space rectangle. */
async function renderRegion(bytes: Uint8Array, rect: PdfRect): Promise<Uint8ClampedArray> {
  const { createCanvas } = await import('@napi-rs/canvas');
  const document = await getDocument({ data: bytes.slice(), standardFontDataUrl, verbosity: 0 }).promise;
  try {
    const page = await document.getPage(1);
    const viewport = page.getViewport({ scale: SCALE });
    const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
    const context = canvas.getContext('2d');
    await page.render({ canvasContext: context as unknown as CanvasRenderingContext2D, viewport }).promise;
    const [left, top] = viewport.convertToViewportPoint(rect.x, rect.y + rect.h);
    const [right, bottom] = viewport.convertToViewportPoint(rect.x + rect.w, rect.y);
    const x = Math.floor(left ?? 0);
    const y = Math.floor(top ?? 0);
    return context.getImageData(x, y, Math.ceil(right ?? 0) - x, Math.ceil(bottom ?? 0) - y).data;
  } finally {
    await document.destroy();
  }
}

function differingPixels(left: Uint8ClampedArray, right: Uint8ClampedArray): { count: number; total: number } {
  let count = 0;
  for (let index = 0; index < left.length; index += 4) {
    if ([0, 1, 2].some((offset) => Math.abs((left[index + offset] ?? 0) - (right[index + offset] ?? 0)) > 8)) {
      count += 1;
    }
  }
  return { count, total: left.length / 4 };
}

async function pageText(bytes: Uint8Array): Promise<string> {
  const document = await getDocument({ data: bytes.slice(), verbosity: 0 }).promise;
  try {
    const content = await (await document.getPage(1)).getTextContent();
    return squash(content.items.map((item) => ('str' in item ? item.str : '')).join(''));
  } finally {
    await document.destroy();
  }
}

// A bullet list whose dots are pictures used to keep its old words in the exported
// file, hidden under the patch: the cover carried pictures, so text removal skipped it.
// With the words and the dot pictures both gone, the patch is not painted either.
describe.runIf(enabled)('editing a bullet list whose dots are pictures', () => {
  it('takes the old words out of the exported file, with no patch', { timeout: 300_000 }, async () => {
    const originalBytes = new Uint8Array(await readFile(file));
    const originalText = await pageText(originalBytes);
    const reader = await getDocument({ data: originalBytes.slice(), verbosity: 0 }).promise;
    const pages: EditDocument['pages'] = [];
    for (let index = 0; index < reader.numPages; index += 1) {
      const p = await reader.getPage(index + 1);
      const [left = 0, bottom = 0, right = 0, top = 0] = p.view;
      pages.push({
        pageIndex: index,
        widthPt: right - left,
        heightPt: top - bottom,
        rotation: ((p.rotate % 360) + 360) % 360 as 0 | 90 | 180 | 270,
        boxOffset: { x: left, y: bottom },
      });
    }
    const page = await reader.getPage(1);
    const [runs, ruleLines, regions] = await Promise.all([
      extractTextRuns(page, 0),
      detectRuleLines(page, 0),
      detectPageGraphicRegions(page, 0),
    ]);
    const blocks = groupRunsIntoBlocks(runs, {
      ruleLines,
      markers: [...regions.imageRegions, ...regions.shapeMarkerRegions],
    });
    const pageTop = page.view[1] ?? 0;
    await reader.destroy();

    const lists = blocks
      .map((block) => detectBulletListFromRegions(block, [...regions.imageRegions], [...regions.shapeMarkerRegions]))
      .filter((list): list is NonNullable<typeof list> => list !== null)
      .filter((list) => list.items.some((item) => item.markerImage));
    expect(lists.length, 'lists whose dots are pictures').toBeGreaterThan(0);

    let checked = 0;
    for (const list of lists) {
      const pictureDots = list.items.filter((item) => item.markerImage).length;
      const old = squash(list.items[0]?.text ?? '').slice(0, 30);
      const texts = list.items.map((item, index) => (index === 0 ? NEW : item.text));
      const built = buildBulletListEdits(
        list,
        {
          text: formatBulletEditorText(texts),
          style: list.block.style,
          width: list.block.rect.w,
          height: list.block.rect.h,
          dx: 0,
          dy: 0,
        },
        texts.map((text) => ({ text, lines: [text] })),
        1,
        availableBulletListHeight(list, blocks, pageTop),
      );
      if (built.overflow) continue;
      expect(originalText, `"${old}" in the original`).toContain(old);

      let patches = 0;
      const exported = await exportPdf({
        originalBytes,
        pages,
        edits: [...built.covers, ...built.texts],
        sampleBackground: () => {
          patches += 1;
          return { r: 1, g: 1, b: 1 };
        },
      });
      const text = await pageText(exported.bytes);
      process.stdout.write(
        `\nPICTURE-DOT LIST "${old}"\n  items ${list.items.length} | picture dots ${pictureDots}`
        + ` | removed text items ${exported.redaction.removedItems}`
        + ` | removed images ${exported.redaction.removedImages}`
        + ` | patches painted ${patches}`
        + ` | warnings ${JSON.stringify(exported.warnings)}\n`,
      );
      expect(exported.warnings).toEqual([]);
      expect(patches, 'patches painted').toBe(0);
      expect(exported.redaction.removedItems).toBeGreaterThan(0);
      expect(exported.redaction.removedImages).toBe(pictureDots);
      expect(text).toContain(squash(NEW));
      expect(text).not.toContain(old);

      // The same export with a white patch forced in under the new list. On this white
      // page the two must look the same: a difference is something the patch was hiding.
      const listCover = built.covers[0]!;
      const forced: CoverEdit = {
        id: 'forced-patch', kind: 'cover', pageIndex: 0, rect: listCover.rect, z: listCover.z, sampleBackground: true,
      };
      const patched = await exportPdf({
        originalBytes,
        pages,
        edits: [...built.covers, forced, ...built.texts],
        sampleBackground: () => ({ r: 1, g: 1, b: 1 }),
      });
      const unpatchedPixels = await renderRegion(exported.bytes, listCover.rect);
      const differing = differingPixels(unpatchedPixels, await renderRegion(patched.bytes, listCover.rect));
      // Control: the comparison must see the change of words, or a zero above means nothing.
      const changed = differingPixels(unpatchedPixels, await renderRegion(originalBytes, listCover.rect));
      process.stdout.write(
        `  pixels that differ from the patched export: ${differing.count} of ${differing.total}`
        + ` | from the original page: ${changed.count}\n`,
      );
      expect(changed.count, 'pixels changed by the edit').toBeGreaterThan(0);
      expect(differing.count, 'pixels the patch was hiding').toBe(0);
      checked += 1;
    }
    expect(checked, 'lists that fitted and were checked').toBeGreaterThan(0);
  });
});
