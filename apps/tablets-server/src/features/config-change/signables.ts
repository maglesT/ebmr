/**
 * The quality unit's approval of a configuration change record (Phase 6 slice 6f, builder A; signable action
 * CONFIG_CHANGE_ACT). It signs the change record the database act works on and records the approval with that signature
 * in the same transaction; the database decides (kernel 1195: the record is OPEN, the signer records their own
 * signature, the raiser never approves) and a refusal signs nothing (esig/db-acts.ts).
 *
 *   CONFIG_CHANGE_ACT APPROVE   config_change_record <number>   CONFIG_CHANGE_APPROVED (QA), state OPEN   platform.approve_change_record
 */
import type { SignableAction } from '@ebmr/api-contract';
import type { AppContext } from '../../platform/context.ts';
import type { SignableActionHandler } from '../../platform/ports.ts';
import { dbActHandler } from '../esig/db-acts.ts';

type ConfigChangeAct = Extract<SignableAction, { kind: 'CONFIG_CHANGE_ACT' }>;

export function configChangeActHandler(app: AppContext): SignableActionHandler<ConfigChangeAct> {
  return dbActHandler<ConfigChangeAct>(app, {
    kind: 'CONFIG_CHANGE_ACT',
    aggregateTypes: ['config_change_record'],
    target: (a) => ({ aggregateType: 'config_change_record', aggregateId: a.number, meaning: 'CONFIG_CHANGE_APPROVED', expectedState: 'OPEN' }),
    async apply(client, _ctx, a, signatureId) {
      await client.query('select platform.approve_change_record($1, $2)', [a.number, signatureId]);
      return { act: a.act, number: a.number };
    },
  });
}
