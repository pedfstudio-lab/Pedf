import { lazy, Suspense } from 'react';
import App from './App';

const VerifyPage = import.meta.env.DEV ? lazy(() => import('./harness/VerifyPage')) : null;

function isVerifyRoute(): boolean {
  const pathname = location.pathname.replace(/\/+$/, '');
  const hash = location.hash.replace(/^#\/?/, '');
  return pathname === '/verify' || hash === 'verify';
}

export function Root() {
  if (import.meta.env.DEV && VerifyPage && isVerifyRoute()) {
    return (
      <Suspense fallback={<div className="p-6 text-neutral-500">Loading harness…</div>}>
        <VerifyPage />
      </Suspense>
    );
  }

  return <App />;
}
