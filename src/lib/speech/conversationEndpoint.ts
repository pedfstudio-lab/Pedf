export interface ConversationEndpoint {
  onSpeechStart(): void;
  onSpeechEnd(hasTranscript: boolean): void;
  cancel(): void;
}

export const MAX_CONVERSATION_TRANSCRIPT_CHARS = 4_000;

export function isUsableConversationTranscript(text: string): boolean {
  return /[\p{L}\p{N}]/u.test(text);
}

/** Merge cumulative partials and new segments without duplicating growing transcripts. */
export function mergeConversationTranscript(
  current: string,
  partial: string,
  maxChars = MAX_CONVERSATION_TRANSCRIPT_CHARS,
): string {
  const existing = current.replace(/\s+/gu, ' ').trim();
  const incoming = partial.replace(/\s+/gu, ' ').trim();
  if (incoming === '') return existing;
  const merged = existing === '' || incoming.startsWith(existing)
    ? incoming
    : existing.startsWith(incoming) || existing.endsWith(incoming)
      ? existing
      : `${existing} ${incoming}`;
  return merged.slice(0, maxChars).trimEnd();
}

/** Arm finalization after silence, and cancel it immediately when speech resumes. */
export function createConversationEndpoint(
  finalizeTurn: () => void,
  silenceMs: number,
): ConversationEndpoint {
  let endpointTimer: ReturnType<typeof setTimeout> | undefined;

  const cancel = () => {
    if (endpointTimer === undefined) return;
    clearTimeout(endpointTimer);
    endpointTimer = undefined;
  };

  return {
    onSpeechStart: cancel,
    onSpeechEnd(hasTranscript) {
      cancel();
      if (!hasTranscript) return;
      endpointTimer = setTimeout(() => {
        endpointTimer = undefined;
        finalizeTurn();
      }, silenceMs);
    },
    cancel,
  };
}
