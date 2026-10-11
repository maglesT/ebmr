/**
 * The quality unit's reprocessing authorisations, rule by rule (SQL mutation group "reprocessing": recipe-core 0621 and
 * 0624). These tests close the gaps the Phase 3 exit SQL mutation run found: each refusal with its own code where
 * another rule (a primary key, the kernel's one-signature rule, an unknown scope) would otherwise stand in for it. An
 * authorisation of a step is asked only for a batch still in execution, for a G-24 or TB-08 step that declares its
 * case, names a container only where the case adds material and only a closed container of an earlier batch, and cites
 * its investigation and risk evaluation; it and a whole-batch request are signed once, by the person who records the
 * signature, never under a signature of another person.
 *
 * The batches are arranged as fixtures by the superuser with triggers off; every rule under test runs as the
 * application role.
 *
 * Controls: PR-47, IN-18, IN-19; invariant INV-33.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, signerActor, type TestDatabase } from '../helpers.ts';
import { QualityWorld, refusal, seedQualityCast, unique, type GmpBatch } from '../quality/support.ts';
import type { SeededActor } from '../../../kernel/test/identity/seed.ts';

let db: TestDatabase;
let w: QualityWorld;
let issuer: SeededActor;
let qcu: SeededActor;
let qcu2: SeededActor;
const PRODUCT = `RM${randomUUID().slice(0, 6).toUpperCase()}`;
const STRENGTH = '500 mg';

const phase = (id: string, type: string, version: string, kase?: string) => ({
  kind: 'phase', id, name: id, block: { type, version }, config: {}, ...(kase ? { reprocessing: { case: kase } } : {}),
});
const CONTENT = {
  header: { product: { code: PRODUCT, strength: STRENGTH } },
  procedure: {
    kind: 'sequence', id: 'ops', children: [
      phase('rec', 'G-24', '2', 'RECOVERY'),
      phase('add', 'TB-08', '1', 'REPROCESSING_ADDITION'),
      phase('whole', 'G-24', '1', 'WHOLE_BATCH_REPROCESSING'),
      phase('valid', 'G-24', '2', 'VALIDATED_RETREATMENT'),
      phase('plain', 'G-24', '2'),
      phase('other', 'G-20', '1', 'RECOVERY'),
      phase('old', 'G-24', '3', 'RECOVERY'),
    ],
  },
};

/** A GMP batch running CONTENT in `status`, issued as a fixture. */
async function batch(status = 'IN_PROGRESS'): Promise<GmpBatch> {
  const b = await w.gmpBatch('SITE-1', PRODUCT, STRENGTH);
  const cr = randomUUID();
  await w.fixture(
    `insert into recipe.control_recipe (id, batch_id, pin_id, version_id, mbr_content_hash, snapshot, snapshot_hash, person_id, account_id)
     values ($1, $2, gen_random_uuid(), gen_random_uuid(), repeat('a', 64), $3::jsonb, repeat('b', 64), gen_random_uuid(), gen_random_uuid())`,
    [cr, b.id, JSON.stringify({ mbr: { content: CONTENT } })],
  );
  await w.fixture(
    `insert into recipe.batch_execution (id, batch_number, content_hash, installation, purpose, engine_version, registry_fingerprint, policy, policy_hash, issue_request,
                                         market_set, batch_size, site_code, site_zone, issued_at_us, issued_by_person, issued_by_account, correlation_id,
                                         control_recipe_id, issue_signature_id)
     values ($1, $2, repeat('a', 64), 'GMP', 'GMP_BATCH', '1', repeat('c', 64), '{}', repeat('d', 64), '{}', '{IN}', 'BS-1', 'SITE-1', 'Asia/Kolkata', 0,
             gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), $3, gen_random_uuid())`,
    [b.id, b.number, cr],
  );
  await w.fixture(
    "insert into recipe.execution_state (batch_id, state, state_version, state_hash, last_seq, last_row_hash, status) values ($1, '{}', 1, repeat('e', 64), 1, 'x', $2)",
    [b.id, status],
  );
  return b;
}

/** An output container of batch `b`, closed unless `open`. */
async function container(b: GmpBatch, open = false): Promise<string> {
  const id = randomUUID();
  await w.fixture(
    `insert into plant.output_container (id, label_code, batch_id, batch_number, product_code, strength, stage, quantity_unit, opened_by_person, opened_by_account)
     values ($1, $2, $3, $4, $5, $6, 'INSPECTION', 'kg', gen_random_uuid(), gen_random_uuid())`,
    [id, `OC-${b.number.replace(/[^A-Za-z0-9]/g, '')}-${String(Math.floor(Math.random() * 1e6)).padStart(6, '0')}`, b.id, b.number, PRODUCT, STRENGTH],
  );
  if (!open) await w.fixture("insert into plant.container_close (container_id, net_quantity, person_id, account_id) values ($1, '0.4', gen_random_uuid(), gen_random_uuid())", [id]);
  return id;
}

const propose = (b: string, step: string, c: string | null = null, inv = 'INV-1', risk = 'RA-1', by: SeededActor = qcu): Promise<string> =>
  refusal(w.sql(by, 'select recipe.propose_reprocessing_authorisation($1, $2, $3, $4, $5) as r', [b, step, c, inv, risk]));

beforeAll(async () => {
  db = await createTestDatabase();
  w = new QualityWorld(db, await seedQualityCast(db));
  issuer = await signerActor(db, 'BATCH_ISSUER');
  qcu = await signerActor(db, 'AUTHORISED_PERSON');
  qcu2 = await signerActor(db, 'AUTHORISED_PERSON');
}, 300_000);
afterAll(async () => {
  await db.drop();
});

describe('a reprocessing authorisation of a step (recipe-core 0621)', () => {
  it('[PR-47] asked only for a batch that exists and is still in execution', async () => {
    expect(await propose(randomUUID(), 'rec')).toMatch(/Batch .* does not exist .*\[EBMR-RPR-020\]/);
    for (const s of ['EXECUTION_COMPLETE', 'ABORTED']) {
      expect(await propose((await batch(s)).id, 'rec')).toMatch(/authorised before it is carried out, on a batch still in execution .*\[EBMR-RPR-020\]/);
    }
    for (const s of ['ISSUED', 'IN_PROGRESS', 'ON_HOLD']) expect(await propose((await batch(s)).id, 'rec')).toBe('');
  });

  it('[PR-47][IN-19] only for a G-24 or TB-08 step that declares a case other than a validated retreatment', async () => {
    const b = (await batch()).id;
    expect(await propose(b, 'add')).toBe('');
    expect(await propose(b, 'whole')).toBe('');
    for (const step of ['valid', 'plain', 'other', 'old', 'nowhere', 'ops']) {
      expect(await propose(b, step)).toMatch(/is no reprocessing or recovery step of the batch's MBR .*\[EBMR-RPR-020\]/);
    }
  });

  it('[PR-47][IN-19] a container only where the case adds material, and only a closed container of an earlier batch; the investigation and risk evaluation cited', async () => {
    const earlier = await batch('EXECUTION_COMPLETE');
    const b = await batch();
    const closed = await container(earlier);
    expect(await propose(b.id, 'whole', closed)).toMatch(/adds no material: its authorisation names no container .*\[EBMR-RPR-020\]/);
    expect(await propose(b.id, 'rec', closed)).toBe('');
    expect(await propose(b.id, 'add', closed)).toBe('');
    const adHoc = /Only a closed output container of an earlier batch record is a source.*\[EBMR-RPR-020\]/;
    expect(await propose(b.id, 'rec', randomUUID())).toMatch(adHoc);
    expect(await propose(b.id, 'rec', await container(earlier, true))).toMatch(adHoc);
    expect(await propose(b.id, 'rec', await container(b))).toMatch(adHoc);
    const cites = /cites the investigation and the risk evaluation .*\[EBMR-RPR-020\]/;
    expect(await propose(b.id, 'rec', null, '  ', 'RA-1')).toMatch(cites);
    expect(await propose(b.id, 'rec', null, 'INV-1', '')).toMatch(cites);
  });

  it('[PR-47] signed once, by the person who records it; an unknown authorisation is refused as unknown', async () => {
    const b = (await batch()).id;
    const { id } = await w.sql<{ id: string }>(qcu, 'select recipe.propose_reprocessing_authorisation($1, $2, null, $3, $4) as r', [b, 'rec', 'INV-1', 'RA-1']);
    const sign = (by: SeededActor) => w.sign(by, { type: 'reprocessing_authorisation', id }, 'REPROCESSING_AUTHORISED', 'PROPOSED');
    const record = (sig: string, by: SeededActor = qcu) => refusal(w.sql(by, 'select recipe.authorise_reprocessing($1, $2) as r', [id, sig]));
    expect(await refusal(w.sql(qcu, 'select recipe.authorise_reprocessing($1, $2) as r', [randomUUID(), randomUUID()]))).toMatch(/There is no reprocessing authorisation .*\[EBMR-RPR-021\]/);
    // Another person's signature, recorded by qcu.
    const other = await sign(qcu2);
    expect(await record(other)).toMatch(/the signer is the person who records it .*\[EBMR-RPR-021\]/);
    expect(await record(await sign(qcu))).toBe('');
    // Signed already: qcu2's signature, recorded by qcu2, is refused by the rule (not by the key of the register).
    expect(await record(other, qcu2)).toMatch(/This reprocessing authorisation is already signed .*\[EBMR-RPR-021\]/);
  });
});

describe('a whole-batch reprocessing request (recipe-core 0624)', () => {
  let family: string;
  beforeAll(async () => {
    family = randomUUID();
    await w.fixture(
      `insert into recipe.mbr_family (id, code, title, edition, record_kind, product_code, product_name, strength, dosage_form, batch_sizes, created_by_person, created_by_account)
       values ($1, $2, 'Reprocessing master', 'tablets', 'REPROCESSING', $3, 'Paracetamol tablets', $4, 'Coated tablet', '[{"id": "BS-1", "quantity": {"value": "100", "unit": "kg"}}]', gen_random_uuid(), gen_random_uuid())`,
      [family, unique('FAM-'), PRODUCT, STRENGTH],
    );
  });
  const request = (parents: string[] | null, inv: string | null, risk: string | null) =>
    w.sql<{ id: string }>(issuer, 'select recipe.propose_reprocessing_request($1, $2, $3::uuid[], $4, $5) as r', [family, 'SITE-1', parents, inv, risk]);

  it('[PR-47][IN-18] a request names its parents, its investigation and its stored risk evaluation', async () => {
    const p = (await batch('EXECUTION_COMPLETE')).id;
    const names = /names its parent batches, the investigation and the stored risk evaluation .*\[EBMR-RPR-050\]/;
    expect(await refusal(request([], 'DEV-1', randomUUID()))).toMatch(names);
    expect(await refusal(request(null, 'DEV-1', randomUUID()))).toMatch(names);
    expect(await refusal(request([p], ' ', randomUUID()))).toMatch(names);
    expect(await refusal(request([p], null, randomUUID()))).toMatch(names);
    expect(await refusal(request([p], 'DEV-1', null))).toMatch(names);
    expect(await refusal(request([p], 'DEV-1', randomUUID()))).toBe('');
  });

  it('[PR-47][IN-18] authorised once, by the person who records it; an unknown request is refused as unknown', async () => {
    const p = (await batch('EXECUTION_COMPLETE')).id;
    const { id } = await request([p], 'DEV-1', randomUUID());
    const sign = (by: SeededActor) => w.sign(by, { type: 'reprocessing_request', id }, 'REPROCESSING_AUTHORISED', 'PROPOSED');
    const record = (sig: string, by: SeededActor = qcu) => refusal(w.sql(by, 'select recipe.authorise_reprocessing_request($1, $2) as r', [id, sig]));
    expect(await refusal(w.sql(qcu, 'select recipe.authorise_reprocessing_request($1, $2) as r', [randomUUID(), randomUUID()]))).toMatch(/There is no reprocessing request .*\[EBMR-RPR-051\]/);
    const other = await sign(qcu2);
    expect(await record(other)).toMatch(/records its own authorisation .*\[EBMR-RPR-051\]/);
    expect(await record(await sign(qcu))).toBe('');
    expect(await record(other, qcu2)).toMatch(/This reprocessing request is already authorised .*\[EBMR-RPR-051\]/);
  });

  it('[PR-47][IN-18] a reprocessing batch is planned only with its master and the request named as identifiers', async () => {
    const plan = (def: object) => refusal(w.sql(issuer, 'select recipe.prepare_reprocessing_issue($1, $2::jsonb) as r', [randomUUID(), JSON.stringify(def)]));
    const base = { familyId: family, markets: ['IN'], site: 'SITE-1', line: 'LINE-1', batchSize: 'BS-1' };
    const named = /planned on its master with the authorised request .*\[EBMR-RPR-052\]/;
    expect(await plan(base)).toMatch(named);
    expect(await plan({ ...base, reprocessingRequest: 'REQ-1' })).toMatch(named);
    expect(await plan({ ...base, familyId: 'FAM-1', reprocessingRequest: randomUUID() })).toMatch(named);
    expect(await plan({ ...base, familyId: undefined, reprocessingRequest: randomUUID() })).toMatch(named);
    // Both named: the request's own checks answer (an unknown request).
    expect(await plan({ ...base, reprocessingRequest: randomUUID() })).toMatch(/\[EBMR-RPR-052\]/);
    expect(await plan({ ...base, reprocessingRequest: randomUUID() })).not.toMatch(named);
  });
});

describe('the limits of a reprocessing or recovery addition (recipe-core 0622, recipe.addition_problem)', () => {
  type Json = Record<string, unknown>;
  const DAY_US = 86_400_000_000n;
  const LIMITS = { case: 'REPROCESSING_ADDITION', maxAge: { value: '30', unit: 'd' }, maxSourceBatches: 1, maxPercent: '1' };
  const contentWith = (rp: Json = {}, size: Json = { value: '100', unit: 'kg' }): Json => ({
    header: { product: { code: PRODUCT, strength: STRENGTH }, batchSizes: [{ id: 'BS-1', quantity: size }] },
    procedure: {
      kind: 'sequence', id: 'ops', children: [
        { ...phase('add', 'TB-08', '1'), reprocessing: { ...LIMITS, ...rp } },
        { ...phase('addr', 'G-24', '2'), reprocessing: { ...LIMITS, case: 'RECOVERY' } },
      ],
    },
  });
  let R: GmpBatch;
  let A: GmpBatch;
  let S1: string;
  let facts: Json;
  let generated: bigint;
  const signer = randomUUID();
  const op = randomUUID();
  const auths: Record<string, string> = {};

  /** A closed container of `b`, CLOSED in its state machine, reserved as residue. */
  async function source(b: GmpBatch, strength = STRENGTH): Promise<string> {
    const id = await container(b);
    if (strength !== STRENGTH) await w.fixture('update plant.output_container set strength = $2 where id = $1', [id, strength]);
    await w.fixture("insert into platform.aggregate_state (aggregate_type, aggregate_id, machine_code, machine_version, state, version) values ('output_container', $1, 'X', 1, 'CLOSED', 1)", [id]);
    await w.fixture('insert into recipe.residue_reservation (container_id, signature_id, reserved_by_person, reserved_by_account, correlation_id) values ($1, gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid())', [id]);
    return id;
  }
  /** An authorisation of batch, step, container (a USE; a STEP when null) and case, signed by `signer` unless not `signed`. */
  async function authorisation(batchId: string, step: string, c: string | null, kase: string, signed = true): Promise<string> {
    const id = randomUUID();
    await w.fixture(
      `insert into recipe.reprocessing_authorisation (id, batch_id, step_id, scope, container_id, case_code, investigation_ref, risk_evaluation_ref, proposed_by_person, proposed_by_account, correlation_id)
       values ($1, $2, $3, $4, $5, $6, 'INV-1', 'RA-1', gen_random_uuid(), gen_random_uuid(), gen_random_uuid())`,
      [id, batchId, step, c ? 'USE' : 'STEP', c, kase],
    );
    if (signed) await w.fixture('insert into recipe.reprocessing_authorisation_signature (authorisation_id, signature_id, signer_person, recorded_by_account) values ($1, gen_random_uuid(), $2, gen_random_uuid())', [id, signer]);
    return id;
  }
  const factsOf = async (c: string): Promise<Json> => (await db.admin.query<{ r: Json }>('select recipe.source_container_facts($1, $2) as r', [c, R.id])).rows[0]?.r ?? {};

  beforeAll(async () => {
    R = await batch();
    A = await batch('EXECUTION_COMPLETE');
    S1 = await source(A);
    facts = await factsOf(S1);
    generated = BigInt(String(facts['generatedAtUs']));
    const other = await batch('EXECUTION_COMPLETE');
    auths['ok'] = await authorisation(R.id, 'add', S1, 'REPROCESSING_ADDITION');
    auths['unsigned'] = await authorisation(R.id, 'add', S1, 'REPROCESSING_ADDITION', false);
    auths['batch'] = await authorisation(other.id, 'add', S1, 'REPROCESSING_ADDITION');
    auths['step'] = await authorisation(R.id, 'addr', S1, 'REPROCESSING_ADDITION');
    auths['container'] = await authorisation(R.id, 'add', await source(A), 'REPROCESSING_ADDITION');
    auths['case'] = await authorisation(R.id, 'add', S1, 'RECOVERY');
    auths['scope'] = await authorisation(R.id, 'add', null, 'REPROCESSING_ADDITION');
  });

  type Case = { content?: Json; others?: Record<string, Json>; now?: bigint | null; net?: string | null; ageFrom?: string; required?: boolean; c?: Json; entryNet?: Json; facts?: Json };
  /** The problem of addition EN-9 (of S1 unless other facts are given) at step add@ of R; NULL when none. */
  async function problem(k: Case = {}): Promise<string | null> {
    const src = k.facts ?? facts;
    const c = { container: src['container'], source: src, ...k.c };
    const e = { stepKey: 'add@', kind: 'ADDITION', enteredBy: op, data: { ...c, net: k.entryNet ?? { value: '0.4', unit: 'kg' } } };
    const now = k.now === undefined ? generated + DAY_US : k.now;
    const state = { steps: { 'add@': { step: 'add' }, 'addr@': { step: 'addr' } }, entries: { ...k.others, 'EN-9': e }, ...(now === null ? {} : { lastRecordedUs: { $u: now.toString() } }) };
    const { rows } = await db.admin.query<{ r: string | null }>(
      'select recipe.addition_problem($1, $2::jsonb, $3::jsonb, $4, $5::jsonb, $6::jsonb, $7::numeric, $8, $9, $10, $11) as r',
      [R.id, JSON.stringify(k.content ?? contentWith()), JSON.stringify(state), 'EN-9', JSON.stringify(e), JSON.stringify(c), k.net === undefined ? '0.4' : k.net, 'kg', k.ageFrom ?? 'GENERATION', k.required ?? false, 'TB08'],
    );
    return rows[0]?.r ?? null;
  }
  const entry = (stepKey: string, kind: string, batchId: string, net?: Json, auth?: string): Json => ({
    stepKey, kind, data: { source: { sourceBatchId: batchId }, ...(net ? { net } : {}), ...(auth ? { authorisation: auth } : {}) },
  });

  it('[PR-47][IN-19] material of another strength of the product is refused', async () => {
    expect(await problem()).toBeNull();
    expect(await problem({ facts: await factsOf(await source(A, '650 mg')) })).toMatch(/TB08-OTHER-PRODUCT/);
  });

  it('[PR-47][IN-19] the age: counted from generation or manufacture as the block says, the MBR maximum included, no maximum or no row time refused', async () => {
    const max = 30n * DAY_US;
    expect(await problem({ now: generated + max })).toBeNull();
    expect(await problem({ now: generated + max + 1n })).toMatch(/TB08-TOO-OLD/);
    // The source batch was issued at the epoch (fixture): counted from manufacture it is far too old.
    expect(await problem({ ageFrom: 'MANUFACTURE' })).toMatch(/TB08-TOO-OLD/);
    expect(await problem({ content: contentWith({ maxAge: null }) })).toMatch(/TB08-TOO-OLD/);
    expect(await problem({ now: null })).toMatch(/TB08-TOO-OLD/);
  });

  it('[PR-47][IN-19] the source batches counted are the additions of this step only; the MBR maximum is a number', async () => {
    const B1 = randomUUID();
    const B2 = randomUUID();
    const others = {
      'EN-1': entry('addr@', 'ADDITION', B1), 'EN-2': entry('addr@', 'ADDITION', B2),
      'EN-3': entry('add@', 'NOTE', B1), 'EN-4': entry('add@', 'NOTE', B2),
    };
    expect(await problem({ others })).toBeNull();
    expect(await problem({ others: { ...others, 'EN-5': entry('add@', 'ADDITION', B1) } })).toMatch(/TB08-TOO-MANY-SOURCES/);
    expect(await problem({ content: contentWith({ maxSourceBatches: '2' }) })).toMatch(/TB08-TOO-MANY-SOURCES/);
  });

  it('[PR-47][INV-33] the net: positive and at most what the container still holds', async () => {
    expect(await problem({ net: '0.4' })).toBeNull();
    expect(await problem({ net: '0.41' })).toMatch(/TB08-OVER-REMAINING/);
    expect(await problem({ net: '0' })).toMatch(/TB08-OVER-REMAINING/);
    expect(await problem({ net: null })).toMatch(/TB08-OVER-REMAINING/);
  });

  it('[PR-47][IN-19] the total added at the step against the MBR percentage of the batch size: the limit included, g and kg converted, other steps not counted', async () => {
    // 1 % of 100 kg is 1 kg: 0.4 kg here, 600 g at this step from the same source batch, 5 kg at another step.
    const at = (net: Json): Record<string, Json> => ({ 'EN-1': entry('add@', 'ADDITION', A.id, net), 'EN-2': entry('addr@', 'ADDITION', A.id, { value: '5', unit: 'kg' }) });
    expect(await problem({ others: at({ value: '600', unit: 'g' }) })).toBeNull();
    expect(await problem({ others: at({ value: '600.1', unit: 'g' }) })).toMatch(/TB08-TOO-MUCH/);
    expect(await problem({ others: at({ value: '0.6001', unit: 'kg' }) })).toMatch(/TB08-TOO-MUCH/);
    // A batch size in g: 1 % of 100000 g is 1000 g; the kg entries convert to g.
    const inG = contentWith({}, { value: '100000', unit: 'g' });
    expect(await problem({ content: inG, others: at({ value: '0.6', unit: 'kg' }) })).toBeNull();
    expect(await problem({ content: inG, others: at({ value: '0.61', unit: 'kg' }) })).toMatch(/TB08-TOO-MUCH/);
    // A unit that does not convert, or a percentage that is no decimal string.
    expect(await problem({ entryNet: { value: '0.4', unit: 'units' } })).toMatch(/TB08-TOO-MUCH/);
    expect(await problem({ content: contentWith({ maxPercent: 1 }) })).toMatch(/TB08-TOO-MUCH/);
  });

  it('[PR-47][IN-19] the authorisation: signed, of this batch, use, step, container and case; used once', async () => {
    const under = (key: string, others?: Record<string, Json>) => problem({ required: true, c: { authorisation: auths[key], authorisedBy: signer }, ...(others ? { others } : {}) });
    expect(await under('ok')).toBeNull();
    for (const key of ['unsigned', 'batch', 'step', 'container', 'case', 'scope']) expect(await under(key)).toMatch(/no signed authorisation of this use .*TB08-NOT-AUTHORISED/);
    expect(await under('ok', { 'EN-1': entry('add@', 'ADDITION', A.id, { value: '0.1', unit: 'kg' }, auths['ok']) })).toMatch(/TB08-AUTHORISATION-USED/);
  });

  it('[PR-47] a recovery step starts on a signed STEP authorisation of this batch, step and case, by another person than its signer, once per authorisation', async () => {
    const c = await db.admin.connect();
    try {
      await c.query('begin');
      await c.query("set local session_replication_role = 'replica'");
      const take = async (b: string, starter: string, key = 'rec@1'): Promise<string | null> =>
        (await c.query<{ r: string | null }>("select recipe.reprocessing_start_take($1, 'rec', 'RECOVERY', $2, $3) as r", [b, starter, key])).rows[0]?.r ?? null;
      const starter = randomUUID();
      // Authorisations that are not this one: unsigned, of another batch, step, case or scope.
      const B = (await batch()).id;
      await authorisation(B, 'rec', null, 'RECOVERY', false);
      await authorisation(R.id, 'rec', null, 'RECOVERY');
      await authorisation(B, 'addr', null, 'RECOVERY');
      await authorisation(B, 'rec', null, 'REPROCESSING_ADDITION');
      await authorisation(B, 'rec', S1, 'RECOVERY');
      expect(await take(B, starter)).toMatch(/without the quality unit's signed authorisation .*G24-NOT-AUTHORISED/);
      // Signed by the starter only.
      const S = (await batch()).id;
      const own = await authorisation(S, 'rec', null, 'RECOVERY');
      await c.query('update recipe.reprocessing_authorisation_signature set signer_person = $2 where authorisation_id = $1', [own, starter]);
      expect(await take(S, starter)).toMatch(/authorised only by the person who starts it .*G24-SELF-AUTHORISED/);
      // Two signed authorisations: two starts, each taking its own; a third is refused.
      const T = (await batch()).id;
      const a1 = await authorisation(T, 'rec', null, 'RECOVERY');
      const a2 = await authorisation(T, 'rec', null, 'RECOVERY');
      expect(await take(T, starter, 'rec@1')).toBeNull();
      expect(await take(T, starter, 'rec@2')).toBeNull();
      expect((await c.query<{ a: string }>('select authorisation_id::text as a from recipe.reprocessing_step_start where batch_id = $1 order by step_key', [T])).rows.map((r) => r.a).sort()).toEqual([a1, a2].sort());
      expect(await take(T, starter, 'rec@3')).toMatch(/each signed authorisation of the step allows one start, and every one was used .*G24-AUTHORISATION-USED/);
      // The starter's own authorisation is never the one taken.
      const U = (await batch()).id;
      const mine = await authorisation(U, 'rec', null, 'RECOVERY');
      await c.query('update recipe.reprocessing_authorisation_signature set signer_person = $2 where authorisation_id = $1', [mine, starter]);
      const theirs = await authorisation(U, 'rec', null, 'RECOVERY');
      expect(await take(U, starter)).toBeNull();
      expect((await c.query<{ a: string }>('select authorisation_id::text as a from recipe.reprocessing_step_start where batch_id = $1', [U])).rows.map((r) => r.a)).toEqual([theirs]);
      expect(await take(U, starter, 'rec@2')).toMatch(/G24-AUTHORISATION-USED/);
    } finally {
      await c.query('rollback');
      c.release();
    }
  });
});

describe('the checks of a whole-batch request at planning (recipe-core 0625, recipe.reprocessing_request_problem)', () => {
  let family: string;
  beforeAll(async () => {
    family = randomUUID();
    await w.fixture(
      `insert into recipe.mbr_family (id, code, title, edition, record_kind, product_code, product_name, strength, dosage_form, batch_sizes, created_by_person, created_by_account)
       values ($1, $2, 'Reprocessing master', 'tablets', 'REPROCESSING', $3, 'Paracetamol tablets', $4, 'Uncoated tablet', '[{"id": "BS-1", "quantity": {"value": "100", "unit": "kg"}}]', gen_random_uuid(), gen_random_uuid())`,
      [family, unique('FAM-'), PRODUCT, STRENGTH],
    );
    // The product master permits reprocessing, in effect (arranged as site services 0802 reads it).
    await w.fixture(
      `with p as (insert into site.erp_product (product_code, strength, product_name, reprocessing_permitted, beta_lactam, shelf_life_months, erp_reference, received_by_person, received_by_account, correlation_id)
                  values ($1, $2, 'Paracetamol tablets', true, false, 24, $3, gen_random_uuid(), gen_random_uuid(), gen_random_uuid()) returning id, product_code, strength)
       insert into site.erp_master_effect (master_kind, master_key, version_id, basis, person_id, account_id)
       select 'PRODUCT', p.product_code || '|' || p.strength, p.id, 'RELEASE_BASELINE', gen_random_uuid(), gen_random_uuid() from p`,
      [PRODUCT, STRENGTH, unique('ERP-')],
    );
  });
  /** A request for `parents` at SITE-1, signed by the QCU (fixtures). */
  async function signedRequest(parents: string[]): Promise<string> {
    const id = randomUUID();
    await w.fixture(
      `insert into recipe.reprocessing_request (id, family_id, site_code, parent_batch_ids, investigation_ref, risk_evaluation_id, proposed_by_person, proposed_by_account, correlation_id)
       values ($1, $2, 'SITE-1', $3::uuid[], 'DEV-1', gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid())`,
      [id, family, parents],
    );
    await w.fixture('insert into recipe.reprocessing_request_signature (request_id, signature_id, signer_person, recorded_by_account) values ($1, gen_random_uuid(), gen_random_uuid(), gen_random_uuid())', [id]);
    return id;
  }
  const problem = async (req: string, fam = family, site = 'SITE-1'): Promise<string | null> =>
    (await db.admin.query<{ r: string | null }>('select recipe.reprocessing_request_problem($1, $2, $3, gen_random_uuid()) as r', [req, fam, site])).rows[0]?.r ?? null;

  it('[PR-47][IN-18] the request is for this master and this site', async () => {
    const req = await signedRequest([(await batch('EXECUTION_COMPLETE')).id]);
    // Past these checks, the investigation is what answers (DEV-1 is no deviation).
    expect(await problem(req)).toMatch(/the investigation DEV-1 does not stand for parent/);
    expect(await problem(req, randomUUID())).toBe('the request is for another reprocessing master or site');
    expect(await problem(req, family, 'SITE-2')).toBe('the request is for another reprocessing master or site');
  });

  it('[INV-33][IN-18] each parent is an issued GMP batch of the product and strength, at the site', async () => {
    expect(await problem(await signedRequest([randomUUID()]))).toMatch(/^parent .* is no issued GMP batch$/);
    const strength = await batch('EXECUTION_COMPLETE');
    await w.fixture(
      "update recipe.control_recipe set snapshot = jsonb_set(snapshot, '{mbr,content,header,product,strength}', '\"650 mg\"') where batch_id = $1",
      [strength.id],
    );
    expect(await problem(await signedRequest([strength.id]))).toMatch(/^parent .* is not of .* at site SITE-1$/);
    const elsewhere = await batch('EXECUTION_COMPLETE');
    await w.fixture("update recipe.stub_batch set site = 'SITE-2' where id = $1", [elsewhere.id]);
    expect(await problem(await signedRequest([elsewhere.id]))).toMatch(/^parent .* is not of .* at site SITE-1$/);
  });
});
