import type { TextAlignment, TextSpan, TextStyle } from '@/lib/export/types';

export interface TextEditSessionValue {
  readonly text: string;
  readonly style: TextStyle;
  readonly spans?: readonly TextSpan[];
  readonly width: number;
  readonly height: number;
  readonly dx: number;
  readonly dy: number;
  readonly align?: TextAlignment;
  readonly alignLeftPt?: number;
  readonly alignWidthPt?: number;
}

/** Upward screen movement increases the PDF-point room available below a bullet list. */
export function calculateBulletRoomPt(
  maxHeightPt: number,
  moveOffsetYPx: number,
  zoom: number,
): number {
  return maxHeightPt - moveOffsetYPx / zoom;
}

function normalizeText(text: string): string {
  return text.replace(/\r\n?/g, '\n').replace(/\n$/, '');
}

export function sameStyle(left: TextStyle, right: TextStyle): boolean {
  return (
    left.fontName === right.fontName &&
    left.fontRef === right.fontRef &&
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
  const normalize = (spans: readonly TextSpan[]): TextSpan[] => {
    const result = spans.map((span) => ({
      ...span,
      text: span.text.replace(/\r\n?/g, '\n'),
    }));
    let last = result.length - 1;
    while (last >= 0 && result[last]!.text.length === 0) last -= 1;
    if (last >= 0 && result[last]!.text.endsWith('\n')) {
      result[last] = { ...result[last]!, text: result[last]!.text.slice(0, -1) };
    }
    return result.filter((span) => span.text.length > 0);
  };
  const normalizedLeft = normalize(left);
  const normalizedRight = normalize(right);
  return normalizedLeft.length === normalizedRight.length && normalizedLeft.every((span, index) => {
    const other = normalizedRight[index];
    return Boolean(
      other &&
      span.text === other.text &&
      span.bold === other.bold &&
      span.italic === other.italic &&
      span.fontSizePt === other.fontSizePt &&
      span.fontName === other.fontName &&
      span.fontRef === other.fontRef
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
    initial.align === current.align &&
    initial.alignLeftPt === current.alignLeftPt &&
    initial.alignWidthPt === current.alignWidthPt &&
    initial.width === current.width &&
    initial.height === current.height &&
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
