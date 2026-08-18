import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
import { buildBulletListEdits } from '@/lib/edit/buildTextEdits';
import { exportPdf } from '@/lib/export/exportPdf';
import type { PageGeometry } from './types';
import { detectImages } from './images';
import {
  availableBulletListHeight,
  bulletListHeadingBlock,
  detectBulletListFromRegions,
  detectBulletMarkers,
  formatBulletEditorText,
  isBulletListBlock,
  nextBlockBelowBulletList,
  parseBulletEditorItems,
} from './bulletList';
import { extractTextRuns, groupRunsIntoBlocks } from './textContent';
import type { TextBlock, TextLine } from './textContent';

let documentProxy: PDFDocumentProxy;
let firstPage: PDFPageProxy;
let blocks: TextBlock[];
let imageRegions: Awaited<ReturnType<typeof detectImages>>;
let resumeBytes: Uint8Array;

beforeAll(async () => {
  const bytes = await readFile('public/samples/RAHUL RAJPUT RESUME.pdf');
  resumeBytes = new Uint8Array(bytes);
  documentProxy = await getDocument({ data: resumeBytes.slice(), verbosity: 0 }).promise;
  firstPage = await documentProxy.getPage(1);
  blocks = groupRunsIntoBlocks(await extractTextRuns(firstPage, 0));
  imageRegions = await detectImages(firstPage, 0);
});

afterAll(async () => {
  await documentProxy?.destroy();
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

  it('splits a job-title heading above a bullet list into its own editable block', () => {
    const headings = blocks.flatMap((block) => {
      const list = detectBulletListFromRegions(block, imageRegions);
      if (!list) return [];
      const heading = bulletListHeadingBlock(list);
      return heading ? [{ list, heading }] : [];
    });

    // At least one résumé list (e.g. Firgun) has its job title grouped above the bullets.
    expect(headings.length).toBeGreaterThan(0);
    for (const { list, heading } of headings) {
      expect(heading.lines).toEqual(list.sourceBlock.lines.slice(0, heading.lines.length));
      expect(list.block.lines).toEqual(list.sourceBlock.lines.slice(heading.lines.length));
      expect(heading.text).not.toContain('•');
    }
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
});

it('formats editor bullets and drops an emptied item on parse', () => {
  const formatted = formatBulletEditorText(['First', 'Second']);
  expect(formatted).toBe('• First\n• Second');
  expect(parseBulletEditorItems('• First\n•   \nSecond')).toEqual(['First', 'Second']);
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
