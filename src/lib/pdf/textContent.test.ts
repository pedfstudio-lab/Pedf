import { afterEach, describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { buildTextBlockEdits } from '@/lib/edit/buildTextEdits';
import { exportPdf } from '@/lib/export/exportPdf';
import type { PageGeometry } from './types';
import type { TextRun } from './textContent';
import {
  classifyFontStyle,
  classifyFontFamily,
  extractTextRuns,
  groupRunsIntoBlocks,
  hitTestRun,
  mergeRunsIntoLines,
} from './textContent';

const openDocuments: PDFDocumentProxy[] = [];

afterEach(async () => {
  await Promise.all(openDocuments.splice(0).map((document) => document.destroy()));
});

describe('classifyFontStyle', () => {
  it.each([
    ['Helvetica', false, false],
    ['Arial-BoldMT', true, false],
    ['Times-Italic', false, true],
    ['Helvetica-BoldOblique', true, true],
    ['SourceSansPro-Semibold', true, false],
    ['Inter-700', true, false],
  ])('classifies %s', (fontName, bold, italic) => {
    expect(classifyFontStyle(fontName)).toEqual({ bold, italic });
  });
});

describe('classifyFontFamily', () => {
  it.each([
    ['Times New Roman', 'serif'],
    ['Georgia-Bold', 'serif'],
    ['ABCDEE+Cambria-Bold', 'serif'],
    ['GaramondPremrPro', 'serif'],
    ['MinionPro-Regular', 'serif'],
    ['Book_Antiqua', 'serif'],
    ['PTSerif-Regular', 'serif'],
    ['Merriweather', 'serif'],
    ['NotoSerif', 'serif'],
    ['CourierNewPSMT', 'mono'],
    ['Consolas', 'mono'],
    ['ABCDEE+Helvetica', 'sans'],
    ['Helvetica', 'sans'],
    ['sans-serif', 'sans'],
  ] as const)('classifies %s as %s', (fontName, family) => {
    expect(classifyFontFamily(fontName)).toBe(family);
  });
});

describe('extractTextRuns', () => {
  it('extracts text, PDF-point geometry, and style from a synthetic PDF', async () => {
    const source = await PDFDocument.create();
    const page = source.addPage([612, 792]);
    const font = await source.embedFont(StandardFonts.Helvetica);
    const text = 'Hello';
    const x = 100;
    const y = 700;
    const size = 24;
    const expectedWidth = font.widthOfTextAtSize(text, size);

    page.drawText(text, { x, y, size, font });

    const document = await getDocument({
      data: (await source.save()).slice(),
      verbosity: 0,
    }).promise;
    openDocuments.push(document);
    const runs = await extractTextRuns(await document.getPage(1), 3);

    expect(runs).toHaveLength(1);
    const run = runs[0];
    expect(run?.pageIndex).toBe(3);
    expect(run?.text).toBe(text);
    expect(run?.rect.x).toBeCloseTo(x, 5);
    expect(run?.rect.y).toBeCloseTo(y, 5);
    expect(run?.rect.w).toBeCloseTo(expectedWidth, 5);
    expect(run?.rect.h).toBeCloseTo(size, 5);
    expect(run?.style.fontSizePt).toBeCloseTo(size, 5);
    expect(run?.style.bold).toBe(false);
    expect(run?.style.italic).toBe(false);
    expect(run?.style.color).toEqual({ r: 0, g: 0, b: 0 });
    expect(run?.style.fontRef).toMatch(/^g_d\d+_f\d+$/);
  });

  it('uses the résumé BaseFont names for weight while preserving the public family', async () => {
    const bytes = new Uint8Array(await readFile('public/samples/RAHUL RAJPUT RESUME.pdf'));
    const document = await getDocument({ data: bytes, verbosity: 0 }).promise;
    openDocuments.push(document);
    const runs = await extractTextRuns(await document.getPage(1), 0);
    const educationRuns = runs.filter((run) => (
      ['Master', 'Business', 'Mana', 'gement'].includes(run.text)
    ));

    expect(runs.some((run) => run.text === 'WORK EXPERIENCE' && run.style.bold)).toBe(true);
    expect(runs.some((run) => run.text === 'Sales and Operations' && run.style.bold)).toBe(true);
    expect(educationRuns.length).toBeGreaterThan(0);
    expect(educationRuns.every((run) => run.style.bold)).toBe(true);
    expect(runs.some((run) => (
      run.text.includes('Managed customer interactions') && !run.style.bold && !run.style.italic
    ))).toBe(true);
    expect(runs.find((run) => run.text === 'WORK EXPERIENCE')?.style.fontName).toBe('sans-serif');
  });

  it('round-trips an edited heading through the résumé own bold font resource', async () => {
    const originalBytes = new Uint8Array(
      await readFile('public/samples/RAHUL RAJPUT RESUME.pdf'),
    );
    const document = await getDocument({ data: originalBytes.slice(), verbosity: 0 }).promise;
    openDocuments.push(document);
    const firstPage = await document.getPage(1);
    const blocks = groupRunsIntoBlocks(await extractTextRuns(firstPage, 0));
    const heading = blocks.find((block) => block.text === 'WORK EXPERIENCE');
    if (!heading) throw new Error('WORK EXPERIENCE heading was not extracted');
    expect(heading.style.bold).toBe(true);
    expect(heading.style.fontRef).toBeDefined();

    const replacement = 'WORK EXPERIENCE UPDATED';
    const built = buildTextBlockEdits(
      heading,
      {
        text: replacement,
        style: heading.style,
        width: heading.rect.w,
        height: heading.rect.h,
        dx: 0,
        dy: 0,
      },
      [replacement],
      1,
    );
    const pages: PageGeometry[] = [];
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const [left = 0, bottom = 0, right = 0, top = 0] = page.view;
      pages.push({
        pageIndex: pageNumber - 1,
        widthPt: right - left,
        heightPt: top - bottom,
        rotation: ((page.rotate % 360) + 360) % 360 as PageGeometry['rotation'],
        boxOffset: { x: left, y: bottom },
      });
    }

    const exported = await exportPdf({
      originalBytes,
      edits: [...built.covers, ...built.texts],
      pages,
    });
    const reopened = await getDocument({ data: exported.bytes.slice(), verbosity: 0 }).promise;
    openDocuments.push(reopened);
    const reopenedPage = await reopened.getPage(1);
    const reopenedRuns = await extractTextRuns(reopenedPage, 0);
    const replacementRun = reopenedRuns.find((run) => run.text === replacement);
    expect(replacementRun?.style.bold).toBe(true);
    expect(replacementRun?.style.fontName).toBe('sans-serif');
    expect(replacementRun?.style.fontRef).toBeDefined();
    const fontObject = replacementRun?.style.fontRef && reopenedPage.commonObjs.has(replacementRun.style.fontRef)
      ? reopenedPage.commonObjs.get(replacementRun.style.fontRef)
      : undefined;
    expect(fontObject?.name).toMatch(/Arial Black/i);
    expect(fontObject?.name).not.toMatch(/Helvetica/i);
  });
});

describe('hitTestRun', () => {
  const large: TextRun = {
    pageIndex: 0,
    text: 'large',
    rect: { x: 10, y: 20, w: 100, h: 40 },
    style: {
      fontName: 'Helvetica',
      fontSizePt: 12,
      bold: false,
      italic: false,
      color: { r: 0, g: 0, b: 0 },
    },
  };
  const small: TextRun = {
    ...large,
    text: 'small',
    rect: { x: 30, y: 30, w: 20, h: 10 },
  };

  it('returns the smallest run containing the tap', () => {
    expect(hitTestRun([large, small], { x: 35, y: 35 })).toBe(small);
  });

  it('returns undefined outside every run', () => {
    expect(hitTestRun([large, small], { x: 200, y: 200 })).toBeUndefined();
  });

  it('prefers the later run when equal-area runs overlap', () => {
    const topmost = { ...small, text: 'topmost' };
    expect(hitTestRun([small, topmost], { x: 35, y: 35 })).toBe(topmost);
  });
});

describe('natural text blocks', () => {
  const style = {
    fontName: 'Helvetica',
    fontSizePt: 10,
    bold: false,
    italic: false,
    color: { r: 0, g: 0, b: 0 },
  };
  const run = (text: string, x: number, y: number, w: number): TextRun => ({
    pageIndex: 0,
    text,
    rect: { x, y, w, h: 10 },
    style,
  });

  it('rejoins touching fragments, spaces words, and splits distant columns', () => {
    const lines = mergeRunsIntoLines([
      run('pan', 10, 500, 15),
      run('oramic', 25.2, 500.1, 30),
      run('view', 60, 500, 20),
      run('Other column', 130, 500, 55),
    ]);

    expect(lines.map((line) => line.text)).toEqual(['panoramic view', 'Other column']);
  });

  it('merges aligned paragraph lines but keeps short fields standalone', () => {
    const blocks = groupRunsIntoBlocks([
      run('This is the first descriptive line', 20, 500, 170),
      run('This is the second descriptive line', 20, 486, 175),
      run('This is the final descriptive line', 20, 472, 160),
      run('Mr. Pratik', 260, 500, 50),
      run('2 Adults', 260, 486, 45),
    ]);

    expect(blocks).toHaveLength(3);
    expect(blocks[0]?.text).toBe(
      'This is the first descriptive line\nThis is the second descriptive line\nThis is the final descriptive line',
    );
    expect(blocks.slice(1).map((block) => block.text)).toEqual(['Mr. Pratik', '2 Adults']);
  });

  it('keeps short numbers separate across columns and from nearby descriptive rows', () => {
    const blocks = groupRunsIntoBlocks([
      run('1', 20, 500, 5),
      run('2', 31, 500, 5),
      run('This descriptive row must not absorb the number above it', 20, 486, 220),
      run('3', 20, 440, 5),
    ]);

    expect(blocks.map((block) => block.text)).toEqual([
      '1',
      '2',
      'This descriptive row must not absorb the number above it',
      '3',
    ]);
  });
});
