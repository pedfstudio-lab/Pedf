const PERIOD_PLACEHOLDER = '\uE000';
export const FIRST_SPEECH_CHUNK_MAX_CHARS = 60;
export const SECOND_SPEECH_CHUNK_TARGET_CHARS = 60;
export const THIRD_SPEECH_CHUNK_TARGET_CHARS = 100;
export const COALESCED_SPEECH_CHUNK_TARGET_CHARS = 150;

function protectPeriods(text: string): string {
  return text
    .replace(/\b(?:a\.m|p\.m)\./gi, (match, offset: number, source: string) => {
      const following = source.slice(offset + match.length);
      const endsSentence = /^\s+(?:\[Page\s+\d+\]\s*)*[A-Z]/.test(following)
        || /^\s*(?:\[Page\s+\d+\]\s*)+$/.test(following);
      const protectedMatch = match.slice(0, -1).replaceAll('.', PERIOD_PLACEHOLDER);
      return `${protectedMatch}${endsSentence ? '.' : PERIOD_PLACEHOLDER}`;
    })
    .replace(/\b(?:Mr|Mrs|Ms|Dr|Prof|Sr|Jr|St|vs|etc|approx|dept|fig|no|e\.g|i\.e)\./gi, (match) => (
      match.replaceAll('.', PERIOD_PLACEHOLDER)
    ))
    .replace(/\b(?:Pvt|Ltd|Inc|Corp)\./gi, (match) => (
      match.replaceAll('.', PERIOD_PLACEHOLDER)
    ))
    .replace(/\b(?:[A-Za-z]\.){2,}/g, (match) => match.replaceAll('.', PERIOD_PLACEHOLDER))
    .replace(/([A-Za-z])\.(?=[A-Za-z])/g, `$1${PERIOD_PLACEHOLDER}`)
    .replace(/\b([A-Z])\.(?=\s+(?:[A-Z]\.|[A-Z][a-z]))/g, `$1${PERIOD_PLACEHOLDER}`)
    .replace(/(\d)\.(\d)/g, `$1${PERIOD_PLACEHOLDER}$2`);
}

function restorePeriods(text: string): string {
  return text.replaceAll(PERIOD_PLACEHOLDER, '.');
}

/** Split speech into short sentence clips while keeping page citations with the sentence before them. */
export function chunkSentences(text: string): string[] {
  const normalized = protectPeriods(text.replace(/\s+/g, ' ').trim());
  if (normalized === '') return [];

  const pieces = normalized.match(/[^.!?।]+(?:[.!?।]+(?:["'”’)]*)?|$)/g) ?? [];
  const chunks: string[] = [];

  for (const rawPiece of pieces) {
    let piece = restorePeriods(rawPiece).trim();
    if (piece === '') continue;

    const citations = piece.match(/^((?:\[Page\s+\d+\]\s*)+)(.*)$/is);
    if (citations && chunks.length > 0) {
      const citationText = citations[1]?.trim();
      if (citationText) {
        chunks[chunks.length - 1] = `${chunks[chunks.length - 1]} ${citationText}`;
      }
      piece = citations[2]?.trim() ?? '';
    }

    if (piece !== '') chunks.push(piece);
  }

  return chunks;
}

/** Normalize readability quirks for TTS without changing the displayed answer. */
export function normalizeForSpeech(text: string): string {
  return text
    .replace(/([A-Za-z])\.(?=[A-Za-z])/g, '$1 ')
    .replace(/\b[A-Z]{2,}(?:\s+[A-Z]{2,})+\b/g, (run) => (
      run
        .split(/\s+/)
        .map((word) => `${word[0]}${word.slice(1).toLowerCase()}`)
        .join(' ')
    ))
    .replace(/\s+/g, ' ')
    .trim();
}

/** Keep the first TTS request short, preferring a natural clause boundary. */
export function splitFirstSpeechChunk(
  sentence: string,
  maxChars = FIRST_SPEECH_CHUNK_MAX_CHARS,
): string[] {
  const normalized = sentence.replace(/\s+/g, ' ').trim();
  if (normalized === '' || normalized.length <= maxChars) return normalized ? [normalized] : [];

  const prefix = normalized.slice(0, maxChars + 1);
  const minimumClauseLength = Math.min(20, Math.floor(maxChars / 2));
  const clauseBoundaries = [...prefix.matchAll(/[,;:—–](?=\s|$)/g)]
    .filter((match) => (match.index ?? 0) >= minimumClauseLength);
  const clauseBoundary = clauseBoundaries[clauseBoundaries.length - 1];
  const whitespaceBoundary = normalized.lastIndexOf(' ', maxChars);
  const splitAt = clauseBoundary
    ? (clauseBoundary.index ?? 0) + clauseBoundary[0].length
    : whitespaceBoundary >= minimumClauseLength
      ? whitespaceBoundary
      : maxChars;

  const first = normalized.slice(0, splitAt).trim();
  const remainder = normalized.slice(splitAt).trim();
  if (!remainder.includes(' ') || remainder.length < 16) return [normalized];
  return remainder ? [first, remainder] : [first];
}

export interface SpeechChunkAccumulator {
  push(sentence: string): string[];
  flush(): string[];
}

function rampedSpeechChunkTarget(releasedCount: number, finalTarget: number): number {
  if (releasedCount <= 1) return Math.min(SECOND_SPEECH_CHUNK_TARGET_CHARS, finalTarget);
  if (releasedCount === 2) return Math.min(THIRD_SPEECH_CHUNK_TARGET_CHARS, finalTarget);
  return finalTarget;
}

/** Keep the fast first pieces, then amortize TTS latency with larger later clips. */
export function createSpeechChunkAccumulator(
  targetChars = COALESCED_SPEECH_CHUNK_TARGET_CHARS,
): SpeechChunkAccumulator {
  let started = false;
  let pending = '';
  let releasedCount = 0;

  return {
    push(sentence) {
      const normalized = sentence.replace(/\s+/g, ' ').trim();
      if (normalized === '') return [];
      if (!started) {
        started = true;
        const ready = splitFirstSpeechChunk(normalized);
        releasedCount += ready.length;
        return ready;
      }

      pending = pending ? `${pending} ${normalized}` : normalized;
      if (pending.length < rampedSpeechChunkTarget(releasedCount, targetChars)) return [];
      const ready = pending;
      pending = '';
      releasedCount += 1;
      return [ready];
    },

    flush() {
      if (pending === '') return [];
      const ready = pending;
      pending = '';
      releasedCount += 1;
      return [ready];
    },
  };
}

export function coalesceSpeechChunks(
  sentences: readonly string[],
  targetChars = COALESCED_SPEECH_CHUNK_TARGET_CHARS,
): string[] {
  const accumulator = createSpeechChunkAccumulator(targetChars);
  return [
    ...sentences.flatMap((sentence) => accumulator.push(sentence)),
    ...accumulator.flush(),
  ];
}

export interface SentenceAccumulator {
  push(delta: string): string[];
  flush(): string[];
}

/** Collect arbitrary SSE deltas and release only sentences with a real terminal boundary. */
export function createSentenceAccumulator(): SentenceAccumulator {
  let buffer = '';

  return {
    push(delta) {
      buffer += delta;
      const protectedBuffer = protectPeriods(buffer);
      const boundaryPattern = /[.!?।]+(?:["'”’)]*)?(?:\s*\[Page\s+\d+\])*/g;
      const complete: string[] = [];
      let releasedThrough = 0;
      let boundary: RegExpExecArray | null;

      while ((boundary = boundaryPattern.exec(protectedBuffer)) !== null) {
        const boundaryEnd = boundary.index + boundary[0].length;
        const rawSentence = buffer.slice(releasedThrough, boundaryEnd);
        complete.push(...chunkSentences(rawSentence));
        releasedThrough = boundaryEnd;
      }

      if (releasedThrough > 0) buffer = buffer.slice(releasedThrough);
      return complete;
    },

    flush() {
      const chunks = chunkSentences(buffer);
      buffer = '';
      return chunks;
    },
  };
}
