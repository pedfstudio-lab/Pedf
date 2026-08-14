import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { getDocumentText } from '@/lib/pdf/documentText';
import { defaultProviders } from '@/lib/providers';
import { getSarvamKey } from '@/lib/providers/keys';
import {
  SUPPORTED_LANGUAGES,
  usePrefs,
} from '@/state/prefsStore';
import type { SupportedLanguageCode } from '@/state/prefsStore';

interface PdfChatProps {
  readonly open: boolean;
  readonly doc: PDFDocumentProxy | null;
  onClose(): void;
  onOpenSettings(): void;
}

interface ChatEntry {
  readonly id: number;
  readonly role: 'user' | 'assistant';
  readonly text: string;
  readonly grounded?: boolean;
}

function readableError(error: unknown): string {
  if (error instanceof AggregateError) {
    const cause = error.errors.find((item): item is Error => item instanceof Error);
    if (cause) return cause.message;
  }
  return error instanceof Error ? error.message : String(error);
}

export function PdfChat({ open, doc, onClose, onOpenSettings }: PdfChatProps) {
  const { preferredLanguage, setPreferredLanguage } = usePrefs();
  const [entries, setEntries] = useState<ChatEntry[]>([]);
  const [question, setQuestion] = useState('');
  const [thinking, setThinking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nextId = useRef(0);
  const messagesEnd = useRef<HTMLDivElement | null>(null);
  const keyMissing = import.meta.env.DEV && getSarvamKey().trim() === '';

  useEffect(() => {
    setEntries([]);
    setQuestion('');
    setError(null);
    setThinking(false);
  }, [doc]);

  useEffect(() => {
    if (!open) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [onClose, open]);

  useEffect(() => {
    if (open) messagesEnd.current?.scrollIntoView({ block: 'nearest' });
  }, [entries, open, thinking]);

  if (!open) return null;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const nextQuestion = question.trim();
    if (!doc || !nextQuestion || thinking || keyMissing) return;

    nextId.current += 1;
    setEntries((current) => [...current, {
      id: nextId.current,
      role: 'user',
      text: nextQuestion,
    }]);
    setQuestion('');
    setError(null);
    setThinking(true);

    try {
      const documentText = await getDocumentText(doc);
      const result = await defaultProviders().discuss({
        question: nextQuestion,
        documentText: documentText.full,
        language: preferredLanguage,
      });
      nextId.current += 1;
      setEntries((current) => [...current, {
        id: nextId.current,
        role: 'assistant',
        text: result.answer,
        grounded: result.grounded,
      }]);
    } catch (caught) {
      setError(readableError(caught));
    } finally {
      setThinking(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[190] flex justify-end bg-neutral-950/35"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="pdf-chat-title"
        className="flex h-full w-full max-w-md flex-col border-l border-neutral-200 bg-white shadow-2xl"
      >
        <header className="border-b border-neutral-200 px-5 py-4">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 id="pdf-chat-title" className="text-lg font-semibold text-neutral-900">Ask this PDF</h2>
              <p className="mt-1 text-xs text-neutral-500">Answers come from this PDF; general knowledge is clearly labeled.</p>
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close PDF chat"
              className="rounded-md px-2 py-1 text-xl leading-none text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900"
            >
              ×
            </button>
          </div>
          <label className="mt-4 block text-xs font-semibold uppercase tracking-wide text-neutral-500">
            Answer language
            <select
              aria-label="Chat answer language"
              value={preferredLanguage}
              onChange={(event) => setPreferredLanguage(event.target.value as SupportedLanguageCode)}
              className="mt-1.5 w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm font-normal normal-case tracking-normal text-neutral-900 outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-200"
            >
              {SUPPORTED_LANGUAGES.map(({ code, label }) => (
                <option key={code} value={code}>{label}</option>
              ))}
            </select>
          </label>
        </header>

        <div className="flex-1 space-y-4 overflow-y-auto px-5 py-5" aria-live="polite">
          {entries.length === 0 && !thinking && (
            <div className="rounded-xl border border-dashed border-neutral-300 bg-neutral-50 p-4 text-sm text-neutral-600">
              Ask about dates, accommodation, activities, or any other information written in the PDF.
            </div>
          )}
          {entries.map((entry) => (
            <article
              key={entry.id}
              className={`max-w-[90%] rounded-xl px-4 py-3 text-sm ${entry.role === 'user' ? 'ml-auto bg-blue-600 text-white' : 'border border-neutral-200 bg-neutral-50 text-neutral-800'}`}
            >
              <p className="whitespace-pre-wrap">{entry.text}</p>
              {entry.role === 'assistant' && entry.grounded === false && (
                <span className="mt-2 inline-flex rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-semibold text-amber-900">
                  General info — not from this PDF
                </span>
              )}
            </article>
          ))}
          {thinking && (
            <div role="status" className="inline-flex rounded-xl border border-neutral-200 bg-neutral-50 px-4 py-3 text-sm text-neutral-500">
              Reading the document…
            </div>
          )}
          {error && (
            <div role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">
              {error}
            </div>
          )}
          <div ref={messagesEnd} />
        </div>

        <footer className="border-t border-neutral-200 p-4">
          {keyMissing ? (
            <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950">
              <p>Add your Sarvam API key in Settings to ask this PDF.</p>
              <button
                type="button"
                onClick={onOpenSettings}
                className="mt-3 rounded-md bg-neutral-900 px-3 py-1.5 font-medium text-white hover:bg-neutral-700"
              >
                Open Settings
              </button>
            </div>
          ) : (
            <form onSubmit={(event) => void submit(event)} className="flex items-end gap-2">
              <label htmlFor="pdf-chat-question" className="sr-only">Ask a question about this PDF</label>
              <textarea
                id="pdf-chat-question"
                rows={2}
                value={question}
                onChange={(event) => setQuestion(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !event.shiftKey) {
                    event.preventDefault();
                    event.currentTarget.form?.requestSubmit();
                  }
                }}
                placeholder="Ask a question about this PDF…"
                disabled={!doc || thinking}
                className="min-h-11 flex-1 resize-none rounded-md border border-neutral-300 px-3 py-2 text-sm text-neutral-900 outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-200 disabled:bg-neutral-100"
              />
              <button
                type="submit"
                disabled={!doc || thinking || question.trim() === ''}
                className="rounded-md bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-40"
              >
                Send
              </button>
            </form>
          )}
        </footer>
      </section>
    </div>
  );
}
