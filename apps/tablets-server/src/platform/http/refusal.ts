/**
 * Refusals as HTTP answers (Phase 2 apps plan section 4, "Refusal envelope"). Handlers throw HttpRefusal;
 * the error mapper turns it (and any kernel or engine error) into a RefusalEnvelope with the right status.
 */
import type { Refusal, RefusalKind } from '@ebmr/api-contract';

export class HttpRefusal extends Error {
  constructor(
    readonly status: number,
    readonly refusal: Refusal,
    readonly retryable = false,
    options?: { cause?: unknown },
  ) {
    super(`${refusal.code}: ${refusal.whatHappened}`, options);
    this.name = 'HttpRefusal';
  }
}

export interface RefusalInput {
  code: string;
  kind: RefusalKind;
  whatHappened: string;
  why?: string;
  controls?: string[];
  whatYouCanDo?: string[];
  whoCanHelp?: string[];
  details?: Record<string, string>;
}

export function refusal(status: number, input: RefusalInput, retryable = false): HttpRefusal {
  return new HttpRefusal(
    status,
    {
      code: input.code,
      kind: input.kind,
      whatHappened: input.whatHappened,
      why: input.why ?? '',
      controls: input.controls ?? [],
      whatYouCanDo: input.whatYouCanDo ?? [],
      whoCanHelp: input.whoCanHelp ?? [],
      ...(input.details ? { details: input.details } : {}),
    },
    retryable,
  );
}
