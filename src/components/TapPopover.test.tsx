// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PageTranslationCache } from '@/lib/translate/pageTranslation';
import { TapPopover } from './TapPopover';
import { TranslationControls } from './TranslationControls';

const mocks = vi.hoisted(() => ({ state: null as unknown }));
vi.mock('@/state/translationStore', () => ({ useTranslation: () => mocks.state }));
const translate = vi.fn();
const state = () => ({ language: 'en-IN', preferredLanguage: 'hi-IN', cache: new PageTranslationCache(),
  provider: { translate }, notePrivacy: vi.fn(), setLanguage: vi.fn() });
function menu() {
  return render(<TapPopover text="Hello world" screenRect={{ left: 20, top: 20, width: 100, height: 20 }}
    pageWidth={600} onEdit={vi.fn()} onClose={vi.fn()} />);
}
beforeEach(() => { translate.mockReset(); mocks.state = state(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('Task 79 Translate controls and card', () => {
  it('removes Meaning and translates the selected text in the preferred language with Copy', async () => {
    translate.mockResolvedValue({ text: 'नमस्ते दुनिया', provider: 'mock' });
    const copy = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: copy } });
    menu();
    expect(screen.queryByRole('menuitem', { name: 'Meaning' })).toBeNull();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Translate' }));
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('नमस्ते दुनिया'));
    expect(translate).toHaveBeenCalledWith(expect.objectContaining({ text: 'Hello world', to: 'hi-IN', from: 'en-IN' }));
    fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
    await waitFor(() => expect(copy).toHaveBeenCalledWith('नमस्ते दुनिया'));
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Translate' }));
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('नमस्ते दुनिया'));
    expect(translate).toHaveBeenCalledTimes(1);
  });
  it('asks for a target when the chat preference is English', () => {
    mocks.state = { ...state(), preferredLanguage: 'en-IN' };
    menu(); fireEvent.click(screen.getByRole('menuitem', { name: 'Translate' }));
    expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe('');
    expect(translate).not.toHaveBeenCalled();
  });
  it('shows failures in the card rather than crashing the page', async () => {
    translate.mockRejectedValue(new Error('offline'));
    menu(); fireEvent.click(screen.getByRole('menuitem', { name: 'Translate' }));
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain("Couldn't translate this page"));
    expect((screen.getByRole('button', { name: 'Copy' }) as HTMLButtonElement).disabled).toBe(true);
    translate.mockResolvedValue({ text: 'ठीक' });
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('ठीक'));
  });
  it('offers nine languages and Show original, without changing the chat language', () => {
    const value = state(); mocks.state = value;
    render(<TranslationControls disabled={false} />);
    fireEvent.click(screen.getByRole('button', { name: /Translate/ }));
    expect(screen.getAllByRole('menuitemradio')).toHaveLength(10);
    fireEvent.click(screen.getByRole('menuitemradio', { name: /Tamil/ }));
    expect(value.setLanguage).toHaveBeenCalledWith('ta-IN');
  });
});
