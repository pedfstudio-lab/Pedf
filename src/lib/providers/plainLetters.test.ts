import { describe, expect, it } from 'vitest';
import { toPlainLetters } from './plainLetters';

describe('look-alike maths letters → plain letters (copy sent to Sarvam only)', () => {
  it('turns the NMAT page 21 formulas into ordinary words, keeping the maths symbols', () => {
    expect(toPlainLetters('𝐸𝑛𝑔𝑖𝑛𝑒𝑒𝑟𝑠 ⊂ 𝐺𝑟𝑎𝑑𝑢𝑎𝑡𝑒𝑠')).toBe('Engineers ⊂ Graduates');
    // ℎ (U+210E) is the maths-italic h; it lives outside the main maths-letter block.
    expect(toPlainLetters('𝐺𝑟𝑎𝑑𝑢𝑎𝑡𝑒𝑠 ∩ 𝐴𝑡ℎ𝑙𝑒𝑡𝑒𝑠 = ∅')).toBe('Graduates ∩ Athletes = ∅');
    expect(toPlainLetters('𝑀𝑎𝑛𝑎𝑔𝑒𝑟𝑠 → 𝐺𝑟𝑎𝑑𝑢𝑎𝑡𝑒𝑠')).toBe('Managers → Graduates');
  });

  it('covers bold, script, fraktur, double-struck and digit styles', () => {
    expect(toPlainLetters('𝐁𝐨𝐥𝐝 𝒮𝒸𝓇𝒾𝓅𝓉 ℬ 𝔉𝔯𝔞𝔨 ℭ 𝔻𝕠𝕦𝕓𝕝𝕖 ℝ ℕ 𝟏𝟐𝟑')).toBe('Bold Script B Frak C Double R N 123');
  });

  it('leaves everything else exactly as it is', () => {
    const untouched = 'नमस्ते, சோதனை — ﬁ x² ½ ⊂ ∩ ∅ → ≤ ℃ № Café [Page 21]';
    expect(toPlainLetters(untouched)).toBe(untouched);
    const plain = 'Check-in is at 3 PM.';
    expect(toPlainLetters(plain)).toBe(plain);
  });
});
