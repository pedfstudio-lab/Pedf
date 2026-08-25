import { describe, expect, it } from 'vitest';
import { classifyQuestion } from './classifyQuestion';

describe('classifyQuestion', () => {
  it.each([
    'Hi',
    'Hello there!',
    'Good morning',
    'Thanks so much.',
    'Bye',
    'नमस्ते।',
    'வணக்கம்',
  ])('treats greeting or sign-off %j as conversational', (question) => {
    expect(classifyQuestion(question)).toBe('conversational');
  });

  it.each([
    'How are you?',
    'Hey how are you',
    'How you doing',
    'How are you buddy',
    "How's it going?",
    'Who are you?',
    'Are you an AI?',
    'What do you think?',
    'What do you think about this?',
    'So what do you think about him',
    'Do you like it?',
  ])('treats small-talk or opinion %j as conversational', (question) => {
    expect(classifyQuestion(question)).toBe('conversational');
  });

  it.each([
    'What are the travel dates?',
    'Who is Rahul Rajput?',
    'Summarize the experience section.',
    'Hi, what time is check-in?',
    'What does the document say about accommodation?',
    '',
  ])('keeps document-style question %j on the lookup path', (question) => {
    expect(classifyQuestion(question)).toBe('document');
  });
});
