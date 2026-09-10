// @vitest-environment jsdom
import { useCallback, useState } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_ORGANIZE_OPTIONS } from '@/lib/tools/organizeOptions';
import type { OrganizeOptionsValue } from '@/lib/tools/organizeOptions';
import { fileKey } from '@/lib/tools/organizePlan';
import type { ToolOptions } from '@/lib/tools/types';
import { OrganizeOptions } from './OrganizeOptions';

const { previewPdfPages } = vi.hoisted(() => ({ previewPdfPages: vi.fn() }));
vi.mock('@/lib/tools/preview', () => ({ previewPdfPages }));

function pdf(name: string, size: number, lastModified: number) {
  return new File([new Uint8Array(size)], name, { type: 'application/pdf', lastModified });
}

const first = pdf('First.pdf', 10, 1);
const second = pdf('Second.pdf', 20, 2);

function Harness({ inputs, disabled = false, changed = vi.fn() }: {
  inputs: File[];
  disabled?: boolean;
  changed?: ReturnType<typeof vi.fn>;
}) {
  const [options, setOptions] = useState<OrganizeOptionsValue>(DEFAULT_ORGANIZE_OPTIONS);
  const onChange = useCallback((next: ToolOptions) => {
    changed(next);
    setOptions(next as OrganizeOptionsValue);
  }, [changed]);
  return <OrganizeOptions options={options} onChange={onChange} inputs={inputs} disabled={disabled} />;
}

beforeEach(() => {
  previewPdfPages.mockReset().mockImplementation(async (
    file: File,
    signal: AbortSignal,
    onPage: (pageIndex: number, thumbnail: string, size: { w: number; h: number }) => void,
  ) => {
    const count = file.name === 'First.pdf' ? 3 : 2;
    for (let index = 0; index < count; index++) {
      signal.throwIfAborted();
      onPage(index, `data:image/png;base64,${file.name}-${index}`, { w: 300 + index * 10, h: 400 + index * 10 });
    }
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

async function waitForCards(count: number) {
  await waitFor(() => expect(screen.getAllByRole('listitem')).toHaveLength(count));
}

describe('OrganizeOptions', () => {
  it('streams one thumbnail card per page with captions', async () => {
    render(<Harness inputs={[first]} />);
    await waitForCards(3);
    expect(screen.getAllByRole('img')).toHaveLength(3);
    expect(screen.getByText('3 pages')).toBeTruthy();
    expect(screen.getByText('Page 1')).toBeTruthy();
    expect(screen.getByText('Page 3')).toBeTruthy();
  });

  it('deletes page 2 and rotates page 1 with a live CSS turn', async () => {
    const changed = vi.fn();
    render(<Harness inputs={[first]} changed={changed} />);
    await waitForCards(3);
    fireEvent.click(screen.getByRole('button', { name: 'Delete page 2' }));
    await waitForCards(2);
    expect((changed.mock.calls.at(-1)?.[0] as OrganizeOptionsValue).plan
      .map((entry) => entry.kind === 'page' ? entry.pageIndex : -1)).toEqual([0, 2]);
  });

  it('rotates a thumbnail and moves page 3 left', async () => {
    const changed = vi.fn();
    render(<Harness inputs={[first]} changed={changed} />);
    await waitForCards(3);
    fireEvent.click(screen.getByRole('button', { name: 'Rotate page 1 right' }));
    expect((screen.getByAltText('Page 1 thumbnail') as HTMLImageElement).style.transform).toBe('rotate(90deg)');
    expect((changed.mock.calls.at(-1)?.[0] as OrganizeOptionsValue).plan[0]).toMatchObject({ turns: 1 });
    fireEvent.click(screen.getByRole('button', { name: 'Move page 3 left' }));
    expect((changed.mock.calls.at(-1)?.[0] as OrganizeOptionsValue).plan
      .map((entry) => entry.kind === 'page' ? entry.pageIndex : -1)).toEqual([0, 2, 1]);
  });

  it('duplicates a page and inserts a same-size blank after it', async () => {
    const changed = vi.fn();
    render(<Harness inputs={[first]} changed={changed} />);
    await waitForCards(3);
    fireEvent.click(screen.getByRole('button', { name: 'Duplicate page 1' }));
    await waitForCards(4);
    let plan = (changed.mock.calls.at(-1)?.[0] as OrganizeOptionsValue).plan;
    expect(plan[0]).toMatchObject({ kind: 'page', pageIndex: 0 });
    expect(plan[1]).toMatchObject({ kind: 'page', pageIndex: 0 });
    fireEvent.click(screen.getByRole('button', { name: 'Insert blank page after 1' }));
    await waitForCards(5);
    plan = (changed.mock.calls.at(-1)?.[0] as OrganizeOptionsValue).plan;
    expect(plan[1]).toEqual(expect.objectContaining({ kind: 'blank', widthPt: 300, heightPt: 400 }));
  });

  it('resets an edited plan to the original page order', async () => {
    const changed = vi.fn();
    render(<Harness inputs={[first]} changed={changed} />);
    await waitForCards(3);
    fireEvent.click(screen.getByRole('button', { name: 'Move page 3 left' }));
    fireEvent.click(screen.getByRole('button', { name: 'Reset' }));
    expect((changed.mock.calls.at(-1)?.[0] as OrganizeOptionsValue).plan
      .map((entry) => entry.kind === 'page' ? entry.pageIndex : -1)).toEqual([0, 1, 2]);
  });

  it('appends pages from a second file and drops them when that file is removed', async () => {
    const { rerender } = render(<Harness inputs={[first]} />);
    await waitForCards(3);
    rerender(<Harness inputs={[first, second]} />);
    await waitForCards(5);
    expect(screen.getAllByText('Second')).toHaveLength(2);
    rerender(<Harness inputs={[first]} />);
    await waitForCards(3);
    expect(screen.queryByText('Second')).toBeNull();
  });

  it('keeps simultaneous multi-file drops in input order when previews finish at different speeds', async () => {
    let releaseFirst!: () => void;
    const firstReady = new Promise<void>((resolve) => { releaseFirst = resolve; });
    previewPdfPages.mockImplementation(async (
      file: File,
      signal: AbortSignal,
      onPage: (pageIndex: number, thumbnail: string, size: { w: number; h: number }) => void,
    ) => {
      if (file === first) await firstReady;
      const count = file === first ? 3 : 2;
      for (let index = 0; index < count; index++) {
        signal.throwIfAborted();
        onPage(index, `data:image/png;base64,${file.name}-${index}`, { w: 300, h: 400 });
      }
    });
    const changed = vi.fn();
    render(<Harness inputs={[first, second]} changed={changed} />);
    await waitFor(() => expect(previewPdfPages).toHaveBeenCalledTimes(1));
    expect(previewPdfPages).toHaveBeenLastCalledWith(
      first, expect.any(AbortSignal), expect.any(Function), 140, expect.any(Function),
    );

    releaseFirst();
    await waitForCards(5);
    await waitFor(() => expect(previewPdfPages).toHaveBeenCalledTimes(2));
    const plan = (changed.mock.calls.at(-1)?.[0] as OrganizeOptionsValue).plan;
    expect(plan.map((entry) => entry.kind === 'page' ? entry.fileKey : 'blank')).toEqual([
      fileKey(first), fileKey(first), fileKey(first), fileKey(second), fileKey(second),
    ]);
  });

  it('lays out every page as soon as the count is known, before thumbnails arrive', async () => {
    let releasePages!: () => void;
    const pagesReady = new Promise<void>((resolve) => { releasePages = resolve; });
    previewPdfPages.mockImplementation(async (
      file: File,
      signal: AbortSignal,
      onPage: (pageIndex: number, thumbnail: string, size: { w: number; h: number }) => void,
      _longSide: number,
      onCount?: (count: number) => void,
    ) => {
      onCount?.(3);
      await pagesReady;
      for (let index = 0; index < 3; index++) {
        signal.throwIfAborted();
        onPage(index, `data:image/png;base64,${file.name}-${index}`, { w: 300, h: 400 });
      }
    });
    const changed = vi.fn();
    render(<Harness inputs={[first]} changed={changed} />);
    await waitForCards(3);
    expect(screen.queryAllByRole('img')).toHaveLength(0);
    expect(screen.getAllByLabelText(/Loading page/)).toHaveLength(3);
    expect((screen.getByRole('button', { name: 'Insert blank page after 1' }) as HTMLButtonElement).disabled).toBe(true);
    expect((changed.mock.calls.at(-1)?.[0] as OrganizeOptionsValue).plan).toHaveLength(3);

    releasePages();
    await waitFor(() => expect(screen.getAllByRole('img')).toHaveLength(3));
    expect((screen.getByRole('button', { name: 'Insert blank page after 1' }) as HTMLButtonElement).disabled).toBe(false);
    expect((changed.mock.calls.at(-1)?.[0] as OrganizeOptionsValue).plan).toHaveLength(3);
  });

  it('supports drag reordering and disables the whole panel during processing', async () => {
    const changed = vi.fn();
    const { rerender } = render(<Harness inputs={[first]} changed={changed} />);
    await waitForCards(3);
    const cards = screen.getAllByRole('listitem');
    fireEvent.dragStart(cards[0]!, { dataTransfer: { effectAllowed: '', setData: vi.fn() } });
    fireEvent.dragOver(cards[2]!, { dataTransfer: {} });
    fireEvent.drop(cards[2]!, { dataTransfer: {} });
    expect((changed.mock.calls.at(-1)?.[0] as OrganizeOptionsValue).plan
      .map((entry) => entry.kind === 'page' ? entry.pageIndex : -1)).toEqual([1, 2, 0]);
    rerender(<Harness inputs={[first]} changed={changed} disabled />);
    expect((screen.getByRole('group') as HTMLFieldSetElement).disabled).toBe(true);
  });
});
