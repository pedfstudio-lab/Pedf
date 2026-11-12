// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { navigate } from '@/lib/site/navigate';
import * as pendingFile from '@/lib/site/pendingFile';
import { MemoryProjectStore } from '@/lib/projects/projectStore';
import { serializeProject } from '@/lib/projects/projectState';
import type { HistoryState } from '@/state/editsStore';
import { Landing } from './Landing';

vi.mock('@/lib/site/navigate', () => ({ navigate: vi.fn() }));

describe('Landing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
    pendingFile.takePendingFile();
    pendingFile.takePendingProject();
    vi.restoreAllMocks();
  });

  it('renders the core HighPal experience', () => {
    const { container } = render(<Landing />);

    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Read it. Ask it. Edit it.');
    expect(screen.getByRole('link', { name: 'Start editing' }).getAttribute('href')).toBe('/app');
    expect(screen.getByText(/& 7 more Indian languages/).textContent).toBe('English, हिन्दी, தமிழ் & 7 more Indian languages');
    expect(screen.getByText('© 2026 HighPal')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Tools' }).getAttribute('href')).toBe('/tools');
    expect(screen.getByRole('link', { name: 'PDF tools' }).getAttribute('href')).toBe('/tools');
    expect(screen.getByRole('link', { name: /Edit Text/ }).getAttribute('href')).toBe('/app');
    expect(container.querySelector('input[type="file"]')?.getAttribute('accept')).toBe('application/pdf');
  });

  it('keeps a chosen PDF in memory and navigates to the editor', () => {
    const setPendingFile = vi.spyOn(pendingFile, 'setPendingFile');
    const { container } = render(<Landing />);
    const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
    const file = new File(['%PDF-1.7'], 'chosen-test.pdf', { type: 'application/pdf' });

    fireEvent.change(input, { target: { files: [file] } });

    expect(setPendingFile).toHaveBeenCalledWith(file);
    expect(navigate).toHaveBeenCalledWith('/app');
    expect(pendingFile.takePendingFile()).toBe(file);
  });

  it('hands a dropped PDF to the same in-page navigation flow', () => {
    const file = new File(['%PDF-1.7'], 'dropped-test.pdf', { type: 'application/pdf' });
    render(<Landing />);

    fireEvent.drop(screen.getByRole('button', { name: 'Drop your PDF here' }), {
      dataTransfer: { files: [file] },
    });

    expect(navigate).toHaveBeenCalledWith('/app');
    expect(pendingFile.takePendingFile()).toBe(file);
  });

  it('rejects a non-PDF without navigating or carrying a file', () => {
    const { container } = render(<Landing />);
    const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;

    fireEvent.change(input, {
      target: { files: [new File(['image'], 'photo.png', { type: 'image/png' })] },
    });

    expect(screen.getByRole('alert').textContent).toBe('Choose a PDF file.');
    expect(navigate).not.toHaveBeenCalled();
    expect(pendingFile.takePendingFile()).toBeUndefined();
  });

  it('hands a saved project id to the editor from the Continue card', async () => {
    const store = new MemoryProjectStore();
    const history: HistoryState = {
      past: [],
      present: { edits: [], plan: [{ id: 'page-0', kind: 'source', sourceIndex: 0 }] },
      future: [],
    };
    await store.create({
      id: 'contract-project',
      fileName: 'Contract.pdf',
      fileSize: 128,
      sha256: 'contract',
      pageCount: 1,
      lastPage: 0,
      zoom: 1,
      changeCount: 0,
      original: new Blob(['pdf']),
      state: serializeProject(history, 0, 1),
    });
    render(<Landing projectStore={store} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Continue editing' }));

    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/app'));
    expect(pendingFile.takePendingProject()).toBe('contract-project');
  });

  it('never says "upload": the PDF stays on this device', () => {
    const { container } = render(<Landing />);
    expect(container.textContent).not.toMatch(/upload/i);
    // Said on the first screen (under the drop area) and again in the trust strip.
    expect(screen.getAllByText('Only Ask, voice and Translate send text out — to get your answer.', { exact: false }).length).toBeGreaterThan(0);
  });

  it('writes each language in its own script and reads the privacy heading as two sentences', () => {
    const { container } = render(<Landing />);
    const tamil = [...container.querySelectorAll('[lang="ta-IN"]')].map((node) => node.textContent);
    expect(tamil).toContain('தமிழ்');
    expect(screen.getByRole('heading', { name: 'Runs on your computer. Stays on your computer.' })).toBeTruthy();
  });

  it('lets keyboard users skip the header links', () => {
    const { container } = render(<Landing />);
    expect(screen.getByRole('link', { name: 'Skip to content' }).getAttribute('href')).toBe('#main-content');
    expect(container.querySelector('main')?.id).toBe('main-content');
  });

  it('folds the page links into a ☰ menu that opens and closes (phones)', () => {
    render(<Landing />);
    const menu = screen.getByRole('button', { name: 'Menu' });
    const nav = screen.getByRole('navigation', { name: 'Main navigation' });
    expect(menu.getAttribute('aria-controls')).toBe('site-nav-links');
    expect(menu.getAttribute('aria-expanded')).toBe('false');

    fireEvent.click(menu);
    expect(menu.getAttribute('aria-expanded')).toBe('true');
    expect(nav.classList.contains('is-open')).toBe(true);
    fireEvent.click(screen.getByRole('link', { name: 'FAQ' }));
    expect(nav.classList.contains('is-open')).toBe(false);

    fireEvent.click(menu);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(menu.getAttribute('aria-expanded')).toBe('false');

    fireEvent.click(menu);
    fireEvent.pointerDown(document.body);
    expect(menu.getAttribute('aria-expanded')).toBe('false');
  });

  it('opens on the Drop-first screen: headline, wide drop area, privacy line, then Read · Ask · Edit', () => {
    const { container } = render(<Landing />);
    const hero = container.querySelector('.hero')!;
    const drop = screen.getByRole('button', { name: 'Drop your PDF here' });
    expect(drop.textContent).toContain('Choose your PDF');
    expect(hero.querySelector('.hero__privacy')?.textContent).toContain('Your PDF never leaves your device.');
    expect(hero.querySelector('.hero__privacy')?.textContent).toContain('Only Ask, voice and Translate send text out');
    const cards = screen.getByRole('list', { name: 'What you can do' });
    expect([...cards.querySelectorAll('strong')].map((title) => title.textContent)).toEqual(['Read it', 'Ask it', 'Edit it']);
    // The order on the page: drop area, then the privacy line, then the cards.
    const order = [drop, hero.querySelector('.hero__privacy')!, cards];
    expect(order.every((node, index) => index === 0 || (order[index - 1]!.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING))).toBe(true);
    // The old picture-and-chat panel is gone from the first screen.
    expect(container.querySelector('.chat-demo')).toBeNull();
  });

});
