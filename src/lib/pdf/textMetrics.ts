import { OPS } from 'pdfjs-dist';
import type { PDFPageProxy } from 'pdfjs-dist';
import type { OperatorListLike } from './images';
import { mapTextItemsToOperators } from './hiddenText';
type TextContent = Awaited<ReturnType<PDFPageProxy['getTextContent']>>;
type TextItem = Extract<TextContent['items'][number], { str: string }>;

export type TextMatrix = readonly [number, number, number, number, number, number];

/** Measurements in unrotated PDF user space; never a browser rectangle. */
export interface SourceTextMetrics {
  readonly matrix: TextMatrix;
  readonly x: number;
  readonly baselineY: number;
  readonly widthPt: number;
  readonly ascent?: number;
  readonly descent?: number;
  readonly characterSpacing?: number;
  readonly wordSpacing?: number;
  readonly leading?: number;
  readonly horizontalScale?: number;
  /** Exact character origins when one show operator accounts for the entire item. */
  readonly glyphs?: readonly { readonly text: string; readonly offsetPt: number; readonly widthPt: number }[];
}

export interface SourceLineMetrics {
  readonly x: number;
  readonly baselineY: number;
  readonly alignmentLeftPt?: number;
  readonly alignmentWidthPt?: number;
  readonly lineSpacingPt?: number;
}

interface TextState { size: number; characterSpacing: number; wordSpacing: number; leading: number; horizontalScale: number; show?: readonly unknown[] }
const SHOW = new Set([OPS.showText, OPS.showSpacedText, OPS.nextLineShowText, OPS.nextLineSetSpacingShowText]);

/** Reuse the existing read-only item/operator association, without altering matching. */
export function textStatesForItems(items: readonly unknown[], list: OperatorListLike): readonly (TextState | undefined)[] {
  const mapped = mapTextItemsToOperators(items, list);
  if (!mapped) return items.map(() => undefined);
  let state: TextState = { size: 1, characterSpacing: 0, wordSpacing: 0, leading: 0, horizontalScale: 1 };
  const stack: TextState[] = [], states = new Map<number, TextState>();
  list.fnArray.forEach((op, index) => {
    const raw = list.argsArray[index], args: readonly unknown[] = Array.isArray(raw) ? raw : [];
    const number = (offset: number) => typeof args[offset] === 'number' && Number.isFinite(args[offset]) ? args[offset] as number : undefined;
    if (op === OPS.save || op === OPS.paintFormXObjectBegin) stack.push({ ...state });
    else if (op === OPS.restore || op === OPS.paintFormXObjectEnd) state = stack.pop() ?? state;
    else if (op === OPS.setFont) state = { ...state, size: number(1) ?? state.size };
    else if (op === OPS.setCharSpacing) state = { ...state, characterSpacing: number(0) ?? state.characterSpacing };
    else if (op === OPS.setWordSpacing) state = { ...state, wordSpacing: number(0) ?? state.wordSpacing };
    else if (op === OPS.setLeading) state = { ...state, leading: number(0) ?? state.leading };
    else if (op === OPS.setLeadingMoveText) state = { ...state, leading: -(number(1) ?? -state.leading) };
    else if (op === OPS.setHScale) state = { ...state, horizontalScale: (number(0) ?? state.horizontalScale * 100) / 100 };
    else if (op === OPS.nextLineSetSpacingShowText) state = { ...state, wordSpacing: number(0) ?? state.wordSpacing, characterSpacing: number(1) ?? state.characterSpacing };
    if (op !== undefined && SHOW.has(op)) states.set(index, { ...state, show: op === OPS.nextLineSetSpacingShowText ? args.slice(-1) : args });
  });
  return mapped.map(index => states.get(index));
}

function finite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** Preserve raw source values even where rotated/complex text cannot yet be composed. */
export function sourceTextMetrics(item: TextItem, font: TextContent['styles'][string] | undefined, state?: TextState): SourceTextMetrics {
  const glyphs: { text: string; offsetPt: number; widthPt: number }[] = [];
  const scale = Math.hypot(item.transform[0]!, item.transform[1]!);
  const textScale = scale / Math.abs(state?.size || 1);
  let pen = 0, supported = true;
  const collect = (value: unknown) => {
    if (Array.isArray(value)) { value.forEach(collect); return; }
    if (typeof value === 'number') { pen -= value * scale / 1000; return; }
    if (!value || typeof value !== 'object') return;
    const glyph = value as { unicode?: unknown; width?: unknown; isSpace?: unknown };
    if (typeof glyph.unicode !== 'string' || typeof glyph.width !== 'number') { supported = false; return; }
    const widthPt = glyph.width * scale / 1000;
    glyphs.push({ text: glyph.unicode, offsetPt: pen, widthPt });
    pen += widthPt + (state?.characterSpacing ?? 0) * textScale
      + (glyph.isSpace === true ? (state?.wordSpacing ?? 0) * textScale : 0);
  };
  state?.show?.forEach(collect);
  const exactGlyphs = supported && glyphs.length > 0 && glyphs.map(glyph => glyph.text).join('') === item.str
    && Math.abs(pen - item.width) < 0.01 && Math.abs(item.transform[1]!) < 1e-8 && Math.abs(item.transform[2]!) < 1e-8;
  return {
    matrix: [...item.transform] as unknown as TextMatrix,
    x: item.transform[4]!, baselineY: item.transform[5]!, widthPt: item.width,
    ...(finite(font?.ascent) !== undefined ? { ascent: font!.ascent } : {}),
    ...(finite(font?.descent) !== undefined ? { descent: font!.descent } : {}),
    ...(state ? {
      characterSpacing: state.characterSpacing, wordSpacing: state.wordSpacing,
      leading: state.leading, horizontalScale: state.horizontalScale,
    } : {}),
    ...(exactGlyphs ? { glyphs } : {}),
  };
}

export function horizontalText(metrics: SourceTextMetrics): boolean {
  const [a, b, c, d] = metrics.matrix;
  return a > 0 && d > 0 && Math.abs(b) < 1e-8 && Math.abs(c) < 1e-8;
}
