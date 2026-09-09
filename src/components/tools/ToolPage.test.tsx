// @vitest-environment jsdom
import { StrictMode } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { navigate } from '@/lib/site/navigate';
import { setPendingFiles, takePendingFiles } from '@/lib/site/pendingFiles';
import { downloadBytes, zipOutputs } from '@/lib/tools/download';
import { getTool, registerTool } from '@/lib/tools/registry';
import type { ToolContext, ToolDefinition, ToolOutput } from '@/lib/tools/types';
import { ToolPage } from './ToolPage';

vi.mock('@/lib/site/navigate', () => ({ navigate: vi.fn() }));
vi.mock('@/lib/tools/download', () => ({ downloadBytes: vi.fn(), zipOutputs: vi.fn(() => new Uint8Array([80, 75])) }));
vi.mock('@/lib/tools/preview', () => ({ previewPdf: vi.fn(async () => ({ pages: 2, thumbnail: 'data:image/png;base64,AA==' })) }));

const result: ToolOutput = { name: 'result.pdf', bytes: new Uint8Array([1, 2]), mime: 'application/pdf' };
const run = vi.fn<ToolDefinition['run']>();
const dummy: ToolDefinition = {
  slug: 'dummy', title: 'Test PDF tool', description: 'A local processing test.',
  accepts: 'pdf', multiple: true, defaultOptions: { label: 'Default' }, run,
  Options: ({ options, onChange, disabled }) => <label>Output label<input disabled={disabled} value={String(options.label)}
    onChange={(event) => onChange({ label: event.target.value })} /></label>,
};
registerTool(dummy);

function show(tool = getTool('dummy')!) { return render(<StrictMode><ToolPage tool={tool} /></StrictMode>); }
function pick(...files: File[]) { fireEvent.change(screen.getByLabelText(/Choose files|Choose a file/), { target: { files } }); }
const file = (name: string) => new File(['%PDF-1.7'], name, { type: 'application/pdf' });

beforeEach(() => {
  takePendingFiles();
  vi.clearAllMocks();
  run.mockReset().mockResolvedValue([result]);
});
afterEach(() => { cleanup(); takePendingFiles(); });

describe('ToolPage', () => {
  it('renders a registered tool and sets/restores page metadata', () => {
    document.title = 'Original title';
    const meta = document.createElement('meta');
    meta.name = 'description'; meta.content = 'Original description'; document.head.append(meta);
    const { unmount } = show();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(dummy.title);
    expect((screen.getByRole('button', { name: dummy.title }) as HTMLButtonElement).disabled).toBe(true);
    expect(document.title).toBe('Test PDF tool — PEDF Studio');
    expect(meta.content).toBe(dummy.description);
    unmount();
    expect(document.title).toBe('Original title');
    expect(meta.content).toBe('Original description');
    meta.remove();
  });

  it('takes pending files only once under StrictMode', async () => {
    const first = file('pending.pdf');
    setPendingFiles([first]);
    show();
    expect(screen.getAllByText('pending.pdf')).toHaveLength(1);
    expect(takePendingFiles()).toEqual([]);
    expect(await screen.findByText('2 pages')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: dummy.title }));
    expect(await screen.findByRole('region', { name: 'Results' })).toBeTruthy();
    expect(run.mock.calls[0]?.[0]).toEqual([first]);
  });

  it('passes reordered files and custom options to run, then downloads individual and zipped outputs', async () => {
    run.mockResolvedValue([result, { ...result, name: 'second.pdf' }]);
    show();
    const first = file('first.pdf'); const second = file('second.pdf');
    pick(first, second);
    expect(await screen.findAllByText('2 pages')).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: 'Move second.pdf up' }));
    fireEvent.change(screen.getByLabelText('Output label'), { target: { value: 'Chosen' } });
    fireEvent.click(screen.getByRole('button', { name: dummy.title }));
    const results = await screen.findByRole('region', { name: 'Results' });
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0]?.[0]).toEqual([second, first]);
    expect(run.mock.calls[0]?.[1]).toEqual({ label: 'Chosen' });
    fireEvent.click(within(results).getAllByRole('button', { name: 'Download' })[0]!);
    expect(downloadBytes).toHaveBeenCalledWith(result.name, result.bytes, result.mime);
    fireEvent.click(screen.getByRole('button', { name: 'Download all (.zip)' }));
    expect(zipOutputs).toHaveBeenCalledWith([result, { ...result, name: 'second.pdf' }]);
    expect(downloadBytes).toHaveBeenCalledWith('dummy-results.zip', new Uint8Array([80, 75]), 'application/zip');
  });

  it('supports drop, drag-to-reorder, and removing inputs', async () => {
    show();
    const first = file('first.pdf'); const second = file('second.pdf'); const third = file('third.pdf');
    fireEvent.drop(screen.getByRole('button', { name: /Drop PDF files here/ }), { dataTransfer: { files: [first, second, third] } });
    const items = within(screen.getByRole('region', { name: 'Selected files' })).getAllByRole('listitem');
    fireEvent.dragStart(items[0]!, { dataTransfer: { setData: vi.fn() } });
    fireEvent.drop(items[1]!);
    fireEvent.click(screen.getByRole('button', { name: 'Remove third.pdf' }));
    fireEvent.click(screen.getByRole('button', { name: dummy.title }));
    await screen.findByRole('region', { name: 'Results' });
    expect(run.mock.calls[0]?.[0]).toEqual([second, first]);
  });

  it('shows progress and cancels, ignoring late results even after a retry', async () => {
    let finish!: (outputs: ToolOutput[]) => void;
    let context!: ToolContext;
    run.mockImplementationOnce((_files, _options, ctx) => {
      context = ctx;
      ctx.onProgress(1, 4, 'Reading pages');
      return new Promise((resolve) => { finish = resolve; });
    });
    show(); pick(file('cancel.pdf'));
    fireEvent.click(screen.getByRole('button', { name: dummy.title }));
    expect(screen.getByRole('status').textContent).toBe('Reading pages');
    expect(screen.getByRole('progressbar').getAttribute('value')).toBe('25');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(context.signal.aborted).toBe(true);
    expect(screen.getByRole('status').textContent).toContain('Cancelled');
    fireEvent.click(screen.getByRole('button', { name: dummy.title }));
    await screen.findByRole('region', { name: 'Results' });
    await act(async () => { finish([{ ...result, name: 'stale.pdf' }]); });
    expect(screen.queryByText('stale.pdf')).toBeNull();
    expect(screen.getByText('result.pdf')).toBeTruthy();
  });

  it('opens PDF output in the editor through the pending-file handoff', async () => {
    show(); pick(file('source.pdf'));
    fireEvent.click(screen.getByRole('button', { name: dummy.title }));
    fireEvent.click(await screen.findByRole('button', { name: 'Open in editor' }));
    expect(navigate).toHaveBeenCalledWith('/app');
    const pending = takePendingFiles();
    expect(pending).toHaveLength(1);
    expect(pending[0]?.name).toBe(result.name);
    expect(pending[0]?.type).toBe('application/pdf');
    expect(pending[0]?.size).toBe(result.bytes.byteLength);
  });

  it('starts over with no files and default options', async () => {
    show(); pick(file('source.pdf'));
    fireEvent.change(screen.getByLabelText('Output label'), { target: { value: 'Changed' } });
    fireEvent.click(screen.getByRole('button', { name: dummy.title }));
    fireEvent.click(await screen.findByRole('button', { name: 'Start over' }));
    expect(screen.queryByRole('region', { name: 'Selected files' })).toBeNull();
    expect(screen.queryByRole('region', { name: 'Results' })).toBeNull();
    expect((screen.getByLabelText('Output label') as HTMLInputElement).value).toBe('Default');
  });

  it('rejects invalid file types and multi-file drops on single-file tools', () => {
    show({ ...dummy, multiple: false });
    pick(new File(['text'], 'notes.txt'));
    expect(screen.getByRole('alert').textContent).toBe('Choose a PDF file.');
    pick(file('one.pdf'), file('two.pdf'));
    expect(screen.getByRole('alert').textContent).toBe('Choose one file at a time.');
    expect(run).not.toHaveBeenCalled();
  });

  it('shows friendly errors and allows a retry', async () => {
    run.mockRejectedValueOnce(new Error('This PDF has a password. Unlock it first.'));
    show(); pick(file('locked.pdf'));
    fireEvent.click(screen.getByRole('button', { name: dummy.title }));
    expect((await screen.findByRole('alert')).textContent).toBe('This PDF has a password. Unlock it first.');
    await waitFor(() => expect((screen.getByRole('button', { name: dummy.title }) as HTMLButtonElement).disabled).toBe(false));
  });

  it('aborts processing on unmount', () => {
    let signal!: AbortSignal;
    run.mockImplementationOnce((_files, _options, ctx) => {
      signal = ctx.signal;
      return new Promise(() => {});
    });
    const { unmount } = show(); pick(file('source.pdf'));
    fireEvent.click(screen.getByRole('button', { name: dummy.title }));
    unmount();
    expect(signal.aborted).toBe(true);
  });
});
