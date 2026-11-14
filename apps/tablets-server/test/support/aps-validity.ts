/**
 * INV-23 (c) (tablets 1915): a filling line fills an aseptic injectables batch only while its aseptic process simulation
 * is valid, so a test that fills such a batch arranges what a firm has before it: a media fill on the line read with no
 * contaminated unit (a process simulation batch, run through the routes as aps-failure.test.ts runs one), and the line's
 * APS interval, proposed by the steward and approved by QA through the database commands.
 *
 *   prepareMediaFill    in beforeAll, after the server and the lifecycle world: the media-fill product, its numbering rule,
 *                       its incubator and its master (the file's own filling formulation, the EM during it, the reading
 *                       and the EM counts), approved and authorised for India (a process simulation needs no licence).
 *                       The blocks the file has not approved yet are drafted and approved here (`approve`).
 *   passingMediaFill    a media fill on the file's units, filled, monitored and read with no contaminated unit.
 *   setApsInterval      the line's interval in days: proposed by the steward, approved by QA (qaInvestigator).
 */
import { randomUUID } from 'node:crypto';
import { routes } from '@ebmr/api-contract';
import { library, type flow } from '@ebmr/recipe-core/pure';
import { openServiceSession } from '@ebmr/test-kit';
import { postOrder } from '../../../../packages/recipe-core/test/lifecycle/gmp-support.ts';
import { cell, reason, type World } from '../../../../packages/recipe-core/test/lifecycle/support.ts';
import { INJECTABLE_SEEDS } from '../../../../packages/recipe-core/src/library/seed/injectables.ts';
import { INJECTABLE_ASEPTIC_SEEDS } from '../../../../packages/recipe-core/src/library/seed/injectables-aseptic.ts';
import { valueOf } from '../esig/support.ts';
import type { ExecServer, RunDriver } from '../execution/support.ts';
import { actorOf, gmpContent } from './gmp-world.ts';
import { confirmErpPending } from './signed-acts.ts';
import { driverOf, issueBatch, libraryEntry, phaseOf, signAs, stage, type Json } from '../substance/support.ts';

type Item = { definition: library.BlockDefinition; exampleUse: unknown };
const seed = (code: string): Item => {
  const item = [...INJECTABLE_SEEDS, ...INJECTABLE_ASEPTIC_SEEDS].find((s) => s.definition.code === code);
  if (!item) throw new Error(`no injectables seed ${code}`);
  return item;
};

export interface MediaFillPlan {
  readonly familyId: string;
  readonly content: flow.MbrContent;
  readonly site: string;
  readonly planLine: string;
  readonly size: string;
  readonly fill: Item;
  readonly incubator: string;
}

/** The media fill of the file's filling formulation: prepared once per file. */
export async function prepareMediaFill(
  gmp: ExecServer,
  world: World,
  opts: { tag: string; site: string; planLine: string; size: string; fill?: Item; approve?: readonly string[] },
): Promise<MediaFillPlan> {
  const fill = opts.fill ?? seed('INJ-FILL');
  const [em, read, counts] = [seed('INJ-EM'), seed('INJ-APS-READ'), seed('INJ-EM-COUNTS')];
  const product = { code: `INJMFV-${opts.tag}`, name: 'Media fill (TSB) 2 mL vials', strength: '2 mL' };
  const steward = await gmp.asPersona('steward');
  valueOf(await steward.call(routes.masterData.enterProduct, { body: { productCode: product.code, strength: product.strength, productName: product.name, dosageForm: 'Injection', betaLactam: false, shelfLifeMonths: 24, changeReason: 'Media fill of the APS schedule' } }));
  await confirmErpPending(gmp);
  const [author, approver] = await Promise.all([gmp.asPersona('author'), gmp.asPersona('approver')]);
  for (const code of opts.approve ?? ['INJ-APS-READ']) {
    const { block } = valueOf(await author.call(routes.library.draft, { body: { definition: seed(code).definition as unknown as Json } }));
    await signAs(gmp, approver, 'approver', { kind: 'LIBRARY_ACT', act: 'BLOCK_APPROVE', subjectId: block.blockId });
  }
  const content = gmpContent((m) => {
    const header = m['header'] as Json;
    header['family'] = `INJ-MFV-${opts.tag}`;
    header['edition'] = 'injectables';
    header['recordKind'] = 'PROCESSING';
    header['nonProduct'] = 'PROCESS_SIMULATION';
    header['marketSet'] = ['IN'];
    header['title'] = `${product.name}: aseptic process simulation`;
    header['product'] = { code: product.code, name: product.name, strength: product.strength, dosageForm: 'Injection' };
    delete header['unitMassMg'];
    const body = (m['procedure'] as Json)['body'] as Json;
    const like = (body['children'] as Json[])[0] as Json;
    body['children'] = [
      stage(like, 'S-FILL', 'Aseptic filling with growth medium', [phaseOf(fill.definition, 'p-fill', fill.exampleUse as Json), phaseOf(em.definition, 'p-em', em.exampleUse as Json)]),
      stage(like, 'S-READ', 'Incubation and reading', [phaseOf(read.definition, 'p-read', read.exampleUse as Json)]),
      stage(like, 'S-EM', 'Environmental monitoring after incubation', [phaseOf(counts.definition, 'p-counts', counts.exampleUse as Json)]),
    ];
    for (const x of ['parameters', 'calculations', 'yieldCheckpoints', 'timeConstraints', 'goldenCases', 'intermediates', 'riskReductions', 'inputs']) m[x] = [];
    m['blockDefinitions'] = [fill.definition, em.definition, read.definition, counts.definition];
  });
  const v = await world.approvedVersion(content);
  await world.authorise({ versionId: v.versionId, market: 'IN', kind: 'CURRENT', cells: [cell(opts.site, opts.planLine, opts.size)], regulatoryBasis: 'IN: media fill of the aseptic process (invented)' });
  await world.run(await actorOf(gmp, 'steward'), (c) =>
    c.query('select site.define_batch_number_rule($1::jsonb)', [JSON.stringify({ rule_code: `INJMFV-${opts.tag}`, site_code: opts.site, product_code: product.code, batch_kind: 'PROCESSING', format: 'MV{YY}{SEQ:5}', site_zone: 'Asia/Kolkata', reason: 'Numbering SOP-QA-017 rev 3' })]),
    reason('Media fill numbering'),
  );
  // The incubator the reading names (test arrangement of master data, triggers off), as the file arranges its own units.
  const incubator = `INCUB-${opts.tag}`;
  const c = await gmp.db.admin.connect();
  try {
    await c.query('begin');
    await c.query('set local session_replication_role = replica');
    await c.query("insert into plant.equipment_class (code, kind, description, clean_hold, dirty_hold, calibration_required, recorded_by) values ('INCUBATOR', 'PROCESS', 'Media fill incubator', interval '3 days', interval '2 days', false, gen_random_uuid()) on conflict do nothing");
    const { rows } = await c.query<{ id: string }>("insert into plant.equipment (code, name, class_code, kind, recorded_by) values ($1, 'Media fill incubator', 'INCUBATOR', 'PROCESS', gen_random_uuid()) returning id", [incubator]);
    await c.query("insert into plant.equipment_event (equipment_id, kind, reference, detail, person_id, account_id) values ($1, 'QUALIFIED', 'QUAL-INJ', 'IQ/OQ/PQ approved', gen_random_uuid(), gen_random_uuid())", [rows[0]?.id]);
    await c.query('commit');
  } finally {
    c.release();
  }
  return { familyId: v.familyId, content, site: opts.site, planLine: opts.planLine, size: opts.size, fill, incubator };
}

/** The nominal entries of a library step, the units named by field id, recorded by operator1. */
async function record(d: RunDriver, stepKey: string, item: Item, units: Json, over: Json = {}): Promise<void> {
  await d.ok('operator1', { type: 'START_STEP', stepKey });
  for (const e of library.nominalEntries(item.definition, item.exampleUse as never)) {
    const { kind, ...entry } = e;
    const data: Json = Object.fromEntries(Object.entries(entry).filter(([x]) => x !== 'equipment' && x !== 'lots'));
    for (const x of Object.keys(data)) if (x in units) data[x] = units[x];
    if (kind === 'tray') data['trayOut'] = `TRAY-${randomUUID().slice(0, 8)}`;
    await d.ok('operator1', libraryEntry(stepKey, kind, { ...data, ...(over[kind] as Json | undefined) }));
  }
}

async function signed(d: RunDriver, stepKey: string): Promise<void> {
  await d.signed('operator1', { type: 'SIGN_PERFORMED', stepKey });
  await d.signed('verifier1', { type: 'VERIFY', stepKey, meaning: 'VERIFIED' });
}

/**
 * A media fill on the file's units (`units`: field id to unit code, the filling line under `line`), its EM entry
 * changed by `emOver` as the file records its own EM, read with no contaminated unit: a passing APS of the line.
 */
export async function passingMediaFill(gmp: ExecServer, plan: MediaFillPlan, units: Json, emOver: Json): Promise<{ batchId: string; batchNumber: string }> {
  const issuer = await gmp.asPersona('issuer');
  await postOrder(gmp.db.app, await openServiceSession(gmp.db, gmp.seed, 'erpInterface'), plan.content, plan.size);
  const planned = valueOf(await issuer.call(routes.execution.planBatch, { body: { familyId: plan.familyId, markets: ['IN'], site: plan.site, line: plan.planLine, batchSize: plan.size } }));
  await issueBatch(gmp, planned.batchId, { code: 'PRODUCTION_PLAN', text: 'Media fill of the APS schedule' });
  const d = await driverOf(gmp, planned.batchId);
  const all = { ...units, incubator: plan.incubator };
  await record(d, 'p-fill@', plan.fill, all);
  await signed(d, 'p-fill@');
  await record(d, 'p-em@', seed('INJ-EM'), all, emOver);
  await signed(d, 'p-em@');
  await d.signed('supervisor1', { type: 'SIGN_OFF_STAGE', stageKey: 'S-FILL@' });
  await record(d, 'p-read@', seed('INJ-APS-READ'), all, { reading: { contaminated: '0' } });
  return { batchId: planned.batchId, batchNumber: planned.batchNumber };
}

/** The line's APS interval as a firm sets it: the steward proposes it, QA approves it (another person). */
export async function setApsInterval(gmp: ExecServer, world: World, line: string, days: number): Promise<void> {
  const why = reason('APS interval of the filling line');
  const id = await world.run(await actorOf(gmp, 'steward'), async (c) =>
    (await c.query<{ id: string }>('select plant.propose_aps_interval($1, $2, $3) as id', [line, days, 'Media fill every six months per SOP-QA-031'])).rows[0]!.id, why);
  await world.run(await actorOf(gmp, 'qaInvestigator'), (c) => c.query('select plant.approve_aps_interval($1)', [id]), why);
}

/**
 * A released lot of EM plates (test arrangement of the lot register, triggers off; a component received as the E2E
 * receives one), for a media fill in a file whose own plates' lot is arranged later.
 */
export async function arrangeEmMediaLot(gmp: ExecServer, site: string, lotCode: string): Promise<void> {
  const c = await gmp.db.admin.connect();
  try {
    await c.query('begin');
    await c.query('set local session_replication_role = replica');
    const { rows } = await c.query<{ id: string }>(
      `insert into site.material_lot (id, site_code, lot_code, material_code, material_name, material_kind, received_quantity, unit, expires_at,
                                      received_by_person, received_by_account, correlation_id)
       values (gen_random_uuid(), $1, $2, $3, 'Environmental monitoring plates, tryptone soya agar', 'PRIMARY_PACKAGING', 500, '1', clock_timestamp() + interval '1 year',
               gen_random_uuid(), gen_random_uuid(), gen_random_uuid()) returning id`,
      [site, lotCode, `MAT-${lotCode}`],
    );
    await c.query("insert into platform.aggregate_state (aggregate_type, aggregate_id, machine_code, machine_version, state, version) values ('material_lot', $1, 'material_lot', 1, 'RELEASED', 2)", [rows[0]?.id]);
    await c.query("insert into site.lot_identity_result (lot_id, result, method_reference, test_reference, recorded_by_person, recorded_by_account) values ($1, 'PASS', 'STP-ID', 'AR-1', gen_random_uuid(), gen_random_uuid())", [rows[0]?.id]);
    await c.query('commit');
  } finally {
    c.release();
  }
}
