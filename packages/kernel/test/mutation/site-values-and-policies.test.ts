/**
 * Site values and policy switches, guard by guard (SQL mutation group "site-values-and-policies":
 * market.assess_site_value and market.set_site_value in kernel 0320; market.policy_version_guard and
 * market.policy_pin_guard in kernel 0350). The scenario tests in market/site-values.test.ts and
 * market/policy.test.ts show the rules working; these tests prove each refusal where it is enforced,
 * with its own error, and the boundaries of each comparison.
 *
 * Controls: IN-52 (a site value only tightens; looser than HARD or DESIGN is refused; a GUIDANCE or
 * EXAMPLE loosening needs a justification reference and QA approval and is recorded), DI-17 (the
 * permission is checked in the scope of the site the value is for), DI-22 (every write names who
 * made it), DI-09 (a policy change is a numbered version with its direction and change reference);
 * invariants INV-47 (no loosening reaches a batch issued before it took effect), INV-07 (no GMP write
 * without an actor) and INV-16 (instants come from the database clock).
 */
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { toDbContext, withCommand, type ActorContext } from '../../src/db/command.ts';
import { applyPolicyTightening, batchPolicy, definePolicy, pinPoliciesForBatch, policyForBatch, setPolicyVersion, type PolicyVersion } from '../../src/market/policy.ts';
import { setSiteValue, type SiteValueRequest } from '../../src/market/repository.ts';
import { seedActor } from '../identity/seed.ts';
import { asApp, createTestTable, MARKET_ROLES, publishDocument, publishSeedTables, seedStubWorld, testActor, type StubWorld } from '../market/helpers.ts';
import { createTestDatabase, type TestDatabase } from '../support/db.ts';

let db: TestDatabase;
let world: StubWorld;
/** MASTER_DATA_STEWARD installation-wide (MARKET.SITE_VALUE_SET). */
let steward: ActorContext;
/** QA_MBR_APPROVER (MARKET.POLICY_CHANGE). */
let policyOwner: ActorContext;
/** BATCH_ISSUER (BATCH.ISSUE: policies are pinned at issue). */
let issuer: ActorContext;
/** QA_REVIEWER (MARKET.POLICY_TIGHTEN_BATCH). */
let tightener: ActorContext;

beforeAll(async () => {
  db = await createTestDatabase();
  await publishSeedTables(db);
  world = await seedStubWorld(db);
  steward = await testActor(db, { roleCode: MARKET_ROLES.siteValues });
  policyOwner = await testActor(db, { roleCode: MARKET_ROLES.policy });
  issuer = await testActor(db, { roleCode: MARKET_ROLES.issuer });
  tightener = await testActor(db, { roleCode: MARKET_ROLES.tightening });
}, 120_000);

afterAll(async () => {
  await db?.drop();
});

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

/**
 * Raw SQL on the superuser connection (the table owner's rights and more), inside one transaction
 * that is committed only when `commit` is set. With an actor, the transaction first declares it
 * through kernel.begin_command, as every GMP write must.
 */
async function asOwner<T>(actor: ActorContext | null, work: (c: pg.PoolClient) => Promise<T>, commit = true): Promise<T> {
  const c = await db.admin.connect();
  try {
    await c.query('begin');
    if (actor) await c.query('select kernel.begin_command($1::jsonb)', [JSON.stringify(toDbContext(actor))]);
    const result = await work(c);
    await c.query(commit ? 'commit' : 'rollback');
    return result;
  } catch (error) {
    await c.query('rollback');
    throw error;
  } finally {
    c.release();
  }
}

/** An instant relative to the database clock (the only authoritative clock, INV-16). */
async function dbInstant(offset: string): Promise<string> {
  const { rows } = await db.app.query<{ t: Date }>('select clock_timestamp() + $1::interval as t', [offset]);
  return (rows[0]?.t as Date).toISOString();
}

const setFor = (actor: ActorContext, request: Omit<SiteValueRequest, 'siteId' | 'effectiveFrom'> & { siteId?: string; effectiveFrom?: string }) =>
  withCommand(db.app, actor, (c) => setSiteValue(c, { siteId: world.siteId, effectiveFrom: '2026-01-01', ...request }));

const set = (request: Omit<SiteValueRequest, 'siteId' | 'effectiveFrom'> & { siteId?: string; effectiveFrom?: string }) => setFor(steward, request);

/** market.set_site_value exactly as the application role calls it, with any argument left null. */
const setRaw = (key: string, value: unknown, effectiveFrom: string | null) =>
  withCommand(db.app, steward, (c) =>
    c.query('select market.set_site_value($1, $2, $3::jsonb, $4::date, $5::jsonb)', [world.siteId, key, JSON.stringify(value), effectiveFrom, '{}']),
  );

async function siteCode(siteId: string): Promise<string> {
  const { rows } = await db.app.query<{ code: string }>('select code from market.stub_site where id = $1', [siteId]);
  return rows[0]?.code ?? '';
}

/** A one-key test rule table (LARGER_STRICTER, Pa) published as version 1 with the given rows. */
async function publishOneKeyTable(rows: Record<string, unknown>[]): Promise<string> {
  const table = `svp${randomUUID().slice(0, 6)}`;
  await createTestTable(db, table);
  const key = `${table}.step`;
  await publishDocument(db, {
    table,
    version: 1,
    change: { kind: 'INITIAL', description: 'mutation test table' },
    keys: [{ key, title: 'A pressure step', method: 'LARGER_STRICTER', valueType: 'DECIMAL', unit: 'Pa', indiaGoverns: true }],
    rows: rows.map((r, i) => ({ ref: `R${i}`, key, unit: 'Pa', source: 'test source', verification: 'CHK', effectiveFrom: '2024-01-01', ...r })),
  });
  return key;
}

let seq = 0;
async function newPolicy(positions: string[], defaultPosition: string): Promise<{ code: string; v1: PolicyVersion }> {
  seq += 1;
  const code = `M${seq}.svp${randomUUID().slice(0, 6)}`;
  const v1 = await withCommand(db.app, policyOwner, (c) =>
    definePolicy(c, { code, title: `mutation test policy ${seq}`, level: 'TENANT', positions, defaultPosition, controls: ['DI-09'] }),
  );
  return { code, v1 };
}

const setVersion = (code: string, position: string, options: { effectiveFrom?: string; approvalId?: string; changeRef?: string } = {}) =>
  withCommand(db.app, policyOwner, (c) => setPolicyVersion(c, code, position, options));

const issue = (batch: string) => withCommand(db.app, issuer, (c) => pinPoliciesForBatch(c, batch));

const tighten = (batch: string, code: string, versionId: string, changeRef = 'CC-M') =>
  withCommand(db.app, tightener, (c) => applyPolicyTightening(c, batch, code, versionId, changeRef));

async function pinCount(batch: string, code: string): Promise<number> {
  const { rows } = await db.app.query<{ n: string }>('select count(*)::text as n from market.batch_policy_pin where batch_id = $1 and policy_code = $2', [batch, code]);
  return Number(rows[0]?.n);
}

// ---------------------------------------------------------------------------------------------
// Site values (market.set_site_value, market.assess_site_value)
// ---------------------------------------------------------------------------------------------

describe('site values: every refusal where it is enforced', () => {
  it('[DI-22][INV-07][IN-52] a site value cannot be set without an actor context: refused as unattributed (EBMR-AUDIT-001), nothing is stored', async () => {
    await expect(
      db.app.query('select market.set_site_value($1, $2, $3::jsonb, $4::date, $5::jsonb)', [
        world.siteId,
        'tablets.compression.ipcSampleMaxInterval',
        JSON.stringify('25'),
        '2026-01-01',
        '{}',
      ]),
    ).rejects.toThrow('EBMR-AUDIT-001 no actor context');
    const { rows } = await db.app.query<{ n: string }>('select count(*)::text as n from market.site_value where site_id = $1', [world.siteId]);
    expect(Number(rows[0]?.n)).toBe(0);
  });

  it('[DI-17][IN-52] the permission is checked at the site the value is for: a steward of that site may set it, a steward of another site may not', async () => {
    const other = await asApp(
      db,
      async (c) =>
        (await c.query<{ id: string }>('insert into market.stub_site (code, markets) values ($1, $2) returning id', [`SITE-B-${randomUUID().slice(0, 6)}`, ['IN']])).rows[0]?.id ?? '',
      { roleCode: MARKET_ROLES.stubs },
    );
    const here = await seedActor(db, { roleCode: MARKET_ROLES.siteValues, scope: { site: await siteCode(world.siteId) } });
    const there = await seedActor(db, { roleCode: MARKET_ROLES.siteValues, scope: { site: await siteCode(other) } });

    const sv = await setFor(here, { key: 'tablets.compression.ipcSampleMaxInterval', value: '25' });
    expect([sv.siteId, sv.outcome]).toEqual([world.siteId, 'TIGHTER']);
    await expect(setFor(there, { key: 'tablets.compression.ipcSampleMaxInterval', value: '24' })).rejects.toThrow('EBMR-IAM-040');
    // The other site's steward may set values for the other site.
    const own = await setFor(there, { siteId: other, key: 'tablets.compression.ipcSampleMaxInterval', value: '24' });
    expect([own.siteId, own.outcome]).toEqual([other, 'TIGHTER']);
  });

  it('[IN-52] a key of no rule table is refused as such (EBMR-MKT-041)', async () => {
    await expect(set({ key: 'nosuchtable.someKey', value: '1' })).rejects.toThrow('EBMR-MKT-041 key nosuchtable.someKey belongs to no rule table');
  });

  it('[IN-52] a site value needs an effective-from date (EBMR-MKT-002), for a comparable and a NOT_COMPARABLE key alike', async () => {
    await expect(setRaw('tablets.compression.ipcSampleMaxInterval', '25', null)).rejects.toThrow('EBMR-MKT-002 a site value needs an effective-from date');
    await expect(setRaw('kernel.label.manufacturingDate', 'NOT_REQUIRED', null)).rejects.toThrow('EBMR-MKT-002 a site value needs an effective-from date');
  });

  it('[IN-52] a key of a rule table that has no published version is refused as such (EBMR-MKT-040)', async () => {
    const table = `svn${randomUUID().slice(0, 6)}`;
    await createTestTable(db, table);
    await expect(set({ key: `${table}.step`, value: '5' })).rejects.toThrow(`EBMR-MKT-040 rule table ${table} has no published version`);
  });

  it('[IN-52] a site value looser than a DESIGN value is refused even with a justification and QA approval, while a GUIDANCE loosening that keeps the DESIGN value is allowed and recorded', async () => {
    // India: 10 Pa by design (binding floor 5); US: 12 Pa guidance. The site (markets IN, US, EU)
    // resolves to 12 (US GUIDANCE).
    const key = await publishOneKeyTable([
      { market: 'IN', value: '10', floor: 'DESIGN', hardFloor: '5' },
      { market: 'US', value: '12', floor: 'GUIDANCE' },
    ]);
    const approvals = { justificationRef: 'CCS-9.1', qaApprovalId: randomUUID() };
    // 8 is above the binding floor but below the DESIGN value.
    await expect(set({ key, value: '8', ...approvals })).rejects.toThrow('EBMR-MKT-061');
    // 11 loosens only the GUIDANCE value; the DESIGN value (10) still holds.
    await expect(set({ key, value: '11' })).rejects.toThrow('EBMR-MKT-065');
    const sv = await set({ key, value: '11', ...approvals });
    expect([sv.outcome, sv.justificationRef, sv.qaApprovalId]).toEqual(['LOOSENED', 'CCS-9.1', approvals.qaApprovalId]);

    // The loosening is recorded as a business event in the site's audit chain (with the QA approval).
    const { rows } = await db.admin.query<{ message: string; details: { siteValueId: string; qaApprovalId: string } }>(
      `select payload -> 'body' ->> 'message' as message, payload -> 'body' -> 'details' as details
         from kernel.audit_event
        where chain_key = $1 and action = 'BUSINESS' and payload -> 'body' -> 'details' ->> 'siteValueId' = $2`,
      [`market_site_value:${world.siteId}`, sv.id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.details).toEqual({ siteValueId: sv.id, qaApprovalId: approvals.qaApprovalId });
    expect(rows[0]?.message).toContain(`site value for ${key} loosens a GUIDANCE value`);
  });
});

// ---------------------------------------------------------------------------------------------
// Policy versions (market.policy_version_guard)
// ---------------------------------------------------------------------------------------------

describe('policy versions: every rule of the version guard', () => {
  it('[DI-22][INV-07][INV-47] a policy version inserted without an actor context is refused as unattributed (EBMR-AUDIT-001)', async () => {
    const { code } = await newPolicy(['OFF', 'ON'], 'ON');
    await expect(
      asOwner(null, (c) =>
        c.query("insert into market.policy_version (policy_code, position, effective_from, change_ref, reason) values ($1, 'ON', null, 'CC-M1', 'no actor')", [code]),
      ),
    ).rejects.toThrow('EBMR-AUDIT-001 no actor context');
    const { rows } = await db.app.query<{ n: string }>('select count(*)::text as n from market.policy_version where policy_code = $1', [code]);
    expect(Number(rows[0]?.n)).toBe(1);
  });

  it('[DI-09][INV-47] a new version at the same position is UNCHANGED: it needs a change reference but no approval, and it is never counted as a tightening', async () => {
    const { code } = await newPolicy(['OFF', 'ON'], 'ON');
    const v2 = await setVersion(code, 'ON', { changeRef: 'CC-M2' });
    expect([v2.version, v2.position, v2.direction, v2.approvalId]).toEqual([2, 'ON', 'UNCHANGED', null]);
    const { code: low } = await newPolicy(['OFF', 'ON'], 'OFF');
    const w2 = await setVersion(low, 'OFF', { changeRef: 'CC-M3' });
    expect([w2.version, w2.direction]).toEqual([2, 'UNCHANGED']);
  });

  it('[DI-09][INV-47] two scheduled versions may share an effective instant; the newer one is in force from then', async () => {
    const { code, v1 } = await newPolicy(['OFF', 'ON'], 'ON');
    const at = await dbInstant('1 hour');
    const loosening = await setVersion(code, 'OFF', { effectiveFrom: at, approvalId: randomUUID(), changeRef: 'CC-M4' });
    const cancel = await setVersion(code, 'ON', { effectiveFrom: at, changeRef: 'CC-M5' });
    expect([loosening.version, loosening.direction, cancel.version, cancel.direction]).toEqual([2, 'LOOSENING', 3, 'TIGHTENING']);
    expect(new Date(cancel.effectiveFrom).toISOString()).toBe(at);
    expect((await policyForBatch(db.app, code, at)).id).toBe(cancel.id);
    expect((await policyForBatch(db.app, code, await dbInstant('1 minute'))).id).toBe(v1.id);
  });
});

// ---------------------------------------------------------------------------------------------
// Batch pins (market.policy_pin_guard)
// ---------------------------------------------------------------------------------------------

describe('batch pins: every rule of the pin guard', () => {
  it('[DI-22][INV-07][INV-47] the pin guard itself refuses a pin without an actor context, even with the audit trigger switched off', async () => {
    const { code, v1 } = await newPolicy(['LOW', 'HIGH'], 'LOW');
    const batch = randomUUID();
    await expect(
      asOwner(
        null,
        async (c) => {
          await c.query('alter table market.batch_policy_pin disable trigger zz_audit_market_batch_policy_pin');
          await c.query("insert into market.batch_policy_pin (batch_id, policy_code, policy_version_id, pin_kind, issue_instant) values ($1, $2, $3, 'ISSUE', $4)", [
            batch,
            code,
            v1.id,
            v1.effectiveFrom,
          ]);
        },
        false,
      ),
    ).rejects.toThrow('EBMR-AUDIT-001 no actor context');
    expect(await pinCount(batch, code)).toBe(0);
  });

  it('[INV-47] a pin must name a version of its own policy: a version of another policy or an unknown version is refused (EBMR-MKT-080)', async () => {
    const { code, v1 } = await newPolicy(['LOW', 'HIGH'], 'LOW');
    const { v1: foreign } = await newPolicy(['LOW', 'HIGH'], 'HIGH');
    const batch = randomUUID();
    await issue(batch);
    await expect(tighten(batch, code, foreign.id)).rejects.toThrow(`EBMR-MKT-080 version ${foreign.id} is not a version of policy ${code}`);
    const unknown = randomUUID();
    await expect(tighten(batch, code, unknown)).rejects.toThrow(`EBMR-MKT-080 version ${unknown} is not a version of policy ${code}`);
    expect((await batchPolicy(db.app, batch, code))?.versionId).toBe(v1.id);
    expect(await pinCount(batch, code)).toBe(1);
  });

  it('[INV-47][INV-16] an issue pin cannot be dated in the future or left undated (EBMR-MKT-081), even as the table owner', async () => {
    const { code, v1 } = await newPolicy(['LOW', 'HIGH'], 'HIGH');
    const insertIssue = (batch: string, instant: string | null) =>
      asOwner(steward, (c) =>
        c.query("insert into market.batch_policy_pin (batch_id, policy_code, policy_version_id, pin_kind, issue_instant) values ($1, $2, $3, 'ISSUE', $4)", [
          batch,
          code,
          v1.id,
          instant,
        ]),
      );
    const future = randomUUID();
    await expect(insertIssue(future, await dbInstant('1 hour'))).rejects.toThrow('EBMR-MKT-081');
    await expect(insertIssue(future, null)).rejects.toThrow('EBMR-MKT-081');
    expect(await pinCount(future, code)).toBe(0);
  });

  it('[INV-47] a tightening reaches only a batch that was issued: a batch with no issue pin is refused (EBMR-MKT-083), whatever other batches were issued', async () => {
    const { code } = await newPolicy(['LOW', 'HIGH'], 'LOW');
    await issue(randomUUID()); // another batch holds an issue pin for this policy
    const stricter = await setVersion(code, 'HIGH', { changeRef: 'CC-M6' });
    const never = randomUUID();
    await expect(tighten(never, code, stricter.id)).rejects.toThrow(`EBMR-MKT-083 batch ${never} has no issue pin for policy ${code}`);
    expect(await batchPolicy(db.app, never, code)).toBeNull();
  });

  it('[INV-47] a policy defined after a batch was issued has no baseline for that batch: no "tightening" pin can bring it in, not even its least strict position (EBMR-MKT-083)', async () => {
    const batch = randomUUID();
    await issue(batch); // pins the policies defined so far
    const { code, v1 } = await newPolicy(['OFF', 'ON'], 'OFF');
    await expect(tighten(batch, code, v1.id)).rejects.toThrow(`EBMR-MKT-083 batch ${batch} has no issue pin for policy ${code}`);
    expect(await batchPolicy(db.app, batch, code)).toBeNull();
  });

  it('[INV-47] the tightening pin carries the batch\'s own issue instant', async () => {
    const { code } = await newPolicy(['LOW', 'HIGH'], 'LOW');
    const batch = randomUUID();
    const issued = await issue(batch);
    await issue(randomUUID()); // a later batch with its own, later issue instant
    const stricter = await setVersion(code, 'HIGH', { changeRef: 'CC-M7' });
    await tighten(batch, code, stricter.id);
    const now = await batchPolicy(db.app, batch, code);
    expect([now?.pinKind, now?.position]).toEqual(['TIGHTENING', 'HIGH']);
    expect(new Date(now?.issueInstant ?? '').toISOString()).toBe(new Date(issued.issueInstant).toISOString());
  });

  it('[INV-47] a tightening scheduled for later cannot be applied before it takes effect (EBMR-MKT-084)', async () => {
    const { code, v1 } = await newPolicy(['LOW', 'HIGH'], 'LOW');
    const batch = randomUUID();
    await issue(batch);
    const later = await setVersion(code, 'HIGH', { effectiveFrom: await dbInstant('1 hour'), changeRef: 'CC-M8' });
    expect(later.direction).toBe('TIGHTENING');
    await expect(tighten(batch, code, later.id)).rejects.toThrow(`EBMR-MKT-084 policy ${code} version 2 is not in force yet`);
    expect((await batchPolicy(db.app, batch, code))?.versionId).toBe(v1.id);
  });

  it('[INV-47] a batch is compared with its own pins for the policy only: a later batch issued under a loosening does not let that loosening reach an earlier, stricter batch', async () => {
    const { code, v1 } = await newPolicy(['LO', 'MID', 'HI'], 'HI');
    const early = randomUUID();
    await issue(early); // HI
    const loosening = await setVersion(code, 'LO', { approvalId: randomUUID(), changeRef: 'CC-M9' });
    const late = randomUUID();
    await issue(late); // LO, pinned after the early batch's pins
    const mid = await setVersion(code, 'MID', { changeRef: 'CC-M10' });
    expect([loosening.direction, mid.direction]).toEqual(['LOOSENING', 'TIGHTENING']);
    // MID is stricter than what the late batch applies, but looser than what the early batch applies.
    await expect(tighten(early, code, mid.id)).rejects.toThrow('EBMR-MKT-085');
    expect((await batchPolicy(db.app, early, code))?.versionId).toBe(v1.id);
    await tighten(late, code, mid.id);
    expect((await batchPolicy(db.app, late, code))?.position).toBe('MID');
  });
});

// ---------------------------------------------------------------------------------------------
// Boundaries at the database clock
// ---------------------------------------------------------------------------------------------

/*
 * The guards compare an instant with the one the trigger itself reads from the database clock
 * (new.recorded_at := clock_timestamp()). An instant equal to that reading is "now": neither in the
 * past nor in the future, and a version whose effective instant it is is in force at it (as
 * market.policy_version_at counts it: effective_from <= at). To offer exactly that instant, each probe
 * writes clock_timestamp() + offset in the inserting statement. Learning attempts, which are always
 * accepted, measure how far the trigger's reading runs behind the statement's (the gap); trial
 * attempts offer offsets drawn from recently measured gaps until one lands exactly on the trigger's
 * reading, within a time budget. Learning is kept separate from trials so that which trials were
 * accepted never biases the gaps. Every attempt is undone in its subtransaction (plpgsql variables
 * survive the rollback), so nothing is left behind. Each probe returns
 * {equal, inForce, refused, other, tries}: `equal` is 1 when an attempt at exactly the trigger's
 * reading was accepted, `other` names anything unexpected.
 */
const PROBES = `
create function pg_temp.gap_sample(p_gaps bigint[]) returns bigint language sql volatile as $$
  select p_gaps[1 + floor(random() * cardinality(p_gaps))::integer]
$$;

-- An ISSUE pin whose issue instant is the trigger's own reading (the version pinned is in force throughout).
create function pg_temp.probe_issue_now(p_policy text, p_version uuid, p_budget interval) returns jsonb language plpgsql as $$
declare
  v_deadline timestamptz := clock_timestamp() + p_budget;
  v_gaps bigint[] := '{}'; v_n integer := 0; v_learn boolean; v_off bigint;
  v_t timestamptz; v_rec timestamptz;
  v_equal integer := 0; v_refused integer := 0; v_other text; i integer := 0;
begin
  while v_equal = 0 and v_other is null and clock_timestamp() < v_deadline loop
    i := i + 1;
    v_learn := v_n < 50 or i % 4 = 0;
    v_off := case when v_learn then 0 else pg_temp.gap_sample(v_gaps) end;
    begin
      insert into market.batch_policy_pin (batch_id, policy_code, policy_version_id, pin_kind, issue_instant)
      values (gen_random_uuid(), p_policy, p_version, 'ISSUE', clock_timestamp() + v_off * interval '1 microsecond')
      returning issue_instant, recorded_at into v_t, v_rec;
      raise sqlstate 'EBX01';
    exception
      when sqlstate 'EBX01' then
        if v_t > v_rec then v_other := 'accepted an issue instant after its recording instant';
        elsif v_learn then v_gaps[1 + v_n % 200] := (extract(epoch from v_rec - v_t) * 1000000)::bigint; v_n := v_n + 1;
        elsif v_t = v_rec then v_equal := 1;
        end if;
      when others then
        if sqlerrm like 'EBMR-MKT-081 %' and not v_learn then v_refused := v_refused + 1; else v_other := sqlerrm; end if;
    end;
  end loop;
  return jsonb_build_object('equal', v_equal, 'inForce', v_equal, 'refused', v_refused, 'other', v_other, 'tries', i);
end
$$;

-- A policy version whose effective instant is the trigger's own reading.
create function pg_temp.probe_version_now(p_policy text, p_position text, p_budget interval) returns jsonb language plpgsql as $$
declare
  v_deadline timestamptz := clock_timestamp() + p_budget;
  v_gaps bigint[] := '{}'; v_n integer := 0; v_learn boolean; v_off bigint;
  v_id uuid; v_t timestamptz; v_rec timestamptz; v_in_force boolean;
  v_equal integer := 0; v_refused integer := 0; v_other text; i integer := 0;
begin
  while v_equal = 0 and v_other is null and clock_timestamp() < v_deadline loop
    i := i + 1;
    v_learn := v_n < 50 or i % 4 = 0;
    v_off := case when v_learn then 10000 else pg_temp.gap_sample(v_gaps) end;
    begin
      insert into market.policy_version (policy_code, position, effective_from, change_ref, reason)
      values (p_policy, p_position, clock_timestamp() + v_off * interval '1 microsecond', 'CC-PROBE', 'boundary probe')
      returning id, effective_from, recorded_at into v_id, v_t, v_rec;
      v_in_force := (market.policy_version_at(p_policy, v_rec)).id = v_id;
      raise sqlstate 'EBX01';
    exception
      when sqlstate 'EBX01' then
        if v_t < v_rec then v_other := 'accepted an effective instant before its recording instant';
        elsif v_learn then v_gaps[1 + v_n % 200] := (extract(epoch from v_rec - v_t) * 1000000)::bigint + v_off; v_n := v_n + 1;
        elsif v_t = v_rec then v_equal := 1;
        end if;
      when others then
        if sqlerrm like 'EBMR-MKT-070 %' and not v_learn then v_refused := v_refused + 1; else v_other := sqlerrm; end if;
    end;
  end loop;
  return jsonb_build_object('equal', v_equal, 'inForce', case when v_equal = 1 and v_in_force then 1 else 0 end,
                            'refused', v_refused, 'other', v_other, 'tries', i);
end
$$;

-- A TIGHTENING pin recorded at the very instant its version takes effect. Learning attempts use a
-- version in force from its own recording instant and carry the statement's clock reading in the reason.
create function pg_temp.probe_tightening_at_effect(p_policy text, p_position text, p_batch uuid, p_budget interval) returns jsonb language plpgsql as $$
declare
  v_deadline timestamptz := clock_timestamp() + p_budget;
  v_gaps bigint[] := '{}'; v_n integer := 0; v_learn boolean; v_off bigint;
  v_id uuid; v_t timestamptz; v_c timestamptz; v_rec timestamptz; v_in_force boolean;
  v_equal integer := 0; v_refused integer := 0; v_other text; i integer := 0;
begin
  while v_equal = 0 and v_other is null and clock_timestamp() < v_deadline loop
    i := i + 1;
    v_learn := v_n < 50 or i % 4 = 0;
    begin
      if v_learn then
        insert into market.policy_version (policy_code, position, effective_from, change_ref, reason)
        values (p_policy, p_position, null, 'CC-PROBE', clock_timestamp()::text)
        returning id, effective_from, reason::timestamptz into v_id, v_t, v_c;
      else
        v_off := pg_temp.gap_sample(v_gaps);
        insert into market.policy_version (policy_code, position, effective_from, change_ref, reason)
        values (p_policy, p_position, clock_timestamp() + v_off * interval '1 microsecond', 'CC-PROBE', 'boundary probe')
        returning id, effective_from into v_id, v_t;
      end if;
      insert into market.batch_policy_pin (batch_id, policy_code, policy_version_id, pin_kind, change_ref)
      values (p_batch, p_policy, v_id, 'TIGHTENING', 'CC-PROBE')
      returning recorded_at into v_rec;
      v_in_force := (market.policy_version_at(p_policy, v_rec)).id = v_id;
      raise sqlstate 'EBX01';
    exception
      when sqlstate 'EBX01' then
        if v_t > v_rec then v_other := 'accepted a version before it took effect';
        elsif v_learn then v_gaps[1 + v_n % 200] := (extract(epoch from v_rec - v_c) * 1000000)::bigint; v_n := v_n + 1;
        elsif v_t = v_rec then v_equal := 1;
        end if;
      when others then
        -- 084: offered after the pin's reading; 070: offered before the version's own reading.
        if (sqlerrm like 'EBMR-MKT-084 %' or sqlerrm like 'EBMR-MKT-070 %') and not v_learn then v_refused := v_refused + 1; else v_other := sqlerrm; end if;
    end;
  end loop;
  return jsonb_build_object('equal', v_equal, 'inForce', case when v_equal = 1 and v_in_force then 1 else 0 end,
                            'refused', v_refused, 'other', v_other, 'tries', i);
end
$$;
`;

interface ProbeResult {
  equal: number;
  inForce: number;
  refused: number;
  other: string | null;
  tries: number;
}

/** Time a probe may take to hit the boundary (it usually needs well under a second). */
const PROBE_BUDGET = '20 seconds';

/** Run one boundary probe as the table owner under `actor`; everything it wrote is rolled back. */
function probe(actor: ActorContext, call: string, params: unknown[]): Promise<ProbeResult> {
  return asOwner(
    actor,
    async (c) => {
      await c.query(PROBES);
      const { rows } = await c.query<{ r: ProbeResult }>(`select ${call} as r`, [...params, PROBE_BUDGET]);
      return rows[0]?.r as ProbeResult;
    },
    false,
  );
}

describe('boundaries at the database clock', () => {
  it('[DI-09][INV-47][INV-16] a version may take effect at the very instant it is recorded, as one set for "now" does: that instant is not in the past', async () => {
    const { code } = await newPolicy(['OFF', 'ON'], 'ON');
    const r = await probe(policyOwner, 'pg_temp.probe_version_now($1, $2, $3::interval)', [code, 'ON']);
    expect(r).toMatchObject({ other: null, equal: 1, inForce: 1 });
  }, 60_000);

  it('[INV-47][INV-16] a batch may be pinned with an issue instant equal to the pin\'s own recording instant: that instant is not in the future', async () => {
    const { code, v1 } = await newPolicy(['LOW', 'HIGH'], 'HIGH');
    const r = await probe(issuer, 'pg_temp.probe_issue_now($1, $2, $3::interval)', [code, v1.id]);
    expect(r).toMatchObject({ other: null, equal: 1 });
  }, 60_000);

  it('[INV-47][INV-16] a tightening may be applied from the very instant it takes effect, when market.policy_version_at already counts it in force', async () => {
    const { code } = await newPolicy(['LOW', 'HIGH'], 'LOW');
    const batch = randomUUID();
    await issue(batch);
    const r = await probe(tightener, 'pg_temp.probe_tightening_at_effect($1, $2, $3, $4::interval)', [code, 'HIGH', batch]);
    expect(r).toMatchObject({ other: null, equal: 1, inForce: 1 });
  }, 60_000);
});
