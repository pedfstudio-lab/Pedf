import { describe, expect, it, vi } from 'vitest';

import { interruptConversationAnswer } from './conversationBargeIn';

describe('interruptConversationAnswer', () => {
  it('stops a spoken answer and resumes the existing listening session', () => {
    const stop = vi.fn();
    const abandonAnswer = vi.fn();
    const setListening = vi.fn();
    const setPhase = vi.fn();

    expect(interruptConversationAnswer({
      phase: 'speaking',
      playback: { stop },
      session: { setListening },
      abandonAnswer,
      setPhase,
    })).toBe(true);

    expect(stop).toHaveBeenCalledOnce();
    expect(abandonAnswer).toHaveBeenCalledOnce();
    expect(setPhase).toHaveBeenCalledWith('listening');
    expect(setListening).toHaveBeenCalledWith(true);
  });

  it('ignores speech outside the speaking phase', () => {
    const stop = vi.fn();
    const abandonAnswer = vi.fn();
    const setListening = vi.fn();
    const setPhase = vi.fn();

    expect(interruptConversationAnswer({
      phase: 'thinking',
      playback: { stop },
      session: { setListening },
      abandonAnswer,
      setPhase,
    })).toBe(false);

    expect(stop).not.toHaveBeenCalled();
    expect(abandonAnswer).not.toHaveBeenCalled();
    expect(setListening).not.toHaveBeenCalled();
    expect(setPhase).not.toHaveBeenCalled();
  });
});
