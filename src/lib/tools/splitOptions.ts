export type SplitMode = 'custom' | 'every-page' | 'every-n';

export interface SplitOptionsValue {
  [key: string]: unknown;
  mode: SplitMode;
  ranges: string;
  everyN: number;
  mergeRanges: boolean;
}

export const DEFAULT_SPLIT_OPTIONS: SplitOptionsValue = {
  mode: 'custom',
  ranges: '',
  everyN: 2,
  mergeRanges: false,
};
