import { lazy, Suspense, useSyncExternalStore } from 'react';
import { Landing } from './components/Landing';
import { NotFoundPage } from './components/NotFoundPage';
import { StaticSitePage } from './components/StaticSitePage';
import { routePageMeta } from './lib/site/pageMeta';
import { resolveRoute } from './lib/site/routes';
import { getPath, subscribe } from './lib/site/navigate';
import { usePageMeta } from './lib/site/usePageMeta';
import { editorPart, toolsPart } from './siteParts';

const VerifyPage = import.meta.env.DEV ? lazy(() => import('./harness/VerifyPage')) : null;

export function Root() {
  const path = useSyncExternalStore(subscribe, getPath);
  const url = new URL(path, window.location.origin);
  const resolved = resolveRoute(url.pathname, url.hash);
  // The developer test page exists only on the local server.
  const route = resolved === 'verify' && !(import.meta.env.DEV && VerifyPage) ? 'notFound' : resolved;
  // Tool pages set their own name card; every other page's comes from the list in pageMeta.
  usePageMeta(typeof route === 'object' ? undefined : routePageMeta(route));

  if (typeof route === 'object') {
    const ToolsApp = toolsPart.component();
    return <Suspense fallback={<div className="p-6 text-neutral-500">Opening tools…</div>}>
      <ToolsApp slug={route.kind === 'tool' ? route.slug : undefined} />
    </Suspense>;
  }

  if (route === 'verify' && VerifyPage) {
    return (
      <Suspense fallback={<div className="p-6 text-neutral-500">Loading harness…</div>}>
        <VerifyPage />
      </Suspense>
    );
  }

  if (route === 'app') {
    const App = editorPart.component();
    return (
      <Suspense fallback={<div className="flex min-h-full items-center justify-center bg-neutral-100 text-neutral-500">Opening editor…</div>}>
        <App />
      </Suspense>
    );
  }

  if (route === 'privacy' || route === 'terms' || route === 'support') {
    return <StaticSitePage kind={route} />;
  }

  if (route === 'notFound') return <NotFoundPage />;

  return <Landing />;
}
