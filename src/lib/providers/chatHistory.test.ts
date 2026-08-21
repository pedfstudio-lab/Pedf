import { describe, expect, it } from 'vitest';

import { CHAT_HISTORY_TURNS, recentChatHistory } from './chatHistory';

describe('recentChatHistory', () => {
  it('maps only the most recent bounded entries', () => {
    const entries = Array.from({ length: CHAT_HISTORY_TURNS + 2 }, (_, index) => ({
      role: index % 2 === 0 ? ('user' as const) : ('assistant' as const),
      text: `message ${index + 1}`,
    }));

    expect(recentChatHistory(entries)).toEqual(
      entries.slice(-CHAT_HISTORY_TURNS).map(({ role, text }) => ({
        role,
        content: text,
      })),
    );
  });

  it('excludes the current question while it is not yet in the thread', () => {
    const currentQuestion = 'What happens next?';
    const history = recentChatHistory([
      { role: 'user', text: 'Where are we going?' },
      { role: 'assistant', text: 'Goa.' },
    ]);

    expect(history).not.toContainEqual({ role: 'user', content: currentQuestion });
  });
});
