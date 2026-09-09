import { describe, expect, it } from 'vitest';
import {
  EMPTY_PAGE_RANGE_ERROR,
  PAGE_RANGE_FORMAT_ERROR,
  REVERSED_PAGE_RANGE_ERROR,
  describePageIndices,
  parsePageRanges,
} from './pageRanges';

describe('parsePageRanges', () => {
  it.each([
    ['1', 10, [[0]]],
    ['1-3', 10, [[0, 1, 2]]],
    ['1-3,5,8-10', 10, [[0, 1, 2], [4], [7, 8, 9]]],
    [' 1 - 3 , 5 ', 5, [[0, 1, 2], [4]]],
    ['2–4', 4, [[1, 2, 3]]],
    ['3,3', 3, [[2], [2]]],
  ] as const)('parses %j into zero-based groups', (text, count, expected) => {
    expect(parsePageRanges(text, count)).toEqual(expected);
  });

  it.each([
    ['', 10, EMPTY_PAGE_RANGE_ERROR],
    ['   ', 10, EMPTY_PAGE_RANGE_ERROR],
    ['1-3,', 10, PAGE_RANGE_FORMAT_ERROR],
    ['one', 10, PAGE_RANGE_FORMAT_ERROR],
    ['1--3', 10, PAGE_RANGE_FORMAT_ERROR],
    ['0', 10, 'Page numbers must be between 1 and 10.'],
    ['11', 10, 'Page numbers must be between 1 and 10.'],
    ['2-11', 10, 'Page numbers must be between 1 and 10.'],
    ['5-2', 10, REVERSED_PAGE_RANGE_ERROR],
  ] as const)('rejects %j with a specific message', (text, count, message) => {
    expect(() => parsePageRanges(text, count)).toThrow(message);
  });

  it('rejects an impossible page count', () => {
    expect(() => parsePageRanges('1', 0)).toThrow('This PDF has no pages.');
  });
});

describe('describePageIndices', () => {
  it('uses one-based labels for filenames', () => {
    expect(describePageIndices([0])).toBe('1');
    expect(describePageIndices([7, 8, 9])).toBe('8-10');
  });
});
