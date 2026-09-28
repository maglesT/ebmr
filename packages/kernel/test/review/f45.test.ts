/**
 * Review reproducer F45: platform.create_aggregate_state (kernel 0550, line 398; the only definition,
 * never replaced later) is granted to ebmr_app and checks only platform.require_actor() (a validated
 * actor exists). It never calls iam.assert_not_administrator(), so a SYSTEM_ADMINISTRATOR command
 * creates GMP state: an aggregate_state row, a state_history row attributed to the administrator, a
 * BUSINESS audit entry on the GMP aggregate's chain and a 'state.created' outbox message.
 *
 * DI-18 (behaviour: "Administrators cannot change GMP data values"; catalog_test: "An administrator
 * tries to edit a GMP value through the UI or API. Refused and logged.") and the iam guard itself
 * (0130: "an administrator role ... never creates or changes GMP data, whatever else it holds.
 * Modules call it in their GMP write functions") require the refusal EBMR-IAM-042.
 *
 * Steps (all as ebmr_app, through kernel.begin_command, exactly as the product would):
 *   1. Positive control: the seeded installation administrator (role SYSTEM_ADMINISTRATOR) is refused
 *      by iam.assert_not_administrator() with EBMR-IAM-042, so the actor really is an administrator
 *      in the DI-18 sense and its command context is valid.
 *   2. Positive control: an MBR_AUTHOR creates a sample_record state through the same call, so the
 *      call itself is well-formed and succeeds for a GMP role.
 *   3. The administrator runs
 *        select platform.create_aggregate_state('sample_record', 'sample_record', <new uuid>)
 *      Safe behaviour asserted: refused with EBMR-IAM-042, and no state row, history row or audit
 *      entry exists for that aggregate afterwards.
 *
 * With the defect, step 3 resolves (state DRAFT, version 1) instead of rejecting, and a
 * state_history row with role_code SYSTEM_ADMINISTRATOR exists.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withCommand, type ActorContext } from '../../src/db/command.ts';
import { createTestDatabase, type TestDatabase } from '../support/db.ts';
import { seededTestActor } from '../support/seeded-actor.ts';
import { seedAdministration, withReason } from '../identity/seed.ts';

let db: TestDatabase;
let admin: ActorContext;
let author: ActorContext;

beforeAll(async () => {
  db = await createTestDatabase();
  const { admin: seededAdmin } = await seedAdministration(db);
  const { seed: _seed, ...adminCtx } = seededAdmin;
  void _seed;
  admin = adminCtx;
  author = await seededTestActor(db, { roleCode: 'MBR_AUTHOR', legalName: 'A. Author' });
});

afterAll(async () => {
  await db.drop();
});

const createState = (actor: ActorContext, id: string) =>
  withCommand(db.app, actor, async (c) => {
    const { rows } = await c.query<{ r: { state: string; version: number; machine_version: number } }>(
      "select platform.create_aggregate_state('sample_record', 'sample_record', $1::uuid) as r",
      [id],
    );
    return rows[0]?.r;
  });

describe('F45: platform.create_aggregate_state and DI-18', () => {
  it('[DI-18][DI-17] an administrator cannot create GMP aggregate state (state row, history, audit entry) through create_aggregate_state', async () => {
    // 1. Positive control: the actor is an administrator in the DI-18 sense and its context is valid.
    expect(admin.roleCode).toBe('SYSTEM_ADMINISTRATOR');
    await expect(withCommand(db.app, withReason(admin), (c) => c.query('select iam.assert_not_administrator()'))).rejects.toThrow('EBMR-IAM-042');

    // 2. Positive control: a GMP role can create a sample_record state with the same call.
    const authored = randomUUID();
    await expect(createState(author, authored)).resolves.toMatchObject({ state: 'DRAFT', version: 1 });

    // 3. The administrator attempts the same GMP write. DI-18 requires a refusal.
    const id = randomUUID();
    let outcome: string;
    try {
      const r = await createState(withReason(admin), id);
      outcome = `created: ${JSON.stringify(r)}`;
    } catch (error) {
      outcome = `refused: ${(error as Error).message}`;
    }

    const { rows: history } = await db.admin.query<{ role_code: string; to_state: string; person_id: string }>(
      "select role_code, to_state, person_id from platform.state_history where aggregate_type = 'sample_record' and aggregate_id = $1",
      [id],
    );
    const { rows: audit } = await db.admin.query<{ n: string }>('select count(*)::text as n from kernel.audit_event where chain_key = $1', [
      `sample_record:${id}`,
    ]);
    const { rows: state } = await db.admin.query<{ n: string }>(
      "select count(*)::text as n from platform.aggregate_state where aggregate_type = 'sample_record' and aggregate_id = $1",
      [id],
    );

    expect({ outcome, history, auditEntries: audit[0]?.n, stateRows: state[0]?.n }).toEqual({
      outcome: expect.stringMatching(/^refused: .*EBMR-IAM-042/),
      history: [],
      auditEntries: '0',
      stateRows: '0',
    });
  });
});
