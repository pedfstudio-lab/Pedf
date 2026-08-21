const ALLOWED_PATHS = new Set([
  'text-to-speech',
  'speech-to-text',
  'v1/chat/completions',
]);

export const SARVAM_PROXY_PATHS = Object.freeze([...ALLOWED_PATHS]);
export const SARVAM_PROXY_MAX_BODY_BYTES = 12_000_000;

const UPSTREAM_ORIGIN = 'https://api.sarvam.ai';

export interface SarvamProxyOptions {
  readonly apiKey: string;
  readonly allowedOrigins?: readonly string[];
  readonly rateLimit?: (ip: string) => Promise<boolean>;
}

function endpointPath(request: Request): string {
  return new URL(request.url).pathname.replace(/^.*\/api\/sarvam\//, '');
}

function clientIp(headers: Headers): string {
  const cloudflareIp = headers.get('cf-connecting-ip')?.trim();
  if (cloudflareIp) return cloudflareIp;
  return headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
}

function forwardHeaders(source: Headers, apiKey: string): Headers {
  const headers = new Headers();
  const contentType = source.get('content-type');
  if (contentType) headers.set('content-type', contentType);
  headers.set('api-subscription-key', apiKey);
  return headers;
}

function passThroughHeaders(source: Headers): Headers {
  const headers = new Headers();
  for (const name of ['content-type', 'content-length']) {
    const value = source.get(name);
    if (value) headers.set(name, value);
  }
  return headers;
}

/** Forward one strictly-whitelisted Sarvam request without exposing the server key. */
export async function handleSarvamProxy(
  request: Request,
  options: SarvamProxyOptions,
): Promise<Response> {
  if (request.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  const path = endpointPath(request);
  if (!ALLOWED_PATHS.has(path)) {
    return new Response('Not found', { status: 404 });
  }

  const origin = request.headers.get('origin');
  if (
    options.allowedOrigins?.length &&
    (!origin || !options.allowedOrigins.includes(origin))
  ) {
    return new Response('Forbidden', { status: 403 });
  }

  const declaredSize = Number(request.headers.get('content-length') ?? 0);
  if (declaredSize > SARVAM_PROXY_MAX_BODY_BYTES) {
    return new Response('Payload too large', { status: 413 });
  }

  const apiKey = options.apiKey.trim();
  if (!apiKey) {
    return new Response('Proxy not configured', { status: 503 });
  }

  if (options.rateLimit && !await options.rateLimit(clientIp(request.headers))) {
    return new Response('Too many requests', { status: 429 });
  }

  const upstream = await fetch(`${UPSTREAM_ORIGIN}/${path}`, {
    method: 'POST',
    headers: forwardHeaders(request.headers, apiKey),
    body: request.body,
    // @ts-expect-error Node requires duplex for streamed request bodies; edge runtimes ignore it.
    duplex: 'half',
  });

  return new Response(upstream.body, {
    status: upstream.status,
    headers: passThroughHeaders(upstream.headers),
  });
}
