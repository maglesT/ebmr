/**
 * Injectables I-6, INV-23 (c) (lead rulings, 14 November 2026; tablets 1915): a filling line fills an aseptic batch only
 * while its aseptic process simulation is valid (Schedule M Part II 5.5, 21 CFR 211.113(b), paraphrased: the aseptic
 * process is validated by media fills repeated at set intervals). The validity is the line's last passing APS (a media
 * fill read with no contaminated unit, as ST-33 reads it, tablets 1912) plus the interval the firm sets for the line,
 * with QA's approval and no default. The database refuses the entry that names the line in an injectables processing
 * batch with no terminal sterilisation step: with no interval in force (EBMR-PLANT-092), with no passing APS or one
 * whose validity has ended (EBMR-PLANT-093). A lapse during the fill does not refuse later entries: the step's sign-off
 * waits for an ACTION exception, its deviation and QA's disposition (EBMR-PLANT-094). A media fill (a process
 * simulation), a terminally sterilised master, a packaging block's line and a tablets master are not checked.
 *
 * The passage of time is arranged by moving a media fill's recorded line use into the past (test arrangement of the
 * record, triggers off), as aps-failure.test.ts moves a calibration. Arranged outside the routes as there: the products,
 * the plant units, the EM plates' released media lot, the ERP orders and the numbering rules. The interval is set the way
 * a firm sets it: the steward proposes it and QA approves it, each as themselves through the database commands.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { routes } from '@ebmr/api-contract';
import { library, type flow } from '@ebmr/recipe-core/pure';
import { openServiceSession } from '@ebmr/test-kit';
import { postOrder } from '../../../../packages/recipe-core/test/lifecycle/gmp-support.ts';
import { cell, reason, type World } from '../../../../packages/recipe-core/test/lifecycle/support.ts';
import { INJECTABLE_SEEDS } from '../../../../packages/recipe-core/src/library/seed/injectables.ts';
import { INJECTABLE_ASEPTIC_SEEDS } from '../../../../packages/recipe-core/src/library/seed/injectables-aseptic.ts';
import { startSigningServer, valueOf } from '../esig/support.ts';
import type { ExecServer, RunDriver } from '../execution/support.ts';
import { actorOf, gmpContent, gmpLifecycleWorld } from '../support/gmp-world.ts';
import { confirmErpPending } from '../support/signed-acts.ts';
import { driverOf, issueBatch, libraryEntry, phaseOf, signAs, stage, type Json } from '../substance/support.ts';

vi.setConfig({ testTimeout: 300_000 });

const SITE = 'SITE-1';
const LINE = 'L1';
const SIZE = 'BS-100K';
const TAG = randomUUID().slice(0, 6).toUpperCase();
const REASON = 'Injectables INV-23 APS interval';

const seed = (code: string) => {
  const item = [...INJECTABLE_SEEDS, ...INJECTABLE_ASEPTIC_SEEDS].find((s) => s.definition.code === code);
  if (!item) throw new Error(`no injectables seed ${code}`);
  return item;
};
const FILL = seed('INJ-FILL');
const READ = seed('INJ-APS-READ');
const EM = seed('INJ-EM');
const COUNTS = seed('INJ-EM-COUNTS');
const TERMINAL = seed('INJ-TERMINAL-STERILISE');
type Item = { definition: library.BlockDefinition; exampleUse: unknown };

const MF_PRODUCT = { code: `INJIVM-${TAG}`, name: 'Media fill (TSB) 2 mL vials (APS interval)', strength: '2 mL' };
const PRODUCT = { code: `INJIV-${TAG}`, name: 'Demoinj aseptic 10 mg/2 mL vials (APS interval)', strength: '10 mg/2 mL' };
const TS_PRODUCT = { code: `INJIVT-${TAG}`, name: 'Demoinj sterilised 10 mg/2 mL vials (APS interval)', strength: '10 mg/2 mL' };
const DAY_US = 86_400_000_000n;

const strip = (m: Json): void => {
  for (const x of ['parameters', 'calculations', 'yieldCheckpoints', 'timeConstraints', 'goldenCases', 'intermediates', 'riskReductions', 'inputs']) m[x] = [];
};
const headerOf = (m: Json, family: string, p: { code: string; name: string; strength: string }, title: string): Json => {
  const header = m['header'] as Json;
  header['family'] = family;
  header['edition'] = 'injectables';
  header['recordKind'] = 'PROCESSING';
  header['marketSet'] = ['IN'];
  header['title'] = `${p.name}: ${title}`;
  header['product'] = { code: p.code, name: p.name, strength: p.strength, dosageForm: 'Injection' };
  delete header['unitMassMg'];
  return header;
};

/** The media fill for India (a process simulation): the filling with the EM during it, the reading, the EM counts. */
const mediaFill: flow.MbrContent = gmpContent((m) => {
  headerOf(m, `INJ-IVM-${TAG}`, MF_PRODUCT, 'aseptic process simulation')['nonProduct'] = 'PROCESS_SIMULATION';
  const body = (m['procedure'] as Json)['body'] as Json;
  const like = (body['children'] as Json[])[0] as Json;
  body['children'] = [
    stage(like, 'S-FILL', 'Aseptic filling with growth medium', [phaseOf(FILL.definition, 'p-fill', FILL.exampleUse), phaseOf(EM.definition, 'p-em', EM.exampleUse)]),
    stage(like, 'S-READ', 'Incubation and reading', [phaseOf(READ.definition, 'p-read', READ.exampleUse)]),
    stage(like, 'S-EM', 'Environmental monitoring after incubation', [phaseOf(COUNTS.definition, 'p-counts', COUNTS.exampleUse)]),
  ];
  strip(m);
  m['blockDefinitions'] = [FILL.definition, EM.definition, READ.definition, COUNTS.definition];
});

/** The product's aseptic processing master: the filling with the EM during it, the EM counts after incubation. */
const productMaster: flow.MbrContent = gmpContent((m) => {
  headerOf(m, `INJ-IVP-${TAG}`, PRODUCT, 'aseptic filling');
  const body = (m['procedure'] as Json)['body'] as Json;
  const like = (body['children'] as Json[])[0] as Json;
  body['children'] = [
    stage(like, 'S-FILL', 'Aseptic filling', [phaseOf(FILL.definition, 'p-fill', FILL.exampleUse), phaseOf(EM.definition, 'p-em', EM.exampleUse)]),
    stage(like, 'S-EM', 'Environmental monitoring after incubation', [phaseOf(COUNTS.definition, 'p-counts', COUNTS.exampleUse)]),
  ];
  strip(m);
  m['blockDefinitions'] = [FILL.definition, EM.definition, COUNTS.definition];
});

/** A terminally sterilised product's master: the filling, then the terminal sterilisation (role TERMINAL_STERILISATION). */
const tsMaster: flow.MbrContent = gmpContent((m) => {
  headerOf(m, `INJ-IVT-${TAG}`, TS_PRODUCT, 'filling and terminal sterilisation');
  const body = (m['procedure'] as Json)['body'] as Json;
  const like = (body['children'] as Json[])[0] as Json;
  body['children'] = [
    stage(like, 'S-FILL', 'Filling', [phaseOf(FILL.definition, 'p-fill', FILL.exampleUse)]),
    stage(like, 'S-TS', 'Terminal sterilisation', [phaseOf(TERMINAL.definition, 'p-ts', TERMINAL.exampleUse)]),
  ];
  strip(m);
  m['blockDefinitions'] = [FILL.definition, TERMINAL.definition];
});

type Key = 'MF' | 'PRODUCT' | 'TS';
const MASTERS: Record<Key, flow.MbrContent> = { MF: mediaFill, PRODUCT: productMaster, TS: tsMaster };
let gmp: ExecServer;
let world: World;
const versions: Partial<Record<Key, { familyId: string; versionId: string }>> = {};

type Units = { line: string; room: string; incubator: string };
const EM_UNITS = { room: `ROOM-B-${TAG}`, counter: `COUNTER-${TAG}`, mediaLot: `TSA-${TAG}` } as const;

/** Plant units (test arrangement of master data, triggers off): qualified, of the given classes. */
async function arrangeEquipment(rows: readonly (readonly [string, string, string])[]): Promise<void> {
  const c = await gmp.db.admin.connect();
  try {
    await c.query('begin');
    await c.query('set local session_replication_role = replica');
    for (const [cls, code, name] of rows) {
      await c.query(
        "insert into plant.equipment_class (code, kind, description, clean_hold, dirty_hold, calibration_required, recorded_by) values ($1, 'PROCESS', $2, interval '3 days', interval '2 days', false, gen_random_uuid()) on conflict do nothing",
        [cls, name],
      );
      const { rows: r } = await c.query<{ id: string }>("insert into plant.equipment (code, name, class_code, kind, recorded_by) values ($1, $2, $3, 'PROCESS', gen_random_uuid()) returning id", [code, name, cls]);
      await c.query("insert into plant.equipment_event (equipment_id, kind, reference, detail, person_id, account_id) values ($1, 'QUALIFIED', 'QUAL-INJ', 'IQ/OQ/PQ approved', gen_random_uuid(), gen_random_uuid())", [r[0]?.id]);
    }
    await c.query('commit');
  } finally {
    c.release();
  }
}

/** The EM's room, counter and released media lot (as aps-failure.test.ts arranges them). */
async function arrangeEm(): Promise<void> {
  await arrangeEquipment([['ROOM-GRADE-B', EM_UNITS.room, 'Grade B filling room'], ['PARTICLE-COUNTER', EM_UNITS.counter, 'Particle counter']]);
  const c = await gmp.db.admin.connect();
  try {
    await c.query('begin');
    await c.query('set local session_replication_role = replica');
    const { rows } = await c.query<{ id: string }>(
      `insert into site.material_lot (id, site_code, lot_code, material_code, material_name, material_kind, received_quantity, unit, expires_at,
                                      received_by_person, received_by_account, correlation_id)
       values (gen_random_uuid(), $1, $2, $3, 'Environmental monitoring plates, tryptone soya agar', 'PRIMARY_PACKAGING', 500, '1', clock_timestamp() + interval '1 year',
               gen_random_uuid(), gen_random_uuid(), gen_random_uuid()) returning id`,
      [SITE, EM_UNITS.mediaLot, `MAT-TSA-${TAG}`],
    );
    await c.query("insert into platform.aggregate_state (aggregate_type, aggregate_id, machine_code, machine_version, state, version) values ('material_lot', $1, 'material_lot', 1, 'RELEASED', 2)", [rows[0]?.id]);
    await c.query("insert into site.lot_identity_result (lot_id, result, method_reference, test_reference, recorded_by_person, recorded_by_account) values ($1, 'PASS', 'STP-ID', 'AR-1', gen_random_uuid(), gen_random_uuid())", [rows[0]?.id]);
    await c.query('commit');
  } finally {
    c.release();
  }
}

/** A fresh filling line, its Grade C room and an incubator. */
async function arrangeUnits(): Promise<Units> {
  const t = randomUUID().slice(0, 6).toUpperCase();
  const units = { line: `VIAL-LINE-${t}`, room: `ROOM-C-${t}`, incubator: `INCUB-${t}` };
  await arrangeEquipment([['VIAL-FILLING-LINE', units.line, 'Vial filling line'], ['ROOM-GRADE-C', units.room, 'Grade C filling room'], ['INCUBATOR', units.incubator, 'Media fill incubator']]);
  return units;
}

/** The line's APS interval as a firm sets it: the steward proposes it, QA (another person) approves it. */
async function proposeInterval(code: string, days: number): Promise<string> {
  return world.run(await actorOf(gmp, 'steward'), async (c) => (await c.query<{ id: string }>('select plant.propose_aps_interval($1, $2, $3) as id', [code, days, 'Media fill twice a year per SOP-QA-031'])).rows[0]!.id, reason(REASON));
}
async function approveInterval(id: string): Promise<void> {
  await world.run(await actorOf(gmp, 'qaInvestigator'), (c) => c.query('select plant.approve_aps_interval($1)', [id]), reason(REASON));
}
async function setInterval(code: string, days: number): Promise<void> {
  await approveInterval(await proposeInterval(code, days));
}

/** A batch of the master, planned from its ERP order and issued. */
async function issued(k: Key): Promise<{ batchId: string; batchNumber: string }> {
  const issuer = await gmp.asPersona('issuer');
  await postOrder(gmp.db.app, await openServiceSession(gmp.db, gmp.seed, 'erpInterface'), MASTERS[k], SIZE);
  const planned = valueOf(await issuer.call(routes.execution.planBatch, { body: { familyId: versions[k]!.familyId, markets: ['IN'], site: SITE, line: LINE, batchSize: SIZE } }));
  await issueBatch(gmp, planned.batchId, { code: 'PRODUCTION_PLAN', text: k === 'MF' ? 'Media fill of the APS schedule' : 'Issued for the plan' });
  return { batchId: planned.batchId, batchNumber: planned.batchNumber };
}

/** The nominal entries of a library step naming the test's units, recorded by operator1 (the first refused one stops it). */
async function record(d: RunDriver, stepKey: string, item: Item, units: Json, over: Json = {}): Promise<{ ok: boolean; error?: unknown }> {
  await d.ok('operator1', { type: 'START_STEP', stepKey });
  for (const e of library.nominalEntries(item.definition, item.exampleUse as never)) {
    const { kind, ...entry } = e;
    const data: Json = Object.fromEntries(Object.entries(entry).filter(([x]) => x !== 'equipment' && x !== 'lots'));
    for (const x of Object.keys(data)) if (x in units) data[x] = units[x];
    if (kind === 'tray') data['trayOut'] = `TRAY-${randomUUID().slice(0, 8)}`;
    const r = await d.command('operator1', libraryEntry(stepKey, kind, { ...data, ...(over[kind] as Json | undefined) }));
    if (!r.ok) return r;
  }
  return { ok: true };
}

async function signed(d: RunDriver, stepKey: string): Promise<void> {
  await d.signed('operator1', { type: 'SIGN_PERFORMED', stepKey });
  await d.signed('verifier1', { type: 'VERIFY', stepKey, meaning: 'VERIFIED' });
}

/** A media fill on the units read with no contaminated unit: a passing APS of the line. */
async function passingMediaFill(units: Units): Promise<{ batchId: string; batchNumber: string }> {
  const b = await issued('MF');
  const d = await driverOf(gmp, b.batchId);
  const fill = await record(d, 'p-fill@', FILL, units);
  expect(fill.ok, errorText(fill)).toBe(true);
  await signed(d, 'p-fill@');
  expect((await record(d, 'p-em@', EM, units, { area: { ...EM_UNITS } })).ok).toBe(true);
  await signed(d, 'p-em@');
  await d.signed('supervisor1', { type: 'SIGN_OFF_STAGE', stageKey: 'S-FILL@' });
  expect((await record(d, 'p-read@', READ, units, { reading: { contaminated: '0' } })).ok).toBe(true);
  return b;
}

/**
 * The passage of time (test arrangement of the record, triggers off): every entry of the batch recorded `days` earlier,
 * so the media fill's use of its line is that much older.
 */
async function age(batchId: string, days: bigint): Promise<void> {
  const c = await gmp.db.admin.connect();
  try {
    await c.query('begin');
    await c.query('set local session_replication_role = replica');
    await c.query(
      `update recipe.execution_state s
          set state = jsonb_set(s.state, '{entries}', (select jsonb_object_agg(x.key, case when x.value -> 'recordedAt' ? '$u'
                       then jsonb_set(x.value, '{recordedAt,$u}', to_jsonb((((x.value -> 'recordedAt' ->> '$u')::bigint) - $2::bigint)::text)) else x.value end)
                                                       from jsonb_each(s.state -> 'entries') x))
        where s.batch_id = $1`,
      [batchId, (days * DAY_US).toString()],
    );
    await c.query('commit');
  } finally {
    c.release();
  }
}

/** The filling step's set-up entry of a started batch of the master naming the units: the command's result. */
async function setupOn(k: Key, units: Units): Promise<{ batchId: string; d: RunDriver; result: { ok: boolean; error?: unknown } }> {
  const b = await issued(k);
  const d = await driverOf(gmp, b.batchId);
  await d.ok('operator1', { type: 'START_STEP', stepKey: 'p-fill@' });
  const setup = library.nominalEntries(FILL.definition, FILL.exampleUse as never).find((e) => e.kind === 'setup')!;
  const data: Json = Object.fromEntries(Object.entries(setup).filter(([x]) => x !== 'kind' && x !== 'equipment'));
  return { batchId: b.batchId, d, result: await d.command('operator1', libraryEntry('p-fill@', 'setup', { ...data, line: units.line, room: units.room })) };
}

const errorText = (r: { ok: boolean; error?: unknown }): string => JSON.stringify(r.ok ? null : r.error);

beforeAll(async () => {
  const ledgerDir = mkdtempSync(join(tmpdir(), 'ebmr-inj-apsi-'));
  gmp = Object.assign(await startSigningServer('GMP', { stub: false, paceDeviceNonces: true, env: { EBMR_NUMBER_LEDGER_FILE: join(ledgerDir, 'numbers.ledger.jsonl') } }), { exchangeDir: ledgerDir });
  vi.useFakeTimers({ toFake: ['performance'] });
  const steward = await gmp.asPersona('steward');
  for (const p of [MF_PRODUCT, PRODUCT, TS_PRODUCT]) {
    valueOf(await steward.call(routes.masterData.enterProduct, { body: { productCode: p.code, strength: p.strength, productName: p.name, dosageForm: 'Injection', betaLactam: false, shelfLifeMonths: 24, changeReason: REASON } }));
    await confirmErpPending(gmp);
  }
  const regulatory = await gmp.asPersona('regulatory');
  const licence = valueOf(await regulatory.call(routes.india.recordLicence, { body: {
    licenceKind: 'MANUFACTURING', form: '25', licenceNumber: `MFG/APSI/${TAG}`, holderName: 'Demo Parenterals Pvt Ltd', holderAddress: 'Plot 9, Pharma City, Hyderabad 500078',
    validFrom: '2020-01-01T00:00:00+05:30', products: [PRODUCT, TS_PRODUCT].map((p) => ({ productCode: p.code, strength: p.strength })),
  } }));
  const [author, approver] = await Promise.all([gmp.asPersona('author'), gmp.asPersona('approver')]);
  await signAs(gmp, approver, 'approver', { kind: 'INDIA_ACT', act: 'LICENCE_APPROVE', subjectId: licence.licenceId });
  for (const def of [FILL.definition, EM.definition, COUNTS.definition, READ.definition, TERMINAL.definition]) {
    const { block } = valueOf(await author.call(routes.library.draft, { body: { definition: def as unknown as Json } }));
    await signAs(gmp, approver, 'approver', { kind: 'LIBRARY_ACT', act: 'BLOCK_APPROVE', subjectId: block.blockId });
  }
  await arrangeEm();
  world = await gmpLifecycleWorld(gmp);
  for (const k of ['MF', 'PRODUCT', 'TS'] as const) {
    versions[k] = await world.approvedVersion(MASTERS[k]);
    await world.authorise({ versionId: versions[k].versionId, market: 'IN', kind: 'CURRENT', cells: [cell(SITE, LINE, SIZE)], regulatoryBasis: 'IN: registration on file (invented injectable)' });
  }
  for (const [rule, product, format] of [[`INJIVM-${TAG}`, MF_PRODUCT.code, 'V{YY}{SEQ:5}'], [`INJIV-${TAG}`, PRODUCT.code, 'W{YY}{SEQ:5}'], [`INJIVT-${TAG}`, TS_PRODUCT.code, 'X{YY}{SEQ:5}']] as const) {
    await world.run(await actorOf(gmp, 'steward'), (c) =>
      c.query('select site.define_batch_number_rule($1::jsonb)', [JSON.stringify({ rule_code: rule, site_code: SITE, product_code: product, batch_kind: 'PROCESSING', format, site_zone: 'Asia/Kolkata', reason: 'Numbering SOP-QA-017 rev 3' })]),
      reason('Injectables INV-23 numbering'),
    );
  }
}, 900_000);
afterAll(async () => {
  vi.useRealTimers();
  await gmp?.close();
});

describe('the APS interval of a filling line (INV-23; tablets 1915)', () => {
  it('[INV-23] the interval is the firm\'s, set per line with no default: a proposal takes effect only with QA\'s approval by another person, the latest version only and once; the versions stay as history and cannot be changed', async () => {
    const units = await arrangeUnits();
    const days = (code: string) => gmp.db.admin.query<{ d: number | null }>('select plant.aps_interval_days(e.id) as d from plant.equipment e where e.code = $1', [code]).then((r) => r.rows[0]!.d);
    expect(await days(units.line)).toBeNull();
    // No number of days, none out of range, and a reason: nothing is defaulted.
    const steward = await actorOf(gmp, 'steward');
    for (const [d, why] of [[null, 'Media fill twice a year per SOP'], [0, 'Media fill twice a year per SOP'], [3651, 'Media fill twice a year per SOP'], [180, 'Nine char']] as const) {
      await expect(world.run(steward, (c) => c.query('select plant.propose_aps_interval($1, $2, $3)', [units.line, d, why]), reason(REASON))).rejects.toThrow(/EBMR-PLANT-090/);
    }
    // A reason of ten characters is enough.
    await world.run(steward, (c) => c.query('select plant.propose_aps_interval($1, $2, $3)', [units.line, 365, 'Ten chars.']), reason(REASON));
    const first = await proposeInterval(units.line, 180);
    expect(await days(units.line)).toBeNull();
    // An approval written outside the command names a proposal of its own line, whoever writes it.
    await expect(gmp.db.admin.query('insert into plant.aps_interval_approval (interval_id, equipment_id, approved_by_person, approved_by_account) select gen_random_uuid(), equipment_id, gen_random_uuid(), gen_random_uuid() from plant.aps_interval where id = $1', [first]))
      .rejects.toThrow(/EBMR-PLANT-091 the approval names no proposed APS interval/);
    await expect(gmp.db.admin.query('insert into plant.aps_interval_approval (interval_id, equipment_id, approved_by_person, approved_by_account) select $1, e.id, gen_random_uuid(), gen_random_uuid() from plant.equipment e where e.code = $2', [first, units.room]))
      .rejects.toThrow(/EBMR-PLANT-091 the approval names no proposed APS interval/);
    // The proposer does not approve it, through the command or by writing the approval itself.
    await expect(world.run(steward, (c) => c.query('select plant.approve_aps_interval($1)', [first]), reason(REASON))).rejects.toThrow(/EBMR-IAM-040|EBMR-PLANT-091/);
    await expect(gmp.db.admin.query("insert into plant.aps_interval_approval (interval_id, equipment_id, approved_by_person, approved_by_account) select id, equipment_id, proposed_by_person, gen_random_uuid() from plant.aps_interval where id = $1", [first]))
      .rejects.toThrow(/EBMR-PLANT-091 the person who proposed/);
    await approveInterval(first);
    expect(await days(units.line)).toBe(180);
    await expect(approveInterval(first)).rejects.toThrow(/EBMR-PLANT-091/);
    // A later proposal changes nothing until it is approved; the older version is then no longer approvable.
    const second = await proposeInterval(units.line, 90);
    expect(await days(units.line)).toBe(180);
    const third = await proposeInterval(units.line, 120);
    await expect(approveInterval(second)).rejects.toThrow(/EBMR-PLANT-091 version 3 of the APS interval is superseded/);
    await approveInterval(third);
    expect(await days(units.line)).toBe(120);
    expect((await gmp.db.admin.query<{ v: number; d: number }>('select version as v, interval_days as d from plant.aps_interval i join plant.equipment e on e.id = i.equipment_id where e.code = $1 order by version', [units.line])).rows)
      .toEqual([{ v: 1, d: 365 }, { v: 2, d: 180 }, { v: 3, d: 90 }, { v: 4, d: 120 }]);
    await expect(gmp.db.admin.query('update plant.aps_interval i set interval_days = 365 from plant.equipment e where e.id = i.equipment_id and e.code = $1', [units.line])).rejects.toThrow();
    await expect(gmp.db.admin.query('delete from plant.aps_interval_approval where interval_id = $1', [third])).rejects.toThrow();
    // Audited on the unit's chain.
    const audited = await gmp.db.admin.query<{ n: number }>(
      "select count(*)::int as n from kernel.audit_event a join plant.equipment e on a.chain_key = 'plant_equipment:' || e.id::text where e.code = $1 and a.action = 'INSERT' and a.table_name in ('plant.aps_interval', 'plant.aps_interval_approval')",
      [units.line],
    );
    expect(audited.rows[0]!.n).toBe(6);
  });
});

describe('the line fills an aseptic batch only while its APS is valid (INV-23; Schedule M Part II 5.5; 21 CFR 211.113(b))', () => {
  it('[INV-23] an injectables processing batch filling on a line with no APS interval in force is refused, and the refusal names the missing setting; a proposal QA has not approved does not count', async () => {
    const units = await arrangeUnits();
    await passingMediaFill(units);
    const refused = (await setupOn('PRODUCT', units)).result;
    expect(refused.ok).toBe(false);
    expect(errorText(refused)).toMatch(/EBMR-PLANT-092.*the filling line .* has no APS interval in force/);
    await proposeInterval(units.line, 180);
    const pending = (await setupOn('PRODUCT', units)).result;
    expect(errorText(pending)).toMatch(/EBMR-PLANT-092/);
  });

  it('[INV-23] with an interval in force, a line whose last passing APS plus the interval is at or before the command\'s time is refused, and so is a line with no passing APS at all', async () => {
    const none = await arrangeUnits();
    await setInterval(none.line, 30);
    const noAps = (await setupOn('PRODUCT', none)).result;
    expect(noAps.ok).toBe(false);
    expect(errorText(noAps)).toMatch(/EBMR-PLANT-093.*the filling line .* has no passing aseptic process simulation on record/);
    const units = await arrangeUnits();
    const mf = await passingMediaFill(units);
    await setInterval(units.line, 30);
    await age(mf.batchId, 31n);
    const lapsed = (await setupOn('PRODUCT', units)).result;
    expect(lapsed.ok).toBe(false);
    expect(errorText(lapsed)).toMatch(/EBMR-PLANT-093.*the aseptic process simulation of the filling line .* was valid until \d{4}-\d\d-\d\dT/);
  });

  it('[INV-23] with a passing APS within the line\'s interval the line entry is accepted, and the filling step is signed with no exception', async () => {
    const units = await arrangeUnits();
    await passingMediaFill(units);
    await setInterval(units.line, 30);
    const s = await setupOn('PRODUCT', units);
    expect(s.result.ok, errorText(s.result)).toBe(true);
    for (const e of library.nominalEntries(FILL.definition, FILL.exampleUse as never).filter((x) => x.kind !== 'setup')) {
      const { kind, ...entry } = e;
      const data: Json = Object.fromEntries(Object.entries(entry).filter(([x]) => x !== 'equipment' && x !== 'lots'));
      if (kind === 'tray') data['trayOut'] = `TRAY-${randomUUID().slice(0, 8)}`;
      await s.d.ok('operator1', libraryEntry('p-fill@', kind, data));
    }
    await signed(s.d, 'p-fill@');
  });

  it('[INV-23] a lapse during the fill: the later entries are accepted; at the sign-off the step waits for an ACTION exception requiring a deviation, which blocks it until QA dispositions it under the linked deviation', async () => {
    const units = await arrangeUnits();
    const mf = await passingMediaFill(units);
    await setInterval(units.line, 30);
    const s = await setupOn('PRODUCT', units);
    expect(s.result.ok, errorText(s.result)).toBe(true);
    const d = s.d;
    // The APS validity ends now: the fill's later entries are not refused.
    await age(mf.batchId, 30n);
    for (const e of library.nominalEntries(FILL.definition, FILL.exampleUse as never).filter((x) => x.kind !== 'setup')) {
      const { kind, ...entry } = e;
      const data: Json = Object.fromEntries(Object.entries(entry).filter(([x]) => x !== 'equipment' && x !== 'lots'));
      if (kind === 'tray') data['trayOut'] = `TRAY-${randomUUID().slice(0, 8)}`;
      await d.ok('operator1', libraryEntry('p-fill@', kind, data));
    }
    const first = await d.sign('operator1', { type: 'SIGN_PERFORMED', stepKey: 'p-fill@' });
    expect(first.result.ok).toBe(false);
    expect(JSON.stringify(first.result.ok ? null : first.result.error)).toMatch(/EBMR-PLANT-094.*the aseptic process simulation of the filling line .* was valid until .* during the filling of step p-fill@: raise an ACTION exception/);
    await d.ok('operator1', { type: 'RAISE_EXCEPTION', stepKey: 'p-fill@', description: `APS of ${units.line} lapsed during the fill`, severity: 'ACTION' });
    const { rows } = await gmp.db.admin.query<{ id: string; severity: string; dev: boolean }>(
      "select exception_id as id, severity, deviation_required as dev from recipe.exception_register where batch_id = $1 and exception_type = 'OPERATOR_RAISED'",
      [s.batchId],
    );
    expect(rows.map(({ severity, dev }) => ({ severity, dev }))).toEqual([{ severity: 'ACTION', dev: true }]);
    const exceptionId = rows[0]!.id;
    // Raised but not yet dispositioned under its deviation: the step is still not signed.
    const open = await d.sign('operator1', { type: 'SIGN_PERFORMED', stepKey: 'p-fill@' });
    expect(JSON.stringify(open.result.ok ? null : open.result.error)).toMatch(/EBMR-PLANT-094/);
    const qaInv = await gmp.asPersona('qaInvestigator');
    const dev = valueOf(await qaInv.call(routes.quality.raiseDeviation, { body: { kind: 'DEVIATION', title: `APS of ${units.line} lapsed during a fill`, classification: 'MAJOR', riskRationale: 'The line filled past the validity of its media fill; sterility assurance to be assessed.' } }));
    valueOf(await qaInv.call(routes.quality.linkDeviation, { params: { deviationId: dev.deviationId }, body: { subjectKind: 'BATCH', subjectId: s.batchId } }));
    await d.ok('supervisor1', { type: 'ATTACH_DEVIATION', exception: exceptionId, deviationRef: dev.ref });
    const linked = await d.sign('operator1', { type: 'SIGN_PERFORMED', stepKey: 'p-fill@' });
    expect(JSON.stringify(linked.result.ok ? null : linked.result.error)).toMatch(/EBMR-PLANT-094/);
    await d.signed('qa1', { type: 'DISPOSITION_EXCEPTION', exception: exceptionId, outcome: 'DEVIATION_RAISED', justification: `Deviation ${dev.ref}: the batch is held until the investigation concludes` });
    await d.signed('operator1', { type: 'SIGN_PERFORMED', stepKey: 'p-fill@' });
  });

  it('[INV-23] database bypass: a RECORD_ENTRY naming the line written straight to the execution store, past the server, is refused by the guard itself', async () => {
    const units = await arrangeUnits();
    const s = await setupOn('PRODUCT', units);
    expect(s.result.ok).toBe(false);
    const c = await gmp.db.admin.connect();
    try {
      await c.query('begin');
      await c.query('alter table recipe.execution_command disable trigger user');
      await c.query('alter table recipe.execution_command enable trigger ad_plant_aps_interval');
      const write = (entry: Json, accepted = true) => c.query(
        `insert into recipe.execution_command
           select batch_id, seq + 1000 + (select count(*) from recipe.execution_command x where x.batch_id = $1 and x.seq > 1000), kind, command_id || '-bypass-' || $2, 'RECORD_ENTRY', $3::jsonb, command_hash, actor_person, actor_account, actor_role, actor_legal_name, source,
                  session_id, device_id, device_class, room_code, auth_event_id, now_us, $4, case when $4 then null else '{"code": "ENG-X"}'::jsonb end, state_version, state_hash, events_hash, event_count, roles, signature_ids,
                  evidence, prev_row_hash, row_hash, correlation_id, recorded_at
             from recipe.execution_command where batch_id = $1 and command_type = 'START_STEP' and accepted order by seq desc limit 1`,
        [s.batchId, randomUUID(), JSON.stringify({ type: 'RECORD_ENTRY', step: 'p-fill', context: [], entry }), accepted],
      );
      await c.query('savepoint a');
      await expect(write({ kind: 'setup', line: units.line, room: units.room })).rejects.toThrow(/EBMR-PLANT-092/);
      await c.query('rollback to savepoint a');
      // An entry of a section with no LINE field passes the guard.
      await expect(write({ kind: 'weights', note: 'x' })).resolves.toBeDefined();
      // A refused row is written as the engine refused it: the guard reads accepted rows only.
      await expect(write({ kind: 'setup', line: units.line, room: units.room }, false)).resolves.toBeDefined();
    } finally {
      await c.query('rollback');
      c.release();
    }
  });

  it('[INV-23] a terminally sterilised master (a step with the role TERMINAL_STERILISATION) is not checked: its filling names a line with no interval and no APS', async () => {
    const units = await arrangeUnits();
    const r = (await setupOn('TS', units)).result;
    expect(r.ok, errorText(r)).toBe(true);
  });

  it('[INV-23] a process-simulation batch is exempt: the media fill fills on a line with no interval and no passing APS', async () => {
    const units = await arrangeUnits();
    const r = (await setupOn('MF', units)).result;
    expect(r.ok, errorText(r)).toBe(true);
  });

  it('[INV-23] a packaging block\'s line (category PACKAGING, as the PACK-* blocks) is not read, the same field of a process block is; a tablets master and a packaging record are out of scope', async () => {
    const units = await arrangeUnits();
    const s = await setupOn('PRODUCT', units);
    const pack = (category: string): Json => ({ code: 'PACK-SITE-LINE', version: 1, title: 'Line set-up', category, sections: [{ id: 'setup', title: 'Set-up', fields: [{ id: 'line', label: 'Line', type: 'EQUIPMENT', kind: 'LINE', classSlot: 'lineClass' }, { id: 'counter', label: 'Counter', type: 'EQUIPMENT', kind: 'EQUIPMENT', classSlot: 'c' }] }], signatures: [] });
    const content = (category: string): Json => ({
      blockDefinitions: [pack(category)],
      procedure: { body: { kind: 'sequence', id: 'b', children: [{ kind: 'phase', id: 'p-pack', block: { type: 'LIB-PACK-SITE-LINE', version: '1' } }] } },
    });
    const lines = async (category: string, data: Json) =>
      (await gmp.db.admin.query<{ l: string }>("select plant.aps_entry_lines($1::jsonb, 'p-pack', 'setup', $2::jsonb) as l", [JSON.stringify(content(category)), JSON.stringify(data)])).rows.map((r) => r.l);
    expect(await lines('PACKAGING', { line: units.line, counter: 'C-1' })).toEqual([]);
    expect(await lines('PROCESS', { line: units.line, counter: 'C-1' })).toEqual([units.line]);
    expect(await lines('PROCESS', { counter: 'C-1' })).toEqual([]);
    // The scope reads the master's edition and record kind: the same batch with a tablets or a packaging header is out.
    const scope = async (header: Json) =>
      (await gmp.db.admin.query<{ s: boolean }>("select plant.aps_interval_scope($1, jsonb_set(recipe.batch_mbr_content($1), '{header}', recipe.batch_mbr_content($1) -> 'header' || $2::jsonb)) as s", [s.batchId, JSON.stringify(header)])).rows[0]!.s;
    expect(await scope({})).toBe(true);
    expect(await scope({ edition: 'tablets' })).toBe(false);
    expect(await scope({ recordKind: 'PACKAGING' })).toBe(false);
    // A batch the store does not hold as a GMP batch (a sandbox test run, here none at all) is out.
    expect((await gmp.db.admin.query<{ s: boolean }>('select plant.aps_interval_scope($1, recipe.batch_mbr_content($2)) as s', [randomUUID(), s.batchId])).rows[0]!.s).toBe(false);
  });

  it('[INV-23] the guard on its own, at its boundaries: the validity ends at the instant itself; a sign-off waits for an exception of its own step raised at or after that instant and dispositioned under a deviation; a code the register does not hold is left to the fitness guard', async () => {
    const units = await arrangeUnits();
    await passingMediaFill(units);
    await setInterval(units.line, 30);
    const s = await setupOn('PRODUCT', units);
    const used = BigInt((await gmp.db.admin.query<{ u: string }>('select max(used_us)::text as u from plant.line_batch_uses($1) where good_aps', [units.line])).rows[0]!.u);
    const until = used + 30n * DAY_US;
    const validUntil = async (at: bigint) => (await gmp.db.admin.query<{ v: string | null }>('select plant.aps_valid_until_us($1, $2)::text as v', [units.line, at.toString()])).rows[0]!.v;
    expect(await validUntil(used)).toBe(until.toString());
    expect(await validUntil(used - 1n)).toBeNull();
    const problem = async (type: string, command: Json, state: Json, now: bigint) =>
      (await gmp.db.admin.query<{ p: string | null }>('select plant.aps_interval_problem($1, recipe.batch_mbr_content($1), $2, $3::jsonb, $4::jsonb, $5) as p',
        [s.batchId, type, JSON.stringify(command), JSON.stringify(state), now.toString()])).rows[0]!.p;
    const entry = { type: 'RECORD_ENTRY', step: 'p-fill', context: [], entry: { kind: 'setup', line: units.line } };
    expect(await problem('RECORD_ENTRY', entry, {}, until - 1n)).toBeNull();
    expect(await problem('RECORD_ENTRY', entry, {}, until)).toMatch(/^EBMR-PLANT-093 .* was valid until/);
    const sign = { type: 'SIGN_PERFORMED', step: 'p-fill', context: [] };
    const stateWith = (line: string, exceptions: Json = {}): Json => ({
      entries: { E1: { stepKey: 'p-fill@', kind: 'setup', data: { line }, recordedAt: { $u: (until - DAY_US).toString() } } },
      exceptions,
    });
    expect(await problem('SIGN_PERFORMED', sign, stateWith(units.line), until - 1n)).toBeNull();
    expect(await problem('SIGN_PERFORMED', sign, stateWith(units.line), until)).toMatch(/^EBMR-PLANT-094 .* was valid until .* during the filling of step p-fill@/);
    expect(await problem('SIGN_PERFORMED', sign, stateWith('NO-SUCH-LINE'), until)).toBeNull();
    const handled = (over: Json = {}): Json => ({
      X1: { source: { stepKey: 'p-fill@', frames: [] }, severity: 'ACTION', deviationRequired: true, raisedAt: { $u: until.toString() }, deviation: { ref: 'DEV-1' },
            status: 'DISPOSITIONED', disposition: { outcome: 'DEVIATION_RAISED' }, ...over },
    });
    expect(await problem('SIGN_PERFORMED', sign, stateWith(units.line, handled()), until + 1n)).toBeNull();
    expect(await problem('SIGN_PERFORMED', sign, stateWith(units.line, handled({ severity: 'CRITICAL' })), until + 1n)).toBeNull();
    for (const over of [{ raisedAt: { $u: (until - 1n).toString() } }, { source: { stepKey: 'p-em@', frames: [] } }, { severity: 'ALERT' }, { deviationRequired: false }, { deviation: null },
                        { status: 'OPEN' }, { disposition: { outcome: 'NO_IMPACT' } }]) {
      expect(await problem('SIGN_PERFORMED', sign, stateWith(units.line, handled(over)), until + 1n), JSON.stringify(over)).toMatch(/^EBMR-PLANT-094/);
    }
  });
});
