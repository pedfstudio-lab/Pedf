import { describe, expect, it } from 'vitest';
import { SUPPORTED_LANGUAGES } from '@/state/prefsStore';
import {
  buildDiscussMessages,
  languageNameFor,
  NOT_IN_DOCUMENT_MARKER,
  OUTDATED_ANSWER_NOTE,
  EDITED_DOCUMENT_RULE,
} from './discussPrompt';

describe('buildDiscussMessages', () => {
  it('includes the document in the system message and the current question last', () => {
    const messages = buildDiscussMessages({
      documentText: '[Page 1]\nCheck-in is at 3 PM.',
      question: 'What time is check-in?',
      language: 'hi-IN',
    });

    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({ role: 'system' });
    expect(messages[0]?.content).toContain('cite the relevant [Page N]');
    expect(messages[0]?.content).toContain('general knowledge');
    expect(messages[0]?.content).toContain('Answer concisely in Hindi');
    expect(messages[0]?.content).toContain('warm, easygoing companion');
    expect(messages[0]?.content).toContain('never clinical or robotic');
    expect(messages[0]?.content).toContain('say so honestly and warmly');
    expect(messages[0]?.content).toContain('cannot access accounts or history');
    expect(messages[0]?.content).toContain('qualified professional');
    expect(messages[0]?.content).toContain(NOT_IN_DOCUMENT_MARKER);
    expect(messages[0]?.content).toContain('[Page 1]\nCheck-in is at 3 PM.');
    expect(messages[1]?.content).not.toContain('<DOCUMENT>');
    expect(messages[1]?.content).toContain('What time is check-in?');
    expect(messages[0]?.content).not.toContain('no more than 40 words');
    expect(messages[0]?.content).not.toContain('end the call');
    expect(messages[0]?.content).not.toContain('voicemail');
  });

  it('adds the brevity instruction only for a spoken question', () => {
    const spoken = buildDiscussMessages({
      documentText: '[Page 1]\nCheck-in is at 3 PM.',
      question: 'What time is check-in?',
      spoken: true,
    });
    const typed = buildDiscussMessages({
      documentText: '[Page 1]\nCheck-in is at 3 PM.',
      question: 'What time is check-in?',
    });

    expect(spoken[0]?.content).toContain(
      'answer in 1–2 short sentences and no more than 40 words',
    );
    expect(spoken[0]?.content).toContain(
      'Use normal capitalization for institution and company names',
    );
    expect(typed[0]?.content).not.toContain('no more than 40 words');
    expect(typed[0]?.content).not.toContain('normal capitalization');
  });

  it('places prior turns between the document system message and current question', () => {
    const messages = buildDiscussMessages({
      documentText: '[Page 1]\nThe trip to Goa begins on 22 July.',
      question: 'How is the weather there then?',
      history: [
        { role: 'user', content: 'When are we leaving for Goa?' },
        { role: 'assistant', content: '22 July [Page 1]' },
      ],
    });

    expect(messages).toHaveLength(4);
    expect(messages.map(({ role }) => role)).toEqual([
      'system',
      'user',
      'assistant',
      'user',
    ]);
    expect(messages[0]?.content).toContain('<DOCUMENT>');
    expect(messages[1]?.content).toBe('When are we leaving for Goa?');
    expect(messages[2]?.content).toBe('22 July [Page 1]');
    expect(messages[3]?.content).toBe(
      '<QUESTION>\nHow is the weather there then?\n</QUESTION>\n'
      + 'Answer in English, even if earlier messages were in another language.',
    );
  });

  it.each(SUPPORTED_LANGUAGES)('ends each question with the chosen $name rule, preserving history', ({ code, name }) => {
    const history = [
      { role: 'user' as const, content: 'पहला विकल्प क्या है?' },
      { role: 'assistant' as const, content: 'पहला विकल्प गोवा है। [Page 1]' },
    ];
    const input = { documentText: '[Page 1]\nGoa and Kerala.', question: 'And the second one?', language: code };
    const messages = buildDiscussMessages({ ...input, history });
    const withoutHistory = buildDiscussMessages(input);

    expect(messages.slice(1, -1)).toEqual(history);
    expect(messages[0]).toEqual(withoutHistory[0]);
    expect(messages.at(-1)).toEqual({
      role: 'user',
      content: `<QUESTION>\nAnd the second one?\n</QUESTION>\nAnswer in ${name}, even if earlier messages were in another language.`,
    });
    expect(history[1]?.content).toBe('पहला विकल्प गोवा है। [Page 1]');
  });

  it('maps every supported code used by the chat and falls back safely', () => {
    expect(languageNameFor('en-IN')).toBe('English');
    expect(languageNameFor('ta-IN')).toBe('Tamil');
    expect(languageNameFor('unsupported')).toBe('English');
  });

  it.each([false, true])('annotates stale assistant answers only in the prompt (spoken: %s)', spoken => {
    const history = [
      { role: 'user' as const, content: 'What is the fee?' },
      { role: 'assistant' as const, content: '21,999. [Page 1]', outOfDate: true },
      { role: 'user' as const, content: 'And now?' },
      { role: 'assistant' as const, content: '31,999. [Page 1]' },
    ];
    const input = { documentText: '[Page 1]\nFee: 31,999', question: 'What is the fee?', language: 'ta-IN', spoken };
    const messages = buildDiscussMessages({ ...input, history });
    expect(messages[0]).toEqual(buildDiscussMessages(input)[0]);
    expect(messages.slice(1, -1)).toEqual([
      { role: 'user', content: 'What is the fee?' },
      { role: 'assistant', content: `21,999. [Page 1]\n${OUTDATED_ANSWER_NOTE}` },
      { role: 'user', content: 'And now?' },
      { role: 'assistant', content: '31,999. [Page 1]' },
    ]);
    expect(messages.at(-1)?.content).toBe('<QUESTION>\nWhat is the fee?\n</QUESTION>\n'
      + 'Answer in Tamil, even if earlier messages were in another language.\n' + EDITED_DOCUMENT_RULE);
    expect(history[1]?.content).toBe('21,999. [Page 1]');
    expect(messages.some(message => 'outOfDate' in message)).toBe(false);
  });

  it('adds nothing when no answer is stale, including a stale flag on a user message', () => {
    const input = { documentText: '[Page 1]\nFee: 31,999', question: 'What is the fee?' };
    const plain = [{ role: 'user' as const, content: 'Earlier question' }, { role: 'assistant' as const, content: 'Earlier answer' }];
    expect(buildDiscussMessages({ ...input, history: plain.map(message => ({ ...message, outOfDate: false })) }))
      .toEqual(buildDiscussMessages({ ...input, history: plain }));
    expect(buildDiscussMessages({ ...input, history: [{ role: 'user', content: 'Earlier question', outOfDate: true }] }).at(-1))
      .toEqual(buildDiscussMessages(input).at(-1));
    expect(buildDiscussMessages(input).at(-1)?.content).not.toContain(EDITED_DOCUMENT_RULE);
  });
});
