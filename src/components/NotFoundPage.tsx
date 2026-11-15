import { siteHref } from '@/lib/site/config';
import { StaticPageShell } from './SiteChrome';

/** Shown for an address that isn't a HighPal page (an old link or a typo). */
export function NotFoundPage() {
  return (
    <StaticPageShell>
      <main id="main-content" className="site-static site-shell">
        <p className="site-eyebrow">Page not found</p>
        <h1>We couldn’t find that page.</h1>
        <p>The link may be old, or the address may have a typo. Try one of these instead:</p>
        <ul className="site-static__links">
          <li><a className="site-button" href={siteHref('/app')}>Open the PDF editor</a></li>
          <li><a href={siteHref('/tools')}>Free PDF tools</a></li>
          <li><a href={siteHref()}>Home page</a></li>
        </ul>
      </main>
    </StaticPageShell>
  );
}
