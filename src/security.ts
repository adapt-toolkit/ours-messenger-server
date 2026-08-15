import { randomUUID } from 'node:crypto';

export interface PublicErrorBody {
  readonly code: string;
  readonly message: string;
  readonly correlationId?: string;
}

/** A fixed, source-authored configuration message safe for operator output. */
export class ConfigurationError extends Error {
  override readonly name = 'ConfigurationError';
}

export function operatorError(
  error: unknown,
  context: string,
  write: (message: string) => void,
): void {
  if (error instanceof ConfigurationError) {
    write(error.message);
    return;
  }
  if (hasErrorCode(error, 'INITIALIZATION_REQUIRED')) {
    write('INITIALIZATION_REQUIRED: messenger state is not initialized; run the offline init command before serve');
    return;
  }
  reportFailure(write, context, error);
}

function hasErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && (error as Error & { code?: unknown }).code === code;
}

/**
 * Deliberately do not interpolate an unknown error. Error strings can contain
 * tokens, invite material, message text, endpoints, URLs, and local paths.
 */
export function reportFailure(write: (message: string) => void, context: string, error: unknown): string {
  void error;
  const correlationId = randomUUID();
  write(`${context} failed (correlation ${correlationId})`);
  return correlationId;
}

export function publicInternalError(
  error: unknown,
  context: string,
  write: (message: string) => void = (message) => console.warn(`[messenger] ${message}`),
): PublicErrorBody {
  const correlationId = reportFailure(write, context, error);
  return { code: 'INTERNAL', message: 'Internal server error', correlationId };
}

// Only fixed messages from this table may preserve an engine code publicly.
// Unknown OursError text is never returned, even for a client-caused failure.
const SAFE_ENGINE_ERRORS: Readonly<Record<string, string>> = Object.freeze({
  NO_SUCH_CONTACT: 'Contact not found',
  NO_SUCH_IDENTITY: 'Identity not found',
  IDENTITY_IN_USE: 'Identity is in use',
  INVALID_INVITE: 'Invite is invalid',
  INVITE_ALREADY_USED: 'Invite is no longer available',
  INVITE_REVOKED: 'Invite is no longer available',
});

export function publicEngineError(code: string): PublicErrorBody {
  const message = SAFE_ENGINE_ERRORS[code];
  return message ? { code, message } : { code: 'REQUEST_REJECTED', message: 'Request rejected' };
}
