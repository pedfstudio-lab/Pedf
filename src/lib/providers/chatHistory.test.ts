import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';

import { CHAT_HISTORY_TURNS, fingerprintDocumentText, recentChatHistory } from './chatHistory';

describe('fingerprintDocumentText', () => {
  it('identifies the exact UTF-8 context, deterministically, without keeping the full text', async () => {
    const text = '[Page 1]\nFee: Rs. 21,999\nनमस्ते';
    const fingerprint = await fingerprintDocumentText(text);
    expect(fingerprint).toBe(createHash('sha256').update(text).digest('hex'));
    expect(await fingerprintDocumentText(text)).toBe(fingerprint);
    expect(await fingerprintDocumentText(text.replace('21,999', '31,999'))).not.toBe(fingerprint);
    expect(await fingerprintDocumentText(text + '\n')).not.toBe(fingerprint);
    expect(fingerprint).toHaveLength(64);
  });
});

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

  it('marks only answers that used different text; never mutates entries or marks user questions', () => {
    const entries = [
      { role: 'user' as const, text: 'What is the fee?', documentFingerprint: 'original' },
      { role: 'assistant' as const, text: '21,999.', documentFingerprint: 'original' },
      { role: 'user' as const, text: 'And now?' },
      { role: 'assistant' as const, text: '31,999.', documentFingerprint: 'edited' },
    ];
    const before = JSON.stringify(entries);
    expect(recentChatHistory(entries, 'edited')).toEqual([
      { role: 'user', content: 'What is the fee?' },
      { role: 'assistant', content: '21,999.', outOfDate: true },
      { role: 'user', content: 'And now?' },
      { role: 'assistant', content: '31,999.' },
    ]);
    expect(JSON.stringify(entries)).toBe(before);
    // Undo restores the original context: the original answer is current again.
    expect(recentChatHistory(entries, 'original')[1]).not.toHaveProperty('outOfDate');
    expect(recentChatHistory(entries, 'original')[3]).toHaveProperty('outOfDate', true);
  });

  it('leaves same-context/legacy histories and the eight-message bound unchanged', () => {
    const entries = Array.from({ length: 12 }, (_, index) => ({
      role: index % 2 ? 'assistant' as const : 'user' as const,
      text: `turn ${index}`,
      documentFingerprint: index < 4 ? 'old' : 'current',
    }));
    expect(CHAT_HISTORY_TURNS).toBe(8);
    expect(recentChatHistory(entries, 'current')).toEqual(recentChatHistory(entries));
    expect(recentChatHistory([{ role: 'assistant', text: 'Older entry without metadata' }], 'current'))
      .toEqual([{ role: 'assistant', content: 'Older entry without metadata' }]);
    expect(recentChatHistory([], 'current')).toEqual([]);
  });

  it('continues marking the retained old answers through ten successive edits', () => {
    const entries: Array<{ role: 'user' | 'assistant'; text: string; documentFingerprint?: string }> = [];
    for (let edit = 0; edit < 10; edit++) {
      const fingerprint = `text-${edit}`;
      const beforeAnswer = recentChatHistory(entries, fingerprint);
      expect(beforeAnswer).toHaveLength(Math.min(edit * 2, CHAT_HISTORY_TURNS));
      expect(beforeAnswer.filter(message => message.role === 'assistant').every(message => message.outOfDate)).toBe(true);
      entries.push({ role: 'user', text: 'What is the fee?' }, { role: 'assistant', text: `Fee ${edit}`, documentFingerprint: fingerprint });
      expect(recentChatHistory(entries, fingerprint).at(-1)).not.toHaveProperty('outOfDate');
    }
  });
});
