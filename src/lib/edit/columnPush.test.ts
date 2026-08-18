import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { CoverEdit, TextEdit } from '@/lib/export/types';
import { exportPdf } from '@/lib/export/exportPdf';
import type { BulletList } from '@/lib/pdf/bulletList';
import { detectBulletListFromRegions, formatBulletEditorText } from '@/lib/pdf/bulletList';
import type { ImageRegion } from '@/lib/pdf/images';
import { detectImages } from '@/lib/pdf/images';
import type { PageGeometry } from '@/lib/pdf/types';
import type { TextBlock, TextLine, TextRun } from '@/lib/pdf/textContent';
import { extractTextRuns, groupRunsIntoBlocks } from '@/lib/pdf/textContent';
import { EMPTY_HISTORY, historyReducer } from '@/state/editsStore';
import {
  buildBulletListEdits,
} from './buildTextEdits';
import {
  columnPushRoom,
  contentBelowInColumn,
  initialListHeight,
  overflowPushDelta,
  planColumnPush,
  pushColumnEdits,
} from './columnPush';

const style = {
  fontName: 'Helvetica',
  fontSizePt: 10,
  bold: false,
  italic: false,
  color: { r: 0, g: 0, b: 0 },
} as const;

function line(text: string, x: number, baselineY: number, width = 120): TextLine {
  const run: TextRun = {
    pageIndex: 0,
    text,
    rect: { x, y: baselineY, w: width, h: 10 },
    style,
  };
  return {
    pageIndex: 0,
    text,
    baselineY,
    rect: run.rect,
    style,
    runs: [run],
  };
}

function block(
  text: string,
  x: number,
  baselines: readonly number[],
  width = 120,
): TextBlock {
  const lines = baselines.map((baseline) => line(text, x, baseline, width));
  const bottom = Math.min(...lines.map((entry) => entry.rect.y));
  const top = Math.max(...lines.map((entry) => entry.rect.y + entry.rect.h));
  return {
    pageIndex: 0,
    text: lines.map((entry) => entry.text).join('\n'),
    rect: { x, y: bottom, w: width, h: top - bottom },
    topBaselineY: Math.max(...baselines),
    lineHeightPt: baselines.length > 1 ? Math.abs((baselines[0] ?? 0) - (baselines[1] ?? 0)) : 12,
    style,
    lines,
  };
}

function listAt(sourceBlock: TextBlock, bulletX = sourceBlock.rect.x - 10): BulletList {
  const items = sourceBlock.lines.map((entry) => ({
    bulletX,
    baselineY: entry.baselineY,
    text: entry.text,
    lines: [entry],
    markerRect: { x: bulletX, y: entry.baselineY + 2, w: 3, h: 3 },
  }));
  const bottom = Math.min(...items.map((item) => item.markerRect.y), sourceBlock.rect.y);
  const right = sourceBlock.rect.x + sourceBlock.rect.w;
  const top = Math.max(
    sourceBlock.rect.y + sourceBlock.rect.h,
    ...items.map((item) => item.markerRect.y + item.markerRect.h),
  );
  return {
    sourceBlock,
    block: sourceBlock,
    items,
    bulletX,
    textX: sourceBlock.rect.x,
    bulletSizePt: 3,
    lineHeightPt: sourceBlock.lineHeightPt,
    itemSpacingPt: 0,
    coverRect: { x: bulletX, y: bottom, w: right - bulletX, h: top - bottom },
  };
}

describe('Task 10I column push planning', () => {
  it('converts only overflow into a downward push amount', () => {
    expect(overflowPushDelta(90, 70)).toBe(20);
    expect(overflowPushDelta(70, 70)).toBe(0);
    expect(overflowPushDelta(60, 70)).toBe(0);
  });

  it('collects same-column content top-down and stops at the first image', () => {
    const edited = listAt(block('Edited', 30, [430, 418]));
    const first = block('First below', 32, [390, 378]);
    const otherColumn = block('Other column', 300, [370]);
    const second = block('Second below', 28, [345]);
    const afterImage = block('Must not move', 30, [250]);
    const obstacle: ImageRegion = {
      pageIndex: 0,
      rect: { x: 45, y: 270, w: 80, h: 30 },
    };
    const run = contentBelowInColumn(
      [edited.sourceBlock, first, otherColumn, second, afterImage],
      [obstacle],
      edited,
      20,
    );

    expect(run.contents.map((entry) => entry.block)).toEqual([first, second]);
    expect(run.firstBoundaryY).toBe(first.rect.y + first.rect.h);
    expect(run.boundaryY).toBe(300);
    expect(run.obstacle).toBe(obstacle);
    expect(columnPushRoom(run)).toBeCloseTo(second.rect.y - 300, 5);
  });

  it('does not mistake the painted markers of a lower list for obstacles', () => {
    const edited = listAt(block('Edited', 30, [430, 418]));
    const lower = block('Lower list', 32, [380, 368]);
    const lowerList = listAt(lower, 22);
    const markerImages = lowerList.items.map<ImageRegion>((item) => ({
      pageIndex: 0,
      rect: item.markerRect,
    }));
    const run = contentBelowInColumn(
      [edited.sourceBlock, lower],
      markerImages,
      edited,
      20,
    );

    expect(run.contents).toHaveLength(1);
    expect(run.contents[0]?.bulletList?.items).toHaveLength(2);
    expect(run.obstacle).toBeUndefined();
    expect(run.boundaryY).toBe(20);
  });

  it('stops selection at the page bottom', () => {
    const edited = listAt(block('Edited', 30, [430, 418]));
    const onPage = block('On page', 30, [80]);
    const pastBottom = block('Past bottom', 30, [10]);
    const run = contentBelowInColumn(
      [edited.sourceBlock, onPage, pastBottom],
      [],
      edited,
      20,
    );

    expect(run.contents.map((entry) => entry.block)).toEqual([onPage]);
    expect(run.boundaryY).toBe(20);
  });

  it('faithfully shifts every original line without changing internal gaps', () => {
    const plain = block('Line', 40, [320, 297, 281]);
    const run = {
      contents: [{ block: plain }],
      firstBoundaryY: plain.rect.y + plain.rect.h,
      boundaryY: 20,
      pageBottomY: 20,
    };
    const result = pushColumnEdits(run, 14, 8);
    const texts = result.edits.filter((edit): edit is TextEdit => edit.kind === 'text');
    const covers = result.edits.filter((edit): edit is CoverEdit => edit.kind === 'cover');

    expect(result.stopped).toBe(false);
    expect(texts.map((edit) => edit.rect.y)).toEqual([306, 283, 267]);
    expect(texts[0]!.rect.y - texts[1]!.rect.y).toBe(23);
    expect(texts[1]!.rect.y - texts[2]!.rect.y).toBe(16);
    expect(covers.map((edit) => edit.rect.y)).not.toEqual(texts.map((edit) => edit.rect.y));
  });

  it('preserves each pushed bullet run style and redraws every marker', () => {
    const first = line('First item', 40, 320);
    const secondStyle = {
      ...style,
      fontName: 'Courier-Bold',
      fontSizePt: 8,
      bold: true,
    };
    const secondRun: TextRun = {
      pageIndex: 0,
      text: 'Second item',
      rect: { x: 40, y: 305, w: 120, h: 8 },
      style: secondStyle,
    };
    const second: TextLine = {
      pageIndex: 0,
      text: secondRun.text,
      baselineY: 305,
      rect: secondRun.rect,
      style: secondStyle,
      runs: [secondRun],
    };
    const lowerBlock: TextBlock = {
      pageIndex: 0,
      text: 'First item\nSecond item',
      rect: { x: 40, y: 305, w: 120, h: 25 },
      topBaselineY: 320,
      lineHeightPt: 15,
      style: first.style,
      lines: [first, second],
    };
    const lowerList = listAt(lowerBlock, 30);
    const run = {
      contents: [{ block: lowerList.sourceBlock, bulletList: lowerList }],
      firstBoundaryY: lowerList.sourceBlock.rect.y + lowerList.sourceBlock.rect.h,
      boundaryY: 20,
      pageBottomY: 20,
    };
    const result = pushColumnEdits(run, 12, 3);
    const bullets = result.edits.filter(
      (edit): edit is TextEdit => edit.kind === 'text' && edit.text === '•',
    );
    const bodies = result.edits.filter(
      (edit): edit is TextEdit => edit.kind === 'text' && edit.text !== '•',
    );
    const covers = result.edits.filter((edit): edit is CoverEdit => edit.kind === 'cover');
    const contains = (outer: CoverEdit, inner: { x: number; y: number; w: number; h: number }) => (
      outer.rect.x <= inner.x &&
      outer.rect.y <= inner.y &&
      outer.rect.x + outer.rect.w >= inner.x + inner.w &&
      outer.rect.y + outer.rect.h >= inner.y + inner.h
    );
    const stripCovers = covers.filter((cover) => (
      lowerList.items.every((item) => contains(cover, item.markerRect))
    ));

    expect(stripCovers).toHaveLength(1);
    expect(covers).toHaveLength(lowerList.block.lines.length + 1);
    expect(stripCovers[0]!.rect.x).toBeLessThan(lowerList.bulletX);
    expect(stripCovers[0]!.rect.x + stripCovers[0]!.rect.w).toBeLessThanOrEqual(
      lowerList.textX,
    );
    expect(bullets.map((edit) => edit.rect.y)).toEqual([308, 293]);
    expect(bullets.map((edit) => edit.rect.x)).toEqual([30, 30]);
    expect(bodies.map((edit) => ({
      fontName: edit.style.fontName,
      fontSizePt: edit.style.fontSizePt,
      bold: edit.style.bold,
    }))).toEqual([
      { fontName: 'Helvetica', fontSizePt: 10, bold: false },
      { fontName: 'Courier-Bold', fontSizePt: 8, bold: true },
    ]);
    expect(bullets.map((edit) => edit.style.fontSizePt)).toEqual([10, 8]);
  });

  it('rejects the whole cascade when the lowest block would cross the boundary', () => {
    const lowest = block('Bottom', 30, [35]);
    const run = {
      contents: [{ block: lowest }],
      firstBoundaryY: lowest.rect.y + lowest.rect.h,
      boundaryY: 20,
      pageBottomY: 20,
    };
    const plan = planColumnPush(42, 20, run);
    const result = pushColumnEdits(run, plan.pushDeltaY, 1);

    expect(plan).toMatchObject({ pushDeltaY: 22, roomPt: 15, stopped: true });
    expect(result.stopped).toBe(true);
    expect(result.edits).toEqual([]);
  });

  it('stores the edited list and its cascade as one undoable replacement', () => {
    const lower = block('Lower', 30, [200]);
    const run = {
      contents: [{ block: lower }],
      firstBoundaryY: lower.rect.y + lower.rect.h,
      boundaryY: 20,
      pageBottomY: 20,
    };
    const before = historyReducer(EMPTY_HISTORY, {
      type: 'add',
      edits: [{
        id: 'old-list',
        kind: 'cover',
        pageIndex: 0,
        rect: { x: 20, y: 220, w: 120, h: 40 },
        z: 1,
        sampleBackground: true,
      }],
    });
    const cascade = pushColumnEdits(run, 12, 2, 'test-cascade');
    const replacement: TextEdit = {
      id: 'new-list',
      kind: 'text',
      pageIndex: 0,
      rect: { x: 30, y: 220, w: 100, h: 10 },
      z: 2 + cascade.edits.length,
      text: '• New item',
      style,
      reflowKey: 'test-cascade',
    };
    const changed = historyReducer(before, {
      type: 'replace',
      removeIds: ['old-list'],
      edits: [...cascade.edits, replacement],
    });

    expect(changed.past).toHaveLength(before.past.length + 1);
    expect(historyReducer(changed, { type: 'undo' }).present).toEqual(before.present);
  });

  it('finds the real Travelmite cascade without treating its bullets as obstacles', async () => {
    const bytes = new Uint8Array(await readFile('public/samples/RAHUL RAJPUT RESUME.pdf'));
    const documentProxy = await getDocument({ data: bytes, verbosity: 0 }).promise;
    try {
      const page = await documentProxy.getPage(1);
      const fixtureBlocks = groupRunsIntoBlocks(await extractTextRuns(page, 0));
      const fixtureImages = await detectImages(page, 0);
      const firgunBlock = fixtureBlocks.find((candidate) => (
        candidate.text.includes('Joined Firgun Travels') &&
        candidate.text.includes('vendor communication, planning, and execution')
      ));
      if (!firgunBlock) throw new Error('Firgun fixture block was not found');
      const firgun = detectBulletListFromRegions(firgunBlock, fixtureImages);
      if (!firgun) throw new Error('Firgun fixture list was not detected');
      const run = contentBelowInColumn(
        fixtureBlocks,
        fixtureImages,
        firgun,
        page.view[1] ?? 0,
      );
      expect(initialListHeight(firgun, run)).toBeCloseTo(175.01, 1);
      expect(run.contents.map((content) => content.block.text.split('\n')[0])).toEqual([
        'Travelmite | Oct’25 - Jan’26',
        'WANDERON. PVT.LTD | Jun’22 – Oct’25',
      ]);
      expect(run.contents.find((content) => content.block.text.includes('Travelmite'))?.bulletList?.items)
        .toHaveLength(5);
      expect(run.obstacle).toBeUndefined();
      expect(columnPushRoom(run)).toBeCloseTo(32.16, 1);
    } finally {
      await documentProxy.destroy();
    }
  });

  it('exports the real cascade with selectable shifted bullets and no page-2 edits', async () => {
    const bytes = new Uint8Array(await readFile('public/samples/RAHUL RAJPUT RESUME.pdf'));
    const documentProxy = await getDocument({ data: bytes.slice(), verbosity: 0 }).promise;
    try {
      const page = await documentProxy.getPage(1);
      const fixtureBlocks = groupRunsIntoBlocks(await extractTextRuns(page, 0));
      const fixtureImages = await detectImages(page, 0);
      const firgunBlock = fixtureBlocks.find((candidate) => (
        candidate.text.includes('Joined Firgun Travels') &&
        candidate.text.includes('vendor communication, planning, and execution')
      ));
      if (!firgunBlock) throw new Error('Firgun fixture block was not found');
      const firgun = detectBulletListFromRegions(firgunBlock, fixtureImages);
      if (!firgun) throw new Error('Firgun fixture list was not detected');
      const run = contentBelowInColumn(
        fixtureBlocks,
        fixtureImages,
        firgun,
        page.view[1] ?? 0,
      );
      const added = Array.from({ length: 5 }, (_, index) => `Stage 2 fixture item ${index + 1}`);
      const itemLayouts = [
        ...firgun.items.map((item) => ({
          text: item.text,
          lines: item.lines.map((entry) => entry.text),
        })),
        ...added.map((text) => ({ text, lines: [text] })),
      ];
      const next = {
        text: formatBulletEditorText(itemLayouts.map((item) => item.text)),
        style: firgun.block.style,
        width: firgun.coverRect.w,
        height: firgun.coverRect.h,
        dx: 0,
        dy: 0,
      };
      const initialHeight = initialListHeight(firgun, run);
      const probe = buildBulletListEdits(firgun, next, itemLayouts, 1, initialHeight);
      const plan = planColumnPush(probe.usedHeightPt, initialHeight, run);
      expect(plan.stopped).toBe(false);
      expect(plan.pushDeltaY).toBeGreaterThan(0);
      const cascade = pushColumnEdits(run, plan.pushDeltaY, 1, 'fixture-cascade');
      const travelmite = run.contents.find(
        (content) => content.block.text.includes('Travelmite'),
      )?.bulletList;
      if (!travelmite) throw new Error('Travelmite fixture list was not detected');
      for (const sourceRun of travelmite.block.lines.flatMap((line) => line.runs)) {
        const shifted = cascade.edits.find((edit): edit is TextEdit => (
          edit.kind === 'text' &&
          edit.text === sourceRun.text &&
          Math.abs(edit.rect.x - sourceRun.rect.x) < 0.01 &&
          Math.abs(edit.rect.y - (sourceRun.rect.y - plan.pushDeltaY)) < 0.01
        ));
        expect(shifted?.style).toEqual(sourceRun.style);
      }
      const active = buildBulletListEdits(
        firgun,
        next,
        itemLayouts,
        1 + cascade.edits.length,
        initialHeight + columnPushRoom(run),
      );
      expect(active.overflow).toBe(false);

      const pages: PageGeometry[] = [];
      for (let pageNumber = 1; pageNumber <= documentProxy.numPages; pageNumber += 1) {
        const fixturePage = await documentProxy.getPage(pageNumber);
        const [left = 0, bottom = 0, right = 0, top = 0] = fixturePage.view;
        pages.push({
          pageIndex: pageNumber - 1,
          widthPt: right - left,
          heightPt: top - bottom,
          rotation: (((fixturePage.rotate % 360) + 360) % 360) as PageGeometry['rotation'],
          boxOffset: { x: left, y: bottom },
        });
      }
      const exported = await exportPdf({
        originalBytes: bytes,
        edits: [...cascade.edits, ...active.covers, ...active.texts],
        pages,
      });
      const reopened = await getDocument({ data: exported.bytes.slice(), verbosity: 0 }).promise;
      try {
        const firstPageContent = await (await reopened.getPage(1)).getTextContent();
        const firstPageItems = firstPageContent.items.filter(
          (item): item is Extract<typeof item, { str: string }> => 'str' in item,
        );
        const secondPageContent = await (await reopened.getPage(2)).getTextContent();
        const secondPageStrings = secondPageContent.items
          .filter((item): item is Extract<typeof item, { str: string }> => 'str' in item)
          .map((item) => item.str);
        expect(firstPageItems.filter((item) => item.str === '•')).toHaveLength(16);
        expect(firstPageItems.map((item) => item.str).join(' ')).toContain('Stage 2 fixture item 5');
        expect(firstPageItems.filter((item) => item.str === 'Travelmite')).toHaveLength(2);
        expect(secondPageStrings).not.toContain('•');
        expect(secondPageStrings.join(' ')).not.toContain('Stage 2 fixture item');
      } finally {
        await reopened.destroy();
      }
    } finally {
      await documentProxy.destroy();
    }
  });
});
