import type { TranscribeStreamSession } from '@/lib/providers/types';

export interface RecordedQuestion {
  /** Browser-encoded audio retained for the batch STT fallback. */
  readonly audio: Blob;
  /** Present only when the realtime session returned a usable final transcript. */
  readonly streamingTranscript?: string;
}

export interface Recording {
  stop(): Promise<RecordedQuestion>;
  cancel(): void;
}

export interface PcmCapture {
  stop(): Promise<void>;
}

export interface RecordingOptions {
  readonly startTranscription?: () => TranscribeStreamSession;
  readonly createPcmCapture?: PcmCaptureFactory;
}

export type PcmCaptureFactory = (
  stream: MediaStream,
  onAudio: (audio: Uint8Array<ArrayBuffer>) => void,
) => Promise<PcmCapture>;

const PREFERRED_MIME_TYPE = 'audio/webm;codecs=opus';
const FALLBACK_MIME_TYPE = 'audio/webm';
const REALTIME_SAMPLE_RATE = 16_000;
const REALTIME_CHUNK_BYTES = 3_200; // 100 ms of 16 kHz, mono, signed 16-bit PCM.
const WORKLET_NAME = 'desipdf-pcm-capture';
const WORKLET_SOURCE = `
class DesiPdfPcmCapture extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (channel && channel.length > 0) this.port.postMessage(channel.slice());
    return true;
  }
}
registerProcessor('${WORKLET_NAME}', DesiPdfPcmCapture);
`;

/** Return the base container MIME type accepted by speech-to-text APIs. */
export function baseMimeType(rawType: string): string {
  const [baseType] = rawType.split(';');
  return baseType?.trim() || FALLBACK_MIME_TYPE;
}

/** Encode normalised Web Audio samples as little-endian signed PCM16. */
export function floatSamplesToPcm16(
  samples: Float32Array<ArrayBufferLike>,
): Uint8Array<ArrayBuffer> {
  const output = new Uint8Array(new ArrayBuffer(samples.length * 2));
  const view = new DataView(output.buffer);
  for (let index = 0; index < samples.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, samples[index] ?? 0));
    const signed = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
    view.setInt16(index * 2, Math.round(signed), true);
  }
  return output;
}

function appendFloats(
  left: Float32Array<ArrayBufferLike>,
  right: Float32Array<ArrayBufferLike>,
): Float32Array<ArrayBuffer> {
  const combined = new Float32Array(left.length + right.length);
  combined.set(left);
  combined.set(right, left.length);
  return combined;
}

function createPcmEncoder(sourceRate: number, targetRate: number) {
  const step = sourceRate / targetRate;
  let buffered: Float32Array<ArrayBufferLike> = new Float32Array(0);
  let position = 0;

  const encode = (input: Float32Array<ArrayBufferLike>): Uint8Array<ArrayBuffer> => {
    buffered = appendFloats(buffered, input);
    const output: number[] = [];
    while (position + 1 < buffered.length) {
      const leftIndex = Math.floor(position);
      const fraction = position - leftIndex;
      const left = buffered[leftIndex] ?? 0;
      const right = buffered[leftIndex + 1] ?? left;
      output.push(left + ((right - left) * fraction));
      position += step;
    }
    const consumed = Math.floor(position);
    if (consumed > 0) {
      buffered = buffered.slice(consumed);
      position -= consumed;
    }
    return floatSamplesToPcm16(Float32Array.from(output));
  };

  const flush = (): Uint8Array<ArrayBuffer> => {
    if (buffered.length === 0) return new Uint8Array(new ArrayBuffer(0));
    const remaining = floatSamplesToPcm16(buffered);
    buffered = new Float32Array(0);
    position = 0;
    return remaining;
  };

  return { encode, flush };
}

function appendBytes(left: Uint8Array<ArrayBuffer>, right: Uint8Array<ArrayBuffer>) {
  const combined = new Uint8Array(new ArrayBuffer(left.byteLength + right.byteLength));
  combined.set(left);
  combined.set(right, left.byteLength);
  return combined;
}

/** Capture microphone frames as 16 kHz mono PCM for Saaras realtime STT. */
export const createRealtimePcmCapture: PcmCaptureFactory = async (stream, onAudio) => {
  if (typeof AudioContext === 'undefined' || typeof AudioWorkletNode === 'undefined') {
    throw new Error('AudioWorklet is unavailable.');
  }

  const context = new AudioContext({ sampleRate: REALTIME_SAMPLE_RATE });
  let source: MediaStreamAudioSourceNode | undefined;
  let worklet: AudioWorkletNode | undefined;
  let mute: GainNode | undefined;
  let moduleUrl: string | undefined;
  let stopped = false;
  const encoder = createPcmEncoder(context.sampleRate, REALTIME_SAMPLE_RATE);
  let pending = new Uint8Array(new ArrayBuffer(0));

  const emit = (bytes: Uint8Array<ArrayBuffer>, flush = false) => {
    if (bytes.byteLength > 0) pending = appendBytes(pending, bytes);
    while (pending.byteLength >= REALTIME_CHUNK_BYTES) {
      onAudio(pending.slice(0, REALTIME_CHUNK_BYTES));
      pending = pending.slice(REALTIME_CHUNK_BYTES);
    }
    if (flush && pending.byteLength > 0) {
      onAudio(pending);
      pending = new Uint8Array(new ArrayBuffer(0));
    }
  };

  const closeContext = async () => {
    worklet?.disconnect();
    source?.disconnect();
    mute?.disconnect();
    if (worklet) worklet.port.onmessage = null;
    if (context.state !== 'closed') await context.close();
  };

  try {
    moduleUrl = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: 'text/javascript' }));
    await context.audioWorklet.addModule(moduleUrl);
    source = context.createMediaStreamSource(stream);
    worklet = new AudioWorkletNode(context, WORKLET_NAME, {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
    });
    mute = context.createGain();
    mute.gain.value = 0;
    worklet.port.onmessage = (event: MessageEvent<unknown>) => {
      if (stopped || !(event.data instanceof Float32Array)) return;
      emit(encoder.encode(event.data));
    };
    source.connect(worklet);
    worklet.connect(mute);
    mute.connect(context.destination);
    await context.resume();
  } catch (error) {
    await closeContext();
    throw error;
  } finally {
    if (moduleUrl) URL.revokeObjectURL(moduleUrl);
  }

  return {
    stop: async () => {
      if (stopped) return;
      stopped = true;
      worklet?.disconnect();
      source?.disconnect();
      emit(encoder.flush(), true);
      await closeContext();
    },
  };
};

function releaseStream(stream: MediaStream): void {
  for (const track of stream.getTracks()) track.stop();
}

/** Capture one microphone question, retaining batch audio as realtime fallback. */
export async function startRecording(options: RecordingOptions = {}): Promise<Recording> {
  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
    throw new Error('Microphone recording is not supported in this browser.');
  }

  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  let recorder: MediaRecorder;
  try {
    const supportsPreferred = typeof MediaRecorder.isTypeSupported === 'function'
      && MediaRecorder.isTypeSupported(PREFERRED_MIME_TYPE);
    recorder = supportsPreferred
      ? new MediaRecorder(stream, { mimeType: PREFERRED_MIME_TYPE })
      : new MediaRecorder(stream);
  } catch (error) {
    releaseStream(stream);
    throw error;
  }

  const chunks: Blob[] = [];
  let cancelled = false;
  let released = false;
  let stopPromise: Promise<RecordedQuestion> | null = null;
  let realtimeSession: TranscribeStreamSession | undefined;
  let pcmCapture: PcmCapture | undefined;
  const release = () => {
    if (released) return;
    released = true;
    releaseStream(stream);
  };

  recorder.addEventListener('dataavailable', (event) => {
    if (!cancelled && event.data.size > 0) chunks.push(event.data);
  });
  try {
    recorder.start();
  } catch (error) {
    release();
    throw error;
  }

  if (options.startTranscription) {
    try {
      realtimeSession = options.startTranscription();
      pcmCapture = await (options.createPcmCapture ?? createRealtimePcmCapture)(
        stream,
        (audio) => realtimeSession?.pushAudio(audio),
      );
    } catch (error) {
      realtimeSession?.cancel();
      realtimeSession = undefined;
      console.info('[voice timing] realtime STT unavailable; retaining batch fallback.', error);
    }
  }

  const stopRecorder = () => new Promise<Blob>((resolve, reject) => {
    recorder.addEventListener('stop', () => {
      release();
      const audio = new Blob(chunks, {
        type: baseMimeType(recorder.mimeType || FALLBACK_MIME_TYPE),
      });
      if (audio.size === 0) {
        reject(new Error('Recording is empty.'));
        return;
      }
      resolve(audio);
    }, { once: true });
    recorder.addEventListener('error', () => {
      release();
      reject(new Error('Microphone recording failed.'));
    }, { once: true });
    if (recorder.state === 'inactive') {
      release();
      reject(new Error('Microphone recording stopped unexpectedly.'));
      return;
    }
    try {
      recorder.stop();
    } catch (error) {
      release();
      reject(error);
    }
  });

  const finishRealtime = async (): Promise<string | undefined> => {
    if (!realtimeSession || !pcmCapture) return undefined;
    try {
      await pcmCapture.stop();
      const result = await realtimeSession.finish();
      return result.text.trim() || undefined;
    } catch (error) {
      realtimeSession.cancel();
      console.info('[voice timing] realtime STT failed; using batch fallback.', error);
      return undefined;
    }
  };

  return {
    stop: () => {
      if (cancelled) return Promise.reject(new Error('Recording was cancelled.'));
      if (stopPromise) return stopPromise;
      const realtimeResult = finishRealtime();
      stopPromise = Promise.all([stopRecorder(), realtimeResult]).then(([audio, streamingTranscript]) => ({
        audio,
        ...(streamingTranscript ? { streamingTranscript } : {}),
      }));
      return stopPromise;
    },
    cancel: () => {
      if (cancelled) return;
      cancelled = true;
      realtimeSession?.cancel();
      void pcmCapture?.stop();
      try {
        if (recorder.state !== 'inactive') recorder.stop();
      } finally {
        release();
      }
    },
  };
}
