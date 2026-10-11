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
