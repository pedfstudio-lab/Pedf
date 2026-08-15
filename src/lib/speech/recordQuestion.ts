export interface Recording {
  stop(): Promise<Blob>;
  cancel(): void;
}

const PREFERRED_MIME_TYPE = 'audio/webm;codecs=opus';
const FALLBACK_MIME_TYPE = 'audio/webm';

/** Return the base container MIME type accepted by speech-to-text APIs. */
export function baseMimeType(rawType: string): string {
  const [baseType] = rawType.split(';');
  return baseType?.trim() || FALLBACK_MIME_TYPE;
}

function releaseStream(stream: MediaStream): void {
  for (const track of stream.getTracks()) track.stop();
}

/** Capture one microphone question and return its encoded browser audio. */
export async function startRecording(): Promise<Recording> {
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
  let stopPromise: Promise<Blob> | null = null;
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

  return {
    stop: () => {
      if (cancelled) return Promise.reject(new Error('Recording was cancelled.'));
      if (stopPromise) return stopPromise;
      stopPromise = new Promise<Blob>((resolve, reject) => {
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
      return stopPromise;
    },
    cancel: () => {
      if (cancelled) return;
      cancelled = true;
      try {
        if (recorder.state !== 'inactive') recorder.stop();
      } finally {
        release();
      }
    },
  };
}
