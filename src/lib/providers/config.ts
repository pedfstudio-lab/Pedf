import { ensurePass, resetPass } from '@/lib/turnstile/pass';

export interface ProviderConfig {
  readonly mode: 'direct' | 'proxy';
  readonly sarvamBaseUrl: string;
  readonly getSarvamKey: () => string;
  /** Runs the human check (Turnstile) before a Sarvam request, if the site uses one. */
  readonly ensureAccess?: () => Promise<void>;
  /** The route said the check is missing or expired: run it again next time. */
  readonly resetAccess?: () => void;
}

/**
 * Every Sarvam request goes through the site's own route (/api/sarvam), which adds the
 * owner's key on the server: the Cloudflare secret SARVAM_API_KEY on the live site, the
 * private .dev.vars file during local development (vite.config.ts). The browser never holds
 * a key. "direct" mode remains only for tests.
 *
 * The route also wants a human-check pass (src/server/humanPass.ts); tests have no browser
 * to run Turnstile in, so they skip it.
 */
export const providerConfig: ProviderConfig = {
  mode: 'proxy',
  sarvamBaseUrl: '/api/sarvam',
  getSarvamKey: () => '',
  ...(import.meta.env.MODE === 'test' ? {} : { ensureAccess: ensurePass, resetAccess: resetPass }),
};
