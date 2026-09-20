export type ContentTokenKind =
  | 'whitespace'
  | 'comment'
  | 'number'
  | 'name'
  | 'literalString'
  | 'hexString'
  | 'arrayStart'
  | 'arrayEnd'
  | 'dictStart'
  | 'dictEnd'
  | 'word'
  | 'inlineImage';

export interface ContentToken {
  readonly kind: ContentTokenKind;
  readonly raw: Uint8Array;
  readonly value?: string | number;
}

export interface TextShowOperator {
  readonly ordinal: number;
  readonly operator: 'Tj' | 'TJ' | "'" | '"';
  readonly operatorTokenIndex: number;
  readonly operandStartTokenIndex: number;
  readonly stringTokenIndexes: readonly number[];
}

export interface GlyphRange {
  /** Inclusive glyph index. */
  readonly start: number;
  /** Exclusive glyph index. */
  readonly end: number;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder('latin1');

function isWhitespace(byte: number): boolean {
  return byte === 0 || byte === 9 || byte === 10 || byte === 12 || byte === 13 || byte === 32;
}

function isDelimiter(byte: number): boolean {
  return isWhitespace(byte) || [40, 41, 60, 62, 91, 93, 123, 125, 47, 37].includes(byte);
}

function bytes(source: Uint8Array, start: number, end: number): Uint8Array {
  return source.slice(start, end);
}

function wordValue(raw: Uint8Array): string {
  return decoder.decode(raw);
}

function isNumberWord(value: string): boolean {
  return /^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(value);
}

function inlineImageEnd(source: Uint8Array, afterBi: number): number | null {
  let index = afterBi;
  let sawId = false;
  while (index < source.length) {
    while (index < source.length && isWhitespace(source[index] ?? 0)) index += 1;
    if (index >= source.length) return null;
    const start = index;
    while (index < source.length && !isDelimiter(source[index] ?? 0)) index += 1;
    const word = decoder.decode(source.subarray(start, index));
    if (word === 'ID') {
      sawId = true;
      if (isWhitespace(source[index] ?? -1)) index += 1;
      break;
    }
    if (index === start) index += 1;
  }
  if (!sawId) return null;

  // Inline-image data is opaque. PDF requires EI to be separated by
  // whitespace; requiring a delimiter after it avoids most false positives in
  // binary image bytes while keeping the original sequence byte-for-byte.
  for (let cursor = index; cursor + 1 < source.length; cursor += 1) {
    if (source[cursor] !== 69 || source[cursor + 1] !== 73) continue;
    const before = cursor === index || isWhitespace(source[cursor - 1] ?? -1);
    const after = cursor + 2 >= source.length || isDelimiter(source[cursor + 2] ?? -1);
    if (before && after) return cursor + 2;
  }
  return null;
}

/** Tokenize a decoded PDF content stream without discarding a single byte. */
export function tokenizeContentStream(source: Uint8Array): ContentToken[] {
  const tokens: ContentToken[] = [];
  let index = 0;
  while (index < source.length) {
    const start = index;
    const byte = source[index] ?? 0;
    if (isWhitespace(byte)) {
      while (index < source.length && isWhitespace(source[index] ?? 0)) index += 1;
      tokens.push({ kind: 'whitespace', raw: bytes(source, start, index) });
      continue;
    }
    if (byte === 37) {
      index += 1;
      while (index < source.length && source[index] !== 10 && source[index] !== 13) index += 1;
      tokens.push({ kind: 'comment', raw: bytes(source, start, index) });
      continue;
    }
    if (byte === 40) {
      index += 1;
      let depth = 1;
      while (index < source.length && depth > 0) {
        const next = source[index] ?? 0;
        if (next === 92) {
          index += 1;
          if (source[index] === 13 && source[index + 1] === 10) index += 2;
          else if (index < source.length) index += 1;
        } else {
          if (next === 40) depth += 1;
          else if (next === 41) depth -= 1;
          index += 1;
        }
      }
      if (depth !== 0) throw new Error('Unterminated PDF literal string');
      tokens.push({ kind: 'literalString', raw: bytes(source, start, index) });
      continue;
    }
    if (byte === 60 && source[index + 1] === 60) {
      index += 2;
      tokens.push({ kind: 'dictStart', raw: bytes(source, start, index) });
      continue;
    }
    if (byte === 62 && source[index + 1] === 62) {
      index += 2;
      tokens.push({ kind: 'dictEnd', raw: bytes(source, start, index) });
      continue;
    }
    if (byte === 60) {
      index += 1;
      while (index < source.length && source[index] !== 62) index += 1;
      if (index >= source.length) throw new Error('Unterminated PDF hex string');
      index += 1;
      tokens.push({ kind: 'hexString', raw: bytes(source, start, index) });
      continue;
    }
    if (byte === 91 || byte === 93) {
      index += 1;
      tokens.push({
        kind: byte === 91 ? 'arrayStart' : 'arrayEnd',
        raw: bytes(source, start, index),
      });
      continue;
    }
    if (byte === 47) {
      index += 1;
      while (index < source.length && !isDelimiter(source[index] ?? 0)) index += 1;
      tokens.push({ kind: 'name', raw: bytes(source, start, index) });
      continue;
    }
    if ([41, 62, 123, 125].includes(byte)) {
      throw new Error(`Unexpected PDF delimiter at byte ${index}`);
    }

    while (index < source.length && !isDelimiter(source[index] ?? 0)) index += 1;
    if (index === start) throw new Error(`Unsupported PDF token at byte ${index}`);
    const raw = bytes(source, start, index);
    const value = wordValue(raw);
    if (value === 'BI') {
      const end = inlineImageEnd(source, index);
      if (end === null) throw new Error('Unterminated PDF inline image');
      index = end;
      tokens.push({ kind: 'inlineImage', raw: bytes(source, start, index) });
    } else if (isNumberWord(value)) {
      tokens.push({ kind: 'number', raw, value: Number(value) });
    } else {
      tokens.push({ kind: 'word', raw, value });
    }
  }
  return tokens;
}

export function serializeContentStream(tokens: readonly ContentToken[]): Uint8Array {
  const length = tokens.reduce((sum, token) => sum + token.raw.length, 0);
  const output = new Uint8Array(length);
  let offset = 0;
  for (const token of tokens) {
    output.set(token.raw, offset);
    offset += token.raw.length;
  }
  return output;
}

function significantIndexes(tokens: readonly ContentToken[]): number[] {
  return tokens.flatMap((token, index) => (
    token.kind === 'whitespace' || token.kind === 'comment' ? [] : [index]
  ));
}

function stringIndexesInArray(
  tokens: readonly ContentToken[],
  indexes: readonly number[],
  arrayPosition: number,
): number[] | null {
  if (tokens[indexes[arrayPosition] ?? -1]?.kind !== 'arrayStart') return null;
  const strings: number[] = [];
  let depth = 0;
  for (let position = arrayPosition; position < indexes.length; position += 1) {
    const tokenIndex = indexes[position] ?? -1;
    const token = tokens[tokenIndex];
    if (!token) return null;
    if (token.kind === 'arrayStart') depth += 1;
    else if (token.kind === 'arrayEnd') {
      depth -= 1;
      if (depth === 0) return strings;
    } else if (depth === 1 && (token.kind === 'literalString' || token.kind === 'hexString')) {
      strings.push(tokenIndex);
    }
  }
  return null;
}

/** Locate every top-level PDF text-showing operator in paint order. */
export function textShowOperators(tokens: readonly ContentToken[]): TextShowOperator[] {
  const indexes = significantIndexes(tokens);
  const operators: TextShowOperator[] = [];
  const operands: number[] = [];

  for (let position = 0; position < indexes.length; position += 1) {
    const tokenIndex = indexes[position] ?? -1;
    const token = tokens[tokenIndex];
    if (!token) continue;

    if (token.kind === 'arrayStart' || token.kind === 'dictStart') {
      const opening = token.kind;
      const closing = opening === 'arrayStart' ? 'arrayEnd' : 'dictEnd';
      let depth = 1;
      let end = position;
      while (++end < indexes.length && depth > 0) {
        const nested = tokens[indexes[end] ?? -1]?.kind;
        if (nested === opening) depth += 1;
        else if (nested === closing) depth -= 1;
      }
      if (depth !== 0) throw new Error('Unbalanced PDF content container');
      operands.push(position);
      position = end - 1;
      continue;
    }
    if (token.kind === 'arrayEnd' || token.kind === 'dictEnd') {
      throw new Error('Unexpected PDF content container close');
    }

    if (token.kind !== 'word') {
      operands.push(position);
      continue;
    }
    const operation = token.value;
    if (operation === 'Tj' || operation === "'" || operation === '"' || operation === 'TJ') {
      const lastOperandPosition = operands.at(-1);
      if (lastOperandPosition === undefined) throw new Error(`${operation} has no text operand`);
      const lastTokenIndex = indexes[lastOperandPosition] ?? -1;
      let stringTokenIndexes: number[] | null = null;
      if (operation === 'TJ') {
        stringTokenIndexes = stringIndexesInArray(tokens, indexes, lastOperandPosition);
      } else {
        const last = tokens[lastTokenIndex];
        stringTokenIndexes = last?.kind === 'literalString' || last?.kind === 'hexString'
          ? [lastTokenIndex]
          : null;
      }
      if (!stringTokenIndexes) throw new Error(`${operation} has an invalid text operand`);
      const operandStartPosition = operation === '"' ? operands.at(-3) : lastOperandPosition;
      if (operandStartPosition === undefined) throw new Error('" has incomplete spacing operands');
      operators.push({
        ordinal: operators.length,
        operator: operation,
        operatorTokenIndex: tokenIndex,
        operandStartTokenIndex: indexes[operandStartPosition] ?? lastTokenIndex,
        stringTokenIndexes,
      });
    }
    operands.length = 0;
  }
  return operators;
}

export function decodedStringBytes(token: ContentToken): Uint8Array {
  if (token.kind === 'hexString') {
    const digits = decoder.decode(token.raw.subarray(1, token.raw.length - 1)).replace(/\s/g, '');
    if (!/^[0-9a-f]*$/i.test(digits)) throw new Error('Invalid PDF hex string');
    const padded = digits.length % 2 === 0 ? digits : `${digits}0`;
    return Uint8Array.from({ length: padded.length / 2 }, (_, index) => (
      Number.parseInt(padded.slice(index * 2, index * 2 + 2), 16)
    ));
  }
  if (token.kind !== 'literalString') throw new Error('Token is not a PDF string');
  const output: number[] = [];
  for (let index = 1; index < token.raw.length - 1; index += 1) {
    const byte = token.raw[index] ?? 0;
    if (byte !== 92) {
      output.push(byte);
      continue;
    }
    const next = token.raw[++index];
    if (next === undefined) break;
    const escapes: Record<number, number> = { 110: 10, 114: 13, 116: 9, 98: 8, 102: 12 };
    if (next in escapes) output.push(escapes[next] ?? next);
    else if (next === 13) {
      if (token.raw[index + 1] === 10) index += 1;
    } else if (next === 10) {
      // A backslash-newline pair is a continuation and contributes no byte.
    } else if (next >= 48 && next <= 55) {
      let octal = String.fromCharCode(next);
      for (let count = 1; count < 3; count += 1) {
        const digit = token.raw[index + 1];
        if (digit === undefined || digit < 48 || digit > 55) break;
        octal += String.fromCharCode(digit);
        index += 1;
      }
      output.push(Number.parseInt(octal, 8) & 0xff);
    } else output.push(next);
  }
  return Uint8Array.from(output);
}

function hexString(value: Uint8Array): string {
  return `<${[...value].map((byte) => byte.toString(16).padStart(2, '0')).join('').toUpperCase()}>`;
}

function normalizedRanges(ranges: readonly GlyphRange[], glyphCount: number): GlyphRange[] {
  const sorted = ranges
    .map(({ start, end }) => ({ start: Math.max(0, start), end: Math.min(glyphCount, end) }))
    .filter(({ start, end }) => start < end)
    .sort((left, right) => left.start - right.start);
  const merged: GlyphRange[] = [];
  for (const range of sorted) {
    const previous = merged.at(-1);
    if (previous && range.start <= previous.end) {
      merged[merged.length - 1] = { start: previous.start, end: Math.max(previous.end, range.end) };
    } else merged.push(range);
  }
  return merged;
}

function originalAdjustments(
  tokens: readonly ContentToken[],
  target: TextShowOperator,
  glyphByteRanges: readonly GlyphRange[],
): Map<number, string[]> {
  const adjustments = new Map<number, string[]>();
  if (target.operator !== 'TJ') return adjustments;
  const significant = significantIndexes(tokens);
  const start = significant.indexOf(target.operandStartTokenIndex);
  if (start < 0 || tokens[target.operandStartTokenIndex]?.kind !== 'arrayStart') {
    throw new Error('TJ array start is missing');
  }
  let consumedBytes = 0;
  for (let position = start + 1; position < significant.length; position += 1) {
    const token = tokens[significant[position] ?? -1];
    if (!token) throw new Error('TJ array token is missing');
    if (token.kind === 'arrayEnd') break;
    if (token.kind === 'literalString' || token.kind === 'hexString') {
      consumedBytes += decodedStringBytes(token).length;
      continue;
    }
    if (token.kind !== 'number') throw new Error('TJ array has a non-number, non-string entry');
    const boundary = consumedBytes === 0
      ? 0
      : glyphByteRanges.findIndex(({ end }) => end === consumedBytes) + 1;
    if (boundary < 0 || (boundary === 0 && consumedBytes !== 0)) {
      throw new Error('TJ adjustment does not fall on a glyph boundary');
    }
    const list = adjustments.get(boundary) ?? [];
    list.push(decoder.decode(token.raw));
    adjustments.set(boundary, list);
  }
  return adjustments;
}

/**
 * Rewrite one text-show operation as a TJ sequence. Removed glyph advances are
 * inserted as negative TJ numbers so all following text keeps its position.
 */
export function rewriteTextShowOperator(
  tokens: readonly ContentToken[],
  target: TextShowOperator,
  glyphByteRanges: readonly GlyphRange[],
  removedRanges: readonly GlyphRange[],
  advanceThousandths: readonly number[],
): ContentToken[] {
  if (glyphByteRanges.length !== advanceThousandths.length) {
    throw new Error('Glyph bytes and advances do not have the same length');
  }
  const sourceBytes = target.stringTokenIndexes.flatMap((tokenIndex) => (
    [...decodedStringBytes(tokens[tokenIndex] as ContentToken)]
  ));
  const ranges = normalizedRanges(removedRanges, glyphByteRanges.length);
  if (ranges.length === 0) return [...tokens];
  if (
    glyphByteRanges.length === 0 ||
    glyphByteRanges[0]?.start !== 0 ||
    glyphByteRanges.at(-1)?.end !== sourceBytes.length ||
    glyphByteRanges.some((range, index) => index > 0 && range.start !== glyphByteRanges[index - 1]?.end)
  ) throw new Error('Glyph byte ranges do not cover the source string exactly');
  const adjustments = originalAdjustments(tokens, target, glyphByteRanges);
  const removed = Array.from({ length: glyphByteRanges.length }, () => false);
  for (const range of ranges) {
    for (let index = range.start; index < range.end; index += 1) removed[index] = true;
  }
  const pieces: string[] = [];
  let kept: number[] = [];
  const flushKept = () => {
    if (kept.length > 0) pieces.push(hexString(Uint8Array.from(kept)));
    kept = [];
  };
  let removedAdvance = 0;
  const flushRemoved = () => {
    if (removedAdvance !== 0) pieces.push(String(-removedAdvance));
    removedAdvance = 0;
  };
  for (let glyphIndex = 0; glyphIndex < glyphByteRanges.length; glyphIndex += 1) {
    const before = adjustments.get(glyphIndex) ?? [];
    if (before.length > 0) {
      flushKept();
      flushRemoved();
      pieces.push(...before);
    }
    const range = glyphByteRanges[glyphIndex];
    if (!range) continue;
    if (removed[glyphIndex]) {
      flushKept();
      removedAdvance += advanceThousandths[glyphIndex] ?? 0;
    } else {
      flushRemoved();
      kept.push(...sourceBytes.slice(range.start, range.end));
    }
  }
  flushKept();
  flushRemoved();
  pieces.push(...(adjustments.get(glyphByteRanges.length) ?? []));
  if (pieces.length === 0) pieces.push('<>');
  const tj = `[${pieces.join(' ')}] TJ`;

  let replacement = tj;
  if (target.operator === "'") replacement = `T* ${tj}`;
  else if (target.operator === '"') {
    const prefix = serializeContentStream(tokens.slice(
      target.operandStartTokenIndex,
      target.stringTokenIndexes[0],
    ));
    const significant = tokenizeContentStream(prefix)
      .filter((token) => token.kind !== 'whitespace' && token.kind !== 'comment');
    if (significant.length < 2) throw new Error('" has incomplete spacing operands');
    replacement = `${decoder.decode(significant[0]?.raw)} Tw ${decoder.decode(significant[1]?.raw)} Tc T* ${tj}`;
  }

  const start = target.operandStartTokenIndex;
  const end = target.operatorTokenIndex;
  return tokenizeContentStream(serializeContentStream([
    ...tokens.slice(0, start),
    { kind: 'word', raw: encoder.encode(replacement), value: replacement },
    ...tokens.slice(end + 1),
  ]));
}
