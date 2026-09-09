export type SiteRoute = 'landing' | 'app' | 'privacy' | 'terms' | 'support' | 'verify'
  | { kind: 'tools' } | { kind: 'tool'; slug: string };

function normalizePath(pathname: string): string {
  const trimmed = pathname.replace(/^\/+|\/+$/g, '');
  return trimmed ? `/${trimmed}` : '/';
}

export function resolveRoute(pathname: string, hash: string): SiteRoute {
  const hashRoute = hash.replace(/^#\/?/, '').replace(/\/+$/g, '');
  if (hashRoute === 'verify') return 'verify';

  const path = normalizePath(pathname);
  if (path === '/tools') return { kind: 'tools' };
  if (path.startsWith('/tools/')) {
    const slug = path.slice('/tools/'.length);
    return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) ? { kind: 'tool', slug } : { kind: 'tools' };
  }

  switch (path) {
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
