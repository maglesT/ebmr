/**
 * The AP's sign-off of a mock recall (Phase 6 slice 6d; signable action MOCK_RECALL_SIGN_OFF). It signs the mock recall
 * the database act works on and runs that act with the signature in the same transaction; the database decides
 * (recipe-core 1012: the AP's own signature as AUTHORISED_PERSON on the current content, the run still reproducing,
 * once) and a refusal signs nothing (esig/db-acts.ts).
 *
 *   MOCK_RECALL_SIGN_OFF  mock_recall <id>  MOCK_RECALL_SIGNED_OFF (AP), state RUN  recipe.sign_off_mock_recall
 */
import type { SignableAction } from '@ebmr/api-contract';
import type { AppContext } from '../../platform/context.ts';
import type { SignableActionHandler } from '../../platform/ports.ts';
import { dbActHandler } from '../esig/db-acts.ts';

type MockRecallSignOff = Extract<SignableAction, { kind: 'MOCK_RECALL_SIGN_OFF' }>;

export function mockRecallSignOffHandler(app: AppContext): SignableActionHandler<MockRecallSignOff> {
  return dbActHandler<MockRecallSignOff>(app, {
    kind: 'MOCK_RECALL_SIGN_OFF',
    aggregateTypes: ['mock_recall'],
    target: (a) => ({ aggregateType: 'mock_recall', aggregateId: a.mockRecallId, meaning: 'MOCK_RECALL_SIGNED_OFF', expectedState: 'RUN' }),
    async apply(client, _ctx, a, signatureId) {
      const { rows } = await client.query<{ id: string }>('select recipe.sign_off_mock_recall($1, $2) as id', [a.mockRecallId, signatureId]);
      return { mockRecallId: a.mockRecallId, signOffId: rows[0]!.id };
    },
  });
}
