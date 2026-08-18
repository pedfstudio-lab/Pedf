import type { CoverEdit, Edit, PdfRect, TextEdit } from '@/lib/export/types';
import { detectBulletListFromRegions } from '@/lib/pdf/bulletList';
import type { BulletList } from '@/lib/pdf/bulletList';
import type { ImageRegion } from '@/lib/pdf/images';
import type { TextBlock, TextLine } from '@/lib/pdf/textContent';
import { coverRectsForTextBlock } from './buildTextEdits';

const EPSILON = 0.5;
let fallbackId = 0;

function id(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  fallbackId += 1;
  return `column-push-${fallbackId}`;
}

function horizontalOverlap(left: PdfRect, right: PdfRect): number {
  return Math.max(
    0,
    Math.min(left.x + left.w, right.x + right.w) - Math.max(left.x, right.x),
  );
}

function sameColumn(column: PdfRect, rect: PdfRect): boolean {
  const overlap = horizontalOverlap(column, rect);
  return overlap >= Math.max(2, Math.min(column.w, rect.w) * 0.2);
}

function sameRect(left: PdfRect, right: PdfRect): boolean {
  return (
    Math.abs(left.x - right.x) <= EPSILON &&
    Math.abs(left.y - right.y) <= EPSILON &&
    Math.abs(left.w - right.w) <= EPSILON &&
    Math.abs(left.h - right.h) <= EPSILON
  );
}

function unionRects(rects: readonly PdfRect[]): PdfRect {
  const first = rects[0];
  if (!first) return { x: 0, y: 0, w: 0, h: 0 };
  const left = Math.min(...rects.map((rect) => rect.x));
  const bottom = Math.min(...rects.map((rect) => rect.y));
  const right = Math.max(...rects.map((rect) => rect.x + rect.w));
  const top = Math.max(...rects.map((rect) => rect.y + rect.h));
  return { x: left, y: bottom, w: right - left, h: top - bottom };
}

function blockFromLines(source: TextBlock, lines: readonly TextLine[]): TextBlock | undefined {
  const first = lines[0];
  if (!first) return undefined;
  const rect = unionRects(lines.map((line) => line.rect));
  return {
    ...source,
    text: lines.map((line) => line.text).join('\n'),
    rect,
    topBaselineY: Math.max(...lines.map((line) => line.baselineY)),
    style: first.style,
    lines,
  };
}

export interface ColumnContent {
  readonly block: TextBlock;
  readonly bulletList?: BulletList;
}

export interface ColumnContentRun {
  /** Same-column source blocks, ordered from the edited list toward the page bottom. */
  readonly contents: readonly ColumnContent[];
  /** Top edge of the first lower block/obstacle, or the page bottom when neither exists. */
  readonly firstBoundaryY: number;
  /** Top edge of the stopping obstacle, or the page bottom. */
  readonly boundaryY: number;
  readonly pageBottomY: number;
  readonly obstacle?: ImageRegion;
}

/** Extra height that must be made available below the edited list. */
export function overflowPushDelta(usedHeightPt: number, availableHeightPt: number): number {
  return Math.max(0, usedHeightPt - availableHeightPt);
}

/**
 * Collect the movable same-column run below a bullet list. Painted bullet image
 * markers are owned by their detected lists and therefore are not obstacles.
 */
export function contentBelowInColumn(
  blocks: readonly TextBlock[],
  images: readonly ImageRegion[],
  editedList: BulletList,
  pageBottomY: number,
): ColumnContentRun {
  const pageIndex = editedList.block.pageIndex;
  const column = editedList.sourceBlock.rect;
  const listBottom = editedList.coverRect.y;
  const bulletLists = blocks
    .filter((block) => block.pageIndex === pageIndex)
    .map((block) => detectBulletListFromRegions(block, images))
    .filter((list): list is BulletList => list !== null);
  const markerRects = bulletLists.flatMap((list) => list.items.map((item) => item.markerRect));

  const lowerBlocks = blocks
    .filter((block) => (
      block !== editedList.sourceBlock &&
      block.pageIndex === pageIndex &&
      block.rect.y + block.rect.h <= listBottom + EPSILON &&
      block.rect.y + block.rect.h > pageBottomY + EPSILON &&
      sameColumn(column, block.rect)
    ))
    .map<ColumnContent>((block) => {
      const bulletList = bulletLists.find((list) => list.sourceBlock === block);
      return { block, ...(bulletList ? { bulletList } : {}) };
    });

  const obstacles = images.filter((image) => (
    image.pageIndex === pageIndex &&
    image.rect.y + image.rect.h <= listBottom + EPSILON &&
    image.rect.y + image.rect.h > pageBottomY + EPSILON &&
    sameColumn(column, image.rect) &&
    !markerRects.some((marker) => sameRect(marker, image.rect))
  ));

  const events = [
    ...lowerBlocks.map((content) => ({
      kind: 'block' as const,
      top: content.block.rect.y + content.block.rect.h,
      content,
    })),
    ...obstacles.map((obstacle) => ({
      kind: 'obstacle' as const,
      top: obstacle.rect.y + obstacle.rect.h,
      obstacle,
    })),
  ].sort((left, right) => right.top - left.top || (
    left.kind === 'obstacle' ? -1 : 1
  ));

  const firstBoundaryY = events[0]?.top ?? pageBottomY;
  const contents: ColumnContent[] = [];
  for (const event of events) {
    if (event.kind === 'obstacle') {
      return {
        contents,
        firstBoundaryY,
        boundaryY: event.top,
        pageBottomY,
        obstacle: event.obstacle,
      };
    }
    contents.push(event.content);
  }
  return { contents, firstBoundaryY, boundaryY: pageBottomY, pageBottomY };
}

/** Current list room before it touches the first lower block or obstacle. */
export function initialListHeight(list: BulletList, run: ColumnContentRun): number {
  const listTop = list.coverRect.y + list.coverRect.h;
  return Math.max(0, listTop - run.firstBoundaryY);
}

/** Space through which the complete movable run can be translated. */
export function columnPushRoom(run: ColumnContentRun): number {
  if (run.contents.length === 0) return 0;
  const lowestY = Math.min(...run.contents.map((content) => Math.min(
    content.block.rect.y,
    content.bulletList?.coverRect.y ?? Number.POSITIVE_INFINITY,
  )));
  return Math.max(0, lowestY - run.boundaryY);
}

export interface ColumnPushPlan {
  readonly pushDeltaY: number;
  readonly roomPt: number;
  readonly stopped: boolean;
}

/** All-or-nothing page/obstacle capacity check. */
export function planColumnPush(
  usedHeightPt: number,
  availableHeightPt: number,
  run: ColumnContentRun,
): ColumnPushPlan {
  const pushDeltaY = overflowPushDelta(usedHeightPt, availableHeightPt);
  const roomPt = columnPushRoom(run);
  return {
    pushDeltaY,
    roomPt,
    stopped: pushDeltaY > EPSILON && (
      run.contents.length === 0 || pushDeltaY > roomPt + EPSILON
    ),
  };
}

export function bulletReflowKey(list: BulletList): string {
  const rect = list.coverRect;
  return [
    'bullet-reflow',
    list.block.pageIndex,
    rect.x.toFixed(2),
    rect.y.toFixed(2),
    rect.w.toFixed(2),
    rect.h.toFixed(2),
  ].join(':');
}

interface EditGroup {
  readonly covers: readonly CoverEdit[];
  readonly texts: readonly TextEdit[];
}

function exactShiftGroup(block: TextBlock, pushDeltaY: number): EditGroup {
  const covers = coverRectsForTextBlock(block).map<CoverEdit>((rect) => ({
    id: id(),
    kind: 'cover',
    pageIndex: block.pageIndex,
    rect,
    z: 0,
    sampleBackground: true,
  }));
  const texts = block.lines.flatMap<TextEdit>((line) => {
    if (line.runs.length > 0) {
      return line.runs.map<TextEdit>((run) => ({
        id: id(),
        kind: 'text',
        pageIndex: run.pageIndex,
        rect: { ...run.rect, y: run.rect.y - pushDeltaY },
        z: 0,
        text: run.text,
        style: run.style,
      }));
    }
    return [{
      id: id(),
      kind: 'text',
      pageIndex: line.pageIndex,
      rect: { ...line.rect, y: line.baselineY - pushDeltaY },
      z: 0,
      text: line.text,
      style: line.style,
    }];
  });
  return { covers, texts };
}

function bulletShiftGroup(list: BulletList, pushDeltaY: number): EditGroup {
  const textGroup = exactShiftGroup(list.block, pushDeltaY);
  const markerRects = list.items.map((item) => item.markerRect);
  const left = Math.min(...markerRects.map((rect) => rect.x));
  const right = Math.max(...markerRects.map((rect) => rect.x + rect.w));
  const bottom = Math.min(...markerRects.map((rect) => rect.y));
  const top = Math.max(...markerRects.map((rect) => rect.y + rect.h));
  const pad = Math.max(1, list.block.style.fontSizePt * 0.15);
  const stripCover: CoverEdit = {
    id: id(),
    kind: 'cover',
    pageIndex: list.block.pageIndex,
    rect: {
      x: left - pad,
      y: bottom - pad,
      w: Math.max(1, Math.min(right + pad, list.textX - 0.5) - (left - pad)),
      h: top - bottom + pad * 2,
    },
    z: 0,
    sampleBackground: true,
  };
  const markerTexts = list.items.map<TextEdit>((item) => {
    const style = item.lines[0]?.style ?? list.block.style;
    return {
      id: id(),
      kind: 'text',
      pageIndex: list.block.pageIndex,
      rect: {
        x: list.bulletX,
        y: item.baselineY - pushDeltaY,
        w: Math.max(1, list.textX - list.bulletX),
        h: style.fontSizePt,
      },
      z: 0,
      text: '•',
      style,
    };
  });
  return {
    covers: [...textGroup.covers, stripCover],
    texts: [...textGroup.texts, ...markerTexts],
  };
}

function groupsForContent(content: ColumnContent, pushDeltaY: number): EditGroup[] {
  const list = content.bulletList;
  if (!list) return [exactShiftGroup(content.block, pushDeltaY)];

  const firstListLine = list.block.lines[0];
  const firstListIndex = firstListLine
    ? content.block.lines.findIndex((line) => line === firstListLine)
    : 0;
  const prefix = blockFromLines(
    content.block,
    content.block.lines.slice(0, Math.max(0, firstListIndex)),
  );
  return [
    ...(prefix ? [exactShiftGroup(prefix, pushDeltaY)] : []),
    bulletShiftGroup(list, pushDeltaY),
  ];
}

export interface PushColumnEditsResult {
  readonly edits: readonly Edit[];
  readonly stopped: boolean;
  readonly roomPt: number;
}

/**
 * Build a faithful, bullet-aware cascade. Groups are painted bottom-to-top so
 * every original lower cover lands before text translated into its old space.
 */
export function pushColumnEdits(
  run: ColumnContentRun,
  pushDeltaY: number,
  z: number,
  reflowKey?: string,
): PushColumnEditsResult {
  const roomPt = columnPushRoom(run);
  if (
    pushDeltaY <= EPSILON ||
    run.contents.length === 0
  ) {
    return { edits: [], stopped: false, roomPt };
  }
  if (pushDeltaY > roomPt + EPSILON) {
    return { edits: [], stopped: true, roomPt };
  }

  const groups = run.contents.flatMap((content) => groupsForContent(content, pushDeltaY));
  let nextZ = z;
  const edits: Edit[] = [];
  for (const group of groups.reverse()) {
    for (const edit of [...group.covers, ...group.texts]) {
      edits.push({
        ...edit,
        z: nextZ,
        ...(reflowKey ? { reflowKey } : {}),
      });
      nextZ += 1;
    }
  }
  return { edits, stopped: false, roomPt };
}
