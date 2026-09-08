// @vitest-environment jsdom
import { StrictMode } from 'react';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { navigate } from './lib/site/navigate';
import { Root } from './routes';

describe('Root navigation', () => {
  beforeEach(() => {
    window.history.replaceState({}, '', '/');
  });

  afterEach(cleanup);

  it('renders in-page navigation and follows browser Back and Forward', async () => {
    const originalDocument = window.document;
    render(<StrictMode><Root /></StrictMode>);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Read it. Ask it. Edit it.');

    act(() => navigate('/privacy'));

    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Your PDF stays yours.');
    expect(window.location.pathname).toBe('/privacy');
    expect(window.document).toBe(originalDocument);

    // jsdom dispatches popstate after its asynchronous history traversal.
    await act(async () => {
      const popped = new Promise<void>((resolve) => {
        window.addEventListener('popstate', () => resolve(), { once: true });
      });
      window.history.back();
      await popped;
    });
    await waitFor(() => {
      expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Read it. Ask it. Edit it.');
    });

    await act(async () => {
      const popped = new Promise<void>((resolve) => {
        window.addEventListener('popstate', () => resolve(), { once: true });
      });
      window.history.forward();
      await popped;
    });
    await waitFor(() => {
      expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Your PDF stays yours.');
    });
  });
});
