import { handleSarvamProxy } from '../../../src/server/sarvamProxy';

interface SarvamProxyEnvironment {
  readonly SARVAM_API_KEY: string;
  readonly APP_ORIGINS?: string;
}

type PagesFunction<Environment> = (context: {
  readonly request: Request;
  readonly env: Environment;
}) => Response | Promise<Response>;

function allowedOrigins(value?: string): string[] | undefined {
  const origins = value?.split(',').map((origin) => origin.trim()).filter(Boolean);
  return origins && origins.length > 0 ? origins : undefined;
}

export const onRequest: PagesFunction<SarvamProxyEnvironment> = ({ request, env }) => (
  handleSarvamProxy(request, {
    apiKey: env.SARVAM_API_KEY ?? '',
    allowedOrigins: allowedOrigins(env.APP_ORIGINS),
  })
);
