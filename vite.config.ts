import { build, defineConfig, type Plugin, type ResolvedConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL, URL } from 'node:url';
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
  const mountRoutes = (middlewares: { use(path: string, handler: (request: IncomingMessage, response: ServerResponse) => void): unknown }) => {
    middlewares.use('/api/pass', nodeRoute('/api/pass', (request) => handlePassRequest(request, {
      secret: localTurnstileSecret(),
      clientIp,
      secureCookie: false,
    })));
    middlewares.use('/api/sarvam/', nodeRoute('/api/sarvam', async (request) => {
      if (!await hasValidPass(request, localTurnstileSecret())) return passRequired();
      return handleSarvamProxy(request, { apiKey: localSarvamKey() });
    }));
  };
  return {
    name: 'pedf-local-sarvam-route',
    configureServer: (server) => mountRoutes(server.middlewares),
    // `vite preview` serves the finished build, so the live site's safety rules can be tried here.
    configurePreviewServer: (server) => mountRoutes(server.middlewares),
  };
}

/** The live site's safety rules (public/_headers), so `vite preview` behaves like highpal.ai. */
function liveSiteHeaders(): Record<string, string> {
  const headers: Record<string, string> = {};
  try {
    const file = readFileSync(new URL('./public/_headers', import.meta.url), 'utf8');
    for (const line of file.split(/\r?\n/)) {
      const match = line.match(/^\s+([A-Za-z-]+):\s*(.+)$/);
      if (match) headers[match[1]!] = match[2]!.trim();
    }
  } catch {
    // No rules file: preview without them.
  }
  return headers;
}

/**
 * After every build (on this laptop and on Cloudflare): draw each website page in advance
 * (src/prerender.tsx) into its own file, such as dist/tools/merge.html, with its own title,
 * description and real address, plus dist/404.html for addresses that aren't pages. Search
 * engines, AI assistants and link previews can then read every page without JavaScript.
 */
function readyMadePages(): Plugin {
  let config: ResolvedConfig;
  // The tools pages and the editor load their own code (and the tools pages their own styles) on
  // demand. Their ready-made pages name those files up front, so they look right straight away
  // and the live page can take over sooner.
  const partFiles: Record<'tools' | 'editor', { css: string[]; js: string[] }> = { tools: { css: [], js: [] }, editor: { css: [], js: [] } };
  return {
    name: 'highpal-ready-made-pages',
    apply: 'build',
    configResolved(resolved) {
      config = resolved;
    },
    generateBundle(_options, bundle) {
      if (config.build.ssr) return;
      for (const chunk of Object.values(bundle)) {
        if (chunk.type !== 'chunk' || !chunk.facadeModuleId) continue;
        const id = chunk.facadeModuleId.replaceAll('\\', '/');
        const part = id.endsWith('/src/components/tools/ToolsApp.tsx') ? 'tools' : id.endsWith('/src/App.tsx') ? 'editor' : undefined;
        if (!part) continue;
        // The part's own styles plus those of the shared files it needs straight away.
        const css = new Set(chunk.viteMetadata?.importedCss ?? []);
        for (const imported of chunk.imports) {
          const shared = bundle[imported];
          if (shared?.type === 'chunk') for (const file of shared.viteMetadata?.importedCss ?? []) css.add(file);
        }
        partFiles[part] = { css: [...css], js: [chunk.fileName, ...chunk.imports] };
      }
    },
    async closeBundle() {
      if (config.build.ssr) return; // the drawing step's own build, below
      const outDir = resolve(config.root, config.build.outDir);
      const workDir = resolve(config.root, 'node_modules/.highpal-ready-made');
      await build({
        configFile: config.configFile,
        mode: config.mode,
        logLevel: 'warn',
        build: {
          ssr: 'src/prerender.tsx',
          outDir: workDir,
          emptyOutDir: true,
          copyPublicDir: false,
          rollupOptions: { output: { entryFileNames: 'prerender.mjs' } },
        },
      });
      const { prerenderSite } = await import(pathToFileURL(join(workDir, 'prerender.mjs')).href) as {
        prerenderSite(template: string): { file: string; html: string }[];
      };
      const files = prerenderSite(readFileSync(join(outDir, 'index.html'), 'utf8'));
      // Only files the page doesn't already name (the main script and styles are in every page).
      const partLinks = (part: 'tools' | 'editor', html: string) => [
        ...partFiles[part].css.filter((file) => !html.includes(`${config.base}${file}`))
          .map((file) => `<link rel="stylesheet" crossorigin href="${config.base}${file}">`),
        ...partFiles[part].js.filter((file) => !html.includes(`${config.base}${file}`))
          .map((file) => `<link rel="modulepreload" crossorigin href="${config.base}${file}">`),
      ].join('\n    ');
      if (!partFiles.tools.js.length || !partFiles.tools.css.length || !partFiles.editor.js.length) {
        throw new Error('Ready-made pages: could not find the tools or editor code in the build.');
      }
      for (const { file, html } of files) {
        const part = file === 'tools.html' || file.startsWith('tools/') ? 'tools' : file === 'app.html' ? 'editor' : undefined;
        const target = join(outDir, file);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, part ? html.replace('</head>', () => `  ${partLinks(part, html)}\n  </head>`) : html);
      }
      rmSync(workDir, { recursive: true, force: true });
      config.logger.info(`Ready-made pages: ${files.length} written.`);
    },
  };
}

/**
 * `vite preview` answers like Cloudflare does: /tools/merge serves tools/merge.html, /app/
 * moves to /app, and an address that isn't a page gets 404.html with a "not found" status.
 */
function liveNotFound(): Plugin {
  return {
    name: 'highpal-live-not-found',
    configurePreviewServer(server) {
      const outDir = resolve(server.config.root, server.config.build.outDir);
      const isFile = (path: string) => existsSync(path) && statSync(path).isFile();
      server.middlewares.use((request, response, next) => {
        if (request.method !== 'GET' && request.method !== 'HEAD') return next();
        const address = new URL(request.url ?? '/', 'http://local');
        const pathname = decodeURIComponent(address.pathname);
        if (pathname === '/' || pathname.startsWith('/api/') || isFile(join(outDir, pathname))) return next();
        const trimmed = pathname.replace(/\/+$/, '');
        if (isFile(join(outDir, `${trimmed}.html`))) {
          if (trimmed !== pathname) {
            response.writeHead(307, { location: `${trimmed}${address.search}` });
            return response.end();
          }
          request.url = `${trimmed}.html${address.search}`;
          return next();
        }
        if (!isFile(join(outDir, '404.html'))) return next();
        response.writeHead(404, { ...liveSiteHeaders(), 'content-type': 'text/html; charset=utf-8' });
        response.end(readFileSync(join(outDir, '404.html')));
      });
    },
  };
}

// Live connections (Conversation, spoken answers): the local server adds the key from
// .dev.vars in a header, like the live site's route. The browser never holds it.
const liveConnections = {
  '^/api/sarvam/(?:text-to-speech|speech-to-text-realtime)/ws': {
    target: 'wss://api.sarvam.ai',
    ws: true,
    changeOrigin: true,
    rewrite: (path: string) => path.replace(/^\/api\/sarvam/, ''),
    configure: (proxy: { on(event: 'proxyReqWs', listener: (request: { setHeader(name: string, value: string): void; removeHeader(name: string): void }) => void): void }) => {
      proxy.on('proxyReqWs', (proxyRequest) => {
        proxyRequest.setHeader('api-subscription-key', localSarvamKey());
        proxyRequest.removeHeader('origin');
      });
    },
  },
};

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss(), localSarvamRoute(), readyMadePages(), liveNotFound()],
  server: { proxy: liveConnections },
  preview: { proxy: liveConnections, headers: liveSiteHeaders() },
  // Root-domain hosting: keep asset URLs absolute for deep links such as /app/.
  base: '/',
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  // pdf.js ships an ES-module worker; keep worker output as ESM.
  worker: { format: 'es' },
  build: { target: 'es2022' },
});
