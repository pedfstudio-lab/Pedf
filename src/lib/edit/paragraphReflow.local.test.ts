import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { exportPdf } from '@/lib/export/exportPdf';
import type { Edit } from '@/lib/export/types';
import type { PageGeometry } from '@/lib/pdf/types';
import { extractTextRuns, groupRunsIntoBlocks } from '@/lib/pdf/textContent';
import {
  editorWidthMeasurementText,
  paragraphSeedText,
  widestLineWidth,
} from './paragraphSeed';
import {
  calculateInitialEditorWidth,
  finishTextEdit,
  type TextEditSessionValue,
} from './textEditSession';

const fixture = 'tmp/paragraphs/Corporate-Governance-edited (25).pdf';
const enabled = process.env.TASK72_REAL === '1' && existsSync(fixture);
if (!enabled) {
  process.stdout.write(
    'Task 72 real paragraph check skipped: set TASK72_REAL=1 with the Corporate Governance fixture present.\n',
  );
}

const documents: PDFDocumentProxy[] = [];

async function open(bytes: Uint8Array): Promise<PDFDocumentProxy> {
  const document = await getDocument({ data: bytes.slice(), verbosity: 0 }).promise;
  documents.push(document);
  return document;
}

async function geometry(document: PDFDocumentProxy): Promise<PageGeometry[]> {
  return Promise.all(Array.from({ length: document.numPages }, async (_, pageIndex) => {
    const page = await document.getPage(pageIndex + 1);
    const [left = 0, bottom = 0, right = 0, top = 0] = page.view;
    return {
      pageIndex,
      widthPt: right - left,
      heightPt: top - bottom,
      rotation: ((page.rotate % 360) + 360) % 360 as PageGeometry['rotation'],
      boxOffset: { x: left, y: bottom },
    };
  }));
}

async function printableTextItems(document: PDFDocumentProxy, pageNumber: number) {
  const content = await (await document.getPage(pageNumber)).getTextContent();
  return content.items.flatMap((item) => {
    if (!('str' in item) || item.str.trim() === '' || item.width === 0) return [];
    return [{
      str: item.str,
      dir: item.dir,
      width: item.width,
      height: item.height,
      transform: [...item.transform],
      fontName: item.fontName.replace(/^g_d\d+_/, 'g_d#_'),
      hasEOL: item.hasEOL,
    }];
  });
}

afterEach(async () => {
  await Promise.all(documents.splice(0).map((document) => document.destroy()));
});

describe.skipIf(!enabled)('Task 72 real paragraph reflow', () => {
  it('seeds the six-line paragraph as flowing text and exports unchanged Done without edits', async () => {
    const originalBytes = new Uint8Array(await readFile(fixture));
    const source = await open(originalBytes);
    const page = await source.getPage(3);
    const blocks = groupRunsIntoBlocks(await extractTextRuns(page, 2));
    const block = blocks.find((candidate) => (
      candidate.text.startsWith('A number of Postgraduate Departments')
    ));

    expect(block, 'the measured Corporate Governance paragraph').toBeDefined();
    if (!block) return;
    expect(block.lines).toHaveLength(6);
    const seed = paragraphSeedText(block);
    const expectedSeed = block.lines
      .map((line) => line.text.trim().replace(/\s+/g, ' '))
      .join(' ')
      .replace(/\s+/g, ' ');
    expect(seed).toBe(expectedSeed);
    expect(seed).not.toContain('\n');
    const measurementText = editorWidthMeasurementText(block);
    expect(measurementText).toBe(block.text);
    const longestLineLength = Math.max(...block.lines.map((line) => line.text.length));
    const fakeCharacterWidth = block.rect.w / longestLineLength;
    const measuredWidth = widestLineWidth(
      measurementText,
      (line) => line.length * fakeCharacterWidth,
    );
    const [pageLeft = 0, , pageRight = 0] = page.view;
    const pageWidthPt = pageRight - pageLeft;
    const initialWidth = calculateInitialEditorWidth({
      blockWidthPt: block.rect.w,
      blockXPt: block.rect.x,
      fontSizePt: block.style.fontSizePt,
      measuredLineWidthPt: measuredWidth,
      pageWidthPt,
    });
    const pageBound = pageWidthPt - block.rect.x;
    expect(initialWidth).toBeLessThanOrEqual(block.rect.w + fakeCharacterWidth);
    expect(initialWidth).toBeLessThan(pageBound);

    const opened: TextEditSessionValue = {
      text: seed,
      style: block.style,
      width: block.rect.w,
      height: block.rect.h,
      dx: 0,
      dy: 0,
      align: block.align ?? 'left',
      alignLeftPt: block.alignLeftPt ?? block.rect.x,
      alignWidthPt: block.alignWidthPt ?? block.rect.w,
    };
    const edits: Edit[] = [];
    const outcome = finishTextEdit(
      opened,
      { ...opened },
      () => {
        throw new Error('unchanged Done must not build or add edits');
      },
      () => undefined,
    );
    expect(outcome).toBe('cancelled');
    expect(edits).toEqual([]);
    expect(edits.filter((edit) => edit.kind === 'cover')).toEqual([]);

    const before = await printableTextItems(source, 3);
    const exported = await exportPdf({
      originalBytes,
      pages: await geometry(source),
      edits,
    });
    const reopened = await open(exported.bytes);
    expect(await printableTextItems(reopened, 3)).toEqual(before);
    process.stdout.write(
      `TASK72 REAL page 3 | lines ${block.lines.length} | seed ${seed.length} chars`
      + ` | width ${initialWidth.toFixed(1)} pt | edits ${edits.length}`
      + ` | text items ${before.length}\n`,
    );
  }, 60_000);
});
