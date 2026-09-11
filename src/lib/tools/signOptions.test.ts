import { describe, expect, it } from 'vitest';
import { DEFAULT_SIGN_OPTIONS, formatSignDate, parseSignOptions, signatureLimits, signatureRect, signProblem } from './signOptions';

describe('Sign PDF options', () => {
  const signature = { png: new Uint8Array([1, 2, 3]), width: 400, height: 120 };

  it('parses safe defaults and requires a signature', () => {
    expect(parseSignOptions({})).toEqual(DEFAULT_SIGN_OPTIONS);
    expect(signProblem({})).toBe('Make or pick a signature first.');
    expect(signProblem({ ...DEFAULT_SIGN_OPTIONS, signature })).toBeUndefined();
  });

  it('formats both local date styles', () => {
    const date = new Date(2026, 8, 11, 12);
    expect(formatSignDate('none', date)).toBe('');
    expect(formatSignDate('text', date)).toBe('11 Sep 2026');
    expect(formatSignDate('numeric', date)).toBe('11/09/2026');
  });

  it('turns shares into a reader-space rectangle and clamps it inside the page', () => {
    const centre = signatureRect(600, 800, { ...DEFAULT_SIGN_OPTIONS, signature, x: 0.5, y: 0.5, widthShare: 0.25 }, 4);
    expect(centre).toMatchObject({ u: 225, v: 381.25, width: 150, height: 37.5, centreX: 0.5, centreYFromTop: 0.5 });
    const edge = signatureRect(600, 800, { ...DEFAULT_SIGN_OPTIONS, signature, x: 1, y: 1, widthShare: 0.5 }, 2);
    expect(edge.u + edge.width).toBeCloseTo(600);
    expect(edge.v).toBeCloseTo(0);
    expect(edge.centreX).toBeCloseTo(0.75);
  });

  it('shrinks very tall signatures to stay inside the displayed frame', () => {
    const rect = signatureRect(300, 200, { ...DEFAULT_SIGN_OPTIONS, signature, widthShare: 1 }, 0.25);
    expect(rect.height).toBe(200);
    expect(rect.width).toBe(50);
  });

  it('reserves room below the signature when a date is enabled', () => {
    const dated = { ...DEFAULT_SIGN_OPTIONS, signature, date: 'text' as const, y: 1 };
    const datedRect = signatureRect(600, 800, dated, 2);
    expect(datedRect.v).toBeGreaterThanOrEqual(16);
    expect(datedRect.v - 13).toBeGreaterThanOrEqual(3);
    expect(signatureLimits(600, 800, dated, 2).maxY).toBeCloseTo(datedRect.centreYFromTop);

    const undatedRect = signatureRect(600, 800, { ...dated, date: 'none' }, 2);
    expect(undatedRect.v).toBeCloseTo(0);
  });
});
