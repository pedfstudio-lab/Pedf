import { describe, expect, it, vi } from 'vitest';
import type { TextRun } from '@/lib/pdf/textContent';
import type { ChatMessage } from '@/lib/providers/types';
import { detectLocationsWithProvider, mapLocationAnswerToRuns } from './locationDetect';

function run(text: string, x: number, pageIndex = 0): TextRun {
  return {
    pageIndex,
    text,
    rect: { x, y: 700, w: text.length * 5, h: 10 },
    style: {
      fontName: 'Helvetica',
      fontSizePt: 10,
      bold: false,
      italic: false,
      color: { r: 0, g: 0, b: 0 },
    },
  };
}

describe('mapLocationAnswerToRuns', () => {
  it('maps an exact multi-run location to the union of its run geometry', () => {
    const locations = mapLocationAnswerToRuns(
      '["Mount Batur", "Bali"]',
      [run('Visit Mount', 10), run('Batur in Bali', 70)],
    );

    expect(locations.map((location) => location.text)).toEqual(['Mount Batur', 'Bali']);
    expect(locations[0]).toMatchObject({
      kind: 'location',
      pageIndex: 0,
      rect: { x: 40, y: 700, h: 10 },
    });
    expect(locations[0]?.rect.w).toBeGreaterThan(50);
  });

  it('drops returned strings that are not found verbatim', () => {
    expect(mapLocationAnswerToRuns(
      '["Mumbai", "New Delhi"]',
      [run('The office is in Mumbai.', 10)],
    ).map((location) => location.text)).toEqual(['Mumbai']);
  });

  it('filters ordinary words, organizations, events, and obvious person names', () => {
    const answer = '```json\n["Goa", "activity", "Cadbury", "Utkal University", "Tech Summit", "Suratha Kumar Das"]\n```';
    const locations = mapLocationAnswerToRuns(answer, [
      run('Goa activity Cadbury Committee Utkal University Tech Summit Dr. Suratha Kumar Das', 10),
    ]);

    expect(locations.map((location) => location.text)).toEqual(['Goa']);
  });

  it('does not match a location name inside a longer word', () => {
    expect(mapLocationAnswerToRuns('["Goa"]', [run('Goat Island', 10)])).toEqual([]);
  });
});

describe('detectLocationsWithProvider', () => {
  it('uses raw system and user messages instead of the conversational discuss wrapper', async () => {
    const complete = vi.fn(async (messages: readonly ChatMessage[]) => {
      void messages;
      return { text: '["Goa"]', provider: 'test' };
    });

    await expect(detectLocationsWithProvider(
      'A trip through Goa.',
      [run('A trip through Goa.', 10)],
      { complete },
    )).resolves.toMatchObject([{ text: 'Goa', kind: 'location' }]);

    expect(complete).toHaveBeenCalledOnce();
    const messages = complete.mock.calls[0]?.[0];
    expect(messages).toHaveLength(2);
    expect(messages?.[0]).toMatchObject({ role: 'system' });
    expect(messages?.[0]?.content).toContain('precise information extractor');
    expect(messages?.[0]?.content).toContain('JSON array');
    expect(messages?.[0]?.content).not.toContain('warm, easygoing companion');
    expect(messages?.[1]).toEqual({ role: 'user', content: 'A trip through Goa.' });
    expect(messages?.[1]?.content).not.toContain('[Page');
  });
});
