import type { ProviderMethod } from './providerTypes';

export class NotSupportedError extends Error {
  constructor(
    readonly provider: string,
    readonly method: ProviderMethod,
  ) {
    super(`${provider} does not support ${method}`);
    this.name = 'NotSupportedError';
  }
}

export class NotImplementedError extends Error {
  constructor(
    readonly provider: string,
    readonly method: ProviderMethod,
  ) {
    super(`${provider}.${method} is not implemented yet`);
    this.name = 'NotImplementedError';
  }
}

export class ProviderChainError extends AggregateError {
  constructor(
    readonly method: ProviderMethod,
    errors: readonly unknown[],
    supportedProviderCount: number,
  ) {
    const providerLabel = supportedProviderCount === 1 ? 'provider' : 'providers';
    super(
      errors,
      supportedProviderCount === 0
        ? `No configured provider supports ${method}`
        : `All ${supportedProviderCount} supporting ${providerLabel} failed for ${method}`,
    );
    this.name = 'ProviderChainError';
  }
}
