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

  it('prefers prepared streaming audio and marks it ready on the first chunk', async () => {
    const streamEnded: Array<() => void> = [];
    const stopStream = vi.fn();
    const prepared = {
      ready: Promise.resolve(),
      play: vi.fn(async (onEnded: () => void) => {
        streamEnded.push(onEnded);
        return stopStream;
      }),
      stop: vi.fn(),
    };
    const speak = vi.fn();
    const speakStream = vi.fn(async () => undefined);
    const onReady = vi.fn();
    const queue = createSpeechQueue({
      speak,
      speakStream,
      prepareStream: (startStream) => {
        void startStream(vi.fn(), new AbortController().signal);
        return prepared;
      },
      logTiming: vi.fn(),
    });

    const ticket = queue.enqueueSpeech('Stream me.', 'en-IN', 'stream', onReady);
    await ticket.ready;
    await flush();

    expect(speakStream).toHaveBeenCalledWith(
      { text: 'Stream me.', language: 'en-IN' },
      expect.any(Function),
      expect.any(AbortSignal),
    );
    expect(speak).not.toHaveBeenCalled();
    expect(onReady).toHaveBeenCalledOnce();
    expect(prepared.play).toHaveBeenCalledOnce();

    streamEnded.shift()?.();
    await ticket.done;
  });

  it('stops active progressive playback through the queue-wide stop handle', async () => {
    const stopStream = vi.fn();
    const prepared = {
      ready: Promise.resolve(),
      play: vi.fn(async () => stopStream),
      stop: vi.fn(),
    };
    const queue = createSpeechQueue({
      speakStream: vi.fn(async () => undefined),
      prepareStream: () => prepared,
      logTiming: vi.fn(),
    });

    const ticket = queue.enqueueSpeech('Interrupt me.', 'en-IN');
    await ticket.ready;
    await flush();
    queue.stop();
    await ticket.done;

    expect(stopStream).toHaveBeenCalledOnce();
    expect(prepared.stop).toHaveBeenCalled();
  });

  it('falls back to batch TTS when a stream cannot prepare its first chunk', async () => {
    const streamError = new Error('socket failed');
    const prepared = {
      ready: Promise.reject(streamError),
      play: vi.fn(),
      stop: vi.fn(),
    };
    const endings: Array<() => void> = [];
    const speak = vi.fn(async () => ({
      audio: new Blob(['batch']),
      provider: 'Sarvam',
    }));
    const played: string[] = [];
    const queue = createSpeechQueue({
      speak,
      speakStream: vi.fn(async () => undefined),
      prepareStream: () => prepared,
      playBlob: async (audio, onEnded) => {
        played.push(await audio.text());
        endings.push(onEnded);
        return vi.fn();
      },
      logTiming: vi.fn(),
    });

    const ticket = queue.enqueueSpeech('Fallback.', 'en-IN');
    await ticket.ready;
    await flush();

    expect(prepared.stop).toHaveBeenCalled();
    expect(speak).toHaveBeenCalledWith({ text: 'Fallback.', language: 'en-IN' });
    expect(played).toEqual(['batch']);
    endings.shift()?.();
    await ticket.done;
  });

  it('switches an active failed stream to batch audio in the same queue item', async () => {
    let reportStreamError: ((error: unknown) => void) | undefined;
    const stopStream = vi.fn();
    const prepared = {
      ready: Promise.resolve(),
      play: vi.fn(async (_onEnded: () => void, onError: (error: unknown) => void) => {
        reportStreamError = onError;
        return stopStream;
      }),
      stop: vi.fn(),
    };
    const endings: Array<() => void> = [];
    const speak = vi.fn(async () => ({
      audio: new Blob(['batch recovery']),
      provider: 'Sarvam',
    }));
    const speakBrowser = vi.fn(() => vi.fn());
    const logTiming = vi.fn();
    const played: string[] = [];
    const queue = createSpeechQueue({
      speak,
      speakStream: vi.fn(async () => undefined),
      prepareStream: () => prepared,
      speakBrowser,
      playBlob: async (audio, onEnded) => {
        played.push(await audio.text());
        endings.push(onEnded);
        return vi.fn();
      },
      logTiming,
    });

    const ticket = queue.enqueueSpeech('Recover me.', 'en-IN');
    await ticket.ready;
    await flush();
    reportStreamError?.(new Error('connection dropped'));
    await vi.waitFor(() => expect(played).toEqual(['batch recovery']));

    expect(stopStream).toHaveBeenCalledOnce();
    expect(speak).toHaveBeenCalledWith({ text: 'Recover me.', language: 'en-IN' });
    expect(speakBrowser).not.toHaveBeenCalled();
    expect(logTiming).toHaveBeenCalledWith('[voice] clip via batch Sarvam (attempt 1)');
    endings.shift()?.();
    await ticket.done;
  });

  it('uses browser speech only after streaming and two batch synthesis attempts fail', async () => {
    let reportStreamError: ((error: unknown) => void) | undefined;
    const prepared = {
      ready: Promise.resolve(),
      play: vi.fn(async (_onEnded: () => void, onError: (error: unknown) => void) => {
        reportStreamError = onError;
        return vi.fn();
      }),
      stop: vi.fn(),
    };
    const speak = vi.fn(async () => {
      throw new Error('batch unavailable');
    });
    const speakBrowser = vi.fn((_text, _language, onEnded: () => void) => {
      queueMicrotask(onEnded);
      return vi.fn();
    });
    const logTiming = vi.fn();
    const queue = createSpeechQueue({
      speak,
      speakStream: vi.fn(async () => undefined),
      prepareStream: () => prepared,
      speakBrowser,
      logTiming,
    });

    const ticket = queue.enqueueSpeech('Retry me.', 'en-IN');
    await ticket.ready;
    await flush();
    expect(speakBrowser).not.toHaveBeenCalled();

    reportStreamError?.(new Error('stream unavailable'));
    await ticket.done;

    expect(speak).toHaveBeenCalledTimes(2);
    expect(speak).toHaveBeenNthCalledWith(1, { text: 'Retry me.', language: 'en-IN' });
    expect(speak).toHaveBeenNthCalledWith(2, { text: 'Retry me.', language: 'en-IN' });
    expect(speakBrowser).toHaveBeenCalledOnce();
    expect(logTiming).toHaveBeenCalledWith(
      '[voice] clip via BROWSER speech (Sarvam unavailable)',
    );
  });
});
