/** @vitest-environment jsdom */

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TextBlock } from '@/lib/pdf/textContent';
import { TextEditOverlay } from './TextEditOverlay';

const style = {
  fontName: 'Helvetica',
  fontSizePt: 20,
  bold: false,
  italic: false,
  color: { r: 0, g: 0, b: 0 },
};

function block(text: string, lineHeightPt: number): TextBlock {
  return {
    pageIndex: 0,
    text,
    rect: { x: 40, y: 650, w: 240, h: text.includes('\n') ? 70 : 20 },
    topBaselineY: 680,
    lineHeightPt,
    style,
    lines: [],
  };
}

function renderEditor(value: TextBlock, zoom = 1, topCorrectionPx = 0) {
  return render(
    <TextEditOverlay
      block={value}
      screenRect={{ left: 40, top: 100, width: 240, height: value.rect.h }}
      topCorrectionPx={topCorrectionPx}
      zoom={zoom}
      pageWidthPt={600}
      pageSizePx={{ width: 600, height: 800 }}
      backgroundColor="white"
      verticalTargets={[]}
      horizontalTargets={[]}
      onMoveStateChange={vi.fn()}
      onDone={vi.fn()}
      onCancel={vi.fn()}
    />,
  );
}

beforeEach(() => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    font: '',
    measureText: (text: string) => ({ width: text.length * 10 }),
  } as unknown as CanvasRenderingContext2D);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('TextEditOverlay first-line placement', () => {
  it.each([
    ['a committed single-line heading', block('Heading', 30), 1, -5],
    ['a committed three-line paragraph', block('First\nSecond\nThird', 26), 1.5, -4.5],
  ])('matches the preview baseline for %s', (_label, value, zoom, expectedTop) => {
    renderEditor(value, zoom);

    const editor = screen.getByRole('textbox', { name: 'Editable text' });
    const offset = Number.parseFloat(editor.style.top);
    const cssHalfLeading = (value.lineHeightPt - value.style.fontSizePt) * zoom / 2;
    expect(offset).toBeCloseTo(expectedTop, 5);
    expect(offset + cssHalfLeading).toBeCloseTo(0, 5);
  });

  it('keeps a fresh block on its PDF baseline while its box retains the ink-top correction', () => {
    const value = block('Heading', 30);
    renderEditor(value, 1, 12);

    const editor = screen.getByRole('textbox', { name: 'Editable text' });
    const offset = Number.parseFloat(editor.style.top);
    const cssHalfLeading = (value.lineHeightPt - value.style.fontSizePt) / 2;
    expect(offset).toBe(-17);
    expect(12 + offset + cssHalfLeading).toBe(0);
  });
});
