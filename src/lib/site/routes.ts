export type SiteRoute = 'landing' | 'app' | 'privacy' | 'terms' | 'support' | 'verify' | 'notFound'
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
    // Any well-formed name is looked up by the tools page, which shows "page not found" for an
    // unknown tool; anything else (nested or strange paths) is not a page.
    return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) ? { kind: 'tool', slug } : 'notFound';
  }

  switch (path) {
    case '/':
    case '/index.html':
      return 'landing';
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
      // An old link or a typo: say so, instead of quietly showing the home page.
      return 'notFound';
  }
}
