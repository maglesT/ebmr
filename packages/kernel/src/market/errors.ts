/**
 * Errors of the market-profile engine carry the same stable codes as the database functions
 * (EBMR-MKT-NNN), so a refusal reads the same whichever side detected it.
 */
export class MarketRuleError extends Error {
  override readonly name = 'MarketRuleError';
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(`${code} ${message}`);
  }
}

export interface RuleTableProblem {
  code: string;
  message: string;
}
