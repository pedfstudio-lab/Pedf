import { SUPPORTED_LANGUAGES } from '@/state/prefsStore';
import type { SupportedLanguageCode } from '@/state/prefsStore';
import { MicIcon } from './LineIcons';

export type TalkStatus = 'starting' | 'listening' | 'recording' | 'thinking' | 'speaking' | 'paused';

interface TalkModeProps {
  readonly status: TalkStatus;
  /** What the person said: their words as they speak, otherwise their last question. */
  readonly heard?: string;
  /** HighPal's reply to that question, once it has arrived. */
  readonly answer?: string;
  /** The reply is general knowledge, not something written in the PDF. */
  readonly answerIsGeneral?: boolean;
  readonly error?: string | null;
  /**
   * True while the microphone stays open between turns (people can interrupt the answer by talking).
   * False when live speech is unavailable and each question is a tap to start, a tap to send.
   */
  readonly handsFree: boolean;
  readonly language: SupportedLanguageCode;
  onLanguageChange(language: SupportedLanguageCode): void;
  onMicTap(): void;
  onEnd(): void;
}

const STATUS_LABEL: Record<TalkStatus, string> = {
  starting: 'Starting…',
  listening: 'Listening…',
  recording: 'Listening…',
  thinking: 'Thinking…',
  speaking: 'Speaking…',
  paused: 'Paused',
};

function statusHint(status: TalkStatus, handsFree: boolean): string {
  switch (status) {
    case 'starting':
      return 'Opening the microphone.';
    case 'listening':
      return 'Speak naturally. Pause when you finish.';
    case 'recording':
      return 'Tap the mic when you finish.';
    case 'thinking':
      return 'Reading your PDF.';
    case 'speaking':
      return handsFree ? 'Start talking to interrupt, or tap the mic to pause.' : 'Tap the mic to stop.';
    default:
      return handsFree ? 'Tap the mic to talk.' : 'Tap the mic, speak, then tap again to send.';
  }
}

function micLabel(status: TalkStatus): string {
  if (status === 'paused') return 'Start talking';
  if (status === 'recording') return 'Send what I said';
  return 'Pause talking';
}

/**
 * Talk: a voice conversation with the open PDF. A big mic at the bottom, the words of both sides
 * in a caption card above it, and the PDF still visible and usable around it.
 */
export function TalkMode({
  status,
  heard,
  answer,
  answerIsGeneral = false,
  error,
  handsFree,
  language,
  onLanguageChange,
  onMicTap,
  onEnd,
}: TalkModeProps) {
  const waiting = !answer && Boolean(heard) && (status === 'thinking' || status === 'speaking');
  const listening = status === 'listening' || status === 'recording';
  return (
    <section
      aria-label="Talk with this PDF"
      data-talk-mode
      className="pointer-events-none fixed inset-x-0 bottom-0 z-[190] flex flex-col items-center gap-3 bg-linear-to-t from-neutral-950/25 to-transparent px-4 pb-4 pt-10 sm:pb-6"
    >
      <div className="pointer-events-auto w-full max-w-xl rounded-2xl border border-neutral-200 bg-white/95 px-4 py-3 text-sm leading-relaxed text-neutral-800 shadow-xl backdrop-blur">
        <div className="max-h-44 space-y-1.5 overflow-y-auto" aria-live="polite">
          {!heard && !answer ? (
            <p className="text-neutral-600">Ask anything about this PDF, out loud.</p>
          ) : (
            <>
              {heard && (
                <p className="whitespace-pre-wrap"><strong className="font-semibold text-neutral-600">You: </strong>{heard}</p>
              )}
              {(answer || waiting) && (
                <p className="whitespace-pre-wrap">
                  <strong className="font-semibold text-brand-800">HighPal: </strong>
                  {answer ?? <span className="text-neutral-500">…</span>}
                </p>
              )}
              {answer && answerIsGeneral && (
                <span className="inline-flex rounded-full bg-warning-100 px-2 py-0.5 text-[11px] font-semibold text-warning-900">
                  General info — not from this PDF
                </span>
              )}
            </>
          )}
        </div>
        {error && (
          <p role="alert" className="mt-2 rounded-lg border border-danger-200 bg-danger-50 px-3 py-2 text-sm text-danger-800">{error}</p>
        )}
        <p aria-hidden="true" className="mt-2 text-xs font-medium text-neutral-600">{statusHint(status, handsFree)}</p>
        <p className="mt-0.5 text-[11px] leading-snug text-neutral-500">
          Your voice and this PDF’s text are sent to Sarvam AI to answer. HighPal doesn’t store them.
        </p>
      </div>

      <div className="grid w-full max-w-xl grid-cols-[1fr_auto_1fr] items-center gap-3">
        <select
          aria-label="Talk language"
          value={language}
          onChange={(event) => onLanguageChange(event.target.value as SupportedLanguageCode)}
          className="pointer-events-auto max-w-full justify-self-start rounded-full border border-neutral-300 bg-white px-3 py-2 text-sm font-semibold text-neutral-800 shadow-md outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
        >
          {SUPPORTED_LANGUAGES.map(({ code, label }) => (
            <option key={code} value={code}>{label}</option>
          ))}
        </select>

        <div className="flex flex-col items-center gap-1.5">
          <div className="relative grid h-24 w-24 place-items-center" data-talk-status={status}>
            {listening && (
              <>
                <span aria-hidden="true" className="absolute inset-2 rounded-full bg-accent/50 motion-safe:animate-ping" />
                <span aria-hidden="true" className="absolute inset-0 rounded-full bg-accent/25 motion-safe:animate-pulse" />
              </>
            )}
            {(status === 'thinking' || status === 'starting') && (
              <span aria-hidden="true" className="absolute inset-0 rounded-full border-4 border-accent/30 border-t-accent motion-safe:animate-spin" />
            )}
            {status === 'speaking' && (
              <span aria-hidden="true" className="absolute inset-0 rounded-full bg-accent/40 motion-safe:animate-talk-breathe" />
            )}
            <button
              type="button"
              autoFocus
              onClick={onMicTap}
              aria-label={micLabel(status)}
              className={`pointer-events-auto relative grid h-20 w-20 place-items-center rounded-full text-white shadow-xl ring-4 ring-accent transition-colors focus:outline-none focus-visible:ring-8 ${status === 'paused' ? 'bg-brand-900 hover:bg-brand-800' : 'bg-brand-700 hover:bg-brand-600'}`}
            >
              <MicIcon className="h-9 w-9" strokeWidth={2} />
            </button>
          </div>
          <p role="status" className="pointer-events-auto rounded-full bg-white/95 px-3 py-0.5 text-center text-xs shadow-sm">
            <span className="font-semibold text-neutral-900">{STATUS_LABEL[status]}</span>
            <span className="sr-only"> {statusHint(status, handsFree)}</span>
          </p>
        </div>

        <button
          type="button"
          onClick={onEnd}
          className="pointer-events-auto justify-self-end rounded-full border border-neutral-300 bg-white px-4 py-2 text-sm font-semibold text-danger-700 shadow-md hover:bg-danger-50"
        >
          End
        </button>
      </div>
    </section>
  );
}
