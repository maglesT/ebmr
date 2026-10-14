/**
 * QA's closure of a CAPA (Phase 6 slice 6a, builder B; signable action CAPA_ACT). It signs the CAPA the database act
 * works on and runs that act with the signature in the same transaction; the database decides (site services 0925:
 * implemented, every effectiveness check effective, the master version it waits for effective (PR-51), QA other than
 * the initiator) and a refusal signs nothing (esig/db-acts.ts).
 *
 *   CAPA_ACT CLOSE   capa <capa id>   CAPA_CLOSED (QA), state IMPLEMENTED   site.close_capa
 */
import type { SignableAction } from '@ebmr/api-contract';
import type { AppContext } from '../../platform/context.ts';
import type { SignableActionHandler } from '../../platform/ports.ts';
import { dbActHandler } from '../esig/db-acts.ts';

type CapaAct = Extract<SignableAction, { kind: 'CAPA_ACT' }>;

export function capaActHandler(app: AppContext): SignableActionHandler<CapaAct> {
  return dbActHandler<CapaAct>(app, {
    kind: 'CAPA_ACT',
    aggregateTypes: ['capa'],
    target: (a) => ({ aggregateType: 'capa', aggregateId: a.capaId, meaning: 'CAPA_CLOSED', expectedState: 'IMPLEMENTED' }),
    async apply(client, _ctx, a, signatureId) {
      await client.query('select site.close_capa($1, $2)', [a.capaId, signatureId]);
      return { act: a.act, capaId: a.capaId };
    },
  });
}
