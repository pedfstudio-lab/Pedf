import type { TextSpan, TextStyle } from '@/lib/export/types';

export interface TextEditSessionValue {
  readonly text: string;
  readonly style: TextStyle;
  readonly spans?: readonly TextSpan[];
  readonly width: number;
  readonly height: number;
  readonly dx: number;
  readonly dy: number;
}

const HEIGHT_EPSILON_PT = 0.5;

function normalizeText(text: string): string {
  return text.replace(/\r\n?/g, '\n');
}

export function sameStyle(left: TextStyle, right: TextStyle): boolean {
  return (
    left.fontName === right.fontName &&
    left.fontSizePt === right.fontSizePt &&
    left.bold === right.bold &&
    left.italic === right.italic &&
    left.color.r === right.color.r &&
    left.color.g === right.color.g &&
    left.color.b === right.color.b
  );
}

export function sameSpans(
  left?: readonly TextSpan[],
  right?: readonly TextSpan[],
): boolean {
  if (!left || !right) return left === right;
  return left.length === right.length && left.every((span, index) => {
    const other = right[index];
    return Boolean(
      other &&
      span.text === other.text &&
      span.bold === other.bold &&
      span.italic === other.italic
    );
  });
}

export function sameTextEditSession(
  initial: TextEditSessionValue,
  current: TextEditSessionValue,
): boolean {
  return (
    normalizeText(initial.text) === normalizeText(current.text) &&
    sameStyle(initial.style, current.style) &&
    sameSpans(initial.spans, current.spans) &&
    initial.width === current.width &&
    Math.abs(initial.height - current.height) <= HEIGHT_EPSILON_PT &&
    current.dx === 0 &&
    current.dy === 0
  );
}

export function finishTextEdit<T extends TextEditSessionValue>(
  initial: TextEditSessionValue,
  current: T,
  onDone: (next: T) => void,
  onCancel: () => void,
): 'cancelled' | 'committed' {
  if (sameTextEditSession(initial, current)) {
    onCancel();
    return 'cancelled';
  }
  onDone(current);
  return 'committed';
}

export interface InitialEditorWidthOptions {
  readonly blockWidthPt: number;
  readonly blockXPt: number;
  readonly existingWidthPt?: number;
  readonly fontSizePt: number;
  readonly measuredLineWidthPt: number;
  readonly pageWidthPt: number;
  readonly marginPt?: number;
}

/** Keep original lines intact when the standard replacement font is slightly wider. */
export function calculateInitialEditorWidth(options: InitialEditorWidthOptions): number {
  const pad = options.fontSizePt * 0.15;
  const margin = options.marginPt ?? Math.max(2, options.fontSizePt * 0.25);
  const pageBound = Math.max(
    options.blockWidthPt,
    options.pageWidthPt - options.blockXPt - margin,
  );
  const desired = Math.max(
    options.blockWidthPt,
    options.existingWidthPt ?? 0,
    options.measuredLineWidthPt + pad,
  );
  return Math.min(desired, pageBound);
}
