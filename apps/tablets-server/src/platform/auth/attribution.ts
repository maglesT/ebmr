/**
 * Per-entry attribution on SHARED and GRADE_A_B terminals (INV-40; plan section 5; decision D8).
 *
 * STUB created by the lead's spine (C0). Ownership passes to module C1, which replaces this file: verify the
 * proof, authenticate BADGE_TAP with purpose COMMAND on the authentication pool, require the session's own
 * person (else 409 SWITCH_USER with the tapper's name), and return the authentication event, which
 * begin_command then consumes. Until then every FRESH_ON_SHARED route on a shared terminal answers 428.
 */
import type { Attribution } from '@ebmr/api-contract';
import type { AppContext } from '../context.ts';
import { refusal } from '../http/refusal.ts';
import type { ResolvedSession } from './session.ts';

export interface AttributionInput {
  app: AppContext;
  session: ResolvedSession;
  attribution: Attribution | undefined;
  method: string;
  /** URL path without the query string. */
  path: string;
  /** The request body (the attribution member is excluded from the proof and the request hash). */
  body: unknown;
}

export interface AttributionResult {
  /** The BADGE_TAP authentication event the command consumes (ActorContext.authEventId). */
  authEventId: string;
}

export function resolveAttribution(input: AttributionInput): Promise<AttributionResult> {
  if (!input.attribution) {
    return Promise.reject(
      refusal(428, {
        code: 'TAP_REQUIRED',
        kind: 'NOT_ALLOWED',
        whatHappened: 'Tap your badge to confirm it is you.',
        why: 'Every entry on a shared terminal is confirmed by a fresh badge tap of the signed-in person (INV-40).',
        controls: ['DI-14'],
        whatYouCanDo: ['Tap your badge on the reader, then send again.'],
      }),
    );
  }
  return Promise.reject(
    refusal(428, {
      code: 'ATTRIBUTION_NOT_ENABLED',
      kind: 'NOT_ENABLED',
      whatHappened: 'Badge confirmation is not available on this installation yet.',
      why: 'Per-entry attribution arrives with the kiosk access module.',
      controls: ['DI-14'],
      whatYouCanDo: ['Use an office terminal for now.'],
    }),
  );
}
