/** @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import type { TextEdit } from '@/lib/export/types';
import type { TextBlock } from '@/lib/pdf/textContent';
import { buildTextBlockEdits } from '@/lib/edit/buildTextEdits';
import { widestLineWidth } from '@/lib/edit/paragraphSeed';
import { detectRuleLines } from '@/lib/pdf/ruleLines';
import { extractTextRuns, groupRunsIntoBlocks } from '@/lib/pdf/textContent';
import { TextEditOverlay } from './TextEditOverlay';

const task74Fixture = 'tmp/compress-tests/rishi-ilovepdf.pdf';
const task74RealEnabled = process.env.TASK74_REAL === '1' && existsSync(task74Fixture);
if (!task74RealEnabled) {
  process.stdout.write(
    'Task 74 real re-edit box check skipped: set TASK74_REAL=1 with rishi-ilovepdf.pdf present.\n',
  );
}

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
  readonly blocks?: readonly TextBlock[];
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
      blocks={options.blocks}
      existing={options.existing}
      screenRect={{ left: (options.existing?.[0]?.alignLeftPt ?? value.alignLeftPt ?? value.rect.x) * zoom, top: 100, width: 240, height: value.rect.h }}
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

function placeCaretAtTextEnd(node: Node): void {
  const range = document.createRange();
  range.setStart(node, node.textContent?.length ?? 0);
  range.collapse(true);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

function selectText(node: Node, start: number, end: number): void {
  const range = document.createRange();
  range.setStart(node, start);
  range.setEnd(node, end);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
  document.dispatchEvent(new Event('selectionchange'));
}

function installFormattingCommandMock(): void {
  vi.mocked(document.queryCommandState).mockImplementation((command) => {
    const selection = window.getSelection();
    const range = selection?.rangeCount ? selection.getRangeAt(0) : undefined;
    const container = range?.startContainer;
    const element = container?.nodeType === Node.ELEMENT_NODE
      ? container as HTMLElement
      : container?.parentElement;
    if (!element) return false;
    const computed = window.getComputedStyle(element);
    if (command === 'bold') {
      return computed.fontWeight === 'bold' || Number.parseInt(computed.fontWeight, 10) >= 600;
    }
    if (command === 'italic') return computed.fontStyle === 'italic' || computed.fontStyle === 'oblique';
    return false;
  });
  vi.mocked(document.execCommand).mockImplementation((command) => {
    if (command !== 'bold' && command !== 'italic') return false;
    const selection = window.getSelection();
    const range = selection?.rangeCount ? selection.getRangeAt(0) : undefined;
    if (!selection || !range || range.collapsed) return false;
    const active = document.queryCommandState(command);
    const wrapper = document.createElement('span');
    if (command === 'bold') wrapper.style.fontWeight = active ? 'normal' : 'bold';
    if (command === 'italic') wrapper.style.fontStyle = active ? 'normal' : 'italic';
    wrapper.append(range.extractContents());
    range.insertNode(wrapper);
    const selected = document.createRange();
    selected.selectNodeContents(wrapper);
    selection.removeAllRanges();
    selection.addRange(selected);
    return true;
  });
}

beforeEach(() => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    font: '',
    measureText: (text: string) => ({ width: text.length * 10 }),
  } as unknown as CanvasRenderingContext2D);
  Object.defineProperty(document, 'queryCommandState', {
    configurable: true,
    value: vi.fn(() => false),
  });
  Object.defineProperty(document, 'execCommand', {
    configurable: true,
    value: vi.fn(() => false),
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  Reflect.deleteProperty(document, 'queryCommandState');
  Reflect.deleteProperty(document, 'execCommand');
});

describe('native input during preview preparation', () => {
  it.each(['clean', 'legacy'] as const)('preserves the focused DOM and composition when preparation becomes %s', (mode) => {
    const onDone = vi.fn();
    const make = (previewMode: 'preparing' | 'clean' | 'legacy', committing = false) => (
      <TextEditOverlay block={block('Heading', 24)} screenRect={{left:40,top:100,width:240,height:20}}
        zoom={1} pageWidthPt={600} pageSizePx={{width:600,height:800}} backgroundColor="white"
        verticalTargets={[]} horizontalTargets={[]} onMoveStateChange={vi.fn()}
        onDone={onDone} onCancel={vi.fn()} previewMode={previewMode} committing={committing} />
    );
    const view = render(make('preparing'));
    const editor = screen.getByRole('textbox', {name:'Editable text'});
    expect(document.activeElement).toBe(editor);
    expect(editor.style.webkitTextFillColor).toBe('transparent');
    fireEvent.compositionStart(editor);
    editor.textContent = 'English नमस्ते தமிழ்';
    fireEvent.input(editor);
    placeCaretAtTextEnd(editor.firstChild!);
    const anchor = window.getSelection()?.anchorNode;
    view.rerender(make(mode));
    expect(screen.getByRole('textbox', {name:'Editable text'})).toBe(editor);
    expect(document.activeElement).toBe(editor);
    expect(window.getSelection()?.anchorNode).toBe(anchor);
    expect(editor.textContent).toBe('English नमस्ते தமிழ்');
    fireEvent.click(screen.getByRole('button', {name:'Done'}));
    expect(onDone).not.toHaveBeenCalled();
    fireEvent.compositionEnd(editor);
    fireEvent.click(screen.getByRole('button', {name:'Done'}));
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(onDone.mock.calls[0]?.[0].text).toBe('English नमस्ते தமிழ்');
    view.rerender(make(mode, true));
    expect(editor.getAttribute('contenteditable')).toBe('false');
    expect(screen.getByRole('button', {name:'Done'}).hasAttribute('disabled')).toBe(true);
    expect(editor.textContent).toBe('English नमस्ते தமிழ்');
  });
});

describe('TextEditOverlay appearance controls', () => {
  it('shows the source text colour in the toolbar swatch', () => {
    renderEditor({
      ...block('White heading', 24),
      style: { ...style, color: { r: 1, g: 1, b: 1 } },
    });

    const swatch = screen.getByRole('button', { name: 'Text colour' }).firstElementChild as HTMLElement;
    expect(swatch.style.backgroundColor).toBe('rgb(255, 255, 255)');
  });

  it('applies a chosen colour only to the selected words', () => {
    const onDone = vi.fn();
    renderEditor(block('black red', 24), 1, 0, { onDone });
    const editor = screen.getByRole('textbox', { name: 'Editable text' });
    selectText(editor.firstChild!, 6, 9);

    fireEvent.click(screen.getByRole('button', { name: 'Text colour' }));
    fireEvent.click(screen.getByRole('button', { name: 'Use #d91a1a text colour' }));
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));

    expect(onDone).toHaveBeenCalledOnce();
    expect(onDone.mock.calls[0]?.[0].spans).toEqual([
      expect.objectContaining({ text: 'black ' }),
      expect.objectContaining({ text: 'red', color: { r: 0.85, g: 0.1, b: 0.1 } }),
    ]);
  });

  it('applies a chosen colour to the whole box when the caret is collapsed', () => {
    const onDone = vi.fn();
    renderEditor(block('whole box', 24), 1, 0, { onDone });

    fireEvent.click(screen.getByRole('button', { name: 'Text colour' }));
    fireEvent.click(screen.getByRole('button', { name: 'Use #1a59d9 text colour' }));
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));

    expect(onDone.mock.calls[0]?.[0]).toMatchObject({
      style: { color: { r: 0.1, g: 0.35, b: 0.85 }, colorKnown: true },
    });
    expect(onDone.mock.calls[0]?.[0].spans).toBeUndefined();
  });

  it('requires an explicit colour before changing unsupported source paint', () => {
    const onDone = vi.fn();
    renderEditor({
      ...block('Unknown paint', 24),
      style: { ...style, colorKnown: false },
    }, 1, 0, { onDone });
    const editor = screen.getByRole('textbox', { name: 'Editable text' });
    editor.textContent = 'Changed paint';
    fireEvent.input(editor);

    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(onDone).not.toHaveBeenCalled();
    expect(screen.getByText('Choose a text colour before finishing this edit.')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Text colour' }));
    fireEvent.click(screen.getByRole('button', { name: 'Use #000000 text colour' }));
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(onDone).toHaveBeenCalledOnce();
  });

  it.each([
    ['bold', 'B'],
    ['italic', 'I'],
  ] as const)('commits %s toggled at a collapsed caret to the whole box', (property, button) => {
    const onDone = vi.fn();
    renderEditor(block('whole box', 24), 1, 0, { onDone });

    fireEvent.click(screen.getByRole('button', { name: button }));
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));

    expect(onDone.mock.calls[0]?.[0].style[property]).toBe(true);
    expect(onDone.mock.calls[0]?.[0].spans).toBeUndefined();
  });

  it.each([
    ['bold', 'B'],
    ['italic', 'I'],
  ] as const)('commits %s turned on for a selection as rich spans', (property, button) => {
    installFormattingCommandMock();
    const onDone = vi.fn();
    renderEditor(block('plain styled', 24), 1, 0, { onDone });
    const editor = screen.getByRole('textbox', { name: 'Editable text' });
    selectText(editor.firstChild!, 6, 12);

    fireEvent.click(screen.getByRole('button', { name: button }));
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));

    expect(onDone.mock.calls[0]?.[0].spans).toEqual([
      expect.objectContaining({ text: 'plain ', [property]: false }),
      expect.objectContaining({ text: 'styled', [property]: true }),
    ]);
  });

  it.each([
    ['bold', 'B'],
    ['italic', 'I'],
  ] as const)('commits %s turned off for a selection as rich spans', (property, button) => {
    installFormattingCommandMock();
    const onDone = vi.fn();
    renderEditor({
      ...block('strong plain', 24),
      style: { ...style, [property]: true },
    }, 1, 0, { onDone });
    const editor = screen.getByRole('textbox', { name: 'Editable text' });
    selectText(editor.firstChild!, 7, 12);

    fireEvent.click(screen.getByRole('button', { name: button }));
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));

    expect(onDone.mock.calls[0]?.[0].spans).toEqual([
      expect.objectContaining({ text: 'strong ', [property]: true }),
      expect.objectContaining({ text: 'plain', [property]: false }),
    ]);
  });
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
  it.each(['right', 'center'] as const)('keeps three %s display lines at their own width', (align) => {
    const onDone = vi.fn();
    const onCancel = vi.fn();
    renderEditor({ ...paragraph('First', 'Second', 'Third'), align, alignLeftPt: 10, alignWidthPt: 500 }, 1, 0, {
      onDone, onCancel, measureTextWidth: (line) => line.length * 6,
    });
    const editor = screen.getByRole('textbox', { name: 'Editable text' });
    expect(editor.innerHTML).toBe('First<br>Second<br>Third');
    expect(editor.parentElement?.style.width).toBe('240px');
    expect(editor.parentElement?.style.left).toBe('40px');
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(onDone).not.toHaveBeenCalled();
    expect(onCancel).toHaveBeenCalledOnce();
    editor.innerHTML = 'First!<br>Second<br>Third';
    fireEvent.input(editor);
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(onDone.mock.calls[0]?.[0]).toMatchObject({
      text: 'First!\nSecond\nThird', width: 240, align, alignLeftPt: 10, alignWidthPt: 500,
    });
  });

  it('keeps the move handle inside a right or centre box and outside a left one', () => {
    const right = renderEditor({ ...block('Email', 24), align: 'right', alignLeftPt: 68.2, alignWidthPt: 467.7 });
    const insideHandle = screen.getByRole('button', { name: 'Drag to move' });
    expect(insideHandle.style.left).toBe('0px');
    expect(insideHandle.style.top).toBe('0px');
    right.unmount();

    renderEditor(block('Heading', 24));
    const outsideHandle = screen.getByRole('button', { name: 'Drag to move' });
    expect(outsideHandle.style.left).toBe('-12px');
    expect(outsideHandle.style.top).toBe('-12px');
  });

  it('still reflows a left-aligned paragraph', () => {
    renderEditor({ ...paragraph('First', 'Second', 'Third'), align: 'left' });
    expect(screen.getByRole('textbox', { name: 'Editable text' }).textContent).toBe('First Second Third');
  });

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

  it('opens an inline-marker list as one editor line per item', () => {
    renderEditor(paragraph(
      '• First item wraps',
      'onto its continuation',
      '• Second item',
      '• Third item wraps',
      'onto another continuation',
    ));

    expect(screen.getByRole('textbox', { name: 'Editable text' }).innerHTML).toBe(
      '• First item wraps onto its continuation<br>• Second item<br>• Third item wraps onto another continuation',
    );
  });

  it('copies the current inline marker when Enter is pressed at an item end', () => {
    const onDone = vi.fn();
    renderEditor(paragraph('◦ First item', '◦ Second item'), 1, 0, { onDone });
    const editor = screen.getByRole('textbox', { name: 'Editable text' });
    const firstItem = editor.firstChild;
    expect(firstItem).not.toBeNull();
    placeCaretAtTextEnd(firstItem!);

    fireEvent.keyDown(editor, { key: 'Enter' });
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));

    expect(onDone.mock.calls[0]?.[0].text).toBe('◦ First item\n◦ \n◦ Second item');
  });

  it('inserts a plain newline for Enter in prose', () => {
    renderEditor(paragraph('Plain paragraph'));
    const editor = screen.getByRole('textbox', { name: 'Editable text' });
    placeCaretAtTextEnd(editor.firstChild!);

    fireEvent.keyDown(editor, { key: 'Enter' });

    expect(editor.textContent).toBe('Plain paragraph\n');
  });

  it('keeps bullet mode in charge of Enter', () => {
    const onDone = vi.fn();
    renderEditor(paragraph('First item', 'Second item'), 1, 0, {
      bulletMode: { items: ['First item', 'Second item'], maxHeightPt: 200 },
      onDone,
    });
    const editor = screen.getByRole('textbox', { name: 'Editable bullet list' });
    placeCaretAtTextEnd(editor.firstChild!);

    fireEvent.keyDown(editor, { key: 'Enter' });
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));

    expect(onDone.mock.calls[0]?.[0].text).toBe('• First item\n• \n• Second item');
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
    const aligned = { ...block('Centred', 24), align: 'center' as const, alignWidthPt: 300 };
    const alignedRender = renderEditor(aligned, 1, 0, { measureTextWidth });
    expect(screen.getByRole('textbox', { name: 'Editable text' }).parentElement?.style.width)
      .toBe('300px');
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
  it('re-opens a saved right-aligned table cell at the same neighbour-limited width', () => {
    const value = {
      ...block('2022-2025', 24),
      rect: { x: 506.1, y: 650, w: 48.1, h: 20 },
      align: 'right' as const,
      alignLeftPt: 36,
      alignWidthPt: 524,
    };
    const neighbour = {
      ...block('8.80 CGPA', 24),
      rect: { x: 400, y: 650, w: 63.5, h: 20 },
    };
    const firstOnDone = vi.fn();
    const first = renderEditor(value, 1, 0, { blocks: [neighbour, value], onDone: firstOnDone });
    const firstEditor = screen.getByRole('textbox', { name: 'Editable text' });
    const firstFrame = firstEditor.parentElement;
    expect(firstFrame?.style.left).toBe('463.5px');
    expect(firstFrame?.style.width).toBe('96.5px');
    firstEditor.textContent = '2022-2026';
    fireEvent.input(firstEditor);
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    const firstOutput = firstOnDone.mock.calls[0]?.[0];
    expect(firstOutput).toBeDefined();
    expect(firstOutput).toMatchObject({ boxLeftPt: 463.5, boxWidthPt: 96.5 });
    const existing = buildTextBlockEdits(
      value,
      firstOutput!,
      ['2022-2026'],
      1,
      { x: value.rect.x, topBaselineY: value.rect.y },
    ).texts;
    expect(existing[0]?.rect).toEqual({ x: 36, y: 650, w: 524, h: 20 });
    expect(existing[0]).toMatchObject({ boxLeftPt: 463.5, boxWidthPt: 96.5 });
    first.unmount();

    const onDone = vi.fn();
    const onCancel = vi.fn();
    renderEditor(value, 1, 0, {
      existing, blocks: [neighbour, value], onDone, onCancel,
    });
    const editor = screen.getByRole('textbox', { name: 'Editable text' });
    expect(editor.parentElement?.style.left).toBe('463.5px');
    expect(editor.parentElement?.style.width).toBe('96.5px');

    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(onDone).not.toHaveBeenCalled();
    expect(onCancel).toHaveBeenCalledOnce();

    editor.textContent = '2022-2027';
    fireEvent.input(editor);
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(onDone.mock.calls[0]?.[0]).toMatchObject({
      align: existing[0]?.align,
      alignLeftPt: existing[0]?.alignLeftPt,
      alignWidthPt: existing[0]?.alignWidthPt,
      boxLeftPt: 463.5,
      boxWidthPt: 96.5,
    });
  });

  it('limits a moved saved edit from its moved geometry and preserves its alignment metadata', () => {
    const value = {
      ...block('Original', 24),
      align: 'right' as const,
      alignLeftPt: 10,
      alignWidthPt: 500,
    };
    const existing = buildTextBlockEdits(value, {
      text: 'Moved', style, width: 240, height: 20, dx: 290, dy: 0,
      align: 'right', alignLeftPt: 10, alignWidthPt: 500,
    }, ['Moved'], 1, { x: value.rect.x, topBaselineY: value.rect.y }).texts;
    expect(existing[0]?.rect).toEqual({ x: 300, y: 650, w: 500, h: 20 });
    const right = { ...block('Right neighbour', 24), rect: { x: 650, y: 650, w: 90, h: 20 } };
    const onDone = vi.fn();
    const onCancel = vi.fn();
    renderEditor(value, 1, 0, { existing, blocks: [value, right], onDone, onCancel });
    const editor = screen.getByRole('textbox', { name: 'Editable text' });
    expect(editor.parentElement?.style.left).toBe('300px');
    expect(editor.parentElement?.style.width).toBe('350px');

    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(onDone).not.toHaveBeenCalled();
    expect(onCancel).toHaveBeenCalledOnce();

    editor.textContent = 'Moved!';
    fireEvent.input(editor);
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(onDone.mock.calls[0]?.[0]).toMatchObject({
      align: existing[0]?.align,
      alignLeftPt: existing[0]?.alignLeftPt,
      alignWidthPt: existing[0]?.alignWidthPt,
    });
  });

  it('keeps a saved alignment region when there is no neighbour on its row', () => {
    const value = {
      ...block('2022-2025', 24),
      rect: { x: 506.1, y: 650, w: 48.1, h: 20 },
      align: 'right' as const,
      alignLeftPt: 36,
      alignWidthPt: 524,
    };
    const existing: TextEdit = {
      id: 'saved-date', kind: 'text', pageIndex: 0, z: 2,
      rect: value.rect, text: value.text, boxText: value.text, boxHeight: 20, style,
      align: 'right', alignLeftPt: 36, alignWidthPt: 524,
    };
    renderEditor(value, 1, 0, { existing: [existing], blocks: [value] });
    const frame = screen.getByRole('textbox', { name: 'Editable text' }).parentElement;
    expect(frame?.style.left).toBe('36px');
    expect(frame?.style.width).toBe('524px');
  });

  it('leaves a saved left-aligned edit at its own rectangle', () => {
    const value = block('Original', 24);
    const existing: TextEdit = {
      id: 'saved-left', kind: 'text', pageIndex: 0, z: 2,
      rect: value.rect, text: 'Saved left', boxText: 'Saved left', boxHeight: 20, style,
      align: 'left',
    };
    const neighbour = { ...block('Neighbour', 24), rect: { x: 300, y: 650, w: 80, h: 20 } };
    renderEditor(value, 1, 0, { existing: [existing], blocks: [value, neighbour] });
    const frame = screen.getByRole('textbox', { name: 'Editable text' }).parentElement;
    expect(frame?.style.left).toBe('40px');
    expect(frame?.style.width).toBe('240px');
  });

  it.each(['right', 'center'] as const)(
    're-opens a saved multi-line %s edit at its own width',
    (align) => {
      const value = {
        ...paragraph('Source first', 'Source second'),
        align,
        alignLeftPt: 10,
        alignWidthPt: 500,
      };
      const existing: TextEdit[] = [
        {
          id: 'saved-1', kind: 'text', pageIndex: 0, z: 2,
          rect: { x: 100, y: 680, w: 200, h: 20 }, text: 'Saved first',
          boxText: 'Saved first\nSaved second', boxHeight: 48, style,
          align, alignLeftPt: 10, alignWidthPt: 500,
        },
        {
          id: 'saved-2', kind: 'text', pageIndex: 0, z: 3,
          rect: { x: 120, y: 656, w: 180, h: 20 }, text: 'Saved second',
          boxText: 'Saved first\nSaved second', boxHeight: 48, style,
          align, alignLeftPt: 10, alignWidthPt: 500,
        },
      ];
      renderEditor(value, 1, 0, { existing, blocks: [value] });
      const frame = screen.getByRole('textbox', { name: 'Editable text' }).parentElement;
      expect(frame?.style.left).toBe('100px');
      expect(frame?.style.width).toBe('200px');
    },
  );

  it('keeps a moved saved alignment region instead of clamping it to the original source block', () => {
    const onDone = vi.fn();
    const onCancel = vi.fn();
    const existing: TextEdit = {
      id: 'moved-right', kind: 'text', pageIndex: 0, z: 2,
      rect: { x: 300, y: 500, w: 200, h: 20 }, text: 'Moved', boxText: 'Moved', boxHeight: 24, style,
      align: 'right', alignLeftPt: 300, alignWidthPt: 200,
    };
    renderEditor({ ...block('Original', 24), align: 'right', alignLeftPt: 10, alignWidthPt: 500 }, 1, 0, {
      existing: [existing], blocks: [block('Old neighbour', 24)], onDone, onCancel,
    });
    const editor = screen.getByRole('textbox', { name: 'Editable text' });
    expect(editor.parentElement?.style.left).toBe('300px');
    expect(editor.parentElement?.style.width).toBe('200px');
    expect(editor.textContent).toBe('Moved');
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(onDone).not.toHaveBeenCalled();
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it('narrows the email box at zoom without changing committed alignment or treating it as a move', () => {
    const value = { ...block('Email', 24), align: 'right' as const,
      rect: { x: 234.7, y: 650, w: 297.5, h: 20 }, alignLeftPt: 68.2, alignWidthPt: 467.7 };
    const phone = { ...block('Phone', 24), rect: { x: 77.3, y: 650, w: 59.7, h: 20 } };
    const onDone = vi.fn();
    const onCancel = vi.fn();
    renderEditor(value, 2, 0, { blocks: [phone, value], onDone, onCancel });
    const editor = screen.getByRole('textbox', { name: 'Editable text' });
    expect(Number.parseFloat(editor.parentElement!.style.left)).toBeCloseTo(274);
    expect(Number.parseFloat(editor.parentElement!.style.width)).toBeCloseTo(797.8);
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(onDone).not.toHaveBeenCalled();
    expect(onCancel).toHaveBeenCalledOnce();
    editor.textContent = 'Email!';
    fireEvent.input(editor);
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(onDone.mock.calls[0]?.[0]).toMatchObject({
      text: 'Email!', dx: 0, dy: -0, align: 'right', alignLeftPt: 68.2, alignWidthPt: 467.7,
      boxLeftPt: 137,
      boxWidthPt: 398.9,
    });
  });

  it('records a left-aligned box without changing its geometry', () => {
    const value = block('Heading', 24);
    const onDone = vi.fn();
    renderEditor(value, 1, 0, { onDone });
    const editor = screen.getByRole('textbox', { name: 'Editable text' });
    editor.textContent = 'Heading!';
    fireEvent.input(editor);
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));

    expect(onDone.mock.calls[0]?.[0]).toMatchObject({
      text: 'Heading!',
      width: 240,
      dx: 0,
      boxLeftPt: 40,
      boxWidthPt: 240,
    });
  });

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

const resumeFixture = 'tmp/bullets/RAHUL_RAJPUT_RESUME.pdf';
const resumeEnabled = process.env.TASK74_REAL === '1' && existsSync(resumeFixture);

describe.skipIf(!resumeEnabled)('TextEditOverlay fill-and-stroke bold, unchanged Done', () => {
  it('treats Done without typing as a no-op on a paragraph with painted bold phrases', async () => {
    // Change 7 made these phrases bold: true while their face stays regular.
    // The unchanged-edit guard compares bold, so prove the seed and the
    // serialized box still agree when nothing was typed.
    const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const document = await getDocument({
      data: new Uint8Array(await readFile(resumeFixture)),
      fontExtraProperties: true,
      verbosity: 0,
    }).promise;
    try {
      const page = await document.getPage(1);
      const [runs, ruleLines] = await Promise.all([
        extractTextRuns(page, 0),
        detectRuleLines(page, 0),
      ]);
      const blocks = groupRunsIntoBlocks(runs, { ruleLines });
      const value = blocks.find((candidate) => candidate.text.includes('60+ bookings'));
      expect(value, 'the résumé paragraph with painted bold phrases').toBeDefined();
      if (!value) return;
      expect(
        value.lines.some((line) => line.runs.some((run) => run.style.bold && run.style.sourceBold === false)),
        'the block really contains a fill-and-stroke bold run',
      ).toBe(true);

      const onDone = vi.fn();
      const onCancel = vi.fn();
      renderEditor(value, 1, 0, { blocks, onDone, onCancel });
      fireEvent.click(screen.getByRole('button', { name: 'Done' }));
      expect(onDone).not.toHaveBeenCalled();
      expect(onCancel).toHaveBeenCalledOnce();
    } finally {
      await document.destroy();
    }
  });
});

describe.skipIf(!task74RealEnabled)('TextEditOverlay Task 74 real re-edit box', () => {
  it('opens the Rishi 2022-2025 cell at the same narrow width on first edit and re-edit', async () => {
    const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const document = await getDocument({
      data: new Uint8Array(await readFile(task74Fixture)),
      verbosity: 0,
    }).promise;
    try {
      const page = await document.getPage(1);
      const [runs, ruleLines] = await Promise.all([
        extractTextRuns(page, 0),
        detectRuleLines(page, 0),
      ]);
      const blocks = groupRunsIntoBlocks(runs, { ruleLines });
      const value = blocks.find((candidate) => candidate.text === '2022-2025');
      expect(value, 'Rishi date cell').toBeDefined();
      if (!value) return;

      const firstOnDone = vi.fn();
      const first = renderEditor(value, 1, 0, { blocks, onDone: firstOnDone });
      const firstEditor = screen.getByRole('textbox', { name: 'Editable text' });
      const firstLeft = Number.parseFloat(firstEditor.parentElement!.style.left);
      const firstWidth = Number.parseFloat(firstEditor.parentElement!.style.width);
      expect(firstLeft).toBeCloseTo(463.5, 0);
      expect(firstLeft + firstWidth).toBeCloseTo(560, 0);
      firstEditor.textContent = '2022-2026';
      fireEvent.input(firstEditor);
      fireEvent.click(screen.getByRole('button', { name: 'Done' }));
      const firstOutput = firstOnDone.mock.calls[0]?.[0];
      expect(firstOutput).toBeDefined();
      const existing = buildTextBlockEdits(value, firstOutput!, ['2022-2026'], 1).texts;
      first.unmount();

      renderEditor(value, 1, 0, { blocks, existing });
      const reEditFrame = screen.getByRole('textbox', { name: 'Editable text' }).parentElement!;
      const reEditLeft = Number.parseFloat(reEditFrame.style.left);
      const reEditWidth = Number.parseFloat(reEditFrame.style.width);
      expect(reEditLeft).toBeCloseTo(firstLeft, 5);
      expect(reEditWidth).toBeCloseTo(firstWidth, 5);
      process.stdout.write(
        `TASK74 REAL Rishi 2022-2025 box first/re-edit ${firstLeft.toFixed(1)}..`
        + `${(firstLeft + firstWidth).toFixed(1)} pt\n`,
      );
    } finally {
      await document.destroy();
    }
  }, 60_000);
});
