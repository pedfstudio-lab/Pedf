import { describe, expect, it, vi } from 'vitest';
import { NOTHING_TO_UNLOCK, run, unlockTool } from './unlock';

const unlockedFiles = vi.hoisted(() => new WeakSet<File>());
vi.mock('@/lib/pdf/protection', () => ({ wasUnlocked: (file: File) => unlockedFiles.has(file) }));

const context = () => ({ signal: new AbortController().signal, onProgress: vi.fn() });
const pdf = (name: string, text = '%PDF-1.7 unlocked') => new File([text], name, { type: 'application/pdf' });

describe('Unlock PDF tool', () => {
  it('hands back the copy the tool page already unlocked, named -unlocked', async () => {
    const file = pdf('e-Aadhaar.pdf');
    unlockedFiles.add(file);
    const [output] = await run([file], {}, context());
    expect(output!.name).toBe('e-Aadhaar-unlocked.pdf');
    expect(new TextDecoder().decode(output!.bytes)).toBe('%PDF-1.7 unlocked');
    expect(output!.note?.text).toContain('opens without a password');
  });

  it('explains that an ordinary PDF has nothing to unlock', async () => {
    await expect(run([pdf('plain.pdf')], {}, context())).rejects.toThrow(NOTHING_TO_UNLOCK);
  });

  it('is a one-PDF tool listed as Unlock PDF', () => {
    expect(unlockTool).toMatchObject({ slug: 'unlock', title: 'Unlock PDF', accepts: 'pdf', multiple: false });
  });
});
