import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  MAX_CONVERSATION_TRANSCRIPT_CHARS,
  createConversationEndpoint,
  dedupeImmediateTranscriptRepeats,
  isUsableConversationTranscript,
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

describe('clean final conversation transcripts', () => {
  it('collapses immediately repeated words and phrases without stitching partials', () => {
    expect(dedupeImmediateTranscriptRepeats(
      'Microsoft Excel Microsoft Excel Microsoft Excel Microsoft Excel is listed',
    )).toBe('Microsoft Excel is listed');
    expect(dedupeImmediateTranscriptRepeats('What what WHAT, is the role?')).toBe(
      'What is the role?',
    );
    expect(dedupeImmediateTranscriptRepeats('Excel appears here and Excel appears later')).toBe(
      'Excel appears here and Excel appears later',
    );
  });

  it('rejects punctuation-only input and caps very long final transcripts', () => {
    expect(isUsableConversationTranscript('  ...?!  ')).toBe(false);
    expect(isUsableConversationTranscript('हाँ?')).toBe(true);
    const capped = dedupeImmediateTranscriptRepeats('a'.repeat(5_000));
    expect(capped).toHaveLength(MAX_CONVERSATION_TRANSCRIPT_CHARS);
  });
});
