import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import type { CoverEdit, Edit, TextEdit, TextStyle } from '@/lib/export/types';
import { createPagePlan, deletePage, duplicatePage, insertBlankPage } from '@/state/pagePlan';
import { getDocumentText } from './documentText';
import { getEditedDocumentText } from './editedDocumentText';
import { extractTextRuns, mergeRunsIntoLines } from './textContent';
import type { TextRun } from './textContent';

const openDocuments: PDFDocumentProxy[] = [];
const style: TextStyle = { fontName: 'Helvetica', fontSizePt: 12, bold: false, italic: false, color: { r: 0, g: 0, b: 0 } };
let sequence = 0;
const id = () => `chat-text-test-${sequence++}`;

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(openDocuments.splice(0).map(doc => doc.destroy()));
});

async function open(bytes: Uint8Array): Promise<PDFDocumentProxy> {
  const doc = await getDocument({ data: bytes.slice(), verbosity: 0 }).promise;
  openDocuments.push(doc);
  return doc;
}

async function fixture(pageCount = 3): Promise<PDFDocumentProxy> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  for (let n = 1; n <= pageCount; n++) {
    const page = pdf.addPage([612, 792]);
    for (const [text, y] of [[`Before page ${n}`, 720], ['Fee: Rs. 5,000', 680], [`After page ${n}`, 640]] as const) {
      page.drawText(text, { x: 72, y, size: 12, font });
    }
  }
  return open(await pdf.save());
}

function cover(run: TextRun, extra: Partial<CoverEdit> = {}): CoverEdit {
  return { id: id(), kind: 'cover', pageIndex: run.pageIndex, rect: run.rect, z: 1, sampleBackground: true,
    replaces: [{ text: run.text, rect: run.rect }], ...extra };
}

function text(run: TextRun, value = 'Fee: Rs. 7,500', extra: Partial<TextEdit> = {}): TextEdit {
  return { id: id(), kind: 'text', pageIndex: run.pageIndex, rect: run.rect, z: 2, text: value, style: run.style, ...extra };
}

async function feeRun(doc: PDFDocumentProxy, pageIndex = 0) {
  const runs = await extractTextRuns(await doc.getPage(pageIndex + 1), pageIndex);
  return runs.find(run => run.text.includes('5,000'))!;
}

describe('getEditedDocumentText', () => {
  it('returns the exact cached original result for identity pages, including non-text edits', async () => {
    const doc = await fixture();
    const original = await getDocumentText(doc);
    const getPage = vi.spyOn(doc, 'getPage');
    expect(await getEditedDocumentText(doc, [])).toBe(original);
    expect(await getEditedDocumentText(doc, [], createPagePlan(3, id))).toBe(original);
    expect(await getEditedDocumentText(doc, [{ id: id(), kind: 'image', pageIndex: 0, rect: { x: 0, y: 0, w: 50, h: 50 }, z: 1, bytes: new Uint8Array() }])).toBe(original);
    expect(getPage).not.toHaveBeenCalled();
  });

  it('replaces a paragraph between the same neighbours, without changing original extraction', async () => {
    const doc = await fixture();
    const run = await feeRun(doc);
    const result = await getEditedDocumentText(doc, [cover(run), text(run)]);
    expect(result.pages[0]).toBe('Before page 1\nFee: Rs. 7,500\nAfter page 1');
    expect(result.pages[0]).not.toContain('5,000');
    expect((await getDocumentText(doc)).pages[0]).toContain('5,000');
  });

  it('removes deleted text, and places Add text by its position rather than edit-array order', async () => {
    const doc = await fixture();
    const run = await feeRun(doc);
    const added = text(run, 'Payment due tomorrow', { origin: 'free', rect: { ...run.rect, y: 660 } });
    const result = await getEditedDocumentText(doc, [added, cover(run)]);
    expect(result.pages[0]).toBe('Before page 1\nPayment due tomorrow\nAfter page 1');
  });

  it('matches named runs, not identical text elsewhere or the padded paragraph envelope', async () => {
    const doc = await fixture();
    const run = await feeRun(doc);
    const large = cover(run, { rect: { x: 0, y: 0, w: 612, h: 792 } });
    const result = await getEditedDocumentText(doc, [large, text(run)]);
    expect(result.pages[0]).toBe('Before page 1\nFee: Rs. 7,500\nAfter page 1');
    expect(result.pages[1]).toContain('5,000');
  });

  it('does not duplicate source-visible words retained by positioned text compositions', async () => {
    const pdf = await PDFDocument.create();
    const page = pdf.addPage([612, 792]);
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    page.drawText('Fee:', { x: 72, y: 680, font, size: 12 });
    page.drawText('Rs. 5,000', { x: 105, y: 680, font, size: 12 });
    const doc = await open(await pdf.save());
    const runs = await extractTextRuns(await doc.getPage(1), 0);
    const label = runs.find(run => run.text === 'Fee:')!;
    const amount = runs.find(run => run.text.includes('5,000'))!;
    const replacement = text(label, 'Fee: Rs. 7,500', {
      composition: { version: 1, text: 'Fee: Rs. 7,500', alignment: 'left', alignmentLeftPt: 72, alignmentWidthPt: 200, style,
        pieces: [{ text: label.text, x: 72, baselineY: 680, widthPt: label.rect.w, style, sourceVisible: true, sourceRect: label.rect }] },
    });
    const result = await getEditedDocumentText(doc, [cover(amount), replacement]);
    expect(result.pages[0]).toBe('Fee: Rs. 7,500');
  });

  it('distinguishes legacy whiteout from photo/shape-only covers and explicit empty replacements', async () => {
    const doc = await fixture();
    const run = await feeRun(doc);
    const original = await getDocumentText(doc);
    const imageCover = cover(run, { replaces: undefined, replacesImages: [{ kind: 'image', rect: run.rect }] });
    const shapeCover = cover(run, { replaces: undefined, replacesShapes: [{ rect: run.rect }] });
    expect(await getEditedDocumentText(doc, [imageCover, shapeCover])).toBe(original);
    expect((await getEditedDocumentText(doc, [cover(run, { replaces: [] })])).full).toBe(original.full);
    expect((await getEditedDocumentText(doc, [cover(run, { replaces: undefined })])).pages[0]).not.toContain('5,000');
  });

  it('includes text for image-marker lists, but not old text or empty deletion anchors', async () => {
    const doc = await fixture();
    const run = await feeRun(doc);
    const result = await getEditedDocumentText(doc, [cover(run, { replacesImages: [{ kind: 'image', rect: run.rect }] }), text(run, '• Updated fee'), text(run, '')]);
    expect(result.pages[0]).toContain('• Updated fee');
    expect(result.pages[0]).not.toContain('5,000');
  });

  it('honours later legacy whiteouts over placed text', async () => {
    const doc = await fixture();
    const run = await feeRun(doc);
    const result = await getEditedDocumentText(doc, [cover(run, { replaces: undefined, z: 3 }), text(run)]);
    expect(result.pages[0]).toBe('Before page 1\nAfter page 1');
  });

  it('keeps words separated when an edited cell box is wider than its actual ink', async () => {
    const pdf = await PDFDocument.create();
    const page = pdf.addPage([612, 792]);
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    for (const [value, x] of [['Fee:', 72], ['5,000', 110], ['including tax', 155]] as const) {
      page.drawText(value, { x, y: 680, size: 12, font });
    }
    const doc = await open(await pdf.save());
    const run = await feeRun(doc);
    const result = await getEditedDocumentText(doc, [cover(run), text(run, '7,500', { rect: { ...run.rect, w: 200 } })]);
    expect(result.pages[0]?.replace(/\s+/g, ' ')).toBe('Fee: 7,500 including tax');
  });

  it('replaces a multi-line paragraph once, in order between its untouched neighbours', async () => {
    const pdf = await PDFDocument.create();
    const page = pdf.addPage([612, 792]);
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    ['Before paragraph', 'Old first line', 'Old second line', 'Old third line', 'After paragraph'].forEach((value, index) => {
      page.drawText(value, { x: 72, y: 720 - index * 20, size: 12, font });
    });
    const doc = await open(await pdf.save());
    const runs = await extractTextRuns(await doc.getPage(1), 0);
    const old = runs.filter(run => run.text.startsWith('Old'));
    const result = await getEditedDocumentText(doc, [
      ...old.map(run => cover(run)),
      text(old[0]!, 'New first line'),
      text(old[1]!, 'New second line'),
    ]);
    expect(result.pages[0]).toBe('Before paragraph\nNew first line\nNew second line\nAfter paragraph');
  });

  it('deletes and renumbers current pages', async () => {
    const doc = await fixture();
    const next = deletePage(createPagePlan(3, id), [], 0);
    const result = await getEditedDocumentText(doc, next.edits, next.plan);
    expect(result.pages).toHaveLength(2);
    expect(result.full).toContain('[Page 1]\nBefore page 2');
    expect(result.full).toContain('[Page 2]\nBefore page 3');
    expect(result.full).not.toContain('Before page 1');
    expect(result.full).not.toContain('[Page 3]');
  });

  it('inserts a blank page with added text, duplicates edits and moves pages in live order', async () => {
    const doc = await fixture();
    const run = await feeRun(doc);
    const duplicated = duplicatePage(createPagePlan(3, id), [cover(run), text(run)], 0, id);
    const inserted = insertBlankPage(duplicated.plan, duplicated.edits, 1, { widthPt: 612, heightPt: 792 }, id);
    const edits = [...inserted.edits, text(run, 'Added on blank', { pageIndex: 2, origin: 'free' })];
    const result = await getEditedDocumentText(doc, edits, inserted.plan);
    expect(result.pages[0]).toBe(result.pages[1]);
    expect(result.pages[0]).toContain('7,500');
    expect(result.pages[2]).toBe('Added on blank');
    expect(result.pages[3]).toContain('Before page 2');
    const plan = createPagePlan(3, id);
    const moved = await getEditedDocumentText(doc, [], [plan[2]!, plan[0]!, plan[1]!]);
    expect(moved.pages.map(page => page.split('\n')[0])).toEqual(['Before page 3', 'Before page 1', 'Before page 2']);
    expect(moved.full).toContain('[Page 1]\nBefore page 3');
  });

  it('an empty blank page still has a page marker', async () => {
    const doc = await fixture(1);
    const next = insertBlankPage(createPagePlan(1, id), [], 0, { widthPt: 612, heightPt: 792 }, id);
    const result = await getEditedDocumentText(doc, next.edits, next.plan);
    expect(result.pages[1]).toBe('');
    expect(result.full.endsWith('[Page 2]')).toBe(true);
  });

  it('rebuilds only edited pages, caches geometry and reads edits afresh on the next question', async () => {
    const doc = await fixture();
    const original = await getDocumentText(doc);
    const run = await feeRun(doc, 2);
    const getPage = vi.spyOn(doc, 'getPage');
    const edits = [cover(run), text(run)];
    const first = await getEditedDocumentText(doc, edits);
    expect(first.pages.slice(0, 2)).toEqual(original.pages.slice(0, 2));
    expect(getPage.mock.calls).toEqual([[3]]);
    const second = await getEditedDocumentText(doc, [edits[0]!, text(run, 'Fee: Rs. 9,000')]);
    expect(second.pages[2]).toContain('9,000');
    expect(second.pages[2]).not.toContain('7,500');
    expect(getPage).toHaveBeenCalledTimes(1);
    expect(await getEditedDocumentText(doc, [])).toBe(original); // Undo.
  });

  it('retries a failed edited-page read instead of caching its rejection', async () => {
    const doc = await fixture();
    await getDocumentText(doc);
    const run = await feeRun(doc);
    vi.spyOn(doc, 'getPage').mockRejectedValueOnce(new Error('temporary page read failure'));
    const edits = [cover(run), text(run)];
    await expect(getEditedDocumentText(doc, edits)).rejects.toThrow('temporary page read failure');
    expect((await getEditedDocumentText(doc, edits)).pages[0]).toContain('7,500');
  });
});

const realFixtures = [
  ['Healing', 'tmp/compress-tests/healing.pdf'],
  ['Corporate', 'public/samples/Corporate-Governance.pdf'],
  ['Ladakh', 'tmp/compress-tests/ladakh-original.pdf'],
  ['Rahul résumé', 'tmp/bullets/RAHUL_RAJPUT_RESUME.pdf'],
] as const;

describe.runIf(process.env.TASK81_REAL === '1')('Task 81 real PDFs', () => {
  it('keeps all four unedited documents byte-equal, and measures Corporate builds', { timeout: 300_000 }, async () => {
    const measurements: unknown[] = [];
    for (const [name, path] of realFixtures) {
      expect(existsSync(path), path).toBe(true);
      const doc = await open(new Uint8Array(await readFile(path)));
      const coldStart = performance.now();
      const original = await getDocumentText(doc);
      const coldMs = performance.now() - coldStart;
      const plan = createPagePlan(doc.numPages, id);
      const start = performance.now();
      const unchanged = await getEditedDocumentText(doc, [], plan);
      const noEditsMs = performance.now() - start;
      expect(unchanged).toBe(original);
      expect(unchanged.full).toBe(original.full);
      expect(unchanged.pages).toEqual(original.pages);
      let editedFirstMs: number | undefined;
      let editedWarmMs: number | undefined;
      if (name === 'Corporate') {
        const runs = await extractTextRuns(await doc.getPage(3), 2);
        const lines = mergeRunsIntoLines(runs);
        const target = lines.find(line => line.text.length > 60)!;
        const edits: Edit[] = [
          { id: id(), kind: 'cover', pageIndex: 2, rect: target.rect, z: 1, sampleBackground: true,
            replaces: target.runs.map(run => ({ text: run.text, rect: run.rect })) },
          { id: id(), kind: 'text', pageIndex: 2, rect: target.rect, z: 2, text: 'Task 81 revised fee: Rs. 7,500', style: target.style },
        ];
        const editStart = performance.now();
        const edited = await getEditedDocumentText(doc, edits, plan);
        editedFirstMs = performance.now() - editStart;
        const warmStart = performance.now();
        expect((await getEditedDocumentText(doc, edits, plan)).full).toBe(edited.full);
        editedWarmMs = performance.now() - warmStart;
        expect(edited.pages.slice(0, 2)).toEqual(original.pages.slice(0, 2));
        expect(edited.pages[2]).toContain('Task 81 revised fee: Rs. 7,500');
        expect(edited.pages[2]).not.toContain(target.text);
      }
      measurements.push({ name, path, pages: doc.numPages, charCount: original.charCount, coldMs, noEditsMs, editedFirstMs, editedWarmMs });
    }
    await mkdir('tmp/task81', { recursive: true });
    await writeFile('tmp/task81/measurements.json', JSON.stringify(measurements, null, 2));
    console.info('TASK81 measurements', JSON.stringify(measurements));
  });
});
