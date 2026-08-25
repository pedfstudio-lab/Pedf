import { describe, expect, it } from 'vitest';

import {
  COALESCED_SPEECH_CHUNK_TARGET_CHARS,
  FIRST_SPEECH_CHUNK_MAX_CHARS,
  SECOND_SPEECH_CHUNK_TARGET_CHARS,
  THIRD_SPEECH_CHUNK_TARGET_CHARS,
  chunkSentences,
  coalesceSpeechChunks,
  createSpeechChunkAccumulator,
  createSentenceAccumulator,
  normalizeForSpeech,
  splitFirstSpeechChunk,
} from './sentenceChunking';

describe('chunkSentences', () => {
  it('splits on sentence punctuation and keeps page citations with the prior sentence', () => {
    expect(chunkSentences(
      'Check-in is at 3 p.m. [Page 1] Dinner follows. Is breakfast included? Yes!',
    )).toEqual([
      'Check-in is at 3 p.m. [Page 1]',
      'Dinner follows.',
      'Is breakfast included?',
      'Yes!',
    ]);
  });

  it('does not split common abbreviations, initials, or decimal numbers', () => {
    expect(chunkSentences(
      'Dr. R. K. Rao arrives at 3.30 p.m. tomorrow. Please meet him there.',
    )).toEqual([
      'Dr. R. K. Rao arrives at 3.30 p.m. tomorrow.',
      'Please meet him there.',
    ]);
  });

  it('supports Indic sentence punctuation and empty input', () => {
    expect(chunkSentences('यह पहला वाक्य है। यह दूसरा है!')).toEqual([
      'यह पहला वाक्य है।',
      'यह दूसरा है!',
    ]);
    expect(chunkSentences('   ')).toEqual([]);
  });

  it('releases complete streamed sentences while retaining partial text and abbreviations', () => {
    const accumulator = createSentenceAccumulator();

    expect(accumulator.push('Dr.')).toEqual([]);
    expect(accumulator.push(' Rao arrives tomorrow. The hotel')).toEqual([
      'Dr. Rao arrives tomorrow.',
    ]);
    expect(accumulator.push(' is nearby! Last part')).toEqual([
      'The hotel is nearby!',
    ]);
    expect(accumulator.flush()).toEqual(['Last part']);
  });

  it('preserves spaces that arrive on streaming-delta boundaries', () => {
    const accumulator = createSentenceAccumulator();

    expect(accumulator.push('The team was leading')).toEqual([]);
    expect(accumulator.push(' ')).toEqual([]);
    expect(accumulator.push('80+ trips and managing')).toEqual([]);
    expect(accumulator.push(' ')).toEqual([]);
    expect(accumulator.push('5 projects.')).toEqual([
      'The team was leading 80+ trips and managing 5 projects.',
    ]);
  });

  it('keeps company abbreviations together and normalizes joined names for speech', () => {
    expect(chunkSentences(
      "Worked at Wanderon. PVT.LTD from Jun'22, leading 80+ trips. Pvt. Ltd. grew quickly.",
    )).toEqual([
      'Worked at Wanderon.',
      "PVT.LTD from Jun'22, leading 80+ trips.",
      'Pvt. Ltd. grew quickly.',
    ]);
    expect(normalizeForSpeech('Wanderon PVT.LTD from June')).toBe(
      'Wanderon Pvt Ltd from June',
    );
  });

  it('title-cases multiword caps names for speech but leaves real lone acronyms alone', () => {
    expect(normalizeForSpeech('She completed an MBA at LLOYD BUSINESS SCHOOL.')).toBe(
      'She completed an MBA at Lloyd Business School.',
    );
    expect(normalizeForSpeech('Her HR course was at IITTM.')).toBe(
      'Her HR course was at IITTM.',
    );
  });

  it('speaks abbreviated résumé months and apostrophe years in full', () => {
    expect(normalizeForSpeech("Jun'22 to Oct'25")).toBe(
      'June 2022 to October 2025',
    );
    expect(normalizeForSpeech("May '26")).toBe('May 2026');
    expect(normalizeForSpeech("Jan.’25 and Feb. '24")).toBe(
      'January 2025 and February 2024',
    );
  });

  it('speaks full year ranges without changing unrelated month-like words', () => {
    expect(normalizeForSpeech('(2020-2023)')).toBe('2020 to 2023');
    expect(normalizeForSpeech('2019–2021')).toBe('2019 to 2021');
    expect(normalizeForSpeech('Marketing, Marched, and Jan Smith')).toBe(
      'Marketing, Marched, and Jan Smith',
    );
  });

  it('makes a long first sentence start with a short natural clause', () => {
    const sentence = 'Your hotel check-in begins at three o’clock, and the reception team will have your room ready when you arrive.';
    const chunks = splitFirstSpeechChunk(sentence);

    expect(chunks).toEqual([
      'Your hotel check-in begins at three o’clock,',
      'and the reception team will have your room ready when you arrive.',
    ]);
    expect(chunks[0]?.length).toBeLessThanOrEqual(FIRST_SPEECH_CHUNK_MAX_CHARS);
  });

  it('falls back to a word boundary and leaves short first sentences unchanged', () => {
    const long = 'This deliberately long answer has no convenient clause punctuation before the configured first speech limit and must still start quickly.';
    const chunks = splitFirstSpeechChunk(long);

    expect(chunks[0]?.length).toBeLessThanOrEqual(FIRST_SPEECH_CHUNK_MAX_CHARS);
    expect(chunks.join(' ')).toBe(long);
    expect(splitFirstSpeechChunk('Check-in is at 3 PM.')).toEqual(['Check-in is at 3 PM.']);
  });

  it('does not strand a trivial proper-name tail in a separate first clip', () => {
    const sentence = 'He did his BBA at Indian Institute Of Tourism and Travel Management.';

    expect(splitFirstSpeechChunk(sentence)).toEqual([sentence]);
  });

  it('uses the last qualifying clause boundary within the first-clip limit', () => {
    const sentence = 'उनके पास Travel Operations, Group Tours, Vendor Management, Travel Logistics, Customer Service की विशेषज्ञता है।';
    const chunks = splitFirstSpeechChunk(sentence);

    expect(chunks[0]).toBe(
      'उनके पास Travel Operations, Group Tours, Vendor Management,',
    );
    expect(chunks[0]?.length).toBeLessThanOrEqual(FIRST_SPEECH_CHUNK_MAX_CHARS);
    expect(chunks[0]).not.toBe('उनके पास Travel Operations,');
    expect(chunks.join(' ')).toBe(sentence);
  });

  it('keeps the first pieces fast and coalesces later sentences near the target', () => {
    const first = 'The first clause starts quickly, while its remainder stays as the second fast clip for playback.';
    const later = [
      'The third sentence contains enough useful detail to begin the buffered portion.',
      'The fourth sentence continues that explanation without creating another tiny request.',
    ];
    const chunks = coalesceSpeechChunks([first, ...later]);

    expect(chunks).toHaveLength(3);
    expect(chunks[0]?.length).toBeLessThanOrEqual(FIRST_SPEECH_CHUNK_MAX_CHARS);
    expect(chunks[1]).toBe('while its remainder stays as the second fast clip for playback.');
    expect(chunks[2]).toBe(later.join(' '));
    expect(chunks[2]?.length).toBeGreaterThanOrEqual(COALESCED_SPEECH_CHUNK_TARGET_CHARS);
  });

  it('holds streamed later sentences until the target and flushes the final remainder', () => {
    const accumulator = createSpeechChunkAccumulator(100);

    expect(accumulator.push('A short first answer.')).toEqual(['A short first answer.']);
    expect(accumulator.push('The second sentence waits in the background.')).toEqual([]);
    expect(accumulator.push('The third sentence joins it to make one longer TTS request.')).toEqual([
      'The second sentence waits in the background. The third sentence joins it to make one longer TTS request.',
    ]);
    expect(accumulator.push('A final remainder is retained.')).toEqual([]);
    expect(accumulator.flush()).toEqual(['A final remainder is retained.']);
    expect(accumulator.flush()).toEqual([]);
  });

  it('ramps early streamed targets so a substantial second sentence ships immediately', () => {
    const accumulator = createSpeechChunkAccumulator();
    const first = 'इससे पहले उन्होंने Wanderon.';
    const second = `${'B'.repeat(117)}.`;
    const third = `${'C'.repeat(76)}.`;

    expect(first.length).toBeLessThan(SECOND_SPEECH_CHUNK_TARGET_CHARS);
    expect(second.length).toBeGreaterThanOrEqual(SECOND_SPEECH_CHUNK_TARGET_CHARS);
    expect(second.length).toBeLessThan(COALESCED_SPEECH_CHUNK_TARGET_CHARS);
    expect(accumulator.push(first)).toEqual([first]);
    expect(accumulator.push(second)).toEqual([second]);
    expect(third.length).toBeLessThan(THIRD_SPEECH_CHUNK_TARGET_CHARS);
    expect(accumulator.push(third)).toEqual([]);
    expect(accumulator.flush()).toEqual([third]);
  });
});
