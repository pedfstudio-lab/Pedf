export interface ProviderConfig {
  readonly mode: 'direct' | 'proxy';
  readonly sarvamBaseUrl: string;
  readonly getSarvamKey: () => string;
}

/** Task 20 supplies the direct-mode key; production keeps all credentials in the Worker proxy. */
export const providerConfig: ProviderConfig = {
  mode: import.meta.env.PROD ? 'proxy' : 'direct',
  sarvamBaseUrl: import.meta.env.PROD ? '/api/sarvam' : 'https://api.sarvam.ai',
  getSarvamKey: () => import.meta.env.PROD ? '' : getSarvamKey(),
};
import { getSarvamKey } from './keys';
