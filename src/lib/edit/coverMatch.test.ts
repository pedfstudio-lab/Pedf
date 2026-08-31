import { describe, expect, it } from 'vitest';
import { coversOriginalRect } from './coverMatch';

describe('coversOriginalRect', () => {
  const original = { x: 20, y: 40, w: 120, h: 16 };

  it('recognizes a Task 44 cover whose top was trimmed to the source ink', () => {
    expect(coversOriginalRect(
      { x: 20, y: 37, w: 120, h: 12 },
      original,
    )).toBe(true);
  });

  it('does not associate a non-overlapping lower cover with the source line', () => {
    expect(coversOriginalRect(
      { x: 20, y: 20, w: 120, h: 20 },
      original,
    )).toBe(false);
  });

  it('still recognizes the legacy below-expanded cover shape', () => {
    expect(coversOriginalRect(
      { x: 20, y: 37, w: 120, h: 19 },
      original,
    )).toBe(true);
  });
});
