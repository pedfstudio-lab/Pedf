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
  detectTextAlignment,
  extractTextRuns,
  fontStyleFromProgram,
  groupRunsIntoBlocks,
  hitTestRun,
  mergeRunsIntoLines,
} from './textContent';

const openDocuments: PDFDocumentProxy[] = [];

function makeSfnt(weight: number, macStyle = 0): Uint8Array {
  const os2Offset = 44;
  const headOffset = 52;
  const data = new Uint8Array(headOffset + 46);
  const view = new DataView(data.buffer);
  view.setUint32(0, 0x00010000);
  view.setUint16(4, 2);

  data.set([0x4f, 0x53, 0x2f, 0x32], 12); // OS/2
  view.setUint32(12 + 8, os2Offset);
  view.setUint32(12 + 12, 6);

  data.set([0x68, 0x65, 0x61, 0x64], 28); // head
  view.setUint32(28 + 8, headOffset);
  view.setUint32(28 + 12, 46);

  view.setUint16(os2Offset + 4, weight);
  view.setUint16(headOffset + 44, macStyle);
  return data;
}

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

describe('fontStyleFromProgram', () => {
  it('detects bold from OS/2 usWeightClass', () => {
    expect(fontStyleFromProgram(makeSfnt(700))).toEqual({ bold: true, italic: false });
    expect(fontStyleFromProgram(makeSfnt(400))).toEqual({ bold: false, italic: false });
  });

  it('detects bold and italic from head.macStyle', () => {
    expect(fontStyleFromProgram(makeSfnt(400, 0x1))).toEqual({ bold: true, italic: false });
    expect(fontStyleFromProgram(makeSfnt(400, 0x2))).toEqual({ bold: false, italic: true });
    expect(fontStyleFromProgram(makeSfnt(400, 0x3))).toEqual({ bold: true, italic: true });
  });

  it.each([
    undefined,
    new Uint8Array(0),
    new Uint8Array(11),
    new Uint8Array(12),
    (() => {
      const data = new Uint8Array(12);
      new DataView(data.buffer).setUint16(4, 65);
      return data;
    })(),
  ])('returns null for missing, short, or malformed data', (data) => {
    expect(fontStyleFromProgram(data)).toBeNull();
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

  it('detects generic-named Corporate Governance heading weight from the font program', async () => {
    const bytes = new Uint8Array(await readFile('public/samples/Corporate-Governance.pdf'));
    const document = await getDocument({
      data: bytes,
      fontExtraProperties: true,
      verbosity: 0,
    }).promise;
    openDocuments.push(document);
    const runs = await extractTextRuns(await document.getPage(1), 0);
    const headingRuns = runs.filter((run) => /CORPORATE|GOVERNANCE/.test(run.text));
    const bodyRun = runs.find((run) => run.text.includes('Email'));

    expect(headingRuns.length).toBeGreaterThan(0);
    expect(headingRuns.every((run) => run.style.bold)).toBe(true);
    expect(bodyRun?.style.bold).toBe(false);
  });

  it('normalizes Word U+F0B7 bullets to a standard-font bullet during extraction', async () => {
    const bytes = new Uint8Array(await readFile('public/samples/Corporate-Governance.pdf'));
    const document = await getDocument({ data: bytes, verbosity: 0 }).promise;
    openDocuments.push(document);
    const runs = await extractTextRuns(await document.getPage(7), 6);
    const bulletRuns = runs.filter((run) => run.text === '•');

    expect(bulletRuns).toHaveLength(18);
    expect(bulletRuns.every((run) => run.style.fontRef === undefined)).toBe(true);
    expect(runs.some((run) => run.text.includes('\uF0B7'))).toBe(false);
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
        dy: -10,
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
    expect(replacementRun?.rect.y).toBeCloseTo(heading.topBaselineY - 10, 5);
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

  it('detects centered, right-aligned, and ordinary left-aligned lines', () => {
    expect(detectTextAlignment({ x: 210, y: 500, w: 180, h: 20 }, 50, 550, 18)).toBe('center');
    expect(detectTextAlignment({ x: 430, y: 500, w: 120, h: 12 }, 50, 550, 10)).toBe('right');
    expect(detectTextAlignment({ x: 50, y: 500, w: 320, h: 12 }, 50, 550, 10)).toBe('left');
  });

  it('carries the page alignment column onto lines and blocks', () => {
    const blocks = groupRunsIntoBlocks([
      run('Left edge', 50, 460, 80),
      run('Centered title', 220, 500, 160),
      run('Right date', 470, 440, 80),
    ]);

    expect(blocks.map((block) => ({
      text: block.text,
      align: block.align,
      left: block.alignLeftPt,
      width: block.alignWidthPt,
    }))).toEqual([
      { text: 'Centered title', align: 'center', left: 50, width: 500 },
      { text: 'Left edge', align: 'left', left: 50, width: 500 },
      { text: 'Right date', align: 'right', left: 50, width: 500 },
    ]);
  });

  it('detects the Corporate Governance cover title as centered', async () => {
    const bytes = new Uint8Array(await readFile('public/samples/Corporate-Governance.pdf'));
    const document = await getDocument({ data: bytes, verbosity: 0 }).promise;
    openDocuments.push(document);
    const blocks = groupRunsIntoBlocks(await extractTextRuns(await document.getPage(1), 0));
    const title = blocks.find((block) => block.text === 'CORPORATE GOVERNANCE');
    expect(title).toMatchObject({
      align: 'center',
    });
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

  it('groups eighteen uniform short normalized-bullet lines into one block', () => {
    const bulletRuns = Array.from({ length: 18 }, (_, index) => {
      const y = 500 - index * 15;
      return [
        run('•', 80, y, 4.5),
        run(`Item ${index + 1}`, 90, y, 38),
      ];
    }).flat();
    const blocks = groupRunsIntoBlocks(bulletRuns);

    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.lines).toHaveLength(18);
    expect(blocks[0]?.text.split('\n')).toEqual(
      Array.from({ length: 18 }, (_, index) => `• Item ${index + 1}`),
    );
  });

  it('does not merge a short bullet line with an adjacent short non-bullet line', () => {
    const blocks = groupRunsIntoBlocks([
      run('•', 80, 500, 4.5),
      run('Bullet item', 90, 500, 48),
      run('Short field', 80, 485, 45),
    ]);

    expect(blocks.map((block) => block.text)).toEqual([
      '• Bullet item',
      'Short field',
    ]);
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
