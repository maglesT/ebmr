/** A value handed to analytics that is not what the package accepts (for example text that is not a decimal). */
export class AnalyticsInputError extends Error {
  override readonly name = 'AnalyticsInputError';
  constructor(
    message: string,
    /** The offending value, as given. */
    readonly value: unknown,
  ) {
    super(message);
  }
}
