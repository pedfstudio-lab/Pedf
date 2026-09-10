import type { ToolOptions } from './types';

export type Turns = 0 | 1 | 2 | 3;
export type RotatePageSelection = 'all' | 'custom';

export interface RotateOptionsValue {
  [key: string]: unknown;
  turns: Turns;
  pageSelection: RotatePageSelection;
  ranges: string;
}

export const DEFAULT_ROTATE_OPTIONS: RotateOptionsValue = {
  turns: 0,
  pageSelection: 'all',
  ranges: '',
};

export function parseRotateOptions(options: ToolOptions): RotateOptionsValue {
  return {
    turns: Number.isInteger(options.turns) && Number(options.turns) >= 0 && Number(options.turns) <= 3
      ? options.turns as Turns
      : 0,
    pageSelection: options.pageSelection === 'custom' ? 'custom' : 'all',
    ranges: typeof options.ranges === 'string' ? options.ranges : '',
  };
}

export function turnLeft(turns: Turns): Turns {
  return (turns + 3) % 4 as Turns;
}

export function turnRight(turns: Turns): Turns {
  return (turns + 1) % 4 as Turns;
}

export function rotationDelta(turns: Turns): number {
  return turns * 90;
}

export function describeTurns(turns: Turns): string {
  return ['Not turned yet', 'Turned 90° right', 'Turned 180°', 'Turned 90° left'][turns]!;
}

export function nextRotation(current: number, delta: number): number {
  return (((Math.round(current / 90) * 90 + delta) % 360) + 360) % 360;
}
