import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFNumber,
  PDFRawStream,
  PDFStream,
  decodePDFRawStream,
} from 'pdf-lib';
import { unzlibSync, zlibSync } from 'fflate';
import type { PdfRect } from '@/lib/export/types';

export interface ExtractedImage {
  readonly bytes: Uint8Array;
  readonly mime: 'image/jpeg' | 'image/png';
}

type Matrix = readonly [number, number, number, number, number, number];
type ContentToken = number | { readonly name: string } | { readonly operator: string };

const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];
const RECT_TOLERANCE_PT = 0.5;

function multiply(left: Matrix, right: Matrix): Matrix {
  return [
    left[0] * right[0] + left[2] * right[1],
    left[1] * right[0] + left[3] * right[1],
    left[0] * right[2] + left[2] * right[3],
    left[1] * right[2] + left[3] * right[3],
    left[0] * right[4] + left[2] * right[5] + left[4],
    left[1] * right[4] + left[3] * right[5] + left[5],
  ];
}

function point(matrix: Matrix, x: number, y: number): { readonly x: number; readonly y: number } {
  return {
    x: matrix[0] * x + matrix[2] * y + matrix[4],
    y: matrix[1] * x + matrix[3] * y + matrix[5],
  };
}

function transformedRect(matrix: Matrix): PdfRect {
  const corners = [
    point(matrix, 0, 0),
    point(matrix, 1, 0),
    point(matrix, 0, 1),
    point(matrix, 1, 1),
  ];
  const left = Math.min(...corners.map((corner) => corner.x));
  const bottom = Math.min(...corners.map((corner) => corner.y));
  const right = Math.max(...corners.map((corner) => corner.x));
  const top = Math.max(...corners.map((corner) => corner.y));
  return { x: left, y: bottom, w: right - left, h: top - bottom };
}

function sameRect(left: PdfRect, right: PdfRect): boolean {
  return (
    Math.abs(left.x - right.x) <= RECT_TOLERANCE_PT &&
    Math.abs(left.y - right.y) <= RECT_TOLERANCE_PT &&
    Math.abs(left.w - right.w) <= RECT_TOLERANCE_PT &&
    Math.abs(left.h - right.h) <= RECT_TOLERANCE_PT
  );
}

function matrixFromArray(value: PDFArray | undefined): Matrix {
  if (!value || value.size() !== 6) return IDENTITY;
  const numbers = Array.from({ length: 6 }, (_, index) =>
    value.lookupMaybe(index, PDFNumber)?.asNumber(),
  );
  if (numbers.some((number) => number === undefined || !Number.isFinite(number))) return IDENTITY;
  return numbers as unknown as Matrix;
}

function isWhitespace(code: number): boolean {
  return code === 0 || code === 9 || code === 10 || code === 12 || code === 13 || code === 32;
}

function isDelimiter(code: number): boolean {
  return isWhitespace(code) || code === 37 || code === 40 || code === 41 || code === 47 ||
    code === 60 || code === 62 || code === 91 || code === 93 || code === 123 || code === 125;
}

function decodeName(value: string): string {
  return value.replace(/#([0-9a-f]{2})/gi, (_match, hex: string) =>
    String.fromCharCode(Number.parseInt(hex, 16)),
  );
}

/** A deliberately small PDF content lexer that ignores strings and inline image payloads. */
function contentTokens(bytes: Uint8Array): ContentToken[] {
  const tokens: ContentToken[] = [];
  const text = new TextDecoder('latin1').decode(bytes);
  let index = 0;
  while (index < text.length) {
    const code = text.charCodeAt(index);
    if (isWhitespace(code)) {
      index += 1;
      continue;
    }
    if (code === 37) {
      while (index < text.length && ![10, 13].includes(text.charCodeAt(index))) index += 1;
      continue;
    }
    if (code === 40) {
      let depth = 1;
      index += 1;
      while (index < text.length && depth > 0) {
        if (text.charCodeAt(index) === 92) index += 2;
        else {
          if (text.charCodeAt(index) === 40) depth += 1;
          if (text.charCodeAt(index) === 41) depth -= 1;
          index += 1;
        }
      }
      continue;
    }
    if (code === 60 && text.charCodeAt(index + 1) !== 60) {
      index = text.indexOf('>', index + 1);
      if (index < 0) break;
      index += 1;
      continue;
    }
    if (code === 47) {
      const start = ++index;
      while (index < text.length && !isDelimiter(text.charCodeAt(index))) index += 1;
      tokens.push({ name: decodeName(text.slice(start, index)) });
      continue;
    }
    if (code === 43 || code === 45 || code === 46 || (code >= 48 && code <= 57)) {
      const start = index++;
      while (index < text.length && /[\d.+-]/.test(text[index] ?? '')) index += 1;
      const number = Number(text.slice(start, index));
      if (Number.isFinite(number)) tokens.push(number);
      continue;
    }
    if ([91, 93, 123, 125].includes(code) || (code === 60 && text.charCodeAt(index + 1) === 60) ||
      (code === 62 && text.charCodeAt(index + 1) === 62)) {
      index += code === 60 || code === 62 ? 2 : 1;
      continue;
    }
    const start = index++;
    while (index < text.length && !isDelimiter(text.charCodeAt(index))) index += 1;
    const operator = text.slice(start, index);
    if (operator === 'BI') {
      const match = /\sEI(?=\s|$)/.exec(text.slice(index));
      if (match?.index !== undefined) index += match.index + match[0].length;
      continue;
    }
    if (operator) tokens.push({ operator });
  }
  return tokens;
}

function decodedStreamBytes(stream: PDFStream): Uint8Array | undefined {
  if (!(stream instanceof PDFRawStream)) return stream.getContents();
  try {
    return decodePDFRawStream(stream).decode();
  } catch {
    return undefined;
  }
}

function contentStreams(contents: PDFStream | PDFArray | undefined): PDFStream[] {
  if (!contents) return [];
  if (contents instanceof PDFStream) return [contents];
  const streams: PDFStream[] = [];
  for (let index = 0; index < contents.size(); index += 1) {
    const stream = contents.lookupMaybe(index, PDFStream);
    if (stream) streams.push(stream);
  }
  return streams;
}

function findImageStream(
  streams: readonly PDFStream[],
  resources: PDFDict | undefined,
  target: PdfRect,
  initial: Matrix,
  activeForms: Set<PDFStream>,
): PDFRawStream | undefined {
  if (!resources) return undefined;
  const xObjects = resources.lookupMaybe(PDFName.of('XObject'), PDFDict);
  if (!xObjects) return undefined;
  let current = initial;
  const stack: Matrix[] = [];
  let operands: ContentToken[] = [];

  for (const stream of streams) {
    const bytes = decodedStreamBytes(stream);
    if (!bytes) continue;
    for (const token of contentTokens(bytes)) {
      if (typeof token === 'number' || 'name' in token) {
        operands.push(token);
        continue;
      }
      const operation = token.operator;
      if (operation === 'q') stack.push(current);
      else if (operation === 'Q') current = stack.pop() ?? current;
      else if (operation === 'cm') {
        const values = operands.slice(-6);
        if (values.length === 6 && values.every((value) => typeof value === 'number')) {
          current = multiply(current, values as unknown as Matrix);
        }
      } else if (operation === 'Do') {
        const name = operands.at(-1);
        if (name && typeof name !== 'number' && 'name' in name) {
          const xObject = xObjects.lookupMaybe(PDFName.of(name.name), PDFStream);
          const subtype = xObject?.dict.lookupMaybe(PDFName.of('Subtype'), PDFName)?.decodeText();
          if (xObject instanceof PDFRawStream && subtype === 'Image' && sameRect(transformedRect(current), target)) {
            return xObject;
          }
          if (xObject && subtype === 'Form' && !activeForms.has(xObject)) {
            activeForms.add(xObject);
            const formResources = xObject.dict.lookupMaybe(PDFName.of('Resources'), PDFDict) ?? resources;
            const formMatrix = matrixFromArray(xObject.dict.lookupMaybe(PDFName.of('Matrix'), PDFArray));
            const found = findImageStream(
              [xObject],
              formResources,
              target,
              multiply(current, formMatrix),
              activeForms,
            );
            activeForms.delete(xObject);
            if (found) return found;
          }
        }
      }
      operands = [];
    }
  }
  return undefined;
}

function filterNames(stream: PDFRawStream): string[] | undefined {
  const filter = stream.dict.lookup(PDFName.of('Filter'));
  if (!filter) return [];
  if (filter instanceof PDFName) return [filter.decodeText()];
  if (!(filter instanceof PDFArray)) return undefined;
  const names: string[] = [];
  for (let index = 0; index < filter.size(); index += 1) {
    const name = filter.lookupMaybe(index, PDFName)?.decodeText();
    if (!name) return undefined;
    names.push(name);
  }
  return names;
}

function decodeFlatePrefix(bytes: Uint8Array, filters: readonly string[]): Uint8Array | undefined {
  let decoded = bytes;
  try {
    for (const filter of filters) {
      if (filter !== 'FlateDecode' && filter !== 'Fl') return undefined;
      decoded = unzlibSync(decoded);
    }
    return decoded;
  } catch {
    return undefined;
  }
}

function numberEntry(dict: PDFDict, name: string): number | undefined {
  return dict.lookupMaybe(PDFName.of(name), PDFNumber)?.asNumber();
}

function predictorIsPlain(stream: PDFRawStream): boolean {
  const parameters = stream.dict.lookupMaybe(PDFName.of('DecodeParms'), PDFDict);
  const predictor = parameters?.lookupMaybe(PDFName.of('Predictor'), PDFNumber)?.asNumber() ?? 1;
  return predictor === 1;
}

function concat(chunks: readonly Uint8Array[]): Uint8Array {
  const output = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}

function uint32(value: number): Uint8Array {
  return Uint8Array.of(value >>> 24, value >>> 16, value >>> 8, value);
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = new TextEncoder().encode(type);
  const body = concat([typeBytes, data]);
  return concat([uint32(data.length), body, uint32(crc32(body))]);
}

function encodePng(
  pixels: Uint8Array,
  width: number,
  height: number,
  channels: 1 | 2 | 3 | 4,
): Uint8Array {
  const stride = width * channels;
  const scanlines = new Uint8Array((stride + 1) * height);
  for (let row = 0; row < height; row += 1) {
    scanlines[row * (stride + 1)] = 0;
    scanlines.set(pixels.subarray(row * stride, (row + 1) * stride), row * (stride + 1) + 1);
  }
  const colorType = channels === 1 ? 0 : channels === 2 ? 4 : channels === 3 ? 2 : 6;
  const header = concat([uint32(width), uint32(height), Uint8Array.of(8, colorType, 0, 0, 0)]);
  return concat([
    Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10),
    pngChunk('IHDR', header),
    pngChunk('IDAT', zlibSync(scanlines)),
    pngChunk('IEND', new Uint8Array()),
  ]);
}

function flatePixels(stream: PDFRawStream, width: number, height: number): { pixels: Uint8Array; channels: 1 | 3 } | undefined {
  if (!predictorIsPlain(stream)) return undefined;
  const filters = filterNames(stream);
  if (!filters || filters.length === 0 || filters.some((filter) => filter !== 'FlateDecode' && filter !== 'Fl')) {
    return undefined;
  }
  if (numberEntry(stream.dict, 'BitsPerComponent') !== 8) return undefined;
  const colorSpace = stream.dict.lookupMaybe(PDFName.of('ColorSpace'), PDFName)?.decodeText();
  const channels = colorSpace === 'DeviceRGB' ? 3 : colorSpace === 'DeviceGray' ? 1 : undefined;
  if (!channels) return undefined;
  const pixels = decodeFlatePrefix(stream.contents, filters);
  if (!pixels || pixels.length !== width * height * channels) return undefined;
  return { pixels, channels };
}

function extractStream(stream: PDFRawStream): ExtractedImage | undefined {
  const filters = filterNames(stream);
  if (!filters) return undefined;
  const finalFilter = filters.at(-1);
  if (finalFilter === 'DCTDecode' || finalFilter === 'DCT') {
    const bytes = decodeFlatePrefix(stream.contents, filters.slice(0, -1));
    if (!bytes || bytes[0] !== 0xff || bytes[1] !== 0xd8) return undefined;
    return { bytes, mime: 'image/jpeg' };
  }
  const width = numberEntry(stream.dict, 'Width');
  const height = numberEntry(stream.dict, 'Height');
  if (!width || !height) return undefined;
  const decoded = flatePixels(stream, width, height);
  if (!decoded) return undefined;
  const maskObject = stream.dict.lookupMaybe(PDFName.of('SMask'), PDFStream);
  const mask = maskObject instanceof PDFRawStream ? maskObject : undefined;
  if (!mask) return { bytes: encodePng(decoded.pixels, width, height, decoded.channels), mime: 'image/png' };
  const maskWidth = numberEntry(mask.dict, 'Width');
  const maskHeight = numberEntry(mask.dict, 'Height');
  const alpha = maskWidth === width && maskHeight === height ? flatePixels(mask, width, height) : undefined;
  if (!alpha || alpha.channels !== 1) return undefined;
  const channels = decoded.channels === 3 ? 4 : 2;
  const pixels = new Uint8Array(width * height * channels);
  for (let source = 0, target = 0, alphaIndex = 0; alphaIndex < alpha.pixels.length; alphaIndex += 1) {
    for (let channel = 0; channel < decoded.channels; channel += 1) pixels[target++] = decoded.pixels[source++]!;
    pixels[target++] = alpha.pixels[alphaIndex]!;
  }
  return { bytes: encodePng(pixels, width, height, channels), mime: 'image/png' };
}

/** Extract the encoded image drawn at `rect` without modifying the source PDF document. */
export function extractImageBytes(
  pdfLibDoc: PDFDocument,
  pageIndex: number,
  rect: PdfRect,
): ExtractedImage | undefined {
  if (pageIndex < 0 || pageIndex >= pdfLibDoc.getPageCount()) return undefined;
  const page = pdfLibDoc.getPage(pageIndex);
  const stream = findImageStream(
    contentStreams(page.node.Contents()),
    page.node.Resources(),
    rect,
    IDENTITY,
    new Set(),
  );
  return stream ? extractStream(stream) : undefined;
}
