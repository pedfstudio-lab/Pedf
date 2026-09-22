import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFRef,
  PDFStream,
} from 'pdf-lib';
import type { PageViewport } from 'pdfjs-dist';
import { imageDrawsFromOperatorList } from '@/lib/pdf/images';
import type { DrawnImage, OperatorListLike } from '@/lib/pdf/images';
import type { ContentToken } from './contentStream';
import { nameValue, serializeContentStream, tokenizeContentStream } from './contentStream';
import type { ContentStreamNode } from './coveredGlyphs';
import type { PageStreamTree, ImageResourceBinding } from './formStreams';
import type { PdfRect, ReplacedImage } from './types';

export interface ImageRemovalCover {
  readonly rect: PdfRect;
  readonly replacesImages?: readonly ReplacedImage[];
}

export interface CoveredImageRewrite {
  readonly streamKey: string;
  readonly startTokenIndex: number;
  readonly endTokenIndex: number;
}

export interface CoveredImagePlan {
  readonly skipped: boolean;
  readonly reason?: string;
  readonly removedImages: number;
  readonly unmatchedImages: number;
  readonly outsideCoverImages: number;
  readonly rewrites: readonly CoveredImageRewrite[];
  readonly removedResources: readonly ImageResourceBinding[];
}

interface LocatedImagePaint extends CoveredImageRewrite {
  readonly source: 'named' | 'inline';
  readonly binding?: ImageResourceBinding;
}

const MAX_FORM_DEPTH = 8;
const SUBTYPE = PDFName.of('Subtype');
const IMAGE = PDFName.of('Image');
const SMASK = PDFName.of('SMask');
const MASK = PDFName.of('Mask');

function skipped(
  reason: string,
  unmatchedImages = 0,
  outsideCoverImages = 0,
): CoveredImagePlan {
  return {
    skipped: true,
    reason,
    removedImages: 0,
    unmatchedImages,
    outsideCoverImages,
    rewrites: [],
    removedResources: [],
  };
}

function significantIndexes(tokens: readonly ContentToken[]): number[] {
  return tokens.flatMap((token, index) => (
    token.kind === 'whitespace' || token.kind === 'comment' ? [] : [index]
  ));
}

function exclusivePlacementRange(
  tokens: readonly ContentToken[],
  startTokenIndex: number,
  endTokenIndex: number,
): { startTokenIndex: number; endTokenIndex: number } {
  const indexes = significantIndexes(tokens);
  const startPosition = indexes.indexOf(startTokenIndex);
  const endPosition = indexes.indexOf(endTokenIndex);
  if (startPosition < 0 || endPosition < startPosition) return { startTokenIndex, endTokenIndex };
  const after = tokens[indexes[endPosition + 1] ?? -1];
  if (after?.kind !== 'word' || after.value !== 'Q') return { startTokenIndex, endTokenIndex };

  let qPosition = startPosition - 1;
  while (qPosition >= 0) {
    const token = tokens[indexes[qPosition] ?? -1];
    if (token?.kind === 'word' && token.value === 'q') break;
    qPosition -= 1;
  }
  if (qPosition < 0) return { startTokenIndex, endTokenIndex };

  let cursor = qPosition + 1;
  while (cursor < startPosition) {
    for (let offset = 0; offset < 6; offset += 1) {
      if (tokens[indexes[cursor + offset] ?? -1]?.kind !== 'number') {
        return { startTokenIndex, endTokenIndex };
      }
    }
    const transform = tokens[indexes[cursor + 6] ?? -1];
    if (transform?.kind !== 'word' || transform.value !== 'cm') {
      return { startTokenIndex, endTokenIndex };
    }
    cursor += 7;
  }
  if (cursor !== startPosition) return { startTokenIndex, endTokenIndex };
  return {
    startTokenIndex: indexes[qPosition] ?? startTokenIndex,
    endTokenIndex: indexes[endPosition + 1] ?? endTokenIndex,
  };
}

function walkStream(
  tree: PageStreamTree,
  node: ContentStreamNode,
  depth: number,
  path: ReadonlySet<string>,
  paints: LocatedImagePaint[],
  invocations: Map<string, number>,
): void {
  invocations.set(node.key, (invocations.get(node.key) ?? 0) + 1);
  let lastName: { readonly name: string; readonly tokenIndex: number } | undefined;
  for (let index = 0; index < node.tokens.length; index += 1) {
    const token = node.tokens[index];
    if (!token || token.kind === 'whitespace' || token.kind === 'comment') continue;
    if (token.kind === 'inlineImage') {
      paints.push({
        streamKey: node.key,
        source: 'inline',
        ...exclusivePlacementRange(node.tokens, index, index),
      });
      lastName = undefined;
      continue;
    }
    if (token.kind === 'name') {
      const name = nameValue(token);
      lastName = name === null ? undefined : { name, tokenIndex: index };
      continue;
    }
    if (token.kind === 'word') {
      if (token.value === 'Do' && lastName) {
        const child = depth < MAX_FORM_DEPTH ? node.form(lastName.name) : null;
        if (child && !path.has(child.key)) {
          walkStream(tree, child, depth + 1, new Set([...path, child.key]), paints, invocations);
        } else if (!child) {
          const range = exclusivePlacementRange(node.tokens, lastName.tokenIndex, index);
          const binding = tree.imageFor(node.key, lastName.name);
          paints.push({
            streamKey: node.key,
            source: 'named',
            ...range,
            ...(binding ? { binding } : {}),
          });
        }
      }
      lastName = undefined;
    }
  }
}

function rawImagePaints(tree: PageStreamTree): {
  readonly paints: readonly LocatedImagePaint[];
  readonly invocations: ReadonlyMap<string, number>;
} {
  const paints: LocatedImagePaint[] = [];
  const invocations = new Map<string, number>();
  for (const root of tree.roots) {
    walkStream(tree, root, 0, new Set([root.key]), paints, invocations);
  }
  return { paints, invocations };
}

function rectsAgree(left: PdfRect, right: PdfRect): boolean {
  const leftEdges = [left.x, left.y, left.x + left.w, left.y + left.h];
  const rightEdges = [right.x, right.y, right.x + right.w, right.y + right.h];
  return leftEdges.every((edge, index) => Math.abs(edge - (rightEdges[index] ?? edge)) <= 1);
}

export function imageMatchesReplacement(draw: DrawnImage, replacement: ReplacedImage): boolean {
  return draw.kind === replacement.kind && (
    (draw.visibleRect ? rectsAgree(draw.visibleRect, replacement.rect) : false) ||
    rectsAgree(draw.region.rect, replacement.rect)
  );
}

function claimed(draw: DrawnImage, covers: readonly ImageRemovalCover[]): boolean {
  return covers.some((cover) => cover.replacesImages?.some((replacement) => (
    imageMatchesReplacement(draw, replacement)
  )) ?? false);
}

function coverContains(rect: PdfRect, cover: PdfRect): boolean {
  return cover.x <= rect.x + 1 &&
    cover.y <= rect.y + 1 &&
    cover.x + cover.w >= rect.x + rect.w - 1 &&
    cover.y + cover.h >= rect.y + rect.h - 1;
}

export function outsideCoverImageWarning(pageIndex: number): string {
  return `A picture on page ${pageIndex + 1} was not removed because the patch does not fully cover it; it is left as it was.`;
}

/** Build a fail-closed plan that maps flattened PDF.js image draws to raw paint operators. */
export function planCoveredImageRemoval(
  operatorList: OperatorListLike,
  viewport: PageViewport,
  pageIndex: number,
  tree: PageStreamTree,
  covers: readonly ImageRemovalCover[],
): CoveredImagePlan {
  let unmatchedImages = 0;
  let outsideCoverImages = 0;
  try {
    const draws = imageDrawsFromOperatorList(operatorList, viewport, pageIndex);
    const replacements = covers.flatMap((cover) => cover.replacesImages ?? []);
    unmatchedImages = replacements.filter((replacement) => (
      !draws.some((draw) => imageMatchesReplacement(draw, replacement))
    )).length;
    const walk = rawImagePaints(tree);
    if (draws.length !== walk.paints.length) {
      return skipped(
        'the content-stream and PDF.js image-paint counts differ',
        unmatchedImages,
        outsideCoverImages,
      );
    }

    const selected = new Set<number>();
    const rewrites: CoveredImageRewrite[] = [];
    for (let index = 0; index < draws.length; index += 1) {
      const draw = draws[index];
      const paint = walk.paints[index];
      if (!draw || !paint) {
        return skipped('an image paint could not be mapped', unmatchedImages, outsideCoverImages);
      }
      if ((draw.kind === 'inline') !== (paint.source === 'inline')) {
        return skipped(
          'an image paint kind does not match the content stream',
          unmatchedImages,
          outsideCoverImages,
        );
      }
      if (!claimed(draw, covers)) continue;
      const visibleRect = draw.visibleRect;
      if (visibleRect && !covers.some((cover) => coverContains(visibleRect, cover.rect))) {
        outsideCoverImages += 1;
        continue;
      }
      if ((walk.invocations.get(paint.streamKey) ?? 0) !== 1) {
        return skipped(
          'a Form XObject is painted more than once on the page',
          unmatchedImages,
          outsideCoverImages,
        );
      }
      if (paint.source === 'named' && !paint.binding) {
        return skipped(
          'an image resource could not be resolved safely',
          unmatchedImages,
          outsideCoverImages,
        );
      }
      selected.add(index);
      rewrites.push({
        streamKey: paint.streamKey,
        startTokenIndex: paint.startTokenIndex,
        endTokenIndex: paint.endTokenIndex,
      });
    }

    const removedResources: ImageResourceBinding[] = [];
    const seenResources = new Set<string>();
    for (const index of selected) {
      const binding = walk.paints[index]?.binding;
      if (!binding) continue;
      const key = `${binding.resourceKey}\u0000${binding.name}`;
      if (seenResources.has(key)) continue;
      const allUsesRemoved = walk.paints.every((paint, paintIndex) => (
        paint.binding?.resourceKey !== binding.resourceKey ||
        paint.binding.name !== binding.name ||
        selected.has(paintIndex)
      ));
      if (allUsesRemoved) {
        seenResources.add(key);
        removedResources.push(binding);
      }
    }

    return {
      skipped: false,
      removedImages: selected.size,
      unmatchedImages,
      outsideCoverImages,
      rewrites,
      removedResources,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return skipped(
      `the page content could not be parsed (${message})`,
      unmatchedImages,
      outsideCoverImages,
    );
  }
}

/** Remove planned paint ranges while preserving every byte outside those ranges. */
export function rewriteImagePaintOperators(
  original: readonly ContentToken[],
  rewrites: readonly CoveredImageRewrite[],
): Uint8Array | null {
  try {
    const tokens = [...original];
    for (const rewrite of [...rewrites].sort((left, right) => right.startTokenIndex - left.startTokenIndex)) {
      if (
        rewrite.startTokenIndex < 0 ||
        rewrite.endTokenIndex < rewrite.startTokenIndex ||
        rewrite.endTokenIndex >= tokens.length
      ) return null;
      tokens.splice(
        rewrite.startTokenIndex,
        rewrite.endTokenIndex - rewrite.startTokenIndex + 1,
      );
    }
    const bytes = serializeContentStream(tokens);
    tokenizeContentStream(bytes);
    return bytes;
  } catch {
    return null;
  }
}

function reachableRefs(pdf: PDFDocument): ReadonlySet<string> {
  const reachable = new Set<string>();
  const visited = new Set<object>();
  const visit = (value: unknown): void => {
    if (!value || typeof value !== 'object') return;
    if (value instanceof PDFRef) {
      if (reachable.has(value.tag)) return;
      reachable.add(value.tag);
      visit(pdf.context.lookup(value));
      return;
    }
    if (visited.has(value)) return;
    visited.add(value);
    if (value instanceof PDFStream) {
      visit(value.dict);
    } else if (value instanceof PDFDict) {
      for (const [, entry] of value.entries()) visit(entry);
    } else if (value instanceof PDFArray) {
      for (let index = 0; index < value.size(); index += 1) visit(value.get(index));
    }
  };
  for (const value of Object.values(pdf.context.trailerInfo)) visit(value);
  return reachable;
}

/** Delete unreferenced image streams and any now-unreferenced soft/explicit mask streams. */
export function deleteUnreachableImageObjects(
  pdf: PDFDocument,
  candidates: readonly PDFRef[],
): void {
  const reachable = reachableRefs(pdf);
  const masks: PDFRef[] = [];
  const unique = new Map(candidates.map((ref) => [ref.tag, ref]));
  for (const ref of unique.values()) {
    if (reachable.has(ref.tag)) continue;
    const stream = pdf.context.lookupMaybe(ref, PDFStream);
    if (!stream || stream.dict.get(SUBTYPE) !== IMAGE) continue;
    const softMask = stream.dict.get(SMASK);
    const mask = stream.dict.get(MASK);
    if (softMask instanceof PDFRef) masks.push(softMask);
    if (mask instanceof PDFRef) masks.push(mask);
    pdf.context.delete(ref);
  }
  const stillReachable = reachableRefs(pdf);
  for (const ref of new Map(masks.map((mask) => [mask.tag, mask])).values()) {
    if (!stillReachable.has(ref.tag)) pdf.context.delete(ref);
  }
}
