import type { ProviderMethod } from './providerTypes';

export interface ProviderAttempt {
  readonly provider: string;
  readonly method: ProviderMethod;
  readonly ok: boolean;
  readonly ms: number;
  readonly error?: string;
}

const MAX_ATTEMPTS = 100;
let attempts: ProviderAttempt[] = [];

export function describeProviderError(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

export function logProviderAttempt(attempt: ProviderAttempt): void {
  attempts = [...attempts, attempt].slice(-MAX_ATTEMPTS);
  if (import.meta.env.DEV) console.info('[provider]', attempt);
}

export function getProviderLog(): readonly ProviderAttempt[] {
  return [...attempts];
}

export function clearProviderLog(): void {
  attempts = [];
}
