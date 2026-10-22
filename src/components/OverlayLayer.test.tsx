/** @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import type { PageViewport, PDFPageProxy } from 'pdfjs-dist';
import type { Edit, TextEdit } from '@/lib/export/types';
import type { ScreenRect } from '@/lib/export/coordinates';
import type { SnapTarget } from '@/lib/edit/moveSnap';
import type { TextBlock } from '@/lib/pdf/textContent';
import type { ImageRegion } from '@/lib/pdf/images';
import type { RuleLine } from '@/lib/pdf/ruleLines';
import type { PagePreviewBridge } from '@/lib/pdf/pagePreviewController';
import { buildTextBlockEdits, coverRectForTextBlock } from '@/lib/edit/buildTextEdits';
import type { NextTextEdit } from '@/lib/edit/buildTextEdits';
import { sourceSpansForTextBlock } from '@/lib/edit/richText';
import { OverlayLayer } from './OverlayLayer';

const task74Fixture = 'tmp/compress-tests/rishi-ilovepdf.pdf';
const task74RealEnabled = process.env.TASK74_REAL === '1' && existsSync(task74Fixture);

interface CapturedEditorProps {
  readonly expectedBaselinePx?: number;
  readonly baselineFontSizeSlopePx?: number;
  readonly toolbarObstacles?: readonly ScreenRect[];
  readonly block: TextBlock;
  readonly existing?: readonly TextEdit[];
  readonly screenRect: ScreenRect;
  readonly topCorrectionPx?: number;
  readonly horizontalTargets: readonly SnapTarget[];
  readonly onCancel: () => void;
  readonly onDone: (next: NextTextEdit) => void;
  readonly scaleInlineSizes?: boolean;
}

const mocks = vi.hoisted(() => ({
  edits: [] as Edit[],
  blocks: [] as TextBlock[],
  legacyBlocks: undefined as TextBlock[] | undefined,
  graphicRegions: {
    imageRegions: [] as ImageRegion[],
    shapeMarkerRegions: [] as ImageRegion[],
  },
  ruleLines: [] as RuleLine[],
  editorProps: undefined as CapturedEditorProps | undefined,
  replaceEdits: vi.fn(),
}));

const style = {
  fontName: 'Helvetica',
  fontSizePt: 20,
  bold: false,
  italic: false,
  color: { r: 0, g: 0, b: 0 },
};

const textBlock: TextBlock = {
  pageIndex: 0,
  text: 'Heading',
  rect: { x: 20, y: 700, w: 100, h: 20 },
  topBaselineY: 700,
  lineHeightPt: 24,
  style,
  lines: [],
};

const viewport = {
  width: 600,
  height: 800,
  convertToViewportPoint: (x: number, y: number) => [x, 800 - y],
  convertToPdfPoint: (x: number, y: number) => [x, 800 - y],
} as unknown as PageViewport;

vi.mock('@/state/editsStore', () => ({
  useEdits: () => ({
    edits: mocks.edits,
    addEdits: vi.fn(),
    replaceEdits: mocks.replaceEdits,
  }),
}));

vi.mock('@/state/documentStore', () => ({
  useDocumentStore: () => ({
    getPageCanvas: () => ({
      canvas: {
        width: 600,
        height: 800,
        getContext: () => ({
          getImageData: (_x: number, _y: number, width: number, height: number) => ({
            data: new Uint8ClampedArray(width * height * 4).fill(255),
          }),
        }),
      },
      viewport,
      dpr: 1,
    }),
  }),
}));

vi.mock('@/lib/pdf/textContent', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/pdf/textContent')>();
  return {
    ...actual,
    extractTextRuns: vi.fn(async () => []),
    groupRunsIntoBlocks: vi.fn((_runs, options) => options?.preserveParagraphSplits
      ? mocks.legacyBlocks ?? mocks.blocks : mocks.blocks),
  };
});

vi.mock('@/lib/pdf/images', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/pdf/images')>();
  return {
    ...actual,
    detectImages: vi.fn(async () => []),
  };
});

vi.mock('@/lib/pdf/shapeMarkers', () => ({
  detectPageGraphicRegions: vi.fn(async () => mocks.graphicRegions),
}));

vi.mock('@/lib/pdf/ruleLines', () => ({
  detectRuleLines: vi.fn(async () => mocks.ruleLines),
}));

vi.mock('@/lib/export/inkExtent', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/export/inkExtent')>();
  return {
    ...actual,
    measureCanvasInkExtent: vi.fn(() => ({ topTrim: 12, below: 0 })),
  };
});

vi.mock('./TextEditOverlay', () => ({
  TextEditOverlay: (props: CapturedEditorProps) => {
    mocks.editorProps = props;
    return (
      <div data-testid="captured-text-editor" data-top={props.screenRect.top}>
        <button type="button" onClick={props.onCancel}>Close captured editor</button>
      </div>
    );
  },
}));

vi.mock('./ImageOverlay', () => ({ ImageOverlay: () => null }));
vi.mock('./SmartSpanLayer', () => ({ SmartSpanLayer: () => null }));
vi.mock('./LineEditOverlay', () => ({ LineEditOverlay: () => null }));

function renderOverlay(preview?: PagePreviewBridge, pageViewport = viewport) {
  render(
    <OverlayLayer
      page={{ view: [0, 0, 600, 800] } as unknown as PDFPageProxy}
      pageIndex={0}
      viewport={pageViewport}
      dpr={1}
      zoom={1}
      editMode
      textAddMode={false}
      imageMode={false}
      peek={false}
      preview={preview}
    />,
  );
}

function targetAt(x: number, y: number): HTMLButtonElement | undefined {
  return [...document.querySelectorAll<HTMLButtonElement>('button')]
    .filter((button) => {
      const left = Number.parseFloat(button.style.left);
      const top = Number.parseFloat(button.style.top);
      const width = Number.parseFloat(button.style.width);
      const height = Number.parseFloat(button.style.height);
      return [left, top, width, height].every(Number.isFinite)
        && x >= left && x <= left + width && y >= top && y <= top + height;
    })
    .reduce<HTMLButtonElement | undefined>((winner, button) => {
      if (!winner) return button;
      const winnerZ = Number.parseInt(winner.style.zIndex || '0', 10);
      const buttonZ = Number.parseInt(button.style.zIndex || '0', 10);
      return buttonZ >= winnerZ ? button : winner;
    }, undefined);
}

function centreOf(button: HTMLElement) {
  return {
    x: Number.parseFloat(button.style.left) + Number.parseFloat(button.style.width) / 2,
    y: Number.parseFloat(button.style.top) + Number.parseFloat(button.style.height) / 2,
  };
}

async function openEditor(buttonName: RegExp) {
  fireEvent.click(await screen.findByRole('button', { name: buttonName }));
  fireEvent.click(screen.getByRole('menuitem', { name: 'Edit' }));
  await screen.findByTestId('captured-text-editor');
  return mocks.editorProps;
}

beforeEach(() => {
  mocks.edits = [];
  mocks.blocks = [textBlock];
  mocks.legacyBlocks = undefined;
  mocks.graphicRegions = { imageRegions: [], shapeMarkerRegions: [] };
  mocks.ruleLines = [];
  mocks.editorProps = undefined;
  mocks.replaceEdits.mockClear();
});

afterEach(cleanup);

describe('Task 84 date editor integration', () => {
  function fixture() {
    const number = { pageIndex: 0, text: '23', rect: { x: 20, y: 700, w: 20, h: 20 }, style };
    const month = { ...number, text: 'September', rect: { ...number.rect, x: 55, w: 100 } };
    const tiny = { ...number, text: 'rd', rect: { x: 40, y: 708, w: 10, h: 12 }, style: { ...style, fontSizePt: 12 } };
    const owner: TextBlock = { ...textBlock, text: '23 September', rect: { x: 20, y: 700, w: 135, h: 20 },
      lines: [{ pageIndex: 0, text: '23 September', rect: { x: 20, y: 700, w: 135, h: 20 }, baselineY: 700, style, runs: [number, month] }] };
    const ordinal: TextBlock = { ...textBlock, text: 'rd', rect: tiny.rect, topBaselineY: 708, style: tiny.style,
      lines: [{ pageIndex: 0, text: 'rd', rect: tiny.rect, baselineY: 708, style: tiny.style, runs: [tiny] }] };
    return { owner, ordinal, tiny };
  }
  it('clicking the tiny suffix opens the full date and warms/removes its physical source too', async () => {
    const { owner, ordinal, tiny } = fixture(); mocks.blocks = [owner, ordinal];
    const preview = { state: 'fallback', renderedEditIds: new Set(), warm: vi.fn(), begin: vi.fn(), cancel: vi.fn(),
      commit: vi.fn(), suspend: vi.fn() } as unknown as PagePreviewBridge;
    renderOverlay(preview);
    const props = await openEditor(/^Text actions: rd$/);
    expect(props!.block.text).toBe('23rd September');
    expect(props!.scaleInlineSizes).toBe(true);
    const selection = vi.mocked(preview.begin).mock.calls[0]![0];
    expect(selection.transientEdits[0]!.replaces).toContainEqual({ text: 'rd', rect: tiny.rect });
    expect(mocks.replaceEdits).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Close captured editor' }));
    expect(mocks.replaceEdits).not.toHaveBeenCalled();
  });
  it('records suffix removal inside the same anchored transaction and reopens saved spans only once', async () => {
    const { owner, ordinal, tiny } = fixture(); mocks.blocks = [owner, ordinal];
    renderOverlay();
    const props = await openEditor(/^Text actions: rd$/);
    const spans = sourceSpansForTextBlock(props!.block, props!.block.text, true);
    props!.onDone({ text: props!.block.text, spans, style, width: 200, height: 20, dx: 10, dy: -5 });
    const saved = mocks.replaceEdits.mock.calls[0]![1] as Edit[];
    const covers = saved.filter(edit => edit.kind === 'cover');
    const texts = saved.filter((edit): edit is TextEdit => edit.kind === 'text');
    expect(covers).toHaveLength(1);
    expect(covers[0]!.replaces).toContainEqual({ text: 'rd', rect: tiny.rect });
    expect(texts[0]!.z).toBe(covers[0]!.z + 1);
    expect(texts[0]!.boxText).toBe('23rd September');
    cleanup(); mocks.edits = saved; renderOverlay();
    const reopened = await openEditor(/^Text actions for edited text: 23rd September$/);
    expect(reopened!.existing).toEqual(texts);
    expect(reopened!.existing?.[0]?.boxText?.match(/rd/gu)).toHaveLength(1);
  });
});

describe('OverlayLayer editor top correction', () => {
  it('does not mistake a new merged-paragraph edit for several old saved boxes', async () => {
    const actual = await vi.importActual<typeof import('@/lib/pdf/textContent')>('@/lib/pdf/textContent');
    const lines = actual.mergeRunsIntoLines(['First fragment', 'Second fragment', 'Third fragment'].map((text, index) => ({
      pageIndex: 0, text, style, rect: { x: 20, y: 700 - index * 30, w: 250, h: 20 },
    })), { ruleLines: [] });
    const merged = actual.textBlockFromLines(lines);
    mocks.blocks = [merged];
    mocks.legacyBlocks = lines.map((line) => actual.textBlockFromLines([line]));
    const built = buildTextBlockEdits(merged, {
      text: 'New whole paragraph', style, width: 250, height: 80, dx: 0, dy: 0,
    }, ['New whole paragraph'], 1);
    mocks.edits = [...built.covers, ...built.texts];
    renderOverlay();
    const props = await openEditor(/^Text actions for edited text: New whole paragraph$/);
    expect(props?.block.lines).toHaveLength(3);
    expect(props?.existing).toEqual(built.texts);
  });
  it('finds a saved edit on the old second box after the fresh grouping merges it', async () => {
    const actual = await vi.importActual<typeof import('@/lib/pdf/textContent')>('@/lib/pdf/textContent');
    const lines = actual.mergeRunsIntoLines(['First paragraph fragment', 'Original second fragment', 'Third fragment'].map((text, index) => ({
      pageIndex: 0, text, style, rect: { x: 20, y: 700 - index * 30, w: 250, h: 20 },
    })), { ruleLines: [] });
    const old = lines.map((line) => actual.textBlockFromLines([line]));
    mocks.blocks = [actual.textBlockFromLines(lines)];
    mocks.legacyBlocks = old;
    const built = buildTextBlockEdits(old[1]!, {
      text: 'Saved replacement', style, width: 250, height: 20, dx: 0, dy: 0,
    }, ['Saved replacement'], 1);
    mocks.edits = [...built.covers, ...built.texts];
    renderOverlay();
    const props = await openEditor(/^Text actions for edited text: Saved replacement$/);
    expect(props?.block.text).toBe('Original second fragment');
    expect(props?.existing).toEqual(built.texts);
    expect(props?.block.lines).toHaveLength(1);
  });
  it('passes only neighbouring text in viewport coordinates for toolbar subtitle clearance', async () => {
    const subtitle = { ...textBlock, text: 'Subtitle', rect: { x: 25, y: 675, w: 200, h: 10 } };
    mocks.blocks = [textBlock, subtitle];
    renderOverlay();
    const props = await openEditor(/^Text actions: Heading$/);
    expect(props?.toolbarObstacles).toEqual([{ left: 25, top: 115, width: 200, height: 10 }]);
    expect(props?.screenRect.top).toBe(92);
  });

  it('keeps the 12px source-ink correction when a block is opened for the first time', async () => {
    renderOverlay();
    const props = await openEditor(/^Text actions: Heading$/);

    expect(props?.screenRect.top).toBe(92);
    expect(props?.topCorrectionPx).toBe(12);
    expect(props?.expectedBaselinePx).toBe(100);
    expect(props?.horizontalTargets.find((target) => target.label === 'original position')?.pos).toBe(92);
  });

  it('re-opens a saved edit at its own box top without applying the correction again', async () => {
    mocks.edits = [
      {
        id: 'cover',
        kind: 'cover',
        pageIndex: 0,
        rect: coverRectForTextBlock(textBlock),
        z: 1,
        sampleBackground: true,
      },
      {
        id: 'saved-heading',
        kind: 'text',
        pageIndex: 0,
        rect: { x: 25, y: 650, w: 100, h: 20 },
        z: 2,
        text: 'Heading',
        style,
        boxText: 'Heading',
        boxHeight: 40,
      },
    ];
    renderOverlay();
    const props = await openEditor(/^Text actions for edited text: Heading$/);

    expect(props?.screenRect.top).toBe(130);
    expect(props?.topCorrectionPx).toBe(0);
    expect(props?.expectedBaselinePx).toBe(150);
    expect(props?.horizontalTargets.find((target) => target.label === 'original position')?.pos).toBe(130);
  });

  it('converts the commit baseline through the rotation-aware viewport, not page-height subtraction', async () => {
    const rotated = { ...viewport, convertToViewportPoint: (x: number, y: number) => [800 - y, x] } as PageViewport;
    renderOverlay(undefined, rotated);
    const props = await openEditor(/^Text actions: Heading$/);
    expect(props?.expectedBaselinePx).toBe(20);
  });

  it('reopens Add Text at its saved baseline and carries the existing size-dependent commit rule', async () => {
    mocks.edits = [{ id: 'added', kind: 'text', origin: 'free', pageIndex: 0, z: 2,
      text: 'Added heading', boxText: 'Added heading', boxHeight: 40, style,
      rect: { x: 40, y: 500, w: 180, h: 20 } }];
    renderOverlay();
    fireEvent.click(await screen.findByRole('button', { name: 'Edit added text: Added heading' }));
    await screen.findByTestId('captured-text-editor');
    expect(mocks.editorProps?.expectedBaselinePx).toBe(300);
    expect(mocks.editorProps?.baselineFontSizeSlopePx).toBe(1);
  });
});

describe('OverlayLayer text click targets', () => {
  it('retains inline smart-action hit targets without painting committed glyphs twice', async () => {
    mocks.edits=[{id:'saved',kind:'text',origin:'free',pageIndex:0,z:2,text:'Arrive 23 September 2026',style,
      rect:{x:40,y:500,w:200,h:20}}];
    renderOverlay({state:'committed',renderedEditIds:new Set(['saved']),begin:vi.fn(),warm:vi.fn(),cancel:vi.fn(),commit:vi.fn(),suspend:vi.fn()});
    const word=await screen.findByRole('button',{name:'Date actions: 23 September 2026'});
    expect(word.parentElement?.style.webkitTextFillColor).toBe('transparent');
  });
  it('keeps a dense page target band below the editor while preserving area order', async () => {
    mocks.blocks = Array.from({ length: 40 }, (_, index) => ({
      ...textBlock,
      text: `Target ${index + 1}`,
      rect: { x: 100, y: 650, w: 41 + index, h: 10 },
      topBaselineY: 650,
    }));

    renderOverlay();

    const targets = await screen.findAllByRole('button', { name: /^Text actions: Target / });
    expect(targets).toHaveLength(40);
    expect(Math.max(...targets.map((target) => Number(target.style.zIndex)))).toBeLessThan(50);

    const smaller = screen.getByRole('button', { name: 'Text actions: Target 21' });
    const larger = screen.getByRole('button', { name: 'Text actions: Target 31' });
    expect(Number(smaller.style.zIndex)).toBeGreaterThan(Number(larger.style.zIndex));
  });

  it('removes click targets for an open edit session and restores them when it closes', async () => {
    renderOverlay();

    await openEditor(/^Text actions: Heading$/);
    expect(screen.queryByRole('button', { name: /^Text actions:/ })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Close captured editor' }));
    expect(await screen.findByRole('button', { name: /^Text actions: Heading$/ })).toBeDefined();
  });

  it.each([
    ['right', { x: 506.1, y: 650, w: 48.1, h: 20 }, 36, 524, 463.5, 96.5],
    ['center', { x: 356.7, y: 650, w: 134, h: 20 }, 240, 366.4, 356.7, 134],
  ] as const)(
    'uses the recorded %s-aligned display box without changing committed geometry',
    async (align, rect, alignLeftPt, alignWidthPt, boxLeftPt, boxWidthPt) => {
      const source: TextBlock = {
        ...textBlock,
        text: 'Edited value',
        rect,
        topBaselineY: rect.y,
        align,
        alignLeftPt,
        alignWidthPt,
      };
      const built = buildTextBlockEdits(source, {
        text: 'Changed value',
        style,
        width: boxWidthPt,
        height: rect.h,
        dx: 0,
        dy: 0,
        align,
        alignLeftPt,
        alignWidthPt,
        boxLeftPt,
        boxWidthPt,
      }, ['Changed value'], 1, { x: rect.x, topBaselineY: rect.y });
      expect(built.texts[0]).toMatchObject({
        rect: { x: alignLeftPt, w: alignWidthPt },
        align,
        alignLeftPt,
        alignWidthPt,
        boxLeftPt,
        boxWidthPt,
      });
      const neighbour: TextBlock = {
        ...textBlock,
        text: `${align} neighbour`,
        rect: { x: alignLeftPt + 20, y: rect.y, w: 40, h: rect.h },
        topBaselineY: rect.y,
      };
      mocks.blocks = [neighbour, source];
      mocks.edits = [...built.covers, ...built.texts];

      renderOverlay();

      const target = await screen.findByRole('button', {
        name: /^Text actions for edited text: Changed value$/,
      });
      expect(Number.parseFloat(target.style.left)).toBeCloseTo(boxLeftPt, 5);
      expect(Number.parseFloat(target.style.width)).toBeCloseTo(boxWidthPt, 5);
      if (align === 'center') {
        expect(Number.parseFloat(target.style.left)).toBeGreaterThan(alignLeftPt);
        expect(
          Number.parseFloat(target.style.left) + Number.parseFloat(target.style.width),
        ).toBeLessThan(alignLeftPt + alignWidthPt);
      }
      const neighbourTarget = screen.getByRole('button', {
        name: `Text actions: ${align} neighbour`,
      });
      const point = centreOf(neighbourTarget);
      expect(targetAt(point.x, point.y)).toBe(neighbourTarget);
    },
  );

  it('keeps old saved edits usable and lets a smaller plain target win inside their wide region', async () => {
    const year: TextBlock = {
      ...textBlock,
      text: '2022-2025',
      rect: { x: 506.1, y: 650, w: 48.1, h: 20 },
      topBaselineY: 650,
      align: 'right',
      alignLeftPt: 36,
      alignWidthPt: 524,
    };
    const school: TextBlock = {
      ...textBlock,
      text: 'JECRC University, Jaipur. Rajasthan',
      rect: { x: 172.5, y: 650, w: 170.1, h: 20 },
      topBaselineY: 650,
    };
    const legacy = buildTextBlockEdits(year, {
      text: '2022-2026', style, width: 96.5, height: 20, dx: 0, dy: 0,
      align: 'right', alignLeftPt: 36, alignWidthPt: 524,
    }, ['2022-2026'], 1, { x: year.rect.x, topBaselineY: year.rect.y });
    mocks.blocks = [school, year];
    mocks.edits = [...legacy.covers, ...legacy.texts];

    renderOverlay();

    const edited = await screen.findByRole('button', {
      name: /^Text actions for edited text: 2022-2026$/,
    });
    expect(edited.style.left).toBe('36px');
    expect(edited.style.width).toBe('524px');
    const schoolTarget = screen.getByRole('button', {
      name: /^Text actions: JECRC University, Jaipur\. Rajasthan$/,
    });
    const point = centreOf(schoolTarget);
    const winner = targetAt(point.x, point.y);
    expect(winner).toBe(schoolTarget);

    fireEvent.click(winner!);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Edit' }));
    expect(mocks.editorProps?.block.text).toBe(school.text);
  });

  it('lets a small neighbour win inside a deliberately widened left-aligned edit', async () => {
    const source: TextBlock = {
      ...textBlock,
      text: 'Wide edit',
      rect: { x: 40, y: 650, w: 140, h: 20 },
      topBaselineY: 650,
    };
    const neighbour: TextBlock = {
      ...textBlock,
      text: 'Small',
      rect: { x: 220, y: 650, w: 45, h: 20 },
      topBaselineY: 650,
    };
    const widened = buildTextBlockEdits(source, {
      text: 'Wider edited text', style, width: 300, height: 20, dx: 0, dy: 0,
      boxLeftPt: 40, boxWidthPt: 300,
    }, ['Wider edited text'], 1, { x: source.rect.x, topBaselineY: source.rect.y });
    mocks.blocks = [source, neighbour];
    mocks.edits = [...widened.covers, ...widened.texts];

    renderOverlay();

    const edited = await screen.findByRole('button', {
      name: /^Text actions for edited text: Wider edited text$/,
    });
    expect(edited.style.left).toBe('40px');
    expect(edited.style.width).toBe('300px');
    const smallTarget = screen.getByRole('button', { name: /^Text actions: Small$/ });
    const point = centreOf(smallTarget);
    expect(targetAt(point.x, point.y)).toBe(smallTarget);
  });

  it('keeps a divider above an equal-area text target', async () => {
    mocks.blocks = [{
      ...textBlock,
      text: 'Equal area',
      rect: { x: 100, y: 650, w: 13, h: 12 },
      topBaselineY: 650,
    }];
    mocks.ruleLines = [{
      pageIndex: 0,
      orientation: 'horizontal',
      x1: 100.5,
      y1: 656,
      x2: 112.5,
      y2: 656,
      thicknessPt: 1,
      color: { r: 0, g: 0, b: 0 },
    }];

    renderOverlay();

    const divider = await screen.findByRole('button', { name: 'Edit horizontal divider line' });
    const text = screen.getByRole('button', { name: /^Text actions: Equal area$/ });
    expect(Number(divider.style.zIndex)).toBeGreaterThan(Number(text.style.zIndex));
  });
});

describe.skipIf(!task74RealEnabled)('OverlayLayer Task 74 real click targets', () => {
  it('keeps every education-row piece reachable after committing the year edit', async () => {
    const [{ getDocument }, textContent, ruleLines] = await Promise.all([
      import('pdfjs-dist/legacy/build/pdf.mjs'),
      vi.importActual<typeof import('@/lib/pdf/textContent')>('@/lib/pdf/textContent'),
      vi.importActual<typeof import('@/lib/pdf/ruleLines')>('@/lib/pdf/ruleLines'),
    ]);
    const document = await getDocument({
      data: new Uint8Array(await readFile(task74Fixture)),
      verbosity: 0,
    }).promise;
    try {
      const page = await document.getPage(1);
      const [runs, detectedRules] = await Promise.all([
        textContent.extractTextRuns(page, 0),
        ruleLines.detectRuleLines(page, 0),
      ]);
      const blocks = textContent.groupRunsIntoBlocks(runs, { ruleLines: detectedRules });
      const year = blocks.find((block) => block.text === '2022-2025');
      expect(year, 'Rishi year cell').toBeDefined();
      if (!year) return;
      const built = buildTextBlockEdits(year, {
        text: '2022-2026',
        style: year.style,
        width: 96.5,
        height: 20,
        dx: 0,
        dy: 0,
        align: year.align,
        alignLeftPt: year.alignLeftPt,
        alignWidthPt: year.alignWidthPt,
        boxLeftPt: 463.5,
        boxWidthPt: 96.5,
      }, ['2022-2026'], 1);
      mocks.blocks = blocks;
      mocks.edits = [...built.covers, ...built.texts];

      renderOverlay();

      const edited = await screen.findByRole('button', {
        name: /^Text actions for edited text: 2022-2026$/,
      });
      expect(Number.parseFloat(edited.style.left)).toBeCloseTo(463.5, 0);
      expect(
        Number.parseFloat(edited.style.left) + Number.parseFloat(edited.style.width),
      ).toBeCloseTo(560, 0);
      for (const label of [
        'JECRC University, Jaipur. Rajasthan',
        '8.80 CGPA',
        'BBA - General',
      ]) {
        const target = screen.getByRole('button', { name: `Text actions: ${label}` });
        const point = centreOf(target);
        expect(targetAt(point.x, point.y), `${label} click target`).toBe(target);
      }
    } finally {
      await document.destroy();
    }
  }, 60_000);
});

it('shows bullet-list actions for a text block marked by filled shape dots', async () => {
  const lines = [0, 1, 2].map((index) => {
    const baselineY = 700 - index * 24;
    return {
      pageIndex: 0,
      text: `Shape item ${index + 1}`,
      rect: { x: 50, y: baselineY, w: 140, h: 20 },
      baselineY,
      style,
      runs: [],
    };
  });
  mocks.blocks = [{
    pageIndex: 0,
    text: lines.map((line) => line.text).join('\n'),
    rect: { x: 50, y: 652, w: 140, h: 68 },
    topBaselineY: 700,
    lineHeightPt: 24,
    style,
    lines,
  }];
  mocks.graphicRegions = {
    imageRegions: [],
    shapeMarkerRegions: lines.map((line) => ({
      pageIndex: 0,
      rect: { x: 38, y: line.baselineY + 5, w: 5, h: 5 },
    })),
  };

  renderOverlay();

  expect(await screen.findByRole('button', {
    name: /^Bullet list actions: • Shape item 1 • Shape item 2 • Shape item 3$/,
  })).toBeDefined();
  const props = await openEditor(/^Bullet list actions: • Shape item 1/);
  expect(props?.expectedBaselinePx).toBe(100);
});
