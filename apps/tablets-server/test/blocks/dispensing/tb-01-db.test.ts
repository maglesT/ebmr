/**
 * TB-01@1 on the sandbox installation, end to end and past the server (Phase 3 slice 3b; tablets 0840 to 0843): the
 * dispenser's potency calculation from the lot register's approved results, dispensing on a balance with a calibrated,
 * checked instrument use (plant.record_instrument_check and record_instrument_use), the manual two-person path while the
 * room's scale is offline and the scale readings once it is online, FEFO, and the database's own refusals when the
 * application role writes past the server (ADR 0012). The GMP path (site lots, reservations, consumption) is
 * tb-01-gmp.test.ts.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { identity, withCommand, type ActorContext } from '@ebmr/kernel';
import { engine, type flow } from '@ebmr/recipe-core';
import { openPersonaSession, passwordActor } from '@ebmr/test-kit';
import { DEMO_GATEWAY, DEMO_INSTRUMENTS, enrolGateway } from '../../../src/features/devices/enrol.ts';
import { registerLots } from '../../../src/features/execution/seed.ts';
import { engineActor, engineRoles } from '../../../src/features/execution/roles.ts';
import { runContext } from '../../../src/features/execution/runs.ts';
import { execution } from '@ebmr/recipe-core';
import { TB01 } from '../../../src/blocks/tb-01.ts';
import { adminActor, fakeGateway, gatewayKey, operatorActor, type FakeGateway } from '../../devices/support.ts';
import { report, untilVouched } from '../../devices/room-scales-support.ts';
import { actorOfBrowser } from '../../esig/support.ts';
import { appendAs, codeOf, engineResult, messageOf, prepareSignature } from '../../execution/db-guards-support.ts';
import { asPersonaInRole, dcMiniVariant, importAndIssue, outcomeOf, personaIn, refusalOf, RunDriver, startExecServer, writePackage, type ExecServer } from '../../execution/support.ts';

type Json = Record<string, unknown>;
const STEP = 'p-tb01';
const KEY = `${STEP}@`;

let sbx: ExecServer;
let gw: FakeGateway | undefined;

/** dc-mini with a TB-01 step first in its dispensing stage: paracetamol (as is) compensated by MCC. */
function withTb01(extra: Json = {}): flow.MbrContent {
  return dcMiniVariant((prep, content) => {
    (content['parameters'] as Json[]).push(
      { id: 'tbApi', name: 'Paracetamol dispensed (potency-adjusted)', valueType: 'DECIMAL', unit: 'kg', precision: { kind: 'DECIMALS', digits: 3 }, role: 'QUANTITY', criticality: 'CRITICAL', riskClass: 'HIGH', capture: 'DEVICE' },
      { id: 'tbMcc', name: 'MCC dispensed (compensating)', valueType: 'DECIMAL', unit: 'kg', precision: { kind: 'DECIMALS', digits: 3 }, role: 'QUANTITY', criticality: 'NON_CRITICAL', riskClass: 'MEDIUM', capture: 'DEVICE' },
    );
    const step = {
      kind: 'phase', id: STEP, name: 'Potency-adjusted dispensing', block: { type: 'TB-01', version: '1' },
      config: {
        active: { bomLine: 'BOM-PCM', basis: 'AS_IS', standardIs: 'FORM', standardBasis: 'paracetamol at 100.0 % as is' },
        compensation: { mode: 'EXCIPIENT', bomLine: 'BOM-MCC', min: '8.000', max: '11.000' },
        readability: '0.001',
        tolerancePercent: { active: '0.5', excipient: '1.0' },
        ...extra,
      },
      records: ['tbApi', 'tbMcc'], computes: [], reads: [], consumes: ['BOM-PCM', 'BOM-MCC'], produces: [], uses: [], equipment: [],
      signatures: { perform: { role: 'DISPENSER' }, check: { meaning: 'VERIFIED', role: 'PRODUCTION_VERIFIER' } },
      significant: true, riskClass: 'HIGH',
    };
    return [step, ...prep];
  });
}

async function owner(): Promise<ActorContext> {
  return passwordActor(sbx.db, sbx.seed.bootstrap.owner, sbx.seed.bootstrap.owner.fingerprint, { reasonCode: 'TEST_SETUP', reasonText: 'designation for the TB-01 tests', correlationId: randomUUID() });
}

/** Grants `role` to persona `key` (requested by the administrator, approved by the process owner, as the seed does). */
async function grant(key: string, role: string): Promise<void> {
  const p = personaIn(sbx, key);
  const id = await withCommand(sbx.db.app, await adminActor(sbx, 'designation for the TB-01 tests'), (c) => identity.requestRoleGrant(c, { accountId: p.accountId, roleCode: role, reason: `TB-01 tests: ${role}` }));
  await withCommand(sbx.db.app, await owner(), (c) => identity.decideRoleGrant(c, id, true, 'approved for the TB-01 tests'));
}

/** The steward's command (office PC): test lots and their results. */
async function stewardActor(): Promise<ActorContext> {
  return { ...(await openPersonaSession(sbx.db, sbx.seed, 'steward')), correlationId: randomUUID() };
}

/** The approved assay result of a test lot (the steward records test data in the sandbox). */
async function assay(lot: string, result: Json): Promise<string> {
  const steward = await stewardActor();
  return withCommand(sbx.db.app, { ...steward, reasonCode: 'TEST_DATA', reasonText: 'test lot assay' }, async (c) => {
    const { rows } = await c.query<{ id: string }>('select tab.record_lot_assay($1, null, $2::jsonb) as id', [lot, JSON.stringify(result)]);
    return rows[0]?.id ?? '';
  });
}

/** The balance TEST-BAL-01 as a calibrated, qualified instrument of the plant (master data, arranged by the superuser). */
async function plantBalance(): Promise<void> {
  const c = await sbx.db.admin.connect();
  try {
    await c.query('begin');
    await c.query('set local session_replication_role = replica');
    await c.query("insert into plant.product (code, name, highly_potent, recorded_by) values ('PCM500', 'Paracetamol tablets', false, gen_random_uuid()) on conflict do nothing");
    await c.query("insert into plant.equipment_class (code, kind, description, calibration_required, check_regime, recorded_by) values ('EQC-BAL', 'INSTRUMENT', 'Balance 60 kg', true, 'PER_USE', gen_random_uuid())");
    const { rows } = await c.query<{ id: string }>("insert into plant.equipment (code, name, class_code, kind, recorded_by) values ('TEST-BAL-01', 'Balance 60 kg', 'EQC-BAL', 'INSTRUMENT', gen_random_uuid()) returning id");
    const id = rows[0]?.id;
    await c.query("insert into plant.equipment_event (equipment_id, kind, reference, detail, person_id, account_id) values ($1, 'QUALIFIED', 'QUAL-BAL-01', 'IQ/OQ/PQ approved', gen_random_uuid(), gen_random_uuid())", [id]);
    await c.query("insert into plant.calibration (equipment_id, due_at, as_found, as_left, reference, person_id, account_id) values ($1, clock_timestamp() + interval '1 year', 'PASS', 'PASS', 'CAL-BAL-01', gen_random_uuid(), gen_random_uuid())", [id]);
    await c.query('commit');
  } finally {
    c.release();
  }
}

/** operator1 records the balance's per-use check for the batch and its use until 8 hours from now (plant, recipe-core 0403). */
async function balanceUse(batchId: string): Promise<void> {
  await withCommand(sbx.db.app, await operatorActor(sbx), async (c) => {
    await c.query("select plant.record_instrument_check('TEST-BAL-01', 'PASS', 'DC-BAL-01 per-use check', $1::uuid)", [batchId]);
    await c.query("select plant.record_instrument_use('TEST-BAL-01', $1::uuid, clock_timestamp() + interval '8 hours')", [batchId]);
  });
}

interface Run {
  runId: string;
  /** verifier1 (a second person). */
  ver: RunDriver;
}

const tap = () => vi.advanceTimersByTime(7_000);

/**
 * operator1 in `role` on their kiosk, in a session of its own opened now (a person holds one session at a time: the
 * newest ends the others).
 */
async function as(r: Run, role: 'DISPENSER' | 'OPERATOR' | 'VERIFIER'): Promise<RunDriver> {
  const b = role === 'OPERATOR' ? await sbx.asPersona('operator1') : await asPersonaInRole(sbx, 'operator1', role);
  const d = new RunDriver(sbx, r.runId, { operator1: b });
  d.beforeTap = tap;
  return d;
}

async function newRun(opts: { balance?: boolean; config?: Json } = {}): Promise<Run> {
  const issuer = await sbx.asPersona('issuer');
  const runId = await importAndIssue(sbx, issuer, writePackage(sbx, withTb01(opts.config)));
  if (opts.balance !== false) await balanceUse(runId);
  const ver = new RunDriver(sbx, runId, { verifier1: await sbx.asPersona('verifier1') });
  ver.beforeTap = tap;
  return { runId, ver };
}

const calc = (lots: { lotCode: string; baseEquivalent?: string }[]) => ({ type: 'RECORD_ENTRY' as const, stepKey: KEY, entry: { kind: 'POTENCY_CALCULATION' as const, lots } });
const weighManual = (item: string, bomLine: string, lotCode: string, gross: string, tare: string, extra: { fefoReason?: string } = {}) => ({
  type: 'RECORD_ENTRY' as const,
  stepKey: KEY,
  entry: { kind: 'CONTAINER_WEIGHING' as const, item, bomLine, lotCode, manual: { gross, tare, unit: 'kg', deviceCode: 'TEST-BAL-01' }, ...extra },
});

async function entryData(runId: string, kind: string): Promise<Json[]> {
  const { rows } = await sbx.db.admin.query<{ d: Json }>(
    "select e.value -> 'data' as d from recipe.execution_state s, jsonb_each(s.state -> 'entries') e where s.batch_id = $1 and e.value ->> 'kind' = $2 order by (e.value ->> 'recordedSeq')::numeric",
    [runId, kind],
  );
  return rows.map((r) => r.d);
}

/** The dispenser's own command past the server: the engine's result for `entry`, forged by `forge`, appended as the application role; the database's message, or 'ok'. */
/** JSON text of an engine value (instants are bigints). */
const asText = (v: unknown): string => JSON.stringify(v, (_k, x: unknown) => (typeof x === 'bigint' ? x.toString() : x));

/** Removes the exceptions of `type` from `state` (a handler that does not raise them); their ids. */
function dropExceptions(state: engine.BatchState, type: string): string[] {
  const ids = Object.values(state.exceptions).filter((x) => x.type === type).map((x) => x.id);
  for (const id of ids) delete (state.exceptions as Record<string, unknown>)[id];
  return ids;
}

async function forged(
  r: Run,
  entry: Json & { kind: string },
  forge: (state: engine.BatchState, command: engine.Command) => void = () => undefined,
  role: 'DISPENSER' | 'OPERATOR' = 'DISPENSER',
  strip: readonly string[] = [],
): Promise<string> {
  const ctx = await runContext(sbx.db.admin, r.runId);
  const b = (await as(r, role)).browser('operator1');
  return messageOf(
    withCommand(sbx.db.app, await actorOfBrowser(sbx, b, 'operator1'), async (c) => {
      vi.advanceTimersByTime(7_000);
      const tx = await execution.ExecutionTx.open(c, ctx.def, r.runId);
      const roles = await engineRoles(c);
      const actor: engine.Actor = { ...engineActor(personaIn(sbx, 'operator1').personId, roles), roles: ['DISPENSER'] };
      const command: engine.Command = { type: 'RECORD_ENTRY', commandId: randomUUID(), actor, step: STEP, context: [], entry };
      const res = engineResult(tx, command);
      const removed = strip.flatMap((type) => dropExceptions(res.state, type));
      const recorded = { ...command, actor: engineActor(personaIn(sbx, 'operator1').personId, roles) };
      forge(res.state, recorded);
      return appendAs(tx, recorded, { state: res.state, events: res.events.filter((ev) => !removed.some((id) => asText(ev).includes(`"${id}"`))) }, roles, engine.encodeCommand(recorded));
    }),
  );
}

const newEntry = (s: engine.BatchState, kind: string) => Object.values(s.entries).filter((e) => e.kind === kind).at(-1) as engine.EntryRecord;

beforeAll(async () => {
  sbx = await startExecServer();
  vi.useFakeTimers({ toFake: ['performance'] });
  // The room's balance behind the site gateway, not reported online yet (the manual two-person path first), with the
  // gateway listener vouching for what it received (tablets 0350): the manual path is open.
  await enrolGateway(sbx.db.app, await adminActor(sbx), { ...DEMO_GATEWAY, spki: gatewayKey(sbx).publicKeySpki, instruments: DEMO_INSTRUMENTS });
  gw = await fakeGateway(sbx);
  if (!(await untilVouched(sbx))) throw new Error('SETUP: the gateway listener did not vouch within 20 s');
  const steward = await stewardActor();
  await registerLots(sbx.db.app, { ...steward, correlationId: randomUUID() }, [
    { lotCode: 'TEST-L26-0111', materialCode: 'MAT-PCM', materialName: 'Paracetamol, later lot', status: 'RELEASED', identityTested: true, expiresInDays: 900, retestInDays: 400 },
    { lotCode: 'TEST-L26-0112', materialCode: 'MAT-MCC', materialName: 'MCC, later lot', status: 'RELEASED', identityTested: true, expiresInDays: 900, retestInDays: 400 },
    { lotCode: 'TEST-L26-0113', materialCode: 'MAT-PCM', materialName: 'Paracetamol, retest due', status: 'RELEASED', identityTested: true, expiresInDays: 800, retestInDays: -1 },
  ]);
  await assay('TEST-L26-0101', { basis: 'AS_IS', assay: '98.5', certificateRef: 'COA-0101' });
  await assay('TEST-L26-0111', { basis: 'AS_IS', assay: '99.0', certificateRef: 'COA-0111' });
  await assay('TEST-L26-0113', { basis: 'AS_IS', assay: '99.0', certificateRef: 'COA-0113' });
  await assay('TEST-L26-0199', { basis: 'AS_IS', assay: '99.0', certificateRef: 'COA-0199' });
  await grant('operator1', 'DISPENSER');
  await grant('operator1', 'VERIFIER');
  await plantBalance();
}, 300_000);

afterAll(async () => {
  vi.useRealTimers();
  await gw?.close();
  await sbx?.close();
});

describe('TB-01 in the database: registers and the lot assay register (tablets 0840, 0841)', () => {
  it('[DI-30][DI-05] the database holds TB-01@1\'s data schemas as the registry declares them, its check meaning, and every rule code its messages name', async () => {
    const { rows } = await sbx.db.admin.query<{ k: string; s: Json }>("select entry_kind as k, schema as s from recipe.block_data_schema where block_type = 'TB-01' and block_version = '1' order by 1");
    expect(rows.map((r) => r.k)).toEqual(Object.keys(TB01.dataSchema?.entries ?? {}).sort());
    const meanings = await sbx.db.admin.query<{ m: string }>("select part || ' ' || meaning_code as m from recipe.block_signature_meaning where block_type = 'TB-01'");
    expect(meanings.rows.map((r) => r.m)).toEqual(['check CONTAINER_CHECKED']);
    const { readFileSync } = await import('node:fs');
    const src = ['../../../src/blocks/tb-01.ts', '../../../src/blocks/dispensing/potency.ts', '../../../sql/0842_tb01_calculation.sql', '../../../sql/0843_tb01_entry_guards.sql']
      .map((f) => readFileSync(new URL(f, import.meta.url), 'utf8'))
      .join('\n');
    const codes = [...new Set(src.match(/TB01-[A-Z]+(?:-[A-Z]+)*/g) ?? [])].sort();
    const known = await sbx.db.admin.query<{ n: string }>("select name as n from recipe.engine_name where name like 'TB01-%' or name = 'TB-01'");
    expect(known.rows.map((r) => r.n)).toEqual(expect.arrayContaining([...codes, 'TB-01']));
  });

  it('[DI-17][DI-18] the new functions pin their search path with pg_temp last, are private to the owner, and the application role executes only the two register functions and the two readers the server needs', async () => {
    const { rows } = await sbx.db.admin.query<{ f: string; owner: string; config: string[] | null; pub: boolean }>(
      `select p.oid::regprocedure::text as f, pg_get_userbyid(p.proowner) as owner, p.proconfig as config,
              coalesce(exists (select 1 from aclexplode(p.proacl) a where a.grantee = 0 and a.privilege_type = 'EXECUTE'), p.proacl is null) as pub
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where (n.nspname = 'tab' and (p.proname like 'tb01%' or p.proname in ('record_lot_assay', 'lot_assay_of')))
           or (n.nspname = 'recipe' and p.proname in ('refusal_problem', 'new_container_problem', 'weighing_item_problem', 'skip_problem'))
        order by 1`,
    );
    expect(rows.length).toBe(17);
    for (const r of rows) {
      expect(r.owner, r.f).toBe('ebmr_owner');
      expect(r.config?.find((c) => c.startsWith('search_path=')), r.f).toMatch(/, pg_temp$/);
      expect(r.pub, r.f).toBe(false);
    }
    const app = (await sbx.db.app.query<{ u: string }>('select current_user as u')).rows[0]?.u ?? '';
    const { rows: granted } = await sbx.db.admin.query<{ f: string }>(
      `select p.oid::regprocedure::text as f from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'tab' and (p.proname like 'tb01%' or p.proname in ('record_lot_assay', 'lot_assay_of')) and has_function_privilege($1, p.oid, 'execute') order by 1`,
      [app],
    );
    expect(granted.map((r) => r.f)).toEqual([
      'tab.lot_assay_of(text,uuid)',
      'tab.record_lot_assay(text,text,jsonb,text)',
      'tab.tb01_first_expiring(uuid,text,text[],timestamp with time zone)',
      'tab.tb01_reservation_for(uuid,text,numeric,text)',
    ]);
  });

  it('[PR-19][DI-33] an approved assay result is recorded once per lot with the values its basis needs; a later one supersedes it only with a reason, both stay; nobody writes the table directly', async () => {
    const steward = await stewardActor();
    const as = (p: Promise<unknown>) => codeOf(p);
    const record = (lot: string, result: Json, reason: string | null = null) =>
      withCommand(sbx.db.app, { ...steward, reasonCode: 'TEST_DATA', reasonText: 'assay' }, (c) => c.query('select tab.record_lot_assay($1, null, $2::jsonb, $3)', [lot, JSON.stringify(result), reason]));
    expect(await as(record('TEST-L26-0102', { basis: 'ANHYDROUS_WATER', assay: '99.0', certificateRef: 'COA-0102' }))).toBe('EBMR-EXE-242');
    expect(await as(record('TEST-L26-0102', { basis: 'AS_IS', assay: 99, certificateRef: 'COA-0102' }))).toBe('EBMR-EXE-242');
    expect(await as(record('TEST-L26-0111', { basis: 'AS_IS', assay: '99.4', certificateRef: 'COA-0111b' }))).toBe('EBMR-EXE-242');
    expect(await as(record('TEST-L26-0111', { basis: 'AS_IS', assay: '99.4', certificateRef: 'COA-0111b' }, 'Retest of the reserve sample after the OOS investigation'))).toBe('ok');
    const { rows } = await sbx.db.admin.query<{ a: string; s: boolean }>(
      "select r.assay::text as a, r.supersedes is not null as s from tab.lot_assay_result r where r.sandbox_lot_code = 'TEST-L26-0111' order by r.recorded_at",
    );
    expect(rows).toEqual([{ a: '99.0', s: false }, { a: '99.4', s: true }]);
    const audit = await sbx.db.admin.query<{ n: string }>("select count(*)::text as n from kernel.audit_event where table_name = 'tab.lot_assay_result'");
    expect(Number(audit.rows[0]?.n)).toBeGreaterThanOrEqual(5);
    expect(await codeOf(sbx.db.app.query("insert into tab.lot_assay_result (sandbox_lot_code, basis, assay, certificate_ref, recorded_by_person, recorded_by_account, correlation_id) values ('TEST-L26-0102', 'AS_IS', 100, 'x', gen_random_uuid(), gen_random_uuid(), gen_random_uuid())"))).toMatch(/permission denied/);
    // The supersession above leaves the 99.0 % result behind; the dispensing tests read the current one.
    await record('TEST-L26-0111', { basis: 'AS_IS', assay: '99.0', certificateRef: 'COA-0111c' }, 'Certificate corrected back to the original value');
  });
});

describe('TB-01 end to end in a test run (sandbox)', () => {
  let r: Run;
  beforeAll(async () => {
    r = await newRun();
  }, 120_000);

  it('[PR-19] a non-designated user is refused: an operator without the dispenser designation cannot start the step', async () => {
    const res = await (await as(r, 'OPERATOR')).command('operator1', { type: 'START_STEP', stepKey: KEY });
    expect(outcomeOf(res)).toMatch(/^4\d\d:/);
    await (await as(r, 'DISPENSER')).ok('operator1', { type: 'START_STEP', stepKey: KEY });
  });

  it('[PR-18][IN-23] a quarantined lot and a lot past its retest date are refused in the calculation; a lot without an approved result blocks it', async () => {
    const quarantined = await (await as(r, 'DISPENSER')).command('operator1', calc([{ lotCode: 'TEST-L26-0199' }]));
    expect(refusalOf(quarantined)?.why).toMatch(/TB01-LOT-STATUS/);
    const retest = await (await as(r, 'DISPENSER')).command('operator1', calc([{ lotCode: 'TEST-L26-0113' }]));
    expect(refusalOf(retest)?.why).toMatch(/TB01-LOT-RETEST/);
    const noResult = await (await as(r, 'DISPENSER')).command('operator1', calc([{ lotCode: 'TEST-L26-0103' }]));
    expect(refusalOf(noResult)?.code).toBe('EBMR-EXE-243');
  });

  it('[PR-19][DI-33] the paracetamol lot assayed at 98.5 % raises the active target to 50.762 kg and lowers the MCC to 8.639 kg; the calculation is stored with its inputs and audited', async () => {
    await (await as(r, 'DISPENSER')).ok('operator1', calc([{ lotCode: 'TEST-L26-0101' }]));
    const [data] = await entryData(r.runId, 'POTENCY_CALCULATION');
    expect(data).toMatchObject({
      lots: [{ lot: { id: 'TEST-L26-0101', material: 'MAT-PCM', status: 'RELEASED' }, assay: { basis: 'AS_IS', assay: '98.5' } }],
      results: [{ lot: 'TEST-L26-0101', asIsAssay: '98.5', baseEquivalent: '50', calculated: '50.761421', target: '50.762' }],
      active: { bomLine: 'BOM-PCM', standardQuantity: '50.000', standard: '50.000000' },
      excipient: { bomLine: 'BOM-MCC', standard: '9.400', calculated: '8.638579', target: '8.639' },
      total: { standard: '59.400000', target: '59.401' },
    });
    const audit = await sbx.db.admin.query<{ n: string }>("select count(*)::text as n from kernel.audit_event where chain_key = 'batch:' || $1 and payload::text like '%RECORD_ENTRY p-tb01@%accepted%'", [r.runId]);
    expect(Number(audit.rows[0]?.n)).toBeGreaterThan(0);
  });

  it('[PR-19][DI-33] past the server, a calculation whose recorded target differs from its inputs, or whose assay is typed instead of the lot\'s approved result, is refused by the database', async () => {
    const lot = { id: 'TEST-L26-0101', material: 'MAT-PCM', status: 'RELEASED', identityTested: true };
    const facts = (await sbx.db.admin.query<{ f: Json }>('select tab.lot_facts($1, $2::uuid) as f', ['TEST-L26-0101', r.runId])).rows[0]?.f ?? {};
    const reg = { ...lot, expiresAtUs: facts['expiresAtUs'], retestAtUs: facts['retestAtUs'] };
    const result = (await sbx.db.admin.query<{ a: Json }>('select tab.lot_assay_of($1, $2::uuid) as a', ['TEST-L26-0101', r.runId])).rows[0]?.a ?? {};
    const honest = { kind: 'POTENCY_CALCULATION', lots: [{ lot: reg, assay: result }] };
    const results = (s: engine.BatchState) => ((newEntry(s, 'POTENCY_CALCULATION').data['results'] as Json[])[0] as Json);
    expect(await forged(r, honest, (s) => void (results(s)['target'] = '50.000'))).toMatch(/TB01-RECOMPUTE.*EBMR-EXE-240/s);
    const typed = { kind: 'POTENCY_CALCULATION', lots: [{ lot: reg, assay: { ...result, assay: '99.0' } }] };
    expect(await (forged(r, typed))).toMatch(/TB01-REGISTER.*EBMR-EXE-240/s);
  });

  it('[PR-18] picking a newer lot demands a reason: the MCC lot expiring later is refused without one, and recorded with one as FEFO_OVERRIDE; past the server the database refuses it without a reason', async () => {
    const noReason = await (await as(r, 'DISPENSER')).command('operator1', weighManual('tbMcc', 'BOM-MCC', 'TEST-L26-0112', '9.639', '1.000'));
    expect(refusalOf(noReason)?.code).toBe('EBMR-EXE-244');
    expect(refusalOf(noReason)?.whatYouCanDo.join(' ')).toMatch(/TEST-L26-0102/);
    const facts = (await sbx.db.admin.query<{ f: Json }>('select tab.lot_facts($1, $2::uuid) as f', ['TEST-L26-0112', r.runId])).rows[0]?.f ?? {};
    const lot = { id: 'TEST-L26-0112', material: 'MAT-MCC', status: 'RELEASED', expiresAtUs: facts['expiresAtUs'], retestAtUs: facts['retestAtUs'], identityTested: true };
    const bypass = { kind: 'CONTAINER_WEIGHING', item: 'tbMcc', bomLine: 'BOM-MCC', container: `${await batchNumber(r.runId)}/C90`, lot, gross: '9.639', tare: '1.000', unit: 'kg', balance: 'TEST-BAL-01', source: 'MANUAL' };
    expect(await (forged(r, bypass))).toMatch(/TB01-FEFO.*EBMR-EXE-240/s);
    await (await as(r, 'DISPENSER')).ok('operator1', weighManual('tbMcc', 'BOM-MCC', 'TEST-L26-0112', '9.639', '1.000', { fefoReason: 'The earlier lot is held in the cold room for the next campaign' }));
    const exceptions = (await (await as(r, 'DISPENSER')).runView('operator1')).exceptions.filter((e) => e.type === 'FEFO_OVERRIDE');
    expect(exceptions).toHaveLength(1);
  });

  it('[PR-20][DI-30] with the scale offline the step switches to two-person mode: the hand-keyed weighing is flagged, and the dispenser cannot verify their own dispensing', async () => {
    await (await as(r, 'DISPENSER')).ok('operator1', weighManual('tbApi', 'BOM-PCM', 'TEST-L26-0101', '51.762', '1.000'));
    const [w] = await entryData(r.runId, 'CONTAINER_WEIGHING');
    expect(w).toMatchObject({ source: 'MANUAL', balance: 'TEST-BAL-01' });
    const { rows } = await sbx.db.admin.query<{ v: boolean }>("select (state -> 'steps' -> $2 ->> 'verificationRequired')::boolean as v from recipe.execution_state where batch_id = $1", [r.runId, KEY]);
    expect(rows[0]?.v).toBe(true);
    await (await as(r, 'DISPENSER')).signed('operator1', { type: 'SIGN_PERFORMED', stepKey: KEY });
    const self = await (await as(r, 'VERIFIER')).sign('operator1', { type: 'VERIFY', stepKey: KEY, meaning: 'VERIFIED' });
    expect(self.result.ok ? 'ok' : refusalOf(self.result)?.code).toBe('ENG-SEGREGATION');
    expect((await (await as(r, 'DISPENSER')).runView('operator1')).exceptions.map((e) => e.type).sort()).toEqual(['FEFO_OVERRIDE', 'MANUAL_ENTRY_FALLBACK', 'MANUAL_ENTRY_FALLBACK']);
    await r.ver.signed('verifier1', { type: 'VERIFY', stepKey: KEY, meaning: 'VERIFIED' });
    const { rows: st } = await sbx.db.admin.query<{ s: string }>("select state -> 'steps' -> $2 ->> 'status' as s from recipe.execution_state where batch_id = $1", [r.runId, KEY]);
    expect(st[0]?.s).toBe('COMPLETED');
  });

  it('[PR-19] each dispensed container is labelled with the component, its lot, the quantity and the destination batch and product, and a unique container id', async () => {
    const [mcc, api] = await entryData(r.runId, 'CONTAINER_WEIGHING');
    const batch = await batchNumber(r.runId);
    expect(api?.['label']).toEqual({ component: 'MAT-PCM', lot: 'TEST-L26-0101', quantity: '50.762 kg', batch, product: 'PCM500', container: api?.['container'] });
    expect(mcc?.['label']).toMatchObject({ lot: 'TEST-L26-0112', quantity: '8.639 kg', batch });
    expect(api?.['container']).not.toBe(mcc?.['container']);
  });
});

describe('TB-01 balance and stock rules in the database', () => {
  it('[IN-25][PR-19] a weighing on a balance with no instrument use for the batch is refused by the database', async () => {
    const r = await newRun({ balance: false });
    await (await as(r, 'DISPENSER')).ok('operator1', { type: 'START_STEP', stepKey: KEY });
    await (await as(r, 'DISPENSER')).ok('operator1', calc([{ lotCode: 'TEST-L26-0101' }]));
    const res = await (await as(r, 'DISPENSER')).command('operator1', weighManual('tbApi', 'BOM-PCM', 'TEST-L26-0101', '51.762', '1.000'));
    expect(refusalOf(res)?.code).toBe('EBMR-EXE-240');
    expect(refusalOf(res)?.why).toMatch(/TB01-INSTRUMENT/);
  });

  it('[PR-19][INV-14] past the server, a test run\'s weighing that names a lot consumption, or a calculation recorded by a person acting without the designation, is refused', async () => {
    const r = await newRun();
    await (await as(r, 'DISPENSER')).ok('operator1', { type: 'START_STEP', stepKey: KEY });
    await (await as(r, 'DISPENSER')).ok('operator1', calc([{ lotCode: 'TEST-L26-0101' }]));
    const facts = (await sbx.db.admin.query<{ f: Json }>('select tab.lot_facts($1, $2::uuid) as f', ['TEST-L26-0101', r.runId])).rows[0]?.f ?? {};
    const lot = { id: 'TEST-L26-0101', material: 'MAT-PCM', status: 'RELEASED', expiresAtUs: facts['expiresAtUs'], retestAtUs: facts['retestAtUs'], identityTested: true };
    const w = { kind: 'CONTAINER_WEIGHING', item: 'tbApi', bomLine: 'BOM-PCM', container: `${await batchNumber(r.runId)}/C91`, lot, gross: '51.762', tare: '1.000', unit: 'kg', balance: 'TEST-BAL-01', source: 'MANUAL', consumption: randomUUID() };
    expect(await (forged(r, w))).toMatch(/TB01-CONSUMPTION.*EBMR-EXE-240/s);
    const result = (await sbx.db.admin.query<{ a: Json }>('select tab.lot_assay_of($1, $2::uuid) as a', ['TEST-L26-0101', r.runId])).rows[0]?.a ?? {};
    const again = { kind: 'POTENCY_CALCULATION', lots: [{ lot, assay: result }] };
    expect(await forged(r, again, () => undefined, 'OPERATOR')).toMatch(/without the dispenser designation \(TB01-DESIGNATION; PR-19\)\. \[EBMR-EXE-240\]/);
  });
});

describe('TB-01 review fixes: the exceptions a breach raises, superseded results, closed configurations, skips', () => {
  const honestCalc = async (r: Run) => {
    const facts = (await sbx.db.admin.query<{ f: Json }>('select tab.lot_facts($1, $2::uuid) as f', ['TEST-L26-0101', r.runId])).rows[0]?.f ?? {};
    const lot = { id: 'TEST-L26-0101', material: 'MAT-PCM', status: 'RELEASED', expiresAtUs: facts['expiresAtUs'], retestAtUs: facts['retestAtUs'], identityTested: true };
    const result = (await sbx.db.admin.query<{ a: Json }>('select tab.lot_assay_of($1, $2::uuid) as a', ['TEST-L26-0101', r.runId])).rows[0]?.a ?? {};
    return { lot, entry: { kind: 'POTENCY_CALCULATION', lots: [{ lot, assay: result }] } };
  };

  it('[PR-19][PR-04] past the server, a calculation beyond the MBR\'s adjustment cap without POTENCY_ADJUSTMENT_CAP is refused; with it, it is recorded', async () => {
    const r = await newRun({ config: { adjustmentCapPercent: '1.0' } });
    await (await as(r, 'DISPENSER')).ok('operator1', { type: 'START_STEP', stepKey: KEY });
    const { entry } = await honestCalc(r);
    expect(await forged(r, entry, () => undefined, 'DISPENSER', ['POTENCY_ADJUSTMENT_CAP'])).toMatch(/beyond the MBR's cap of 1\.0 %, and the row raises no POTENCY_ADJUSTMENT_CAP.*EBMR-EXE-240/s);
    expect(await forged(r, entry)).toBe('ok');
  });

  it('[PR-18] past the server, a lot dispensed out of rotation without FEFO_OVERRIDE in the same row is refused', async () => {
    const r = await newRun();
    await (await as(r, 'DISPENSER')).ok('operator1', { type: 'START_STEP', stepKey: KEY });
    await (await as(r, 'DISPENSER')).ok('operator1', calc([{ lotCode: 'TEST-L26-0101' }]));
    const facts = (await sbx.db.admin.query<{ f: Json }>('select tab.lot_facts($1, $2::uuid) as f', ['TEST-L26-0112', r.runId])).rows[0]?.f ?? {};
    const lot = { id: 'TEST-L26-0112', material: 'MAT-MCC', status: 'RELEASED', expiresAtUs: facts['expiresAtUs'], retestAtUs: facts['retestAtUs'], identityTested: true };
    const w = { kind: 'CONTAINER_WEIGHING', item: 'tbMcc', bomLine: 'BOM-MCC', container: `${await batchNumber(r.runId)}/C95`, lot, gross: '9.639', tare: '1.000', unit: 'kg', balance: 'TEST-BAL-01', source: 'MANUAL', fefoReason: 'Earlier lot held for the next campaign' };
    expect(await forged(r, w, () => undefined, 'DISPENSER', ['FEFO_OVERRIDE'])).toMatch(/raises no FEFO_OVERRIDE.*EBMR-EXE-240/s);
  });

  it('[PR-19] past the server, the step closes with a line outside its tolerance only with DISPENSE_OUT_OF_TOLERANCE raised', async () => {
    const r = await newRun();
    const d = await as(r, 'DISPENSER');
    await d.ok('operator1', { type: 'START_STEP', stepKey: KEY });
    await (await as(r, 'DISPENSER')).ok('operator1', calc([{ lotCode: 'TEST-L26-0101' }]));
    await (await as(r, 'DISPENSER')).ok('operator1', weighManual('tbApi', 'BOM-PCM', 'TEST-L26-0101', '51.762', '1.000'));
    await (await as(r, 'DISPENSER')).ok('operator1', weighManual('tbMcc', 'BOM-MCC', 'TEST-L26-0102', '10.000', '1.000'));
    const run = await runContext(sbx.db.admin, r.runId);
    const who = personaIn(sbx, 'operator1');
    const signed = async (strip: boolean) => {
      const b = (await as(r, 'DISPENSER')).browser('operator1');
      const p = await prepareSignature(sbx, b, 'operator1', 'batch_step', `${r.runId}:${KEY}`, 'PERFORMED');
      return messageOf(
        withCommand(sbx.db.app, await p.actor(), async (c) => {
          const id = await p.sign(c);
          const tx = await execution.ExecutionTx.open(c, run.def, r.runId);
          const roles = await engineRoles(c);
          const command: engine.Command = { type: 'SIGN_PERFORMED', commandId: randomUUID(), actor: engineActor(who.personId, roles), step: STEP, context: [], signature: { id, meaning: 'PERFORMED', signer: who.personId } };
          const res = engineResult(tx, command);
          const removed = strip ? dropExceptions(res.state, 'DISPENSE_OUT_OF_TOLERANCE') : [];
          expect(strip ? removed.length : 1).toBe(1);
          return appendAs(tx, command, { state: res.state, events: res.events.filter((ev) => !removed.some((x) => asText(ev).includes(`"${x}"`))) }, roles);
        }),
      );
    };
    expect(await signed(true)).toMatch(/with 9 kg of BOM-MCC dispensed against its target 8\.639.*no DISPENSE_OUT_OF_TOLERANCE raised.*EBMR-EXE-240/s);
    expect(await signed(false)).toBe('ok');
  });

  it('[PR-19][DI-33] a weighing against a calculation whose lot result QC has superseded since is refused', async () => {
    const r = await newRun();
    await (await as(r, 'DISPENSER')).ok('operator1', { type: 'START_STEP', stepKey: KEY });
    await (await as(r, 'DISPENSER')).ok('operator1', calc([{ lotCode: 'TEST-L26-0101' }]));
    const steward = await stewardActor();
    await withCommand(sbx.db.app, { ...steward, reasonCode: 'TEST_DATA', reasonText: 'assay' }, (c) =>
      c.query("select tab.record_lot_assay('TEST-L26-0101', null, $1::jsonb, 'Certificate reissued after the review')", [JSON.stringify({ basis: 'AS_IS', assay: '98.5', certificateRef: 'COA-0101b' })]),
    );
    const res = await (await as(r, 'DISPENSER')).command('operator1', weighManual('tbApi', 'BOM-PCM', 'TEST-L26-0101', '51.762', '1.000'));
    expect(refusalOf(res)?.code).toBe('EBMR-EXE-240');
    expect(refusalOf(res)?.why).toMatch(/TB01-RESULT-SUPERSEDED/);
  });

  it('[PR-19] the database refuses a calculation naming a lot twice, at a step whose configuration states no standard basis, or whose compensation has no approved range', async () => {
    const content = withTb01();
    const node = (((((content.procedure.body as unknown as Json)['children'] as Json[])[0] as Json)['body'] as Json)['children'] as Json[])[0] as Json;
    const prep = (((node['body'] as Json)['children'] as Json[])[0] as Json);
    const cfg = prep['config'] as Json;
    const lot = { lot: { id: 'TEST-L26-0101' }, assay: { basis: 'AS_IS', assay: '98.5' } };
    const problem = async (config: Json, lots: Json[]) =>
      (await sbx.db.admin.query<{ p: string | null }>("select tab.tb01_calculation($1::jsonb, $2::jsonb, $3::jsonb) ->> 'problem' as p", [JSON.stringify(config), JSON.stringify(content), JSON.stringify(lots)])).rows[0]?.p ?? null;
    expect(await problem(cfg, [lot])).toBeNull();
    expect(await problem(cfg, [{ ...lot, baseEquivalent: '25' }, { ...lot, baseEquivalent: '25' }])).toMatch(/names a lot twice/);
    expect(await problem({ ...cfg, active: { ...(cfg['active'] as Json), standardIs: undefined } }, [lot])).toMatch(/no standard basis/);
    expect(await problem({ ...cfg, compensation: { mode: 'EXCIPIENT', bomLine: 'BOM-MCC' } }, [lot])).toMatch(/approved range/);
  });

  it('[PR-13][PR-16] the database never lets a TB-01 to TB-07 step be skipped, even one the MBR marks skippable that moves no material', async () => {
    for (const type of ['TB-01', 'TB-02', 'TB-03', 'TB-04', 'TB-05', 'TB-06', 'TB-07']) {
      const node = { kind: 'phase', id: 'p-x', block: { type, version: '1' }, config: { skippable: true }, records: [], consumes: [], produces: [], uses: [] };
      const { rows } = await sbx.db.admin.query<{ p: string | null }>('select recipe.skip_problem($1::jsonb, $2::jsonb) as p', [JSON.stringify(withTb01()), JSON.stringify(node)]);
      expect(rows[0]?.p, type).toMatch(/never skipped/);
    }
  });
});

describe('TB-01 with the balance online (scale readings)', () => {
  it('[PR-20][DI-32] once the room\'s scale is online the weights come from its readings: a hand-keyed weighing is refused and a weighing from the readings needs no fallback', async () => {
    if (!gw) throw new Error('SETUP: no gateway');
    await report({ server: sbx, gw }, { 'TEST-BAL-01': 'ONLINE' });
    const r = await newRun();
    await (await as(r, 'DISPENSER')).ok('operator1', { type: 'START_STEP', stepKey: KEY });
    await (await as(r, 'DISPENSER')).ok('operator1', calc([{ lotCode: 'TEST-L26-0101' }]));
    const reading = async (purpose: 'TARE' | 'GROSS', value: string) => {
      const x = gw?.next({ deviceCode: 'TEST-BAL-01', serial: 'SIM-0001', purpose, value });
      if (!gw || !x) throw new Error('SETUP: no gateway');
      const res = await gw.uplink([{ reading: x, delayUs: '1000' }]);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      return x.readingId;
    };
    const manual = await (await as(r, 'DISPENSER')).command('operator1', weighManual('tbApi', 'BOM-PCM', 'TEST-L26-0101', '51.762', '1.000'));
    expect(refusalOf(manual)?.code).toBe('EBMR-EXE-074');
    const tare = await reading('TARE', '1.000');
    const gross = await reading('GROSS', '51.762');
    await (await as(r, 'DISPENSER')).ok('operator1', { type: 'RECORD_ENTRY', stepKey: KEY, entry: { kind: 'CONTAINER_WEIGHING', item: 'tbApi', bomLine: 'BOM-PCM', lotCode: 'TEST-L26-0101', tareReadingId: tare, grossReadingId: gross } });
    const [w] = await entryData(r.runId, 'CONTAINER_WEIGHING');
    expect(w).toMatchObject({ source: 'DEVICE', balance: 'TEST-BAL-01', net: '50.762' });
    const { rows } = await sbx.db.admin.query<{ v: boolean | null }>("select (state -> 'steps' -> $2 ->> 'verificationRequired')::boolean as v from recipe.execution_state where batch_id = $1", [r.runId, KEY]);
    expect(rows[0]?.v ?? false).toBe(false);
  });
});

async function batchNumber(runId: string): Promise<string> {
  const { rows } = await sbx.db.admin.query<{ n: string }>('select batch_number as n from recipe.batch_execution where id = $1', [runId]);
  return rows[0]?.n ?? '';
}

