/**
 * Phase 3 slice 5b: reprocessing and recovery additions held by the database (recipe-core 0620 to 0622, tablets 1020,
 * 1021; outline 5.2.9 cases 2 and 3; D-S5-7, D-S5-8), proven as the application role past the server: an honest
 * addition the engine builds from the database's facts is stored with its genealogy edge in the same transaction; the
 * same act through a tampered block handler (a forged engine: the rule skipped, the facts or the data changed) is refused
 * by the database alone; the registers are written only through their commands.
 *
 * Four test runs of dc-mini issued from one package (S, T: sources; R: receiving) and one of another product (O). Each
 * source keeps reusable residue in a container its TB-20 sort result names; the quality unit (qa1) reserves it and
 * authorises each use. Master data the test needs and no persona records (a plant press unit) is arranged as setup.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { withCommand, type ActorContext } from '@ebmr/kernel';
import { actorOfBrowser } from '../../esig/support.ts';
import { prepareSignature } from '../../execution/db-guards-support.ts';
import { importAndIssue, personaIn, RunDriver, startExecServer, writePackage, type ExecServer } from '../../execution/support.ts';
import { REPROCESSING_BLOCK_VERSIONS } from '../../../src/blocks/reprocessing/index.ts';
import { fakeTimers, laxEntry, stateOf, tamperHandler } from '../granulation/db-support.ts';
import { asSetup, cleanUnit } from '../compression/plant-support.ts';
import { entryCommand, reprocessingDbMbr, SHORT_AGE_SECONDS, startCommand, writer } from './db-support.ts';

type Json = Record<string, unknown>;

let sbx: ExecServer;
const runs: Record<'S' | 'T' | 'R' | 'O', RunDriver> = {} as never;
let qa: string;
let op1: string;
const advance = (): void => {
  vi.advanceTimersByTime(7_000);
};
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function sql<T>(text: string, params: unknown[] = []): Promise<T | null> {
  const { rows } = await sbx.db.admin.query<{ r: T | null }>(text, params);
  return rows[0]?.r ?? null;
}
const actorFor = async (d: RunDriver, persona: string): Promise<ActorContext> => {
  advance();
  return actorOfBrowser(sbx, d.browser(persona), persona);
};
async function as<T = Json>(d: RunDriver, persona: string, text: string, params: unknown[]): Promise<T> {
  return withCommand(sbx.db.app, await actorFor(d, persona), async (c) => (await c.query<{ r: T }>(text, params)).rows[0]?.r as T);
}
async function refusal(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'ok';
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    const code = /\b(EBMR-[A-Z]+-\d{3})\b/.exec(m)?.[1] ?? '';
    if (process.env['RPR_DEBUG']) console.log('REFUSAL', m.slice(0, 1500));
    const rule = [...m.matchAll(/\b((?:TB08|G24|TB20)-[A-Z-]*[A-Z])\b/g)].at(-1)?.[1];
    return [code, rule].filter(Boolean).join(' ') || m.slice(0, 300);
  }
}

/** A closed container of run `d` at `stage` (on `press` when given) holding `net` kg. */
async function container(d: RunDriver, stage: string, net: string, press?: string): Promise<string> {
  const o = await as<{ container_id: string; version: number }>(d, 'operator1', press ? 'select plant.open_container($1, $2, $3, $4) as r' : 'select plant.open_container($1, $2, $3) as r', press ? [d.runId, stage, 'kg', press] : [d.runId, stage, 'kg']);
  await as(d, 'operator1', 'select plant.close_container($1, $2, $3) as r', [o.container_id, net, o.version]);
  return o.container_id;
}

/** Run `d`'s inspection step sorted, its reusable residue (0.400 kg) in a new container; returns the container. */
async function residue(d: RunDriver): Promise<string> {
  const id = await container(d, 'INSPECTION', '0.400');
  const w = writer(sbx, d, advance).code;
  expect(await w('operator1', startCommand('p-tb20'))).toBe('ok');
  expect(await w('operator1', entryCommand('p-tb20', { kind: 'INSPECTION_START' }))).toBe('ok');
  expect(await w('operator1', entryCommand('p-tb20', { kind: 'INSPECTION_END' }))).toBe('ok');
  expect(
    await w('operator1', entryCommand('p-tb20', {
      kind: 'SORT_RESULT',
      inspected: { count: '1000', mass: { value: '10.500', unit: 'kg' } },
      accepted: { count: '990', mass: { value: '10.000', unit: 'kg' } },
      defects: [{ code: 'CHIPPED', count: '10' }],
      rejects: [{ category: 'REUSABLE_RESIDUE', container: id, count: '10', mass: { value: '0.400', unit: 'kg' } }],
    })),
  ).toBe('ok');
  return id;
}

/** qa1 signs RESIDUE_RESERVED on container `id` and reserves it, in one command. */
async function reserve(d: RunDriver, id: string, persona = 'qa1'): Promise<string> {
  const p = await prepareSignature(sbx, d.browser(persona), persona, 'output_container', id, 'RESIDUE_RESERVED');
  return refusal(withCommand(sbx.db.app, await p.actor(), async (c) => c.query('select recipe.reserve_residue($1, $2)', [id, await p.sign(c)])));
}

/** qa1 asks for and signs the authorisation of step `step` of run `d` (one use of `source` when given); returns its id. */
async function authorise(d: RunDriver, step: string, source: string | null, persona = 'qa1'): Promise<string> {
  const { id } = await as<{ id: string }>(d, persona, 'select recipe.propose_reprocessing_authorisation($1, $2, $3, $4, $5) as r', [d.runId, step, source, 'TEST-INV-1', 'TEST-RA-1']);
  const p = await prepareSignature(sbx, d.browser(persona), persona, 'reprocessing_authorisation', id, 'REPROCESSING_AUTHORISED');
  await withCommand(sbx.db.app, await p.actor(), async (c) => c.query('select recipe.authorise_reprocessing($1, $2)', [id, await p.sign(c)]));
  return id;
}

const facts = (container: string, batch: string): Promise<Json | null> => sql<Json>('select recipe.source_container_facts($1, $2) as r', [container, batch]);

/** A TB-08 addition of `container` at `step` of run `d`, the facts and the signer read as the server reads them. */
async function addition(d: RunDriver, step: string, container: string, gross: string, tare: string, auth?: string, extra: Json = {}): Promise<Json & { kind: string }> {
  const source = await facts(container, d.runId);
  return { kind: 'ADDITION', container, gross, tare, unit: 'kg', ...(source ? { source } : {}), ...(auth ? { authorisation: auth, authorisedBy: qa } : {}), ...extra };
}

/** What a forged engine stores for entry `e` at TB-08 step `step` of run `d` by operator1 (the honest data, changed). */
function honestData(e: Json, step: string, change: Json = {}): Json {
  return {
    container: e['container'], gross: e['gross'], tare: e['tare'], source: e['source'],
    case: step === 'p-tb08-r' ? 'RECOVERY' : 'REPROCESSING_ADDITION',
    ...(e['authorisation'] ? { authorisation: e['authorisation'], authorisedBy: e['authorisedBy'] } : {}),
    addedBy: op1, ...change,
  };
}

let sResidue: string;
let tResidue: string;
let oResidue: string;

beforeAll(async () => {
  sbx = await startExecServer();
  fakeTimers();
  const issuer = await sbx.asPersona('issuer');
  const browsers = {
    issuer,
    operator1: await sbx.asPersona('operator1'),
    operatorVerifier1: await sbx.asPersona('operatorVerifier1'),
    verifier1: await sbx.asPersona('verifier1'),
    qa1: await sbx.asPersona('qa1'),
  };
  const pkg = writePackage(sbx, reprocessingDbMbr());
  for (const k of ['S', 'T', 'R'] as const) runs[k] = new RunDriver(sbx, await importAndIssue(sbx, issuer, pkg), browsers);
  runs.O = new RunDriver(sbx, await importAndIssue(sbx, issuer, writePackage(sbx, reprocessingDbMbr({ code: 'PCM650', strength: '650 mg' }))), browsers);
  for (const d of Object.values(runs)) d.beforeTap = advance;
  qa = personaIn(sbx, 'qa1').personId;
  // The ERP product master of the test product (5a's register, arranged): 24 months' shelf life.
  await asSetup(sbx, "insert into site.erp_product (product_code, strength, product_name, reprocessing_permitted, beta_lactam, shelf_life_months, erp_reference, received_by_person, received_by_account, correlation_id) values ('PCM500', '500 mg', 'Paracetamol tablets', true, false, 24, 'TEST-ERP-1', gen_random_uuid(), gen_random_uuid(), gen_random_uuid())");
  op1 = personaIn(sbx, 'operator1').personId;
  sResidue = await residue(runs.S);
  tResidue = await residue(runs.T);
  oResidue = await residue(runs.O);
  expect(await writer(sbx, runs.R, advance).code('operator1', startCommand('p-tb08'))).toBe('ok');
}, 600_000);

afterAll(async () => {
  vi.useRealTimers();
  await sbx?.close();
});

describe('reprocessing and recovery additions in the database (recipe-core 0620 to 0622, tablets 1020, 1021)', () => {
  it('[DI-30][DI-05] the database holds the data schema of TB-08@1 as the registry declares it and its rule codes; nothing can change them', async () => {
    const { rows } = await sbx.db.admin.query<{ k: string; schema: Json }>("select entry_kind as k, schema from recipe.block_data_schema where block_type = 'TB-08'");
    const s = REPROCESSING_BLOCK_VERSIONS[0]?.dataSchema?.entries?.['ADDITION'] as unknown as Json;
    expect(rows.map((r) => r.k)).toEqual(['ADDITION']);
    expect(Object.keys((rows[0]?.schema['fields'] ?? {}) as Json).sort()).toEqual(Object.keys(s['fields'] as Json).sort());
    const src = readFileSync(new URL('../../../src/blocks/tb-08.ts', import.meta.url), 'utf8');
    const codes = [...new Set([...src.matchAll(/'(TB08(?:-[A-Z0-9]+)+)'/g)].map((m) => m[1] ?? ''))];
    const named = (await sbx.db.admin.query<{ name: string }>("select name from recipe.engine_name where name ~ '^TB08' or name = 'TB-08'")).rows.map((r) => r.name);
    expect(codes.filter((c) => !named.includes(c))).toEqual([]);
    expect(named).toContain('TB-08');
    await expect(sbx.db.admin.query("delete from recipe.block_data_schema where block_type = 'TB-08'")).rejects.toThrow(/EBMR-AUDIT-004/);
  });

  it('[PR-47] only the quality unit reserves reject material for reprocessing, under its own RESIDUE_RESERVED signature, and only a closed container its batch\'s inspection put reusable residue into; the register is written only through the command', async () => {
    const plain = await container(runs.S, 'COMPRESSION', '1.000');
    expect(await reserve(runs.S, plain)).toBe('EBMR-RPR-010');
    await expect(as(runs.S, 'operator1', 'select recipe.reserve_residue($1, $2) as r', [sResidue, randomUUID()])).rejects.toThrow(/EBMR-IAM-040/);
    await expect(sbx.db.app.query('insert into recipe.residue_reservation (container_id, signature_id, reserved_by_person, reserved_by_account, correlation_id) values ($1, $2, $2, $2, $2)', [sResidue, randomUUID()])).rejects.toThrow(/permission denied/);
    expect(await reserve(runs.S, sResidue)).toBe('ok');
    // A second reservation: the kernel refuses the second signature, and the command refuses a second reservation.
    expect(await reserve(runs.S, sResidue)).toMatch(/^EBMR-(ESIG-042|RPR-010)$/);
    await expect(as(runs.S, 'qa1', 'select recipe.reserve_residue($1, (select signature_id from recipe.residue_reservation where container_id = $1)) as r', [sResidue])).rejects.toThrow(/EBMR-RPR-010/);
    expect(await reserve(runs.T, tResidue)).toBe('ok');
    expect(await reserve(runs.O, oResidue)).toBe('ok');
    expect(await facts(sResidue, runs.R.runId)).toMatchObject({ case: 'REPROCESSING_ADDITION', remaining: '0.4', containsRecovered: false, stage: 'INSPECTION' });
  });

  it('[PR-47][IN-19] an addition without prior authorisation, by its authoriser, of another product, over the MBR percentage, age or source-batch count, from a source holding recovered material, from material of another status, or from ad-hoc material is refused by the database, past a forged engine', async () => {
    const R = runs.R;
    const w = writer(sbx, R, advance);
    // No per-use authorisation: the engine refuses; a forged engine that skips the rule is refused by the database.
    const bare = await addition(R, 'p-tb08', sResidue, '0.600', '0.500');
    expect(await w.code('operator1', entryCommand('p-tb08', bare))).toBe('ENGINE TB08-NOT-AUTHORISED');
    const forged = (e: Json, step = 'p-tb08', change: Json = {}) => ({ tamper: laxEntry(step, honestData(e, step, { net: { value: '0.100', unit: 'kg' }, ...change }), { verificationRequired: true }) });
    const m = (e: Json, step = 'p-tb08', change: Json = {}) => refusal(w.message('operator1', entryCommand(step, e as Json & { kind: string }), forged(e, step, change)));
    expect(await m(bare)).toBe('EBMR-RPR-031 TB08-NOT-AUTHORISED');
    // Forged facts (another product, no recovered material) are not the database's.
    const a1 = await authorise(R, 'p-tb08', sResidue);
    const lie = await addition(R, 'p-tb08', sResidue, '0.600', '0.500', a1);
    lie['source'] = { ...(lie['source'] as Json), remaining: '9' };
    expect(await m(lie)).toBe('EBMR-RPR-031 TB08-SOURCE-FACTS');
    // Over the MBR's 3 % of the standard batch (1.8 kg of 60 kg): the residue holds 0.4 kg, so over-remaining first.
    const big = await addition(R, 'p-tb08', sResidue, '0.900', '0.400', a1);
    expect(await w.code('operator1', entryCommand('p-tb08', big))).toBe('ENGINE TB08-OVER-REMAINING');
    expect(await m(big, 'p-tb08', { net: { value: '0.500', unit: 'kg' } })).toBe('EBMR-RPR-031 TB08-OVER-REMAINING');
    // Other product: O's reserved residue.
    const ao = await authorise(R, 'p-tb08', oResidue);
    const other = await addition(R, 'p-tb08', oResidue, '0.600', '0.500', ao);
    expect(await w.code('operator1', entryCommand('p-tb08', other))).toBe('ENGINE TB08-OTHER-PRODUCT');
    expect(await m(other)).toBe('EBMR-RPR-031 TB08-OTHER-PRODUCT');
    // Ad-hoc material: a container that does not exist.
    const ghost = randomUUID();
    const adhoc: Json & { kind: string } = { kind: 'ADDITION', container: ghost, gross: '0.600', tare: '0.500', unit: 'kg', source: { ...(lie['source'] as Json), container: ghost, remaining: '0.4' }, authorisation: a1, authorisedBy: qa };
    expect(await m(adhoc)).toBe('EBMR-RPR-031 TB08-AD-HOC');
    // Material of another status: reserved residue at the recovery step.
    expect(await writer(sbx, R, advance).code('operator1', startCommand('p-tb08-r'))).toBe('ok');
    const statusEntry = await addition(R, 'p-tb08-r', sResidue, '0.600', '0.500');
    expect(await w.code('operator1', entryCommand('p-tb08-r', statusEntry))).toBe('ENGINE TB08-SOURCE-STATUS');
    expect(await m(statusEntry, 'p-tb08-r')).toBe('EBMR-RPR-031 TB08-SOURCE-STATUS');
    // By its authoriser: operatorVerifier1 holds the authority in this test (arranged), authorises and adds himself.
    await asSetup(sbx, "insert into iam.role_permission (role_code, permission_code) values ('OPERATOR', 'REPROCESSING.AUTHORISE') on conflict do nothing");
    const self = await authorise(R, 'p-tb08', tResidue, 'operatorVerifier1');
    const selfEntry = { ...(await addition(R, 'p-tb08', tResidue, '0.600', '0.500', self)), authorisedBy: personaIn(sbx, 'operatorVerifier1').personId };
    expect(await w.code('operatorVerifier1', entryCommand('p-tb08', selfEntry))).toBe('ENGINE TB08-SELF-AUTHORISED');
    const selfForged = laxEntry('p-tb08', { ...honestData(selfEntry, 'p-tb08', { net: { value: '0.100', unit: 'kg' } }), addedBy: personaIn(sbx, 'operatorVerifier1').personId }, { verificationRequired: true });
    expect(await refusal(w.message('operatorVerifier1', entryCommand('p-tb08', selfEntry), { tamper: selfForged }))).toBe('EBMR-RPR-031 TB08-SELF-AUTHORISED');
    await asSetup(sbx, "delete from iam.role_permission where role_code = 'OPERATOR' and permission_code = 'REPROCESSING.AUTHORISE'");
    // Too old: the step's limit is SHORT_AGE_SECONDS from the container's close.
    expect(await writer(sbx, R, advance).code('operator1', startCommand('p-tb08-old'))).toBe('ok');
    await wait(Number(SHORT_AGE_SECONDS) * 1000 + 500);
    const aOld = await authorise(R, 'p-tb08-old', tResidue);
    const old = await addition(R, 'p-tb08-old', tResidue, '0.600', '0.500', aOld);
    expect(await w.code('operator1', entryCommand('p-tb08-old', old))).toBe('ENGINE TB08-TOO-OLD');
    expect(await m(old, 'p-tb08-old')).toBe('EBMR-RPR-031 TB08-TOO-OLD');
    // Nothing was recorded by any of these.
    expect(await sql<string>('select count(*)::text as r from recipe.source_addition where batch_id = $1', [R.runId])).toBe('0');
  });

  it('[INV-33][PR-57][PR-47] an authorised addition writes its genealogy edge with the source batch number and the quantity taken in the same transaction; the remaining quantity is reduced and never goes below zero; the authorisation serves once; a forward trace from the source finds the receiving batch; the computed item is the net added (C-07)', async () => {
    const R = runs.R;
    const w = writer(sbx, R, advance);
    const a1 = await authorise(R, 'p-tb08', sResidue);
    const e1 = await addition(R, 'p-tb08', sResidue, '0.750', '0.500', a1);
    expect(await refusal(w.message('operator1', entryCommand('p-tb08', e1)))).toBe('ok');
    const row = await sql<Json>("select to_jsonb(a) - 'id' - 'recorded_at' - 'source_generated_at' - 'source_manufactured_at' as r from recipe.source_addition a where a.batch_id = $1", [R.runId]);
    const sNumber = await sql<string>('select batch_number as r from recipe.batch_execution where id = $1', [runs.S.runId]);
    expect(row).toMatchObject({ container_id: sResidue, net_quantity: 0.25, unit: 'kg', source_batch_id: runs.S.runId, source_batch_number: sNumber, case_code: 'REPROCESSING_ADDITION', authorisation_id: a1, added_by_person: op1, block: 'TB-08@1' });
    expect((await facts(sResidue, R.runId))?.['remaining']).toBe('0.15');
    // IN-19 (b): the source's expiry month (its manufacturing month plus the master's 24 months, less one) is recorded with
    // the addition, and caps the receiving batch's expiry.
    const expiry = await sql<string>("select to_char((date_trunc('month', (issued_at at time zone kernel.site_zone())::date) + interval '23 months')::date, 'YYYY-MM') as r from recipe.batch_execution where id = $1", [runs.S.runId]);
    expect((e1['source'] as Json)['expiry']).toBe(expiry);
    expect(await sql<string>("select to_char(recipe.recovered_expiry_cap($1) at time zone 'UTC', 'YYYY-MM-DD') as r", [R.runId])).toBe(`${expiry}-01`);
    expect(await sql<Json[]>('select recipe.batches_receiving_from($1) as r', [runs.S.runId])).toEqual([expect.objectContaining({ batchId: R.runId, quantity: '0.25', unit: 'kg', container: sResidue })]);
    expect(await sql<string>('select recipe.batch_reprocessing_basis($1) as r', [R.runId])).toBe('REPROCESSING_ADDITION');
    // The same authorisation again: the engine sees it at the step, a forged engine is refused by the database.
    const again = await addition(R, 'p-tb08', sResidue, '0.600', '0.500', a1);
    expect(await w.code('operator1', entryCommand('p-tb08', again))).toBe('ENGINE TB08-AUTHORISATION-USED');
    expect(await refusal(w.message('operator1', entryCommand('p-tb08', again), { tamper: tamperHandler('p-tb08', { acceptEntry: () => ({ ok: true, data: honestData(again, 'p-tb08', { net: { value: '0.100', unit: 'kg' } }), verificationRequired: true }) }) })))
      .toBe('EBMR-RPR-031 TB08-AUTHORISATION-USED');
    // A second source batch (T) is the step's limit of 2; the remaining guard holds past every path.
    const a2 = await authorise(R, 'p-tb08', tResidue);
    expect(await refusal(w.message('operator1', entryCommand('p-tb08', await addition(R, 'p-tb08', tResidue, '0.900', '0.500', a2))))).toBe('ok');
    expect((await facts(tResidue, R.runId))?.['remaining']).toBe('0');
    await expect(sbx.db.app.query("insert into recipe.source_addition (batch_id, batch_number, step_key, entry_id, block, container_id, case_code, net_quantity, unit, source_batch_id, source_batch_number, product_code, strength, source_generated_at, source_manufactured_at, added_by_person) select $1, 'X', 'k', 'EN-999', 'TB-08@1', $2, 'RECOVERY', 1, 'kg', $3, 'X', 'P', 'S', now(), now(), gen_random_uuid()", [R.runId, sResidue, runs.S.runId])).rejects.toThrow(/permission denied/);
    await expect(sbx.db.admin.query("insert into recipe.source_addition (batch_id, batch_number, step_key, entry_id, block, container_id, case_code, net_quantity, unit, source_batch_id, source_batch_number, product_code, strength, source_generated_at, source_manufactured_at, added_by_person) select $1, 'X', 'k', 'EN-999', 'TB-08@1', $2, 'RECOVERY', 0.5, 'kg', $3, 'X', 'P', 'S', now(), now(), gen_random_uuid()", [R.runId, sResidue, runs.S.runId])).rejects.toThrow(/EBMR-RPR-040/);
    await expect(sbx.db.admin.query('update recipe.source_addition set net_quantity = 0.01 where batch_id = $1', [R.runId])).rejects.toThrow(/EBMR-AUDIT-004|insert-only/);
    // A reserved container is never charged.
    await expect(as(runs.S, 'operator1', 'select plant.charge_container($1, $2, $3) as r', [runs.S.runId, 'BLENDING', await sql<string>('select label_code as r from plant.output_container where id = $1', [sResidue])])).rejects.toThrow(/EBMR-(RPR-041|TAB-310|CNT-\d{3})/);
    // C-07: performing computes the net added (0.25 + 0.4 kg) into reworkAdded, and QC is flagged to decide on extra testing.
    await R.signed('operator1', { type: 'SIGN_PERFORMED', stepKey: 'p-tb08@' });
    const st = await stateOf(sbx, R.runId);
    const point = Object.values(st.points).find((p) => p['item'] === 'reworkAdded' && p['status'] === 'VALID');
    expect(point?.['value']).toEqual({ kind: 'DECIMAL', value: '0.65', unit: 'kg' });
    expect(Object.values(st.exceptions).some((x) => x['type'] === 'QC_ADDITIONAL_TESTING_DECISION')).toBe(true);
  });

  it('[IN-19][PR-47] chained recovery is blocked: a source batch that itself received recovered material cannot be a source, past a forged engine', async () => {
    const R = runs.R;
    const rResidue = await residue(R);
    expect(await reserve(R, rResidue)).toBe('ok');
    const S = runs.S;
    expect(await writer(sbx, S, advance).code('operator1', startCommand('p-tb08'))).toBe('ok');
    const a = await authorise(S, 'p-tb08', rResidue);
    const e = await addition(S, 'p-tb08', rResidue, '0.600', '0.500', a);
    expect((e['source'] as Json)['containsRecovered']).toBe(true);
    const ws = writer(sbx, S, advance);
    expect(await ws.code('operator1', entryCommand('p-tb08', e))).toBe('ENGINE TB08-CHAINED');
    expect(await refusal(ws.message('operator1', entryCommand('p-tb08', e), { tamper: laxEntry('p-tb08', honestData(e, 'p-tb08', { net: { value: '0.100', unit: 'kg' } }), { verificationRequired: true }) }))).toBe('EBMR-RPR-031 TB08-CHAINED');
  });

  it('[PR-47][IN-19] G-24@2: a recovery step starts only under the quality unit\'s signed authorisation of that step; its addition of QA-released material stands on the database\'s facts and is recorded', async () => {
    const T = runs.T;
    const press = (await cleanUnit(sbx, T.runId)).code;
    const released = await container(T, 'COMPRESSION', '5.000', press);
    await as(T, 'operator1', 'select plant.record_ipc_check($1, $2, $3, $4, $5) as r', [T.runId, press, null, 'FAIL', 'TEST-IPC-1']);
    const version = await sql<string>("select version::text as r from platform.aggregate_state where aggregate_type = 'output_container' and aggregate_id = $1", [released]);
    const p = await prepareSignature(sbx, T.browser('qa1'), 'qa1', 'output_container', released, 'OUTPUT_CONTAINER_RELEASED');
    await withCommand(sbx.db.app, await p.actor(), async (c) => c.query('select plant.release_container($1, $2, $3)', [released, Number(version), await p.sign(c)]));
    const R = runs.R;
    const w = writer(sbx, R, advance);
    // Started without the quality unit's signed authorisation of the step: the engine has nothing to check (G-24@2 takes
    // no start data), the database refuses.
    expect(await refusal(w.message('operator1', startCommand('p-g24')))).toBe('EBMR-RPR-030 G24-NOT-AUTHORISED');
    // Authorised only for one use of a container, not for the step: still refused.
    const use = await authorise(R, 'p-g24', released);
    expect(await refusal(w.message('operator1', startCommand('p-g24')))).toBe('EBMR-RPR-030 G24-NOT-AUTHORISED');
    await authorise(R, 'p-g24', null);
    // Start data is never taken (recipe-core 0345 refuses it on an accepted start).
    expect(await refusal(w.message('operator1', startCommand('p-g24', { authorisation: use }), ))).toBe('ENGINE ENG-ENTRY-SCHEMA');
    expect(await refusal(w.message('operator1', startCommand('p-g24')))).toBe('ok');
    const source = await facts(released, R.runId);
    expect(source).toMatchObject({ case: 'RECOVERY', remaining: '5' });
    const e: Json & { kind: string } = { kind: 'ADDITION', container: released, quantity: { value: '1.000', unit: 'kg' }, authorisation: use, authorisedBy: qa, source };
    expect(await refusal(w.message('operator1', entryCommand('p-g24', e)))).toBe('ok');
    expect((await facts(released, R.runId))?.['remaining']).toBe('4');
    expect(await sql<string>("select block as r from recipe.source_addition where container_id = $1", [released])).toBe('G-24@2');
  });

  it('[PR-47] the release reader reports a batch with reprocessed or recovered material added and no QC decision on additional testing, and nothing once QC has decided; a batch without additions has no reprocessing basis', async () => {
    const R = runs.R;
    expect(await sql<string>('select recipe.batch_reprocessing_basis($1) as r', [R.runId])).toBe('REPROCESSING_ADDITION');
    expect(await sql<string>('select recipe.reprocessing_release_problem($1) as r', [R.runId])).toMatch(/reprocessed material added and QC has recorded no decision on additional testing/);
    expect(await sql<string>('select recipe.reprocessing_release_problem($1) as r', [runs.O.runId])).toBeNull();
    expect(await sql<string>('select recipe.batch_reprocessing_basis($1) as r', [runs.O.runId])).toBeNull();
    // QC's decision (5a's register; arranged here, its command and signature are 5a's tests).
    const number = await sql<string>('select batch_number as r from recipe.batch_execution where id = $1', [R.runId]);
    await asSetup(sbx, "insert into site.qc_extra_testing_decision (batch_id, batch_number, edition, site_code, decision, tests, signature_id, decided_by_person, decided_by_account) values ($1, $2, 'TABLETS', 'SITE-1', 'EXTRA_TESTS', '{ASSAY}', gen_random_uuid(), gen_random_uuid(), gen_random_uuid())", [R.runId, number]);
    expect(await sql<string>('select recipe.reprocessing_release_problem($1) as r', [R.runId])).toBeNull();
    await expect(sbx.db.app.query('select recipe.reprocessing_release_problem($1)', [R.runId])).resolves.toBeDefined();
  });
});
