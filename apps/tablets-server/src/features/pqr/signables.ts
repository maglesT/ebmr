/**
 * The AP's sign-off of a PQR extract (Phase 4 slice 6c; signable action PQR_SIGN_OFF). It signs the extract the
 * database act works on and runs that act with the signature in the same transaction; the database decides (recipe-core
 * 0910: the AP's own signature as AUTHORISED_PERSON, the signer outside the reviewed batches' records, the extract still
 * reproducing and reconciled, once) and a refusal signs nothing (esig/db-acts.ts).
 *
 *   PQR_SIGN_OFF  pqr_extract <extract id>  PQR_SIGNED_OFF (AP), state EXTRACTED  recipe.sign_off_pqr
 */
import type { SignableAction } from '@ebmr/api-contract';
import type { AppContext } from '../../platform/context.ts';
import type { SignableActionHandler } from '../../platform/ports.ts';
import { dbActHandler } from '../esig/db-acts.ts';

type PqrSignOff = Extract<SignableAction, { kind: 'PQR_SIGN_OFF' }>;

export function pqrSignOffHandler(app: AppContext): SignableActionHandler<PqrSignOff> {
  return dbActHandler<PqrSignOff>(app, {
    kind: 'PQR_SIGN_OFF',
    aggregateTypes: ['pqr_extract'],
    target: (a) => ({ aggregateType: 'pqr_extract', aggregateId: a.extractId, meaning: 'PQR_SIGNED_OFF', expectedState: 'EXTRACTED' }),
    async apply(client, _ctx, a, signatureId) {
      const { rows } = await client.query<{ id: string }>('select recipe.sign_off_pqr($1, $2) as id', [a.extractId, signatureId]);
      return { extractId: a.extractId, signOffId: rows[0]!.id };
    },
  });
}
