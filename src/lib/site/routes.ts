export type SiteRoute = 'landing' | 'app' | 'privacy' | 'terms' | 'support' | 'verify';

function normalizePath(pathname: string): string {
  const trimmed = pathname.replace(/^\/+|\/+$/g, '');
  return trimmed ? `/${trimmed}` : '/';
}

export function resolveRoute(pathname: string, hash: string): SiteRoute {
  const hashRoute = hash.replace(/^#\/?/, '').replace(/\/+$/g, '');
  if (hashRoute === 'verify') return 'verify';

  switch (normalizePath(pathname)) {
    case '/app':
      return 'app';
    case '/privacy':
      return 'privacy';
    case '/terms':
      return 'terms';
    case '/support':
      return 'support';
    case '/verify':
      return 'verify';
    default:
      return 'landing';
  }
}
