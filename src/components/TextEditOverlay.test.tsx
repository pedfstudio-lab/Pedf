/** @vitest-environment jsdom */

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import type { TextEdit } from '@/lib/export/types';
import type { ScreenRect } from '@/lib/export/coordinates';
import type { TextBlock } from '@/lib/pdf/textContent';
import { buildTextBlockEdits } from '@/lib/edit/buildTextEdits';
import { widestLineWidth } from '@/lib/edit/paragraphSeed';
import { detectRuleLines } from '@/lib/pdf/ruleLines';
import { detectPageGraphicRegions } from '@/lib/pdf/shapeMarkers';
import { extractTextRuns, groupRunsIntoBlocks } from '@/lib/pdf/textContent';
import { TextEditOverlay } from './TextEditOverlay';
import { wrapTextParagraphs } from '@/lib/edit/paragraphLayout';

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
      runs: [{ pageIndex: 0, text, rect: { x: 40, y: 680 - index * 24, w: 240, h: 20 }, style,
        characterWidthsPt: [...text].map(() => 240 / [...text].length), spaceWidthPt: 3 }],
    })),
  };
}

interface RenderEditorOptions {
  readonly expectedBaselinePx?: number;
  readonly baselineFontSizeSlopePx?: number;
  readonly toolbarObstacles?: readonly ScreenRect[];
  readonly blocks?: readonly TextBlock[];
  readonly existing?: readonly TextEdit[];
  readonly bulletMode?: { readonly items: readonly string[]; readonly symbols?: readonly string[]; readonly maxHeightPt: number; readonly indentPt?: number; readonly itemSpacingPt?: number };
  readonly onDone?: ReturnType<typeof vi.fn>;
  readonly onCancel?: ReturnType<typeof vi.fn>;
  readonly measureTextWidth?: (line: string) => number;
  readonly scaleInlineSizes?: boolean;
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
      toolbarObstacles={options.toolbarObstacles}
      existing={options.existing}
      screenRect={{ left: (options.existing?.[0]?.alignLeftPt ?? value.alignLeftPt ?? value.rect.x) * zoom, top: 100, width: 240, height: value.rect.h }}
      topCorrectionPx={topCorrectionPx}
      expectedBaselinePx={options.expectedBaselinePx}
      baselineFontSizeSlopePx={options.baselineFontSizeSlopePx}
      zoom={zoom}
      pageWidthPt={600}
      pageSizePx={{ width: 600, height: 800 }}
      backgroundColor="white"
      verticalTargets={[]}
      horizontalTargets={[]}
      bulletMode={options.bulletMode}
      measureTextWidth={options.measureTextWidth}
      scaleInlineSizes={options.scaleInlineSizes}
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

describe('Task 79 English edit guard', () => {
  it('runs the same guard after the plain-text paste handler inserts Tamil', () => {
    const onDone = vi.fn(), onCancel = vi.fn();
    renderEditor(block('Hello', 24), 1, 0, { onDone, onCancel });
    const editor = screen.getByRole('textbox');
    placeCaretAtTextEnd(editor.firstChild!);
    fireEvent.paste(editor, { clipboardData: { getData: () => ' தமிழ்' } });
    expect(editor.textContent).toContain('தமிழ்');
    expect(screen.getByRole('alert').textContent).toContain('in Tamil.');
    expect((screen.getByRole('button', { name: 'Done' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalledOnce(); expect(onDone).not.toHaveBeenCalled();
  });
  it.each(['नमस्ते', 'தமிழ்'])('refuses Done for typed/pasted %s, allows Cancel and recovers after removal', text => {
    const onDone = vi.fn(), onCancel = vi.fn();
    renderEditor(block('Hello', 24), 1, 0, { onDone, onCancel });
    const editor = screen.getByRole('textbox');
    editor.textContent = `Hello ${text}`;
    fireEvent.input(editor);
    expect(screen.getByRole('alert').textContent).toContain('Editing supports English text.');
    expect((screen.getByRole('button', { name: 'Done' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.keyDown(editor, { key: 'Enter', ctrlKey: true });
    expect(onDone).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalledOnce();
    editor.textContent = 'Hello English'; fireEvent.input(editor);
    expect(screen.queryByRole('alert')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(onDone).toHaveBeenCalledOnce();
  });
});

it('keeps matched-font presentation out of the no-op model and preserves text nodes on input', async () => {
  const value = paragraph('First ordinary line', 'Last ordinary line');
  const fontStyle = { ...style, fontName:'sans-serif', fontIdentity:'Calibri', fontRef:'task78-editor-subset' };
  const matched = { ...value, style:fontStyle, lines:value.lines.map(line=>({ ...line,style:fontStyle,runs:line.runs.map(run=>({...run,style:fontStyle})) })) };
  const onDone=vi.fn(),onCancel=vi.fn();
  renderEditor(matched,1,0,{onDone,onCancel});
  await act(async()=>{ await Promise.resolve(); });
  const editable=screen.getByRole('textbox',{name:'Editable text'}), first=editable.querySelector('[data-pdf-font-word]')!.firstChild!;
  expect(editable.querySelector('[data-pdf-font-word]')?.getAttribute('data-font-name')).toBe('sans-serif');
  fireEvent.input(editable);
  expect(editable.querySelector('[data-pdf-font-word]')!.firstChild).toBe(first);
  fireEvent.click(screen.getByRole('button',{name:'Done'}));
  expect(onDone).not.toHaveBeenCalled();expect(onCancel).toHaveBeenCalledOnce();
});

it('selects the real matched B/I variant inside native formatting descendants without replacing text', () => {
  const value = block('QualityQZ', 12), fontStyle = { ...value.style, fontIdentity:'Calibri' };
  renderEditor({ ...value, style:fontStyle },1,0);
  const editor = screen.getByRole('textbox'), word = editor.querySelector<HTMLElement>('[data-pdf-font-word]')!;
  const text = word.firstChild!, nativeBold = document.createElement('b');
  nativeBold.append(text); word.append(nativeBold);
  placeCaretAtTextEnd(text);
  fireEvent.input(editor);
  expect(nativeBold.style.fontFamily).toContain('Carlito-Bold-ttf');
  expect(nativeBold.dataset.fontName).toBe(fontStyle.fontName);
  expect(nativeBold.firstChild).toBe(text);
  expect(window.getSelection()?.anchorNode).toBe(text);
  nativeBold.style.fontWeight = 'normal'; nativeBold.style.fontStyle = 'italic';
  fireEvent.input(editor);
  expect(nativeBold.style.fontFamily).toContain('Carlito-Italic-ttf');
  nativeBold.style.fontStyle = 'normal'; fireEvent.input(editor);
  expect(nativeBold.style.fontFamily).toContain('Carlito-Regular-ttf');
  expect(nativeBold.firstChild).toBe(text);
});

it('keeps a presentation-aligned bullet list a no-op when Done is pressed unchanged', () => {
  const value = block('First item\nSecond item',12), onDone=vi.fn(),onCancel=vi.fn();
  renderEditor({ ...value, style:{...value.style,fontIdentity:'Calibri'} },1,0,{onDone,onCancel,
    bulletMode:{items:['First item','Second item'],maxHeightPt:400,indentPt:29,itemSpacingPt:4.5}});
  expect(screen.getByRole('textbox').querySelectorAll('[data-pdf-bullet-item]')).toHaveLength(2);
  fireEvent.click(screen.getByRole('button',{name:'Done'}));
  expect(onDone).not.toHaveBeenCalled();expect(onCancel).toHaveBeenCalledOnce();
});

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
  it('reopens a saved justified paragraph at its own expanded column width', () => {
    const value = { ...paragraph('one two', 'three four'), align: 'justify' as const };
    const existing: TextEdit[] = [{ id: 'justified', kind: 'text', pageIndex: 0, z: 1, text: 'one two three four', style,
      rect: { x: 40, y: 650, w: 350, h: 20 }, align: 'justify', alignLeftPt: 40, alignWidthPt: 350,
      boxText: 'one two three four', boxLeftPt: 40, boxWidthPt: 350,
      boxParagraphs: [{ gapBeforePt: 0, firstIndentPt: 0, restIndentPt: 0 }] }];
    renderEditor(value, 1, 0, { existing });
    expect(screen.getByRole('textbox', { name: 'Editable text' }).parentElement?.style.width).toBe('350px');
  });
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
    expect(onDone).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toContain('Editing supports English text.');
    // IME text remains intact and cancellable; saving resumes after its removal.
    editor.textContent = 'English'; fireEvent.input(editor);
    fireEvent.click(screen.getByRole('button', {name:'Done'}));
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(onDone.mock.calls[0]?.[0].text).toBe('English');
    view.rerender(make(mode, true));
    expect(editor.getAttribute('contenteditable')).toBe('false');
    expect(screen.getByRole('button', {name:'Done'}).hasAttribute('disabled')).toBe(true);
    expect(editor.textContent).toBe('English');
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
  it('adds measured-piece residual tracking to font tracking instead of overriding either', () => {
    const tracked={...style,fontIdentity:'Lato',fontTrackingEm:-0.04};
    const text='N E W Y E A R';
    const runs=[{text:'N E W',x:40,width:50},{text:'Y E A R',x:140,width:70}].map(piece=>({
      pageIndex:0,text:piece.text,style:tracked,rect:{x:piece.x,y:680,w:piece.width,h:20},
      metrics:{matrix:[20,0,0,20,piece.x,680] as const,x:piece.x,baselineY:680,widthPt:piece.width},
    }));
    renderEditor({...block(text,24),style:tracked,lines:[{pageIndex:0,text,style:tracked,runs,baselineY:680,rect:{x:40,y:680,w:170,h:20}}]});
    const editor=screen.getByRole('textbox',{name:'Editable text'});
    const contents=editor.querySelectorAll<HTMLElement>('[data-pdf-piece-content]');
    const first=contents[0]!.querySelector<HTMLElement>('[data-pdf-font-word]')!;
    const node=first.firstChild;
    expect(Number.parseFloat(contents[0]!.style.getPropertyValue('--pdf-piece-tracking'))).toBeCloseTo(0.8);
    expect(first.style.letterSpacing).toContain('var(--pdf-piece-tracking,0px)');
    expect(first.style.letterSpacing).toContain('-0.8px');
    fireEvent.input(editor);
    expect(first.firstChild).toBe(node);
    expect(first.style.letterSpacing).toContain('var(--pdf-piece-tracking,0px)');
  });
  it.each([1, 2])('uses displayed-face metrics, not source-face heights, at zoom %s', zoom => {
    vi.mocked(HTMLCanvasElement.prototype.getContext).mockReturnValue({
      font: '', measureText(this: { font: string }, text: string) {
        const size = Number(this.font.match(/([\d.]+)px/)?.[1]) || 20;
        return { width: text.length * size / 2, fontBoundingBoxAscent: size * 0.7, fontBoundingBoxDescent: size * 0.2 };
      },
    } as unknown as CanvasRenderingContext2D);
    const original = paragraph('First row', 'Second row');
    const value = { ...original, lines: original.lines.map(line => ({ ...line, runs: line.runs.map(run => ({ ...run,
      metrics: { matrix: [20, 0, 0, 20, run.rect.x, run.rect.y] as const, x: run.rect.x, baselineY: run.rect.y, widthPt: run.rect.w, ascent: 0.95, descent: -0.25 } })) })) };
    const onDone = vi.fn(); renderEditor(value, zoom, 0, { onDone });
    const editor = screen.getByRole('textbox', { name: 'Editable text' });
    editor.firstChild!.textContent = 'First row! Second row'; fireEvent.input(editor);
    vi.spyOn(editor, 'getBoundingClientRect').mockImplementation(() => { throw Error('Done consulted a DOM position'); });
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(onDone.mock.calls[0]?.[0].fontMetrics).toEqual({ ascent: 0.7, descent: 0.2 });
    expect(onDone.mock.calls[0]?.[0].width).toBe(value.rect.w);
  });

  it('restores measured heading gaps when an unmatched edit is undone while typing', () => {
    const text = 'N E W Y E A R';
    const runs = [{ text: 'N E W', x: 40, width: 50 }, { text: 'Y E A R', x: 140, width: 70 }].map(piece => ({
      pageIndex: 0, text: piece.text, style,
      rect: { x: piece.x, y: 680, w: piece.width, h: 20 },
      metrics: { matrix: [20, 0, 0, 20, piece.x, 680] as const, x: piece.x, baselineY: 680, widthPt: piece.width },
    }));
    renderEditor({ ...block(text, 24), lines: [{ pageIndex: 0, text, style, runs, baselineY: 680, rect: { x: 40, y: 680, w: 170, h: 20 } }] });
    const editor = screen.getByRole('textbox', { name: 'Editable text' });
    const wrappers = editor.querySelectorAll<HTMLElement>('[data-pdf-source-piece]');
    const first = wrappers[0]!.querySelector<HTMLElement>('[data-pdf-piece-content]')!;
    const second = wrappers[1]!.querySelector<HTMLElement>('[data-pdf-piece-content]')!;
    expect(wrappers[1]!.style.marginLeft).toBe('40px');
    first.textContent = 'X'; second.textContent = 'Z'; fireEvent.input(editor);
    expect(wrappers[1]!.style.marginLeft).toBe('0px');
    first.textContent = 'N E W'; second.textContent = 'Y E A R'; fireEvent.input(editor);
    expect(wrappers[1]!.style.marginLeft).toBe('40px');
    expect(editor.querySelectorAll('[data-pdf-source-piece]')[1]).toBe(wrappers[1]);
  });

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
    expect(outsideHandle.style.left).toBe('-8px');
    expect(outsideHandle.style.top).toBe('-8px');
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

  it('keeps real arrow symbols and treats unchanged Done as a no-op',()=>{
    const onDone=vi.fn(),onCancel=vi.fn();
    renderEditor(paragraph('First item','Second item'),1,0,{onDone,onCancel,
      bulletMode:{items:['First item','Second item'],symbols:['➢','➢'],maxHeightPt:200}});
    expect(screen.getByRole('textbox',{name:'Editable bullet list'}).innerHTML).toBe('➢ First item<br>➢ Second item');
    fireEvent.click(screen.getByRole('button',{name:'Done'}));
    expect(onDone).not.toHaveBeenCalled();expect(onCancel).toHaveBeenCalledOnce();
  });

  it('copies an arrow on Enter rather than inserting a dot',()=>{
    const onDone=vi.fn();
    renderEditor(paragraph('First item','Second item'),1,0,{onDone,
      bulletMode:{items:['First item','Second item'],symbols:['➢','➢'],maxHeightPt:200}});
    const editor=screen.getByRole('textbox',{name:'Editable bullet list'});placeCaretAtTextEnd(editor.firstChild!);
    fireEvent.keyDown(editor,{key:'Enter'});fireEvent.click(screen.getByRole('button',{name:'Done'}));
    expect(onDone.mock.calls[0]?.[0].text).toBe('➢ First item\n➢ \n➢ Second item');
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

  it('keeps paragraph DOM and the composing text node stable during IME input', () => {
    const value = paragraph('First paragraph', 'Second paragraph');
    const first = value.lines[0]!;
    renderEditor({ ...value, lines: [{ ...first, rect: { ...first.rect, w: 30 } }, value.lines[1]!] });
    const editor = screen.getByRole('textbox', { name: 'Editable text' });
    const node = editor.firstChild!.firstChild!;
    expect(editor.querySelectorAll('[data-pdf-paragraph]')).toHaveLength(2);
    fireEvent.compositionStart(editor);
    node.textContent = 'हिंदी'; fireEvent.input(editor); fireEvent.keyDown(editor, { key: 'Enter' });
    expect(editor.firstChild!.firstChild).toBe(node);
    expect(editor.querySelectorAll('[data-pdf-paragraph]')).toHaveLength(2);
    fireEvent.compositionEnd(editor);
    expect(editor.firstChild!.firstChild).toBe(node);
  });

  it('inserts a paragraph break for Enter in prose', () => {
    const onDone = vi.fn();
    renderEditor(paragraph('Plain paragraph'), 1, 0, { onDone });
    const editor = screen.getByRole('textbox', { name: 'Editable text' });
    placeCaretAtTextEnd(editor.firstChild!.firstChild!);

    fireEvent.keyDown(editor, { key: 'Enter' });

    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(onDone.mock.calls[0]?.[0].text).toBe('Plain paragraph\n');
    expect(onDone.mock.calls[0]?.[0].paragraphs).toHaveLength(2);
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

  it('restores saved paragraph layout and treats an unchanged Done as a no-op', () => {
    const onDone = vi.fn(), onCancel = vi.fn();
    const paragraphs = [{ gapBeforePt: 0, firstIndentPt: 0, restIndentPt: 0 }, { gapBeforePt: 3, firstIndentPt: 28.8, restIndentPt: 0 }];
    const existing: TextEdit = { id: 'saved-paragraphs', kind: 'text', pageIndex: 0, rect: { x: 40, y: 650, w: 240, h: 20 }, z: 1,
      text: 'Saved first', boxText: 'Saved first\nSaved second', style, boxHeight: 50, boxParagraphs: paragraphs };
    renderEditor(paragraph('Original first', 'Original second'), 1, 0, { existing: [existing], onDone, onCancel });
    const editor = screen.getByRole('textbox', { name: 'Editable text' });
    const second = editor.querySelectorAll<HTMLElement>('[data-pdf-paragraph]')[1]!;
    expect(second.style.marginTop).toBe('3px'); expect(second.style.textIndent).toBe('28.8px');
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(onDone).not.toHaveBeenCalled(); expect(onCancel).toHaveBeenCalledOnce();
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

describe('Task 74 Step 5c live visual frame', () => {
  let rectangles: DOMRect[];

  beforeEach(() => {
    rectangles = [new DOMRect(150, 110, 100, 20)];
    Object.defineProperty(Range.prototype, 'getClientRects', {
      configurable: true,
      value: vi.fn(function (this: Range) {
        return this.toString().length ? rectangles : [];
      }),
    });
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      return this.dataset.testid === 'text-editor-layout'
        ? new DOMRect(40, 100, 240, 24)
        : new DOMRect(40, 110, 240, 24);
    });
  });

  afterEach(() => { Reflect.deleteProperty(Range.prototype, 'getClientRects'); });

  it('moves a top-page toolbar below the subtitle without chasing every later paragraph down the page', () => {
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) {
      return this.getAttribute('role') === 'toolbar' ? 44 : 0;
    });
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function (this: HTMLElement) {
      return this.getAttribute('role') === 'toolbar' ? 390 : 0;
    });
    rectangles = [new DOMRect(150, 18, 100, 30)];
    renderEditor(block('Heading', 24), 1, 0, { toolbarObstacles: [
      { left: 100, top: 52, width: 300, height: 14 },
      { left: 100, top: 80, width: 300, height: 14 },
      { left: 550, top: 100, width: 40, height: 14 }, // not under this toolbar
    ] });
    const toolbar = screen.getByRole('toolbar');
    expect(Number.parseFloat(toolbar.style.top) + 100).toBe(74);
    expect(Number.parseFloat(toolbar.style.left) + 40).toBe(149);
    expect(screen.getByTestId('text-editor-layout').style.width).toBe('240px');
    expect(screen.getByTestId('text-editor-frame').style.height).toBe('32px');
  });

  it('keeps the above-heading toolbar unchanged when there is room', () => {
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(44);
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(390);
    renderEditor(block('Heading', 24), 1, 0, { toolbarObstacles: [
      { left: 100, top: 135, width: 300, height: 14 },
    ] });
    expect(Number.parseFloat(screen.getByRole('toolbar').style.top) + 100).toBe(57);
  });

  it('retains the page-contained fallback if no lower slot fits', () => {
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(44);
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(390);
    rectangles = [new DOMRect(150, 18, 100, 30)];
    renderEditor(block('Heading', 24), 1, 0, { toolbarObstacles: [
      { left: 100, top: 52, width: 300, height: 740 },
    ] });
    expect(Number.parseFloat(screen.getByRole('toolbar').style.top) + 100).toBe(57);
  });

  it.each(['left', 'center', 'right'] as const)('hugs the text independently of the %s layout box', (align) => {
    const onDone = vi.fn(), onCancel = vi.fn();
    renderEditor({ ...block('Heading', 24), align, alignLeftPt: 40, alignWidthPt: 240 }, 1, 0, { onDone, onCancel });
    const frame = screen.getByTestId('text-editor-frame');
    expect(frame.style).toMatchObject({ left: '109px', top: '9px', width: '102px', height: '22px' });
    expect(screen.getByTestId('text-editor-layout').style.width).toBe('240px');
    expect(screen.getByRole('textbox').className).toContain('w-full');
    expect(screen.getByRole('toolbar').style.left).toBe('109px');
    expect(screen.getByRole('toolbar').style.maxWidth).toBe('600px');
    expect(screen.getByRole('toolbar').style.width).toBe('max-content');
    expect(screen.getByRole('toolbar').className).toContain('flex-wrap');
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(onDone).not.toHaveBeenCalled();
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it('follows shrinking text, wrapped lines and composition without resizing the saved box', () => {
    const onDone = vi.fn();
    renderEditor(block('Heading', 24), 1, 0, { onDone });
    const editor = screen.getByRole('textbox');
    editor.textContent = 'Short';
    rectangles = [new DOMRect(150, 110, 50, 20)];
    fireEvent.input(editor);
    expect(screen.getByTestId('text-editor-frame').style.width).toBe('52px');
    editor.textContent = 'Short\nSecond line';
    rectangles = [new DOMRect(40, 110, 50, 20), new DOMRect(40, 134, 130, 20)];
    fireEvent.compositionUpdate(editor, { data: 'Second line' });
    expect(screen.getByTestId('text-editor-frame').style).toMatchObject({ left: '-1px', width: '132px', height: '46px' });
    fireEvent.compositionEnd(editor);
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(onDone.mock.calls[0]?.[0]).toMatchObject({ width: 240, boxWidthPt: 240, dx: 0, dy: -0 });
  });

  it('keeps the full fallback patch while tightening only the outline', () => {
    renderEditor(block('Heading', 24));
    expect(screen.getByTestId('text-editor-layout').style).toMatchObject({ backgroundColor: 'white', width: '240px' });
    expect(screen.getByTestId('text-editor-frame').style.width).toBe('102px');
    expect(screen.getByTestId('text-editor-frame').style.backgroundColor).toBe('');
  });

  it('retains one line and the scaled minimum width after deleting all text', () => {
    const onDone = vi.fn();
    renderEditor(block('Heading', 24), 2, 0, { onDone });
    const editor = screen.getByRole('textbox');
    editor.textContent = '';
    fireEvent.input(editor);
    expect(screen.getByTestId('text-editor-frame').style).toMatchObject({ width: '48px', height: '48px' });
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(onDone.mock.calls[0]?.[0]).toMatchObject({ text: '', width: 240 });
  });

  it('places the width handle on the ink and preserves its existing drag distance', () => {
    const onDone = vi.fn();
    renderEditor(block('Heading', 24), 1, 0, { onDone });
    const handle = screen.getByRole('button', { name: 'Drag to change text width' });
    expect(handle.style.left).toBe('206px');
    handle.setPointerCapture = vi.fn();
    // jsdom has no native PointerEvent constructor.
    const pointerDown = new MouseEvent('pointerdown', { bubbles: true, clientX: 250 });
    fireEvent(handle, pointerDown);
    fireEvent(window, new MouseEvent('pointermove', { clientX: 280 }));
    fireEvent(window, new MouseEvent('pointerup'));
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(onDone.mock.calls[0]?.[0]).toMatchObject({ width: 270, boxWidthPt: 270, dx: 0, dy: -0 });
  });

  it.each(['center', 'right', 'paragraph', 'cell', 'list'] as const)(
    'keeps every committed field identical for a %s when only the measured frame changes', (kind) => {
      const value = kind === 'paragraph' ? paragraph('First sentence continues', 'on the next visual line.')
        : kind === 'list' ? paragraph('First item', 'Second item') : block('Heading', 24);
      const aligned = kind === 'center' || kind === 'right'
        ? { ...value, align: kind, alignLeftPt: 10, alignWidthPt: 500 }
        : value;
      const bulletMode = kind === 'list' ? { items: ['First item', 'Second item'], maxHeightPt: 200 } : undefined;
      const commits: unknown[] = [];
      for (const measured of [new DOMRect(150, 110, 100, 20), new DOMRect(55, 120, 190, 60)]) {
        rectangles = [measured];
        const onDone = vi.fn();
        const view = renderEditor(aligned, 1, 0, { onDone, bulletMode });
        const editor = screen.getByRole('textbox');
        editor.append(document.createTextNode('!'));
        fireEvent.input(editor);
        fireEvent.click(screen.getByRole('button', { name: 'Done' }));
        expect(onDone).toHaveBeenCalledOnce();
        commits.push(onDone.mock.calls[0]?.[0]);
        view.unmount();
      }
      expect(commits[1]).toEqual(commits[0]);
    },
  );
});

describe('Task 74 Step 5c.1 measured baseline', () => {
  let markerOffset: number;
  let markerReads: number;
  let fonts: EventTarget & { ready: Promise<void> };
  let fontsReady: () => void;

  beforeEach(() => {
    markerOffset = 15;
    markerReads = 0;
    fonts = Object.assign(new EventTarget(), { ready: new Promise<void>((resolve) => { fontsReady = resolve; }) });
    Object.defineProperty(document, 'fonts', { configurable: true, value: fonts });
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const probeTop = 100 + Number.parseFloat(document.querySelector<HTMLElement>('[data-testid="text-baseline-probe"]')?.style.top ?? '0');
      if (this.dataset.testid === 'text-baseline-probe') return new DOMRect(40, probeTop, 20, 24);
      if (this.dataset.testid === 'text-baseline-marker') {
        markerReads += 1;
        return new DOMRect(40, probeTop + markerOffset, 0, 0);
      }
      return new DOMRect();
    });
  });
  afterEach(() => { Reflect.deleteProperty(document, 'fonts'); });

  it('corrects the editable only, with its hidden marker completely outside the typing DOM', () => {
    renderEditor(block('Heading', 24), 1, 12, { expectedBaselinePx: 120 });
    const editor = screen.getByRole('textbox');
    expect(editor.style.top).toBe('5px'); // 100 + 5 + measured 15 = 120
    expect(editor.textContent).toBe('Heading');
    const marker = screen.getByTestId('text-baseline-marker');
    expect(editor.contains(marker)).toBe(false);
    expect(screen.getByTestId('text-baseline-probe').getAttribute('aria-hidden')).toBe('true');
    expect(screen.getByTestId('text-baseline-probe').className).toContain('invisible');
  });

  it('re-measures on a whole-box size change and font loading without replacing the editable', async () => {
    renderEditor(block('Heading', 24), 1, 0, { expectedBaselinePx: 120 });
    const editor = screen.getByRole('textbox');
    markerOffset = 30;
    fireEvent.change(screen.getByRole('combobox', { name: 'Font size' }), { target: { value: '40' } });
    fireEvent.keyDown(screen.getByRole('combobox', { name: 'Font size' }), { key: 'Enter' });
    expect(editor.style.top).toBe('-10px');
    markerOffset = 28;
    act(() => { fonts.dispatchEvent(new Event('loadingdone')); });
    expect(editor.style.top).toBe('-8px');
    markerOffset = 29;
    await act(async () => { fontsReady(); await fonts.ready; });
    expect(editor.style.top).toBe('-9px');
    expect(screen.getByRole('textbox')).toBe(editor);
    expect(editor.textContent).toBe('Heading');
  });

  it('does not probe every keystroke or interfere with composition and selection', () => {
    renderEditor(block('Heading', 24), 1, 0, { expectedBaselinePx: 120 });
    const editor = screen.getByRole('textbox');
    const initialReads = markerReads;
    fireEvent.compositionStart(editor);
    editor.append(document.createTextNode(' नमस्ते'));
    placeCaretAtTextEnd(editor.lastChild!);
    const anchor = window.getSelection()?.anchorNode;
    fireEvent.input(editor);
    fireEvent.compositionUpdate(editor);
    fireEvent.compositionEnd(editor);
    expect(markerReads).toBe(initialReads);
    expect(window.getSelection()?.anchorNode).toBe(anchor);
    expect(editor.textContent).toBe('Heading नमस्ते');
  });

  it('re-measures selected inline font changes in the hidden mirror without inserting a marker into the selection', () => {
    renderEditor(block('Heading', 24), 1, 0, { expectedBaselinePx: 120 });
    const editor = screen.getByRole('textbox');
    selectText(editor.firstChild!, 0, 7);
    markerOffset = 25;
    fireEvent.change(screen.getByRole('combobox', { name: 'Font size' }), { target: { value: '40' } });
    fireEvent.keyDown(screen.getByRole('combobox', { name: 'Font size' }), { key: 'Enter' });
    expect(editor.style.top).toBe('-5px');
    expect(editor.querySelector('[data-testid="text-baseline-marker"]')).toBeNull();
    expect(screen.getByTestId('text-baseline-probe').querySelector('[data-font-size-pt="40"]')).not.toBeNull();
    expect(window.getSelection()?.toString()).toBe('Heading');
  });

  it('retains the old offset when the probe has no layout', () => {
    vi.mocked(HTMLElement.prototype.getBoundingClientRect).mockReturnValue(new DOMRect());
    renderEditor(block('Heading', 24), 1, 12, { expectedBaselinePx: 120 });
    expect(screen.getByRole('textbox').style.top).toBe('-14px');
  });

  it('follows Add Text’s existing size-dependent commit baseline', () => {
    renderEditor(block('Heading', 24), 1, 0, { expectedBaselinePx: 120, baselineFontSizeSlopePx: 1 });
    markerOffset = 30;
    fireEvent.change(screen.getByRole('combobox', { name: 'Font size' }), { target: { value: '40' } });
    fireEvent.keyDown(screen.getByRole('combobox', { name: 'Font size' }), { key: 'Enter' });
    expect(screen.getByRole('textbox').style.top).toBe('10px'); // baseline now 140, as Add Text already saves
  });

  it.each(['center', 'right', 'paragraph', 'cell', 'list'] as const)(
    'does not change any Done field for a %s, including its moved baseline', (kind) => {
      const value = kind === 'paragraph' || kind === 'list' ? paragraph('First line', 'Second line')
        : block('Heading', 24);
      const aligned = kind === 'center' || kind === 'right'
        ? { ...value, align: kind, alignWidthPt: 500 } : value;
      const bulletMode = kind === 'list' ? { items: ['First line', 'Second line'], maxHeightPt: 200 } : undefined;
      const outputs: unknown[] = [];
      for (const expectedBaselinePx of [undefined, 120]) {
        const onDone = vi.fn();
        const view = renderEditor(aligned, 1, 0, { expectedBaselinePx, onDone, bulletMode });
        const editor = screen.getByRole('textbox');
        editor.append(document.createTextNode('!'));
        fireEvent.input(editor);
        fireEvent.keyDown(screen.getByRole('button', { name: 'Drag to move' }), { key: 'ArrowDown' });
        fireEvent.click(screen.getByRole('button', { name: 'Done' }));
        expect(onDone).toHaveBeenCalledOnce();
        outputs.push(onDone.mock.calls[0]?.[0]);
        view.unmount();
      }
      expect(outputs[1]).toEqual(outputs[0]);
    },
  );
});


describe('Task 83 revision 1 grows-down corner resize', () => {
  function drag(handle: HTMLElement, dx: number, dy: number, back = false) {
    handle.setPointerCapture = vi.fn();
    fireEvent(handle, new MouseEvent('pointerdown', { bubbles: true, clientX: 300, clientY: 200, button: 0 }));
    fireEvent(window, new MouseEvent('pointermove', { clientX: 300 + dx, clientY: 200 + dy }));
    if (back) fireEvent(window, new MouseEvent('pointermove', { clientX: 300, clientY: 200 }));
    fireEvent(window, new MouseEvent('pointerup'));
  }

  it.each([[100, 0, 30], [0, 100, 30], [-100, 0, 10], [0, -100, 10], [50, 50, 30]])(
    'drag (%s, %s) changes size to %s pt with the same width', (dx, dy, size) => {
      const onDone = vi.fn();
      renderEditor(block('Heading', 24), 1, 0, { onDone });
      const frame = screen.getByTestId('text-editor-frame');
      const handle = screen.getByRole('button', { name: 'Drag to resize text' });
      expect(handle.className).toContain('cursor-nwse-resize');
      expect(Number.parseFloat(handle.style.top)).toBeCloseTo(Number.parseFloat(frame.style.top) + Number.parseFloat(frame.style.height) - 5);
      drag(handle, dx!, dy!);
      expect(Number((screen.getByRole('combobox', { name: 'Font size' }) as HTMLInputElement).value)).toBe(size);
      fireEvent.click(screen.getByRole('button', { name: 'Done' }));
      expect(onDone).toHaveBeenCalledOnce();
      expect(onDone.mock.calls[0]![0]).toMatchObject({ style: { fontSizePt: size, bold: false }, width: 240, dx: 0, dy: -0 });
    },
  );

  it.each(['paragraph', 'justify', 'center', 'right', 'heading', 'bullet'] as const)(
    'matches the existing whole-box size control for %s, including the saved edit', kind => {
      const source = kind === 'heading' ? block('One line heading', 24) : paragraph('First sentence continues', 'on its second line.');
      const aligned = kind === 'justify' || kind === 'center' || kind === 'right'
        ? { ...source, align: kind, alignLeftPt: 40, alignWidthPt: 240 } : source;
      const measureTextWidth = (text: string) => text.length * 7;
      const outputs: unknown[] = [];
      for (const control of ['toolbar', 'corner']) {
        const onDone = vi.fn();
        const view = renderEditor(aligned, 1, 0, { onDone, measureTextWidth,
          ...(kind === 'bullet' ? { bulletMode: { items: ['First sentence continues', 'on its second line.'],
            indentPt: 20, itemSpacingPt: 6, maxHeightPt: 500 } } : {}) });
        window.getSelection()?.removeAllRanges();
        if (control === 'corner') {
          fireEvent.keyDown(screen.getByRole('button', { name: 'Drag to resize text' }), { key: 'ArrowDown', shiftKey: true });
        } else {
          fireEvent.change(screen.getByRole('combobox', { name: 'Font size' }), { target: { value: '30' } });
          fireEvent.keyDown(screen.getByRole('combobox', { name: 'Font size' }), { key: 'Enter' });
        }
        fireEvent.click(screen.getByRole('button', { name: 'Done' }));
        expect(onDone).toHaveBeenCalledOnce();
        const next = onDone.mock.calls[0]![0];
        const rows = wrapTextParagraphs(next, text => text.length * 7, aligned);
        const built = buildTextBlockEdits(aligned, next, rows, 0);
        outputs.push({ next, rows, edits: built.texts.map(edit => ({ ...edit, id: 'normalized-test-id' })) });
        view.unmount();
      }
      expect(outputs[1]).toEqual(outputs[0]);
    },
  );

  it('rewraps at the unchanged paragraph width and still wraps normally after typing', () => {
    const onDone = vi.fn(), source = paragraph('alpha beta', 'gamma delta');
    renderEditor(source, 1, 0, { onDone, measureTextWidth: text => text.length * 2 });
    fireEvent.keyDown(screen.getByRole('button', { name: 'Drag to resize text' }), { key: 'ArrowDown', shiftKey: true });
    const editor = screen.getByRole('textbox');
    const part = editor.querySelector('[data-pdf-paragraph]') ?? editor;
    part.append(document.createTextNode(' added')); fireEvent.input(editor);
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    const next = onDone.mock.calls[0]![0];
    expect(next.width).toBe(240);
    expect(next.text).toBe('alpha beta gamma delta added');
    expect(next.style.fontSizePt).toBe(30);
    expect(next).not.toHaveProperty('cornerParagraphLayout');
    const measure = (text: string) => text.length * next.style.fontSizePt / 2;
    const rows = wrapTextParagraphs(next, measure, source);
    expect(rows.map(row => row.text)).toEqual(['alpha beta gamma', 'delta added']);
  });

  it('scales explicit selected-word sizes proportionally, without changing width', () => {
    const onDone = vi.fn();
    renderEditor(block('Normal Large', 24), 1, 0, { onDone });
    const editor = screen.getByRole('textbox');
    editor.innerHTML = 'Normal <span data-font-size-pt="40" style="font-size:40px;font-weight:bold">Large</span>';
    const range = document.createRange(); range.selectNodeContents(editor.lastChild!);
    window.getSelection()?.removeAllRanges(); window.getSelection()?.addRange(range);
    fireEvent.keyDown(screen.getByRole('button', { name: 'Drag to resize text' }), { key: 'ArrowUp', shiftKey: true });
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(onDone.mock.calls[0]![0]).toMatchObject({ style: { fontSizePt: 10 }, width: 240,
      spans: [{ text: 'Normal ', bold: false }, { text: 'Large', fontSizePt: 20, bold: true }] });
  });

  it('dragging back restores exact source markup and Done is a no-op', () => {
    const onDone = vi.fn(), onCancel = vi.fn();
    renderEditor(paragraph('First sentence continues', 'on its second line.'), 1, 0, { onDone, onCancel });
    const editor = screen.getByRole('textbox'), html = editor.innerHTML;
    drag(screen.getByRole('button', { name: 'Drag to resize text' }), 80, 50, true);
    expect(editor.innerHTML).toBe(html);
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(onDone).not.toHaveBeenCalled(); expect(onCancel).toHaveBeenCalledOnce();
  });

  it('Cancel discards a resize and keyboard arrows use 1pt / Shift 10pt steps', () => {
    const onDone = vi.fn(), onCancel = vi.fn();
    renderEditor(block('Heading', 24), 1, 0, { onDone, onCancel });
    const handle = screen.getByRole('button', { name: 'Drag to resize text' });
    fireEvent.keyDown(handle, { key: 'ArrowRight' });
    expect((screen.getByRole('combobox', { name: 'Font size' }) as HTMLInputElement).value).toBe('21');
    fireEvent.keyDown(handle, { key: 'ArrowDown', shiftKey: true });
    expect((screen.getByRole('combobox', { name: 'Font size' }) as HTMLInputElement).value).toBe('31');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onDone).not.toHaveBeenCalled(); expect(onCancel).toHaveBeenCalledOnce();
  });

  it('keeps bullet indent fixed and uses the existing A+/A− item spacing', () => {
    const onDone = vi.fn();
    renderEditor(paragraph('First item', 'Second item'), 1, 0, { onDone,
      bulletMode: { items: ['First item', 'Second item'], indentPt: 20, itemSpacingPt: 6, maxHeightPt: 500 } });
    fireEvent.keyDown(screen.getByRole('button', { name: 'Drag to resize text' }), { key: 'ArrowUp', shiftKey: true });
    const items = screen.getByRole('textbox').children;
    expect((items[0] as HTMLElement).style.paddingLeft).toBe('20px');
    expect((items[1] as HTMLElement).style.marginTop).toBe('3px');
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(onDone.mock.calls[0]![0]).toMatchObject({ width: 240, style: { fontSizePt: 10 } });
    expect(onDone.mock.calls[0]![0]).not.toHaveProperty('resizedBullet');
  });
});

describe('Task 84 small inline date letters', () => {
  function date() {
    const value = paragraph('23rd September');
    return { ...value, text: '23rd September', lines: [{ ...value.lines[0]!, runs: [
      { pageIndex: 0, text: '23', style, rect: { x: 40, y: 680, w: 20, h: 20 } },
      { pageIndex: 0, text: 'rd', style: { ...style, fontSizePt: 12 }, rect: { x: 60, y: 680, w: 10, h: 12 } },
      { pageIndex: 0, text: 'September', style, rect: { x: 75, y: 680, w: 90, h: 20 } },
    ] }] };
  }
  it('unchanged Done is still a no-op with the small ordinal', () => {
    const onDone = vi.fn(), onCancel = vi.fn();
    renderEditor(date(), 1, 0, { onDone, onCancel, scaleInlineSizes: true });
    expect(screen.getByRole('textbox').textContent).toBe('23rd September');
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(onDone).not.toHaveBeenCalled(); expect(onCancel).toHaveBeenCalledOnce();
  });
  it.each(['size', 'corner'])('keeps the small span proportional through the %s control', control => {
    const onDone = vi.fn();
    renderEditor(date(), 1, 0, { onDone, scaleInlineSizes: true });
    window.getSelection()?.removeAllRanges();
    if (control === 'corner') {
      fireEvent.keyDown(screen.getByRole('button', { name: 'Drag to resize text' }), { key: 'ArrowDown', shiftKey: true });
    } else {
      fireEvent.change(screen.getByRole('combobox', { name: 'Font size' }), { target: { value: '30' } });
      fireEvent.keyDown(screen.getByRole('combobox', { name: 'Font size' }), { key: 'Enter' });
    }
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(onDone.mock.calls[0]![0]).toMatchObject({ style: { fontSizePt: 30 },
      spans: expect.arrayContaining([expect.objectContaining({ text: 'rd', fontSizePt: 18 })]) });
  });
  it('keeps the existing non-date whole-box size behavior unchanged', () => {
    const onDone = vi.fn();
    renderEditor(date(), 1, 0, { onDone });
    window.getSelection()?.removeAllRanges();
    fireEvent.change(screen.getByRole('combobox', { name: 'Font size' }), { target: { value: '30' } });
    fireEvent.keyDown(screen.getByRole('combobox', { name: 'Font size' }), { key: 'Enter' });
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(onDone.mock.calls[0]![0]).toMatchObject({ style: { fontSizePt: 30 },
      spans: expect.arrayContaining([expect.objectContaining({ text: 'rd', fontSizePt: 12 })]) });
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

describe.runIf(process.env.TASK80_REAL === '1')('Task 80 Corporate p13', () => {
  it.each([1, 2])('opens with 12pt leading at zoom %s and Done makes no edit', async zoom => {
    const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const reader = await getDocument({ data: new Uint8Array(await readFile('tmp/text-doubling/corporate-edited-3.pdf')), fontExtraProperties: true, verbosity: 0 }).promise;
    try {
      const page = await reader.getPage(13);
      const [runs, ruleLines, regions] = await Promise.all([extractTextRuns(page, 12), detectRuleLines(page, 12), detectPageGraphicRegions(page, 12)]);
      const value = groupRunsIntoBlocks(runs, { ruleLines, markers: [...regions.imageRegions, ...regions.shapeMarkerRegions] }).find(block => block.text.startsWith('(i) All elements of remuneration'))!;
      expect(value.lines).toHaveLength(36);
      const onDone = vi.fn(), onCancel = vi.fn();
      renderEditor(value, zoom, 0, { onDone, onCancel, measureTextWidth: text => text.length * 2 });
      await act(async () => { await Promise.resolve(); });
      const editable = screen.getByRole('textbox', { name: 'Editable text' });
      expect(Number.parseFloat(editable.style.lineHeight) * Number.parseFloat(editable.style.fontSize)).toBeCloseTo(12 * zoom, 6);
      // Existing Change 10 partitions: 22 groups (including larger steps inside
      // three soft groups). Fix A must not turn those into new paragraphs.
      expect(editable.querySelectorAll('[data-pdf-paragraph]')).toHaveLength(22);
      fireEvent.click(screen.getByRole('button', { name: 'Done' }));
      expect(onDone).not.toHaveBeenCalled(); expect(onCancel).toHaveBeenCalledOnce();
    } finally { await reader.destroy(); }
  }, 120_000);
});

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
