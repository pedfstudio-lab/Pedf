import type { CompressImageAnalysis } from './analyze';
import type { DecodedImagePixels } from './recode';

const MAX_SAMPLED_PIXELS = 200_000;
const MAX_LINE_ART_COLOURS = 48;
const DOMINANT_COLOUR_RATIO = 0.85;
const HARD_ALPHA_RATIO = 0.9;
const ALPHA_EDGE_TOLERANCE = 8;
/**
 * Measured on real files with white margins excluded: text scans and review screenshots score 6–37, while photos
 * sitting on a white phone-screenshot canvas score 61–82.
 */
const MAX_SCAN_CHROMA = 45;
const NEAR_WHITE_LUMINANCE = 245;
const NEAR_WHITE_CHROMA = 12;
const EXTREME_LUMINANCE_FRACTION = 0.3;
const MIN_SCAN_EXTREME_RATIO = 0.85;

function hasLossyFilter(image: CompressImageAnalysis): boolean {
  return image.filters.some((filter) =>
    ['DCTDecode', 'DCT', 'JPXDecode', 'JPX'].includes(filter),
  );
}

/** Identify flat-colour artwork and hard-edged cut-outs without scanning more than 200k pixels. */
export function isLineArt(image: CompressImageAnalysis, pixels: DecodedImagePixels): boolean {
  if ((image.hasSoftMask || image.hasMask) && !hasLossyFilter(image)) return true;

  const availablePixels = Math.min(pixels.width * pixels.height, Math.floor(pixels.data.length / 4));
  if (availablePixels <= 0) return false;
  const stride = Math.max(1, Math.ceil(availablePixels / MAX_SAMPLED_PIXELS));
  const colours = new Map<number, number>();
  let tooManyColours = false;
  let sampled = 0;
  let hardAlpha = 0;
  let transparentAlpha = 0;
  for (let pixelIndex = 0; pixelIndex < availablePixels; pixelIndex += stride) {
    const offset = pixelIndex * 4;
    const red = (pixels.data[offset] ?? 0) >> 3;
    const green = (pixels.data[offset + 1] ?? 0) >> 3;
    const blue = (pixels.data[offset + 2] ?? 0) >> 3;
    const alpha = pixels.data[offset + 3] ?? 255;
    const alpha5 = alpha >> 3;
    const key = (((red << 5) | green) << 10) | (blue << 5) | alpha5;
    const previous = colours.get(key);
    if (previous !== undefined) colours.set(key, previous + 1);
    else if (colours.size < MAX_LINE_ART_COLOURS + 1) colours.set(key, 1);
    else tooManyColours = true;
    if (alpha <= ALPHA_EDGE_TOLERANCE) transparentAlpha += 1;
    if (alpha <= ALPHA_EDGE_TOLERANCE || alpha >= 255 - ALPHA_EDGE_TOLERANCE) hardAlpha += 1;
    sampled += 1;
  }

  const dominant = Array.from(colours.values()).sort((left, right) => right - left)
    .slice(0, 4).reduce((sum, count) => sum + count, 0);
  const flatColours = !tooManyColours && colours.size <= MAX_LINE_ART_COLOURS
    && dominant >= sampled * DOMINANT_COLOUR_RATIO;
  const hardEdgedCutout = transparentAlpha > 0 && hardAlpha >= sampled * HARD_ALPHA_RATIO;
  return flatColours || hardEdgedCutout;
}

/** Identify paper-and-ink document scans while rejecting colourful photos and smooth greyscale portraits. */
export function isDocumentScan(pixels: DecodedImagePixels): boolean {
  const availablePixels = Math.min(pixels.width * pixels.height, Math.floor(pixels.data.length / 4));
  if (availablePixels <= 0) return false;
  const stride = Math.max(1, Math.ceil(availablePixels / MAX_SAMPLED_PIXELS));
  const luminances = new Uint8Array(Math.ceil(availablePixels / stride));
  let sampled = 0;
  let chroma = 0;
  let contentPixels = 0;
  let darkest = 255;
  let brightest = 0;
  for (let pixelIndex = 0; pixelIndex < availablePixels; pixelIndex += stride) {
    const offset = pixelIndex * 4;
    const red = pixels.data[offset] ?? 0;
    const green = pixels.data[offset + 1] ?? 0;
    const blue = pixels.data[offset + 2] ?? 0;
    const pixelChroma = Math.max(red, green, blue) - Math.min(red, green, blue);
    const luminance = Math.round((red * 299 + green * 587 + blue * 114) / 1_000);
    // Blank white margins say nothing about colour; counting them made a photo on a white canvas look like paper.
    if (luminance < NEAR_WHITE_LUMINANCE || pixelChroma > NEAR_WHITE_CHROMA) {
      chroma += pixelChroma;
      contentPixels += 1;
    }
    luminances[sampled] = luminance;
    darkest = Math.min(darkest, luminance);
    brightest = Math.max(brightest, luminance);
    sampled += 1;
  }
  // An all-white image has no content to judge by colour, so the paper-and-ink test below decides.
  if (contentPixels > 0 && chroma / contentPixels >= MAX_SCAN_CHROMA) return false;
  const range = brightest - darkest;
  const darkLimit = darkest + range * EXTREME_LUMINANCE_FRACTION;
  const brightLimit = brightest - range * EXTREME_LUMINANCE_FRACTION;
  let extremes = 0;
  for (let index = 0; index < sampled; index++) {
    const luminance = luminances[index]!;
    if (luminance <= darkLimit || luminance >= brightLimit) extremes += 1;
  }
  return extremes >= sampled * MIN_SCAN_EXTREME_RATIO;
}
