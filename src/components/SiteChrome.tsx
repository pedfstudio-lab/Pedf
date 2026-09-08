import type { ReactNode } from 'react';
import { siteHref } from '@/lib/site/config';

export function Brand() {
  return (
    <a className="site-brand" href={siteHref()} aria-label="PEDF Studio home">
      <span className="site-brand__mark" aria-hidden="true">
        <svg viewBox="0 0 34 34" fill="none">
          <path d="M8 5.5h12.5L27 12v16.5H8z" fill="white" />
          <path d="M20.5 5.5V12H27" stroke="#83C9FF" strokeWidth="2" />
          <path d="M4 22h15m-5-5 5 5-5 5" stroke="#0868FF" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </span>
      <span><strong>PEDF</strong> Studio</span>
    </a>
  );
}

export function SiteHeader({ compact = false }: { readonly compact?: boolean }) {
  return (
    <header className="site-header">
      <nav className="site-shell site-nav" aria-label="Main navigation">
        <Brand />
        {!compact && (
          <div className="site-nav__links">
            <a href={siteHref('#features')}>Features</a>
            <a href={siteHref('#how')}>How it Works</a>
            <a href={siteHref('#privacy')}>Privacy</a>
            <a href={siteHref('#faq')}>FAQ</a>
          </div>
        )}
        <a className="site-button site-button--small" href={siteHref('/app')}>Try it free</a>
      </nav>
    </header>
  );
}

export function SiteFooter() {
  return (
    <footer className="site-footer">
      <div className="site-shell site-footer__inner">
        <Brand />
        <nav aria-label="Footer navigation">
          <a href={siteHref('/privacy')}>Privacy</a>
          <a href={siteHref('/terms')}>Terms</a>
          <a href={siteHref('/support')}>Support</a>
        </nav>
        <p>© 2026 PEDF Studio</p>
      </div>
    </footer>
  );
}

export function StaticPageShell({ children }: { readonly children: ReactNode }) {
  return (
    <div className="site-page">
      <SiteHeader compact />
      {children}
      <SiteFooter />
    </div>
  );
}
