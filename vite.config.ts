import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { readFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';
import { handleSarvamProxy } from './src/server/sarvamProxy';

/** SARVAM_API_KEY from the git-ignored .dev.vars file (the same file `wrangler dev` reads). */
function localSarvamKey(): string {
  try {
    const file = readFileSync(new URL('./.dev.vars', import.meta.url), 'utf8');
    return file.match(/^\s*SARVAM_API_KEY\s*=\s*"?([^"\r\n]*)"?\s*$/m)?.[1]?.trim() ?? '';
  } catch {
    return '';
  }
}

/**
 * Local development runs the same Sarvam route as the live site, so the key stays on this
 * computer's dev server and never reaches the browser. Read on every request: pasting the
 * key into .dev.vars works without a restart.
 */
function localSarvamRoute(): Plugin {
  return {
    name: 'pedf-local-sarvam-route',
    configureServer(server) {
      server.middlewares.use('/api/sarvam/', (request, response) => {
        void (async () => {
          const chunks: Buffer[] = [];
          for await (const chunk of request) chunks.push(chunk as Buffer);
          const headers = new Headers();
          for (const [name, value] of Object.entries(request.headers)) {
            if (typeof value === 'string') headers.set(name, value);
          }
          const url = `http://${request.headers.host ?? 'localhost'}/api/sarvam${request.url ?? ''}`;
          const body = chunks.length ? Buffer.concat(chunks) : undefined;
          const result = await handleSarvamProxy(new Request(url, { method: request.method, headers, body }), { apiKey: localSarvamKey() });
          response.statusCode = result.status;
          result.headers.forEach((value, name) => response.setHeader(name, value));
          response.end(Buffer.from(await result.arrayBuffer()));
        })().catch((error: unknown) => {
          response.statusCode = 502;
          response.end(`Local Sarvam route failed: ${String(error)}`);
        });
      });
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
