import { siteHref } from './config';

const listeners = new Set<() => void>();

function notify(): void {
  listeners.forEach((listener) => listener());
}

export function getPath(): string {
  // A primitive snapshot stays stable between navigation events for React.
  return `${window.location.pathname}${window.location.search}${window.location.hash}`;
}

export function subscribe(listener: () => void): () => void {
  if (listeners.size === 0) {
    window.addEventListener('popstate', notify);
    window.addEventListener('hashchange', notify);
  }
  listeners.add(listener);

  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      window.removeEventListener('popstate', notify);
      window.removeEventListener('hashchange', notify);
    }
  };
}

export function navigate(path: string): void {
  window.history.pushState({}, '', siteHref(path));
  notify();
}
