/**
 * Identity errors. Every refusal from the database carries a stable code (EBMR-IAM-NNN) at the start
 * of its message; the TypeScript side keeps that code so callers can branch on it.
 */

export class IdentityError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: { cause?: unknown }) {
    super(`${code} ${message}`, options);
    this.name = 'IdentityError';
    this.code = code;
  }
}

/** Authentication refused or failed. `reason` is for logs and the security unit, not for the user's screen. */
export class AuthenticationFailedError extends IdentityError {
  readonly reason: string;
  readonly locked: boolean;

  constructor(reason: string, locked: boolean) {
    super('EBMR-IAM-140', `authentication failed (${reason})`);
    this.name = 'AuthenticationFailedError';
    this.reason = reason;
    this.locked = locked;
  }
}

/** The stable EBMR code at the start of an error message (from the database or this module), if any. */
export function ebmrCode(error: unknown): string | undefined {
  if (error instanceof IdentityError) return error.code;
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  return /^(EBMR-[A-Z]+-\d{3})\b/.exec(message)?.[1];
}

/** The JSON DETAIL a database refusal carries (EBMR-IAM-040, -041, -054, -170), if any. */
export function errorDetail(error: unknown): Record<string, unknown> | undefined {
  const detail = (error as { detail?: unknown } | null)?.detail;
  if (typeof detail !== 'string' || detail === '') return undefined;
  try {
    const parsed: unknown = JSON.parse(detail);
    return parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}
