import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  MAX_CONVERSATION_TRANSCRIPT_CHARS,
  createConversationEndpoint,
  isUsableConversationTranscript,
  mergeConversationTranscript,
} from './conversationEndpoint';

describe('createConversationEndpoint', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('finalizes after the configured silence delay', async () => {
    vi.useFakeTimers();
    const ask = vi.fn();
    const endpoint = createConversationEndpoint(ask, 600);

    endpoint.onSpeechEnd(true);
    await vi.advanceTimersByTimeAsync(599);
    expect(ask).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(ask).toHaveBeenCalledOnce();
  });

  it('resets on resumed speech and ignores empty transcripts', async () => {
    vi.useFakeTimers();
    const ask = vi.fn();
    const endpoint = createConversationEndpoint(ask, 600);

    endpoint.onSpeechEnd(false);
    await vi.advanceTimersByTimeAsync(600);
    endpoint.onSpeechEnd(true);
    await vi.advanceTimersByTimeAsync(599);
    endpoint.onSpeechStart();
    await vi.advanceTimersByTimeAsync(600);
    expect(ask).not.toHaveBeenCalled();

    endpoint.onSpeechEnd(true);
    endpoint.cancel();
    await vi.advanceTimersByTimeAsync(600);
    expect(ask).not.toHaveBeenCalled();
  });
});

describe('conversation transcript accumulation', () => {
  it('replaces growing partials and appends distinct speech segments', () => {
    expect(mergeConversationTranscript('what are', 'what are the dates')).toBe(
      'what are the dates',
    );
    expect(mergeConversationTranscript('what are the dates', 'in this PDF?')).toBe(
      'what are the dates in this PDF?',
    );
    expect(mergeConversationTranscript('what are the dates', 'what are')).toBe(
      'what are the dates',
    );
  });

  it('rejects punctuation-only input and caps very long monologues', () => {
    expect(isUsableConversationTranscript('  ...?!  ')).toBe(false);
    expect(isUsableConversationTranscript('हाँ?')).toBe(true);
    const capped = mergeConversationTranscript('', 'a'.repeat(5_000));
    expect(capped).toHaveLength(MAX_CONVERSATION_TRANSCRIPT_CHARS);
  });
});
