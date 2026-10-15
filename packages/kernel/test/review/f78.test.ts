/**
 * Review reproducer F78: platform.create_aggregate_state (packages/kernel/sql/0550_platform_state_engine.sql,
 * line 398; the only definition, never replaced later) is granted to ebmr_app (0550 line 597) and checks
 * only platform.require_actor() (0500 line 21: "a context exists"). It never calls platform.authorize /
 * iam.require_permission, so any validated actor, including one whose role holds no GMP permission at all,
 * creates GMP state: an aggregate_state row, a state_history row attributed to that person, a BUSINESS audit
 * entry on the aggregate's chain and a 'state.created' outbox message. It can also pin any published machine
 * version (p_machine_version) and pre-empt the id a module will create later (EBMR-PLAT-063).
 *
 * DI-17 (authorization: every GMP write is checked against the actor's permissions) requires that a
 * CONTRACT_GIVER_REVIEWER (K27, "Read-only access to completed records", holds only RECORD.READ) is
 * refused when it tries to create GMP state.
 *
 * Steps (all as ebmr_app, through kernel.begin_command, exactly as the product would):
 *   1. Sanity: CONTRACT_GIVER_REVIEWER's only live permission is RECORD.READ, and machine sample_record has
 *      a published version (so the call is well-formed and cannot fail on EBMR-PLAT-060/065).
 *   2. Positive control: the same reviewer calls a gated platform writer (platform.set_setting, which runs
 *      platform.authorize('platform.settings.change')) with a reason and is refused with EBMR-PLAT-006. This
 *      proves the reviewer's command context is valid and that the AUTHORITY hook denies this role.
 *   3. The reviewer runs
 *        select platform.create_aggregate_state('sample_record', 'sample_record', <new uuid>)
 *      Safe behaviour asserted: the call is refused (for a reason other than a missing context or an unknown
 *      machine), and no aggregate_state row, state_history row or audit entry exists for that aggregate.
 *
 * With the defect, step 3 resolves (state DRAFT, version 1), and a state_history row with role_code
 * CONTRACT_GIVER_REVIEWER and a BUSINESS audit event on chain sample_record:<id> exist.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withCommand, type ActorContext } from '../../src/db/command.ts';
import { ensureFixtureChangeRecord, underChange } from '../support/change-record.ts';
import { createTestDatabase, type TestDatabase } from '../support/db.ts';
import { seededTestActor } from '../support/seeded-actor.ts';

let db: TestDatabase;
let reviewer: ActorContext;

beforeAll(async () => {
  db = await createTestDatabase();
  await ensureFixtureChangeRecord(db);
  reviewer = await seededTestActor(db, { roleCode: 'CONTRACT_GIVER_REVIEWER', legalName: 'R. Reviewer' });
});

afterAll(async () => {
  await db.drop();
});

type Outcome = { ok: true; value: unknown } | { ok: false; message: string };

const settle = async (p: Promise<unknown>): Promise<Outcome> =>
  p.then(
    (value) => ({ ok: true as const, value }),
    (e: unknown) => ({ ok: false as const, message: e instanceof Error ? e.message : String(e) }),
  );

describe('F78: platform.create_aggregate_state is ungated (DI-17)', () => {
  it('[DI-17] a CONTRACT_GIVER_REVIEWER (RECORD.READ only) cannot create sample_record GMP state', async () => {
    // 1. Sanity: the role is read-only and the machine is published.
    const { rows: perms } = await db.admin.query<{ permission_code: string }>(
      `select permission_code from iam.role_permission
        where role_code = 'CONTRACT_GIVER_REVIEWER' and removed_at is null order by 1`,
    );
    expect(perms.map((p) => p.permission_code)).toEqual(['RECORD.READ']);
    const { rows: versions } = await db.admin.query<{ n: string }>(
      `select count(*)::text as n from platform.machine_version
        where machine_code = 'sample_record' and definition_hash is not null`,
    );
    expect(Number(versions[0]?.n)).toBeGreaterThan(0);

    // 2. Positive control: a gated platform writer refuses this reviewer through the AUTHORITY hook.
    const gated = await settle(
      withCommand(
        db.app,
        underChange({ ...reviewer, correlationId: randomUUID(), reasonCode: 'CONFIGURATION', reasonText: 'F78 positive control' }),
        (c) => c.query("select platform.set_setting('time.drift_alarm_threshold_s', '1')"),
      ),
    );
    expect(gated.ok).toBe(false);
    expect(gated.ok ? '' : gated.message).toMatch(/EBMR-PLAT-006/);

    // 3. The reviewer tries to create GMP state for a new sample_record aggregate.
    const id = randomUUID();
    const outcome = await settle(
      withCommand(db.app, { ...reviewer, correlationId: randomUUID() }, async (c) => {
        const { rows } = await c.query<{ r: unknown }>(
          "select platform.create_aggregate_state('sample_record', 'sample_record', $1::uuid) as r",
          [id],
        );
        return rows[0]?.r;
      }),
    );

    const { rows: stateRows } = await db.admin.query<{ state: string }>(
      "select state from platform.aggregate_state where aggregate_type = 'sample_record' and aggregate_id = $1",
      [id],
    );
    const { rows: histRows } = await db.admin.query<{ role_code: string; person_id: string }>(
      "select role_code, person_id::text as person_id from platform.state_history where aggregate_type = 'sample_record' and aggregate_id = $1",
      [id],
    );
    const { rows: auditRows } = await db.admin.query<{ n: string }>(
      'select count(*)::text as n from kernel.audit_event where chain_key = $1',
      [`sample_record:${id}`],
    );

    // Safe behaviour: refused, and nothing was written in the reviewer's name.
    expect(
      outcome,
      `CONTRACT_GIVER_REVIEWER (RECORD.READ only) created sample_record:${id}: ${JSON.stringify(outcome)}; ` +
        `history ${JSON.stringify(histRows)}; audit events ${auditRows[0]?.n}`,
    ).toMatchObject({ ok: false });
    // The refusal must be an authorization refusal, not a missing context or an unknown machine.
    expect(outcome.ok ? '' : outcome.message).not.toMatch(/EBMR-PLAT-001|EBMR-PLAT-06[05]|EBMR-IAM-00[12]/);
    expect(stateRows).toHaveLength(0);
    expect(histRows).toHaveLength(0);
    expect(Number(auditRows[0]?.n)).toBe(0);
  });
});
