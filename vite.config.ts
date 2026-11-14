import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';
import { handlePassRequest, hasValidPass, passRequired } from './src/server/humanPass';
import { clientIp, handleSarvamProxy } from './src/server/sarvamProxy';

/** A value from the git-ignored .dev.vars file (the same file `wrangler dev` reads). */
function devVar(name: string): string {
  try {
    const file = readFileSync(new URL('./.dev.vars', import.meta.url), 'utf8');
    return file.match(new RegExp(`^\\s*${name}\\s*=\\s*"?([^"\\r\\n]*)"?\\s*$`, 'm'))?.[1]?.trim() ?? '';
  } catch {
    return '';
  }
}

const localSarvamKey = () => devVar('SARVAM_API_KEY');
/**
 * Cloudflare's published always-pass test secret, matching the test site keys the page uses
 * locally (src/lib/turnstile/siteKey.ts). Not a real secret. TURNSTILE_SECRET_KEY in
 * .dev.vars overrides it.
 */
const localTurnstileSecret = () => devVar('TURNSTILE_SECRET_KEY') || '1x0000000000000000000000000000000AA';

/** Runs a fetch-style handler for a Node request from the dev server. */
function nodeRoute(prefix: string, handle: (request: Request) => Promise<Response>) {
  return (request: IncomingMessage, response: ServerResponse) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk as Buffer);
      const headers = new Headers();
      for (const [name, value] of Object.entries(request.headers)) {
        if (typeof value === 'string') headers.set(name, value);
      }
      const url = `http://${request.headers.host ?? 'localhost'}${prefix}${request.url ?? ''}`;
      const body = chunks.length ? Buffer.concat(chunks) : undefined;
      const result = await handle(new Request(url, { method: request.method, headers, body }));
      response.statusCode = result.status;
      result.headers.forEach((value, name) => response.setHeader(name, value));
      response.end(Buffer.from(await result.arrayBuffer()));
    })().catch((error: unknown) => {
      response.statusCode = 502;
      response.end(`Local route failed: ${String(error)}`);
    });
  };
}

/**
 * Local development runs the same Sarvam route as the live site, so the key stays on this
 * computer's dev server and never reaches the browser. Read on every request: pasting the
 * key into .dev.vars works without a restart. The human check works the same way too, with
 * Cloudflare's test keys (live connections, /…/ws, are not checked locally).
 */
function localSarvamRoute(): Plugin {
  return {
    name: 'pedf-local-sarvam-route',
    configureServer(server) {
      server.middlewares.use('/api/pass', nodeRoute('/api/pass', (request) => handlePassRequest(request, {
        secret: localTurnstileSecret(),
        clientIp,
        secureCookie: false,
      })));
      server.middlewares.use('/api/sarvam/', nodeRoute('/api/sarvam', async (request) => {
        if (!await hasValidPass(request, localTurnstileSecret())) return passRequired();
        return handleSarvamProxy(request, { apiKey: localSarvamKey() });
      }));
    },
  };
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss(), localSarvamRoute()],
  server: {
    proxy: {
      // Live connections (Conversation, spoken answers): the dev server adds the key from
      // .dev.vars in a header, like the live site's route. The browser never holds it.
      '^/api/sarvam/(?:text-to-speech|speech-to-text-realtime)/ws': {
        target: 'wss://api.sarvam.ai',
        ws: true,
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/sarvam/, ''),
        configure: (proxy) => {
          proxy.on('proxyReqWs', (proxyRequest) => {
            proxyRequest.setHeader('api-subscription-key', localSarvamKey());
            proxyRequest.removeHeader('origin');
          });
        },
      },
    },
  },
  // Root-domain hosting: keep asset URLs absolute for deep links such as /app/.
  base: '/',
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  // pdf.js ships an ES-module worker; keep worker output as ESM.
  worker: { format: 'es' },
  build: { target: 'es2022' },
});
