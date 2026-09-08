import { lazy, Suspense, useSyncExternalStore } from 'react';
import { Landing } from './components/Landing';
import { StaticSitePage } from './components/StaticSitePage';
import { resolveRoute } from './lib/site/routes';
import { getPath, subscribe } from './lib/site/navigate';

const App = lazy(() => import('./App'));
const VerifyPage = import.meta.env.DEV ? lazy(() => import('./harness/VerifyPage')) : null;

export function Root() {
  const path = useSyncExternalStore(subscribe, getPath);
  const url = new URL(path, window.location.origin);
  const route = resolveRoute(url.pathname, url.hash);

  if (import.meta.env.DEV && VerifyPage && route === 'verify') {
    return (
      <Suspense fallback={<div className="p-6 text-neutral-500">Loading harness…</div>}>
        <VerifyPage />
      </Suspense>
    );
  }

  if (route === 'app') {
    return (
      <Suspense fallback={<div className="flex min-h-full items-center justify-center bg-neutral-100 text-neutral-500">Opening editor…</div>}>
        <App />
      </Suspense>
    );
  }

  if (route === 'privacy' || route === 'terms' || route === 'support') {
    return <StaticSitePage kind={route} />;
  }

  return <Landing />;
}
