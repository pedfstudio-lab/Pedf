// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { DEFAULT_SIGN_OPTIONS } from '@/lib/tools/signOptions';
import type { ToolOptions } from '@/lib/tools/types';
import { SignOptions } from './SignOptions';

const { previewPdfPage, previewPdfPages } = vi.hoisted(() => ({
  previewPdfPage: vi.fn(async (_file: File, pageIndex: number) => ({
    thumbnail: `data:image/png;base64,stage${pageIndex}`,
    size: { w: 400, h: 600 },
  })),
  previewPdfPages: vi.fn(async (
    _file: File,
    _signal: AbortSignal,
    onPage: (index: number, thumbnail: string, size: { w: number; h: number }) => void,
    _size: number,
    onCount: (count: number) => void,
  ) => {
    onCount(3);
    for (let index = 0; index < 3; index++) onPage(index, `data:image/png;base64,page${index}`, { w: 400, h: 600 });
  }),
}));

vi.mock('@/components/sign/SignatureMaker', () => ({
  SignatureMaker: ({ onDone }: { onDone(value: unknown): void }) => <button type="button" onClick={() => onDone({
    png: new Uint8Array([137, 80, 78, 71]), width: 400, height: 120,
  })}>Make test signature</button>,
}));

vi.mock('@/lib/tools/preview', () => ({ previewPdfPage, previewPdfPages }));

const PDF_FILE = new File(['pdf'], 'form.pdf', { type: 'application/pdf' });

function Harness({ onChanged }: { onChanged?: (options: ToolOptions) => void }) {
  const [options, setOptions] = useState<ToolOptions>(DEFAULT_SIGN_OPTIONS);
  return <SignOptions options={options} inputs={[PDF_FILE]}
    disabled={false} onChange={(next) => { setOptions(next); onChanged?.(next); }} />;
}

beforeEach(() => {
  vi.stubGlobal('URL', { ...URL, createObjectURL: vi.fn(() => 'blob:signature'), revokeObjectURL: vi.fn() });
});

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('SignOptions', () => {
  it('explains the signature type and opens on the last page', async () => {
    render(<Harness />);
    expect(screen.getByText(/not a certified digital signature/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Make test signature' })).toBeTruthy();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Page 3' }).getAttribute('aria-pressed')).toBe('true'));
  });

  it('accepts a signature, previews it, and updates page/date choices', async () => {
    const changes: ToolOptions[] = [];
    render(<Harness onChanged={(value) => changes.push(value)} />);
    fireEvent.click(screen.getByRole('button', { name: 'Make test signature' }));
    expect(await screen.findByText('Signature ready')).toBeTruthy();
    expect(await screen.findByRole('button', { name: /Move the signature/ })).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Add the date'), { target: { value: 'numeric' } });
    expect((screen.getByLabelText('Add the date') as HTMLSelectElement).value).toBe('numeric');
    fireEvent.change(screen.getByLabelText('Apply to'), { target: { value: 'all' } });
    expect(screen.queryByLabelText('Choose preview page')).toBeNull();
    fireEvent.change(screen.getByLabelText('Apply to'), { target: { value: 'custom' } });
    fireEvent.change(screen.getByLabelText('Pages or ranges'), { target: { value: '1, 3' } });
    expect(changes.at(-1)!.ranges).toBe('1, 3');
  });

  it('shows and changes the placement stage without waiting for streamed thumbnails', async () => {
    previewPdfPages.mockImplementationOnce(async (_file, _signal, _onPage, _size, onCount) => {
      onCount(3);
      await new Promise<void>(() => {});
    });
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Make test signature' }));
    expect(await screen.findByRole('button', { name: /Move the signature/ })).toBeTruthy();
    await waitFor(() => expect(previewPdfPage).toHaveBeenLastCalledWith(PDF_FILE, 2, expect.any(AbortSignal), 420));
    fireEvent.click(screen.getByRole('button', { name: 'Page 2' }));
    await waitFor(() => expect(previewPdfPage).toHaveBeenLastCalledWith(PDF_FILE, 1, expect.any(AbortSignal), 420));
  });
});
