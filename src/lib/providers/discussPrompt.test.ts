import { describe, expect, it } from 'vitest';
import {
  buildDiscussMessages,
  languageNameFor,
  NOT_IN_DOCUMENT_MARKER,
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
      '<QUESTION>\nHow is the weather there then?\n</QUESTION>',
    );
  });

  it('maps every supported code used by the chat and falls back safely', () => {
    expect(languageNameFor('en-IN')).toBe('English');
    expect(languageNameFor('ta-IN')).toBe('Tamil');
    expect(languageNameFor('unsupported')).toBe('English');
  });
});
