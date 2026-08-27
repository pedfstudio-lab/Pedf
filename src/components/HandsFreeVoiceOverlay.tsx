import type { ConversationPhase } from '@/lib/speech/conversationSession';

interface HandsFreeVoiceOverlayProps {
  readonly phase: ConversationPhase;
  readonly answer?: string;
  onOpenChat(): void;
  onStop(): void;
}

function handsFreePhaseLabel(phase: ConversationPhase): string {
  switch (phase) {
    case 'listening':
      return 'Listening…';
    case 'thinking':
      return 'Thinking…';
    case 'speaking':
      return 'Speaking…';
    default:
      return 'Voice conversation';
  }
}

/** Click-through voice chrome that leaves the PDF fully interactive underneath. */
export function HandsFreeVoiceOverlay({
  phase,
  answer,
  onOpenChat,
  onStop,
}: HandsFreeVoiceOverlayProps) {
  return (
    <div className="pointer-events-none fixed inset-0 z-[190]" data-hands-free-overlay>
      <div className="absolute inset-x-0 bottom-4 flex justify-center px-4 sm:bottom-6">
        <div className="pointer-events-none flex w-full max-w-2xl flex-col items-center gap-3">
          {answer && (
            <section
              aria-label="Latest voice answer"
              aria-live="polite"
              className="pointer-events-auto max-h-48 w-full overflow-y-auto rounded-2xl border border-white/20 bg-neutral-950/80 px-4 py-3 text-sm leading-relaxed text-white shadow-2xl backdrop-blur-md"
            >
              <p className="whitespace-pre-wrap">{answer}</p>
            </section>
          )}

          <div
            role="status"
            className="pointer-events-auto flex max-w-full items-center gap-2 rounded-full border border-white/20 bg-neutral-950/90 p-1.5 pl-3 text-sm text-white shadow-2xl backdrop-blur-md"
          >
            <span
              aria-hidden="true"
              className={`h-2.5 w-2.5 shrink-0 rounded-full ${phase === 'listening' ? 'animate-pulse bg-emerald-400' : phase === 'thinking' ? 'bg-amber-400' : 'bg-violet-400'}`}
            />
            <span className="min-w-0 truncate font-semibold">{handsFreePhaseLabel(phase)}</span>
            <button
              type="button"
              onClick={onOpenChat}
              className="shrink-0 rounded-full bg-white/10 px-3 py-1.5 text-xs font-semibold text-white hover:bg-white/20"
            >
              Open chat
            </button>
            <button
              type="button"
              onClick={onStop}
              className="shrink-0 rounded-full bg-red-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-red-500"
            >
              Stop
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
