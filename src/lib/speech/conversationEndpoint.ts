export interface ConversationEndpoint {
  onSpeechStart(): void;
  onSpeechEnd(hasTranscript: boolean): void;
  cancel(): void;
}

export const MAX_CONVERSATION_TRANSCRIPT_CHARS = 4_000;

export function isUsableConversationTranscript(text: string): boolean {
  return /[\p{L}\p{N}]/u.test(text);
}

function comparisonToken(token: string): string {
  const word = token
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
  return word === '' ? token.toLocaleLowerCase() : word;
}

function segmentsMatch(words: readonly string[], first: number, second: number, length: number): boolean {
  for (let offset = 0; offset < length; offset += 1) {
    if (comparisonToken(words[first + offset] ?? '') !== comparisonToken(words[second + offset] ?? '')) {
      return false;
    }
  }
  return true;
}

/** Collapse adjacent repeated words or phrases in a clean provider-final transcript. */
export function dedupeImmediateTranscriptRepeats(
  text: string,
  maxChars = MAX_CONVERSATION_TRANSCRIPT_CHARS,
): string {
  const words = text.replace(/\s+/gu, ' ').trim().split(' ').filter(Boolean);
  const deduped: string[] = [];
  let cursor = 0;

  while (cursor < words.length) {
    let repeatedLength = 0;
    let repeatCount = 1;
    const maxLength = Math.floor((words.length - cursor) / 2);
    for (let length = 1; length <= maxLength; length += 1) {
      if (!segmentsMatch(words, cursor, cursor + length, length)) continue;
      repeatedLength = length;
      repeatCount = 2;
      while (
        cursor + (repeatCount + 1) * length <= words.length
        && segmentsMatch(words, cursor, cursor + repeatCount * length, length)
      ) {
        repeatCount += 1;
      }
      break;
    }

    if (repeatedLength > 0) {
      deduped.push(...words.slice(cursor, cursor + repeatedLength));
      cursor += repeatedLength * repeatCount;
    } else {
      deduped.push(words[cursor] ?? '');
      cursor += 1;
    }
  }

  return deduped.join(' ').slice(0, maxChars).trimEnd();
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
