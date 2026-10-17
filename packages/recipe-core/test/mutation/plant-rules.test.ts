/**
 * Kill tests of the SQL mutation group "plant-rules" on the recipe-core side (recipe-core 0973, 0974; Phase 6 exit,
 * decision 0019):
 * - the clean hold of a room (PR-25): a room with a clean hold that was never cleaned is refused; another batch's
 *   occupancy of the room does not lend its start to this batch, so an expired hold refuses this batch's start;
 * - a product made beta-lactam by its MBR's predicate alone (neither classified nor flagged by the ERP) is beta-lactam,
 *   and its batch does not start in a room of a non-penicillin site (PR-27); a predicate of false is not;
 * - a GMP-critical alarm bound to the step blocks the step's signature even when the command names a room without
 *   alarms of its own (DI-49).
 */
import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asTimeTraveller } from '../../../kernel/test/esig/helpers.ts';
import { envelopeFor, nowUs, receive, registerAdapter, type TestAdapter } from '../../../kernel/test/integrations/support.ts';
import { createTestDatabase, type TestDatabase } from '../../../kernel/test/support/db.ts';
import { PlantWorld, seedPlantCast, tag } from '../plant/support.ts';
import { batchWithSteps, occupy, occupyBatch, stepProblem } from '../plant-rules/support.ts';

let db: TestDatabase;
let w: PlantWorld;
let ems: TestAdapter;

beforeAll(async () => {
  db = await createTestDatabase();
  w = new PlantWorld(db, await seedPlantCast(db));
  ems = await registerAdapter(db, 'EMS');
}, 300_000);
afterAll(async () => {
  await db.drop();
});

const areaRule = (code: string, holdSeconds: number | null) =>
  w.run(w.cast.steward, (c) => c.query('select plant.set_area_rule($1, false, $2, $3)', [code, holdSeconds, 'site rule for the kill test']));
const roomStart = async (areaId: string, batch: string, later: string) =>
  (await db.app.query<{ p: string | null }>('select plant.room_start_problem($1, $2, clock_timestamp() + $3::interval) as p', [areaId, batch, later])).rows[0]?.p ?? null;

/** A sandbox batch of `product` whose MBR header carries the predicates given (step p-1). */
async function batchWithPredicates(product: string, predicates: Record<string, unknown> | null): Promise<string> {
  const id = randomUUID();
  const hash = createHash('sha256').update(id).digest('hex');
  const productRef = { code: product, name: `Product ${product}`, strength: '10 mg' };
  const content = {
    header: { product: productRef, ...(predicates ? { predicates } : {}) },
    procedure: { kind: 'procedure', id: 'proc', body: { kind: 'stage', id: 'S-1', body: { kind: 'sequence', children: [{ kind: 'phase', id: 'p-1' }] } } },
  };
  await asTimeTraveller(
    db,
    `insert into recipe.test_package (package_hash, file_name, package, content, content_hash, family_id, family_code, product, version_id, version_number,
                                      revision, version_state, exporter, exported_at_us, source, imported_by_person, imported_by_account, correlation_id)
     values ($1, $1 || '.json', '{}', $3::jsonb, $1, gen_random_uuid(), 'FAM', $2::jsonb, gen_random_uuid(), '1', 1, 'APPROVED', '{}', 0, '{}',
             gen_random_uuid(), gen_random_uuid(), gen_random_uuid())`,
    [hash, JSON.stringify(productRef), JSON.stringify(content)],
  );
  await asTimeTraveller(
    db,
    `insert into recipe.batch_execution (id, batch_number, package_hash, content_hash, installation, purpose, engine_version, registry_fingerprint, policy,
                                         policy_hash, issue_request, market_set, batch_size, site_code, site_zone, issued_at_us, issued_by_person,
                                         issued_by_account, correlation_id)
     values ($1, $2, $3, $3, 'SANDBOX', 'SANDBOX_TEST_RUN', '1', $3, '{}', $3, '{}', '{IN}', 'BS', 'SITE-1', 'Asia/Kolkata', 0, gen_random_uuid(),
             gen_random_uuid(), gen_random_uuid())`,
    [id, `TEST-BL-${tag()}`, hash],
  );
  return id;
}

describe('the clean hold of a room (PR-25)', () => {
  it('[PR-25] a room with a clean hold that was never cleaned is refused', async () => {
    const room = await w.room();
    await areaRule(room.code, 60);
    const batch = await batchWithSteps(db, await w.product(), ['p-1']);
    expect(await roomStart(room.id, batch, '0 seconds')).toMatch(/^EBMR-PLANT-150 .* it has no verified cleaning, clean-hold time 00:01:00/);
  });

  it('[PR-25] another batch\'s occupancy of the room does not carry this batch past an expired clean hold', async () => {
    const room = await w.room();
    const product = await w.product();
    await areaRule(room.code, 60);
    // Cleaned, cleared and occupied by another batch: that batch works on the cleaning that preceded its start.
    await occupy(w, room.code, `OTH-${tag()}`, product);
    const batch = await batchWithSteps(db, product, ['p-1']);
    // Within the hold this batch may start; an hour on, without an occupancy of its own, the hold has expired for it.
    expect(await roomStart(room.id, batch, '0 seconds')).toBeNull();
    expect(await roomStart(room.id, batch, '1 hour')).toMatch(/^EBMR-PLANT-150 .* overdue for cleaning: last cleaning verified at /);
  });
});

describe('a beta-lactam product by its MBR predicate (PR-27)', () => {
  it('[PR-27] the MBR\'s betaLactam predicate alone makes the batch beta-lactam and its start in a non-penicillin site is refused; a predicate of false does not', async () => {
    const product = await w.product();
    const beta = await batchWithPredicates(product, { betaLactam: true });
    const notBeta = await batchWithPredicates(await w.product(), { betaLactam: false });
    const none = await batchWithPredicates(await w.product(), null);
    const isBeta = async (b: string) => (await db.app.query<{ r: boolean }>('select plant.batch_beta_lactam($1) as r', [b])).rows[0]?.r;
    expect([await isBeta(beta), await isBeta(notBeta), await isBeta(none)]).toEqual([true, false, false]);
    // SITE-1 has no facility rule, so it is not a penicillin facility: the batch does not start in its room.
    await expect(occupyBatch(w, (await w.room()).code, beta)).rejects.toThrow(new RegExp(`EBMR-PLANT-170 product ${product} is beta-lactam`));
    expect(await occupyBatch(w, (await w.room()).code, notBeta)).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('a step alarm at the step signature (DI-49)', () => {
  it('[DI-49] a GMP-critical alarm bound to the step blocks its signature even when the command names a room without alarms', async () => {
    const room = await w.room();
    const quiet = await w.room();
    const batch = await batchWithSteps(db, await w.product(), ['p-1']);
    await occupyBatch(w, room.code, batch);
    const code = `TEMP_HIGH_${tag()}`;
    const raised = await receive(db, ems, 'plant.receive_equipment_alarm', envelopeFor(ems, 'ems.alarm', {
      subjectKind: 'AREA', subjectCode: room.code, occurrenceId: `occ-${tag()}`, transition: 'RAISED', alarmCode: code, severity: '800', tag: 'room.t_c',
      value: { value: '27.0', unit: 'C' }, limit: { value: '25.0', unit: 'C' }, limitKind: 'HIGH', message: 'Room temperature high', occurredAt: nowUs(),
    }));
    // Arranged: the alarm is bound to step p-1 of the batch (as an alarm of the step's equipment is).
    await asTimeTraveller(db, "update plant.alarm_batch set step = 'p-1' where alarm_id = $1 and batch_id = $2", [raised['alarmId'], batch]);
    const blocked = new RegExp(`^EBMR-ALM-020 DI-49: GMP-critical alarm\\(s\\) await acknowledgment: ${code}`);
    expect(await stepProblem(db, batch, 'SIGN_PERFORMED', 'p-1', null, w.cast.operator.personId)).toMatch(blocked);
    expect(await stepProblem(db, batch, 'SIGN_PERFORMED', 'p-1', quiet.code, w.cast.operator.personId)).toMatch(blocked);
  });
});
