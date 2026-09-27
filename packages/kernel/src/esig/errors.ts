/**
 * E-signature errors. Database refusals start with a stable code (EBMR-ESIG-NNN, or EBMR-IAM-NNN
 * when the identity module refused, for example a proxy-signing attempt); callers branch on it.
 */
export { ebmrCode, errorDetail } from '../identity/errors.ts';

export class EsigError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: { cause?: unknown }) {
    super(`${code} ${message}`, options);
    this.name = 'EsigError';
    this.code = code;
  }
}
