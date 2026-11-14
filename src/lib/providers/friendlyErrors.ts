import { HUMAN_CHECK_FAILED } from '@/lib/turnstile/pass';
import {
  CONTENT_FILTER_MESSAGE, RATE_LIMITED_MESSAGE, SERVICE_UNAVAILABLE_MESSAGE, TRANSLATION_FILTER_MESSAGE, TRANSLATION_KEY_MESSAGE,
} from './sarvam';

export const ASK_FAILED_MESSAGE = "Ask couldn't get an answer just now. Please try again in a moment.";
export const VOICE_FAILED_MESSAGE = "Voice isn't working just now. Please try again, or type your question.";
export const PLAYBACK_FAILED_MESSAGE = "Read aloud isn't working just now. Please try again.";
export const CONVERSATION_CLOSE_FAILED_MESSAGE = "Conversation didn't close cleanly. Close this panel and open it again.";

/** Messages written for people: shown as they are. */
const SAFE_MESSAGES = new Set<string>([
  CONTENT_FILTER_MESSAGE,
  TRANSLATION_FILTER_MESSAGE,
  TRANSLATION_KEY_MESSAGE,
  RATE_LIMITED_MESSAGE,
  SERVICE_UNAVAILABLE_MESSAGE,
  HUMAN_CHECK_FAILED,
]);

/**
 * What the Ask panel shows when something fails. Anything technical (Sarvam's raw replies,
 * connection codes, library errors) becomes a plain fallback, so people never see internals.
 */
export function friendlyAiError(error: unknown, fallback = ASK_FAILED_MESSAGE): string {
  const cause = error instanceof AggregateError ? error.errors.find((item): item is Error => item instanceof Error) : error;
  const message = cause instanceof Error ? cause.message : '';
  return SAFE_MESSAGES.has(message) ? message : fallback;
}
