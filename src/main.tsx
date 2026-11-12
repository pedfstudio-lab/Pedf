import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Root } from './routes';
import { clearSarvamKey } from './lib/providers/keys';
import './index.css';

// Sarvam keys now live only on the server (the site's /api/sarvam route). Remove any key an
// older version stored in this browser's Settings.
clearSarvamKey();

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('#root element missing from index.html');

createRoot(rootEl).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
