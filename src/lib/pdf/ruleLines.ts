import { OPS } from 'pdfjs-dist';
import type { PDFPageProxy } from 'pdfjs-dist';
import type { Rgb } from '@/lib/export/types';

export const MIN_RULE_LENGTH_PT = 72;
export const MAX_RULE_THICKNESS_PT = 3;
const AXIS_TOLERANCE_PT = 1.5;
const MERGE_TOLERANCE_PT = 2;
const PAGE_FRAME_MARGIN_PT = 4;

type Matrix = readonly [number, number, number, number, number, number];

export interface RuleLine {
  readonly pageIndex: number;
  readonly orientation: 'horizontal' | 'vertical';
  readonly x1: number;
  readonly y1: number;
  readonly x2: number;
  readonly y2: number;
  readonly thicknessPt: number;
  readonly color: Rgb;
}

export interface RuleOperatorListLike {
  readonly fnArray: readonly number[];
  readonly argsArray: readonly unknown[];
}

export interface RulePageBox {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface TextUnderlineHint {
  readonly x: number;
  readonly baselineY: number;
  readonly width: number;
  readonly height: number;
}

interface GraphicsState {
  readonly ctm: Matrix;
  readonly lineWidth: number;
  readonly stroke: Rgb;
  readonly fill: Rgb;
}

interface ParsedPath {
  readonly kind: 'rectangle' | 'segment';
  readonly points: readonly { readonly x: number; readonly y: number }[];
}

const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];
const BLACK: Rgb = { r: 0, g: 0, b: 0 };

function numericValues(value: unknown): number[] | undefined {
  if (!Array.isArray(value) && !ArrayBuffer.isView(value)) return undefined;
  const values = Array.from(value as ArrayLike<unknown>);
  if (values.some((entry) => typeof entry !== 'number' || !Number.isFinite(entry))) return undefined;
  return values as number[];
}

function matrix(value: unknown): Matrix | undefined {
  const values = numericValues(value);
  return values?.length === 6 ? values as unknown as Matrix : undefined;
}

function multiply(left: Matrix, right: Matrix): Matrix {
  return [
    left[0] * right[0] + left[2] * right[1],
    left[1] * right[0] + left[3] * right[1],
    left[0] * right[2] + left[2] * right[3],
    left[1] * right[2] + left[3] * right[3],
    left[0] * right[4] + left[2] * right[5] + left[4],
    left[1] * right[4] + left[3] * right[5] + left[5],
  ];
}

function transformPoint(ctm: Matrix, x: number, y: number) {
  return {
    x: ctm[0] * x + ctm[2] * y + ctm[4],
    y: ctm[1] * x + ctm[3] * y + ctm[5],
  };
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
  const values = normalizedComponents(value, 1);
  const gray = values?.[0];
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

function parsePath(raw: unknown, ctm: Matrix): ParsedPath | undefined {
  if (!Array.isArray(raw)) return undefined;
  const operations = numericValues(raw[0]);
  const coordinates = numericValues(raw[1]);
  if (!operations || !coordinates) return undefined;

  if (operations.length === 1 && operations[0] === OPS.rectangle && coordinates.length >= 4) {
    const [x = 0, y = 0, width = 0, height = 0] = coordinates;
    return {
      kind: 'rectangle',
      points: [
        transformPoint(ctm, x, y),
        transformPoint(ctm, x + width, y),
        transformPoint(ctm, x + width, y + height),
        transformPoint(ctm, x, y + height),
      ],
    };
  }

  if (
    operations.every((operation) => operation === OPS.moveTo || operation === OPS.lineTo) &&
    operations.filter((operation) => operation === OPS.lineTo).length === 1
  ) {
    let cursor = 0;
    let current: { readonly x: number; readonly y: number } | undefined;
    let segment: readonly [
      { readonly x: number; readonly y: number },
      { readonly x: number; readonly y: number },
    ] | undefined;
    for (const operation of operations) {
      const x = coordinates[cursor];
      const y = coordinates[cursor + 1];
      cursor += 2;
      if (x === undefined || y === undefined) return undefined;
      const next = transformPoint(ctm, x, y);
      if (operation === OPS.moveTo) current = next;
      else if (current) segment = [current, next];
    }
    if (segment) return { kind: 'segment', points: segment };
  }

  return undefined;
}

function isPageFrame(line: RuleLine, page: RulePageBox): boolean {
  if (line.orientation === 'horizontal') {
    const boundaryDistance = Math.min(
      Math.abs(line.y1 - page.y),
      Math.abs(line.y1 - (page.y + page.height)),
    );
    return Math.abs(line.x2 - line.x1) >= page.width * 0.9 && boundaryDistance <= PAGE_FRAME_MARGIN_PT;
  }
  const boundaryDistance = Math.min(
    Math.abs(line.x1 - page.x),
    Math.abs(line.x1 - (page.x + page.width)),
  );
  return Math.abs(line.y2 - line.y1) >= page.height * 0.9 && boundaryDistance <= PAGE_FRAME_MARGIN_PT;
}

function classifyPath(
  path: ParsedPath | undefined,
  paint: 'fill' | 'stroke',
  state: GraphicsState,
  pageIndex: number,
  page: RulePageBox,
): RuleLine | undefined {
  if (!path) return undefined;
  let x1: number;
  let y1: number;
  let x2: number;
  let y2: number;
  let thicknessPt: number;
  let color: Rgb;

  if (path.kind === 'rectangle') {
    if (paint !== 'fill') return undefined;
    const left = Math.min(...path.points.map((entry) => entry.x));
    const right = Math.max(...path.points.map((entry) => entry.x));
    const bottom = Math.min(...path.points.map((entry) => entry.y));
    const top = Math.max(...path.points.map((entry) => entry.y));
    const width = right - left;
    const height = top - bottom;
    if (width <= 0 || height <= 0) return undefined;
    if (width >= height) {
      x1 = left;
      x2 = right;
      y1 = y2 = (bottom + top) / 2;
      thicknessPt = height;
    } else {
      x1 = x2 = (left + right) / 2;
      y1 = bottom;
      y2 = top;
      thicknessPt = width;
    }
    color = state.fill;
  } else {
    if (paint !== 'stroke') return undefined;
    const first = path.points[0];
    const second = path.points[1];
    if (!first || !second) return undefined;
    ({ x: x1, y: y1 } = first);
    ({ x: x2, y: y2 } = second);
    const horizontal = Math.abs(x2 - x1) >= Math.abs(y2 - y1);
    const perpendicularScale = horizontal
      ? Math.hypot(state.ctm[2], state.ctm[3])
      : Math.hypot(state.ctm[0], state.ctm[1]);
    thicknessPt = Math.max(0.25, state.lineWidth * perpendicularScale);
    color = state.stroke;
  }

  const horizontal = Math.abs(x2 - x1) >= Math.abs(y2 - y1);
  const offAxis = horizontal ? Math.abs(y2 - y1) : Math.abs(x2 - x1);
  if (offAxis > AXIS_TOLERANCE_PT || thicknessPt > MAX_RULE_THICKNESS_PT) return undefined;

  const line: RuleLine = horizontal
    ? {
        pageIndex,
        orientation: 'horizontal',
        x1: Math.min(x1, x2),
        y1: (y1 + y2) / 2,
        x2: Math.max(x1, x2),
        y2: (y1 + y2) / 2,
        thicknessPt,
        color,
      }
    : {
        pageIndex,
        orientation: 'vertical',
        x1: (x1 + x2) / 2,
        y1: Math.min(y1, y2),
        x2: (x1 + x2) / 2,
        y2: Math.max(y1, y2),
        thicknessPt,
        color,
      };

  return isPageFrame(line, page) ? undefined : line;
}

function colorsMatch(left: Rgb, right: Rgb): boolean {
  return (
    Math.abs(left.r - right.r) <= 0.03 &&
    Math.abs(left.g - right.g) <= 0.03 &&
    Math.abs(left.b - right.b) <= 0.03
  );
}

function mergeLines(lines: readonly RuleLine[]): RuleLine[] {
  const merged: RuleLine[] = [];
  for (const line of lines) {
    const start = line.orientation === 'horizontal' ? line.x1 : line.y1;
    const end = line.orientation === 'horizontal' ? line.x2 : line.y2;
    const perpendicular = line.orientation === 'horizontal' ? line.y1 : line.x1;
    const existingIndex = merged.findIndex((candidate) => {
      if (candidate.orientation !== line.orientation || !colorsMatch(candidate.color, line.color)) return false;
      const candidateStart = candidate.orientation === 'horizontal' ? candidate.x1 : candidate.y1;
      const candidateEnd = candidate.orientation === 'horizontal' ? candidate.x2 : candidate.y2;
      const candidatePerpendicular = candidate.orientation === 'horizontal' ? candidate.y1 : candidate.x1;
      return (
        Math.abs(candidatePerpendicular - perpendicular) <= MERGE_TOLERANCE_PT &&
        start <= candidateEnd + MERGE_TOLERANCE_PT &&
        end >= candidateStart - MERGE_TOLERANCE_PT
      );
    });
    if (existingIndex < 0) {
      merged.push(line);
      continue;
    }
    const existing = merged[existingIndex];
    if (!existing) continue;
    if (line.orientation === 'horizontal') {
      merged[existingIndex] = {
        ...existing,
        x1: Math.min(existing.x1, line.x1),
        x2: Math.max(existing.x2, line.x2),
        y1: (existing.y1 + line.y1) / 2,
        y2: (existing.y2 + line.y2) / 2,
        thicknessPt: Math.max(existing.thicknessPt, line.thicknessPt),
      };
    } else {
      merged[existingIndex] = {
        ...existing,
        x1: (existing.x1 + line.x1) / 2,
        x2: (existing.x2 + line.x2) / 2,
        y1: Math.min(existing.y1, line.y1),
        y2: Math.max(existing.y2, line.y2),
        thicknessPt: Math.max(existing.thicknessPt, line.thicknessPt),
      };
    }
  }
  return merged;
}

function isTextUnderline(line: RuleLine, hints: readonly TextUnderlineHint[]): boolean {
  if (line.orientation !== 'horizontal') return false;
  const length = line.x2 - line.x1;
  return hints.some((hint) => {
    if (hint.width <= 0) return false;
    const verticalGap = hint.baselineY - line.y1;
    const maxVerticalGap = Math.max(6, hint.height * 0.4);
    const endpointTolerance = Math.max(10, length * 0.08);
    return (
      verticalGap >= -1 &&
      verticalGap <= maxVerticalGap &&
      Math.abs(line.x1 - hint.x) <= endpointTolerance &&
      Math.abs(line.x2 - (hint.x + hint.width)) <= endpointTolerance
    );
  });
}

/** Detect dominant-axis rules from a flattened PDF.js operator list. */
export function ruleLinesFromOperatorList(
  operatorList: RuleOperatorListLike,
  pageIndex: number,
  page: RulePageBox,
  textHints: readonly TextUnderlineHint[] = [],
): RuleLine[] {
  let state: GraphicsState = {
    ctm: IDENTITY,
    lineWidth: 1,
    stroke: BLACK,
    fill: BLACK,
  };
  const stack: GraphicsState[] = [];
  const candidates: RuleLine[] = [];
  let path: ParsedPath | undefined;

  const paint = (mode: 'fill' | 'stroke') => {
    const line = classifyPath(path, mode, state, pageIndex, page);
    if (line) candidates.push(line);
    path = undefined;
  };

  for (let index = 0; index < operatorList.fnArray.length; index += 1) {
    const operation = operatorList.fnArray[index];
    const args = operatorList.argsArray[index];
    if (operation === OPS.save) {
      stack.push(state);
    } else if (operation === OPS.restore) {
      state = stack.pop() ?? state;
    } else if (operation === OPS.transform) {
      const next = matrix(args);
      if (next) state = { ...state, ctm: multiply(state.ctm, next) };
    } else if (operation === OPS.paintFormXObjectBegin) {
      stack.push(state);
      const next = Array.isArray(args) ? matrix(args[0]) : undefined;
      if (next) state = { ...state, ctm: multiply(state.ctm, next) };
    } else if (operation === OPS.paintFormXObjectEnd) {
      state = stack.pop() ?? state;
    } else if (operation === OPS.setLineWidth) {
      const values = numericValues(args);
      if (values?.[0] !== undefined) state = { ...state, lineWidth: Math.abs(values[0]) };
    } else if (operation === OPS.setStrokeRGBColor) {
      state = { ...state, stroke: rgbColor(args) ?? state.stroke };
    } else if (operation === OPS.setFillRGBColor) {
      state = { ...state, fill: rgbColor(args) ?? state.fill };
    } else if (operation === OPS.setStrokeGray) {
      state = { ...state, stroke: grayColor(args) ?? state.stroke };
    } else if (operation === OPS.setFillGray) {
      state = { ...state, fill: grayColor(args) ?? state.fill };
    } else if (operation === OPS.setStrokeCMYKColor) {
      state = { ...state, stroke: cmykColor(args) ?? state.stroke };
    } else if (operation === OPS.setFillCMYKColor) {
      state = { ...state, fill: cmykColor(args) ?? state.fill };
    } else if (operation === OPS.constructPath) {
      path = parsePath(args, state.ctm);
    } else if (operation === OPS.stroke || operation === OPS.closeStroke) {
      paint('stroke');
    } else if (operation === OPS.fill || operation === OPS.eoFill) {
      paint('fill');
    } else if (
      operation === OPS.fillStroke ||
      operation === OPS.eoFillStroke ||
      operation === OPS.closeFillStroke ||
      operation === OPS.closeEOFillStroke
    ) {
      paint(path?.kind === 'rectangle' ? 'fill' : 'stroke');
    } else if (operation === OPS.endPath) {
      path = undefined;
    }
  }

  return mergeLines(candidates).filter((line) => {
    const length = line.orientation === 'horizontal'
      ? Math.abs(line.x2 - line.x1)
      : Math.abs(line.y2 - line.y1);
    return length >= MIN_RULE_LENGTH_PT && !isTextUnderline(line, textHints);
  });
}

export async function detectRuleLines(page: PDFPageProxy, pageIndex: number): Promise<RuleLine[]> {
  const [operatorList, textContent] = await Promise.all([
    page.getOperatorList(),
    page.getTextContent(),
  ]);
  const [x1 = 0, y1 = 0, x2 = 0, y2 = 0] = page.view;
  const textHints: TextUnderlineHint[] = textContent.items.flatMap((item) => {
    if (!('str' in item) || item.str.trim() === '') return [];
    return [{
      x: item.transform[4],
      baselineY: item.transform[5],
      width: item.width,
      height: item.height,
    }];
  });
  return ruleLinesFromOperatorList(
    operatorList,
    pageIndex,
    { x: x1, y: y1, width: x2 - x1, height: y2 - y1 },
    textHints,
  );
}
