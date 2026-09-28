/**
 * Review reproducer F24: the approvals that stand behind a loosening are free UUIDs that nothing
 * verifies.
 *
 *   - market.publish_rule_table (0340): a SOURCE_CORRECTION needs a citation and two distinct
 *     approverIds other than the publisher, but the ids are never checked against iam persons,
 *     roles or e-signatures. The outline (3.3.2, L-38) asks for two QA signatures.
 *   - market.set_site_value (0320): loosening a GUIDANCE value needs a justificationRef and any
 *     qaApprovalId uuid, so the steward can approve their own loosening.
 *   - market.set_policy_version / market.policy_version_guard (0350): a LOOSENING needs any
 *     approval_id uuid; policy.level (VENDOR / TENANT) and policy.loosening_requires
 *     (QA_APPROVAL / CHANGE_CONTROL / OWNER_CONFIRMATION) are stored but never checked.
 *
 * Safe behaviour asserted: each of these loosenings is refused when the named approval is not a
 * real e-signature by the named approver (random UUIDs, or real QA persons who signed nothing),
 * and a VENDOR-level policy that needs OWNER_CONFIRMATION cannot be loosened by the QA MBR
 * approver with an unverified approval id.
 *
 * Every attack runs in its own transaction that is rolled back, so the attacks are independent.
 * Positive controls, run first, show that the attack inputs are otherwise valid: the kernel v2
 * document validates and is a retroactive loosening (refused as an UPDATE with EBMR-MKT-031); the
 * steward may set a tighter site value for the key; the QA MBR approver may version the TENANT
 * policy. So a refusal of an attack can only come from the approval check.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { toDbContext, type ActorContext } from '../../src/db/command.ts';
import { createTestDatabase, type TestDatabase } from '../support/db.ts';
import { seededTestActor } from '../support/seeded-actor.ts';
import { MARKET_ROLES, publishSeedTables, seedDocument, seedStubWorld, type StubWorld } from '../market/helpers.ts';

let db: TestDatabase;
let world: StubWorld;

beforeAll(async () => {
  db = await createTestDatabase();
  await publishSeedTables(db);
  world = await seedStubWorld(db);
});

afterAll(async () => {
  await db.drop();
});

type Attempt = { accepted: true; result: Record<string, unknown> } | { accepted: false; error: string };

/**
 * Run one statement as the application role inside a command, then roll back whatever happened.
 * A failure of kernel.begin_command (a setup problem) propagates; a refusal of the statement is
 * returned.
 */
async function attemptRolledBack(ctx: ActorContext, sql: string, params: unknown[]): Promise<Attempt> {
  const client = await db.app.connect();
  try {
    await client.query('begin');
    await client.query('select kernel.begin_command($1::jsonb)', [JSON.stringify(toDbContext(ctx))]);
    try {
      const { rows } = await client.query<{ r: Record<string, unknown> }>(sql, params);
      return { accepted: true, result: rows[0]?.r ?? {} };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { accepted: false, error: message };
    }
  } finally {
    await client.query('rollback');
    client.release();
  }
}

/** Run statements as the superuser inside a command and commit (setup only). */
async function adminCommand(ctx: ActorContext, statements: { sql: string; params: unknown[] }[]): Promise<void> {
  const client = await db.admin.connect();
  try {
    await client.query('begin');
    await client.query('select kernel.begin_command($1::jsonb)', [JSON.stringify(toDbContext(ctx))]);
    for (const s of statements) await client.query(s.sql, s.params);
    await client.query('commit');
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

/** Run one statement as the application role inside a command and commit (setup only). */
async function appCommand(ctx: ActorContext, sql: string, params: unknown[]): Promise<Record<string, unknown>> {
  const client = await db.app.connect();
  try {
    await client.query('begin');
    await client.query('select kernel.begin_command($1::jsonb)', [JSON.stringify(toDbContext(ctx))]);
    const { rows } = await client.query<{ r: Record<string, unknown> }>(sql, params);
    await client.query('commit');
    return rows[0]?.r ?? {};
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

const code = (a: Attempt): string => (a.accepted ? 'ACCEPTED' : (/EBMR-[A-Z]+-\d+/.exec(a.error)?.[0] ?? a.error));

const PUBLISH = 'select market.publish_rule_table($1::jsonb, $2::jsonb) as r';
const SITE_VALUE = 'select market.set_site_value($1::uuid, $2, $3::jsonb, $4::date, $5::jsonb) as r';
const POLICY_VERSION = 'select market.set_policy_version($1, $2, $3::timestamptz, $4::jsonb) as r';

describe('F24: approvals behind a loosening must be verified e-signatures, not free UUIDs', () => {
  it('[IN-52][DI-35][DI-09][INV-47][ST-01] source correction, site-value loosening and policy loosening are refused without real signed approvals', async () => {
    // --- Actors (real identities from the identity module).
    const corrector = await seededTestActor(db, { roleCode: MARKET_ROLES.corrector }); // REGULATORY_SIGNER
    const steward = await seededTestActor(db, { roleCode: MARKET_ROLES.siteValues }); // MASTER_DATA_STEWARD
    const qaPolicy = await seededTestActor(db, { roleCode: MARKET_ROLES.policy }); // QA_MBR_APPROVER
    const qaReviewer = await seededTestActor(db, { roleCode: 'QA_REVIEWER' });
    const qaApprover = await seededTestActor(db, { roleCode: 'QA_MBR_APPROVER' });

    // --- Scenario 1 input: kernel v2 in which the India HARD self-inspection interval (B-08, 12 months
    // from 2023-12-28) becomes 36 months, retroactively.
    const v2 = JSON.parse(JSON.stringify(seedDocument('kernel'))) as {
      version: number;
      change: Record<string, unknown>;
      rows: { ref: string; value: unknown; floor: string }[];
    };
    v2.version = 2;
    v2.change = { kind: 'UPDATE', description: 'self-inspection interval re-read' };
    const row = v2.rows.find((r) => r.ref === 'B-08.IN.selfInspection');
    expect(row, 'seed row B-08.IN.selfInspection').toBeDefined();
    expect([row?.value, row?.floor]).toEqual(['12', 'HARD']);
    if (row) row.value = '36';
    const correction = {
      kind: 'SOURCE_CORRECTION',
      description: 'self-inspection interval re-read',
      citation: 'x',
      vendorNoticeRef: 'VN-F24',
    };

    // --- Scenario 3 setup: a TENANT policy (QA_APPROVAL) defined through the function, and a
    // VENDOR policy (OWNER_CONFIRMATION) written by the superuser as the vendor profile would.
    const tenantPolicy = `F24.tenant${randomUUID().slice(0, 6)}`;
    await appCommand(qaPolicy, 'select market.define_policy($1::jsonb) as r', [
      JSON.stringify({
        code: tenantPolicy,
        title: 'F24 tenant policy',
        level: 'TENANT',
        controls: ['DI-09'],
        positions: ['OFF', 'ON'],
        defaultPosition: 'ON',
        looseningRequires: 'QA_APPROVAL',
        reason: 'F24 setup',
      }),
    ]);
    const vendorPolicy = `F24.vendor${randomUUID().slice(0, 6)}`;
    await adminCommand(qaPolicy, [
      {
        sql: `insert into market.policy (code, title, level, controls, positions, default_position, loosening_requires, defined_by)
              values ($1, 'F24 vendor policy', 'VENDOR', '{DI-09}', '["OFF","ON"]'::jsonb, 'ON', 'OWNER_CONFIRMATION', $2)`,
        params: [vendorPolicy, qaPolicy.personId],
      },
      {
        sql: `insert into market.policy_version (policy_code, position, effective_from, reason) values ($1, 'ON', null, 'vendor profile default')`,
        params: [vendorPolicy],
      },
    ]);
    const { rows: vendorRows } = await db.admin.query('select level, loosening_requires from market.policy where code = $1', [vendorPolicy]);
    expect(vendorRows).toEqual([{ level: 'VENDOR', loosening_requires: 'OWNER_CONFIRMATION' }]);

    // --- Positive controls: the attack inputs are valid apart from the approvals.
    // (1) The v2 document validates, has the right version number and loosens a value in force:
    //     as an UPDATE it is refused only for the retroactive loosening.
    const asUpdate = await attemptRolledBack(steward, PUBLISH, [JSON.stringify(v2), '{}']);
    expect(code(asUpdate), 'control: kernel v2 as an UPDATE').toBe('EBMR-MKT-031');
    // (2) The steward may set a site value for the key at the stub site (a tighter one is accepted),
    //     and 36 months is a loosening that is refused without an approval.
    const tighter = await attemptRolledBack(steward, SITE_VALUE, [world.siteId, 'kernel.managementReview.maxIntervalMonths', '"6"', '2026-01-01', '{}']);
    expect(tighter.accepted && tighter.result['outcome'], 'control: tighter site value').toBe('TIGHTER');
    const noApproval = await attemptRolledBack(steward, SITE_VALUE, [
      world.siteId,
      'kernel.managementReview.maxIntervalMonths',
      '"36"',
      '2026-01-01',
      JSON.stringify({ justificationRef: 'x' }),
    ]);
    expect(noApproval.accepted, 'control: site loosening without any approval').toBe(false);
    // (3) The QA MBR approver may version the TENANT policy; a loosening without any approval is refused.
    const unchanged = await attemptRolledBack(qaPolicy, POLICY_VERSION, [tenantPolicy, 'ON', null, JSON.stringify({ changeRef: 'CC-F24-0' })]);
    expect(unchanged.accepted && unchanged.result['direction'], 'control: unchanged policy version').toBe('UNCHANGED');
    const looseNoApproval = await attemptRolledBack(qaPolicy, POLICY_VERSION, [tenantPolicy, 'OFF', null, JSON.stringify({ changeRef: 'CC-F24-0' })]);
    expect(looseNoApproval.accepted, 'control: policy loosening without any approval').toBe(false);

    // --- Attacks.
    // 1a. Source correction with two approvers who do not exist and approved nothing.
    const ghosts = [randomUUID(), randomUUID()];
    const { rows: ghostPersons } = await db.admin.query('select id from iam.person where id = any($1::uuid[])', [ghosts]);
    expect(ghostPersons).toEqual([]);
    const attack1a = await attemptRolledBack(corrector, PUBLISH, [JSON.stringify(v2), JSON.stringify({ ...correction, approverIds: ghosts })]);

    // 1b. Source correction naming two real QA persons who never signed anything.
    const qaPersons = [qaReviewer.personId, qaApprover.personId];
    const { rows: qaSignatures } = await db.admin.query<{ n: string }>('select count(*)::text as n from esig.signature where signer_person = any($1::uuid[])', [qaPersons]);
    expect(qaSignatures[0]?.n).toBe('0');
    const attack1b = await attemptRolledBack(corrector, PUBLISH, [JSON.stringify(v2), JSON.stringify({ ...correction, approverIds: qaPersons })]);

    // 2. Steward loosens a GUIDANCE value (12 -> 36 months) with a QA approval id that is no record at all.
    const attack2 = await attemptRolledBack(steward, SITE_VALUE, [
      world.siteId,
      'kernel.managementReview.maxIntervalMonths',
      '"36"',
      '2026-01-01',
      JSON.stringify({ justificationRef: 'x', qaApprovalId: randomUUID() }),
    ]);

    // 3a. QA MBR approver loosens a TENANT policy (QA_APPROVAL) with an approval id that is no record at all.
    const attack3a = await attemptRolledBack(qaPolicy, POLICY_VERSION, [
      tenantPolicy,
      'OFF',
      null,
      JSON.stringify({ approvalId: randomUUID(), changeRef: 'CC-F24-1', reason: 'F24' }),
    ]);

    // 3b. QA MBR approver loosens a VENDOR-level policy that needs OWNER_CONFIRMATION.
    const attack3b = await attemptRolledBack(qaPolicy, POLICY_VERSION, [
      vendorPolicy,
      'OFF',
      null,
      JSON.stringify({ approvalId: randomUUID(), changeRef: 'CC-F24-2', reason: 'F24' }),
    ]);

    const pick = (a: Attempt, keys: string[]): unknown =>
      a.accepted ? { ACCEPTED: Object.fromEntries(keys.map((k) => [k, a.result[k]])) } : 'REFUSED';
    const observed = {
      sourceCorrectionNonexistentApprovers: pick(attack1a, ['changeKind', 'version', 'loosening']),
      sourceCorrectionUnsignedQaApprovers: pick(attack1b, ['changeKind', 'version', 'loosening']),
      siteLooseningUnverifiedQaApproval: pick(attack2, ['outcome', 'value', 'qa_approval_id', 'recorded_by']),
      tenantPolicyLooseningUnverifiedApproval: pick(attack3a, ['direction', 'position', 'approval_id']),
      vendorPolicyLooseningByQaMbrApprover: pick(attack3b, ['direction', 'position', 'approval_id']),
    };
    expect(observed).toEqual({
      sourceCorrectionNonexistentApprovers: 'REFUSED',
      sourceCorrectionUnsignedQaApprovers: 'REFUSED',
      siteLooseningUnverifiedQaApproval: 'REFUSED',
      tenantPolicyLooseningUnverifiedApproval: 'REFUSED',
      vendorPolicyLooseningByQaMbrApprover: 'REFUSED',
    });
  });
});
