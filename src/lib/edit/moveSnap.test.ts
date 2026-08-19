import { describe, expect, it } from 'vitest';
import { SNAP_THRESHOLD_PX, snapAxis } from './moveSnap';

describe('snapAxis', () => {
  it('returns the exact delta and label when an edge is within the threshold', () => {
    expect(snapAxis(47, 67, 87, [
      { pos: 50, edge: 'min', label: 'left column' },
    ], SNAP_THRESHOLD_PX)).toEqual({
      delta: 3,
      guide: { pos: 50, label: 'left column' },
    });
  });

  it('chooses the nearest of several competing targets', () => {
    expect(snapAxis(47, 67, 87, [
      { pos: 43, edge: 'min', label: 'farther' },
      { pos: 49, edge: 'min', label: 'nearest' },
      { pos: 52, edge: 'min', label: 'also farther' },
    ], SNAP_THRESHOLD_PX)).toEqual({
      delta: 2,
      guide: { pos: 49, label: 'nearest' },
    });
  });

  it('returns null when no target is within the threshold', () => {
    expect(snapAxis(10, 20, 30, [
      { pos: 40, edge: 'max', label: 'right margin' },
    ], SNAP_THRESHOLD_PX)).toBeNull();
  });

  it('snaps midpoint and maximum edges as well as the minimum edge', () => {
    expect(snapAxis(10, 24, 38, [
      { pos: 25, edge: 'mid', label: 'page center' },
    ], SNAP_THRESHOLD_PX)).toEqual({
      delta: 1,
      guide: { pos: 25, label: 'page center' },
    });

    expect(snapAxis(10, 24, 38, [
      { pos: 40, edge: 'max', label: 'right margin' },
    ], SNAP_THRESHOLD_PX)).toEqual({
      delta: 2,
      guide: { pos: 40, label: 'right margin' },
    });
  });
});
