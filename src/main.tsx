import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Root } from './routes';
import { preloadRoute } from './siteParts';
import { clearSarvamKey } from './lib/providers/keys';
import './index.css';

// Sarvam keys now live only on the server (the site's /api/sarvam route). Remove any key an
// older version stored in this browser's Settings.
clearSarvamKey();

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('#root element missing from index.html');

// Each address arrives as a ready-made page (built for search engines). Load that page's code
// first, then swap in the live page in one step, so there's no "loading" flash in between.
const startSite = () => createRoot(rootEl).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
preloadRoute(window.location.pathname, window.location.hash).then(startSite, startSite);
