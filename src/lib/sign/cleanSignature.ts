export type SignatureInk = 'original' | 'black' | 'blue';

export interface CleanSignatureOptions {
  strength: number;
  removeLines: boolean;
  ink: SignatureInk;
}

const BLOCK_SIZE = 32;
const LINE_COVERAGE = 0.5;
/**
 * How far below the local paper a pixel must be to count towards finding a ruled line. Fixed on purpose:
 * finding lines must not depend on the Cleaning strength slider (Task 62 Rev 2) — with a slider-based
 * mask, turning the strength down made whole stretches of a line stop counting, and they stayed.
 */
const LINE_DETECT_DARKNESS = 20;
/** Rows (or columns) cleaned on each side of a found line: shrinking blends a line's edge into its neighbours. */
const LINE_EDGE_ROWS = 1;
/**
 * Ruled lines are faint (light blue / pink / grey: roughly 40–100 below the paper); pen ink is dark (blue ballpoint
 * ~170, black ~230). A long straight band as dark as ink is a pen stroke — an underline, a tall straight letter in a
 * tightly cropped photo — and must never be erased as a "line". A bold red margin is the exception: it can be as dark
 * as ink overall, but its red stays close to the paper's, while pen ink (black or blue) is dark in red too.
 */
const LINE_MAX_DARKNESS = 110;
const CROP_PADDING = 8;
const MAX_OUTPUT_WIDTH = 1600;

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}

function makeImageData(data: Uint8ClampedArray, width: number, height: number): ImageData {
  if (typeof ImageData !== 'undefined') {
    const owned = new Uint8ClampedArray(data.length);
    owned.set(data);
    return new ImageData(owned, width, height);
  }
  return { data, width, height, colorSpace: 'srgb' } as ImageData;
}

/**
 * Shrink a photographed signature before background cleaning. Each output pixel is the
 * area-weighted average of the source pixels it covers, so thin notebook rules cannot
 * disappear merely because a nearest-neighbour sample skipped them.
 */
export function shrinkForCleaning(image: ImageData, maxSide = 1600): ImageData {
  const longestSide = Math.max(image.width, image.height);
  const limit = Math.max(1, Math.round(Number.isFinite(maxSide) ? maxSide : 1600));
  if (longestSide <= limit) return image;

  const scale = limit / longestSide;
  const width = Math.max(1, Math.round(image.width * scale));
  const height = Math.max(1, Math.round(image.height * scale));
  const output = new Uint8ClampedArray(width * height * 4);
  const sourcePerOutputX = image.width / width;
  const sourcePerOutputY = image.height / height;

  for (let y = 0; y < height; y++) {
    const sourceTop = y * sourcePerOutputY;
    const sourceBottom = (y + 1) * sourcePerOutputY;
    const firstY = Math.floor(sourceTop);
    const lastY = Math.min(image.height - 1, Math.ceil(sourceBottom) - 1);
    for (let x = 0; x < width; x++) {
      const sourceLeft = x * sourcePerOutputX;
      const sourceRight = (x + 1) * sourcePerOutputX;
      const firstX = Math.floor(sourceLeft);
      const lastX = Math.min(image.width - 1, Math.ceil(sourceRight) - 1);
      const sums = [0, 0, 0, 0];
      let area = 0;
      for (let sourceY = firstY; sourceY <= lastY; sourceY++) {
        const yWeight = Math.min(sourceBottom, sourceY + 1) - Math.max(sourceTop, sourceY);
        if (yWeight <= 0) continue;
        for (let sourceX = firstX; sourceX <= lastX; sourceX++) {
          const xWeight = Math.min(sourceRight, sourceX + 1) - Math.max(sourceLeft, sourceX);
          const weight = xWeight * yWeight;
          if (weight <= 0) continue;
          const source = (sourceY * image.width + sourceX) * 4;
          for (let channel = 0; channel < 4; channel++) sums[channel]! += image.data[source + channel]! * weight;
          area += weight;
        }
      }
      const target = (y * width + x) * 4;
      for (let channel = 0; channel < 4; channel++) output[target + channel] = Math.round(sums[channel]! / area);
    }
  }
  return makeImageData(output, width, height);
}

function brightness(data: Uint8ClampedArray, offset: number): number {
  return data[offset]! * 0.299 + data[offset + 1]! * 0.587 + data[offset + 2]! * 0.114;
}

function percentile(values: number[], share: number): number {
  if (!values.length) return 255;
  values.sort((left, right) => left - right);
  return values[Math.min(values.length - 1, Math.floor((values.length - 1) * share))]!;
}

function backgroundMap(image: ImageData): { values: Float32Array; columns: number; rows: number } {
  const columns = Math.max(1, Math.ceil(image.width / BLOCK_SIZE));
  const rows = Math.max(1, Math.ceil(image.height / BLOCK_SIZE));
  const values = new Float32Array(columns * rows);
  for (let by = 0; by < rows; by++) {
    for (let bx = 0; bx < columns; bx++) {
      const samples: number[] = [];
      const left = bx * BLOCK_SIZE;
      const top = by * BLOCK_SIZE;
      const right = Math.min(image.width, left + BLOCK_SIZE);
      const bottom = Math.min(image.height, top + BLOCK_SIZE);
      for (let y = top; y < bottom; y++) {
        for (let x = left; x < right; x++) samples.push(brightness(image.data, (y * image.width + x) * 4));
      }
      values[by * columns + bx] = percentile(samples, 0.9);
    }
  }
  return { values, columns, rows };
}

function paperBrightnessAt(
  map: ReturnType<typeof backgroundMap>,
  x: number,
  y: number,
  width: number,
  height: number,
): number {
  if (map.columns === 1 && map.rows === 1) return map.values[0] ?? 255;
  const gx = map.columns === 1 ? 0 : clamp((x + 0.5) / width * map.columns - 0.5, 0, map.columns - 1);
  const gy = map.rows === 1 ? 0 : clamp((y + 0.5) / height * map.rows - 0.5, 0, map.rows - 1);
  const x0 = Math.floor(gx);
  const y0 = Math.floor(gy);
  const x1 = Math.min(map.columns - 1, x0 + 1);
  const y1 = Math.min(map.rows - 1, y0 + 1);
  const tx = gx - x0;
  const ty = gy - y0;
  const top = (map.values[y0 * map.columns + x0] ?? 255) * (1 - tx)
    + (map.values[y0 * map.columns + x1] ?? 255) * tx;
  const bottom = (map.values[y1 * map.columns + x0] ?? 255) * (1 - tx)
    + (map.values[y1 * map.columns + x1] ?? 255) * tx;
  return top * (1 - ty) + bottom * ty;
}

function groups(mask: boolean[]): Array<{ start: number; end: number }> {
  const result: Array<{ start: number; end: number }> = [];
  let start = -1;
  for (let index = 0; index <= mask.length; index++) {
    if (mask[index] && start < 0) start = index;
    if ((!mask[index] || index === mask.length) && start >= 0) {
      result.push({ start, end: index - 1 });
      start = -1;
    }
  }
  return result;
}

function removeRuledLines(
  alpha: Uint8ClampedArray,
  darkness: Float32Array,
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
): void {
  // Blended edges can add a row on each side of a line's body, so allow for them in the thickness check.
  const maxLineThickness = Math.max(4, Math.round(Math.max(width, height) / 400)) + 2 * LINE_EDGE_ROWS;
  const lineLike = (index: number) => darkness[index]! > LINE_DETECT_DARKNESS;
  const rows = Array.from({ length: height }, (_, y) => {
    let count = 0;
    for (let x = 0; x < width; x++) if (lineLike(y * width + x)) count += 1;
    return count > width * LINE_COVERAGE;
  });
  const columns = Array.from({ length: width }, (_, x) => {
    let count = 0;
    for (let y = 0; y < height; y++) if (lineLike(y * width + x)) count += 1;
    return count > height * LINE_COVERAGE;
  });

  const clearBand = (horizontal: boolean, start: number, end: number) => {
    if (end - start + 1 > maxLineThickness) return;
    const values: number[] = [];
    const redDrops: number[] = [];
    const major = horizontal ? width : height;
    const minorCount = horizontal ? height : width;
    for (let minor = start; minor <= end; minor++) {
      for (let majorIndex = 0; majorIndex < major; majorIndex++) {
        const index = horizontal ? minor * width + majorIndex : majorIndex * width + minor;
        if (!lineLike(index)) continue;
        values.push(darkness[index]!);
        // How far the red channel sits below the paper (paper is near neutral, so its red is about its brightness).
        redDrops.push(darkness[index]! + brightness(pixels, index * 4) - pixels[index * 4]!);
      }
    }
    // Area averaging creates lighter antialiased edges around a rule. Use the darker
    // body of the band as its reference while still preserving much darker pen ink.
    const lineDarkness = percentile(values, 0.8);
    if (lineDarkness > LINE_MAX_DARKNESS && percentile(redDrops, 0.8) > LINE_MAX_DARKNESS) return;
    // Also clean the row just outside each side: shrinking leaves a pale edge row there that is too faint to be
    // found as a line but can still pass as ink on part of the page (a thin blue streak in the signature).
    const first = Math.max(0, start - LINE_EDGE_ROWS);
    const last = Math.min(minorCount - 1, end + LINE_EDGE_ROWS);
    for (let minor = first; minor <= last; minor++) {
      for (let majorIndex = 0; majorIndex < major; majorIndex++) {
        const index = horizontal ? minor * width + majorIndex : majorIndex * width + minor;
        // Preserve clearly darker pen strokes that cross a ruled line.
        if (darkness[index]! <= lineDarkness + 16) alpha[index] = 0;
      }
    }
  };

  for (const band of groups(rows)) clearBand(true, band.start, band.end);
  for (const band of groups(columns)) clearBand(false, band.start, band.end);
}

export function trimToInk(image: ImageData, padding = CROP_PADDING): ImageData {
  let left = image.width;
  let top = image.height;
  let right = -1;
  let bottom = -1;
  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < image.width; x++) {
      if (image.data[(y * image.width + x) * 4 + 3]! <= 2) continue;
      left = Math.min(left, x);
      top = Math.min(top, y);
      right = Math.max(right, x);
      bottom = Math.max(bottom, y);
    }
  }
  if (right < left || bottom < top) return makeImageData(new Uint8ClampedArray(4), 1, 1);
  const safePadding = Math.max(0, Math.round(padding));
  const width = right - left + 1 + safePadding * 2;
  const height = bottom - top + 1 + safePadding * 2;
  const output = new Uint8ClampedArray(width * height * 4);
  for (let y = top; y <= bottom; y++) {
    for (let x = left; x <= right; x++) {
      const source = (y * image.width + x) * 4;
      const target = ((y - top + safePadding) * width + x - left + safePadding) * 4;
      output[target] = image.data[source]!;
      output[target + 1] = image.data[source + 1]!;
      output[target + 2] = image.data[source + 2]!;
      output[target + 3] = image.data[source + 3]!;
    }
  }
  return makeImageData(output, width, height);
}

function downscale(image: ImageData, maximumWidth: number): ImageData {
  if (image.width <= maximumWidth) return image;
  const width = maximumWidth;
  const height = Math.max(1, Math.round(image.height * width / image.width));
  const output = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    const sourceY = Math.min(image.height - 1, Math.floor((y + 0.5) * image.height / height));
    for (let x = 0; x < width; x++) {
      const sourceX = Math.min(image.width - 1, Math.floor((x + 0.5) * image.width / width));
      const source = (sourceY * image.width + sourceX) * 4;
      const target = (y * width + x) * 4;
      output[target] = image.data[source]!;
      output[target + 1] = image.data[source + 1]!;
      output[target + 2] = image.data[source + 2]!;
      output[target + 3] = image.data[source + 3]!;
    }
  }
  return makeImageData(output, width, height);
}

/** Remove photographed paper and leave a compact transparent image containing only the signature ink. */
export function cleanSignature(image: ImageData, options: CleanSignatureOptions): ImageData {
  if (image.width < 1 || image.height < 1) return makeImageData(new Uint8ClampedArray(4), 1, 1);
  let transparentPixels = 0;
  for (let offset = 3; offset < image.data.length; offset += 4) {
    if (image.data[offset]! < 250) transparentPixels += 1;
  }
  // A PNG that already carries transparency is already separated from its paper. Preserve its antialiased edge.
  if (transparentPixels > image.width * image.height * 0.01) {
    const preserved = new Uint8ClampedArray(image.data.length);
    for (let offset = 0; offset < image.data.length; offset += 4) {
      if (options.ink === 'black') {
        preserved[offset] = 18; preserved[offset + 1] = 24; preserved[offset + 2] = 33;
      } else if (options.ink === 'blue') {
        preserved[offset] = 22; preserved[offset + 1] = 76; preserved[offset + 2] = 166;
      } else {
        preserved[offset] = image.data[offset]!;
        preserved[offset + 1] = image.data[offset + 1]!;
        preserved[offset + 2] = image.data[offset + 2]!;
      }
      preserved[offset + 3] = image.data[offset + 3]!;
    }
    return downscale(trimToInk(makeImageData(preserved, image.width, image.height)), MAX_OUTPUT_WIDTH);
  }
  const map = backgroundMap(image);
  const count = image.width * image.height;
  const alpha = new Uint8ClampedArray(count);
  const dark = new Float32Array(count);
  const strength = clamp(Number.isFinite(options.strength) ? options.strength : 50, 0, 100);
  // Higher strength keeps fainter ink. At the default, ink begins at 25 points below the local paper.
  const threshold = 70 - strength * 0.9;

  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < image.width; x++) {
      const index = y * image.width + x;
      const offset = index * 4;
      const amount = Math.max(0, paperBrightnessAt(map, x, y, image.width, image.height) - brightness(image.data, offset));
      dark[index] = amount;
      const ramp = clamp((amount - threshold) / 40, 0, 1);
      alpha[index] = Math.round(ramp * (image.data[offset + 3] ?? 255));
    }
  }
  if (options.removeLines) removeRuledLines(alpha, dark, image.data, image.width, image.height);

  const output = new Uint8ClampedArray(count * 4);
  for (let index = 0; index < count; index++) {
    const source = index * 4;
    const target = source;
    if (options.ink === 'black') {
      output[target] = 18; output[target + 1] = 24; output[target + 2] = 33;
    } else if (options.ink === 'blue') {
      output[target] = 22; output[target + 1] = 76; output[target + 2] = 166;
    } else {
      output[target] = image.data[source]!;
      output[target + 1] = image.data[source + 1]!;
      output[target + 2] = image.data[source + 2]!;
    }
    output[target + 3] = alpha[index]!;
  }
  return downscale(trimToInk(makeImageData(output, image.width, image.height)), MAX_OUTPUT_WIDTH);
}

export function hasVisibleInk(image: ImageData): boolean {
  for (let offset = 3; offset < image.data.length; offset += 4) {
    if (image.data[offset]! > 8) return true;
  }
  return false;
}
