/** @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TextEdit } from '@/lib/export/types';
import type { TextBlock } from '@/lib/pdf/textContent';
import { widestLineWidth } from '@/lib/edit/paragraphSeed';
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

function paragraph(...texts: string[]): TextBlock {
  const value = block(texts.join('\n'), 24);
  return {
    ...value,
    lines: texts.map((text, index) => ({
      pageIndex: 0,
      text,
      rect: { x: 40, y: 680 - index * 24, w: 240, h: 20 },
      baselineY: 680 - index * 24,
      style,
      runs: [],
    })),
  };
}

interface RenderEditorOptions {
  readonly existing?: readonly TextEdit[];
  readonly bulletMode?: { readonly items: readonly string[]; readonly maxHeightPt: number };
  readonly onDone?: ReturnType<typeof vi.fn>;
  readonly onCancel?: ReturnType<typeof vi.fn>;
  readonly measureTextWidth?: (line: string) => number;
}

function renderEditor(
  value: TextBlock,
  zoom = 1,
  topCorrectionPx = 0,
  options: RenderEditorOptions = {},
) {
  return render(
    <TextEditOverlay
      block={value}
      existing={options.existing}
      screenRect={{ left: 40, top: 100, width: 240, height: value.rect.h }}
      topCorrectionPx={topCorrectionPx}
      zoom={zoom}
      pageWidthPt={600}
      pageSizePx={{ width: 600, height: 800 }}
      backgroundColor="white"
      verticalTargets={[]}
      horizontalTargets={[]}
      bulletMode={options.bulletMode}
      measureTextWidth={options.measureTextWidth}
      onMoveStateChange={vi.fn()}
      onDone={options.onDone ?? vi.fn()}
      onCancel={options.onCancel ?? vi.fn()}
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

describe('TextEditOverlay paragraph seed', () => {
  it('opens a multi-line source paragraph as flowing text without newlines', () => {
    renderEditor(paragraph('A number of Postgraduate', 'Departments serve students', 'across the region'));

    const editor = screen.getByRole('textbox', { name: 'Editable text' });
    expect(editor.textContent).toBe(
      'A number of Postgraduate Departments serve students across the region',
    );
    expect(editor.textContent).not.toContain('\n');
  });

  it('keeps the bullet-list seed unchanged', () => {
    renderEditor(paragraph('First item', 'Second item'), 1, 0, {
      bulletMode: { items: ['First item', 'Second item'], maxHeightPt: 200 },
    });

    expect(screen.getByRole('textbox', { name: 'Editable bullet list' }).innerHTML)
      .toBe('• First item<br>• Second item');
  });

  it('re-opens an edited block from boxText instead of reseeding the source paragraph', () => {
    const existing: TextEdit = {
      id: 'saved-line',
      kind: 'text',
      pageIndex: 0,
      rect: { x: 40, y: 650, w: 240, h: 20 },
      z: 2,
      text: 'Wrapped saved line',
      style,
      boxText: 'Saved flowing paragraph value',
      boxHeight: 24,
    };

    renderEditor(paragraph('Source line one', 'Source line two'), 1, 0, { existing: [existing] });

    expect(screen.getByRole('textbox', { name: 'Editable text' }).textContent)
      .toBe('Saved flowing paragraph value');
  });
});

describe('TextEditOverlay width measurement', () => {
  it('measures the widest displayed line instead of summing every line', () => {
    expect(widestLineWidth('short\nthe longest\nmedium', (line) => line.length * 6)).toBe(66);
  });

  it('keeps a six-line paragraph at its own width instead of the page bound', () => {
    const source = paragraph(
      'A number of Postgraduate Departments',
      'serve students across the region',
      'from one campus',
      'with another line',
      'and one more line',
      'before the end',
    );
    const value = { ...source, rect: { ...source.rect, w: 300 } };

    renderEditor(value, 1, 0, { measureTextWidth: (line) => line.length * 6 });

    const frame = screen.getByRole('textbox', { name: 'Editable text' }).parentElement;
    expect(frame?.style.width).toBe('300px');
    expect(frame?.style.width).not.toBe('555px');
  });

  it('still gives a single long line its small measurement padding', () => {
    const source = block('12345678901234567890', 24);
    const value = { ...source, rect: { ...source.rect, w: 80 } };

    renderEditor(value, 1, 0, { measureTextWidth: (line) => line.length * 6 });

    expect(screen.getByRole('textbox', { name: 'Editable text' }).parentElement?.style.width)
      .toBe('123px');
  });

  it('does not use line measurement for alignment columns or bullets', () => {
    const measureTextWidth = vi.fn((line: string) => line.length * 6);
    const aligned = { ...paragraph('Centred', 'paragraph'), align: 'center' as const, alignWidthPt: 210 };
    const alignedRender = renderEditor(aligned, 1, 0, { measureTextWidth });
    expect(screen.getByRole('textbox', { name: 'Editable text' }).parentElement?.style.width)
      .toBe('210px');
    alignedRender.unmount();

    renderEditor(paragraph('First item', 'Second item'), 1, 0, {
      bulletMode: { items: ['First item', 'Second item'], maxHeightPt: 200 },
      measureTextWidth,
    });
    expect(screen.getByRole('textbox', { name: 'Editable bullet list' }).parentElement?.style.width)
      .toBe('240px');
    expect(measureTextWidth).not.toHaveBeenCalled();
  });

  it('re-opens at the width of wrapped edits instead of their long boxText', () => {
    const flowing = 'One long flowing paragraph value that must not set the editor width';
    const existing: TextEdit[] = [
      {
        id: 'wrapped-1',
        kind: 'text',
        pageIndex: 0,
        rect: { x: 40, y: 680, w: 140, h: 20 },
        z: 1,
        text: 'One wrapped line',
        style,
        boxText: flowing,
        boxHeight: 48,
      },
      {
        id: 'wrapped-2',
        kind: 'text',
        pageIndex: 0,
        rect: { x: 40, y: 656, w: 132, h: 20 },
        z: 2,
        text: 'and another line',
        style,
        boxText: flowing,
        boxHeight: 48,
      },
    ];
    const source = paragraph('Original source', 'paragraph lines');
    const value = { ...source, rect: { ...source.rect, w: 100 } };

    renderEditor(value, 1, 0, { existing, measureTextWidth: (line) => line.length * 6 });

    const editor = screen.getByRole('textbox', { name: 'Editable text' });
    expect(editor.textContent).toBe(flowing);
    expect(editor.parentElement?.style.width).toBe('140px');
  });
});

describe('TextEditOverlay unchanged guard', () => {
  it('closes without committing when Done is pressed without a change', () => {
    const onDone = vi.fn();
    const onCancel = vi.fn();
    renderEditor(paragraph('A flowing', 'paragraph'), 1, 0, { onDone, onCancel });

    fireEvent.click(screen.getByRole('button', { name: 'Done' }));

    expect(onDone).not.toHaveBeenCalled();
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it('commits after changing one character', () => {
    const onDone = vi.fn();
    const onCancel = vi.fn();
    renderEditor(block('Heading', 24), 1, 0, { onDone, onCancel });
    const editor = screen.getByRole('textbox', { name: 'Editable text' });
    editor.textContent = 'Heading!';
    fireEvent.input(editor);

    fireEvent.click(screen.getByRole('button', { name: 'Done' }));

    expect(onDone).toHaveBeenCalledOnce();
    expect(onDone.mock.calls[0]?.[0]).toMatchObject({ text: 'Heading!' });
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('Cancel closes without committing', () => {
    const onDone = vi.fn();
    const onCancel = vi.fn();
    renderEditor(block('Heading', 24), 1, 0, { onDone, onCancel });

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(onDone).not.toHaveBeenCalled();
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it('leaves an existing edit untouched when Done is unchanged', () => {
    const onDone = vi.fn();
    const onCancel = vi.fn();
    const existing: TextEdit = {
      id: 'keep-this-id',
      kind: 'text',
      pageIndex: 0,
      rect: { x: 40, y: 650, w: 240, h: 20 },
      z: 7,
      text: 'Already edited',
      style,
      boxText: 'Already edited',
      boxHeight: 24,
    };
    renderEditor(block('Original', 24), 1, 0, { existing: [existing], onDone, onCancel });

    fireEvent.click(screen.getByRole('button', { name: 'Done' }));

    expect(onDone).not.toHaveBeenCalled();
    expect(onCancel).toHaveBeenCalledOnce();
    expect(existing).toMatchObject({ id: 'keep-this-id', z: 7 });
  });
});
