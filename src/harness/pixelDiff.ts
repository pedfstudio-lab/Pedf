import pixelmatch from 'pixelmatch';

export interface DiffResult {
  readonly ratio: number;
  readonly diff: ImageData;
}

export interface WorstBlockDiff {
  readonly meanError: number;
  readonly changedPercent: number;
}

/** Report the most damaged local block instead of letting a whole-page average hide small defects. */
export function worstBlockDiff(before: ImageData, after: ImageData, blockPx = 100): WorstBlockDiff {
  if (before.width !== after.width || before.height !== after.height) {
    return { meanError: 255, changedPercent: 100 };
  }
  const blockSize = Number.isFinite(blockPx) ? Math.max(1, Math.floor(blockPx)) : 100;
  let worst: WorstBlockDiff = { meanError: 0, changedPercent: 0 };
  for (let top = 0; top < before.height; top += blockSize) {
    for (let left = 0; left < before.width; left += blockSize) {
      const right = Math.min(before.width, left + blockSize);
      const bottom = Math.min(before.height, top + blockSize);
      let error = 0;
      let changed = 0;
      let pixels = 0;
      for (let y = top; y < bottom; y++) {
        for (let x = left; x < right; x++) {
          const offset = (y * before.width + x) * 4;
          const red = Math.abs((before.data[offset] ?? 0) - (after.data[offset] ?? 0));
          const green = Math.abs((before.data[offset + 1] ?? 0) - (after.data[offset + 1] ?? 0));
          const blue = Math.abs((before.data[offset + 2] ?? 0) - (after.data[offset + 2] ?? 0));
          const alpha = Math.abs((before.data[offset + 3] ?? 255) - (after.data[offset + 3] ?? 255));
          error += (red + green + blue) / 3;
          if (red || green || blue || alpha) changed += 1;
          pixels += 1;
        }
      }
      const result = {
        meanError: pixels ? error / pixels : 0,
        changedPercent: pixels ? changed / pixels * 100 : 0,
      };
      if (result.meanError > worst.meanError ||
        (result.meanError === worst.meanError && result.changedPercent > worst.changedPercent)) worst = result;
    }
  }
  return worst;
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
