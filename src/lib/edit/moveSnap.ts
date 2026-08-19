export interface SnapTarget {
  readonly pos: number;
  readonly edge: 'min' | 'mid' | 'max';
  readonly label: string;
}

export interface SnapGuide {
  readonly pos: number;
  readonly label: string;
}

export interface AxisSnap {
  readonly delta: number;
  readonly guide: SnapGuide;
}

export interface MoveGuideState {
  readonly crosshair: {
    readonly x: number;
    readonly y: number;
  };
  readonly vertical?: SnapGuide;
  readonly horizontal?: SnapGuide;
}

export const SNAP_THRESHOLD_PX = 6;

/** Finds the nearest target for the corresponding min, midpoint, or max box edge. */
export function snapAxis(
  min: number,
  mid: number,
  max: number,
  targets: readonly SnapTarget[],
  threshold: number,
): AxisSnap | null {
  let best: (AxisSnap & { readonly distance: number }) | null = null;

  for (const target of targets) {
    const edge = target.edge === 'min' ? min : target.edge === 'max' ? max : mid;
    const delta = target.pos - edge;
    const distance = Math.abs(delta);
    if (distance <= threshold && (!best || distance < best.distance)) {
      best = {
        distance,
        delta,
        guide: { pos: target.pos, label: target.label },
      };
    }
  }

  return best ? { delta: best.delta, guide: best.guide } : null;
}
