/** @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PageViewport, PDFPageProxy } from 'pdfjs-dist';
import type { Edit } from '@/lib/export/types';
import type { ScreenRect } from '@/lib/export/coordinates';
import type { SnapTarget } from '@/lib/edit/moveSnap';
import type { TextBlock } from '@/lib/pdf/textContent';
import type { ImageRegion } from '@/lib/pdf/images';
import { coverRectForTextBlock } from '@/lib/edit/buildTextEdits';
import { OverlayLayer } from './OverlayLayer';

interface CapturedEditorProps {
  readonly screenRect: ScreenRect;
  readonly topCorrectionPx?: number;
  readonly horizontalTargets: readonly SnapTarget[];
}

const mocks = vi.hoisted(() => ({
  edits: [] as Edit[],
  blocks: [] as TextBlock[],
  graphicRegions: {
    imageRegions: [] as ImageRegion[],
    shapeMarkerRegions: [] as ImageRegion[],
  },
  editorProps: undefined as CapturedEditorProps | undefined,
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
    replaceEdits: vi.fn(),
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
    groupRunsIntoBlocks: vi.fn(() => mocks.blocks),
  };
});

vi.mock('@/lib/pdf/images', () => ({
  detectImages: vi.fn(async () => []),
}));

vi.mock('@/lib/pdf/shapeMarkers', () => ({
  detectPageGraphicRegions: vi.fn(async () => mocks.graphicRegions),
}));

vi.mock('@/lib/pdf/ruleLines', () => ({
  detectRuleLines: vi.fn(async () => []),
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
    return <div data-testid="captured-text-editor" data-top={props.screenRect.top} />;
  },
}));

vi.mock('./ImageOverlay', () => ({ ImageOverlay: () => null }));
vi.mock('./SmartSpanLayer', () => ({ SmartSpanLayer: () => null }));
vi.mock('./LineEditOverlay', () => ({ LineEditOverlay: () => null }));

function renderOverlay() {
  render(
    <OverlayLayer
      page={{ view: [0, 0, 600, 800] } as unknown as PDFPageProxy}
      pageIndex={0}
      viewport={viewport}
      dpr={1}
      zoom={1}
      editMode
      textAddMode={false}
      imageMode={false}
      peek={false}
      locations={[]}
      locationNames={[]}
    />,
  );
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
  mocks.graphicRegions = { imageRegions: [], shapeMarkerRegions: [] };
  mocks.editorProps = undefined;
});

afterEach(cleanup);

describe('OverlayLayer editor top correction', () => {
  it('keeps the 12px source-ink correction when a block is opened for the first time', async () => {
    renderOverlay();
    const props = await openEditor(/^Text actions: Heading$/);

    expect(props?.screenRect.top).toBe(92);
    expect(props?.topCorrectionPx).toBe(12);
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
    expect(props?.horizontalTargets.find((target) => target.label === 'original position')?.pos).toBe(130);
  });
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
});
