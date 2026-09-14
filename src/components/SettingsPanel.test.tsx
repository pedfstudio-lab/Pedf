// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryProjectStore } from '@/lib/projects/projectStore';
import { serializeProject } from '@/lib/projects/projectState';
import type { HistoryState } from '@/state/editsStore';
import { PrefsStoreProvider } from '@/state/prefsStore';
import { SettingsPanel } from './SettingsPanel';

const history: HistoryState = {
  past: [],
  present: { edits: [], plan: [{ id: 'page-0', kind: 'source', sourceIndex: 0 }] },
  future: [],
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('SettingsPanel saved files', () => {
  it('shows the count and storage estimate, then deletes every save with confirmation', async () => {
    const store = new MemoryProjectStore();
    for (const id of ['one', 'two']) {
      await store.create({
        id,
        fileName: `${id}.pdf`,
        fileSize: 2048,
        sha256: id,
        pageCount: 1,
        lastPage: 0,
        zoom: 1,
        changeCount: 0,
        original: new Blob(['pdf']),
        state: serializeProject(history, 0, 1),
      });
    }
    Object.defineProperty(navigator, 'storage', {
      configurable: true,
      value: { estimate: vi.fn().mockResolvedValue({ usage: 4096, quota: 8192 }) },
    });
    vi.spyOn(window, 'confirm').mockReturnValue(true);

    render(
      <PrefsStoreProvider>
        <SettingsPanel open fileOpen={false} projectStore={store} onClose={vi.fn()} />
      </PrefsStoreProvider>,
    );

    expect(await screen.findByText('2 files saved · about 4.0 KB')).toBeTruthy();
    expect(await screen.findByText('Browser storage: 4.0 KB used of 8.0 KB.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Delete all saved files on this device' }));

    await waitFor(async () => {
      const listed = await store.list();
      expect(listed.status === 'ok' ? listed.value : []).toHaveLength(0);
    });
    expect(screen.getByText('0 files saved · about 0 B')).toBeTruthy();
    expect(window.confirm).toHaveBeenCalledWith(
      "Delete all saved files on this device? This can't be undone.",
    );
  });

  it('disables Delete all while a PDF is open', async () => {
    const store = new MemoryProjectStore();
    await store.create({
      id: 'open',
      fileName: 'Open.pdf',
      fileSize: 3,
      sha256: 'open',
      pageCount: 1,
      lastPage: 0,
      zoom: 1,
      changeCount: 1,
      original: new Blob(['pdf']),
      state: serializeProject(history, 0, 1),
    });
    const confirm = vi.spyOn(window, 'confirm');
    render(
      <PrefsStoreProvider>
        <SettingsPanel open fileOpen projectStore={store} onClose={vi.fn()} />
      </PrefsStoreProvider>,
    );

    const button = await screen.findByRole('button', { name: 'Delete all saved files on this device' });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(button.getAttribute('title')).toBe('Close the open file first.');
    expect(screen.getByText('Close the open file first.')).toBeTruthy();
    fireEvent.click(button);
    expect(confirm).not.toHaveBeenCalled();
  });
});
