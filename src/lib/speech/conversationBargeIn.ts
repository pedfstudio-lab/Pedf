import type {
  ConversationPhase,
  ConversationSession,
} from './conversationSession';

interface StoppablePlayback {
  stop(): void;
}

export interface ConversationBargeInInput {
  readonly phase: ConversationPhase;
  readonly playback: StoppablePlayback;
  readonly session: Pick<ConversationSession, 'setListening'>;
  abandonAnswer(): void;
  setPhase(phase: ConversationPhase): void;
}

/** Atomically hand control from the spoken answer back to the persistent STT turn. */
export function interruptConversationAnswer(input: ConversationBargeInInput): boolean {
  if (input.phase !== 'speaking') return false;
  input.playback.stop();
  input.abandonAnswer();
  input.setPhase('listening');
  input.session.setListening(true);
  return true;
}
