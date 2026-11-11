import { useEffect, useRef, useState } from 'react';
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

const MENU_ID = 'site-nav-links';

export function SiteHeader({ compact = false }: { readonly compact?: boolean }) {
  // On phones the links fold into a ☰ menu (landing.css hides them under 760px).
  const [menuOpen, setMenuOpen] = useState(false);
  const headerRef = useRef<HTMLElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const closeOutside = (event: PointerEvent) => {
      if (!headerRef.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMenuOpen(false);
    };
    window.addEventListener('pointerdown', closeOutside);
    window.addEventListener('keydown', closeOnEscape);
    return () => {
      window.removeEventListener('pointerdown', closeOutside);
      window.removeEventListener('keydown', closeOnEscape);
    };
  }, [menuOpen]);

  return (
    <header ref={headerRef} className="site-header">
      {/* For keyboard users: jump past the header links straight to the page. */}
      <a className="site-skip" href="#main-content">Skip to content</a>
      <nav className={`site-shell site-nav${menuOpen ? ' is-open' : ''}`} aria-label="Main navigation">
        <Brand />
        {compact && <a className="site-nav__tools" href={siteHref('/tools')}>Tools</a>}
        {!compact && (
          <div className="site-nav__links" id={MENU_ID} onClick={() => setMenuOpen(false)}>
            <a href={siteHref('/tools')}>Tools</a>
            <a href={siteHref('#features')}>Features</a>
            <a href={siteHref('#how')}>How it Works</a>
            <a href={siteHref('#privacy')}>Privacy</a>
            <a href={siteHref('#faq')}>FAQ</a>
          </div>
        )}
        <a className="site-button site-button--small" href={siteHref('/app')}>Start editing</a>
        {!compact && (
          <button
            type="button"
            className="site-nav__menu"
            aria-expanded={menuOpen}
            aria-controls={MENU_ID}
            aria-label="Menu"
            onClick={() => setMenuOpen((open) => !open)}
          >
            <span aria-hidden="true">{menuOpen ? '✕' : '☰'}</span>
          </button>
        )}
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
