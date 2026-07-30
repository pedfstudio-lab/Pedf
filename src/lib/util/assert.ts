export function assertNever(value: never, message = 'unexpected variant'): never {
  throw new Error(`${message}: ${JSON.stringify(value)}`);
}

export function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(`Invariant failed: ${message}`);
  }
}

export function notImplemented(feature: string): never {
  throw new Error(`Not implemented yet: ${feature}`);
}
