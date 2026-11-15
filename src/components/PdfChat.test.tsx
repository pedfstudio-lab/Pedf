// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { webcrypto } from 'node:crypto';
import { useState } from 'react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { TextRun } from '@/lib/pdf/textContent';
import type { DiscussInput } from '@/lib/providers/types';
import type { ConversationCallbacks } from '@/lib/speech/conversationSession';
import { EditsStoreProvider, useEdits } from '@/state/editsStore';
import { PrefsStoreProvider } from '@/state/prefsStore';
import { startConversationSession } from '@/lib/speech/conversationSession';
import { PdfChat } from './PdfChat';
import type { PdfChatMode } from './PdfChat';
import { buildDiscussMessages, EDITED_DOCUMENT_RULE, OUTDATED_ANSWER_NOTE } from '@/lib/providers/discussPrompt';

const mocks = vi.hoisted(() => ({
  discuss: vi.fn(),
  transcribe: vi.fn(),
  startRecording: vi.fn(),
  callbacks: null as ConversationCallbacks | null,
  stopConversation: vi.fn(async () => undefined),
  enqueueSpeech: vi.fn(),
  transcribeStream: vi.fn(),
  getDocumentText: vi.fn(),
  extractTextRuns: vi.fn(),
}));

vi.mock('@/lib/providers', () => ({
  defaultProviders: () => ({ discuss: mocks.discuss, transcribe: mocks.transcribe }),
  providerConfig: {},
  SarvamProvider: class { transcribeStream = mocks.transcribeStream; },
}));
vi.mock('@/lib/pdf/documentText', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/pdf/documentText')>()),
  getDocumentText: mocks.getDocumentText,
}));
vi.mock('@/lib/pdf/textContent', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/pdf/textContent')>()),
  extractTextRuns: mocks.extractTextRuns,
}));
vi.mock('@/lib/speech/recordQuestion', () => ({ startRecording: mocks.startRecording }));
vi.mock('@/lib/speech/conversationSession', () => ({
  startConversationSession: vi.fn(async (_factory, callbacks: ConversationCallbacks) => {
    mocks.callbacks = callbacks;
    return {
      setListening: vi.fn(), setBargeInEnabled: vi.fn(), stop: mocks.stopConversation,
      requestFinal: () => {
        queueMicrotask(() => callbacks.onFinal?.('What is the fee?'));
        return true;
      },
    };
  }),
}));
vi.mock('@/lib/speech/conversationEndpoint', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/speech/conversationEndpoint')>()),
  createConversationEndpoint: (finalize: () => void) => ({
    onSpeechStart: vi.fn(), onSpeechEnd: () => finalize(), cancel: vi.fn(),
  }),
}));
vi.mock('@/lib/speech/speechQueue', () => ({
  createSpeechQueue: () => ({
    stop: vi.fn(), skipCurrent: vi.fn(), enqueue: vi.fn(),
    enqueueBrowserSpeech: () => ({ ready: Promise.resolve(), done: Promise.resolve() }),
    enqueueSpeech: mocks.enqueueSpeech,
  }),
}));
vi.mock('@/lib/speech/acknowledgments', () => ({
  MAX_BRIDGING_FILLERS: 0,
  preloadAcknowledgments: vi.fn(async () => undefined),
  preloadBridgingAcknowledgments: vi.fn(async () => undefined),
  takeAcknowledgment: () => undefined,
  takeAcknowledgmentPhrase: () => 'One moment.',
  takeBridgingAcknowledgment: () => undefined,
  waitForBridgingGap: vi.fn(async () => undefined),
  waitForBridgingInitialDelay: vi.fn(async () => undefined),
}));

const source: TextRun = {
  pageIndex: 0, text: 'Fee: Rs. 5,000', rect: { x: 72, y: 680, w: 100, h: 12 },
  style: { fontName: 'Helvetica', fontSizePt: 12, bold: false, italic: false, color: { r: 0, g: 0, b: 0 } },
};

function Harness({ doc, initialMode }: { readonly doc: PDFDocumentProxy; readonly initialMode: PdfChatMode }) {
  const { addEdits, updateEdit, resetDocument, undo } = useEdits();
  const [currentDoc, setCurrentDoc] = useState(doc);
  const [mode, setMode] = useState(initialMode);
  return <>
    <button onClick={() => setMode('talk')}>Switch to Talk</button>
    <button onClick={() => setMode('chat')}>Switch to Chat</button>
    <button onClick={() => resetDocument([{ id: 'page', kind: 'source', sourceIndex: 0 }])}>Open test PDF</button>
    <button onClick={() => addEdits([
      { id: 'cover', kind: 'cover', pageIndex: 0, rect: source.rect, z: 1, sampleBackground: true, replaces: [{ text: source.text, rect: source.rect }] },
      { id: 'replacement', kind: 'text', pageIndex: 0, rect: source.rect, z: 2, text: 'Fee: Rs. 7,500', style: source.style },
    ])}>Commit price edit</button>
    <button onClick={() => updateEdit({ id: 'replacement', kind: 'text', pageIndex: 0, rect: source.rect, z: 2,
      text: 'Fee: Rs. 9,000', style: source.style })}>Commit second price edit</button>
    <button onClick={() => addEdits([{ id: 'picture', kind: 'image', pageIndex: 0, rect: source.rect, z: 3,
      bytes: new Uint8Array() }])}>Add test picture</button>
    <button onClick={() => {
      resetDocument([{ id: 'other-page', kind: 'source', sourceIndex: 0 }]);
      setCurrentDoc({ numPages: doc.numPages, getPage: doc.getPage } as unknown as PDFDocumentProxy);
    }}>Open another PDF</button>
    <button onClick={undo}>Undo test edit</button>
    <PdfChat open mode={mode} doc={currentDoc} onClose={() => undefined} />
  </>;
}

function mount(initialMode: PdfChatMode = 'chat') {
  const doc = { numPages: 1, getPage: vi.fn(async () => ({})) } as unknown as PDFDocumentProxy;
  render(<EditsStoreProvider><PrefsStoreProvider><Harness doc={doc} initialMode={initialMode} /></PrefsStoreProvider></EditsStoreProvider>);
  fireEvent.click(screen.getByRole('button', { name: 'Open test PDF' }));
}

async function typeQuestion(question = 'What is the fee?') {
  fireEvent.change(screen.getByRole('textbox', { name: 'Ask a question about this PDF' }), { target: { value: question } });
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  await waitFor(() => expect((screen.getByRole('textbox') as HTMLTextAreaElement).disabled).toBe(false));
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('crypto', webcrypto);
  localStorage.clear();
  localStorage.setItem('desipdf.prefs', JSON.stringify({ preferredLanguage: 'hi-IN' }));
  Element.prototype.scrollIntoView = vi.fn();
  mocks.getDocumentText.mockResolvedValue({ pages: [source.text], full: `[Page 1]\n${source.text}`, charCount: 22 });
  mocks.extractTextRuns.mockResolvedValue([source]);
  mocks.discuss.mockImplementation(async (input: DiscussInput) => ({
    answer: `${input.language}: ${input.documentText.match(/Rs\. ([\d,]+)/)?.[1]} [Page 1]`, grounded: true, provider: 'test',
  }));
  mocks.enqueueSpeech.mockImplementation(() => ({ ready: Promise.resolve(), done: Promise.resolve() }));
  mocks.startRecording.mockResolvedValue({ stop: async () => ({ audio: new Blob(['test']), streamingTranscript: 'What is the fee?' }), cancel: vi.fn() });
  mocks.transcribe.mockResolvedValue({ text: 'What is the fee?', provider: 'test' });
  mocks.callbacks = null;
});

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function promptForCall(index: number) {
  return buildDiscussMessages(mocks.discuss.mock.calls[index]![0] as DiscussInput);
}

function expectHiddenNotes() {
  expect(document.body.textContent).not.toContain(OUTDATED_ANSWER_NOTE);
  expect(document.body.textContent).not.toContain(EDITED_DOCUMENT_RULE);
}

describe('PdfChat question length', () => {
  it('limits a question to 2,000 characters, so a huge paste cannot burn Sarvam credits', async () => {
    mount();
    const box = screen.getByRole('textbox', { name: 'Ask a question about this PDF' }) as HTMLTextAreaElement;
    expect(box.maxLength).toBe(2000);
    await typeQuestion('x'.repeat(5000));
    expect((mocks.discuss.mock.calls[0]?.[0] as DiscussInput).question).toHaveLength(2000);
  });
});

describe('PdfChat current context', () => {
  it('sends committed edits, then the original after Undo, without reopening chat', async () => {
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Commit price edit' }));
    await typeQuestion();
    expect(mocks.discuss.mock.calls[0]?.[0]).toMatchObject({ documentText: '[Page 1]\nFee: Rs. 7,500', spoken: false });
    fireEvent.click(screen.getByRole('button', { name: 'Undo test edit' }));
    await typeQuestion('And now?');
    expect(mocks.discuss.mock.calls[1]?.[0]).toMatchObject({ documentText: '[Page 1]\nFee: Rs. 5,000', spoken: false });
  });

  it('sends the newly chosen language next time, with follow-up history intact', async () => {
    mount();
    await typeQuestion('पहला विकल्प क्या है?');
    fireEvent.change(screen.getByRole('combobox', { name: 'Chat answer language' }), { target: { value: 'ta-IN' } });
    await typeQuestion('And the second one?');
    expect(mocks.discuss.mock.calls[0]?.[0].language).toBe('hi-IN');
    expect(mocks.discuss.mock.calls[1]?.[0]).toMatchObject({ language: 'ta-IN', history: [
      { role: 'user', content: 'पहला विकल्प क्या है?' },
      { role: 'assistant', content: 'hi-IN: 5,000 [Page 1]' },
    ] });
    expect(mocks.extractTextRuns).not.toHaveBeenCalled();
  });

  it.each([true, false])('Talk without live speech: tap, speak, tap to send current text (streaming transcript: %s)', async streaming => {
    if (!streaming) mocks.startRecording.mockResolvedValue({ stop: async () => ({ audio: new Blob(['test']) }), cancel: vi.fn() });
    vi.mocked(startConversationSession).mockRejectedValueOnce(new Error('Live speech is unavailable.'));
    mount();
    await typeQuestion();
    fireEvent.click(screen.getByRole('button', { name: 'Commit price edit' }));
    fireEvent.click(screen.getByRole('button', { name: 'Switch to Talk' }));
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('Tap the mic, speak, then tap again to send.'));
    fireEvent.click(screen.getByRole('button', { name: 'Start talking' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Send what I said' }));
    await waitFor(() => expect(mocks.discuss).toHaveBeenCalledTimes(2));
    expect(mocks.discuss.mock.calls[1]?.[0]).toMatchObject({ documentText: '[Page 1]\nFee: Rs. 7,500', language: 'hi-IN', spoken: true,
      history: [{ role: 'user', content: 'What is the fee?' }, { role: 'assistant', content: 'hi-IN: 5,000 [Page 1]', outOfDate: true }] });
    expect(promptForCall(1)[2]?.content).toContain(OUTDATED_ANSWER_NOTE);
    expect(promptForCall(1).at(-1)?.content).toContain(EDITED_DOCUMENT_RULE);
    expectHiddenNotes();
  });

  it('Talk reads edits made while it is listening, and restarts in a newly chosen language', async () => {
    mount();
    await typeQuestion();
    fireEvent.click(screen.getByRole('button', { name: 'Switch to Talk' }));
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('Listening…'));
    expect(screen.getByText('What is the fee?').textContent).toBe('You: What is the fee?');
    fireEvent.click(screen.getByRole('button', { name: 'Commit price edit' }));
    await act(async () => {
      mocks.callbacks?.onPartial?.('What is the fee?');
      mocks.callbacks?.onSpeechEnd?.();
    });
    await waitFor(() => expect(mocks.discuss).toHaveBeenCalledTimes(2));
    expect(mocks.discuss.mock.calls[1]?.[0]).toMatchObject({ documentText: '[Page 1]\nFee: Rs. 7,500', spoken: true, language: 'hi-IN' });
    expect(promptForCall(1)[2]?.content).toContain(OUTDATED_ANSWER_NOTE);
    expect(promptForCall(1).at(-1)?.content).toContain(EDITED_DOCUMENT_RULE);
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('Listening…'));
    expect(screen.getByText('hi-IN: 7,500 [Page 1]').textContent).toBe('HighPal: hi-IN: 7,500 [Page 1]');
    fireEvent.change(screen.getByRole('combobox', { name: 'Talk language' }), { target: { value: 'en-IN' } });
    await waitFor(() => expect(mocks.stopConversation).toHaveBeenCalled());
    await waitFor(() => expect(startConversationSession).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('Listening…'));
    await act(async () => {
      mocks.callbacks?.onPartial?.('What is the fee?');
      mocks.callbacks?.onSpeechEnd?.();
    });
    await waitFor(() => expect(mocks.discuss).toHaveBeenCalledTimes(3));
    expect(mocks.discuss.mock.calls[2]?.[0]).toMatchObject({ documentText: '[Page 1]\nFee: Rs. 7,500', spoken: true, language: 'en-IN' });
    expect(mocks.discuss.mock.calls[2]?.[0].history[3]).not.toHaveProperty('outOfDate');
    expect(mocks.enqueueSpeech.mock.calls.at(-1)?.[1]).toBe('en-IN');
    expectHiddenNotes();
  });

  it('Talk starts listening when it opens; the mic pauses and resumes; switching to Chat ends the voice', async () => {
    mount('talk');
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('Listening…'));
    expect(startConversationSession).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('textbox')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Pause talking' }));
    await waitFor(() => expect(mocks.stopConversation).toHaveBeenCalledTimes(1));
    expect(screen.getByRole('status').textContent).toContain('Paused');
    fireEvent.click(screen.getByRole('button', { name: 'Start talking' }));
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('Listening…'));
    expect(startConversationSession).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole('button', { name: 'Switch to Chat' }));
    await waitFor(() => expect(mocks.stopConversation).toHaveBeenCalledTimes(2));
    expect(screen.getByRole('dialog', { name: 'Chat with this PDF' })).toBeTruthy();
    expect(screen.getByRole('textbox', { name: 'Ask a question about this PDF' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /voice|conversation|record/i })).toBeNull();
    expect(document.body.textContent).not.toMatch(/\p{Extended_Pictographic}/u);
  });

  it('marks all old answers after each edit, but not the latest-context answer or unchanged repeat', async () => {
    mount();
    await typeQuestion();
    await typeQuestion('And his email?');
    expect(promptForCall(1).some(message => message.content.includes(OUTDATED_ANSWER_NOTE))).toBe(false);
    expect(promptForCall(1).at(-1)?.content).not.toContain(EDITED_DOCUMENT_RULE);
    fireEvent.click(screen.getByRole('button', { name: 'Commit price edit' }));
    await typeQuestion();
    expect(mocks.discuss.mock.calls[2]?.[0].history.filter((message: { outOfDate?: boolean }) => message.outOfDate)).toHaveLength(2);
    await typeQuestion();
    const repeatHistory = mocks.discuss.mock.calls[3]?.[0].history;
    expect(repeatHistory[1]).toHaveProperty('outOfDate', true);
    expect(repeatHistory[3]).toHaveProperty('outOfDate', true);
    expect(repeatHistory[5]).not.toHaveProperty('outOfDate');
    fireEvent.click(screen.getByRole('button', { name: 'Commit second price edit' }));
    await typeQuestion();
    const newest = mocks.discuss.mock.calls[4]?.[0] as DiscussInput;
    expect(newest.documentText).toBe('[Page 1]\nFee: Rs. 9,000');
    expect(newest.history).toHaveLength(8);
    expect(newest.history?.filter(message => message.role === 'assistant').every(message => message.outOfDate)).toBe(true);
    expect(promptForCall(4).at(-1)?.content).toContain(EDITED_DOCUMENT_RULE);
    expectHiddenNotes();
  });

  it('does not mark answers for a picture-only edit', async () => {
    mount();
    await typeQuestion();
    fireEvent.click(screen.getByRole('button', { name: 'Add test picture' }));
    await typeQuestion();
    expect(mocks.discuss.mock.calls[1]?.[0].history[1]).not.toHaveProperty('outOfDate');
    expect(promptForCall(1).at(-1)?.content).not.toContain(EDITED_DOCUMENT_RULE);
    expect(promptForCall(1).some(message => message.content.includes(OUTDATED_ANSWER_NOTE))).toBe(false);
    expectHiddenNotes();
  });

  it('marks the edited answer after Undo and starts fresh when a different PDF opens', async () => {
    mount();
    await typeQuestion();
    fireEvent.click(screen.getByRole('button', { name: 'Commit price edit' }));
    await typeQuestion();
    fireEvent.click(screen.getByRole('button', { name: 'Undo test edit' }));
    await typeQuestion();
    const history = mocks.discuss.mock.calls[2]?.[0].history;
    expect(history[1]).not.toHaveProperty('outOfDate');
    expect(history[3]).toHaveProperty('outOfDate', true);
    expect(mocks.discuss.mock.calls[2]?.[0].documentText).toContain('5,000');
    fireEvent.click(screen.getByRole('button', { name: 'Open another PDF' }));
    await waitFor(() => expect(screen.queryAllByRole('article')).toHaveLength(0));
    await typeQuestion('Fresh question');
    expect(mocks.discuss.mock.calls[3]?.[0].history).toEqual([]);
    expect(promptForCall(3).at(-1)?.content).not.toContain(EDITED_DOCUMENT_RULE);
    expectHiddenNotes();
  });

  it('keeps the fingerprint of the request, even if the document changes before the answer arrives', async () => {
    let finish: (answer: { answer: string; grounded: boolean; provider: string }) => void = () => undefined;
    mocks.discuss.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    mount();
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'What is the fee?' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(mocks.discuss).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole('button', { name: 'Commit price edit' }));
    await act(async () => finish({ answer: 'The fee was 5,000.', grounded: true, provider: 'test' }));
    await typeQuestion();
    expect(mocks.discuss.mock.calls[1]?.[0].history[1]).toMatchObject({ content: 'The fee was 5,000.', outOfDate: true });
    expectHiddenNotes();
  });
});
