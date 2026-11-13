/**
 * ST-33 (tablets 1911, 1912; lead-approved behaviour; owner decision 0001 #2): a media fill (aseptic process simulation)
 * read with a contaminated unit fails. On a master for the EU market (Annex 1 9.46: repeat simulations before the line is
 * back in routine use) the database withdraws the qualification of the filling line the media fill used, so the fitness
 * guard refuses the line in a product's step until QA has reviewed the batches made on it since its last successful APS
 * (with their risk assessment and the repeat APS runs) and recorded it QUALIFIED again. On a master for India only
 * (Schedule M Part II 5.6(i): an investigation and the consideration of a repeat) the reading raises its critical
 * exception, which holds the step until it is handled under a deviation, and the line stays qualified. The reading is
 * found by its block's role APS_READING and the field marked contaminatedCount, so a firm's own approved block counts.
 *
 * ST-29, ST-33 (tablets 1913): the repeat media fills run on the line withdrawn for them; a product batch, another
 * withdrawal or a second problem of the unit is still refused.
 *
 * The media-fill masters carry the process-simulation mark (recipe-core 1896), so they are issued with no licence and no
 * export permission; the product master is licensed. Arranged outside the routes, as the aseptic gate
 * (aseptic-gate.test.ts): the products, the plant units (test arrangement of master data), the ERP orders and the
 * numbering rules.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { routes } from '@ebmr/api-contract';
import { withCommand } from '@ebmr/kernel';
import { library, type flow } from '@ebmr/recipe-core/pure';
import { openServiceSession } from '@ebmr/test-kit';
import { postOrder } from '../../../../packages/recipe-core/test/lifecycle/gmp-support.ts';
import { cell, reason, type World } from '../../../../packages/recipe-core/test/lifecycle/support.ts';
import { INJECTABLE_SEEDS } from '../../../../packages/recipe-core/src/library/seed/injectables.ts';
import { INJECTABLE_ASEPTIC_SEEDS } from '../../../../packages/recipe-core/src/library/seed/injectables-aseptic.ts';
import { refusalOf, startSigningServer, valueOf } from '../esig/support.ts';
import type { ExecServer, RunDriver } from '../execution/support.ts';
import { actorOf, gmpContent, gmpLifecycleWorld } from '../support/gmp-world.ts';
import { confirmErpPending, signAction } from '../support/signed-acts.ts';
import { driverOf, issueBatch, libraryEntry, phaseOf, signAs, stage, type Json } from '../substance/support.ts';

// Device nonces are paced to the server's rate limit (the harness waits), so a test of several batches takes minutes.
vi.setConfig({ testTimeout: 300_000 });

const SITE = 'SITE-1';
const LINE = 'L1';
const SIZE = 'BS-100K';
const TAG = randomUUID().slice(0, 6).toUpperCase();
const REASON = 'Injectables ST-33 media fill';

const seed = (code: string) => {
  const item = [...INJECTABLE_SEEDS, ...INJECTABLE_ASEPTIC_SEEDS].find((s) => s.definition.code === code);
  if (!item) throw new Error(`no injectables seed ${code}`);
  return item;
};
const FILL = seed('INJ-FILL');
const ALARMS = seed('INJ-ALARM-ASSESSMENT');
const READ = seed('INJ-APS-READ');
type Item = { definition: library.BlockDefinition; exampleUse: unknown };
/** A firm's own media-fill reading under its own code (decision 0026): the role APS_READING and the marked count. */
const SITE_READ: Item = { definition: { ...READ.definition, code: 'SITE-MEDIA-READ', title: 'Media fill reading (site form)' }, exampleUse: READ.exampleUse };
/** A NUMBER field without the contaminatedCount mark. */
const unmarked = <F extends { contaminatedCount?: true }>(f: F): F => {
  const c = { ...f };
  delete c.contaminatedCount;
  return c;
};
/** The same form without the role and the mark: an ordinary observation, which withdraws nothing. */
const PLAIN_READ: Item = {
  definition: {
    ...READ.definition,
    code: 'SITE-GROWTH-OBS',
    title: 'Growth observation (site form)',
    roles: ['OBSERVATION'],
    sections: READ.definition.sections.map((s) => ({ ...s, fields: s.fields.map((f) => (f.type === 'NUMBER' ? unmarked(f) : f)) })),
  },
  exampleUse: READ.exampleUse,
};

/** The media-fill masters (one product each: a family is one product, edition and record kind) and the product master. */
type Key = 'EU' | 'IN' | 'SITE' | 'PLAIN';
const MF: Record<Key, { markets: string[]; read: Item; letter: string }> = {
  EU: { markets: ['IN', 'EU'], read: READ, letter: 'E' },
  IN: { markets: ['IN'], read: READ, letter: 'I' },
  SITE: { markets: ['IN', 'EU'], read: SITE_READ, letter: 'S' },
  PLAIN: { markets: ['IN', 'EU'], read: PLAIN_READ, letter: 'P' },
};
const productOf = (k: Key) => ({ code: `INJMF${MF[k].letter}-${TAG}`, name: `Media fill (TSB) 2 mL vials ${k}`, strength: '2 mL' });
const PRODUCT = { code: `INJAPS-${TAG}`, name: 'Demoinj aseptic 10 mg/2 mL vials (ST-33)', strength: '10 mg/2 mL' };

/** A media-fill master (process simulation) for the market set: filling, (EU) the alarms' assessment, the reading. */
const mediaFill = (k: Key): flow.MbrContent =>
  gmpContent((m) => {
    const { markets, read } = MF[k];
    const P = productOf(k);
    const header = m['header'] as Json;
    header['family'] = `INJ-MF-${k}-${TAG}`;
    header['edition'] = 'injectables';
    header['recordKind'] = 'PROCESSING';
    header['nonProduct'] = 'PROCESS_SIMULATION';
    header['marketSet'] = markets;
    header['title'] = `${P.name}: aseptic process simulation`;
    header['product'] = { code: P.code, name: P.name, strength: P.strength, dosageForm: 'Injection' };
    delete header['unitMassMg'];
    const body = (m['procedure'] as Json)['body'] as Json;
    const like = (body['children'] as Json[])[0] as Json;
    const eu = markets.includes('EU');
    body['children'] = [
      stage(like, 'S-FILL', 'Aseptic filling with growth medium', [phaseOf(FILL.definition, 'p-fill', FILL.exampleUse)]),
      ...(eu ? [stage(like, 'S-ALARMS', 'Alarms raised during filling', [phaseOf(ALARMS.definition, 'p-alarms', ALARMS.exampleUse)])] : []),
      stage(like, 'S-READ', 'Incubation and reading', [phaseOf(read.definition, 'p-read', read.exampleUse as never)]),
    ];
    for (const x of ['parameters', 'calculations', 'yieldCheckpoints', 'timeConstraints', 'goldenCases', 'intermediates', 'riskReductions', 'inputs']) m[x] = [];
    m['blockDefinitions'] = [FILL.definition, ...(eu ? [ALARMS.definition] : []), read.definition];
  });

/** A product's processing master for India: the aseptic filling only. */
const productMaster: flow.MbrContent = gmpContent((m) => {
  const header = m['header'] as Json;
  header['family'] = `INJ-APSP-${TAG}`;
  header['edition'] = 'injectables';
  header['recordKind'] = 'PROCESSING';
  header['marketSet'] = ['IN'];
  header['title'] = `${PRODUCT.name}: aseptic filling`;
  header['product'] = { code: PRODUCT.code, name: PRODUCT.name, strength: PRODUCT.strength, dosageForm: 'Injection' };
  delete header['unitMassMg'];
  const body = (m['procedure'] as Json)['body'] as Json;
  const like = (body['children'] as Json[])[0] as Json;
  body['children'] = [stage(like, 'S-FILL', 'Aseptic filling', [phaseOf(FILL.definition, 'p-fill', FILL.exampleUse)])];
  for (const x of ['parameters', 'calculations', 'yieldCheckpoints', 'timeConstraints', 'goldenCases', 'intermediates', 'riskReductions', 'inputs']) m[x] = [];
  m['blockDefinitions'] = [FILL.definition];
});

const masters = Object.fromEntries((Object.keys(MF) as Key[]).map((k) => [k, mediaFill(k)])) as Record<Key, flow.MbrContent>;

let gmp: ExecServer;
let world: World;
const versions: Partial<Record<Key | 'PRODUCT', { familyId: string; versionId: string }>> = {};

type Units = { line: string; room: string; incubator: string };

/** The plant units a media fill names (test arrangement of master data, triggers off): qualified, of the formulation's classes. */
async function arrangeUnits(): Promise<Units> {
  const t = randomUUID().slice(0, 6).toUpperCase();
  const units = { line: `VIAL-LINE-${t}`, room: `ROOM-C-${t}`, incubator: `INCUB-${t}` };
  const c = await gmp.db.admin.connect();
  try {
    await c.query('begin');
    await c.query('set local session_replication_role = replica');
    for (const [cls, code, name] of [['VIAL-FILLING-LINE', units.line, 'Vial filling line'], ['ROOM-GRADE-C', units.room, 'Grade C filling room'], ['INCUBATOR', units.incubator, 'Media fill incubator']] as const) {
      await c.query(
        "insert into plant.equipment_class (code, kind, description, clean_hold, dirty_hold, calibration_required, recorded_by) values ($1, 'PROCESS', $2, interval '3 days', interval '2 days', false, gen_random_uuid()) on conflict do nothing",
        [cls, name],
      );
      const { rows } = await c.query<{ id: string }>("insert into plant.equipment (code, name, class_code, kind, recorded_by) values ($1, $2, $3, 'PROCESS', gen_random_uuid()) returning id", [code, name, cls]);
      await c.query("insert into plant.equipment_event (equipment_id, kind, reference, detail, person_id, account_id) values ($1, 'QUALIFIED', 'QUAL-INJ', 'IQ/OQ/PQ and APS approved', gen_random_uuid(), gen_random_uuid())", [rows[0]?.id]);
    }
    await c.query('commit');
  } finally {
    c.release();
  }
  return units;
}

/** A batch of the master, planned from its ERP order and issued. */
async function issued(k: Key | 'PRODUCT'): Promise<{ batchId: string; batchNumber: string }> {
  const issuer = await gmp.asPersona('issuer');
  await postOrder(gmp.db.app, await openServiceSession(gmp.db, gmp.seed, 'erpInterface'), k === 'PRODUCT' ? productMaster : masters[k], SIZE);
  const markets = k === 'PRODUCT' ? ['IN'] : MF[k].markets;
  const planned = valueOf(await issuer.call(routes.execution.planBatch, { body: { familyId: versions[k]!.familyId, markets, site: SITE, line: LINE, batchSize: SIZE } }));
  await issueBatch(gmp, planned.batchId, { code: 'PRODUCTION_PLAN', text: k === 'PRODUCT' ? 'Issued for the plan' : 'Media fill of the APS schedule' });
  return { batchId: planned.batchId, batchNumber: planned.batchNumber };
}

/** The nominal entries of a library step (some sections' data changed), naming the test's units, recorded by operator1. */
async function record(d: RunDriver, stepKey: string, item: Item, units: Json, over: Json = {}): Promise<void> {
  await d.ok('operator1', { type: 'START_STEP', stepKey });
  for (const e of library.nominalEntries(item.definition, item.exampleUse as never)) {
    const { kind, ...entry } = e;
    // The equipment facts are the server's (EBMR-API-SERVER-FILLED): the entry names the units by their codes only.
    const data: Json = Object.fromEntries(Object.entries(entry).filter(([x]) => x !== 'equipment' && x !== 'lots'));
    for (const x of Object.keys(data)) if (x in units) data[x] = units[x];
    if (kind === 'tray') data['trayOut'] = `TRAY-${randomUUID().slice(0, 8)}`;
    await d.ok('operator1', libraryEntry(stepKey, kind, { ...data, ...(over[kind] as Json | undefined) }));
  }
}

async function signed(d: RunDriver, stepKey: string, verify = true): Promise<void> {
  await d.signed('operator1', { type: 'SIGN_PERFORMED', stepKey });
  if (verify) await d.signed('verifier1', { type: 'VERIFY', stepKey, meaning: 'VERIFIED' });
}

/** A batch of the master that has filled on the units (its filling step recorded and signed). */
async function filled(k: Key | 'PRODUCT', units: Units): Promise<{ batchId: string; batchNumber: string; d: RunDriver }> {
  const b = await issued(k);
  const d = await driverOf(gmp, b.batchId);
  await record(d, 'p-fill@', FILL, units);
  await signed(d, 'p-fill@');
  return { ...b, d };
}

/** The media fill run up to its reading: filled on the units, the alarms assessed (EU), then read with `contaminated` units. */
async function mediaFillRead(k: Key, units: Units, contaminated: string): Promise<{ batchId: string; batchNumber: string; d: RunDriver }> {
  const b = await filled(k, units);
  const d = b.d;
  await d.signed('supervisor1', { type: 'SIGN_OFF_STAGE', stageKey: 'S-FILL@' });
  if (MF[k].markets.includes('EU')) {
    await d.ok('operator1', { type: 'START_STEP', stepKey: 'p-alarms@' });
    await d.ok('operator1', libraryEntry('p-alarms@', 'alarms', { alarmsRaised: false }));
    await signed(d, 'p-alarms@', false);
    await d.signed('supervisor1', { type: 'SIGN_OFF_STAGE', stageKey: 'S-ALARMS@' });
  }
  await record(d, 'p-read@', MF[k].read, units, { reading: { contaminated, identification: contaminated === '0' ? undefined : 'Staphylococcus epidermidis' } });
  return b;
}

/** The filling step's set-up entry of a started batch naming the units: the command's result (refused or recorded). */
async function setupOn(k: Key | 'PRODUCT', units: Units) {
  const b = await issued(k);
  const d = await driverOf(gmp, b.batchId);
  await d.ok('operator1', { type: 'START_STEP', stepKey: 'p-fill@' });
  const setup = library.nominalEntries(FILL.definition, FILL.exampleUse as never).find((e) => e.kind === 'setup')!;
  const data: Json = Object.fromEntries(Object.entries(setup).filter(([x]) => x !== 'kind' && x !== 'equipment'));
  return d.command('operator1', libraryEntry('p-fill@', 'setup', { ...data, line: units.line, room: units.room }));
}

const fitness = async (code: string): Promise<{ fit: string; problems: string[] }> =>
  (
    await gmp.db.admin.query<{ fit: string; problems: string[] }>(
      `select plant.equipment_fitness(e.id) as fit,
              array(select jsonb_array_elements_text(plant.equipment_use_assessment(e.id, 'ANY', clock_timestamp() + interval '1 hour') -> 'problems')) as problems
         from plant.equipment e where e.code = $1`,
      [code],
    )
  ).rows[0]!;

const qualificationEvents = async (code: string) =>
  (
    await gmp.db.admin.query<{ kind: string; reference: string | null; batch_ref: string | null; detail: string }>(
      `select v.kind, v.reference, v.batch_ref, v.detail from plant.equipment_event v join plant.equipment e on e.id = v.equipment_id
        where e.code = $1 and v.kind in ('QUALIFIED', 'QUALIFICATION_WITHDRAWN') order by v.recorded_at, v.id`,
      [code],
    )
  ).rows;

const exceptionsOf = async (batchId: string) =>
  Object.values((await gmp.db.admin.query<{ s: { exceptions: Record<string, { type: string; severity?: string }> } }>('select state as s from recipe.execution_state where batch_id = $1', [batchId])).rows[0]!.s.exceptions)
    .map((x) => x.type);

/** QA's review of the line's open ST-33 withdrawal, through the route (RECORD.QA_REVIEW). */
const review = async (persona: string, code: string, body: { riskAssessmentRef: string; repeatApsRefs: string[]; justification?: string }) =>
  (await gmp.asPersona(persona)).call(routes.plant.apsFailureReview, { params: { code }, body });

/** QA requalifies the line through the logbook route (MASTERDATA.CHANGE). */
const requalify = async (code: string) =>
  (await gmp.asPersona('steward')).call(routes.plant.equipmentEvent, { params: { code }, body: { event: 'EVENT', kind: 'QUALIFIED', detail: 'Repeat media fills passed; investigation closed', reference: `APS-REQUAL-${TAG}` } });

const errorText = (r: { ok: boolean; error?: unknown }): string => JSON.stringify(r.ok ? null : r.error);

beforeAll(async () => {
  const ledgerDir = mkdtempSync(join(tmpdir(), 'ebmr-inj-aps-'));
  gmp = Object.assign(await startSigningServer('GMP', { stub: false, paceDeviceNonces: true, env: { EBMR_NUMBER_LEDGER_FILE: join(ledgerDir, 'numbers.ledger.jsonl') } }), { exchangeDir: ledgerDir });
  vi.useFakeTimers({ toFake: ['performance'] });
  const steward = await gmp.asPersona('steward');
  for (const p of [...(Object.keys(MF) as Key[]).map(productOf), PRODUCT]) {
    valueOf(await steward.call(routes.masterData.enterProduct, { body: { productCode: p.code, strength: p.strength, productName: p.name, dosageForm: 'Injection', betaLactam: false, shelfLifeMonths: 24, changeReason: REASON } }));
    await confirmErpPending(gmp);
  }
  const regulatory = await gmp.asPersona('regulatory');
  const licence = valueOf(await regulatory.call(routes.india.recordLicence, { body: {
    licenceKind: 'MANUFACTURING', form: '25', licenceNumber: `MFG/APS/${TAG}`, holderName: 'Demo Parenterals Pvt Ltd', holderAddress: 'Plot 9, Pharma City, Hyderabad 500078',
    validFrom: '2020-01-01T00:00:00+05:30', products: [{ productCode: PRODUCT.code, strength: PRODUCT.strength }],
  } }));
  const [author, approver] = await Promise.all([gmp.asPersona('author'), gmp.asPersona('approver')]);
  await signAs(gmp, approver, 'approver', { kind: 'INDIA_ACT', act: 'LICENCE_APPROVE', subjectId: licence.licenceId });
  for (const def of [FILL.definition, ALARMS.definition, READ.definition, SITE_READ.definition, PLAIN_READ.definition]) {
    const { block } = valueOf(await author.call(routes.library.draft, { body: { definition: def as unknown as Json } }));
    await signAs(gmp, approver, 'approver', { kind: 'LIBRARY_ACT', act: 'BLOCK_APPROVE', subjectId: block.blockId });
  }
  world = await gmpLifecycleWorld(gmp);
  for (const k of Object.keys(MF) as Key[]) {
    const v = await world.approvedVersion(masters[k]);
    versions[k] = v;
    for (const m of MF[k].markets) {
      await world.authorise({ versionId: v.versionId, market: m, kind: 'CURRENT', cells: [cell(SITE, LINE, SIZE)], regulatoryBasis: `${m}: media fill of the aseptic process (invented)` });
    }
  }
  versions.PRODUCT = await world.approvedVersion(productMaster);
  await world.authorise({ versionId: versions.PRODUCT.versionId, market: 'IN', kind: 'CURRENT', cells: [cell(SITE, LINE, SIZE)], regulatoryBasis: 'IN: registration on file (invented injectable)' });
  const rules: [string, string, string][] = [...(Object.keys(MF) as Key[]).map((k): [string, string, string] => [`INJMF${MF[k].letter}-${TAG}`, productOf(k).code, `M${MF[k].letter}{YY}{SEQ:5}`]), [`INJAPS-${TAG}`, PRODUCT.code, 'Q{YY}{SEQ:5}']];
  for (const [rule, product, format] of rules) {
    await world.run(await actorOf(gmp, 'steward'), (c) =>
      c.query('select site.define_batch_number_rule($1::jsonb)', [JSON.stringify({ rule_code: rule, site_code: SITE, product_code: product, batch_kind: 'PROCESSING', format, site_zone: 'Asia/Kolkata', reason: 'Numbering SOP-QA-017 rev 3' })]),
      reason('Injectables ST-33 numbering'),
    );
  }
}, 900_000);
afterAll(async () => {
  vi.useRealTimers();
  await gmp?.close();
});

describe('a failed media fill on an EU master withdraws the filling line (ST-33; tablets 1911)', () => {
  it('[ST-33] an EU media fill read with one contaminated unit raises its critical exception and withdraws the qualification of the filling line it used: the line is NOT_QUALIFIED and refused in a step of a product batch until QA has reviewed the withdrawal and recorded it QUALIFIED again, after which it is usable', async () => {
    const units = await arrangeUnits();
    expect((await fitness(units.line)).fit).toBe('QUALIFIED');
    const mf = await mediaFillRead('EU', units, '1');
    expect(await exceptionsOf(mf.batchId)).toContain('LIB_LIMIT_BREACH');
    expect((await qualificationEvents(units.line)).at(-1)).toEqual({ kind: 'QUALIFICATION_WITHDRAWN', reference: mf.batchNumber, batch_ref: mf.batchNumber, detail: 'APS failed: repeat APS required (A1 9.46)' });
    const withdrawn = await fitness(units.line);
    expect(withdrawn.fit).toBe('NOT_QUALIFIED');
    expect(withdrawn.problems.join(' ')).toMatch(/not qualified|NOT_QUALIFIED/i);
    // The room and the incubator are not filling lines: they keep their qualification.
    expect((await fitness(units.room)).fit).toBe('QUALIFIED');
    expect((await fitness(units.incubator)).fit).toBe('QUALIFIED');
    // A product batch cannot name the line in its filling step.
    const refused = await setupOn('PRODUCT', units);
    expect(refused.ok).toBe(false);
    expect(errorText(refused)).toMatch(/not qualified|NOT_QUALIFIED/i);
    // QA reviews the withdrawal (no other batch used the line: an empty impact list, no successful APS on record) after the
    // repeat media fills, then requalifies the line: usable again.
    const open = valueOf(await (await gmp.asPersona('qaInvestigator')).call(routes.plant.apsFailure, { params: { code: units.line } }));
    expect(open.withdrawal).toMatchObject({ failedBatch: mf.batchNumber, lastSuccessfulAps: null, batches: [], reviewed: false });
    valueOf(await review('qaInvestigator', units.line, { riskAssessmentRef: `QRM-APS-${TAG}`, repeatApsRefs: ['APS-R1', 'APS-R2', 'APS-R3'] }));
    valueOf(await requalify(units.line));
    expect(await fitness(units.line)).toEqual({ fit: 'QUALIFIED', problems: [] });
    const after = await setupOn('PRODUCT', units);
    expect(after.ok, errorText(after)).toBe(true);
  });

  it('[ST-33] an India-only media fill read with one contaminated unit raises the critical exception (its deviation holds the step) but does not withdraw the line; an EU media fill read with no contaminated unit withdraws nothing', async () => {
    const units = await arrangeUnits();
    const mf = await mediaFillRead('IN', units, '1');
    expect(await exceptionsOf(mf.batchId)).toContain('LIB_LIMIT_BREACH');
    const refused = await mf.d.sign('operator1', { type: 'SIGN_PERFORMED', stepKey: 'p-read@' });
    expect(refused.result.ok).toBe(false);
    expect((await fitness(units.line)).fit).toBe('QUALIFIED');
    expect((await qualificationEvents(units.line)).map((e) => e.kind)).toEqual(['QUALIFIED']);
    const other = await arrangeUnits();
    const passed = await mediaFillRead('EU', other, '0');
    expect(await exceptionsOf(passed.batchId)).toEqual([]);
    expect((await fitness(other.line)).fit).toBe('QUALIFIED');
  });

  it('[ST-33] the reading is found by its block\'s role APS_READING and its marked count, not its code: a firm\'s own approved reading block (SITE-MEDIA-READ) withdraws the line too; the same form without the role and the mark withdraws nothing', async () => {
    const units = await arrangeUnits();
    const mf = await mediaFillRead('SITE', units, '1');
    expect((await qualificationEvents(units.line)).at(-1)).toMatchObject({ kind: 'QUALIFICATION_WITHDRAWN', reference: mf.batchNumber });
    expect((await fitness(units.line)).fit).toBe('NOT_QUALIFIED');
    const other = await arrangeUnits();
    const plain = await mediaFillRead('PLAIN', other, '1');
    expect(await exceptionsOf(plain.batchId)).toContain('LIB_LIMIT_BREACH');
    expect((await qualificationEvents(other.line)).map((e) => e.kind)).toEqual(['QUALIFIED']);
  });
});

describe('the review of a failed media fill before the line is qualified again (ST-33; tablets 1912)', () => {
  it('[ST-33] the withdrawal records the impact list: the batches made on the line since its last successful APS (one before it is not listed, one after it is), not the failed media fill itself', async () => {
    const units = await arrangeUnits();
    const before = await filled('PRODUCT', units);
    const good = await mediaFillRead('EU', units, '0');
    const after = await filled('PRODUCT', units);
    const failed = await mediaFillRead('EU', units, '1');
    const { rows } = await gmp.db.admin.query<{ failed: string; good: string | null; batches: string[] }>(
      `select w.failed_batch_number as failed, w.last_good_aps_batch as good,
              array(select i.batch_number from plant.aps_failure_impact i where i.event_id = w.event_id order by i.batch_number) as batches
         from plant.aps_failure_withdrawal w join plant.equipment e on e.id = w.equipment_id where e.code = $1`,
      [units.line],
    );
    expect(rows).toEqual([{ failed: failed.batchNumber, good: good.batchNumber, batches: [after.batchNumber] }]);
    expect(rows[0]!.batches).not.toContain(before.batchNumber);
    const view = valueOf(await (await gmp.asPersona('qaInvestigator')).call(routes.plant.apsFailure, { params: { code: units.line } }));
    expect(view.withdrawal).toMatchObject({ failedBatch: failed.batchNumber, lastSuccessfulAps: good.batchNumber, reviewed: false });
    expect(view.withdrawal?.batches.map((b) => b.batchNumber)).toEqual([after.batchNumber]);
    // The list is insert-only, whoever writes it.
    await expect(gmp.db.admin.query('delete from plant.aps_failure_impact i using plant.equipment e where e.id = i.equipment_id and e.code = $1', [units.line])).rejects.toThrow();
  });

  it('[ST-33] requalification is refused before QA records the review, by the route and by a direct write; it is accepted after it, and the review stands once', async () => {
    const units = await arrangeUnits();
    const mf = await mediaFillRead('EU', units, '1');
    expect(JSON.stringify(refusalOf(await requalify(units.line)))).toMatch(/EBMR-PLANT-074/);
    const steward = { ...(await actorOf(gmp, 'steward')), reasonCode: 'TEST_SETUP', reasonText: 'direct requalification', correlationId: randomUUID() };
    await expect(
      withCommand(gmp.db.admin, steward, (c) =>
        c.query("insert into plant.equipment_event (equipment_id, kind, reference, detail, person_id, account_id) select e.id, 'QUALIFIED', 'X', 'direct', gen_random_uuid(), gen_random_uuid() from plant.equipment e where e.code = $1", [units.line]),
      ),
    ).rejects.toThrow(/EBMR-PLANT-074/);
    expect((await fitness(units.line)).fit).toBe('NOT_QUALIFIED');
    // Fewer than three repeat runs with the firm's justification is accepted (A1 9.46: normally at least three).
    valueOf(await review('qaInvestigator', units.line, { riskAssessmentRef: `QRM-APS-${TAG}`, repeatApsRefs: ['APS-R1', 'APS-R2'], justification: 'Root cause found and corrected (filling needle); two runs agreed with QA' }));
    expect(JSON.stringify(refusalOf(await review('qaInvestigator', units.line, { riskAssessmentRef: 'QRM-2', repeatApsRefs: ['A', 'B', 'C'] })))).toMatch(/EBMR-PLANT-070/);
    const { rows } = await gmp.db.admin.query<{ refs: string[]; justification: string | null; failed: string }>(
      `select r.repeat_aps_refs as refs, r.justification, w.failed_batch_number as failed from plant.aps_failure_review r
         join plant.aps_failure_withdrawal w on w.event_id = r.event_id join plant.equipment e on e.id = r.equipment_id where e.code = $1`,
      [units.line],
    );
    expect(rows).toEqual([{ refs: ['APS-R1', 'APS-R2'], justification: 'Root cause found and corrected (filling needle); two runs agreed with QA', failed: mf.batchNumber }]);
    valueOf(await requalify(units.line));
    expect((await fitness(units.line)).fit).toBe('QUALIFIED');
  });

  it('[ST-33] the review is refused with fewer than three repeat runs and no justification, with no run, with a run cited twice or the failed batch cited as its own repeat, with a blank risk-assessment reference, and without RECORD.QA_REVIEW; three distinct runs are accepted', async () => {
    const units = await arrangeUnits();
    const mf = await mediaFillRead('EU', units, '1');
    const code = async (persona: string, body: Parameters<typeof review>[2]) => JSON.stringify(refusalOf(await review(persona, units.line, body)));
    const risk = `QRM-APS-${TAG}`;
    expect(await code('qaInvestigator', { riskAssessmentRef: risk, repeatApsRefs: ['APS-R1', 'APS-R2'] })).toMatch(/EBMR-PLANT-073/);
    expect(await code('qaInvestigator', { riskAssessmentRef: risk, repeatApsRefs: ['APS-R1', 'APS-R2', 'APS-R1'] })).toMatch(/EBMR-PLANT-072/);
    expect(await code('qaInvestigator', { riskAssessmentRef: risk, repeatApsRefs: ['APS-R1', 'APS-R2', mf.batchNumber] })).toMatch(/EBMR-PLANT-072/);
    // Blank or empty input is refused at the route before the database (the contract trims and needs one character).
    expect(await code('qaInvestigator', { riskAssessmentRef: risk, repeatApsRefs: [] })).toMatch(/INVALID_INPUT|EBMR-API/);
    expect(await code('qaInvestigator', { riskAssessmentRef: '  ', repeatApsRefs: ['APS-R1', 'APS-R2', 'APS-R3'] })).toMatch(/INVALID_INPUT|EBMR-API/);
    expect(await code('steward', { riskAssessmentRef: risk, repeatApsRefs: ['APS-R1', 'APS-R2', 'APS-R3'] })).toMatch(/RECORD\.QA_REVIEW|permission|FORBIDDEN/i);
    // The database refuses the same, whoever calls it: a blank reference, no run, fewer than three without a justification.
    const qa = { ...(await actorOf(gmp, 'qaInvestigator')), reasonCode: 'TEST_SETUP', reasonText: 'direct review', correlationId: randomUUID() };
    const direct = (risk: string, refs: string[]) =>
      withCommand(gmp.db.app, qa, (c) => c.query('select plant.record_aps_failure_review($1, $2, $3::text[], null)', [units.line, risk, refs]));
    await expect(direct(' ', ['APS-R1', 'APS-R2', 'APS-R3'])).rejects.toThrow(/EBMR-PLANT-071/);
    await expect(direct(risk, [])).rejects.toThrow(/EBMR-PLANT-072/);
    await expect(direct(risk, ['APS-R1', ' '])).rejects.toThrow(/EBMR-PLANT-072/);
    await expect(direct(risk, ['APS-R1'])).rejects.toThrow(/EBMR-PLANT-073/);
    // A row written past the function still meets the table's checks.
    await expect(
      withCommand(gmp.db.admin, qa, (c) =>
        c.query(
          `insert into plant.aps_failure_review (event_id, equipment_id, risk_assessment_ref, repeat_aps_refs, person_id, account_id)
           select w.event_id, w.equipment_id, 'QRM', array['A', 'B'], gen_random_uuid(), gen_random_uuid() from plant.aps_failure_withdrawal w join plant.equipment e on e.id = w.equipment_id where e.code = $1`,
          [units.line],
        ),
      ),
    ).rejects.toThrow(/aps_failure_review_three_or_justified/);
    valueOf(await review('qaInvestigator', units.line, { riskAssessmentRef: risk, repeatApsRefs: ['APS-R1', 'APS-R2', 'APS-R3'] }));
    valueOf(await requalify(units.line));
  });

  it('[ST-33] a withdrawal that is not ST-33\'s (QA withdraws the qualification by hand) is requalified as before, with no review', async () => {
    const units = await arrangeUnits();
    const steward = await gmp.asPersona('steward');
    valueOf(await steward.call(routes.plant.equipmentEvent, { params: { code: units.line }, body: { event: 'EVENT', kind: 'QUALIFICATION_WITHDRAWN', detail: 'Periodic requalification overdue', reference: `PQ-${TAG}` } }));
    expect((await fitness(units.line)).fit).toBe('NOT_QUALIFIED');
    expect(valueOf(await (await gmp.asPersona('qaInvestigator')).call(routes.plant.apsFailure, { params: { code: units.line } })).withdrawal).toBeNull();
    valueOf(await requalify(units.line));
    expect((await fitness(units.line)).fit).toBe('QUALIFIED');
  });
});

describe('the repeat media fills run on the line withdrawn for them (ST-29, ST-33; tablets 1913)', () => {
  it('[ST-29][ST-33] a media fill fills on a line withdrawn after a failed APS (ST-33) or for an APS a change requires (ST-29); a product batch on the same line is still refused', async () => {
    const units = await arrangeUnits();
    await mediaFillRead('EU', units, '1');
    expect((await fitness(units.line)).fit).toBe('NOT_QUALIFIED');
    const repeat = await setupOn('EU', units);
    expect(repeat.ok, errorText(repeat)).toBe(true);
    const product = await setupOn('PRODUCT', units);
    expect(product.ok).toBe(false);
    expect(errorText(product)).toMatch(/not qualified|NOT_QUALIFIED/i);
    // ST-29: QA approves a change that names the line.
    const changed = await arrangeUnits();
    const steward = await gmp.asPersona('steward');
    const number = `CR-APS-${randomUUID().slice(0, 6).toUpperCase()}`;
    valueOf(await steward.call(routes.config.raiseChangeRecord, { body: { number, title: 'Filling line HVAC rebalanced', description: 'Air handling unit of the filling room replaced', areas: ['RBE_RULE'], apsLines: [changed.line] } }));
    const approved = await signAction(gmp, await gmp.asPersona('qaInvestigator'), 'qaInvestigator', { kind: 'CONFIG_CHANGE_ACT', act: 'APPROVE', number });
    expect(approved.ok, approved.ok ? '' : JSON.stringify(approved.error)).toBe(true);
    expect((await fitness(changed.line)).fit).toBe('NOT_QUALIFIED');
    const afterChange = await setupOn('IN', changed);
    expect(afterChange.ok, errorText(afterChange)).toBe(true);
    expect((await setupOn('PRODUCT', changed)).ok).toBe(false);
  });

  it('[ST-29][ST-33] a media fill is still refused on a line withdrawn for another reason, and on an APS-withdrawn line with a second problem (in maintenance)', async () => {
    const units = await arrangeUnits();
    const steward = await gmp.asPersona('steward');
    valueOf(await steward.call(routes.plant.equipmentEvent, { params: { code: units.line }, body: { event: 'EVENT', kind: 'QUALIFICATION_WITHDRAWN', detail: 'Periodic requalification overdue', reference: `PQ-${TAG}` } }));
    const other = await setupOn('EU', units);
    expect(other.ok).toBe(false);
    expect(errorText(other)).toMatch(/not qualified|NOT_QUALIFIED/i);
    const failed = await arrangeUnits();
    await mediaFillRead('EU', failed, '1');
    const c = await gmp.db.admin.connect();
    try {
      await c.query('begin');
      await c.query('set local session_replication_role = replica');
      await c.query("insert into plant.equipment_event (equipment_id, kind, reference, detail, person_id, account_id) select e.id, 'MAINTENANCE_STARTED', 'WO-1', 'Needle change', gen_random_uuid(), gen_random_uuid() from plant.equipment e where e.code = $1", [failed.line]);
      await c.query('commit');
    } finally {
      c.release();
    }
    expect((await fitness(failed.line)).fit).toBe('MAINTENANCE');
    const second = await setupOn('EU', failed);
    expect(second.ok).toBe(false);
    expect(errorText(second)).toMatch(/maintenance/i);
  });
});
