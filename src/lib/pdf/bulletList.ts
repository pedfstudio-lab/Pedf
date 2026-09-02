import type { PDFPageProxy } from 'pdfjs-dist';
import type { PdfRect, TextSpan } from '@/lib/export/types';
import { normalizeTextSpans, textFromSpans } from '@/lib/edit/richText';
import { detectImages } from './images';
import type { ImageRegion } from './images';
import type { TextBlock, TextLine, TextRun } from './textContent';

const MIN_MARKER_SIZE_PT = 1;
const MAX_MARKER_SIZE_PT = 7;
const MAX_LEFT_GAP_PT = 16;
const MIN_LEFT_GAP_PT = 0.5;
const MIN_LIST_ITEMS = 2;

/** Text glyphs commonly used as list markers by Word and other PDF producers. */
export const TEXT_BULLET_CHARACTERS: ReadonlySet<string> = new Set([
  '\uF0B7',
  '\uF0A7',
  '\uF0A8',
  '\uF0D8',
  '\uF06C',
  '\uF075',
  '\uF0FC',
  '\uF0FD',
  '\u2022',
  '\u25CF',
  '\u25AA',
  '\u25E6',
  '\u2023',
  '\u2043',
  '\u00B7',
  '\u2219',
]);

export interface BulletMarker {
  readonly lineIndex: number;
  readonly line: TextLine;
  readonly rect: PdfRect;
  readonly centerX: number;
  readonly centerY: number;
  /** Present only when the marker came from a text run rather than an image. */
  readonly textCharacter?: string;
}

interface TextBulletMatch {
  readonly markerRun: TextRun;
  readonly bodyRun: TextRun;
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

/** Bullet-list source blocks are owned exclusively by the bullet editor target. */
export function isBulletListBlock(
  block: TextBlock,
  lists: readonly BulletList[],
): boolean {
  return lists.some((list) => list.sourceBlock === block);
}

/**
 * The heading lines that precede the first bullet in a source block (e.g. a job
 * title above its bullets). Returns a standalone editable block, or null when the
 * list starts at the very first line. The bullet suffix keeps its own editor.
 */
export function bulletListHeadingBlock(list: BulletList): TextBlock | null {
  const headingCount = list.sourceBlock.lines.length - list.block.lines.length;
  if (headingCount <= 0) return null;
  const headingLines = list.sourceBlock.lines.slice(0, headingCount);
  const first = headingLines[0];
  if (!first) return null;
  return {
    ...list.sourceBlock,
    text: headingLines.map((line) => line.text).join('\n'),
    rect: unionRects(headingLines.map((line) => line.rect)),
    topBaselineY: Math.max(...headingLines.map((line) => line.baselineY)),
    style: first.style,
    lines: headingLines,
  };
}

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

function textBulletMatch(line: TextLine): TextBulletMatch | undefined {
  const [markerRun, ...remainingRuns] = line.runs.filter((run) => run.text.trim() !== '');
  const markerText = markerRun?.text.trim() ?? '';
  if (!markerRun || !TEXT_BULLET_CHARACTERS.has(markerText)) return undefined;

  const bodyRun = remainingRuns.find((run) => run.text.trim() !== '');
  if (!bodyRun) return undefined;

  // A text item's box is the font em-box, so its height is usually the same as
  // the body text. Its narrow width is the useful equivalent of the image
  // detector's square-marker size check.
  const markerSize = Math.min(markerRun.rect.w, markerRun.rect.h);
  if (
    markerSize < MIN_MARKER_SIZE_PT ||
    markerSize > Math.min(MAX_MARKER_SIZE_PT, line.style.fontSizePt * 0.85)
  ) {
    return undefined;
  }

  const leftGap = bodyRun.rect.x - (markerRun.rect.x + markerRun.rect.w);
  if (leftGap < MIN_LEFT_GAP_PT || leftGap > MAX_LEFT_GAP_PT) return undefined;

  const baselineDistance = Math.abs(markerRun.rect.y - bodyRun.rect.y);
  if (baselineDistance > Math.max(1.5, line.style.fontSizePt * 0.25)) return undefined;

  return { markerRun, bodyRun };
}

/** Match recognized symbol-character bullets at the left edge of text lines. */
export function detectTextBulletMarkers(block: TextBlock): BulletMarker[] {
  return block.lines.flatMap((line, lineIndex) => {
    const match = textBulletMatch(line);
    if (!match) return [];
    const { rect } = match.markerRun;
    return [{
      lineIndex,
      line,
      rect,
      centerX: rect.x + rect.w / 2,
      centerY: rect.y + rect.h / 2,
      textCharacter: match.markerRun.text.trim(),
    }];
  });
}

function bulletPrefixLength(text: string): number {
  const leadingWhitespace = text.match(/^\s*/u)?.[0].length ?? 0;
  const remainder = text.slice(leadingWhitespace);
  const character = Array.from(remainder)[0];
  if (!character || !TEXT_BULLET_CHARACTERS.has(character)) return 0;
  const afterCharacter = leadingWhitespace + character.length;
  const trailingWhitespace = text.slice(afterCharacter).match(/^\s*/u)?.[0].length ?? 0;
  return afterCharacter + trailingWhitespace;
}

function withoutTextBulletMarker(line: TextLine, marker: BulletMarker): TextLine {
  if (!marker.textCharacter) return line;
  const markerRunIndex = line.runs.findIndex((run) => (
    TEXT_BULLET_CHARACTERS.has(run.text.trim()) &&
    run.rect.x === marker.rect.x &&
    run.rect.y === marker.rect.y
  ));
  if (markerRunIndex < 0) return line;
  const bodyRuns = line.runs.slice(markerRunIndex + 1).filter((run) => run.text.trim() !== '');
  const firstBodyRun = bodyRuns[0];
  if (!firstBodyRun) return line;
  return {
    ...line,
    text: line.text.slice(bulletPrefixLength(line.text)),
    rect: unionRects(bodyRuns.map((run) => run.rect)),
    baselineY: bodyRuns.reduce((sum, run) => sum + run.rect.y, 0) / bodyRuns.length,
    style: bodyRuns.reduce((best, run) => (
      run.text.trim().length > best.text.trim().length ? run : best
    ), firstBodyRun).style,
    runs: bodyRuns,
  };
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
    .map((line) => line.slice(bulletPrefixLength(line)).trim())
    .filter(Boolean);
}

export interface BulletEditorItemSpans {
  readonly text: string;
  readonly spans: readonly TextSpan[];
}

function sliceTextSpans(
  spans: readonly TextSpan[],
  start: number,
  end: number,
): TextSpan[] {
  const sliced: TextSpan[] = [];
  let offset = 0;
  for (const span of spans) {
    const spanStart = offset;
    const spanEnd = spanStart + span.text.length;
    const from = Math.max(start, spanStart);
    const to = Math.min(end, spanEnd);
    if (from < to) {
      sliced.push({
        ...span,
        text: span.text.slice(from - spanStart, to - spanStart),
      });
    }
    offset = spanEnd;
  }
  return normalizeTextSpans(sliced);
}

/** Split the editor's rich value into marker-free bullet items without losing inline styles. */
export function parseBulletEditorItemSpans(
  text: string,
  spans: readonly TextSpan[],
): BulletEditorItemSpans[] {
  const normalizedText = text.replace(/\r\n?/g, '\n');
  const normalizedSpans = normalizeTextSpans(spans);
  const sourceSpans = textFromSpans(normalizedSpans) === normalizedText
    ? normalizedSpans
    : normalizedText
      ? [{ text: normalizedText, bold: false, italic: false }]
      : [];
  const lines: TextSpan[][] = [[]];

  for (const span of sourceSpans) {
    const parts = span.text.split('\n');
    parts.forEach((part, index) => {
      if (part) lines.at(-1)?.push({ ...span, text: part });
      if (index < parts.length - 1) lines.push([]);
    });
  }

  return lines.flatMap((lineSpans) => {
    const normalizedLine = normalizeTextSpans(lineSpans);
    const lineText = textFromSpans(normalizedLine);
    const markerLength = bulletPrefixLength(lineText);
    const markerless = lineText.slice(markerLength);
    const leadingWhitespace = markerless.length - markerless.trimStart().length;
    const start = markerLength + leadingWhitespace;
    const end = lineText.length - lineText.slice(start).length + lineText.slice(start).trimEnd().length;
    if (start >= end) return [];
    const itemSpans = sliceTextSpans(normalizedLine, start, end);
    return [{ text: textFromSpans(itemSpans), spans: itemSpans }];
  });
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
export function buildBulletList(
  block: TextBlock,
  markers: readonly BulletMarker[],
): BulletList | null {
  const firstMarker = markers[0];
  if (markers.length < MIN_LIST_ITEMS || !firstMarker) return null;

  // PDF generators often group a job heading and its following bullets into one
  // paragraph block. Own only the marker-started suffix; the heading stays pristine.
  const markerByLineIndex = new Map(markers.map((marker) => [marker.lineIndex, marker]));
  const listLines = block.lines.slice(firstMarker.lineIndex).map((line, relativeIndex) => {
    const marker = markerByLineIndex.get(firstMarker.lineIndex + relativeIndex);
    return marker ? withoutTextBulletMarker(line, marker) : line;
  });
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
    const relativeStart = marker.lineIndex - firstMarker.lineIndex;
    const relativeEnd = nextLineIndex - firstMarker.lineIndex;
    const lines = listLines.slice(relativeStart, relativeEnd);
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
    // Text runs expose a full em-box height rather than the visible dot height;
    // their narrow dimension is the useful glyph measurement. Preserve the
    // image-marker calculation exactly for Task 10H lists.
    bulletSizePt: median(markers.map((marker) => (
      marker.textCharacter
        ? Math.min(marker.rect.w, marker.rect.h)
        : Math.max(marker.rect.w, marker.rect.h)
    ))),
    lineHeightPt: block.lineHeightPt,
    itemSpacingPt: median(itemSpacing),
    coverRect: unionRects([listRect, ...items.map((item) => item.markerRect)]),
  };
}

/** Prefer image markers; fall back to recognized text-symbol markers only if needed. */
export function detectBulletListFromRegions(
  block: TextBlock,
  imageRegions: readonly ImageRegion[],
): BulletList | null {
  const imageList = buildBulletList(block, detectBulletMarkers(block, imageRegions));
  if (imageList) return imageList;
  return buildBulletList(block, detectTextBulletMarkers(block));
}

/** Detect a bullet list from painted image markers, then text symbols as a fallback. */
export async function detectBulletList(
  block: TextBlock,
  page: PDFPageProxy,
): Promise<BulletList | null> {
  const imageRegions = await detectImages(page, block.pageIndex);
  return detectBulletListFromRegions(block, imageRegions);
}
