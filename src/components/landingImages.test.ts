import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const landing = readFileSync(resolve('src/components/Landing.tsx'), 'utf8');
const size = (file: string) => statSync(resolve('public/landing', file)).size;

// The 3 small pictures at the top load straight away, so they use light "-card" copies.
describe('homepage pictures stay light (speed on phones)', () => {
  it('uses the small card copies for the first-screen cards, each under 10 KB', () => {
    for (const card of ['hero-doc-card.webp', 'cube-bot-card.webp', 'cube-text-card.webp']) {
      expect(landing).toContain(`landing/${card}`);
      expect(size(card), card).toBeLessThan(10 * 1024);
    }
  });

  it('keeps the feature pictures (loaded when scrolled to) under 16 KB each', () => {
    for (const feature of ['cube-upload.webp', 'cube-text.webp', 'cube-image.webp', 'cube-bot.webp']) {
      expect(size(feature), feature).toBeLessThan(16 * 1024);
    }
    expect(landing).toMatch(/loading="lazy"/);
  });
});
