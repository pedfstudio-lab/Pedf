import type { ToolOptions } from './types';

export type SignPageSelection = 'one' | 'all' | 'custom';
export type SignDate = 'none' | 'text' | 'numeric';

export interface SignatureAsset {
  png: Uint8Array;
  width: number;
  height: number;
}

export interface SignOptionsValue {
  [key: string]: unknown;
  signature?: SignatureAsset;
  pageSelection: SignPageSelection;
  pageIndex: number;
  ranges: string;
  /** Centre x as a share of the displayed page. */
  x: number;
  /** Centre y from the top as a share of the displayed page. */
  y: number;
  widthShare: number;
  date: SignDate;
}

export interface SignatureReaderRect {
  u: number;
  v: number;
  width: number;
  height: number;
  centreX: number;
  centreYFromTop: number;
}

export interface SignatureLimits { minX: number; maxX: number; minY: number; maxY: number }

export const DEFAULT_SIGN_OPTIONS: SignOptionsValue = {
  pageSelection: 'one',
  pageIndex: 0,
  ranges: '',
  x: 0.7,
  y: 0.85,
  widthShare: 0.25,
  date: 'none',
};

function bounded(value: unknown, fallback: number, minimum: number, maximum: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(Math.max(value, minimum), maximum)
    : fallback;
}

function signatureOf(value: unknown): SignatureAsset | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const signature = value as Partial<SignatureAsset>;
  return signature.png instanceof Uint8Array && signature.png.byteLength > 0
    && typeof signature.width === 'number' && signature.width > 0
    && typeof signature.height === 'number' && signature.height > 0
    ? { png: signature.png, width: signature.width, height: signature.height }
    : undefined;
}

export function parseSignOptions(options: ToolOptions): SignOptionsValue {
  const pageSelection: SignPageSelection = options.pageSelection === 'all' || options.pageSelection === 'custom'
    ? options.pageSelection : 'one';
  const date: SignDate = options.date === 'text' || options.date === 'numeric' ? options.date : 'none';
  return {
    signature: signatureOf(options.signature),
    pageSelection,
    pageIndex: Math.max(0, Math.floor(bounded(options.pageIndex, 0, 0, Number.MAX_SAFE_INTEGER))),
    ranges: typeof options.ranges === 'string' ? options.ranges : '',
    x: bounded(options.x, DEFAULT_SIGN_OPTIONS.x, 0, 1),
    y: bounded(options.y, DEFAULT_SIGN_OPTIONS.y, 0, 1),
    widthShare: bounded(options.widthShare, DEFAULT_SIGN_OPTIONS.widthShare, 0.02, 1),
    date,
  };
}

export function signProblem(options: ToolOptions): string | undefined {
  if (!parseSignOptions(options).signature) return 'Make or pick a signature first.';
}

function signatureSize(
  frameWidth: number,
  frameHeight: number,
  value: SignOptionsValue,
  imageAspect: number,
): { width: number; height: number } {
  const safeAspect = Number.isFinite(imageAspect) && imageAspect > 0 ? imageAspect : 1;
  const dateRoom = value.date === 'none' ? 0 : 16;
  const availableHeight = Math.max(0, frameHeight - dateRoom);
  let width = Math.min(frameWidth, frameWidth * value.widthShare);
  let height = width / safeAspect;
  if (height > availableHeight) {
    height = availableHeight;
    width = Math.min(frameWidth, height * safeAspect);
  }
  return { width, height };
}

/** Centre limits as page shares, with y measured from the top like the placement stage. */
export function signatureLimits(
  pageWidth: number,
  pageHeight: number,
  options: ToolOptions,
  imageAspect: number,
): SignatureLimits {
  const value = parseSignOptions(options);
  const safeWidth = Math.max(Number.EPSILON, pageWidth);
  const safeHeight = Math.max(Number.EPSILON, pageHeight);
  const { width, height } = signatureSize(safeWidth, safeHeight, value, imageAspect);
  const dateRoom = value.date === 'none' ? 0 : 16;
  return {
    minX: width / (2 * safeWidth),
    maxX: 1 - width / (2 * safeWidth),
    minY: height / (2 * safeHeight),
    maxY: 1 - (height / 2 + dateRoom) / safeHeight,
  };
}

/** Rectangle in the displayed reader frame; u/v use a bottom-left origin, while the stored y share is from the top. */
export function signatureRect(
  frameWidth: number,
  frameHeight: number,
  options: ToolOptions,
  imageAspect: number,
): SignatureReaderRect {
  const value = parseSignOptions(options);
  const { width, height } = signatureSize(frameWidth, frameHeight, value, imageAspect);
  const limits = signatureLimits(frameWidth, frameHeight, value, imageAspect);
  const centreX = Math.min(Math.max(value.x, limits.minX), limits.maxX) * frameWidth;
  const centreYFromTop = Math.min(Math.max(value.y, limits.minY), limits.maxY);
  const centreV = (1 - centreYFromTop) * frameHeight;
  return {
    u: centreX - width / 2,
    v: centreV - height / 2,
    width,
    height,
    centreX: centreX / frameWidth,
    centreYFromTop,
  };
}

export function formatSignDate(mode: SignDate, date = new Date()): string {
  if (mode === 'none') return '';
  const day = String(date.getDate()).padStart(2, '0');
  const month = date.getMonth();
  const year = date.getFullYear();
  if (mode === 'numeric') return `${day}/${String(month + 1).padStart(2, '0')}/${year}`;
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${day} ${months[month]} ${year}`;
}
