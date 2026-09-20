import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { getDocument, OPS } from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
import { buildBulletListEdits, buildTextBlockEdits } from '@/lib/edit/buildTextEdits';
import { exportPdf } from '@/lib/export/exportPdf';
import type { PageGeometry } from './types';
import { detectImages } from './images';
import {
  availableBulletListHeight,
  bulletListHeadingBlock,
  detectBulletListFromRegions,
  detectBulletMarkers,
  detectTextBulletMarkers,
  formatBulletEditorText,
  isBulletListBlock,
  nextBlockBelowBulletList,
  parseBulletEditorItemSpans,
  parseBulletEditorItems,
} from './bulletList';
import { extractTextRuns, groupRunsIntoBlocks } from './textContent';
import type { TextBlock, TextLine } from './textContent';

let documentProxy: PDFDocumentProxy;
let firstPage: PDFPageProxy;
let blocks: TextBlock[];
let imageRegions: Awaited<ReturnType<typeof detectImages>>;
let resumeBytes: Uint8Array;
let governanceDocumentProxy: PDFDocumentProxy;
let governancePageSevenBlocks: TextBlock[];
let governanceBytes: Uint8Array;

beforeAll(async () => {
  const bytes = await readFile('public/samples/RAHUL RAJPUT RESUME.pdf');
  resumeBytes = new Uint8Array(bytes);
  documentProxy = await getDocument({ data: resumeBytes.slice(), verbosity: 0 }).promise;
  firstPage = await documentProxy.getPage(1);
  blocks = groupRunsIntoBlocks(await extractTextRuns(firstPage, 0));
  imageRegions = await detectImages(firstPage, 0);

  governanceBytes = new Uint8Array(
    await readFile('public/samples/Corporate-Governance.pdf'),
  );
  governanceDocumentProxy = await getDocument({
    data: governanceBytes.slice(),
    verbosity: 0,
  }).promise;
  const governancePageSeven = await governanceDocumentProxy.getPage(7);
  governancePageSevenBlocks = groupRunsIntoBlocks(
    await extractTextRuns(governancePageSeven, 6),
  );
});

afterAll(async () => {
  await documentProxy?.destroy();
  await governanceDocumentProxy?.destroy();
});

function fixtureBlock(firstText: string, lastText: string): TextBlock {
  const block = blocks.find((candidate) => (
    candidate.text.includes(firstText) && candidate.text.includes(lastText)
  ));
  if (!block) {
    throw new Error(`Fixture block not found: ${firstText} ... ${lastText}`);
  }
  return block;
}

describe('RAHUL résumé bullet detection', () => {
  it('detects every Firgun bullet and no continuation line', () => {
    const block = fixtureBlock('Joined Firgun Travels', 'vendor communication, planning, and execution');
    const markers = detectBulletMarkers(block, imageRegions);

    expect(markers).toHaveLength(6);
    expect(markers.every((marker) => marker.markerRun === undefined)).toBe(true);
    expect(markers.map((marker) => Number(marker.line.baselineY.toFixed(2)))).toEqual([
      412.92,
      384.12,
      370.18,
      341.62,
      313.06,
      284.71,
    ]);
    expect(markers.every((marker) => Math.abs(marker.rect.x - 56.65) < 0.01)).toBe(true);
  });

  it('detects every Travelmite bullet and groups wrapped lines into five items', () => {
    const block = fixtureBlock('Screened 30+', 'personnel files with accuracy');
    const list = detectBulletListFromRegions(block, imageRegions);

    expect(list).not.toBeNull();
    expect(list?.items).toHaveLength(5);
    expect(list?.items.every((item) => item.markerRun === undefined)).toBe(true);
    expect(list?.items.map((item) => item.lines.length)).toEqual([2, 2, 2, 2, 2]);
    expect(list?.items.map((item) => Number(item.baselineY.toFixed(2)))).toEqual([
      205.25,
      176.69,
      148.37,
      119.54,
      91.46,
    ]);
    expect(list?.bulletX).toBeCloseTo(56.65, 2);
    expect(list?.bulletSizePt).toBeCloseTo(3.1, 1);
    expect(list?.coverRect.x).toBeLessThan(block.rect.x);
  });

  it('returns null for a non-bulleted paragraph', () => {
    const block = fixtureBlock('Tourism professional', 'operations.');
    expect(detectBulletListFromRegions(block, imageRegions)).toBeNull();
  });

  it('keeps bold job titles separate from normal bullet-list blocks', () => {
    const lists = blocks.flatMap((block) => {
      const list = detectBulletListFromRegions(block, imageRegions);
      return list ? [list] : [];
    });
    const boldJobTitles = blocks.filter((block) => (
      block.style.bold && /Firgun Travels|Travelmite|WANDERON/.test(block.text)
    ));

    expect(lists.length).toBeGreaterThan(0);
    expect(boldJobTitles.length).toBeGreaterThan(0);
    expect(lists.every((list) => bulletListHeadingBlock(list) === null)).toBe(true);
    expect(lists.every((list) => !list.sourceBlock.style.bold)).toBe(true);
  });

  it('bounds Firgun at the untouched Travelmite section', () => {
    const firgun = detectBulletListFromRegions(
      fixtureBlock('Joined Firgun Travels', 'vendor communication, planning, and execution'),
      imageRegions,
    );
    expect(firgun).not.toBeNull();
    const boundary = firgun ? nextBlockBelowBulletList(firgun, blocks) : undefined;
    expect(boundary?.text).toContain('Travelmite');
    expect(firgun ? availableBulletListHeight(firgun, blocks) : 0).toBeGreaterThan(
      firgun?.coverRect.h ?? Number.POSITIVE_INFINITY,
    );
  });

  it('owns each detected list block without claiming ordinary headings', () => {
    const firgunBlock = fixtureBlock(
      'Joined Firgun Travels',
      'vendor communication, planning, and execution',
    );
    const firgun = detectBulletListFromRegions(firgunBlock, imageRegions);
    if (!firgun) throw new Error('Firgun bullet list was not detected');
    const heading = fixtureBlock('WORK EXPERIENCE', 'WORK EXPERIENCE');

    expect(isBulletListBlock(firgunBlock, [firgun])).toBe(true);
    expect(isBulletListBlock(heading, [firgun])).toBe(false);
  });

  it('exports owned bullets as selectable text through the unchanged edit seam', async () => {
    const firgun = detectBulletListFromRegions(
      fixtureBlock('Joined Firgun Travels', 'vendor communication, planning, and execution'),
      imageRegions,
    );
    if (!firgun) throw new Error('Firgun bullet list was not detected');
    const itemLayouts = [
      ...firgun.items.map((item) => ({
        text: item.text,
        lines: item.lines.map((line) => line.text),
      })),
      { text: 'Added export bullet', lines: ['Added export bullet'] },
    ];
    const built = buildBulletListEdits(
      firgun,
      {
        text: formatBulletEditorText(itemLayouts.map((item) => item.text)),
        style: firgun.block.style,
        width: firgun.coverRect.w,
        height: firgun.coverRect.h,
        dx: 0,
        dy: 0,
      },
      itemLayouts,
      1,
      500,
    );
    const pages: PageGeometry[] = [];
    for (let pageNumber = 1; pageNumber <= documentProxy.numPages; pageNumber += 1) {
      const page = await documentProxy.getPage(pageNumber);
      const [left = 0, bottom = 0, right = 0, top = 0] = page.view;
      const rotation = ((page.rotate % 360) + 360) % 360 as PageGeometry['rotation'];
      pages.push({
        pageIndex: pageNumber - 1,
        widthPt: right - left,
        heightPt: top - bottom,
        rotation,
        boxOffset: { x: left, y: bottom },
      });
    }

    const result = await exportPdf({
      originalBytes: resumeBytes,
      edits: [...built.covers, ...built.texts],
      pages,
    });
    const reopened = await getDocument({ data: result.bytes.slice(), verbosity: 0 }).promise;
    try {
      const content = await (await reopened.getPage(1)).getTextContent();
      const strings = content.items
        .filter((item): item is Extract<typeof item, { str: string }> => 'str' in item)
        .map((item) => item.str);
      expect(strings.filter((text) => text === '•')).toHaveLength(7);
      expect(strings.join(' ')).toContain('Added export bullet');
    } finally {
      await reopened.destroy();
    }
  });

  it('round-trips a partially bold bullet without losing bullets or text', async () => {
    const firgun = detectBulletListFromRegions(
      fixtureBlock('Joined Firgun Travels', 'vendor communication, planning, and execution'),
      imageRegions,
    );
    if (!firgun) throw new Error('Firgun bullet list was not detected');
    const firstText = 'Bold word survives';
    const itemTexts = [firstText, ...firgun.items.slice(1).map((item) => item.text)];
    const editorText = formatBulletEditorText(itemTexts);
    const editorSpans = [
      { text: '• ', bold: false, italic: false },
      { text: 'Bold', bold: true, italic: false },
      { text: editorText.slice('• Bold'.length), bold: false, italic: false },
    ];
    const itemLayouts = [
      {
        text: firstText,
        lines: [{
          text: firstText,
          spans: [
            { text: 'Bold', bold: true, italic: false },
            { text: ' word survives', bold: false, italic: false },
          ],
        }],
      },
      ...firgun.items.slice(1).map((item) => ({
        text: item.text,
        lines: item.lines.map((line) => line.text),
      })),
    ];
    const built = buildBulletListEdits(
      firgun,
      {
        text: editorText,
        spans: editorSpans,
        style: firgun.block.style,
        width: firgun.coverRect.w,
        height: firgun.coverRect.h,
        dx: 0,
        dy: 0,
      },
      itemLayouts,
      1,
      500,
    );
    const pages: PageGeometry[] = [];
    for (let pageNumber = 1; pageNumber <= documentProxy.numPages; pageNumber += 1) {
      const page = await documentProxy.getPage(pageNumber);
      const [left = 0, bottom = 0, right = 0, top = 0] = page.view;
      const rotation = ((page.rotate % 360) + 360) % 360 as PageGeometry['rotation'];
      pages.push({
        pageIndex: pageNumber - 1,
        widthPt: right - left,
        heightPt: top - bottom,
        rotation,
        boxOffset: { x: left, y: bottom },
      });
    }

    const originalOperators = await firstPage.getOperatorList();
    const result = await exportPdf({
      originalBytes: resumeBytes,
      edits: [...built.covers, ...built.texts],
      pages,
    });
    const reopened = await getDocument({ data: result.bytes.slice(), verbosity: 0 }).promise;
    try {
      const reopenedPage = await reopened.getPage(1);
      const content = await reopenedPage.getTextContent();
      const strings = content.items
        .filter((item): item is Extract<typeof item, { str: string }> => 'str' in item)
        .map((item) => item.str);
      expect(strings.filter((text) => text === '•')).toHaveLength(firgun.items.length);
      expect(strings.join(' ')).toContain('Bold');
      expect(strings.join(' ')).toContain('word survives');
      const boldItem = content.items.find((item) => 'str' in item && item.str === 'Bold');
      const boldFontRef = boldItem && 'fontName' in boldItem ? boldItem.fontName : undefined;
      const reopenedOperators = await reopenedPage.getOperatorList();
      const boldFont = boldFontRef && reopenedPage.commonObjs.has(boldFontRef)
        ? reopenedPage.commonObjs.get(boldFontRef)
        : undefined;
      const originalFillAndStrokeCount = originalOperators.fnArray.filter(
        (operator) => operator === OPS.setTextRenderingMode,
      ).length;
      const reopenedFillAndStrokeCount = reopenedOperators.fnArray.filter(
        (operator) => operator === OPS.setTextRenderingMode,
      ).length;

      expect(boldFont?.name).toMatch(/Lucida Sans Unicode/i);
      expect(boldFont?.name).not.toMatch(/Helvetica/i);
      expect(reopenedFillAndStrokeCount).toBeGreaterThan(originalFillAndStrokeCount);
    } finally {
      await reopened.destroy();
    }
  });
});

describe('Corporate Governance symbol-character bullet detection', () => {
  function governanceListFixture(): TextBlock {
    const block = governancePageSevenBlocks.find((candidate) => (
      detectTextBulletMarkers(candidate).length === 18
    ));
    if (!block) throw new Error('Corporate Governance page-7 bullet block not found');
    return block;
  }

  it('detects all eighteen normalized Word-symbol markers in one page-7 list block', () => {
    const matches = governancePageSevenBlocks
      .map((block) => ({ block, markers: detectTextBulletMarkers(block) }))
      .filter(({ markers }) => markers.length > 0);

    const target = matches.find(({ markers }) => markers.length === 18);
    expect(target?.block.text).toContain('Introduction of CG & an overview');
    expect(target?.block.text).toContain('Significance of good governance');
    expect(target?.markers).toHaveLength(18);
    expect(target?.markers.every((marker) => (
      marker.line.runs[0]?.text.trim() === '•' &&
      marker.line.runs[0]?.style.fontRef === undefined
    ))).toBe(true);
  });

  it('routes the symbols through marker-free list editing and standard bullet redraws', () => {
    const list = detectBulletListFromRegions(governanceListFixture(), []);
    expect(list).not.toBeNull();
    if (!list) return;

    expect(list.items).toHaveLength(18);
    expect(list.items.every((item) => item.markerRun?.text.trim() === '•')).toBe(true);
    expect(list.items.every((item) => !/[\uF0B7☐]/u.test(item.text))).toBe(true);
    expect(list.block.text).not.toContain('\uF0B7');
    expect(list.textX).toBeCloseTo(89.76, 1);
    expect(list.coverRect.x).toBeLessThan(list.textX);
    expect(list.coverRect.x).toBeCloseTo(80.76, 1);

    const layouts = list.items.map((item) => ({
      text: item.text,
      lines: item.lines.map((line) => line.text),
    }));
    const built = buildBulletListEdits(
      list,
      {
        text: formatBulletEditorText(layouts.map((item) => item.text)),
        style: list.block.style,
        width: list.coverRect.w,
        height: list.coverRect.h,
        dx: 0,
        dy: 0,
      },
      layouts,
      1,
      500,
    );
    const bullets = built.texts.filter((edit) => edit.text === '•');
    expect(bullets).toHaveLength(18);
    expect(bullets.every((edit) => edit.style.fontRef === undefined)).toBe(true);
    expect(built.texts.every((edit) => !edit.text.includes('\uF0B7'))).toBe(true);
  });

  it('commits a lone normalized bullet through plain-text editing without a box glyph', async () => {
    const source = governanceListFixture();
    const line = source.lines.find((candidate) => candidate.text === '• Need for CG');
    if (!line) throw new Error('Need for CG bullet line not found');
    const block: TextBlock = {
      ...source,
      text: line.text,
      rect: line.rect,
      topBaselineY: line.baselineY,
      style: line.style,
      lines: [line],
    };

    expect(detectTextBulletMarkers(block)).toHaveLength(1);
    expect(detectBulletListFromRegions(block, [])).toBeNull();
    expect(block.text).not.toMatch(/[\uF0B7☐]/u);

    const replacement = '• Need for CG — checked';
    const built = buildTextBlockEdits(
      block,
      {
        text: replacement,
        style: block.style,
        width: block.rect.w,
        height: block.rect.h,
        dx: 0,
        dy: 0,
      },
      [replacement],
      1,
    );
    const pages: PageGeometry[] = [];
    for (let pageNumber = 1; pageNumber <= 7; pageNumber += 1) {
      const page = await governanceDocumentProxy.getPage(pageNumber);
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
      originalBytes: governanceBytes,
      edits: [...built.covers, ...built.texts],
      pages,
    });
    const reopened = await getDocument({ data: exported.bytes.slice(), verbosity: 0 }).promise;
    try {
      const page = await reopened.getPage(7);
      const runs = await extractTextRuns(page, 6);
      const committed = runs.find((run) => run.text === replacement);
      const fontRef = committed?.style.fontRef;
      const font = fontRef && page.commonObjs.has(fontRef)
        ? page.commonObjs.get(fontRef)
        : undefined;

      expect(committed?.text).toBe(replacement);
      expect(committed?.text).not.toMatch(/[\uF0B7☐]/u);
      expect(font?.name).toMatch(/Times|Helvetica|Courier/i);
      expect(font?.name).not.toMatch(/Symbol/i);
    } finally {
      await reopened.destroy();
    }
  });
});

it('formats editor bullets and drops an emptied item on parse', () => {
  const formatted = formatBulletEditorText(['First', 'Second']);
  expect(formatted).toBe('• First\n• Second');
  expect(parseBulletEditorItems('• First\n•   \nSecond')).toEqual(['First', 'Second']);
  expect(parseBulletEditorItems('\uF0B7 Legacy symbol\n▪ Unicode square')).toEqual([
    'Legacy symbol',
    'Unicode square',
  ]);
});

describe('parseBulletEditorItemSpans', () => {
  it('strips the marker while preserving a partially bold item', () => {
    expect(parseBulletEditorItemSpans(
      '• Led and coordinated',
      [
        { text: '• ', bold: false, italic: false },
        { text: 'Led', bold: true, italic: false },
        { text: ' and coordinated', bold: false, italic: false },
      ],
    )).toEqual([{
      text: 'Led and coordinated',
      spans: [
        { text: 'Led', bold: true, italic: false },
        { text: ' and coordinated', bold: false, italic: false },
      ],
    }]);
  });

  it('splits multiple items and drops an empty marker line', () => {
    expect(parseBulletEditorItemSpans(
      '• First\n•   \n• Second',
      [
        { text: '• First\n', bold: false, italic: false },
        { text: '•   \n• Second', bold: true, italic: false },
      ],
    )).toEqual([
      {
        text: 'First',
        spans: [{ text: 'First', bold: false, italic: false }],
      },
      {
        text: 'Second',
        spans: [{ text: 'Second', bold: true, italic: false }],
      },
    ]);
  });

  it('keeps a uniform item as one normalized span', () => {
    expect(parseBulletEditorItemSpans(
      '• Uniform item',
      [{ text: '• Uniform item', bold: false, italic: true }],
    )).toEqual([{
      text: 'Uniform item',
      spans: [{ text: 'Uniform item', bold: false, italic: true }],
    }]);
  });
});

function line(index: number, text: string): TextLine {
  const baselineY = 100 - index * 12;
  return {
    pageIndex: 0,
    text,
    baselineY,
    rect: { x: 30, y: baselineY, w: 100, h: 9 },
    style: {
      fontName: 'Helvetica',
      fontSizePt: 9,
      bold: false,
      italic: false,
      color: { r: 0, g: 0, b: 0 },
    },
    runs: [],
  };
}

function syntheticListBlock(): TextBlock {
  const lines = [line(0, 'First item'), line(1, 'Second item'), line(2, 'Third item')];
  return {
    pageIndex: 0,
    text: lines.map((entry) => entry.text).join('\n'),
    rect: { x: 30, y: 76, w: 100, h: 33 },
    topBaselineY: 100,
    lineHeightPt: 12,
    style: lines[0]?.style ?? {
      fontName: 'Helvetica',
      fontSizePt: 9,
      bold: false,
      italic: false,
      color: { r: 0, g: 0, b: 0 },
    },
    lines,
  };
}

it('builds a list from drawn-shape regions and preserves their measured dot size', () => {
  const block = syntheticListBlock();
  const shapes = [100, 88, 76].map((baselineY) => ({
    pageIndex: 0,
    rect: { x: 20, y: baselineY + 1, w: 4, h: 4 },
  }));
  const list = detectBulletListFromRegions(block, [], shapes);

  expect(list?.items).toHaveLength(3);
  expect(list?.bulletX).toBe(20);
  expect(list?.bulletSizePt).toBe(4);
  expect(list?.coverRect.x).toBe(20);
});

it('keeps image-marker precedence when image and shape lists both match', () => {
  const block = syntheticListBlock();
  const images = [100, 88, 76].map((baselineY) => ({
    pageIndex: 0,
    rect: { x: 21, y: baselineY + 1.5, w: 3, h: 3 },
  }));
  const shapes = [100, 88, 76].map((baselineY) => ({
    pageIndex: 0,
    rect: { x: 18, y: baselineY + 1, w: 4, h: 4 },
  }));
  const list = detectBulletListFromRegions(block, images, shapes);

  expect(list?.bulletX).toBe(21);
  expect(list?.bulletSizePt).toBe(3);
});

it('moves a shape-marker list by stamping bullets at the new x and covering the original dots', () => {
  const block = syntheticListBlock();
  const shapes = [100, 88, 76].map((baselineY) => ({
    pageIndex: 0,
    rect: { x: 20, y: baselineY + 1, w: 4, h: 4 },
  }));
  const list = detectBulletListFromRegions(block, [], shapes);
  if (!list) throw new Error('Shape-marker list was not detected');
  const layouts = list.items.map((item) => ({ text: item.text, lines: [item.text] }));
  const built = buildBulletListEdits(
    list,
    {
      text: formatBulletEditorText(layouts.map((item) => item.text)),
      style: block.style,
      width: list.coverRect.w,
      height: list.coverRect.h,
      dx: 7,
      dy: 3,
    },
    layouts,
    1,
    200,
  );

  expect(built.overflow).toBe(false);
  expect(built.texts.filter((edit) => edit.text === '•')).toHaveLength(3);
  expect(built.texts.filter((edit) => edit.text === '•').every((edit) => edit.rect.x === 27)).toBe(true);
  expect(built.covers).toHaveLength(1);
  const cover = built.covers[0]?.rect;
  expect(cover?.x).toBeLessThan(20);
  expect((cover?.x ?? 0) + (cover?.w ?? 0)).toBeGreaterThan(24);
});

it('models each marker-start through the line before the next marker as one item', () => {
  const lines = [line(0, 'First item'), line(1, 'continues'), line(2, 'Second item')];
  const block: TextBlock = {
    pageIndex: 0,
    text: lines.map((entry) => entry.text).join('\n'),
    rect: { x: 30, y: 76, w: 100, h: 33 },
    topBaselineY: 100,
    lineHeightPt: 12,
    style: lines[0]?.style ?? {
      fontName: 'Helvetica',
      fontSizePt: 9,
      bold: false,
      italic: false,
      color: { r: 0, g: 0, b: 0 },
    },
    lines,
  };
  const list = detectBulletListFromRegions(block, [
    { pageIndex: 0, rect: { x: 19, y: 101.5, w: 3, h: 3 } },
    { pageIndex: 0, rect: { x: 19, y: 77.5, w: 3, h: 3 } },
  ]);

  expect(list?.items.map((item) => item.text)).toEqual([
    'First item continues',
    'Second item',
  ]);
  expect(list?.items.map((item) => item.lines.length)).toEqual([2, 1]);
});
