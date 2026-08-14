import { describe, expect, it } from 'vitest';
import { stripPageMarkers } from './stripPageMarkers';

describe('stripPageMarkers', () => {
  it.each([
    ['The plan is: [Page 3] Kick things off', 'The plan is: Kick things off'],
    ['[Page 5] Additionally, after breakfast', 'Additionally, after breakfast'],
    ['[Page 3] and [Page 5] both', 'and both'],
    ['no markers here', 'no markers here'],
  ])('turns %j into %j', (text, expected) => {
    expect(stripPageMarkers(text)).toBe(expected);
  });

  it('handles plural, ranges, lists, and case-insensitive markers', () => {
    expect(stripPageMarkers('[Pages 3-5] See this [PAGE 3, 5] section.')).toBe('See this section.');
  });
});
