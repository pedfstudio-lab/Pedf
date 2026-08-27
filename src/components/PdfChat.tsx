import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { getDocumentText } from '@/lib/pdf/documentText';
import { defaultProviders, providerConfig, SarvamProvider } from '@/lib/providers';
import { recentChatHistory } from '@/lib/providers/chatHistory';
import { NOT_IN_DOCUMENT_MARKER } from '@/lib/providers/discussPrompt';
import { getSarvamKey } from '@/lib/providers/keys';
import {
  MAX_BRIDGING_FILLERS,
  preloadAcknowledgments,
  preloadBridgingAcknowledgments,
  takeAcknowledgment,
  takeAcknowledgmentPhrase,
  takeBridgingAcknowledgment,
  waitForBridgingGap,
  waitForBridgingInitialDelay,
} from '@/lib/speech/acknowledgments';
import { classifyQuestion } from '@/lib/speech/classifyQuestion';
import { interruptConversationAnswer } from '@/lib/speech/conversationBargeIn';
import {
  createConversationEndpoint,
  dedupeImmediateTranscriptRepeats,
  isUsableConversationTranscript,
} from '@/lib/speech/conversationEndpoint';
import type { ConversationEndpoint } from '@/lib/speech/conversationEndpoint';
import { startConversationSession } from '@/lib/speech/conversationSession';
import type {
  ConversationPhase,
  ConversationSession,
  ConversationTranscriptionFactory,
} from '@/lib/speech/conversationSession';
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
  onVoiceComplete?(): void;
}

interface VoicePlaybackState {
  readonly voiceRequest: number;
  readonly language: string;
  readonly playbackToken: number;
  firstAnswerReady: boolean;
  bridgeActive: boolean;
  bargeInArmed: boolean;
}

const ACKNOWLEDGMENT_PLAYBACK_ID = -1;
export const ENDPOINT_SILENCE_MS = 1_500;

function readableError(error: unknown): string {
  if (error instanceof AggregateError) {
    const cause = error.errors.find((item): item is Error => item instanceof Error);
    if (cause) return cause.message;
  }
  return error instanceof Error ? error.message : String(error);
}

function microphonePermissionDenied(error: unknown): boolean {
  if (error instanceof DOMException && ['NotAllowedError', 'SecurityError'].includes(error.name)) {
    return true;
  }
  return /permission|denied|not allowed/i.test(readableError(error));
}

function microphoneError(error: unknown): string {
  if (microphonePermissionDenied(error)) return 'Allow mic access to ask by voice.';
  const message = readableError(error);
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
  const [conversationPhase, setConversationPhase] = useState<ConversationPhase>('idle');
  const [liveTranscript, setLiveTranscript] = useState('');
  const [conversationUnavailable, setConversationUnavailable] = useState(false);
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
  const conversationPhaseRef = useRef<ConversationPhase>('idle');
  const conversationSession = useRef<ConversationSession | null>(null);
  const conversationRequest = useRef(0);
  const conversationEndpoint = useRef<ConversationEndpoint | null>(null);
  const conversationTranscript = useRef('');
  const conversationUserSpeaking = useRef(false);
  const finalizeConversationTurnRef = useRef<() => void>(() => undefined);
  const handleConversationFinalRef = useRef<(text: string) => void>(() => undefined);
  const keyMissing = import.meta.env.DEV && getSarvamKey().trim() === '';

  const updateConversationPhase = useCallback((phase: ConversationPhase) => {
    conversationPhaseRef.current = phase;
    setConversationPhase(phase);
  }, []);

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

  const stopConversation = useCallback(async () => {
    const request = conversationRequest.current + 1;
    conversationRequest.current = request;
    const activeSession = conversationSession.current;
    conversationSession.current = null;
    conversationEndpoint.current?.cancel();
    conversationEndpoint.current = null;
    conversationTranscript.current = '';
    conversationUserSpeaking.current = false;
    askRequest.current += 1;
    micRequest.current += 1;
    stopPlayback();
    updateConversationPhase('idle');
    setLiveTranscript('');
    setThinking(false);
    if (!activeSession) return;
    try {
      await activeSession.stop();
    } catch (caught) {
      if (conversationRequest.current === request) {
        setError(`Could not close conversation mode: ${readableError(caught)}`);
      }
    }
  }, [stopPlayback, updateConversationPhase]);

  useEffect(() => {
    askRequest.current += 1;
    stopPlayback();
    cancelRecording();
    void stopConversation();
    setEntries([]);
    setQuestion('');
    setError(null);
    setThinking(false);
    setConversationUnavailable(false);
  }, [cancelRecording, doc, stopConversation, stopPlayback]);

  useEffect(() => {
    if (!open) {
      stopPlayback();
      cancelRecording();
      void stopConversation();
    }
  }, [cancelRecording, open, stopConversation, stopPlayback]);

  useEffect(() => {
    setConversationUnavailable(false);
    if (conversationPhaseRef.current !== 'idle' || conversationSession.current) {
      void stopConversation();
    }
  }, [preferredLanguage, stopConversation]);

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
    conversationRequest.current += 1;
    conversationPhaseRef.current = 'idle';
    conversationEndpoint.current?.cancel();
    conversationEndpoint.current = null;
    conversationTranscript.current = '';
    conversationUserSpeaking.current = false;
    const activeConversation = conversationSession.current;
    conversationSession.current = null;
    void activeConversation?.stop();
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
  }, [conversationPhase, entries, micState, open, thinking]);

  if (!open) return null;

  const isCurrentVoicePlayback = (state: VoicePlaybackState): boolean => (
    voicePlayback.current === state
    && micRequest.current === state.voiceRequest
    && playbackRequest.current === state.playbackToken
  );

  const armConversationBargeIn = (state: VoicePlaybackState) => {
    if (
      conversationPhaseRef.current !== 'speaking'
      || !isCurrentVoicePlayback(state)
      || state.bargeInArmed
    ) return;
    state.bargeInArmed = true;
    conversationSession.current?.setBargeInEnabled(true);
  };

  const enqueueBridgingFillers = async (state: VoicePlaybackState) => {
    if (!isCurrentVoicePlayback(state) || state.firstAnswerReady) return;
    await Promise.all([
      waitForBridgingInitialDelay(),
      preloadBridgingAcknowledgments(state.language),
    ]);
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
          armConversationBargeIn(voiceState);
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

  const beginVoiceAnswer = (language: string, voiceRequest: number): VoicePlaybackState => {
    stopPlayback();
    const playbackToken = playbackRequest.current;
    const state: VoicePlaybackState = {
      voiceRequest,
      language,
      playbackToken,
      firstAnswerReady: false,
      bridgeActive: false,
      bargeInArmed: false,
    };
    voicePlayback.current = state;
    playback.current = { id: ACKNOWLEDGMENT_PLAYBACK_ID };
    setPlayingId(ACKNOWLEDGMENT_PLAYBACK_ID);
    return state;
  };

  const startAcknowledgment = (state: VoicePlaybackState) => {
    if (!isCurrentVoicePlayback(state)) return;

    try {
      const cached = takeAcknowledgment(state.language);
      const ticket = cached
        ? speechQueue.current?.enqueue(cached)
        : speechQueue.current?.enqueueBrowserSpeech(
          takeAcknowledgmentPhrase(state.language),
          state.language,
        );
      if (!ticket || !isCurrentVoicePlayback(state)) return;
      armConversationBargeIn(state);
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
                armConversationBargeIn(streamingVoiceState);
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
          void startPlayback(answer, streamingVoiceState).then(() => {
            if (micRequest.current !== streamingVoiceState.voiceRequest) return;
            options.onVoiceComplete?.();
          });
        } else {
          void finalTicket.done.then(() => {
            if (!isCurrentVoicePlayback(streamingVoiceState)) return;
            playbackRequest.current += 1;
            playback.current = null;
            voicePlayback.current = null;
            setPlayingId(null);
            options.onVoiceComplete?.();
          });
        }
      }
    } catch (caught) {
      if (askRequest.current === request) {
        if (options.spoken) stopPlayback();
        setError(readableError(caught));
        options.onVoiceComplete?.();
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
      const realtimeProvider = new SarvamProvider(providerConfig);
      const activeRecording = await startRecording({
        startTranscription: () => realtimeProvider.transcribeStream({ language: 'auto' }),
      });
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

    try {
      const stoppedAt = performance.now();
      const recorded = await activeRecording.stop();
      if (micRequest.current !== request) return;
      let transcript = recorded.streamingTranscript?.trim() ?? '';
      if (transcript !== '') {
        console.info(
          `[voice timing] request ${request} realtime STT final after stop: ${Math.round(performance.now() - stoppedAt)} ms`,
        );
      } else {
        const sttStartedAt = performance.now();
        const result = await defaultProviders().transcribe({ audio: recorded.audio });
        transcript = result.text.trim();
        console.info(
          `[voice timing] request ${request} batch STT fallback: ${Math.round(performance.now() - sttStartedAt)} ms`,
        );
      }
      if (micRequest.current !== request) return;
      if (transcript === '') throw new Error('Sarvam returned an empty transcript.');
      const voiceState = beginVoiceAnswer(preferredLanguage, request);
      if (classifyQuestion(transcript) === 'document') startAcknowledgment(voiceState);
      setMicState('idle');
      await ask(transcript, { spoken: true, voiceRequest: request });
    } catch (caught) {
      if (micRequest.current !== request) return;
      setError(microphoneError(caught));
    } finally {
      if (micRequest.current === request) setMicState('idle');
    }
  };

  const resumeConversationListening = (request: number) => {
    if (
      conversationRequest.current !== request
      || !conversationSession.current
    ) return;
    conversationTranscript.current = '';
    conversationUserSpeaking.current = false;
    setLiveTranscript('');
    conversationSession.current.setListening(true);
    updateConversationPhase('listening');
  };

  const handleConversationBargeIn = () => {
    const activeSession = conversationSession.current;
    if (!activeSession) return;
    interruptConversationAnswer({
      phase: conversationPhaseRef.current,
      playback: { stop: stopPlayback },
      session: activeSession,
      abandonAnswer: () => {
        askRequest.current += 1;
        micRequest.current += 1;
        conversationEndpoint.current?.cancel();
        conversationTranscript.current = '';
        conversationUserSpeaking.current = false;
        setLiveTranscript('');
        setThinking(false);
      },
      setPhase: updateConversationPhase,
    });
  };

  const handleConversationFinal = async (rawTranscript: string) => {
    if (
      conversationPhaseRef.current !== 'thinking'
      || !conversationSession.current
    ) return;
    const request = conversationRequest.current;
    const transcript = dedupeImmediateTranscriptRepeats(rawTranscript);
    if (!isUsableConversationTranscript(transcript)) {
      resumeConversationListening(request);
      return;
    }

    const voiceRequest = micRequest.current + 1;
    micRequest.current = voiceRequest;
    const voiceState = beginVoiceAnswer(preferredLanguage, voiceRequest);
    updateConversationPhase('speaking');
    if (classifyQuestion(transcript) === 'document') startAcknowledgment(voiceState);
    const answering = ask(transcript, {
      spoken: true,
      voiceRequest,
      onVoiceComplete: () => {
        resumeConversationListening(request);
      },
    });
    await answering;
  };
  handleConversationFinalRef.current = (text) => {
    void handleConversationFinal(text);
  };

  const finalizeConversationTurn = () => {
    if (
      conversationPhaseRef.current !== 'listening'
      || !conversationSession.current
    ) return;
    const activeSession = conversationSession.current;
    conversationEndpoint.current?.cancel();
    conversationUserSpeaking.current = false;
    activeSession.setListening(false);
    updateConversationPhase('thinking');
    if (!activeSession.requestFinal()) {
      activeSession.setListening(true);
      updateConversationPhase('listening');
    }
  };
  finalizeConversationTurnRef.current = () => {
    finalizeConversationTurn();
  };

  const beginConversation = async () => {
    if (
      !doc
      || thinking
      || keyMissing
      || micState !== 'idle'
      || conversationUnavailable
      || conversationPhaseRef.current !== 'idle'
      || conversationSession.current
    ) return;
    stopPlayback();
    const request = conversationRequest.current + 1;
    conversationRequest.current = request;
    setError(null);
    setLiveTranscript('');
    conversationTranscript.current = '';
    conversationUserSpeaking.current = false;
    updateConversationPhase('listening');

    try {
      const realtimeProvider = new SarvamProvider(providerConfig);
      const endpoint = createConversationEndpoint(
        () => finalizeConversationTurnRef.current(),
        ENDPOINT_SILENCE_MS,
      );
      const transcriptionFactory: ConversationTranscriptionFactory = (
        onPartial,
        onFinal,
        onError,
      ) => realtimeProvider.transcribeStream({
        language: preferredLanguage,
        onPartial,
        onFinal,
        onError,
      });
      conversationEndpoint.current = endpoint;
      const activeConversation = await startConversationSession(
        transcriptionFactory,
        {
          onPartial: (text) => {
            if (
              conversationRequest.current !== request
              || conversationPhaseRef.current !== 'listening'
            ) return;
            conversationTranscript.current = text;
            setLiveTranscript(text);
          },
          onFinal: (text) => {
            if (conversationRequest.current !== request) return;
            handleConversationFinalRef.current(text);
          },
          onSpeechStart: () => {
            if (
              conversationRequest.current !== request
              || conversationPhaseRef.current !== 'listening'
            ) return;
            conversationUserSpeaking.current = true;
            endpoint.onSpeechStart();
          },
          onSpeechEnd: () => {
            if (
              conversationRequest.current !== request
              || conversationPhaseRef.current !== 'listening'
            ) return;
            conversationUserSpeaking.current = false;
            endpoint.onSpeechEnd(isUsableConversationTranscript(
              conversationTranscript.current,
            ));
          },
          onBargeIn: () => {
            if (conversationRequest.current !== request) return;
            handleConversationBargeIn();
          },
          onReconnect: () => {
            if (conversationRequest.current !== request) return;
            conversationEndpoint.current?.cancel();
            conversationTranscript.current = '';
            conversationUserSpeaking.current = false;
            setLiveTranscript('');
            if (
              conversationPhaseRef.current === 'thinking'
              && conversationSession.current
            ) {
              conversationSession.current.setListening(true);
              updateConversationPhase('listening');
            }
          },
          onError: (caught) => {
            if (conversationRequest.current !== request) return;
            if (!microphonePermissionDenied(caught)) setConversationUnavailable(true);
            setError(microphoneError(caught));
            void stopConversation();
          },
        },
      );
      if (conversationRequest.current !== request) {
        await activeConversation.stop();
        return;
      }
      conversationSession.current = activeConversation;
    } catch (caught) {
      if (conversationRequest.current !== request) return;
      conversationRequest.current += 1;
      conversationSession.current = null;
      conversationEndpoint.current?.cancel();
      conversationEndpoint.current = null;
      conversationTranscript.current = '';
      conversationUserSpeaking.current = false;
      updateConversationPhase('idle');
      setLiveTranscript('');
      if (!microphonePermissionDenied(caught)) setConversationUnavailable(true);
      setError(microphoneError(caught));
    }
  };

  const conversationActive = conversationPhase !== 'idle';

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
          {entries.length === 0 && !thinking && micState === 'idle' && !conversationActive && (
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
          {conversationActive && (
            <div role="status" className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900">
              <p className="font-semibold">
                {conversationPhase === 'listening' && 'Conversation mode is listening.'}
                {conversationPhase === 'thinking' && 'Finishing your question…'}
                {conversationPhase === 'speaking' && 'Answering aloud…'}
              </p>
              <p className="mt-1 text-xs text-emerald-800">
                {conversationPhase === 'listening'
                  ? 'Pause briefly when you finish. Earphones are recommended.'
                  : conversationPhase === 'speaking'
                    ? 'You can interrupt by speaking. Earphones are most reliable; speakers use echo cancellation.'
                    : 'The microphone stays open; the next listening turn starts automatically.'}
              </p>
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
                value={conversationActive ? liveTranscript : question}
                onChange={(event) => {
                  if (!conversationActive) setQuestion(event.target.value);
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !event.shiftKey) {
                    event.preventDefault();
                    event.currentTarget.form?.requestSubmit();
                  }
                }}
                placeholder={conversationActive ? 'Listening continuously…' : 'Ask a question about this PDF…'}
                disabled={!doc || thinking || micState !== 'idle' || conversationActive}
                className="min-h-11 min-w-0 flex-1 resize-none rounded-md border border-neutral-300 px-3 py-2 text-sm text-neutral-900 outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-200 disabled:bg-neutral-100"
              />
              <button
                type="button"
                onClick={() => {
                  if (micState === 'recording') void finishRecording();
                  else void beginRecording();
                }}
                disabled={!doc || thinking || conversationActive || micState === 'requesting' || micState === 'transcribing'}
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
                type="button"
                onClick={() => {
                  if (conversationActive) void stopConversation();
                  else void beginConversation();
                }}
                disabled={!conversationActive && (!doc || thinking || micState !== 'idle' || conversationUnavailable)}
                aria-label={conversationActive
                  ? 'Stop conversation mode'
                  : conversationUnavailable
                    ? 'Conversation mode unavailable'
                    : 'Start conversation mode'}
                aria-pressed={conversationActive}
                title={conversationUnavailable
                  ? 'Realtime speech is unavailable; click-to-talk remains available.'
                  : 'Conversation mode keeps the microphone open. You can interrupt spoken answers; earphones improve reliability.'}
                className={`rounded-md px-3 py-2.5 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-40 ${conversationActive ? 'bg-emerald-700 hover:bg-emerald-600' : 'bg-violet-700 hover:bg-violet-600'}`}
              >
                {conversationActive
                  ? 'Stop conversation'
                  : conversationUnavailable
                    ? 'Unavailable'
                    : 'Conversation'}
              </button>
              <button
                type="submit"
                disabled={!doc || thinking || micState !== 'idle' || conversationActive || question.trim() === ''}
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
