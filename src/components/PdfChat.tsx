import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { getDocumentText } from '@/lib/pdf/documentText';
import { defaultProviders } from '@/lib/providers';
import { recentChatHistory } from '@/lib/providers/chatHistory';
import { NOT_IN_DOCUMENT_MARKER } from '@/lib/providers/discussPrompt';
import { getSarvamKey } from '@/lib/providers/keys';
import {
  MAX_BRIDGING_FILLERS,
  preloadAcknowledgments,
  takeAcknowledgment,
  takeAcknowledgmentPhrase,
  takeBridgingAcknowledgment,
  waitForAcknowledgmentDelay,
  waitForBridgingGap,
  waitForBridgingInitialDelay,
} from '@/lib/speech/acknowledgments';
import { startRecording } from '@/lib/speech/recordQuestion';
import type { Recording } from '@/lib/speech/recordQuestion';
import {
  chunkSentences,
  coalesceSpeechChunks,
  createSpeechChunkAccumulator,
  createSentenceAccumulator,
  normalizeForSpeech,
} from '@/lib/speech/sentenceChunking';
import { createSpeechQueue } from '@/lib/speech/speechQueue';
import type { SpeechQueue, SpeechQueueTicket } from '@/lib/speech/speechQueue';
import { stripPageMarkers } from '@/lib/speech/stripPageMarkers';
import {
  SUPPORTED_LANGUAGES,
  usePrefs,
} from '@/state/prefsStore';
import type { SupportedLanguageCode } from '@/state/prefsStore';

interface PdfChatProps {
  readonly open: boolean;
  readonly doc: PDFDocumentProxy | null;
  onClose(): void;
  onOpenSettings(): void;
}

interface ChatEntry {
  readonly id: number;
  readonly role: 'user' | 'assistant';
  readonly text: string;
  readonly grounded?: boolean;
  readonly language?: string;
}

type MicState = 'idle' | 'requesting' | 'recording' | 'transcribing';

interface AskOptions {
  readonly spoken: boolean;
  readonly voiceRequest?: number;
}

interface VoicePlaybackState {
  readonly voiceRequest: number;
  readonly language: string;
  readonly playbackToken: number;
  firstAnswerReady: boolean;
  bridgeActive: boolean;
}

const ACKNOWLEDGMENT_PLAYBACK_ID = -1;

function readableError(error: unknown): string {
  if (error instanceof AggregateError) {
    const cause = error.errors.find((item): item is Error => item instanceof Error);
    if (cause) return cause.message;
  }
  return error instanceof Error ? error.message : String(error);
}

function microphoneError(error: unknown): string {
  if (error instanceof DOMException && ['NotAllowedError', 'SecurityError'].includes(error.name)) {
    return 'Allow mic access to ask by voice.';
  }
  const message = readableError(error);
  if (/permission|denied|not allowed/i.test(message)) return 'Allow mic access to ask by voice.';
  if (/empty (recording|transcript)|didn.t catch/i.test(message)) {
    return "Didn't catch that — try again.";
  }
  return message;
}

export function PdfChat({ open, doc, onClose, onOpenSettings }: PdfChatProps) {
  const { preferredLanguage, setPreferredLanguage } = usePrefs();
  const [entries, setEntries] = useState<ChatEntry[]>([]);
  const [question, setQuestion] = useState('');
  const [thinking, setThinking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [playingId, setPlayingId] = useState<number | null>(null);
  const [micState, setMicState] = useState<MicState>('idle');
  const speechQueue = useRef<SpeechQueue | null>(null);
  if (!speechQueue.current) {
    speechQueue.current = createSpeechQueue({
      onError: (caught) => {
        setError(`Speech playback is unavailable: ${readableError(caught)}`);
      },
    });
  }
  const nextId = useRef(0);
  const askRequest = useRef(0);
  const messagesEnd = useRef<HTMLDivElement | null>(null);
  const playback = useRef<{ readonly id: number } | null>(null);
  const playbackRequest = useRef(0);
  const voicePlayback = useRef<VoicePlaybackState | null>(null);
  const recording = useRef<Recording | null>(null);
  const micRequest = useRef(0);
  const keyMissing = import.meta.env.DEV && getSarvamKey().trim() === '';

  const stopPlayback = useCallback(() => {
    playbackRequest.current += 1;
    speechQueue.current?.stop();
    playback.current = null;
    voicePlayback.current = null;
    setPlayingId(null);
  }, []);

  const cancelRecording = useCallback(() => {
    micRequest.current += 1;
    recording.current?.cancel();
    recording.current = null;
    setMicState('idle');
  }, []);

  useEffect(() => {
    askRequest.current += 1;
    stopPlayback();
    cancelRecording();
    setEntries([]);
    setQuestion('');
    setError(null);
    setThinking(false);
  }, [cancelRecording, doc, stopPlayback]);

  useEffect(() => {
    if (!open) {
      stopPlayback();
      cancelRecording();
    }
  }, [cancelRecording, open, stopPlayback]);

  useEffect(() => {
    if (!open || keyMissing) return;
    void preloadAcknowledgments(preferredLanguage);
  }, [keyMissing, open, preferredLanguage]);

  useEffect(() => () => {
    askRequest.current += 1;
    playbackRequest.current += 1;
    speechQueue.current?.stop();
    playback.current = null;
    voicePlayback.current = null;
    micRequest.current += 1;
    recording.current?.cancel();
    recording.current = null;
  }, []);

  useEffect(() => {
    if (!open) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [onClose, open]);

  useEffect(() => {
    if (open) messagesEnd.current?.scrollIntoView({ block: 'nearest' });
  }, [entries, micState, open, thinking]);

  if (!open) return null;

  const isCurrentVoicePlayback = (state: VoicePlaybackState): boolean => (
    voicePlayback.current === state
    && micRequest.current === state.voiceRequest
    && playbackRequest.current === state.playbackToken
  );

  const enqueueBridgingFillers = async (state: VoicePlaybackState) => {
    await waitForBridgingInitialDelay();
    for (let count = 0; count < MAX_BRIDGING_FILLERS; count += 1) {
      if (!isCurrentVoicePlayback(state) || state.firstAnswerReady) return;
      const bridge = takeBridgingAcknowledgment(state.language);
      if (!bridge) return;
      state.bridgeActive = true;
      const ticket = speechQueue.current?.enqueue(bridge, () => {
        state.bridgeActive = false;
      });
      if (!ticket) return;
      await ticket.done;
      if (!isCurrentVoicePlayback(state) || state.firstAnswerReady) return;
      if (count + 1 < MAX_BRIDGING_FILLERS) await waitForBridgingGap();
    }
  };

  const startPlayback = async (
    entry: ChatEntry,
    voiceState?: VoicePlaybackState,
  ) => {
    const continuingVoice = voiceState && isCurrentVoicePlayback(voiceState);
    if (!continuingVoice) stopPlayback();
    const request = continuingVoice
      ? voiceState.playbackToken
      : playbackRequest.current;
    setPlayingId(entry.id);
    setError(null);
    playback.current = { id: entry.id };

    const sentenceChunks = chunkSentences(entry.text)
      .map((chunk) => normalizeForSpeech(stripPageMarkers(chunk)))
      .filter((chunk) => chunk !== '');
    const chunks = coalesceSpeechChunks(sentenceChunks);
    if (chunks.length === 0) {
      if (continuingVoice) voiceState.firstAnswerReady = true;
      playback.current = null;
      setPlayingId(null);
      return;
    }

    const tickets = chunks.map((chunk, index) => speechQueue.current?.enqueueSpeech(
      chunk,
      entry.language ?? preferredLanguage,
      `${continuingVoice ? `request ${voiceState.voiceRequest} ` : ''}TTS sentence ${index + 1}`,
      continuingVoice && index === 0
        ? () => {
          if (!isCurrentVoicePlayback(voiceState)) return;
          voiceState.firstAnswerReady = true;
          if (voiceState.bridgeActive) speechQueue.current?.skipCurrent();
        }
        : undefined,
    )).filter((ticket) => ticket !== undefined);

    await tickets[tickets.length - 1]?.done;
    if (playbackRequest.current !== request) return;
    playbackRequest.current += 1;
    playback.current = null;
    if (continuingVoice && voicePlayback.current === voiceState) voicePlayback.current = null;
    setPlayingId(null);
  };

  const togglePlayback = async (entry: ChatEntry) => {
    if (playingId === entry.id) {
      stopPlayback();
      return;
    }
    await startPlayback(entry);
  };

  const stopVoicePlayback = () => {
    micRequest.current += 1;
    stopPlayback();
    setMicState('idle');
  };

  const startAcknowledgment = async (language: string, voiceRequest: number) => {
    stopPlayback();
    const playbackToken = playbackRequest.current;
    const state: VoicePlaybackState = {
      voiceRequest,
      language,
      playbackToken,
      firstAnswerReady: false,
      bridgeActive: false,
    };
    voicePlayback.current = state;
    await waitForAcknowledgmentDelay();
    if (!isCurrentVoicePlayback(state)) return;

    try {
      const cached = takeAcknowledgment(language);
      const ticket = cached
        ? speechQueue.current?.enqueue(cached)
        : speechQueue.current?.enqueueBrowserSpeech(
          takeAcknowledgmentPhrase(language),
          language,
        );
      if (!ticket || !isCurrentVoicePlayback(state)) return;
      playback.current = { id: ACKNOWLEDGMENT_PLAYBACK_ID };
      setPlayingId(ACKNOWLEDGMENT_PLAYBACK_ID);
      void ticket.done.then(() => enqueueBridgingFillers(state));
    } catch {
      // An acknowledgment is best-effort; transcription and the real answer must continue.
    }
  };

  const ask = async (questionText: string, options: AskOptions) => {
    const nextQuestion = questionText.trim();
    if (!doc || !nextQuestion || thinking || keyMissing) return;
    if (!options.spoken) stopPlayback();
    const history = recentChatHistory(entries);
    const request = askRequest.current + 1;
    askRequest.current = request;
    const answerLanguage = preferredLanguage;

    nextId.current += 1;
    setEntries((current) => [...current, {
      id: nextId.current,
      role: 'user',
      text: nextQuestion,
    }]);
    setError(null);
    setThinking(true);

    try {
      const documentText = await getDocumentText(doc);
      if (askRequest.current !== request) return;
      const voiceState = options.spoken && options.voiceRequest !== undefined
        ? voicePlayback.current
        : null;
      const streamingVoiceState = voiceState
        && voiceState.voiceRequest === options.voiceRequest
        && isCurrentVoicePlayback(voiceState)
        ? voiceState
        : null;
      const sentenceAccumulator = streamingVoiceState ? createSentenceAccumulator() : null;
      const speechChunkAccumulator = streamingVoiceState
        ? createSpeechChunkAccumulator()
        : null;
      let sentenceCount = 0;
      let speechChunkCount = 0;
      let lastSentenceTicket: SpeechQueueTicket | undefined;
      let firstTextDeltaAt: number | null = null;
      const llmStartedAt = performance.now();
      const enqueueSpeechChunks = (speechChunks: readonly string[]) => {
        if (!streamingVoiceState || !isCurrentVoicePlayback(streamingVoiceState)) return;
        for (const speechChunk of speechChunks) {
          speechChunkCount += 1;
          const ticket = speechQueue.current?.enqueueSpeech(
            speechChunk,
            streamingVoiceState.language,
            `request ${streamingVoiceState.voiceRequest} TTS chunk ${speechChunkCount}`,
            speechChunkCount === 1
              ? () => {
                if (!isCurrentVoicePlayback(streamingVoiceState)) return;
                streamingVoiceState.firstAnswerReady = true;
                if (streamingVoiceState.bridgeActive) speechQueue.current?.skipCurrent();
              }
              : undefined,
          );
          if (ticket) lastSentenceTicket = ticket;
        }
      };
      const enqueueStreamedSentences = (sentences: readonly string[]) => {
        if (
          !streamingVoiceState
          || !speechChunkAccumulator
          || !isCurrentVoicePlayback(streamingVoiceState)
        ) return;
        for (const sentence of sentences) {
          const spokenText = normalizeForSpeech(stripPageMarkers(
            sentence.replace(NOT_IN_DOCUMENT_MARKER, ''),
          ));
          if (spokenText === '') continue;
          sentenceCount += 1;
          if (sentenceCount === 1) {
            console.info(
              `[voice timing] request ${streamingVoiceState.voiceRequest} LLM first sentence: ${Math.round(performance.now() - llmStartedAt)} ms`,
            );
          }
          const speechChunks = speechChunkAccumulator.push(spokenText);
          enqueueSpeechChunks(speechChunks);
        }
      };
      const result = await defaultProviders().discuss({
        question: nextQuestion,
        documentText: documentText.full,
        language: answerLanguage,
        history,
        spoken: options.spoken,
        onTextDelta: sentenceAccumulator
          ? (delta) => {
            if (firstTextDeltaAt === null) {
              firstTextDeltaAt = performance.now();
              console.info(
                `[voice timing] request ${options.voiceRequest ?? 'unknown'} LLM first token: ${Math.round(firstTextDeltaAt - llmStartedAt)} ms`,
              );
            }
            enqueueStreamedSentences(sentenceAccumulator.push(delta));
          }
          : undefined,
      });
      if (sentenceAccumulator) enqueueStreamedSentences(sentenceAccumulator.flush());
      if (speechChunkAccumulator) {
        enqueueSpeechChunks(speechChunkAccumulator.flush());
      }
      if (options.spoken) {
        console.info(
          `[voice timing] request ${options.voiceRequest ?? 'unknown'} LLM: ${Math.round(performance.now() - llmStartedAt)} ms`,
        );
      }
      if (askRequest.current !== request) return;
      nextId.current += 1;
      const answer: ChatEntry = {
        id: nextId.current,
        role: 'assistant',
        text: result.answer,
        grounded: result.grounded,
        language: answerLanguage,
      };
      setEntries((current) => [...current, answer]);
      if (
        streamingVoiceState
        && isCurrentVoicePlayback(streamingVoiceState)
      ) {
        playback.current = { id: answer.id };
        setPlayingId(answer.id);
        const finalTicket = lastSentenceTicket;
        if (!finalTicket) {
          void startPlayback(answer, streamingVoiceState);
        } else {
          void finalTicket.done.then(() => {
            if (!isCurrentVoicePlayback(streamingVoiceState)) return;
            playbackRequest.current += 1;
            playback.current = null;
            voicePlayback.current = null;
            setPlayingId(null);
          });
        }
      }
    } catch (caught) {
      if (askRequest.current === request) {
        if (options.spoken) stopPlayback();
        setError(readableError(caught));
      }
    } finally {
      if (askRequest.current === request) setThinking(false);
    }
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const nextQuestion = question.trim();
    if (!doc || !nextQuestion || thinking || keyMissing || micState !== 'idle') return;
    setQuestion('');
    void ask(nextQuestion, { spoken: false });
  };

  const beginRecording = async () => {
    if (!doc || thinking || keyMissing || micState !== 'idle') return;
    stopPlayback();
    const request = micRequest.current + 1;
    micRequest.current = request;
    setError(null);
    setMicState('requesting');

    try {
      const activeRecording = await startRecording();
      if (micRequest.current !== request) {
        activeRecording.cancel();
        return;
      }
      recording.current = activeRecording;
      setMicState('recording');
    } catch (caught) {
      if (micRequest.current !== request) return;
      micRequest.current += 1;
      setMicState('idle');
      setError(microphoneError(caught));
    }
  };

  const finishRecording = async () => {
    const activeRecording = recording.current;
    if (!activeRecording || micState !== 'recording') return;
    recording.current = null;
    const request = micRequest.current;
    setError(null);
    setMicState('transcribing');
    void startAcknowledgment(preferredLanguage, request);

    try {
      const audio = await activeRecording.stop();
      if (micRequest.current !== request) return;
      const sttStartedAt = performance.now();
      const result = await defaultProviders().transcribe({ audio });
      console.info(
        `[voice timing] request ${request} STT: ${Math.round(performance.now() - sttStartedAt)} ms`,
      );
      if (micRequest.current !== request) return;
      const transcript = result.text.trim();
      if (transcript === '') throw new Error('Sarvam returned an empty transcript.');
      setMicState('idle');
      await ask(transcript, { spoken: true, voiceRequest: request });
    } catch (caught) {
      if (micRequest.current !== request) return;
      setError(microphoneError(caught));
    } finally {
      if (micRequest.current === request) setMicState('idle');
    }
  };

  return (
    <div
      className="fixed inset-0 z-[190] flex justify-end bg-neutral-950/35"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="pdf-chat-title"
        className="flex h-full w-full max-w-md flex-col border-l border-neutral-200 bg-white shadow-2xl"
      >
        <header className="border-b border-neutral-200 px-5 py-4">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 id="pdf-chat-title" className="text-lg font-semibold text-neutral-900">Ask this PDF</h2>
              <p className="mt-1 text-xs text-neutral-500">Answers come from this PDF; general knowledge is clearly labeled.</p>
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close PDF chat"
              className="rounded-md px-2 py-1 text-xl leading-none text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900"
            >
              ×
            </button>
          </div>
          <label className="mt-4 block text-xs font-semibold uppercase tracking-wide text-neutral-500">
            Answer language
            <select
              aria-label="Chat answer language"
              value={preferredLanguage}
              onChange={(event) => setPreferredLanguage(event.target.value as SupportedLanguageCode)}
              className="mt-1.5 w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm font-normal normal-case tracking-normal text-neutral-900 outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-200"
            >
              {SUPPORTED_LANGUAGES.map(({ code, label }) => (
                <option key={code} value={code}>{label}</option>
              ))}
            </select>
          </label>
        </header>

        <div className="flex-1 space-y-4 overflow-y-auto px-5 py-5" aria-live="polite">
          {entries.length === 0 && !thinking && micState === 'idle' && (
            <div className="rounded-xl border border-dashed border-neutral-300 bg-neutral-50 p-4 text-sm text-neutral-600">
              Ask about dates, accommodation, activities, or any other information written in the PDF.
            </div>
          )}
          {entries.map((entry) => (
            <article
              key={entry.id}
              className={`max-w-[90%] rounded-xl px-4 py-3 text-sm ${entry.role === 'user' ? 'ml-auto bg-blue-600 text-white' : 'border border-neutral-200 bg-neutral-50 text-neutral-800'}`}
            >
              <p className="whitespace-pre-wrap">{entry.text}</p>
              {entry.role === 'assistant' && (
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={() => void togglePlayback(entry)}
                    aria-label={playingId === entry.id ? 'Stop reading answer aloud' : 'Read answer aloud'}
                    className="inline-flex items-center gap-1 rounded-full border border-neutral-300 bg-white px-2.5 py-1 text-[11px] font-semibold text-neutral-700 hover:border-blue-400 hover:text-blue-700"
                  >
                    <span aria-hidden="true">{playingId === entry.id ? '⏹' : '▶'}</span>
                    {playingId === entry.id ? 'Stop' : 'Read aloud'}
                  </button>
                  {entry.grounded === false && (
                    <span className="inline-flex rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-semibold text-amber-900">
                      General info — not from this PDF
                    </span>
                  )}
                </div>
              )}
            </article>
          ))}
          {thinking && (
            <div role="status" className="inline-flex rounded-xl border border-neutral-200 bg-neutral-50 px-4 py-3 text-sm text-neutral-500">
              Reading the document…
            </div>
          )}
          {micState !== 'idle' && (
            <div role="status" className="inline-flex rounded-xl border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-800">
              {micState === 'requesting' && 'Opening the microphone…'}
              {micState === 'recording' && 'Listening… tap Stop when you finish.'}
              {micState === 'transcribing' && 'Transcribing your question…'}
            </div>
          )}
          {playingId === ACKNOWLEDGMENT_PLAYBACK_ID && (
            <button
              type="button"
              onClick={stopVoicePlayback}
              className="inline-flex items-center gap-1 rounded-full border border-neutral-300 bg-white px-3 py-1.5 text-xs font-semibold text-neutral-700 hover:border-red-400 hover:text-red-700"
            >
              <span aria-hidden="true">⏹</span>
              Stop voice
            </button>
          )}
          {error && (
            <div role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">
              {error}
            </div>
          )}
          <div ref={messagesEnd} />
        </div>

        <footer className="border-t border-neutral-200 p-4">
          {keyMissing ? (
            <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950">
              <p>Add your Sarvam API key in Settings to ask this PDF.</p>
              <button
                type="button"
                onClick={onOpenSettings}
                className="mt-3 rounded-md bg-neutral-900 px-3 py-1.5 font-medium text-white hover:bg-neutral-700"
              >
                Open Settings
              </button>
            </div>
          ) : (
            <form onSubmit={submit} className="flex items-end gap-2">
              <label htmlFor="pdf-chat-question" className="sr-only">Ask a question about this PDF</label>
              <textarea
                id="pdf-chat-question"
                rows={2}
                value={question}
                onChange={(event) => setQuestion(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !event.shiftKey) {
                    event.preventDefault();
                    event.currentTarget.form?.requestSubmit();
                  }
                }}
                placeholder="Ask a question about this PDF…"
                disabled={!doc || thinking || micState !== 'idle'}
                className="min-h-11 flex-1 resize-none rounded-md border border-neutral-300 px-3 py-2 text-sm text-neutral-900 outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-200 disabled:bg-neutral-100"
              />
              <button
                type="button"
                onClick={() => {
                  if (micState === 'recording') void finishRecording();
                  else void beginRecording();
                }}
                disabled={!doc || thinking || micState === 'requesting' || micState === 'transcribing'}
                aria-label={micState === 'recording' ? 'Stop recording question' : 'Ask by voice'}
                aria-pressed={micState === 'recording'}
                className={`rounded-md px-3 py-2.5 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-40 ${micState === 'recording' ? 'bg-red-600 hover:bg-red-500' : 'bg-neutral-800 hover:bg-neutral-700'}`}
              >
                {micState === 'requesting' && '…'}
                {micState === 'recording' && '⏹'}
                {micState === 'transcribing' && '…'}
                {micState === 'idle' && '🎤'}
              </button>
              <button
                type="submit"
                disabled={!doc || thinking || micState !== 'idle' || question.trim() === ''}
                className="rounded-md bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-40"
              >
                Send
              </button>
            </form>
          )}
        </footer>
      </section>
    </div>
  );
}
