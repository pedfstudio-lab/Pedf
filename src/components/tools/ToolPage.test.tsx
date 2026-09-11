// @vitest-environment jsdom
import { StrictMode } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { navigate } from '@/lib/site/navigate';
import { setPendingFiles, takePendingFiles } from '@/lib/site/pendingFiles';
import { downloadBytes, zipOutputs } from '@/lib/tools/download';
import { ToolError } from '@/lib/tools/errors';
import { previewPdf } from '@/lib/tools/preview';
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
  vi.mocked(previewPdf).mockResolvedValue({ pages: 2, thumbnail: 'data:image/png;base64,AA==' });
});
afterEach(() => { cleanup(); takePendingFiles(); });

describe('ToolPage', () => {
  it('shows a tool\'s calm preview-failure text instead of the red reading error', async () => {
    vi.mocked(previewPdf).mockRejectedValue(new ToolError('This file could not be read. Try Repair PDF.'));
    const calm = { ...dummy, slug: 'calm', previewFailureText: 'No preview. See the file check below.' };
    show(calm);
    pick(file('damaged.pdf'));
    const note = await screen.findByText('No preview. See the file check below.');
    expect(note.className).not.toContain('tool-file-error');
    expect(screen.queryByText('This file could not be read. Try Repair PDF.')).toBeNull();
  });

  it('keeps the red reading error for tools without preview-failure text', async () => {
    vi.mocked(previewPdf).mockRejectedValue(new ToolError('This file could not be read. Try Repair PDF.'));
    show();
    pick(file('damaged.pdf'));
    const error = await screen.findByText('This file could not be read. Try Repair PDF.');
    expect(error.className).toContain('tool-file-error');
  });

  it('uses canRun to explain a disabled action and enables it when the reason clears', () => {
    const canRun = vi.fn((options: Record<string, unknown>) => options.label === 'Ready' ? undefined : 'Choose an option first.');
    show({ ...dummy, canRun });
    pick(file('one.pdf'));
    const button = screen.getByRole('button', { name: dummy.title }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.getAttribute('aria-disabled')).toBe('true');
    expect(button.title).toBe('Choose an option first.');
    expect(screen.getByText('Choose an option first.')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Output label'), { target: { value: 'Ready' } });
    expect(button.disabled).toBe(false);
    expect(button.getAttribute('aria-disabled')).toBe('false');
    expect(screen.queryByText('Choose an option first.')).toBeNull();
  });

  it('enforces a two-file minimum after picking and removing files', () => {
    show({ ...dummy, minInputs: 2 });
    pick(file('one.pdf'));
    const button = screen.getByRole('button', { name: dummy.title }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    pick(file('two.pdf'));
    expect(button.disabled).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Remove one.pdf' }));
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(run).not.toHaveBeenCalled();
  });

  it('keeps warnings visible with results, deduplicates them, and clears them on start over', async () => {
    run.mockImplementationOnce(async (_files, _options, ctx) => {
      ctx.onWarning?.('Form fields from more than one file may clash');
      ctx.onWarning?.('Form fields from more than one file may clash');
      return [result];
    });
    show(); pick(file('form.pdf'));
    fireEvent.click(screen.getByRole('button', { name: dummy.title }));
    await screen.findByRole('region', { name: 'Results' });
    expect(screen.getAllByText('Form fields from more than one file may clash')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Start over' }));
    expect(screen.queryByText('Form fields from more than one file may clash')).toBeNull();
  });

  it('shows a tool result note with its tone under the output name', async () => {
    run.mockResolvedValueOnce([{ ...result, note: { text: 'All 2 pages kept. Nothing else changed.', tone: 'ok' } }]);
    show(); pick(file('repair.pdf'));
    fireEvent.click(screen.getByRole('button', { name: dummy.title }));
    const note = await screen.findByText('All 2 pages kept. Nothing else changed.');
    expect(note.textContent).toBe('All 2 pages kept. Nothing else changed.');
    expect(note.classList.contains('tool-result-note-ok')).toBe(true);
  });

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

  it('shows a tool\'s own user-facing message word for word, but hides internal errors', async () => {
    run.mockRejectedValueOnce(new ToolError('Page numbers must be between 1 and 16.'));
    show(); pick(file('goa.pdf'));
    fireEvent.click(screen.getByRole('button', { name: dummy.title }));
    expect((await screen.findByRole('alert')).textContent).toBe('Page numbers must be between 1 and 16.');

    run.mockRejectedValueOnce(new Error('TypeError: cannot read property of undefined'));
    fireEvent.click(await screen.findByRole('button', { name: dummy.title }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('Something went wrong. Please try again.'));
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
