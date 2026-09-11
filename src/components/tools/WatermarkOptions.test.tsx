// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { PDFDocument } from 'pdf-lib';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_WATERMARK_OPTIONS } from '@/lib/tools/watermarkOptions';
import type { ToolOptions } from '@/lib/tools/types';
import { WatermarkOptions } from './WatermarkOptions';

const { loadPdfJs } = vi.hoisted(() => ({ loadPdfJs: vi.fn() }));
vi.mock('@/lib/tools/pdfIo', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/tools/pdfIo')>(),
  loadPdfJs,
}));

function Harness({ inputs = [], initial = DEFAULT_WATERMARK_OPTIONS, onChanged }: {
  inputs?: File[];
  initial?: ToolOptions;
  onChanged?: (next: ToolOptions) => void;
}) {
  const [options, setOptions] = useState<ToolOptions>(initial);
  return <WatermarkOptions options={options} onChange={(next) => { onChanged?.(next); setOptions(next); }}
    inputs={inputs} disabled={false} />;
}

/** pdf.js stand-in for the preview: a 300 × 400 page whose render resolves at once. */
function mockPreviewPage() {
  const page = {
    getViewport: vi.fn(({ scale }: { scale: number }) => ({ width: 300 * scale, height: 400 * scale })),
    render: vi.fn(() => ({ promise: Promise.resolve(), cancel: vi.fn() })),
    cleanup: vi.fn(),
  };
  const destroy = vi.fn(async () => {});
  loadPdfJs.mockResolvedValue({ doc: { getPage: vi.fn(async () => page), destroy } });
  return { page, destroy };
}

beforeEach(() => {
  loadPdfJs.mockReset();
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    fillStyle: '', fillRect: vi.fn(),
  } as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/png;base64,preview');
  vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: 80, height: 40, close: vi.fn() })));
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: vi.fn(() => 'blob:watermark') });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function pdfFile() {
  const doc = await PDFDocument.create(); doc.addPage([300, 400]);
  return new File([(await doc.save()).slice().buffer], 'sample.pdf', { type: 'application/pdf' });
}

function choose(input: HTMLInputElement, file: File) {
  Object.defineProperty(input, 'files', { configurable: true, value: [file] });
  fireEvent.change(input);
}

describe('WatermarkOptions', () => {
  it('renders the complete default text controls and updates shared choices', () => {
    render(<Harness />);
    expect((screen.getByLabelText('Watermark text') as HTMLInputElement).value).toBe('CONFIDENTIAL');
    expect((screen.getByLabelText('Font') as HTMLSelectElement).value).toBe('sans');
    expect((screen.getByLabelText('Size') as HTMLSelectElement).value).toBe('auto');
    expect(screen.getByRole('button', { name: 'grey watermark colour' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: 'Centre' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('slider', { name: /Opacity: 30%/ })).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Angle'), { target: { value: '-45' } });
    expect((screen.getByLabelText('Angle') as HTMLSelectElement).value).toBe('-45');
    fireEvent.click(screen.getByLabelText('Tile across page'));
    expect((screen.getByLabelText('Tile across page') as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole('button', { name: 'Top right' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByLabelText('Tile across page'));
    fireEvent.click(screen.getByRole('button', { name: 'Top right' }));
    expect((screen.getByLabelText('Tile across page') as HTMLInputElement).checked).toBe(false);
  });

  it('shows exact text validation feedback and custom page controls', () => {
    render(<Harness />);
    fireEvent.change(screen.getByLabelText('Watermark text'), { target: { value: 'नमस्ते' } });
    expect(screen.getByText('Use English letters, numbers and common symbols for now.')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Pages'), { target: { value: 'custom' } });
    fireEvent.change(screen.getByLabelText('Pages or ranges'), { target: { value: '2-4, 7' } });
    expect((screen.getByLabelText('Pages or ranges') as HTMLInputElement).value).toBe('2-4, 7');
  });

  it('rejects HEIC and images over 10 MB with the promised guidance', async () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Image' }));
    const picker = document.querySelector<HTMLInputElement>('.watermark-file-input')!;
    choose(picker, new File(['heic'], 'photo.heic', { type: 'image/heic' }));
    expect(await screen.findByText('Convert HEIC to JPG on your phone first.')).toBeTruthy();
    choose(picker, new File([new Uint8Array(10 * 1024 * 1024 + 1)], 'huge.png', { type: 'image/png' }));
    expect(await screen.findByText('Choose an image smaller than 10 MB.')).toBeTruthy();
  });

  it('prepares a chosen image, shows its dimensions, adjusts width, and removes it', async () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Image' }));
    const picker = document.querySelector<HTMLInputElement>('.watermark-file-input')!;
    const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
    choose(picker, new File([png], 'logo.png', { type: 'image/png' }));
    expect(await screen.findByAltText('Watermark thumbnail')).toBeTruthy();
    expect(screen.getByText('80 × 40 px')).toBeTruthy();
    const width = screen.getByRole('slider', { name: /Width:/ });
    fireEvent.change(width, { target: { value: '55' } });
    expect((screen.getByRole('slider', { name: /Width: 55%/ }) as HTMLInputElement).value).toBe('55');
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    expect(screen.getByRole('button', { name: 'Choose image…' })).toBeTruthy();
  });

  it('builds and renders a lossless, print-intent preview after the debounce', async () => {
    const { page, destroy } = mockPreviewPage();
    render(<Harness inputs={[await pdfFile()]} />);
    expect(await screen.findByAltText('Watermarked page preview', {}, { timeout: 3000 })).toBeTruthy();
    expect(page.getViewport).toHaveBeenLastCalledWith({ scale: 1 });
    expect(page.render).toHaveBeenCalledWith(expect.objectContaining({ intent: 'print' }));
    // One plain page picture (under the stamp while dragging) and one real result.
    expect(page.cleanup).toHaveBeenCalledTimes(2);
    expect(destroy).toHaveBeenCalledTimes(2);
  });

  it('drags the stamp to a custom spot, snaps to the centre, and nudges with arrow keys', async () => {
    mockPreviewPage();
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      left: 0, top: 0, right: 300, bottom: 400, width: 300, height: 400, x: 0, y: 0, toJSON: () => ({}),
    } as DOMRect);
    const changes: ToolOptions[] = [];
    render(<Harness inputs={[await pdfFile()]} onChanged={(next) => changes.push(next)}
      initial={{ ...DEFAULT_WATERMARK_OPTIONS, text: 'X', size: 24, angle: 0 }} />);
    const handle = await screen.findByRole('button', { name: /Move the watermark/ }, { timeout: 3000 });
    expect(handle.style.left).toBe('50%');

    // A click without moving keeps the quick spot.
    fireEvent.pointerDown(handle, { button: 0, pointerId: 1, clientX: 150, clientY: 200 });
    fireEvent.pointerUp(window, { pointerId: 1 });
    expect(changes).toHaveLength(0);

    fireEvent.pointerDown(handle, { button: 0, pointerId: 2, clientX: 150, clientY: 200 });
    fireEvent.pointerMove(window, { pointerId: 2, clientX: 153, clientY: 202 });
    expect(document.querySelector('.watermark-guide-v')).toBeTruthy();
    expect(document.querySelector('.watermark-guide-h')).toBeTruthy();
    fireEvent.pointerMove(window, { pointerId: 2, clientX: 225, clientY: 100 });
    fireEvent.pointerUp(window, { pointerId: 2 });
    const dropped = changes.at(-1)!;
    expect(dropped.position).toBe('custom');
    expect(dropped.customX as number).toBeCloseTo(0.75, 5);
    expect(dropped.customY as number).toBeCloseTo(0.25, 5);
    expect(document.querySelector('.watermark-guide')).toBeNull();

    const moved = screen.getByRole('button', { name: /Move the watermark/ });
    expect(moved.style.left).toBe('75%');
    expect(moved.style.top).toBe('25%');
    fireEvent.keyDown(moved, { key: 'ArrowRight' });
    expect(changes.at(-1)!.customX as number).toBeCloseTo(0.76, 5);
    fireEvent.keyDown(screen.getByRole('button', { name: /Move the watermark/ }), { key: 'ArrowUp', shiftKey: true });
    expect(changes.at(-1)!.customY as number).toBeCloseTo(0.2, 5);
  });

  it('hides the drag handle while the watermark is tiled', async () => {
    mockPreviewPage();
    render(<Harness inputs={[await pdfFile()]} />);
    await screen.findByRole('button', { name: /Move the watermark/ }, { timeout: 3000 });
    fireEvent.click(screen.getByLabelText('Tile across page'));
    expect(screen.queryByRole('button', { name: /Move the watermark/ })).toBeNull();
  });

  it('disables all option controls while processing', () => {
    render(<WatermarkOptions options={DEFAULT_WATERMARK_OPTIONS} onChange={vi.fn()} inputs={[]} disabled />);
    expect((screen.getByRole('group', { name: 'Watermark' }) as HTMLFieldSetElement).disabled).toBe(true);
  });
});
