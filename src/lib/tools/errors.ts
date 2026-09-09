/**
 * An error whose message was written for the user and is safe to show as-is.
 * Anything else that reaches the tool page is replaced by a generic message.
 */
export class ToolError extends Error {
  readonly userFacing = true as const;

  constructor(message: string) {
    super(message);
    this.name = 'ToolError';
  }
}

/** Duck-typed so the check survives bundling / cross-realm quirks. */
export function isUserFacingError(error: unknown): error is Error & { readonly userFacing: true } {
  return error instanceof Error && (error as { userFacing?: unknown }).userFacing === true;
}
