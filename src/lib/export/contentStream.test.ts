import { describe, expect, it } from 'vitest';
import {
  decodedStringBytes,
  rewriteTextShowOperator,
  serializeContentStream,
  textShowOperators,
  tokenizeContentStream,
} from './contentStream';

const encoder = new TextEncoder();
const decoder = new TextDecoder('latin1');

describe('PDF content stream tokenizer', () => {
  it('round-trips strings, hex, arrays, dictionaries, comments and inline images byte-for-byte', () => {
    const source = encoder.encode(
      'q\r\n% keep me\n/GS1 gs << /Key (a\\(b\\)c) /Hex <41 4f 5> >> ' +
      '[(one) -12 <74776f>] TJ\nBI /W 1 /H 1 /BPC 8 ID \u0000EI\u00ff \nEI\nQ',
    );
    const tokens = tokenizeContentStream(source);

    expect(serializeContentStream(tokens)).toEqual(source);
    expect(tokens.filter((token) => token.kind === 'inlineImage')).toHaveLength(1);
  });

  it('decodes literal escapes, octal bytes, line continuations and odd hex nibbles', () => {
    const literal = tokenizeContentStream(encoder.encode('(A\\n\\101\\\r\nB\\(C\\))'))[0];
    const hex = tokenizeContentStream(encoder.encode('<4142F>'))[0];
    expect(decoder.decode(decodedStringBytes(literal!))).toBe('A\nAB(C)');
    expect([...decodedStringBytes(hex!)]).toEqual([0x41, 0x42, 0xf0]);
  });

  it('finds every text-showing operator and its glyph strings in order', () => {
    const tokens = tokenizeContentStream(encoder.encode(
      '(one) Tj (two) \' 10 2 (three) " [(four) -20 <66697665>] TJ',
    ));
    const operators = textShowOperators(tokens);

    expect(operators.map(({ operator }) => operator)).toEqual(['Tj', "'", '"', 'TJ']);
    expect(operators.map(({ stringTokenIndexes }) => stringTokenIndexes.length)).toEqual([1, 1, 1, 2]);
  });
});

describe('text-show rewriting', () => {
  it('replaces removed glyphs with TJ advances so following text does not shift', () => {
    const tokens = tokenizeContentStream(encoder.encode('(ABCDE) Tj (NEXT) Tj'));
    const [first] = textShowOperators(tokens);
    const rewritten = rewriteTextShowOperator(
      tokens,
      first!,
      [
        { start: 0, end: 1 }, { start: 1, end: 2 }, { start: 2, end: 3 },
        { start: 3, end: 4 }, { start: 4, end: 5 },
      ],
      [{ start: 1, end: 4 }],
      [600, 610, 620, 630, 640],
    );
    const text = decoder.decode(serializeContentStream(rewritten));

    expect(text).toBe('[<41> -1860 <45>] TJ (NEXT) Tj');
    expect(textShowOperators(rewritten)).toHaveLength(2);
  });

  it('preserves quote movement and spacing semantics while removing text', () => {
    const single = tokenizeContentStream(encoder.encode('(AB) \' 2 3 (CD) "'));
    const [first, second] = textShowOperators(single);
    const one = rewriteTextShowOperator(
      single, first!, [{ start: 0, end: 1 }, { start: 1, end: 2 }],
      [{ start: 0, end: 2 }], [500, 500],
    );
    expect(decoder.decode(serializeContentStream(one))).toContain('T* [-1000] TJ');

    const refreshed = textShowOperators(one);
    const two = rewriteTextShowOperator(
      one, refreshed.at(-1)!, [{ start: 0, end: 1 }, { start: 1, end: 2 }],
      [{ start: 0, end: 2 }], [500, 500],
    );
    expect(decoder.decode(serializeContentStream(two))).toContain('2 Tw 3 Tc T* [-1000] TJ');
    expect(second?.operator).toBe('"');
  });

  it('keeps original TJ kerning adjustments around rewritten glyphs', () => {
    const tokens = tokenizeContentStream(encoder.encode('[(AB) -35 (CD) 12 (E)] TJ'));
    const [operator] = textShowOperators(tokens);
    const rewritten = rewriteTextShowOperator(
      tokens,
      operator!,
      [
        { start: 0, end: 1 }, { start: 1, end: 2 }, { start: 2, end: 3 },
        { start: 3, end: 4 }, { start: 4, end: 5 },
      ],
      [{ start: 2, end: 3 }],
      [500, 500, 500, 500, 500],
    );

    expect(decoder.decode(serializeContentStream(rewritten)))
      .toBe('[<4142> -35 -500 <44> 12 <45>] TJ');
  });
});
