import { describe, expect, it } from 'vitest';
import { HumanCheckError } from '@/lib/turnstile/pass';
import { ASK_FAILED_MESSAGE, friendlyAiError, VOICE_FAILED_MESSAGE } from './friendlyErrors';
import { CONTENT_FILTER_MESSAGE, RATE_LIMITED_MESSAGE, sarvamUnavailableMessage } from './sarvam';

describe('what the Ask panel shows when something fails', () => {
  it('keeps messages written for people', () => {
    expect(friendlyAiError(new Error(CONTENT_FILTER_MESSAGE))).toBe(CONTENT_FILTER_MESSAGE);
    expect(friendlyAiError(new Error(RATE_LIMITED_MESSAGE))).toBe(RATE_LIMITED_MESSAGE);
    expect(friendlyAiError(new Error(sarvamUnavailableMessage(503)))).toBe(sarvamUnavailableMessage(503));
    expect(friendlyAiError(new HumanCheckError())).toBe(new HumanCheckError().message);
  });

  it('hides technical details behind a plain message', () => {
    for (const raw of ['Sarvam request failed (500): upstream_timeout', 'Sarvam streaming STT connection failed.', 'TypeError: x is undefined', '']) {
      expect(friendlyAiError(new Error(raw))).toBe(ASK_FAILED_MESSAGE);
    }
    expect(friendlyAiError('not even an error')).toBe(ASK_FAILED_MESSAGE);
    expect(friendlyAiError(new Error('socket closed (1006)'), VOICE_FAILED_MESSAGE)).toBe(VOICE_FAILED_MESSAGE);
  });

  it('looks inside grouped failures for a message written for people', () => {
    expect(friendlyAiError(new AggregateError([new Error(RATE_LIMITED_MESSAGE)]))).toBe(RATE_LIMITED_MESSAGE);
    expect(friendlyAiError(new AggregateError([new Error('raw')]))).toBe(ASK_FAILED_MESSAGE);
  });
});
