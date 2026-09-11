// @vitest-environment jsdom
import { useState } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Inspection } from '@/lib/tools/repairInspect';
import type { ToolOptions } from '@/lib/tools/types';
import { RepairOptions } from './RepairOptions';

const { inspectPdf } = vi.hoisted(() => ({ inspectPdf: vi.fn() }));
vi.mock('@/lib/tools/repairInspect', () => ({ inspectPdf }));

function pdf(name: string): File {
  return new File(['%PDF-1.7'], name, { type: 'application/pdf', lastModified: name.length });
}

function Harness({ files }: { files: File[] }) {
  const [options, setOptions] = useState<ToolOptions>({ repairAnyway: false, acceptSignatureLoss: false });
  return <><RepairOptions options={options} onChange={setOptions} inputs={files} disabled={false} />
    <output data-testid="options">{JSON.stringify(options)}</output></>;
}

beforeEach(() => inspectPdf.mockReset());
afterEach(cleanup);

describe('RepairOptions', () => {
  it('shows inspection progress without blocking the page render', async () => {
    inspectPdf.mockImplementation(async (_bytes: Uint8Array, onProgress?: (done: number, total: number) => void) => {
      onProgress?.(12, 80);
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
      return { kind: 'healthy', pageCount: 80, signed: false } satisfies Inspection;
    });
    render(<Harness files={[pdf('large.pdf')]} />);
    expect(await screen.findByText('Checking your file… (page 12 of 80)')).toBeTruthy();
    expect(await screen.findByText('This file looks healthy.')).toBeTruthy();
  });

  it('shows a healthy card and records Repair anyway', async () => {
    inspectPdf.mockResolvedValue({ kind: 'healthy', pageCount: 2, signed: false });
    render(<Harness files={[pdf('healthy.pdf')]} />);
    expect(await screen.findByText('This file looks healthy.')).toBeTruthy();
    fireEvent.click(screen.getByRole('checkbox', { name: /Repair anyway/ }));
    await waitFor(() => expect(screen.getByTestId('options').textContent).toContain('"repairAnyway":true'));
  });

  it('shows damaged problems and asks for signature consent', async () => {
    inspectPdf.mockResolvedValue({
      kind: 'damaged', pageCount: 9, badPages: [6, 8],
      problems: ["the file's index is broken", "2 pages can't be read (pages 7, 9)"], signed: true,
    });
    render(<Harness files={[pdf('signed-damaged.pdf')]} />);
    expect(await screen.findByText('This file is damaged:')).toBeTruthy();
    expect(screen.getByText("2 pages can't be read (pages 7, 9)")).toBeTruthy();
    expect(screen.getByText('This file has a digital signature. Any repair makes the signature invalid.')).toBeTruthy();
    fireEvent.click(screen.getByRole('checkbox', { name: 'I understand' }));
    await waitFor(() => expect(screen.getByTestId('options').textContent).toContain('"acceptSignatureLoss":true'));
  });

  it.each([
    [{ kind: 'locked' }, "This file is password-protected or restricted, not damaged. Repair can't change it."],
    [{ kind: 'not-pdf' }, "This isn't a PDF file. It may be a web page or another file saved with a .pdf name."],
  ] as const)('shows a red terminal card for %s', async (inspection, message) => {
    inspectPdf.mockResolvedValue(inspection);
    render(<Harness files={[pdf('bad.pdf')]} />);
    expect(await screen.findByText(message)).toBeTruthy();
  });

  it('cancels the old check and re-checks when the selected file changes', async () => {
    inspectPdf.mockResolvedValue({ kind: 'healthy', pageCount: 1, signed: false });
    const first = pdf('first.pdf');
    const { rerender } = render(<Harness files={[first]} />);
    await screen.findByText('This file looks healthy.');
    rerender(<Harness files={[pdf('second.pdf')]} />);
    await waitFor(() => expect(inspectPdf).toHaveBeenCalledTimes(2));
    expect(screen.getByTestId('options').textContent).toContain('second.pdf');
  });
});
