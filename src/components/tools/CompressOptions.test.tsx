// @vitest-environment jsdom
import { useState } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CompressAnalysis } from '@/lib/compress/analyze';
import { DEFAULT_COMPRESS_OPTIONS } from '@/lib/tools/compressOptions';
import type { ToolOptions } from '@/lib/tools/types';
import { CompressOptions } from './CompressOptions';

const mocks = vi.hoisted(() => ({
  analyzeFile: vi.fn(),
  estimateFileLevels: vi.fn(),
  estimateAllLevels: vi.fn(),
}));

vi.mock('@/lib/compress/analyze', () => ({ analyzeFile: mocks.analyzeFile }));
vi.mock('@/lib/compress/estimate', () => ({
  estimateFileLevels: mocks.estimateFileLevels,
  estimateAllLevels: mocks.estimateAllLevels,
}));

const estimates = { light: 2_000_000, medium: 1_153_434, strong: 400_000, smallest: 250_000 };

function analysis(extra: Partial<CompressAnalysis> = {}): CompressAnalysis {
  return {
    fileSize: 3_565_158,
    bytesInShrinkableImages: 3_040_870,
    photoCount: 12,
    skippedCount: 3,
    signed: false,
    images: [],
    ...extra,
    trailingBytes: extra.trailingBytes ?? 0,
    unusedPhotoBytes: extra.unusedPhotoBytes ?? 0,
    unusedPhotoCount: extra.unusedPhotoCount ?? 0,
    duplicateBytes: extra.duplicateBytes ?? 0,
    duplicateCount: extra.duplicateCount ?? 0,
    namesIncomplete: extra.namesIncomplete ?? false,
  };
}

function pdf(name = 'scan.pdf'): File {
  return new File(['%PDF-1.7'], name, { type: 'application/pdf', lastModified: name.length });
}

const DEFAULT_FILE = pdf();

function Harness({ file = DEFAULT_FILE }: { file?: File }) {
  const [options, setOptions] = useState<ToolOptions>(DEFAULT_COMPRESS_OPTIONS);
  return <><CompressOptions options={options} onChange={setOptions} inputs={[file]} disabled={false} />
    <output data-testid="options">{JSON.stringify(options)}</output></>;
}

beforeEach(() => {
  mocks.analyzeFile.mockReset().mockResolvedValue(analysis());
  mocks.estimateFileLevels.mockReset().mockResolvedValue(estimates);
  mocks.estimateAllLevels.mockReset().mockReturnValue(estimates);
});
afterEach(cleanup);

describe('CompressOptions', () => {
  it('shows the file breakdown, level cards and estimates', async () => {
    render(<Harness />);
    expect(screen.getByText('Checking the file…')).toBeTruthy();
    expect(await screen.findByText('12 photos take 2.9 MB of this 3.4 MB file.')).toBeTruthy();
    expect(screen.getByRole('radio', { name: /Light/ })).toBeTruthy();
    expect(screen.getByRole('radio', { name: /Medium/ })).toBeTruthy();
    expect(screen.getByRole('radio', { name: /Strong/ })).toBeTruthy();
    expect(screen.getByRole('radio', { name: /^SmallestFor strict upload limits/ })).toBeTruthy();
    expect(screen.getByText('For strict upload limits · photos get soft')).toBeTruthy();
    expect(screen.getByRole('radio', { name: /Fit under a size/ })).toBeTruthy();
    expect(await screen.findByText('about 1.1 MB')).toBeTruthy();
    expect((screen.getByRole('radio', { name: /Medium/ }) as HTMLInputElement).checked).toBe(true);
  });

  it('offers Fit presets, custom validation and the gentlest recommendation', async () => {
    render(<Harness />);
    await screen.findByText('about 1.1 MB');
    fireEvent.click(screen.getByRole('radio', { name: /Fit under a size/ }));
    expect(screen.getByRole('button', { name: '200 KB' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '500 KB' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '1 MB' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '2 MB' })).toBeTruthy();
    expect(screen.getByText(/gentlest level expected to fit/).closest('p')?.textContent)
      .toBe('Strong is the gentlest level expected to fit.');

    fireEvent.click(screen.getByRole('button', { name: 'Custom' }));
    const input = screen.getByLabelText('Custom size limit');
    fireEvent.change(input, { target: { value: '10' } });
    expect(screen.getByRole('alert').textContent).toBe('Enter a size limit of at least 20 KB.');
    fireEvent.change(input, { target: { value: '600' } });
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    expect(screen.getByLabelText('Size unit')).toBeTruthy();
  });

  it('explains signed-file invalidation and records consent', async () => {
    mocks.analyzeFile.mockResolvedValue(analysis({ signed: true }));
    render(<Harness file={pdf('signed.pdf')} />);
    expect(await screen.findByText('This file is digitally signed. Compressing it makes the signature invalid.')).toBeTruthy();
    fireEvent.click(screen.getByRole('checkbox', { name: 'I understand' }));
    await waitFor(() => expect(screen.getByTestId('options').textContent).toContain('"acceptSignatureLoss":true'));
  });

  it('sets expectations for a mostly-text file', async () => {
    mocks.analyzeFile.mockResolvedValue(analysis({ photoCount: 0, bytesInShrinkableImages: 0 }));
    render(<Harness file={pdf('text.pdf')} />);
    expect(await screen.findByText('This file is mostly text and fonts, so it may not get much smaller.')).toBeTruthy();
  });

  it('shows meaningful lossless findings and labels an ineffective level No change', async () => {
    mocks.analyzeFile.mockResolvedValue(analysis({
      trailingBytes: 12 * 1024 * 1024,
      unusedPhotoBytes: Math.round(0.6 * 1024 * 1024),
      unusedPhotoCount: 4,
      duplicateBytes: 300_000,
      duplicateCount: 3,
    }));
    mocks.estimateFileLevels.mockResolvedValue({
      light: 3_500_000, medium: 3_450_000, strong: 2_000_000, smallest: 1_500_000,
    });
    render(<Harness file={pdf('findings.pdf')} />);
    expect(await screen.findByText('12 MB of this file is empty padding left by another tool. We remove it.')).toBeTruthy();
    expect(screen.getByText('4 photos (0.6 MB) are not shown on any page. We remove them.')).toBeTruthy();
    expect(screen.getByText('3 photos are stored more than once. We store them once.')).toBeTruthy();
    expect(await screen.findAllByText('No change')).toHaveLength(2);
  });
});
