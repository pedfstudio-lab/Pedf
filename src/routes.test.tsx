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

  it('keeps each page\'s title and real address right while moving around the site', () => {
    render(<StrictMode><Root /></StrictMode>);
    expect(document.title).toBe('HighPal — Professional PDF Editor | Read it. Ask it. Edit it.');
    expect(document.head.querySelector('link[rel="canonical"]')?.getAttribute('href')).toBe('https://highpal.ai/');

    act(() => navigate('/terms'));
    expect(document.title).toBe('Terms of Use — HighPal');
    expect(document.head.querySelector('link[rel="canonical"]')?.getAttribute('href')).toBe('https://highpal.ai/terms');
    expect(document.head.querySelector('meta[property="og:url"]')?.getAttribute('content')).toBe('https://highpal.ai/terms');
  });

  it('shows "page not found" for an old link or a typo, kept out of search', () => {
    window.history.replaceState({}, '', '/compres');
    render(<StrictMode><Root /></StrictMode>);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('We couldn’t find that page.');
    expect(screen.getByRole('link', { name: 'Open the PDF editor' }).getAttribute('href')).toBe('/app');
    expect(document.title).toBe('Page not found — HighPal');
    expect(document.head.querySelector('link[rel="canonical"]')).toBeNull();
    expect(document.head.querySelector('meta[name="robots"]')?.getAttribute('content')).toBe('noindex');

    act(() => navigate('/'));
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Read it. Ask it. Edit it.');
    expect(document.head.querySelector('meta[name="robots"]')).toBeNull();
    expect(document.head.querySelector('link[rel="canonical"]')?.getAttribute('href')).toBe('https://highpal.ai/');
  });
});
