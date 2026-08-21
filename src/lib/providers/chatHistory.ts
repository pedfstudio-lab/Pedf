import type { DiscussHistoryMessage } from './types';

export const CHAT_HISTORY_TURNS = 8;

interface ChatHistoryEntry {
  readonly role: 'user' | 'assistant';
  readonly text: string;
}

export function recentChatHistory(
  entries: readonly ChatHistoryEntry[],
): DiscussHistoryMessage[] {
  return entries.slice(-CHAT_HISTORY_TURNS).map(({ role, text }) => ({
    role,
    content: text,
  }));
}
