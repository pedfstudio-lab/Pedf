// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_ROTATE_OPTIONS } from '@/lib/tools/rotateOptions';
import { RotateOptions } from './RotateOptions';

const { loadPdfJs } = vi.hoisted(() => ({ loadPdfJs: vi.fn() }));
vi.mock('@/lib/tools/pdfIo', () => ({ loadPdfJs }));

beforeEach(() => {
  loadPdfJs.mockReset();
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    fillStyle: '',
    fillRect: vi.fn(),
  } as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/png;base64,preview');
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function file() {
  return new File(['%PDF'], 'sample.pdf', { type: 'application/pdf' });
}

function loadedPreview() {
  const page = {
    getViewport: vi.fn(({ scale }: { scale: number }) => ({ width: 300 * scale, height: 500 * scale })),
    render: vi.fn(() => ({ promise: Promise.resolve() })),
    cleanup: vi.fn(),
  };
  const destroy = vi.fn(async () => {});
  loadPdfJs.mockResolvedValue({ doc: { getPage: vi.fn(async () => page), destroy } });
  return { page, destroy };
}

describe('RotateOptions', () => {
  it('renders a 180 px page-one preview and turns it with CSS', async () => {
    const { page, destroy } = loadedPreview();
    const input = file();
    const { rerender } = render(<RotateOptions options={DEFAULT_ROTATE_OPTIONS} onChange={vi.fn()} inputs={[input]} disabled={false} />);
    const preview = await screen.findByAltText('Page 1 preview') as HTMLImageElement;
    expect(preview.style.transform).toBe('rotate(0deg)');
    expect(page.getViewport).toHaveBeenLastCalledWith({ scale: 0.36 });
    expect(page.render).toHaveBeenCalledWith(expect.objectContaining({ intent: 'print' }));
    expect(page.cleanup).toHaveBeenCalledOnce();
    expect(destroy).toHaveBeenCalledOnce();

    rerender(<RotateOptions options={{ ...DEFAULT_ROTATE_OPTIONS, turns: 1 }} onChange={vi.fn()} inputs={[input]} disabled={false} />);
    expect((screen.getByAltText('Page 1 preview') as HTMLImageElement).style.transform).toBe('rotate(90deg)');
    expect(screen.getByText('Turned 90° right')).toBeTruthy();
  });

  it('turns right twice and reports 180°', () => {
    const onChange = vi.fn();
    const { rerender } = render(<RotateOptions options={DEFAULT_ROTATE_OPTIONS} onChange={onChange} inputs={[]} disabled={false} />);
    fireEvent.click(screen.getByRole('button', { name: 'Rotate right' }));
    expect(onChange).toHaveBeenLastCalledWith({ ...DEFAULT_ROTATE_OPTIONS, turns: 1 });
    rerender(<RotateOptions options={{ ...DEFAULT_ROTATE_OPTIONS, turns: 1 }} onChange={onChange} inputs={[]} disabled={false} />);
    fireEvent.click(screen.getByRole('button', { name: 'Rotate right' }));
    expect(onChange).toHaveBeenLastCalledWith({ ...DEFAULT_ROTATE_OPTIONS, turns: 2 });
    rerender(<RotateOptions options={{ ...DEFAULT_ROTATE_OPTIONS, turns: 2 }} onChange={onChange} inputs={[]} disabled={false} />);
    expect(screen.getByText('Turned 180°')).toBeTruthy();
  });

  it('turns left from zero and resets to an unchosen direction', () => {
    const onChange = vi.fn();
    const { rerender } = render(<RotateOptions options={DEFAULT_ROTATE_OPTIONS} onChange={onChange} inputs={[]} disabled={false} />);
    fireEvent.click(screen.getByRole('button', { name: 'Rotate left' }));
    expect(onChange).toHaveBeenLastCalledWith({ ...DEFAULT_ROTATE_OPTIONS, turns: 3 });
    rerender(<RotateOptions options={{ ...DEFAULT_ROTATE_OPTIONS, turns: 3 }} onChange={onChange} inputs={[]} disabled={false} />);
    expect(screen.getByText('Turned 90° left')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Reset' }));
    expect(onChange).toHaveBeenLastCalledWith({ ...DEFAULT_ROTATE_OPTIONS, turns: 0 });
    rerender(<RotateOptions options={DEFAULT_ROTATE_OPTIONS} onChange={onChange} inputs={[]} disabled={false} />);
    expect(screen.queryByRole('button', { name: 'Reset' })).toBeNull();
    expect(screen.getByText('Not turned yet')).toBeTruthy();
  });

  it('shows and updates ranges only for custom pages', () => {
    const onChange = vi.fn();
    const { rerender } = render(<RotateOptions options={DEFAULT_ROTATE_OPTIONS} onChange={onChange} inputs={[]} disabled={false} />);
    expect(screen.queryByLabelText('Pages or ranges')).toBeNull();
    fireEvent.change(screen.getByLabelText('Pages'), { target: { value: 'custom' } });
    expect(onChange).toHaveBeenLastCalledWith({ ...DEFAULT_ROTATE_OPTIONS, pageSelection: 'custom' });
    const custom = { ...DEFAULT_ROTATE_OPTIONS, pageSelection: 'custom' as const };
    rerender(<RotateOptions options={custom} onChange={onChange} inputs={[]} disabled={false} />);
    fireEvent.change(screen.getByLabelText('Pages or ranges'), { target: { value: '1-3, 5' } });
    expect(onChange).toHaveBeenLastCalledWith({ ...custom, ranges: '1-3, 5' });
  });

  it('keeps direction controls usable when preview loading fails', async () => {
    loadPdfJs.mockRejectedValue(new Error('preview failed'));
    const onChange = vi.fn();
    render(<RotateOptions options={DEFAULT_ROTATE_OPTIONS} onChange={onChange} inputs={[file()]} disabled={false} />);
    expect(await screen.findByText('Preview unavailable')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Rotate right' }));
    expect(onChange).toHaveBeenLastCalledWith({ ...DEFAULT_ROTATE_OPTIONS, turns: 1 });
  });

  it('disables all configurable controls while processing', () => {
    render(<RotateOptions options={DEFAULT_ROTATE_OPTIONS} onChange={vi.fn()} inputs={[]} disabled />);
    expect((screen.getByRole('group') as HTMLFieldSetElement).disabled).toBe(true);
  });
});
