// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getPath, navigate, subscribe } from './navigate';

describe('in-page navigation', () => {
  const unsubscribers: Array<() => void> = [];

  beforeEach(() => {
    window.history.replaceState({}, '', '/');
  });

  afterEach(() => {
    unsubscribers.splice(0).forEach((unsubscribe) => unsubscribe());
  });

  it('updates the URL and notifies subscribers without replacing the document', () => {
    const originalDocument = window.document;
    const listener = vi.fn();
    unsubscribers.push(subscribe(listener));

    navigate('/privacy');

    expect(window.location.pathname).toBe('/privacy');
    expect(getPath()).toBe('/privacy');
    expect(listener).toHaveBeenCalledTimes(1);
    expect(window.document).toBe(originalDocument);
  });

  it('notifies on browser history changes', () => {
    const listener = vi.fn();
    unsubscribers.push(subscribe(listener));

    window.history.replaceState({}, '', '/support');
    window.dispatchEvent(new PopStateEvent('popstate'));

    expect(listener).toHaveBeenCalledTimes(1);
    expect(getPath()).toBe('/support');
  });

  it('includes queries and the dev harness hash in the snapshot', () => {
    const listener = vi.fn();
    unsubscribers.push(subscribe(listener));
    window.history.replaceState({}, '', '/?check=export#verify');
    window.dispatchEvent(new HashChangeEvent('hashchange'));

    expect(listener).toHaveBeenCalledTimes(1);
    expect(getPath()).toBe('/?check=export#verify');
  });

  it('stops notifying an unsubscribed listener while other subscriptions stay active', () => {
    const removed = vi.fn();
    const active = vi.fn();
    const unsubscribe = subscribe(removed);
    unsubscribers.push(subscribe(active));
    unsubscribe();

    navigate('/terms');
    window.dispatchEvent(new PopStateEvent('popstate'));

    expect(removed).not.toHaveBeenCalled();
    expect(active).toHaveBeenCalledTimes(2);
  });
});
