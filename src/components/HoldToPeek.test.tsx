// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HoldToPeek } from './HoldToPeek';

afterEach(cleanup);

describe('HoldToPeek', () => {
  it.each([' ', 'Enter'])('shows the original while %j is held, from the keyboard', (key) => {
    const onPeekChange = vi.fn();
    render(<HoldToPeek onPeekChange={onPeekChange} />);
    const button = screen.getByRole('button', { name: 'Hold to peek' });

    fireEvent.keyDown(button, { key });
    fireEvent.keyDown(button, { key, repeat: true }); // auto-repeat while held changes nothing
    expect(onPeekChange.mock.calls).toEqual([[true]]);
    fireEvent.keyUp(button, { key });
    expect(onPeekChange.mock.calls).toEqual([[true], [false]]);
  });

  it('stops peeking if focus leaves while the key is still down', () => {
    const onPeekChange = vi.fn();
    render(<HoldToPeek onPeekChange={onPeekChange} />);
    const button = screen.getByRole('button', { name: 'Hold to peek' });
    fireEvent.keyDown(button, { key: ' ' });
    fireEvent.blur(button);
    expect(onPeekChange.mock.calls).toEqual([[true], [false]]);
  });

  it('explains why it is greyed out before the first edit', () => {
    render(<HoldToPeek disabled onPeekChange={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Hold to peek' }).getAttribute('title'))
      .toBe('Make an edit first, then hold this to see the original PDF');
  });
});
