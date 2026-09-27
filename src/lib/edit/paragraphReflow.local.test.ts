import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { exportPdf } from '@/lib/export/exportPdf';
import type { Edit } from '@/lib/export/types';
import type { PageGeometry } from '@/lib/pdf/types';
import { detectRuleLines } from '@/lib/pdf/ruleLines';
import { detectPageGraphicRegions } from '@/lib/pdf/shapeMarkers';
import { detectBulletListFromRegions } from '@/lib/pdf/bulletList';
import { extractTextRuns, groupRunsIntoBlocks } from '@/lib/pdf/textContent';
import {
  editorWidthMeasurementText,
  listSeedText,
  paragraphSeedText,
  widestLineWidth,
} from './paragraphSeed';
import { startsWithBulletMarker } from '@/lib/pdf/textUnits';
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

const task74Fixtures = {
  firgun: 'tmp/tables/Firgun_QT-H4SNASRX_SriLanka.pdf',
  rishi: 'tmp/compress-tests/rishi-ilovepdf.pdf',
  rahul: 'tmp/bullets/RAHUL_RAJPUT_RESUME.pdf',
  sriLanka: 'tmp/tables/Firgun_QT-H4SNASRX_SriLanka.pdf',
  fractions: 'tmp/tables/Fraction Chart.pdf',
  bhutan: "tmp/paragraphs/Bhutan December'26.pdf",
  corporate: 'tmp/paragraphs/Corporate-Governance-edited (25).pdf',
} as const;
const task74Enabled = process.env.TASK74_REAL === '1'
  && Object.values(task74Fixtures).every((path) => existsSync(path));
if (!task74Enabled) {
  process.stdout.write(
    'Task 74 real border check skipped: set TASK74_REAL=1 with the four named fixtures present.\n',
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

async function editorPage(file: string, pageNumber: number) {
  const document = await open(new Uint8Array(await readFile(file)));
  const page = await document.getPage(pageNumber);
  const pageIndex = pageNumber - 1;
  // Group exactly as OverlayLayer does, drawn bullet markers included; without them a
  // drawn-marker list does not group and bulletList.ts cannot see it.
  const [runs, ruleLines, regions] = await Promise.all([
    extractTextRuns(page, pageIndex),
    detectRuleLines(page, pageIndex),
    detectPageGraphicRegions(page, pageIndex),
  ]);
  const markers = [...regions.imageRegions, ...regions.shapeMarkerRegions];
  const blocks = groupRunsIntoBlocks(runs, { ruleLines, markers });
  return {
    runs,
    ruleLines,
    regions,
    blocks,
    bulletLists: blocks
      .map((block) => detectBulletListFromRegions(
        block,
        [...regions.imageRegions],
        [...regions.shapeMarkerRegions],
      ))
      .filter((list): list is NonNullable<typeof list> => list !== null),
  };
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

describe.skipIf(!task74Enabled)('Task 74 Step 1 Revision 1 real borders', () => {
  it('opens the Rishi education and certificate tables one row at a time', async () => {
    const [page1, page2] = await Promise.all([
      editorPage(task74Fixtures.rishi, 1),
      editorPage(task74Fixtures.rishi, 2),
    ]);
    const educationRows = page1.blocks.map((block) => block.text).filter((text) => (
      text === 'JECRC University, Jaipur. Rajasthan'
      || text === 'Chinar Public School, Alwar, Rajasthan'
    ));
    expect(educationRows).toEqual([
      'JECRC University, Jaipur. Rajasthan',
      'Chinar Public School, Alwar, Rajasthan',
      'Chinar Public School, Alwar, Rajasthan',
    ]);
    expect(page2.blocks.map((block) => block.text)).toEqual(expect.arrayContaining([
      'Strategy Consulting Job Simulation by ACCENTURE',
      'Strategy Consulting Job Simulation by BCG',
      'Human Resource foundation course',
      'IAYP(International Award for Young People) at Bronze Level',
    ]));
  }, 60_000);

  it('keeps the Sri Lanka and Fraction Chart cell boundaries unchanged', async () => {
    const [sriLankaPage1, sriLankaPage2, fractions] = await Promise.all([
      editorPage(task74Fixtures.sriLanka, 1),
      editorPage(task74Fixtures.sriLanka, 2),
      editorPage(task74Fixtures.fractions, 1),
    ]);
    expect(sriLankaPage1.blocks).toHaveLength(31);
    expect(sriLankaPage2.blocks.map((block) => block.text)).toEqual(expect.arrayContaining([
      'Nuwara Eliya – Ella\n– Yala',
      expect.stringMatching(/^After breakfast, proceed to Ambewela Railway Station/),
    ]));
    expect(fractions.blocks).toHaveLength(218);
    expect(fractions.blocks.every((block) => (block.text.match(/%/g)?.length ?? 0) <= 1)).toBe(true);
  }, 60_000);

  it('does not introduce a border-driven Bhutan regression', async () => {
    const [page6, page8] = await Promise.all([
      editorPage(task74Fixtures.bhutan, 6),
      editorPage(task74Fixtures.bhutan, 8),
    ]);
    expect(page6.ruleLines).toEqual([]);
    expect(page6.blocks).toEqual(groupRunsIntoBlocks(page6.runs, { ruleLines: [] }));
    const craneBlocks = page8.blocks.filter((block) => /Black-Necked\s*\n?Crane Centre/.test(block.text));
    expect(craneBlocks).toHaveLength(1);
    expect(craneBlocks[0]?.lines).toHaveLength(4);
  }, 60_000);
});

describe.skipIf(!task74Enabled)('Task 74 Step 2 real text units', () => {
  it('opens the Firgun vehicle allocation list as nine items and unchanged Done writes nothing', async () => {
    const page = await editorPage(task74Fixtures.firgun, 5);
    const block = page.blocks.find((candidate) => (
      candidate.text.includes('A/C vehicle during the tours and transfers')
      && candidate.text.includes('1-4 pax')
    ));
    expect(block, 'Firgun page 5 Vehicle Allocation list').toBeDefined();
    expect(block?.lines).toHaveLength(9);
    const seed = listSeedText(block!);
    expect(seed.split('\n')).toHaveLength(9);
    expect(seed.match(/\n/g)).toHaveLength(8);

    const opened: TextEditSessionValue = {
      text: seed,
      style: block!.style,
      width: block!.rect.w,
      height: block!.rect.h,
      dx: 0,
      dy: 0,
      align: block!.align ?? 'left',
      alignLeftPt: block!.alignLeftPt ?? block!.rect.x,
      alignWidthPt: block!.alignWidthPt ?? block!.rect.w,
    };
    const onDone = () => {
      throw new Error('unchanged list Done must not build or add edits');
    };
    expect(finishTextEdit(opened, { ...opened }, onDone, () => undefined)).toBe('cancelled');
  }, 60_000);

  it('seeds the wrapped Rishi experience list as five items', async () => {
    const page = await editorPage(task74Fixtures.rishi, 1);
    const block = page.blocks.find((candidate) => (
      candidate.lines.length === 8
      && candidate.lines.filter((line) => startsWithBulletMarker(line.text)).length === 5
    ));
    expect(block, 'Rishi page 1 five-item experience list').toBeDefined();
    expect(listSeedText(block!).split('\n')).toHaveLength(5);
  }, 60_000);

  it('keeps the Bhutan stretched line in its paragraph and gives the crane block local geometry', async () => {
    const [page6, page8] = await Promise.all([
      editorPage(task74Fixtures.bhutan, 6),
      editorPage(task74Fixtures.bhutan, 8),
    ]);
    const stretched = page6.blocks.find((block) => block.text.includes('After breakfast'));
    expect(stretched, 'Bhutan page 6 stretched paragraph').toBeDefined();
    expect(stretched?.lines).toHaveLength(4);
    expect(stretched?.lines[0]?.text).toMatch(/^After breakfast, we leave/);

    const dochula = page8.blocks.find((block) => block.text.startsWith('Our first major stop'));
    expect(dochula, 'Bhutan page 8 Dochula paragraph').toBeDefined();
    expect(dochula?.lines).toHaveLength(4);
    expect(dochula?.text).toContain('chortens surrounded by');

    const crane = page8.blocks.find((block) => /Black-Necked\s*\n?Crane Centre/.test(block.text));
    expect(crane, 'Bhutan page 8 crane paragraph').toBeDefined();
    expect(crane).toMatchObject({ align: 'left' });
    expect(crane?.lines).toHaveLength(4);
    expect(crane?.rect.w).toBeCloseTo(340.1, 0);
    expect(crane?.alignLeftPt).toBeUndefined();
    expect(crane?.alignWidthPt).toBeUndefined();
  }, 60_000);

  it('keeps the Rahul contact row as phone, email, and city click units', async () => {
    const page = await editorPage(task74Fixtures.rahul, 1);
    const texts = page.blocks.map((block) => block.text);
    expect(texts).toEqual(expect.arrayContaining([
      '9555737955',
      'rahulrajput82143@gmail.com',
      'Gurgaon',
    ]));
  }, 60_000);

  it('keeps the Task 72 Corporate Governance paragraph unchanged in the editor path', async () => {
    const page = await editorPage(task74Fixtures.corporate, 3);
    const block = page.blocks.find((candidate) => (
      candidate.text.startsWith('A number of Postgraduate Departments')
    ));
    expect(block, 'Corporate Governance page 3 paragraph').toBeDefined();
    expect(block?.lines).toHaveLength(6);
    expect(paragraphSeedText(block!)).toHaveLength(576);
  }, 60_000);
});

describe.skipIf(!task74Enabled)('Task 74 drawn bullet markers', () => {
  it('still finds the resume bullet lists that grouping must hold together', async () => {
    // Step 2's sentence-end and right-edge guards broke these: every item ends with a
    // full stop and an item's last line is short, so each item became its own block and
    // bulletList.ts saw no list at all. main detects four; so must we.
    const [page1, page2] = await Promise.all([
      editorPage(task74Fixtures.rahul, 1),
      editorPage(task74Fixtures.rahul, 2),
    ]);
    expect(page1.bulletLists.length + page2.bulletLists.length).toBe(4);
    expect(page1.bulletLists.map((list) => list.items.length)).toEqual([6, 5]);
    expect(page2.bulletLists.map((list) => list.items.length)).toEqual([4, 3]);

    // A typed-marker list is unaffected either way.
    const rishi = await editorPage(task74Fixtures.rishi, 1);
    expect(rishi.bulletLists).toHaveLength(2);
    process.stdout.write(
      `TASK74 BULLETS rahul ${page1.bulletLists.length + page2.bulletLists.length} lists`
      + ` | rishi ${rishi.bulletLists.length} lists
`,
    );
  }, 120_000);
});
