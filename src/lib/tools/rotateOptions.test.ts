import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ROTATE_OPTIONS,
  describeTurns,
  nextRotation,
  parseRotateOptions,
  rotationDelta,
  turnLeft,
  turnRight,
} from './rotateOptions';

describe('Rotate PDF option parsing', () => {
  it.each([
    [0, 90, 90],
    [270, 90, 0],
    [90, 270, 0],
    [180, 180, 0],
    [-90, 90, 0],
    [95, 90, 180],
  ])('normalises %d plus %d to %d', (current, delta, expected) => {
    expect(nextRotation(current, delta)).toBe(expected);
  });

  it.each([4, -1, '1', 1.5, undefined])('rejects unsupported turns value %s', (turns) => {
    expect(parseRotateOptions({ turns }).turns).toBe(0);
  });

  it('keeps valid values and otherwise falls back to defaults', () => {
    expect(parseRotateOptions({ turns: 3, pageSelection: 'custom', ranges: '2-3' }))
      .toEqual({ turns: 3, pageSelection: 'custom', ranges: '2-3' });
    expect(parseRotateOptions({ pageSelection: 'some', ranges: 7 })).toEqual(DEFAULT_ROTATE_OPTIONS);
  });

  it('turns left and right with wrap-around', () => {
    expect(turnLeft(0)).toBe(3);
    expect(turnLeft(1)).toBe(0);
    expect(turnRight(2)).toBe(3);
    expect(turnRight(3)).toBe(0);
  });

  it('maps turns to clockwise rotation deltas and labels', () => {
    expect([0, 1, 2, 3].map((turns) => rotationDelta(turns as 0 | 1 | 2 | 3)))
      .toEqual([0, 90, 180, 270]);
    expect([0, 1, 2, 3].map((turns) => describeTurns(turns as 0 | 1 | 2 | 3))).toEqual([
      'Not turned yet', 'Turned 90° right', 'Turned 180°', 'Turned 90° left',
    ]);
  });
});
