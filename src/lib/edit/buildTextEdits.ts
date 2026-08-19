import type { CoverEdit, TextEdit, TextSpan, TextStyle } from '@/lib/export/types';
import type { PdfRect } from '@/lib/export/types';
import type { TextRun } from '@/lib/pdf/textContent';
import type { TextBlock, TextLine } from '@/lib/pdf/textContent';
import type { BulletList } from '@/lib/pdf/bulletList';
import { formatBulletEditorText } from '@/lib/pdf/bulletList';
import type { WrappedTextLine } from './textLayout';

let fallbackId = 0;

function id(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  fallbackId += 1;
  return `edit-${fallbackId}`;
}

export interface NextTextEdit {
  readonly text: string;
  readonly spans?: readonly TextSpan[];
  readonly style: TextStyle;
  readonly width: number;
  readonly height: number;
  readonly dx: number;
  readonly dy: number;
}

export function buildTextEdits(
  run: TextRun,
  next: NextTextEdit,
  z: number,
  base: PdfRect = run.rect,
): { readonly cover: CoverEdit; readonly text: TextEdit } {
  const cover: CoverEdit = {
    id: id(),
    kind: 'cover',
    pageIndex: run.pageIndex,
    rect: run.rect,
    z,
    sampleBackground: true,
  };
  const text: TextEdit = {
    id: id(),
    kind: 'text',
    pageIndex: run.pageIndex,
    rect: {
      x: base.x + next.dx,
      y: base.y + next.dy,
      w: next.width,
      h: base.h,
    },
    z: z + 1,
    text: next.text,
    style: next.style,
    ...(next.spans ? { spans: next.spans, boxSpans: next.spans } : {}),
    boxText: next.text,
    boxHeight: next.height,
  };

  return { cover, text };
}

export interface TextBlockBase {
  readonly x: number;
  readonly topBaselineY: number;
}

function paddedRect(rect: PdfRect, style: TextStyle): PdfRect {
  const horizontalPad = Math.max(0.75, style.fontSizePt * 0.08);
  const verticalPad = Math.max(1, style.fontSizePt * 0.14);
  return {
    x: rect.x - horizontalPad,
    y: rect.y - verticalPad,
    w: rect.w + horizontalPad * 2,
    h: rect.h + verticalPad * 2,
  };
}

export function coverRectForTextLine(line: TextLine): PdfRect {
  return paddedRect(line.rect, line.style);
}

export function coverRectsForTextBlock(block: TextBlock): readonly PdfRect[] {
  if (block.lines.length === 0) return [paddedRect(block.rect, block.style)];
  return block.lines.map(coverRectForTextLine);
}

export function coverRectForTextBlock(block: TextBlock): PdfRect {
  const rects = coverRectsForTextBlock(block);
  const left = Math.min(...rects.map((rect) => rect.x));
  const bottom = Math.min(...rects.map((rect) => rect.y));
  const right = Math.max(...rects.map((rect) => rect.x + rect.w));
  const top = Math.max(...rects.map((rect) => rect.y + rect.h));
  return { x: left, y: bottom, w: right - left, h: top - bottom };
}

const MIN_LINE_HEIGHT_RATIO = 1.0;
const MAX_LINE_HEIGHT_RATIO = 1.5;

export function textBlockLineHeight(block: TextBlock, style: TextStyle): number {
  const scale = style.fontSizePt / Math.max(1, block.style.fontSizePt);
  const detected = block.lineHeightPt * scale;
  return Math.min(
    style.fontSizePt * MAX_LINE_HEIGHT_RATIO,
    Math.max(style.fontSizePt * MIN_LINE_HEIGHT_RATIO, detected),
  );
}

export function freeTextLineHeight(style: TextStyle): number {
  return style.fontSizePt * 1.2;
}

export function buildFreeTextEdits(
  pageIndex: number,
  rect: PdfRect,
  next: NextTextEdit,
  wrappedLines: readonly (string | WrappedTextLine)[],
  z: number,
  boxId = id(),
): readonly TextEdit[] {
  const lineHeight = freeTextLineHeight(next.style);
  return wrappedLines.map<TextEdit>((line, index) => {
    const text = typeof line === 'string' ? line : line.text;
    const spans = typeof line === 'string' ? undefined : line.spans;
    return {
      id: id(),
      kind: 'text',
      pageIndex,
      rect: {
        x: rect.x + next.dx,
        y: rect.y + rect.h + next.dy - index * lineHeight,
        w: next.width,
        h: next.style.fontSizePt,
      },
      z: z + index,
      text,
      style: next.style,
      origin: 'free',
      boxId,
      ...(spans && spans.length > 0 ? { spans } : {}),
      boxText: next.text,
      ...(next.spans ? { boxSpans: next.spans } : {}),
      boxHeight: next.height,
    };
  });
}

export function buildTextBlockEdits(
  block: TextBlock,
  next: NextTextEdit,
  wrappedLines: readonly (string | WrappedTextLine)[],
  z: number,
  base: TextBlockBase = { x: block.rect.x, topBaselineY: block.topBaselineY },
): { readonly covers: readonly CoverEdit[]; readonly texts: readonly TextEdit[] } {
  const covers = coverRectsForTextBlock(block).map<CoverEdit>((rect, index) => ({
    id: id(),
    kind: 'cover',
    pageIndex: block.pageIndex,
    rect,
    z: z + index,
    sampleBackground: true,
  }));
  const lineHeight = textBlockLineHeight(block, next.style);
  const texts = wrappedLines.map<TextEdit>((line, index) => {
    const text = typeof line === 'string' ? line : line.text;
    const spans = typeof line === 'string' ? undefined : line.spans;
    return {
      id: id(),
      kind: 'text',
      pageIndex: block.pageIndex,
      rect: {
        x: base.x + next.dx,
        y: base.topBaselineY + next.dy - index * lineHeight,
        w: next.width,
        h: next.style.fontSizePt,
      },
      z: z + covers.length + index,
      text,
      style: next.style,
      ...(spans && spans.length > 0 ? { spans } : {}),
      boxText: next.text,
      ...(next.spans ? { boxSpans: next.spans } : {}),
      boxHeight: next.height,
    };
  });

  return { covers, texts };
}

export interface BulletListItemLayout {
  readonly text: string;
  readonly lines: readonly string[];
}

export interface BuiltBulletListEdits {
  readonly covers: readonly CoverEdit[];
  readonly texts: readonly TextEdit[];
  readonly usedHeightPt: number;
  readonly overflow: boolean;
}

/** One sampled patch owns both the original text and its painted bullet strip. */
export function coverRectForBulletList(list: BulletList): PdfRect {
  const padding = Math.max(0.75, list.block.style.fontSizePt * 0.08);
  return {
    x: list.coverRect.x - padding,
    y: list.coverRect.y - padding,
    w: list.coverRect.w + padding * 2,
    h: list.coverRect.h + padding * 2,
  };
}

/** A "•" glyph's dot is ~this fraction of its font size, centred ~this fraction above the baseline. */
const BULLET_GLYPH_DOT_RATIO = 0.31;
const BULLET_GLYPH_DOT_RISE = 0.31;

/** Render a list entirely through the existing cover + text export seam. */
export function buildBulletListEdits(
  list: BulletList,
  next: NextTextEdit,
  items: readonly BulletListItemLayout[],
  z: number,
  availableHeightPt: number,
): BuiltBulletListEdits {
  const lineHeight = textBlockLineHeight(list.block, next.style);
  const spacingScale = next.style.fontSizePt / Math.max(1, list.block.style.fontSizePt);
  const itemSpacing = list.itemSpacingPt * spacingScale;
  const firstBaseline = list.block.topBaselineY + next.dy;
  let baseline = firstBaseline;
  let lastBaseline = firstBaseline;

  for (const [itemIndex, item] of items.entries()) {
    const lineCount = Math.max(1, item.lines.length);
    lastBaseline = baseline - (lineCount - 1) * lineHeight;
    baseline = lastBaseline - lineHeight;
    if (itemIndex < items.length - 1) baseline -= itemSpacing;
  }

  const usedHeightPt = items.length === 0
    ? 0
    : next.style.fontSizePt + firstBaseline - lastBaseline;
  if (usedHeightPt > availableHeightPt + 0.5) {
    return { covers: [], texts: [], usedHeightPt, overflow: true };
  }

  const cover: CoverEdit = {
    id: id(),
    kind: 'cover',
    pageIndex: list.block.pageIndex,
    rect: coverRectForBulletList(list),
    z,
    sampleBackground: true,
  };
  const texts: TextEdit[] = [];
  const boxText = formatBulletEditorText(items.map((item) => item.text));
  const indent = Math.max(1, list.textX - list.bulletX);
  const textWidth = Math.max(1, next.width - indent);
  const bulletX = list.bulletX + next.dx;
  const textX = list.textX + next.dx;
  // Size the redrawn "•" to the measured original dot (bulletSizePt) rather than the
  // text size, and use a standard font — the "•" glyph isn't in the embedded subset.
  const bulletGlyphSizePt = list.bulletSizePt > 0
    ? Math.min(
        next.style.fontSizePt * 1.8,
        Math.max(next.style.fontSizePt * 0.75, list.bulletSizePt / BULLET_GLYPH_DOT_RATIO),
      )
    : next.style.fontSizePt;
  const bulletGlyphStyle: TextStyle = { ...next.style, fontSizePt: bulletGlyphSizePt, fontRef: undefined };
  const bulletGlyphDy = BULLET_GLYPH_DOT_RISE * (bulletGlyphSizePt - next.style.fontSizePt);
  baseline = firstBaseline;

  // Retain a non-painting session anchor when every item is removed so the
  // now-empty list can still be reopened and edited without revealing source text.
  if (items.length === 0) {
    texts.push({
      id: id(),
      kind: 'text',
      pageIndex: list.block.pageIndex,
      rect: {
        x: bulletX,
        y: firstBaseline,
        w: next.width,
        h: next.style.fontSizePt,
      },
      z: z + 1,
      text: '',
      style: next.style,
      boxText: '',
      boxHeight: 0,
    });
  }

  for (const [itemIndex, item] of items.entries()) {
    const lines = item.lines.length > 0 ? item.lines : [''];
    texts.push({
      id: id(),
      kind: 'text',
      pageIndex: list.block.pageIndex,
      rect: {
        x: bulletX,
        y: baseline - bulletGlyphDy,
        w: next.width,
        h: bulletGlyphSizePt,
      },
      z: z + 1 + texts.length,
      text: '•',
      style: bulletGlyphStyle,
      boxText,
      boxHeight: usedHeightPt,
    });
    for (const [lineIndex, text] of lines.entries()) {
      texts.push({
        id: id(),
        kind: 'text',
        pageIndex: list.block.pageIndex,
        rect: {
          x: textX,
          y: baseline - lineIndex * lineHeight,
          w: textWidth,
          h: next.style.fontSizePt,
        },
        z: z + 1 + texts.length,
        text,
        style: next.style,
        boxText,
        boxHeight: usedHeightPt,
      });
    }
    baseline -= lines.length * lineHeight;
    if (itemIndex < items.length - 1) baseline -= itemSpacing;
  }

  return { covers: [cover], texts, usedHeightPt, overflow: false };
}
