/**
 * What the ceremony signs for a signable action: the aggregate and the meaning, as the server computes them for the
 * action exactly as the person would send it (POST /api/esig/describe, Phase 3 slice 6). The browser never derives an
 * aggregate id or a meaning itself (e.g. qc_extra_testing:<batch>/<decision>/<tests>, or a lot rejected from
 * quarantine): where the person chooses (release or reject, extra tests or none), the screen asks once per choice.
 */
import { routes, type CallError, type SignableAction, type SignableDescriptorView } from '@ebmr/api-contract';
import { api } from './client.ts';

export interface SignSubject {
  aggregateType: string;
  aggregateId: string;
  meaning: string;
}

export type Described = { ok: true; subject: SignSubject; descriptor: SignableDescriptorView } | { ok: false; error: CallError };

/** The server's descriptor of `action`; refused when it names no meaning (the person must choose one first). */
export async function describeSignable(action: SignableAction): Promise<Described> {
  const r = await api.call(routes.esig.describe, { body: { action } });
  if (!r.ok) return { ok: false, error: r.error };
  const d = r.value;
  if (d.meaning === null) {
    return {
      ok: false,
      error: {
        kind: 'REFUSAL',
        status: 422,
        envelope: {
          refusal: { code: 'CLIENT_NO_MEANING', kind: 'NOT_ALLOWED', whatHappened: 'This act needs a choice before it can be signed.', why: 'The server named no meaning for it.', controls: [], whatYouCanDo: ['Choose what you decide, then sign.'], whoCanHelp: [] },
          correlationId: 'client',
          retryable: false,
        },
      },
    };
  }
  return { ok: true, subject: { aggregateType: d.aggregateType, aggregateId: d.aggregateId, meaning: d.meaning }, descriptor: d };
}
