import type { CoverEdit, TextEdit, TextSpan, TextStyle } from '@/lib/export/types';
import type { PdfRect } from '@/lib/export/types';
import type { TextRun } from '@/lib/pdf/textContent';
import type { TextBlock, TextLine } from '@/lib/pdf/textContent';
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

export function textBlockLineHeight(block: TextBlock, style: TextStyle): number {
  const scale = style.fontSizePt / Math.max(1, block.style.fontSizePt);
  const detected = block.lineHeightPt * scale;
  return Math.min(
    style.fontSizePt * 1.35,
    Math.max(style.fontSizePt * 1.15, detected),
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
