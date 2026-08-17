import type { PDFPageProxy } from 'pdfjs-dist';
import type { PdfRect } from '@/lib/export/types';
import { detectImages } from './images';
import type { ImageRegion } from './images';
import type { TextBlock, TextLine } from './textContent';

const MIN_MARKER_SIZE_PT = 1;
const MAX_MARKER_SIZE_PT = 7;
const MAX_LEFT_GAP_PT = 16;
const MIN_LEFT_GAP_PT = 0.5;
const MIN_LIST_ITEMS = 2;

export interface BulletMarker {
  readonly lineIndex: number;
  readonly line: TextLine;
  readonly rect: PdfRect;
  readonly centerX: number;
  readonly centerY: number;
}

export interface BulletListItem {
  readonly bulletX: number;
  readonly baselineY: number;
  readonly text: string;
  readonly lines: readonly TextLine[];
  readonly markerRect: PdfRect;
}

export interface BulletList {
  readonly sourceBlock: TextBlock;
  readonly block: TextBlock;
  readonly items: readonly BulletListItem[];
  readonly bulletX: number;
  readonly textX: number;
  readonly bulletSizePt: number;
  readonly lineHeightPt: number;
  readonly itemSpacingPt: number;
  readonly coverRect: PdfRect;
}

export const BULLET_NO_ROOM_MESSAGE = 'No room — the next section is in the way';

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle] ?? 0;
  return ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
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

function markerDistance(line: TextLine, region: ImageRegion): number | undefined {
  if (region.pageIndex !== line.pageIndex) return undefined;
  const { rect } = region;
  const size = Math.max(rect.w, rect.h);
  const aspectRatio = rect.w / Math.max(0.001, rect.h);
  if (
    size < MIN_MARKER_SIZE_PT ||
    size > Math.min(MAX_MARKER_SIZE_PT, line.style.fontSizePt * 0.85) ||
    aspectRatio < 0.65 ||
    aspectRatio > 1.55
  ) {
    return undefined;
  }

  const leftGap = line.rect.x - (rect.x + rect.w);
  if (leftGap < MIN_LEFT_GAP_PT || leftGap > MAX_LEFT_GAP_PT) return undefined;

  // A PDF text rect's y is its draw baseline. The visible centre of a body-text
  // bullet sits roughly one third of an em above it.
  const centerY = rect.y + rect.h / 2;
  const expectedCenterY = line.baselineY + line.style.fontSizePt * 0.34;
  const verticalDistance = Math.abs(centerY - expectedCenterY);
  const verticalTolerance = Math.max(1.5, line.style.fontSizePt * 0.34);
  if (verticalDistance > verticalTolerance) return undefined;

  return verticalDistance + leftGap * 0.05;
}

/** Match small rendered image markers immediately left of a block's text lines. */
export function detectBulletMarkers(
  block: TextBlock,
  imageRegions: readonly ImageRegion[],
): BulletMarker[] {
  const claimedRegions = new Set<number>();
  const markers: BulletMarker[] = [];

  for (const [lineIndex, line] of block.lines.entries()) {
    const match = imageRegions
      .map((region, regionIndex) => ({
        region,
        regionIndex,
        distance: claimedRegions.has(regionIndex) ? undefined : markerDistance(line, region),
      }))
      .filter((candidate): candidate is {
        region: ImageRegion;
        regionIndex: number;
        distance: number;
      } => candidate.distance !== undefined)
      .sort((left, right) => left.distance - right.distance)[0];
    if (!match) continue;
    claimedRegions.add(match.regionIndex);
    markers.push({
      lineIndex,
      line,
      rect: match.region.rect,
      centerX: match.region.rect.x + match.region.rect.w / 2,
      centerY: match.region.rect.y + match.region.rect.h / 2,
    });
  }

  return markers;
}

function itemText(lines: readonly TextLine[]): string {
  return lines
    .map((line) => line.text.trim())
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ');
}

export function formatBulletEditorText(items: readonly string[]): string {
  return items.map((item) => `• ${item.trim()}`).join('\n');
}

export function parseBulletEditorItems(text: string): string[] {
  return text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/^\s*•\s?/, '').trim())
    .filter(Boolean);
}

/** The editor includes the bullet strip; the extracted list block starts at the text column. */
export function bulletEditorBlock(list: BulletList): TextBlock {
  return {
    ...list.block,
    text: formatBulletEditorText(list.items.map((item) => item.text)),
    rect: list.coverRect,
  };
}

function horizontalOverlap(left: PdfRect, right: PdfRect): number {
  return Math.max(
    0,
    Math.min(left.x + left.w, right.x + right.w) - Math.max(left.x, right.x),
  );
}

/** Find the first separate same-column content below this list; Stage 1 never moves it. */
export function nextBlockBelowBulletList(
  list: BulletList,
  blocks: readonly TextBlock[],
): TextBlock | undefined {
  return blocks
    .filter((candidate) => {
      if (candidate === list.sourceBlock || candidate.pageIndex !== list.block.pageIndex) return false;
      const candidateTop = candidate.rect.y + candidate.rect.h;
      if (candidateTop > list.coverRect.y + 0.5) return false;
      const overlap = horizontalOverlap(list.block.rect, candidate.rect);
      return overlap >= Math.max(2, Math.min(list.block.rect.w, candidate.rect.w) * 0.2);
    })
    .sort((left, right) => (
      (right.rect.y + right.rect.h) - (left.rect.y + left.rect.h)
    ))[0];
}

/** Vertical room from the list top to the next same-column content (or page bottom). */
export function availableBulletListHeight(
  list: BulletList,
  blocks: readonly TextBlock[],
  pageBottomY = 0,
): number {
  const nextBlock = nextBlockBelowBulletList(list, blocks);
  const boundaryTop = nextBlock
    ? nextBlock.rect.y + nextBlock.rect.h
    : pageBottomY;
  return Math.max(0, list.coverRect.y + list.coverRect.h - boundaryTop);
}

/** Build an editable list model only when at least two bullet starts are proven. */
export function detectBulletListFromRegions(
  block: TextBlock,
  imageRegions: readonly ImageRegion[],
): BulletList | null {
  const markers = detectBulletMarkers(block, imageRegions);
  const firstMarker = markers[0];
  if (markers.length < MIN_LIST_ITEMS || !firstMarker) return null;

  // PDF generators often group a job heading and its following bullets into one
  // paragraph block. Own only the marker-started suffix; the heading stays pristine.
  const listLines = block.lines.slice(firstMarker.lineIndex);
  const listRect = unionRects(listLines.map((line) => line.rect));
  const listBlock: TextBlock = {
    ...block,
    text: listLines.map((line) => line.text).join('\n'),
    rect: listRect,
    topBaselineY: firstMarker.line.baselineY,
    style: firstMarker.line.style,
    lines: listLines,
  };

  const items = markers.map<BulletListItem>((marker, markerIndex) => {
    const nextLineIndex = markers[markerIndex + 1]?.lineIndex ?? block.lines.length;
    const lines = block.lines.slice(marker.lineIndex, nextLineIndex);
    return {
      bulletX: marker.rect.x,
      baselineY: marker.line.baselineY,
      text: itemText(lines),
      lines,
      markerRect: marker.rect,
    };
  });
  const itemSpacing = items.slice(0, -1).map((item, index) => {
    const next = items[index + 1];
    if (!next) return 0;
    return Math.max(
      0,
      item.baselineY - next.baselineY - item.lines.length * block.lineHeightPt,
    );
  });

  return {
    sourceBlock: block,
    block: listBlock,
    items,
    bulletX: median(items.map((item) => item.bulletX)),
    textX: median(items.map((item) => item.lines[0]?.rect.x ?? block.rect.x)),
    bulletSizePt: median(items.map((item) => Math.max(item.markerRect.w, item.markerRect.h))),
    lineHeightPt: block.lineHeightPt,
    itemSpacingPt: median(itemSpacing),
    coverRect: unionRects([listRect, ...items.map((item) => item.markerRect)]),
  };
}

/** Detect a bullet list from the page's painted image markers. */
export async function detectBulletList(
  block: TextBlock,
  page: PDFPageProxy,
): Promise<BulletList | null> {
  const imageRegions = await detectImages(page, block.pageIndex);
  return detectBulletListFromRegions(block, imageRegions);
}
