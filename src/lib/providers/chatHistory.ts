import type { DiscussHistoryMessage } from './types';

export const CHAT_HISTORY_TURNS = 8;

interface ChatHistoryEntry {
  readonly role: 'user' | 'assistant';
  readonly text: string;
  readonly documentFingerprint?: string;
}

/** Identity of the exact context sent with an answer, not of the edit revision. */
export async function fingerprintDocumentText(text: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('');
}

export function recentChatHistory(
  entries: readonly ChatHistoryEntry[],
  currentDocumentFingerprint?: string,
): DiscussHistoryMessage[] {
  return entries.slice(-CHAT_HISTORY_TURNS).map(({ role, text, documentFingerprint }) => ({
    role,
    content: text,
    ...(role === 'assistant' && currentDocumentFingerprint !== undefined
      && documentFingerprint !== undefined && documentFingerprint !== currentDocumentFingerprint
      ? { outOfDate: true } : {}),
  }));
}
