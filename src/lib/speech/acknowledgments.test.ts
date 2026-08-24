import { describe, expect, it, vi } from 'vitest';

import {
  ACKNOWLEDGMENT_DELAY_MS,
  ACKNOWLEDGMENT_PHRASES,
  BRIDGING_GAP_MS,
  BRIDGING_INITIAL_DELAY_MS,
  BRIDGING_PHRASES,
  MAX_BRIDGING_FILLERS,
  createAcknowledgmentManager,
  waitForAcknowledgmentDelay,
  waitForBridgingGap,
  waitForBridgingInitialDelay,
} from './acknowledgments';

describe('acknowledgments', () => {
  it('waits for the configured natural beat before acknowledgment playback', async () => {
    vi.useFakeTimers();
    try {
      let finished = false;
      const waiting = waitForAcknowledgmentDelay().then(() => {
        finished = true;
      });

      expect(ACKNOWLEDGMENT_DELAY_MS).toBeGreaterThanOrEqual(500);
      expect(ACKNOWLEDGMENT_DELAY_MS).toBeLessThanOrEqual(1000);
      await vi.advanceTimersByTimeAsync(ACKNOWLEDGMENT_DELAY_MS - 1);
      expect(finished).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await waiting;
      expect(finished).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('uses a tunable natural gap between bridge clips', async () => {
    vi.useFakeTimers();
    try {
      let finished = false;
      const waiting = waitForBridgingGap().then(() => {
        finished = true;
      });

      expect(BRIDGING_GAP_MS).toBeGreaterThanOrEqual(1000);
      expect(BRIDGING_GAP_MS).toBeLessThanOrEqual(1500);
      await vi.advanceTimersByTimeAsync(BRIDGING_GAP_MS - 1);
      expect(finished).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await waiting;
      expect(finished).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('waits before the first bridge and caps the fallback count', async () => {
    vi.useFakeTimers();
    try {
      let finished = false;
      const waiting = waitForBridgingInitialDelay().then(() => {
        finished = true;
      });

      expect(BRIDGING_INITIAL_DELAY_MS).toBe(1500);
      expect(MAX_BRIDGING_FILLERS).toBeGreaterThanOrEqual(1);
      expect(MAX_BRIDGING_FILLERS).toBeLessThanOrEqual(2);
      await vi.advanceTimersByTimeAsync(BRIDGING_INITIAL_DELAY_MS - 1);
      expect(finished).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await waiting;
      expect(finished).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('returns null before preload and caches each language only once', async () => {
    const speak = vi.fn(async ({ text }: { readonly text: string; readonly language: string }) => ({
      audio: new Blob([text], { type: 'audio/wav' }),
      provider: 'test',
    }));
    const manager = createAcknowledgmentManager(speak, () => 0);

    expect(manager.take('en-IN')).toBeNull();
    await Promise.all([
      manager.preload('en-IN'),
      manager.preload('en-IN'),
    ]);
    await manager.preload('en-IN');

    expect(speak).toHaveBeenCalledTimes(
      ACKNOWLEDGMENT_PHRASES['en-IN'].length + BRIDGING_PHRASES['en-IN'].length,
    );
    expect(speak).toHaveBeenCalledWith(expect.objectContaining({ language: 'en-IN' }));

    await manager.preload('hi-IN');
    expect(speak).toHaveBeenCalledTimes(
      ACKNOWLEDGMENT_PHRASES['en-IN'].length
      + BRIDGING_PHRASES['en-IN'].length
      + ACKNOWLEDGMENT_PHRASES['hi-IN'].length
      + BRIDGING_PHRASES['hi-IN'].length,
    );
    expect(speak).toHaveBeenCalledWith(expect.objectContaining({ language: 'hi-IN' }));
  });

  it('rotates cached clips instead of repeating the previous acknowledgment', async () => {
    const speak = vi.fn(async ({ text }: { readonly text: string; readonly language: string }) => ({
      audio: new Blob([text], { type: 'audio/wav' }),
      provider: 'test',
    }));
    const manager = createAcknowledgmentManager(speak, () => 0);
    await manager.preload('en-IN');

    const clips = [
      manager.take('en-IN'),
      manager.take('en-IN'),
      manager.take('en-IN'),
    ];
    expect(clips.every((clip) => clip instanceof Blob)).toBe(true);
    await expect(Promise.all(clips.map((clip) => clip?.text()))).resolves.toEqual(
      ACKNOWLEDGMENT_PHRASES['en-IN'],
    );

    const bridges = BRIDGING_PHRASES['en-IN'].map(() => manager.takeBridge('en-IN'));
    await expect(Promise.all(bridges.map((clip) => clip?.text()))).resolves.toEqual(
      BRIDGING_PHRASES['en-IN'],
    );
  });
});
