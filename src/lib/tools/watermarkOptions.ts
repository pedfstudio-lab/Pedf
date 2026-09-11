import { StandardFonts } from 'pdf-lib';
import type { ToolOptions } from './types';

export type WatermarkMode = 'text' | 'image';
export type WatermarkFont = 'sans' | 'serif' | 'mono';
export type WatermarkSize = 'auto' | 24 | 36 | 48 | 72;
export type WatermarkColour = 'grey' | 'black' | 'red' | 'blue' | 'white';
export type WatermarkAngle = 45 | 0 | -45 | 90;
/** Nine quick spots, tiling, or `custom` — a spot the user dragged to (see `customX` / `customY`). */
export type WatermarkPosition = 'tl' | 't' | 'tr' | 'l' | 'c' | 'r' | 'bl' | 'b' | 'br' | 'tile' | 'custom';
export type WatermarkPageSelection = 'all' | 'custom';

export interface WatermarkOptionsValue {
  [key: string]: unknown;
  mode: WatermarkMode;
  text: string;
  font: WatermarkFont;
  bold: boolean;
  size: WatermarkSize;
  colour: WatermarkColour;
  opacity: number;
  angle: WatermarkAngle;
  position: WatermarkPosition;
  /** Centre of a dragged watermark, as a share of the page the reader sees: 0 = left edge, 1 = right edge. */
  customX: number;
  /** Centre of a dragged watermark, as a share of the page the reader sees: 0 = top edge, 1 = bottom edge. */
  customY: number;
  imageBytes?: Uint8Array;
  imageMime?: 'image/png' | 'image/jpeg';
  imageName?: string;
  imageWidth?: number;
  imageHeight?: number;
  imageScale: number;
  pageSelection: WatermarkPageSelection;
  ranges: string;
}

export const DEFAULT_WATERMARK_OPTIONS: WatermarkOptionsValue = {
  mode: 'text',
  text: 'CONFIDENTIAL',
  font: 'sans',
  bold: false,
  size: 'auto',
  colour: 'grey',
  opacity: 0.3,
  angle: 45,
  position: 'c',
  customX: 0.5,
  customY: 0.5,
  imageScale: 0.4,
  pageSelection: 'all',
  ranges: '',
};

export const WATERMARK_COLOURS: Record<WatermarkColour, readonly [number, number, number]> = {
  grey: [0.5, 0.5, 0.5],
  black: [0, 0, 0],
  red: [0xd3 / 255, 0x2f / 255, 0x2f / 255],
  blue: [0x1e / 255, 0x6b / 255, 1],
  white: [1, 1, 1],
};

export const WATERMARK_FONTS: Record<WatermarkFont, { regular: StandardFonts; bold: StandardFonts }> = {
  sans: { regular: StandardFonts.Helvetica, bold: StandardFonts.HelveticaBold },
  serif: { regular: StandardFonts.TimesRoman, bold: StandardFonts.TimesRomanBold },
  mono: { regular: StandardFonts.Courier, bold: StandardFonts.CourierBold },
};

const sizes: readonly WatermarkSize[] = ['auto', 24, 36, 48, 72];
const angles: readonly WatermarkAngle[] = [45, 0, -45, 90];
const positions: readonly WatermarkPosition[] = ['tl', 't', 'tr', 'l', 'c', 'r', 'bl', 'b', 'br', 'tile', 'custom'];

function bounded(value: unknown, fallback: number, min: number, max: number): number {
  const number = typeof value === 'number' ? value : Number.NaN;
  return Number.isFinite(number) && number >= min && number <= max ? number : fallback;
}

export function parseWatermarkOptions(options: ToolOptions): WatermarkOptionsValue {
  const mode = options.mode === 'image' ? 'image' : 'text';
  const font = options.font === 'serif' || options.font === 'mono' ? options.font : 'sans';
  const size = sizes.includes(options.size as WatermarkSize) ? options.size as WatermarkSize : 'auto';
  const colour = options.colour === 'black' || options.colour === 'red' || options.colour === 'blue'
    || options.colour === 'white' ? options.colour : 'grey';
  const angle = angles.includes(options.angle as WatermarkAngle) ? options.angle as WatermarkAngle : 45;
  const position = positions.includes(options.position as WatermarkPosition)
    ? options.position as WatermarkPosition : 'c';
  const imageMime = options.imageMime === 'image/png' || options.imageMime === 'image/jpeg'
    ? options.imageMime : undefined;
  return {
    mode,
    text: typeof options.text === 'string' ? options.text : DEFAULT_WATERMARK_OPTIONS.text,
    font,
    bold: options.bold === true,
    size,
    colour,
    opacity: bounded(options.opacity, DEFAULT_WATERMARK_OPTIONS.opacity, 0.1, 1),
    angle,
    position,
    customX: bounded(options.customX, DEFAULT_WATERMARK_OPTIONS.customX, 0, 1),
    customY: bounded(options.customY, DEFAULT_WATERMARK_OPTIONS.customY, 0, 1),
    imageBytes: options.imageBytes instanceof Uint8Array ? options.imageBytes : undefined,
    imageMime,
    imageName: typeof options.imageName === 'string' ? options.imageName : undefined,
    imageWidth: typeof options.imageWidth === 'number' && options.imageWidth > 0 ? options.imageWidth : undefined,
    imageHeight: typeof options.imageHeight === 'number' && options.imageHeight > 0 ? options.imageHeight : undefined,
    imageScale: bounded(options.imageScale, DEFAULT_WATERMARK_OPTIONS.imageScale, 0.1, 1),
    pageSelection: options.pageSelection === 'custom' ? 'custom' : 'all',
    ranges: typeof options.ranges === 'string' ? options.ranges : '',
  };
}

export function watermarkProblem(options: ToolOptions): string | undefined {
  const value = parseWatermarkOptions(options);
  if (value.mode === 'image') {
    if (!value.imageBytes || !value.imageMime) return 'Choose an image for the watermark first.';
    return;
  }
  if (!value.text.trim()) return 'Type the watermark text first.';
  if (value.text.length > 100) return 'Keep the watermark under 100 characters.';
  if (!/^[\x20-\x7e]*$/.test(value.text)) return 'Use English letters, numbers and common symbols for now.';
}
