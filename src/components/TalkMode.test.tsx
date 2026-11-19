// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TalkMode } from './TalkMode';
import type { TalkStatus } from './TalkMode';

afterEach(cleanup);

function renderTalk(overrides: Partial<Parameters<typeof TalkMode>[0]> = {}) {
  const props = {
    status: 'listening' as TalkStatus,
    handsFree: true,
    language: 'en-IN' as const,
    onLanguageChange: vi.fn(),
    onMicTap: vi.fn(),
    onEnd: vi.fn(),
    ...overrides,
  };
  render(<TalkMode {...props} />);
  return props;
}

describe('TalkMode', () => {
  it('leaves the PDF usable: only the caption card and controls take clicks', () => {
    renderTalk();
    const shell = screen.getByRole('region', { name: 'Talk with this PDF' });
    expect(shell.className).toContain('pointer-events-none');
    expect(shell.className).not.toContain('inset-0');
    expect(screen.getByRole('button', { name: 'Pause talking' }).className).toContain('pointer-events-auto');
    expect(screen.getByRole('button', { name: 'End' }).className).toContain('pointer-events-auto');
  });

  it('shows what the person said and HighPal’s reply, with the general-knowledge label', () => {
    renderTalk({ status: 'paused', heard: 'When do we leave?', answer: 'On 22 July. [Page 1]', answerIsGeneral: true });
    expect(screen.getByText('When do we leave?').textContent).toContain('You: When do we leave?');
    expect(screen.getByText('On 22 July. [Page 1]', { exact: false }).textContent).toContain('HighPal: On 22 July.');
    expect(screen.getByText('General info — not from this PDF')).toBeTruthy();
  });

  it('shows a waiting reply while thinking, and a starter line before anything is said', () => {
    renderTalk({ status: 'thinking', heard: 'What is the fee?' });
    expect(screen.getByText('HighPal:', { exact: false }).parentElement?.textContent).toBe('HighPal: …');
    cleanup();
    renderTalk({ status: 'listening' });
    expect(screen.getByText('Ask anything about this PDF, out loud.')).toBeTruthy();
    expect(screen.queryByText('HighPal:', { exact: false })).toBeNull();
  });

  it.each([
    ['starting', 'Starting…', 'Pause talking'],
    ['listening', 'Listening…', 'Pause talking'],
    ['recording', 'Listening…', 'Send what I said'],
    ['thinking', 'Thinking…', 'Pause talking'],
    ['speaking', 'Speaking…', 'Pause talking'],
    ['paused', 'Paused', 'Start talking'],
  ] as const)('%s: says "%s" and the mic button reads "%s"', (status, label, mic) => {
    const props = renderTalk({ status });
    expect(screen.getByRole('status').textContent).toContain(label);
    fireEvent.click(screen.getByRole('button', { name: mic }));
    expect(props.onMicTap).toHaveBeenCalledOnce();
  });

  it('explains tap-to-send when live speech is unavailable', () => {
    renderTalk({ status: 'paused', handsFree: false });
    expect(screen.getByRole('status').textContent).toContain('Tap the mic, speak, then tap again to send.');
  });

  it('changes the language, shows errors, and ends', () => {
    const props = renderTalk({ error: 'Allow mic access to ask by voice.' });
    fireEvent.change(screen.getByRole('combobox', { name: 'Talk language' }), { target: { value: 'hi-IN' } });
    expect(props.onLanguageChange).toHaveBeenCalledWith('hi-IN');
    expect(screen.getByRole('alert').textContent).toBe('Allow mic access to ask by voice.');
    fireEvent.click(screen.getByRole('button', { name: 'End' }));
    expect(props.onEnd).toHaveBeenCalledOnce();
  });

  it('says that voice and the PDF text go to Sarvam AI, and uses no emoji', () => {
    renderTalk();
    const shell = screen.getByRole('region', { name: 'Talk with this PDF' });
    // Only promise what HighPal controls: Sarvam's own retention follows its terms.
    expect(shell.textContent).toContain('Your voice and this PDF’s text are sent to Sarvam AI to answer. HighPal doesn’t store them.');
    expect(shell.textContent).not.toContain('Nothing is stored');
    expect(shell.textContent).not.toMatch(/\p{Extended_Pictographic}/u);
  });
});
