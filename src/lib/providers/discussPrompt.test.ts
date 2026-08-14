import { describe, expect, it } from 'vitest';
import {
  buildDiscussMessages,
  languageNameFor,
  NOT_IN_DOCUMENT_MARKER,
} from './discussPrompt';

describe('buildDiscussMessages', () => {
  it('includes the document, question, language name, and grounded + general-knowledge rules', () => {
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
    expect(messages[0]?.content).toContain(NOT_IN_DOCUMENT_MARKER);
    expect(messages[1]?.content).toContain('[Page 1]\nCheck-in is at 3 PM.');
    expect(messages[1]?.content).toContain('What time is check-in?');
  });

  it('maps every supported code used by the chat and falls back safely', () => {
    expect(languageNameFor('en-IN')).toBe('English');
    expect(languageNameFor('ta-IN')).toBe('Tamil');
    expect(languageNameFor('unsupported')).toBe('English');
  });
});
