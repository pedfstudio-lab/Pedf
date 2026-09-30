import { OPS } from 'pdfjs-dist';
import type { Rgb } from '@/lib/export/types';
import { mapTextItemsToOperators } from './hiddenText';

export interface TextPaintOperatorListLike {
  readonly fnArray: readonly number[];
  readonly argsArray: readonly unknown[];
}

export interface TextPaintState {
  readonly color?: Rgb;
  readonly strokeColor?: Rgb;
  readonly lineWidth?: number;
  readonly renderingMode: number;
  readonly visible: boolean;
  readonly supported: boolean;
  /** True only after a same-colour thin mode-2 outline is resolved against its font size. */
  readonly syntheticBold?: boolean;
}

interface PaintState {
  readonly fill: Rgb;
  readonly fillSupported: boolean;
  readonly stroke: Rgb;
  readonly strokeSupported: boolean;
  readonly lineWidth: number;
  readonly renderingMode: number;
}

const BLACK: Rgb = { r: 0, g: 0, b: 0 };
const SYNTHETIC_BOLD_STROKE_RATIO = 0.03;
const SYNTHETIC_BOLD_RATIO_TOLERANCE = 0.005;
const COLOR_TOLERANCE = 1 / 255 + Number.EPSILON;
const TEXT_SHOW = new Set([
  OPS.showText,
  OPS.showSpacedText,
  OPS.nextLineShowText,
  OPS.nextLineSetSpacingShowText,
]);

function numericValues(value: unknown): number[] | undefined {
  if (!Array.isArray(value) && !ArrayBuffer.isView(value)) return undefined;
  const values = Array.from(value as ArrayLike<unknown>);
  if (values.some((entry) => typeof entry !== 'number' || !Number.isFinite(entry))) return undefined;
  return values as number[];
}

function normalizedComponents(value: unknown, count: number): number[] | undefined {
  const values = numericValues(value);
  if (!values || values.length < count) return undefined;
  const scale = values.slice(0, count).some((entry) => entry > 1) ? 255 : 1;
  return values.slice(0, count).map((entry) => Math.min(1, Math.max(0, entry / scale)));
}

function rgbColor(value: unknown): Rgb | undefined {
  const values = normalizedComponents(value, 3);
  if (!values) return undefined;
  return { r: values[0] ?? 0, g: values[1] ?? 0, b: values[2] ?? 0 };
}

function grayColor(value: unknown): Rgb | undefined {
  const gray = normalizedComponents(value, 1)?.[0];
  return gray === undefined ? undefined : { r: gray, g: gray, b: gray };
}

function cmykColor(value: unknown): Rgb | undefined {
  const values = normalizedComponents(value, 4);
  if (!values) return undefined;
  const [c = 0, m = 0, y = 0, k = 0] = values;
  return {
    r: 1 - Math.min(1, c + k),
    g: 1 - Math.min(1, m + k),
    b: 1 - Math.min(1, y + k),
  };
}

function publicState(state: PaintState): TextPaintState {
  const visible = state.renderingMode !== 3 && state.renderingMode !== 7;
  const usesFill = [0, 2, 4, 6].includes(state.renderingMode);
  const usesStroke = [1, 2, 5, 6].includes(state.renderingMode);
  // Mode 2 needs the run's font size before it can be distinguished from
  // decorative outlined text. resolveTextPaint performs that guarded step.
  const supported = visible && [0, 4].includes(state.renderingMode) && state.fillSupported;
  return {
    ...(usesFill && state.fillSupported ? { color: state.fill } : {}),
    ...(usesStroke && state.strokeSupported ? { strokeColor: state.stroke } : {}),
    ...(usesStroke ? { lineWidth: state.lineWidth } : {}),
    renderingMode: state.renderingMode,
    visible,
    supported,
  };
}

function sameColor(left: Rgb | undefined, right: Rgb | undefined): boolean {
  return Boolean(
    left && right &&
    Math.abs(left.r - right.r) <= COLOR_TOLERANCE &&
    Math.abs(left.g - right.g) <= COLOR_TOLERANCE &&
    Math.abs(left.b - right.b) <= COLOR_TOLERANCE
  );
}

/**
 * Resolve mode-2 fill-and-stroke only when it is the same thin synthetic-bold
 * technique that the editor writes. Contrasting, patterned and thick outlines
 * remain unsupported because the text model cannot reproduce them faithfully.
 */
export function resolveTextPaint(
  paint: TextPaintState,
  fontSizePt: number,
): TextPaintState {
  if (paint.supported || paint.renderingMode !== 2) return paint;
  if (!sameColor(paint.color, paint.strokeColor)) return paint;
  if (!Number.isFinite(fontSizePt) || fontSizePt <= 0) return paint;
  if (!Number.isFinite(paint.lineWidth) || (paint.lineWidth ?? 0) <= 0) return paint;
  const ratio = (paint.lineWidth ?? 0) / fontSizePt;
  if (ratio > SYNTHETIC_BOLD_STROKE_RATIO + SYNTHETIC_BOLD_RATIO_TOLERANCE) {
    return paint;
  }
  return { ...paint, supported: true, syntheticBold: true };
}

/** Read the paint state at every text-show operator in a flattened PDF.js operator list. */
export function textPaintByOperator(
  operatorList: TextPaintOperatorListLike,
): ReadonlyMap<number, TextPaintState> {
  let state: PaintState = {
    fill: BLACK,
    fillSupported: true,
    stroke: BLACK,
    strokeSupported: true,
    lineWidth: 1,
    renderingMode: 0,
  };
  const stack: PaintState[] = [];
  const result = new Map<number, TextPaintState>();

  for (let index = 0; index < operatorList.fnArray.length; index += 1) {
    const operation = operatorList.fnArray[index];
    const args = operatorList.argsArray[index];
    if (operation === OPS.save || operation === OPS.paintFormXObjectBegin) {
      stack.push(state);
    } else if (operation === OPS.restore || operation === OPS.paintFormXObjectEnd) {
      state = stack.pop() ?? state;
    } else if (operation === OPS.setFillRGBColor) {
      const fill = rgbColor(args);
      state = fill ? { ...state, fill, fillSupported: true } : { ...state, fillSupported: false };
    } else if (operation === OPS.setFillGray) {
      const fill = grayColor(args);
      state = fill ? { ...state, fill, fillSupported: true } : { ...state, fillSupported: false };
    } else if (operation === OPS.setFillCMYKColor) {
      const fill = cmykColor(args);
      state = fill ? { ...state, fill, fillSupported: true } : { ...state, fillSupported: false };
    } else if (operation === OPS.setFillColorN) {
      state = { ...state, fillSupported: false };
    } else if (operation === OPS.setStrokeRGBColor) {
      const stroke = rgbColor(args);
      state = stroke
        ? { ...state, stroke, strokeSupported: true }
        : { ...state, strokeSupported: false };
    } else if (operation === OPS.setStrokeGray) {
      const stroke = grayColor(args);
      state = stroke
        ? { ...state, stroke, strokeSupported: true }
        : { ...state, strokeSupported: false };
    } else if (operation === OPS.setStrokeCMYKColor) {
      const stroke = cmykColor(args);
      state = stroke
        ? { ...state, stroke, strokeSupported: true }
        : { ...state, strokeSupported: false };
    } else if (operation === OPS.setStrokeColorN) {
      state = { ...state, strokeSupported: false };
    } else if (operation === OPS.setLineWidth) {
      const lineWidth = numericValues(args)?.[0];
      if (lineWidth !== undefined) state = { ...state, lineWidth };
    } else if (operation === OPS.setTextRenderingMode) {
      const renderingMode = numericValues(args)?.[0];
      if (renderingMode !== undefined) state = { ...state, renderingMode };
    } else if (operation !== undefined && TEXT_SHOW.has(operation)) {
      result.set(index, publicState(state));
    }
  }
  return result;
}

/** Match extracted text items to the paint state that visibly produced them. */
export function textPaintForItems(
  items: readonly unknown[],
  operatorList: TextPaintOperatorListLike,
): readonly (TextPaintState | undefined)[] | null {
  const mapped = mapTextItemsToOperators(items, operatorList);
  if (!mapped) return null;
  const states = textPaintByOperator(operatorList);
  return mapped.map((operatorIndex) => (
    operatorIndex < 0 ? undefined : states.get(operatorIndex)
  ));
}
