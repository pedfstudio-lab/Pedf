import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { HandsFreeVoiceOverlay } from './HandsFreeVoiceOverlay';

describe('HandsFreeVoiceOverlay', () => {
  it('renders a click-through shell with interactive caption and controls', () => {
    const markup = renderToStaticMarkup(
      <HandsFreeVoiceOverlay
        phase="listening"
        answer="The latest grounded answer."
        onOpenChat={vi.fn()}
        onStop={vi.fn()}
      />,
    );

    expect(markup).toContain('data-hands-free-overlay');
    expect(markup).toContain('pointer-events-none fixed inset-0');
    expect(markup).toContain('pointer-events-auto max-h-48');
    expect(markup).toContain('The latest grounded answer.');
    expect(markup).toContain('Listening…');
    expect(markup).toContain('Open chat');
    expect(markup).toContain('Stop');
    expect(markup).not.toContain('bg-neutral-950/35');
  });

  it('maps every conversation phase to a compact status label', () => {
    const renderPhase = (phase: 'idle' | 'listening' | 'thinking' | 'speaking') => (
      renderToStaticMarkup(
        <HandsFreeVoiceOverlay
          phase={phase}
          onOpenChat={vi.fn()}
          onStop={vi.fn()}
        />,
      )
    );

    expect(renderPhase('listening')).toContain('Listening…');
    expect(renderPhase('thinking')).toContain('Thinking…');
    expect(renderPhase('speaking')).toContain('Speaking…');
    expect(renderPhase('idle')).toContain('Voice conversation');
  });
});
