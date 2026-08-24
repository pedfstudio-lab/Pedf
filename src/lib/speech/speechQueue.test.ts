import { describe, expect, it, vi } from 'vitest';

import { createSpeechQueue } from './speechQueue';

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('speechQueue', () => {
  it('plays enqueued clips in order', async () => {
    const played: string[] = [];
    const endings: Array<() => void> = [];
    const queue = createSpeechQueue({
      playBlob: async (blob, onEnded) => {
        played.push(await blob.text());
        endings.push(onEnded);
        return vi.fn();
      },
    });

    const first = queue.enqueue(new Blob(['first']));
    const second = queue.enqueue(new Blob(['second']));
    await flush();
    expect(played).toEqual(['first']);

    endings.shift()?.();
    await first.done;
    await flush();
    expect(played).toEqual(['first', 'second']);

    endings.shift()?.();
    await second.done;
  });

  it('starts sentence TTS in parallel but preserves sentence playback order', async () => {
    const resolvers: Array<(value: { audio: Blob; provider: string }) => void> = [];
    const speak = vi.fn(() => new Promise<{ audio: Blob; provider: string }>((resolve) => {
      resolvers.push(resolve);
    }));
    const played: string[] = [];
    const endings: Array<() => void> = [];
    const queue = createSpeechQueue({
      speak,
      playBlob: async (blob, onEnded) => {
        played.push(await blob.text());
        endings.push(onEnded);
        return vi.fn();
      },
      logTiming: vi.fn(),
    });

    const first = queue.enqueueSpeech('First.', 'en-IN');
    const second = queue.enqueueSpeech('Second.', 'en-IN');
    expect(speak).toHaveBeenCalledTimes(2);

    resolvers[1]?.({ audio: new Blob(['second']), provider: 'test' });
    await flush();
    expect(played).toEqual([]);

    resolvers[0]?.({ audio: new Blob(['first']), provider: 'test' });
    await first.ready;
    await second.ready;
    await flush();
    expect(played).toEqual(['first']);

    endings.shift()?.();
    await first.done;
    await flush();
    expect(played).toEqual(['first', 'second']);
    endings.shift()?.();
    await second.done;
  });

  it('lets a ready bridge play while the first answer sentence is still pending', async () => {
    let resolveAnswer: ((value: { audio: Blob; provider: string }) => void) | undefined;
    const played: string[] = [];
    const endings: Array<() => void> = [];
    const queue = createSpeechQueue({
      speak: () => new Promise((resolve) => {
        resolveAnswer = resolve;
      }),
      playBlob: async (blob, onEnded) => {
        played.push(await blob.text());
        endings.push(onEnded);
        return vi.fn();
      },
      logTiming: vi.fn(),
    });

    const acknowledgment = queue.enqueue(new Blob(['ack']));
    const answer = queue.enqueueSpeech('Answer.', 'en-IN');
    await flush();
    expect(played).toEqual(['ack']);

    endings.shift()?.();
    await acknowledgment.done;
    const bridge = queue.enqueue(new Blob(['bridge']));
    await flush();
    expect(played).toEqual(['ack', 'bridge']);

    resolveAnswer?.({ audio: new Blob(['answer']), provider: 'test' });
    await answer.ready;
    endings.shift()?.();
    await bridge.done;
    await flush();
    expect(played).toEqual(['ack', 'bridge', 'answer']);
    endings.shift()?.();
    await answer.done;
  });

  it('stop clears pending clips and halts the active one', async () => {
    const stopAudio = vi.fn();
    const played: string[] = [];
    const queue = createSpeechQueue({
      playBlob: async (blob) => {
        played.push(await blob.text());
        return stopAudio;
      },
    });

    const first = queue.enqueue(new Blob(['first']));
    const second = queue.enqueue(new Blob(['second']));
    await flush();
    queue.stop();

    await Promise.all([first.done, second.done]);
    expect(stopAudio).toHaveBeenCalledOnce();
    expect(played).toEqual(['first']);
  });

  it('can skip one filler without clearing the answer behind it', async () => {
    const stops: Array<ReturnType<typeof vi.fn>> = [];
    const played: string[] = [];
    const endings: Array<() => void> = [];
    const queue = createSpeechQueue({
      playBlob: async (blob, onEnded) => {
        played.push(await blob.text());
        endings.push(onEnded);
        const stop = vi.fn();
        stops.push(stop);
        return stop;
      },
    });

    const filler = queue.enqueue(new Blob(['filler']));
    const answer = queue.enqueue(new Blob(['answer']));
    await flush();
    queue.skipCurrent();
    await filler.done;
    await flush();

    expect(stops[0]).toHaveBeenCalledOnce();
    expect(played).toEqual(['filler', 'answer']);
    endings[1]?.();
    await answer.done;
  });

  it('interrupts the active filler synchronously when answer TTS becomes ready', async () => {
    let resolveAnswer: ((value: { audio: Blob; provider: string }) => void) | undefined;
    const stopFiller = vi.fn();
    const played: string[] = [];
    const endings: Array<() => void> = [];
    const queue = createSpeechQueue({
      speak: () => new Promise((resolve) => {
        resolveAnswer = resolve;
      }),
      playBlob: async (blob, onEnded) => {
        const text = await blob.text();
        played.push(text);
        endings.push(onEnded);
        return text === 'filler' ? stopFiller : vi.fn();
      },
      logTiming: vi.fn(),
    });

    const filler = queue.enqueue(new Blob(['filler']));
    const answer = queue.enqueueSpeech('Answer.', 'en-IN', 'answer', () => {
      queue.skipCurrent();
    });
    await flush();
    expect(played).toEqual(['filler']);

    resolveAnswer?.({ audio: new Blob(['answer']), provider: 'test' });
    await answer.ready;
    await filler.done;
    await flush();
    expect(stopFiller).toHaveBeenCalledOnce();
    expect(played).toEqual(['filler', 'answer']);

    endings[1]?.();
    await answer.done;
  });
});
