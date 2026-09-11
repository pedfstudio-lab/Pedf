// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SAVED_SIGNATURES_KEY } from '@/lib/sign/savedSignatures';
import { SignatureMaker } from './SignatureMaker';

function inkImage(width = 24, height = 12): ImageData {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 4; y < 8; y++) for (let x = 3; x < width - 3; x++) {
    const offset = (y * width + x) * 4;
    data.set([20, 30, 50, 255], offset);
  }
  return { data, width, height, colorSpace: 'srgb' } as ImageData;
}

beforeEach(() => {
  localStorage.clear();
  const context = {
    clearRect: vi.fn(), beginPath: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(), quadraticCurveTo: vi.fn(), stroke: vi.fn(),
    putImageData: vi.fn(), drawImage: vi.fn(), fillText: vi.fn(), measureText: vi.fn(() => ({ width: 260 })),
    getImageData: vi.fn(() => inkImage()),
    set lineCap(_value: string) {}, set lineJoin(_value: string) {}, set strokeStyle(_value: string) {},
    set lineWidth(_value: number) {}, set font(_value: string) {}, set fillStyle(_value: string) {},
    set textBaseline(_value: string) {},
  } as unknown as CanvasRenderingContext2D;
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context);
  vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((callback) => callback(new Blob(['png'], { type: 'image/png' })));
  vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: 80, height: 40, close: vi.fn() })));
});

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function upload(input: HTMLInputElement, file: File) {
  fireEvent.change(input, { target: { files: [file] } });
}

describe('SignatureMaker', () => {
  it('draws strokes and supports Undo and Clear', () => {
    render(<SignatureMaker onDone={vi.fn()} />);
    const use = screen.getByRole('button', { name: 'Use this signature' }) as HTMLButtonElement;
    expect(use.disabled).toBe(true);
    const canvas = screen.getByLabelText('Draw your signature');
    fireEvent.pointerDown(canvas, { button: 0, buttons: 1, pointerId: 1, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(canvas, { buttons: 1, pointerId: 1, clientX: 40, clientY: 20 });
    fireEvent.pointerUp(canvas, { pointerId: 1 });
    expect(use.disabled).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Undo stroke' }));
    expect(use.disabled).toBe(true);
    fireEvent.pointerDown(canvas, { button: 0, buttons: 1, pointerId: 2, clientX: 20, clientY: 20 });
    fireEvent.pointerUp(canvas, { pointerId: 2 });
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    expect(use.disabled).toBe(true);
  });

  it('offers all three type fonts and guides other scripts', async () => {
    const done = vi.fn();
    render(<SignatureMaker onDone={done} />);
    fireEvent.click(screen.getByRole('tab', { name: 'Type' }));
    fireEvent.change(screen.getByLabelText('Your name'), { target: { value: 'Sidharth' } });
    for (const font of ['Caveat', 'Dancing Script', 'Great Vibes']) {
      expect(screen.getByRole('radio', { name: new RegExp(font) })).toBeTruthy();
    }
    fireEvent.click(screen.getByRole('radio', { name: /Great Vibes/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Use this signature' }));
    await waitFor(() => expect(done).toHaveBeenCalledTimes(1));
    expect(done.mock.calls[0]![0]).toMatchObject({ width: expect.any(Number), height: expect.any(Number) });

    cleanup();
    render(<SignatureMaker onDone={vi.fn()} />);
    fireEvent.click(screen.getByRole('tab', { name: 'Type' }));
    fireEvent.change(screen.getByLabelText('Your name'), { target: { value: 'सिद्धार्थ' } });
    expect(screen.getByText('Use Draw or Upload for other scripts.')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Use this signature' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('validates uploads and shows live cleaning controls', async () => {
    render(<SignatureMaker onDone={vi.fn()} />);
    fireEvent.click(screen.getByRole('tab', { name: 'Upload' }));
    const picker = document.querySelector<HTMLInputElement>('.signature-upload-button input')!;
    upload(picker, new File(['heic'], 'photo.heic', { type: 'image/heic' }));
    expect(await screen.findByText('Convert HEIC to JPG on your phone first.')).toBeTruthy();
    upload(picker, new File([new Uint8Array(10 * 1024 * 1024 + 1)], 'huge.png', { type: 'image/png' }));
    expect(await screen.findByText('Choose an image smaller than 10 MB.')).toBeTruthy();
    upload(picker, new File([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], 'paper.png', { type: 'image/png' }));
    expect(await screen.findByLabelText('Cleaned signature preview')).toBeTruthy();
    expect((screen.getByLabelText('Clean up background') as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText('Remove notebook lines') as HTMLInputElement).checked).toBe(true);
    fireEvent.change(screen.getByLabelText(/Cleaning strength/), { target: { value: '80' } });
    fireEvent.change(screen.getByLabelText('Ink colour'), { target: { value: 'blue' } });
    expect((screen.getByLabelText(/Cleaning strength/) as HTMLInputElement).value).toBe('80');
    expect((screen.getByLabelText('Ink colour') as HTMLSelectElement).value).toBe('blue');
  });

  it('writes browser storage only when Remember is selected', async () => {
    const done = vi.fn();
    render(<SignatureMaker onDone={done} />);
    fireEvent.click(screen.getByRole('tab', { name: 'Type' }));
    fireEvent.change(screen.getByLabelText('Your name'), { target: { value: 'Rahul' } });
    fireEvent.click(screen.getByRole('button', { name: 'Use this signature' }));
    await waitFor(() => expect(done).toHaveBeenCalledTimes(1));
    expect(localStorage.getItem(SAVED_SIGNATURES_KEY)).toBeNull();

    cleanup();
    render(<SignatureMaker onDone={vi.fn()} />);
    fireEvent.click(screen.getByRole('tab', { name: 'Type' }));
    fireEvent.change(screen.getByLabelText('Your name'), { target: { value: 'Rahul' } });
    fireEvent.click(screen.getByRole('checkbox', { name: /Remember on this device/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Use this signature' }));
    await waitFor(() => expect(localStorage.getItem(SAVED_SIGNATURES_KEY)).not.toBeNull());
  });
});
