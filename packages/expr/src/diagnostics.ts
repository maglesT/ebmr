/**
 * Design-time diagnostics (parser, checker, unit rules). Errors block; warnings need a recorded
 * justification (outline 6.3); INFO is advisory. Every message is plain language first and ends
 * with the rule code and the control it serves, e.g. "(EXPR-TAG-001, DI-33)".
 */
export type Severity = 'ERROR' | 'WARNING' | 'INFO';

export interface Diagnostic {
  /** Stable rule code, e.g. "EXPR-UNIT-003". */
  readonly code: string;
  readonly severity: Severity;
  /** Plain language first; ends with "(<code>, <control>)". */
  readonly message: string;
  /** Control (or invariant) the rule serves. */
  readonly control: string;
  /** Source span (character offsets into the expression) where known. */
  readonly start?: number;
  readonly end?: number;
  /** Warnings need a recorded justification before the MBR can be submitted. */
  readonly requiresJustification: boolean;
}

export interface Span {
  readonly start: number;
  readonly end: number;
}

export function diagnostic(code: string, severity: Severity, text: string, span?: Span, control = 'DI-33'): Diagnostic {
  return {
    code,
    severity,
    message: `${text} (${code}, ${control})`,
    control,
    ...(span === undefined ? {} : { start: span.start, end: span.end }),
    requiresJustification: severity === 'WARNING',
  };
}

export function hasErrors(diagnostics: readonly Diagnostic[]): boolean {
  return diagnostics.some((d) => d.severity === 'ERROR');
}
