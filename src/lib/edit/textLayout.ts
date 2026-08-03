export type MeasureText = (text: string) => number;

export interface FittedTextLayout {
  readonly fontSizePt: number;
  readonly lineHeightPt: number;
  readonly lines: readonly string[];
  readonly usedHeightPt: number;
}

export interface FitTextOptions {
  readonly text: string;
  readonly width: number;
  readonly height: number;
  readonly maxFontSizePt: number;
  readonly minFontSizePt?: number;
  measureAtSize(text: string, fontSizePt: number): number;
  lineHeightAtSize(fontSizePt: number): number;
}

function splitLongWord(word: string, maxWidth: number, measureText: MeasureText): string[] {
  const chunks: string[] = [];
  let chunk = '';
  for (const character of Array.from(word)) {
    const candidate = chunk + character;
    if (chunk && measureText(candidate) > maxWidth) {
      chunks.push(chunk);
      chunk = character;
    } else {
      chunk = candidate;
    }
  }
  if (chunk) chunks.push(chunk);
  return chunks;
}

function wrapLogicalLine(
  line: string,
  maxWidth: number,
  measureText: MeasureText,
): string[] {
  if (line === '') return [''];
  const output: string[] = [];
  const tokens = line.match(/\s+|\S+/g) ?? [];
  let current = '';

  for (const token of tokens) {
    const candidate = current + token;
    if (measureText(candidate) <= maxWidth) {
      current = candidate;
      continue;
    }

    if (current) {
      output.push(current);
      current = '';
    }
    if (measureText(token) <= maxWidth) {
      current = token;
      continue;
    }

    const chunks = splitLongWord(token, maxWidth, measureText);
    output.push(...chunks.slice(0, -1));
    current = chunks.at(-1) ?? '';
  }

  output.push(current);
  return output;
}

/** Greedy wrapping that preserves typed spaces, explicit newlines, and blank lines. */
export function wrapTextToLines(
  text: string,
  maxWidth: number,
  measureText: MeasureText,
): string[] {
  if (!Number.isFinite(maxWidth) || maxWidth <= 0) {
    throw new RangeError('maxWidth must be a positive finite number');
  }

  if (text === '') return [];
  return text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .flatMap((line) => wrapLogicalLine(line, maxWidth, measureText));
}

function layoutAtSize(options: FitTextOptions, fontSizePt: number): FittedTextLayout {
  const lines = wrapTextToLines(
    options.text,
    options.width,
    (text) => options.measureAtSize(text, fontSizePt),
  );
  const lineHeightPt = options.lineHeightAtSize(fontSizePt);
  const usedHeightPt = lines.length === 0
    ? 0
    : fontSizePt + (lines.length - 1) * lineHeightPt;
  return { fontSizePt, lineHeightPt, lines, usedHeightPt };
}

/** Find the largest font size whose wrapped glyphs stay inside the original block footprint. */
export function fitTextToBlock(options: FitTextOptions): FittedTextLayout {
  if (!Number.isFinite(options.width) || options.width <= 0) {
    throw new RangeError('width must be a positive finite number');
  }
  if (!Number.isFinite(options.height) || options.height <= 0) {
    throw new RangeError('height must be a positive finite number');
  }
  const maxSize = Math.max(0.1, options.maxFontSizePt);
  const minSize = Math.min(maxSize, Math.max(0.1, options.minFontSizePt ?? 4));
  const fits = (layout: FittedTextLayout) => layout.usedHeightPt <= options.height + 0.001;
  const maximum = layoutAtSize(options, maxSize);
  if (fits(maximum)) return maximum;

  let low = minSize;
  let high = maxSize;
  let best = layoutAtSize(options, minSize);
  for (let iteration = 0; iteration < 18; iteration += 1) {
    const middle = (low + high) / 2;
    const layout = layoutAtSize(options, middle);
    if (fits(layout)) {
      best = layout;
      low = middle;
    } else {
      high = middle;
    }
  }
  return best;
}
