/**
 * ST-33 (tablets 1911; lead-approved behaviour; owner decision 0001 #2): a media fill (aseptic process simulation) read
 * with a contaminated unit fails. On a master for the EU market (Annex 1 9.46: repeat simulations before the line is back
 * in routine use) the database withdraws the qualification of the filling line the media fill used, so the fitness guard
 * refuses the line in a step of any product until QA records it QUALIFIED again. On a master for India only (Schedule M
 * Part II 5.6(i): an investigation and the consideration of a repeat) the reading raises its critical exception, which
 * holds the step until it is handled under a deviation, and the line stays qualified.
 *
 * The media-fill masters carry the process-simulation mark (recipe-core 1896), so they are issued with no licence and no
 * export permission. Arranged outside the routes, as the aseptic gate (aseptic-gate.test.ts): the product, the plant
 * units (test arrangement of master data), the ERP order and the numbering rule.
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

const SITE = 'SITE-1';
const LINE = 'L1';
const SIZE = 'BS-100K';
const TAG = randomUUID().slice(0, 6).toUpperCase();
/** One media-fill product per master (a family is one product, edition and record kind). */
const PRODUCTS = { EU: { code: `INJMFE-${TAG}`, name: 'Media fill (TSB) 2 mL vials, EU line', strength: '2 mL' }, IN: { code: `INJMFI-${TAG}`, name: 'Media fill (TSB) 2 mL vials', strength: '2 mL' } };
const REASON = 'Injectables ST-33 media fill';

const seed = (code: string) => {
  const item = [...INJECTABLE_SEEDS, ...INJECTABLE_ASEPTIC_SEEDS].find((s) => s.definition.code === code);
  if (!item) throw new Error(`no injectables seed ${code}`);
  return item;
};
const FILL = seed('INJ-FILL');
const ALARMS = seed('INJ-ALARM-ASSESSMENT');
const READ = seed('INJ-APS-READ');

/** A media-fill master (process simulation) for the market set: filling, (EU) the alarms' assessment, the reading. */
const mediaFill = (marketSet: string[]): flow.MbrContent =>
  gmpContent((m) => {
    const PRODUCT = PRODUCTS[marketSet.includes('EU') ? 'EU' : 'IN'];
    const header = m['header'] as Json;
    header['family'] = `INJ-MF-${marketSet.join('')}-${TAG}`;
    header['edition'] = 'injectables';
    header['recordKind'] = 'PROCESSING';
    header['nonProduct'] = 'PROCESS_SIMULATION';
    header['marketSet'] = marketSet;
    header['title'] = `${PRODUCT.name}: aseptic process simulation`;
    header['product'] = { code: PRODUCT.code, name: PRODUCT.name, strength: PRODUCT.strength, dosageForm: 'Injection' };
    delete header['unitMassMg'];
    const body = (m['procedure'] as Json)['body'] as Json;
    const like = (body['children'] as Json[])[0] as Json;
    const eu = marketSet.includes('EU');
    body['children'] = [
      stage(like, 'S-FILL', 'Aseptic filling with growth medium', [phaseOf(FILL.definition, 'p-fill', FILL.exampleUse)]),
      ...(eu ? [stage(like, 'S-ALARMS', 'Alarms raised during filling', [phaseOf(ALARMS.definition, 'p-alarms', ALARMS.exampleUse)])] : []),
      stage(like, 'S-READ', 'Incubation and reading', [phaseOf(READ.definition, 'p-read', READ.exampleUse)]),
    ];
    for (const k of ['parameters', 'calculations', 'yieldCheckpoints', 'timeConstraints', 'goldenCases', 'intermediates', 'riskReductions', 'inputs']) m[k] = [];
    m['blockDefinitions'] = [FILL.definition, ...(eu ? [ALARMS.definition] : []), READ.definition];
  });

const masters = { EU: mediaFill(['IN', 'EU']), IN: mediaFill(['IN']) };

let gmp: ExecServer;
let world: World;
const versions: Record<string, { familyId: string; versionId: string }> = {};

/** The plant units a media fill names (test arrangement of master data, triggers off): qualified, of the formulation's classes. */
async function arrangeUnits(): Promise<{ line: string; room: string; incubator: string }> {
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

/** A media-fill batch of the market's master, planned from its ERP order and issued. */
async function issued(market: 'EU' | 'IN'): Promise<{ batchId: string; batchNumber: string }> {
  const issuer = await gmp.asPersona('issuer');
  await postOrder(gmp.db.app, await openServiceSession(gmp.db, gmp.seed, 'erpInterface'), masters[market], SIZE);
  const planned = valueOf(await issuer.call(routes.execution.planBatch, { body: { familyId: versions[market]!.familyId, markets: market === 'EU' ? ['IN', 'EU'] : ['IN'], site: SITE, line: LINE, batchSize: SIZE } }));
  await issueBatch(gmp, planned.batchId, { code: 'PRODUCTION_PLAN', text: 'Media fill of the APS schedule' });
  return { batchId: planned.batchId, batchNumber: planned.batchNumber };
}

/** The nominal entries of a library step (some sections' data changed), naming the test's units, recorded by operator1. */
async function record(d: RunDriver, stepKey: string, item: { definition: library.BlockDefinition; exampleUse: unknown }, units: Json, over: Json = {}): Promise<void> {
  await d.ok('operator1', { type: 'START_STEP', stepKey });
  for (const e of library.nominalEntries(item.definition, item.exampleUse as never)) {
    const { kind, ...entry } = e;
    // The equipment facts are the server's (EBMR-API-SERVER-FILLED): the entry names the units by their codes only.
    const data: Json = Object.fromEntries(Object.entries(entry).filter(([k]) => k !== 'equipment' && k !== 'lots'));
    for (const k of Object.keys(data)) if (k in units) data[k] = units[k];
    if (kind === 'tray') data['trayOut'] = `TRAY-${randomUUID().slice(0, 8)}`;
    await d.ok('operator1', libraryEntry(stepKey, kind, { ...data, ...(over[kind] as Json | undefined) }));
  }
}

async function signed(d: RunDriver, stepKey: string, verify = true): Promise<void> {
  await d.signed('operator1', { type: 'SIGN_PERFORMED', stepKey });
  if (verify) await d.signed('verifier1', { type: 'VERIFY', stepKey, meaning: 'VERIFIED' });
}

/** The media fill run up to its reading: filled on the units, the alarms assessed (EU), then read with `contaminated` units. */
async function mediaFillRead(market: 'EU' | 'IN', units: Json, contaminated: string): Promise<{ batchId: string; batchNumber: string; d: RunDriver }> {
  const b = await issued(market);
  const d = await driverOf(gmp, b.batchId);
  await record(d, 'p-fill@', FILL, units);
  await signed(d, 'p-fill@');
  await d.signed('supervisor1', { type: 'SIGN_OFF_STAGE', stageKey: 'S-FILL@' });
  if (market === 'EU') {
    await d.ok('operator1', { type: 'START_STEP', stepKey: 'p-alarms@' });
    await d.ok('operator1', libraryEntry('p-alarms@', 'alarms', { alarmsRaised: false }));
    await signed(d, 'p-alarms@', false);
    await d.signed('supervisor1', { type: 'SIGN_OFF_STAGE', stageKey: 'S-ALARMS@' });
  }
  await record(d, 'p-read@', READ, units, { reading: { contaminated, identification: contaminated === '0' ? undefined : 'Staphylococcus epidermidis' } });
  return { ...b, d };
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

beforeAll(async () => {
  const ledgerDir = mkdtempSync(join(tmpdir(), 'ebmr-inj-aps-'));
  gmp = Object.assign(await startSigningServer('GMP', { stub: false, env: { EBMR_NUMBER_LEDGER_FILE: join(ledgerDir, 'numbers.ledger.jsonl') } }), { exchangeDir: ledgerDir });
  vi.useFakeTimers({ toFake: ['performance'] });
  const steward = await gmp.asPersona('steward');
  for (const p of Object.values(PRODUCTS)) {
    valueOf(await steward.call(routes.masterData.enterProduct, { body: { productCode: p.code, strength: p.strength, productName: p.name, dosageForm: 'Injection', betaLactam: false, shelfLifeMonths: 24, changeReason: REASON } }));
    await confirmErpPending(gmp);
  }
  const [author, approver] = await Promise.all([gmp.asPersona('author'), gmp.asPersona('approver')]);
  for (const def of [FILL.definition, ALARMS.definition, READ.definition]) {
    const { block } = valueOf(await author.call(routes.library.draft, { body: { definition: def as unknown as Json } }));
    await signAs(gmp, approver, 'approver', { kind: 'LIBRARY_ACT', act: 'BLOCK_APPROVE', subjectId: block.blockId });
  }
  world = await gmpLifecycleWorld(gmp);
  for (const market of ['EU', 'IN'] as const) {
    const v = await world.approvedVersion(masters[market]);
    versions[market] = v;
    for (const m of market === 'EU' ? ['IN', 'EU'] : ['IN']) {
      await world.authorise({ versionId: v.versionId, market: m, kind: 'CURRENT', cells: [cell(SITE, LINE, SIZE)], regulatoryBasis: `${m}: media fill of the aseptic process (invented)` });
    }
  }
  for (const [k, p] of Object.entries(PRODUCTS)) {
    await world.run(await actorOf(gmp, 'steward'), (c) =>
      c.query('select site.define_batch_number_rule($1::jsonb)', [JSON.stringify({ rule_code: `INJMF${k}-${TAG}`, site_code: SITE, product_code: p.code, batch_kind: 'PROCESSING', format: `M${k.slice(0, 1)}{YY}{SEQ:5}`, site_zone: 'Asia/Kolkata', reason: 'Numbering SOP-QA-017 rev 3' })]),
      reason('Injectables ST-33 numbering'),
    );
  }
}, 900_000);
afterAll(async () => {
  vi.useRealTimers();
  await gmp?.close();
});

describe('a failed media fill on an EU master withdraws the filling line (ST-33; tablets 1911)', () => {
  it('[ST-33] an EU media fill read with one contaminated unit raises its critical exception and withdraws the qualification of the filling line it used: the line is NOT_QUALIFIED and refused in a step of another batch until QA records it QUALIFIED again, after which it is usable', async () => {
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
    // Another batch (here the India master's) cannot name the line in its filling step.
    const next = await issued('IN');
    const d = await driverOf(gmp, next.batchId);
    await d.ok('operator1', { type: 'START_STEP', stepKey: 'p-fill@' });
    const setup = library.nominalEntries(FILL.definition, FILL.exampleUse as never).find((e) => e.kind === 'setup')!;
    const data: Json = Object.fromEntries(Object.entries(setup).filter(([k]) => k !== 'kind' && k !== 'equipment'));
    const refused = await d.command('operator1', libraryEntry('p-fill@', 'setup', { ...data, line: units.line, room: units.room }));
    expect(refused.ok).toBe(false);
    expect(JSON.stringify(refused.ok ? null : refused.error)).toMatch(/not qualified|NOT_QUALIFIED/i);
    // QA requalifies the line after the repeat media fills: usable again.
    const steward = await gmp.asPersona('steward');
    valueOf(await steward.call(routes.plant.equipmentEvent, { params: { code: units.line }, body: { event: 'EVENT', kind: 'QUALIFIED', detail: 'Three consecutive repeat media fills passed; investigation closed', reference: `APS-REQUAL-${TAG}` } }));
    expect(await fitness(units.line)).toEqual({ fit: 'QUALIFIED', problems: [] });
    await d.ok('operator1', libraryEntry('p-fill@', 'setup', { ...data, line: units.line, room: units.room }));
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
});
