import pixelmatch from 'pixelmatch';

export interface DiffResult {
  readonly ratio: number;
  readonly diff: ImageData;
}

export function diffImageData(expected: ImageData, actual: ImageData): DiffResult {
  if (expected.width !== actual.width || expected.height !== actual.height) {
    return { ratio: 1, diff: expected };
  }

  const { width, height } = expected;
  const diff = new ImageData(width, height);
  const mismatched = pixelmatch(expected.data, actual.data, diff.data, width, height, {
    threshold: 0.1,
  });

  return {
    ratio: mismatched / (width * height),
    diff,
  };
}
