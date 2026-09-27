/**
 * Kernel error codes. Database functions raise messages that start with a stable code such as
 * EBMR-PLAT-066; callers branch on the code, never on the wording.
 */
const CODE = /\bEBMR-[A-Z]+-\d{3}\b/;

/** The EBMR-<AREA>-<NNN> code of an error raised by the database or the kernel, if any. */
export function errorCode(error: unknown): string | undefined {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  return CODE.exec(message)?.[0];
}

export class KernelError extends Error {
  constructor(
    readonly code: string,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'KernelError';
  }
}

/** Wraps database errors that carry a kernel code as KernelError; other errors are returned unchanged. */
export function asKernelError(error: unknown): Error {
  if (!(error instanceof Error)) return new Error(String(error));
  const code = errorCode(error);
  if (code && !(error instanceof KernelError)) return new KernelError(code, error.message, { cause: error });
  return error;
}
