import { describe, expect, it } from 'vitest';
import { OPS } from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { PageViewport } from 'pdfjs-dist';
import { PDFRef } from 'pdf-lib';
import type { OperatorListLike } from '@/lib/pdf/images';
import { tokenizeContentStream } from './contentStream';
import type { ContentStreamNode } from './coveredGlyphs';
import type { PageStreamTree } from './formStreams';
import {
  imageMatchesReplacement,
  outsideCoverImageWarning,
  planCoveredImageRemoval,
  rewriteImagePaintOperators,
} from './coveredImages';

const decoder = new TextDecoder('latin1');

function viewport(height = 200): PageViewport {
  return {
    width: 200,
    height,
    transform: [1, 0, 0, -1, 0, height],
    viewBox: [0, 0, 200, height],
    convertToPdfPoint: (x: number, y: number) => [x, height - y],
  } as unknown as PageViewport;
}

function treeFor(
  source: string,
  form?: (name: string) => ContentStreamNode | null,
): PageStreamTree {
  const tokens = tokenizeContentStream(new TextEncoder().encode(source));
  const root: ContentStreamNode = { key: 'page:0', tokens, form: form ?? (() => null) };
  return {
    roots: [root],
    tokensFor: (key) => key === root.key ? tokens : null,
    imageFor: (streamKey, name) => ({
      resourceKey: streamKey,
      name,
      ref: PDFRef.of(7),
    }),
    apply: () => [],
  };
}

function namedOperators(transforms: readonly number[][], objectId = 'img_p0_1'): OperatorListLike {
  return {
    fnArray: transforms.flatMap(() => [OPS.save, OPS.transform, OPS.paintImageXObject, OPS.restore]),
    argsArray: transforms.flatMap((transform) => [[], transform, [objectId], []]),
  };
}

describe('covered image matching', () => {
  const draw = {
    region: { pageIndex: 0, rect: { x: 20, y: 10, w: 80, h: 80 } },
    visibleRect: { x: 20, y: 30, w: 80, h: 40 },
    widthPt: 80,
    heightPt: 40,
    objectId: 'img_p0_1',
    kind: 'image' as const,
  };

  it('matches by image kind and file-space edges without consulting the PDF.js object id', () => {
    expect(imageMatchesReplacement(draw, {
      kind: 'image', rect: draw.visibleRect,
    })).toBe(true);
    expect(imageMatchesReplacement(draw, {
      kind: 'image', rect: draw.region.rect,
    })).toBe(true);
    expect(imageMatchesReplacement(draw, {
      kind: 'inline', rect: draw.region.rect,
    })).toBe(false);
    expect(imageMatchesReplacement(draw, {
      kind: 'image', rect: { x: 22, y: 32, w: 76, h: 36 },
    })).toBe(false);
    expect(imageMatchesReplacement(draw, {
      kind: 'image', rect: { x: 20.5, y: 29.5, w: 79.5, h: 40.5 },
    })).toBe(true);
  });
});

describe('covered image planning', () => {
  it('removes a claimed draw fully inside a cover', () => {
    const tree = treeFor('q 80 0 0 40 20 30 cm /Im0 Do Q');
    const plan = planCoveredImageRemoval(
      namedOperators([[80, 0, 0, 40, 20, 30]]),
      viewport(),
      0,
      tree,
      [{
        rect: { x: 19, y: 29, w: 82, h: 42 },
        replacesImages: [{ kind: 'image', rect: { x: 20, y: 30, w: 80, h: 40 } }],
      }],
    );

    expect(plan).toMatchObject({
      skipped: false,
      removedImages: 1,
      outsideCoverImages: 0,
    });
  });

  it('keeps a claimed draw that extends outside the cover while removing another claimed draw', () => {
    const source = [
      'q 80 0 0 40 20 30 cm /Im0 Do Q',
      'q 40 0 0 30 120 60 cm /Im1 Do Q',
    ].join('\n');
    const tree = treeFor(source);
    const plan = planCoveredImageRemoval(
      namedOperators([
        [80, 0, 0, 40, 20, 30],
        [40, 0, 0, 30, 120, 60],
      ]),
      viewport(),
      0,
      tree,
      [
        {
          rect: { x: 20, y: 30, w: 75, h: 40 },
          replacesImages: [{ kind: 'image', rect: { x: 20, y: 30, w: 80, h: 40 } }],
        },
        {
          rect: { x: 120, y: 60, w: 40, h: 30 },
          replacesImages: [{ kind: 'image', rect: { x: 120, y: 60, w: 40, h: 30 } }],
        },
      ],
    );

    expect(plan).toMatchObject({
      skipped: false,
      removedImages: 1,
      outsideCoverImages: 1,
    });
    expect(outsideCoverImageWarning(0)).toBe(
      'A picture on page 1 was not removed because the patch does not fully cover it; it is left as it was.',
    );
    const bytes = rewriteImagePaintOperators(tree.roots[0]!.tokens, plan.rewrites);
    expect(decoder.decode(bytes!)).toContain('/Im0 Do');
    expect(decoder.decode(bytes!)).not.toContain('/Im1 Do');
    expect(plan.removedResources.map((resource) => resource.name)).toEqual(['Im1']);
  });

  it('removes a claimed draw whose visible clipped rectangle stops at the page edge', () => {
    const tree = treeFor('q 40 0 0 30 180 50 cm /Im0 Do Q');
    const plan = planCoveredImageRemoval(
      namedOperators([[40, 0, 0, 30, 180, 50]]),
      viewport(),
      0,
      tree,
      [{
        rect: { x: 180, y: 50, w: 20, h: 30 },
        replacesImages: [{ kind: 'image', rect: { x: 180, y: 50, w: 40, h: 30 } }],
      }],
    );

    expect(plan).toMatchObject({
      skipped: false,
      removedImages: 1,
      outsideCoverImages: 0,
    });
  });

  it('removes every claimed draw stacked at the same rectangle', () => {
    const source = [
      'q 80 0 0 40 20 30 cm /Im0 Do Q',
      'q 80 0 0 40 20 30 cm /Im1 Do Q',
      'q 80 0 0 40 20 30 cm /Im2 Do Q',
    ].join('\n');
    const tree = treeFor(source);
    const plan = planCoveredImageRemoval(
      namedOperators([
        [80, 0, 0, 40, 20, 30],
        [80, 0, 0, 40, 20, 30],
        [80, 0, 0, 40, 20, 30],
      ]),
      viewport(),
      0,
      tree,
      [{
        rect: { x: 20, y: 30, w: 80, h: 40 },
        replacesImages: [{ kind: 'image', rect: { x: 20, y: 30, w: 80, h: 40 } }],
      }],
    );

    expect(plan).toMatchObject({
      skipped: false,
      removedImages: 3,
      outsideCoverImages: 0,
    });
    expect(plan.rewrites).toHaveLength(3);
  });

  it('skips when PDF.js and raw image-paint counts disagree', () => {
    const tree = treeFor('q 80 0 0 40 20 30 cm /Im0 Do Q');
    const plan = planCoveredImageRemoval(
      { fnArray: [], argsArray: [] },
      viewport(),
      0,
      tree,
      [{ rect: { x: 20, y: 30, w: 80, h: 40 }, replacesImages: [{
        kind: 'image', rect: { x: 20, y: 30, w: 80, h: 40 },
      }] }],
    );

    expect(plan.skipped).toBe(true);
    expect(plan.reason).toMatch(/counts differ/);
  });

  it('leaves the stream untouched when no replacement entry matches a draw', () => {
    const source = 'q 80 0 0 40 20 30 cm /Im0 Do Q';
    const tree = treeFor(source);
    const plan = planCoveredImageRemoval(
      namedOperators([[80, 0, 0, 40, 20, 30]]),
      viewport(),
      0,
      tree,
      [{ rect: { x: 150, y: 150, w: 10, h: 10 }, replacesImages: [{
        kind: 'image', rect: { x: 150, y: 150, w: 10, h: 10 },
      }] }],
    );

    expect(plan).toMatchObject({
      skipped: false,
      removedImages: 0,
      unmatchedImages: 1,
      rewrites: [],
      removedResources: [],
    });
  });

  it('removes one claimed named draw and its exclusive q/cm/Q placement wrapper', () => {
    const tree = treeFor('q 80 0 0 40 20 30 cm /Im0 Do Q');
    const plan = planCoveredImageRemoval(
      namedOperators([[80, 0, 0, 40, 20, 30]]),
      viewport(),
      0,
      tree,
      [{
        rect: { x: 0, y: 0, w: 200, h: 200 },
        replacesImages: [{
          kind: 'image',
          rect: { x: 20, y: 30, w: 80, h: 40 },
        }],
      }],
    );

    expect(plan).toMatchObject({ skipped: false, removedImages: 1 });
    expect(plan.removedResources).toHaveLength(1);
    const bytes = rewriteImagePaintOperators(tree.roots[0]!.tokens, plan.rewrites);
    expect(bytes).not.toBeNull();
    expect(decoder.decode(bytes!)).not.toMatch(/\b(?:q|cm|Do|Q)\b/);
  });

  it('leaves an unclaimed neighbouring use of the same resource intact', () => {
    const tree = treeFor([
      'q 80 0 0 40 20 30 cm /Im0 Do Q',
      'q 80 0 0 40 110 120 cm /Im0 Do Q',
    ].join('\n'));
    const plan = planCoveredImageRemoval(
      namedOperators([
        [80, 0, 0, 40, 20, 30],
        [80, 0, 0, 40, 110, 120],
      ]),
      viewport(),
      0,
      tree,
      [{
        rect: { x: 20, y: 30, w: 80, h: 40 },
        replacesImages: [{
          kind: 'image', rect: { x: 20, y: 30, w: 80, h: 40 },
        }],
      }],
    );

    expect(plan).toMatchObject({ skipped: false, removedImages: 1 });
    expect(plan.removedResources).toEqual([]);
    const bytes = rewriteImagePaintOperators(tree.roots[0]!.tokens, plan.rewrites);
    expect(decoder.decode(bytes!)).toContain('/Im0 Do');
  });

  it('removes an inline image without claiming a resource object', () => {
    const tree = treeFor('q 20 0 0 10 5 6 cm BI /W 1 /H 1 /BPC 8 /CS /G ID \x00 EI Q');
    const operators: OperatorListLike = {
      fnArray: [OPS.save, OPS.transform, OPS.paintInlineImageXObject, OPS.restore],
      argsArray: [[], [20, 0, 0, 10, 5, 6], [{}], []],
    };
    const plan = planCoveredImageRemoval(operators, viewport(), 0, tree, [{
      rect: { x: 5, y: 6, w: 20, h: 10 },
      replacesImages: [{ kind: 'inline', rect: { x: 5, y: 6, w: 20, h: 10 } }],
    }]);

    expect(plan).toMatchObject({ skipped: false, removedImages: 1, removedResources: [] });
    const bytes = rewriteImagePaintOperators(tree.roots[0]!.tokens, plan.rewrites);
    expect(decoder.decode(bytes!)).not.toContain('BI');
  });

  it('skips a form stream painted more than once on the page', () => {
    const childTokens = tokenizeContentStream(new TextEncoder().encode(
      'q 20 0 0 10 5 6 cm /Im0 Do Q',
    ));
    const child: ContentStreamNode = { key: 'page/Fm', tokens: childTokens, form: () => null };
    const rootTokens = tokenizeContentStream(new TextEncoder().encode('/Fm Do /Fm Do'));
    const root: ContentStreamNode = { key: 'page:0', tokens: rootTokens, form: () => child };
    const tree: PageStreamTree = {
      roots: [root],
      tokensFor: (key) => key === child.key ? childTokens : key === root.key ? rootTokens : null,
      imageFor: (_streamKey, name) => ({ resourceKey: child.key, name, ref: PDFRef.of(7) }),
      apply: () => [],
    };
    const operators: OperatorListLike = {
      fnArray: [
        OPS.paintFormXObjectBegin, OPS.transform, OPS.paintImageXObject, OPS.paintFormXObjectEnd,
        OPS.paintFormXObjectBegin, OPS.transform, OPS.paintImageXObject, OPS.paintFormXObjectEnd,
      ],
      argsArray: [
        [[1, 0, 0, 1, 0, 0]], [20, 0, 0, 10, 5, 6], ['img_p0_1'], [],
        [[1, 0, 0, 1, 0, 0]], [20, 0, 0, 10, 5, 6], ['img_p0_1'], [],
      ],
    };
    const plan = planCoveredImageRemoval(operators, viewport(), 0, tree, [{
      rect: { x: 5, y: 6, w: 20, h: 10 },
      replacesImages: [{ kind: 'image', rect: { x: 5, y: 6, w: 20, h: 10 } }],
    }]);

    expect(plan.skipped).toBe(true);
    expect(plan.reason).toMatch(/painted more than once/);
  });
});
