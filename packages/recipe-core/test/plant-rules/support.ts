/**
 * Test support for the plant rules of slice 6b (recipe-core 0973 to 0975, kernel 1190, site services 0940): batches
 * whose MBR names real steps, a room or line cleaned, cleared and occupied, and the forged execution row a bypass
 * attempt writes as the database owner. Batch records are arranged by the superuser with triggers off, as the plant
 * support does (test setup only); everything under test runs as the application role through the real commands.
 */
import { createHash, randomUUID } from 'node:crypto';
import type pg from 'pg';
import { asTimeTraveller } from '../../../kernel/test/esig/helpers.ts';
import type { TestDatabase } from '../../../kernel/test/support/db.ts';
import * as plant from '../../src/plant/index.ts';
import { seedActor, type SeededActor } from '../../../kernel/test/identity/seed.ts';
import { tag, type PlantWorld } from '../plant/support.ts';

/** A test batch of `product` whose MBR has one stage with the given phases (purpose SANDBOX_TEST_RUN or GMP_BATCH). */
export async function batchWithSteps(db: TestDatabase, product: string, steps: string[], purpose: 'SANDBOX_TEST_RUN' | 'GMP_BATCH' = 'SANDBOX_TEST_RUN'): Promise<string> {
  const id = randomUUID();
  const hash = createHash('sha256').update(id).digest('hex');
  const content = {
    procedure: { kind: 'procedure', id: 'proc', body: { kind: 'stage', id: 'S-1', body: { kind: 'sequence', children: steps.map((s) => ({ kind: 'phase', id: s })) } } },
  };
  const productRef = { code: product, name: `Product ${product}`, strength: '10 mg' };
  if (purpose === 'GMP_BATCH') {
    // A GMP batch runs a control recipe: its snapshot holds the MBR content (the stub batch, pin and version it names
    // are not needed by the plant rules; arranged with triggers and foreign keys off).
    const cr = randomUUID();
    await asTimeTraveller(
      db,
      `insert into recipe.control_recipe (id, batch_id, pin_id, version_id, mbr_content_hash, snapshot, snapshot_hash, person_id, account_id)
       values ($1, gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), $2, $3::jsonb, $2, gen_random_uuid(), gen_random_uuid())`,
      [cr, hash, JSON.stringify({ mbr: { content: { ...content, header: { product: productRef } } } })],
    );
    await asTimeTraveller(
      db,
      `insert into recipe.batch_execution (id, batch_number, control_recipe_id, issue_signature_id, content_hash, installation, purpose, engine_version,
                                           registry_fingerprint, policy, policy_hash, issue_request, market_set, batch_size, site_code, site_zone, issued_at_us,
                                           issued_by_person, issued_by_account, correlation_id)
       values ($1, $2, $3, gen_random_uuid(), $4, 'GMP', 'GMP_BATCH', '1', $4, '{}', $4, '{}', '{IN}', 'BS', 'SITE-1', 'Asia/Kolkata', 0, gen_random_uuid(),
               gen_random_uuid(), gen_random_uuid())`,
      [id, `TEST-PR-${tag()}`, cr, hash],
    );
    return id;
  }
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
    [id, `TEST-PR-${tag()}`, hash],
  );
  return id;
}

/** Room or line `code` cleaned (MAJOR, verified), cleared for batch `label` of `product` and occupied by it. */
export async function occupy(w: PlantWorld, code: string, label: string, product: string, line = false): Promise<string> {
  const order = line ? { order: `PO-${tag()}`, artworkSet: `ART-${tag()}` } : {};
  await w.clean('AREA', code, 'MAJOR');
  await w.clear(code, line ? 'PACKAGING_ORDER' : 'PRODUCT_CHANGE', { batch: label, product, ...order });
  return w.startIn(code, { batch: label, product, stage: line ? 'PACKAGING' : 'COMPRESSION', ...order });
}

/** Room `code` cleaned (MAJOR), cleared for the batch by the operator and the verifier, and occupied by it. */
export async function occupyBatch(w: PlantWorld, code: string, batchId: string): Promise<string> {
  await w.clean('AREA', code, 'MAJOR');
  const clearance = await w.run(w.cast.operator, (c) => plant.recordClearance(c, code, 'PRODUCT_CHANGE', { batchId, result: 'PASSED' }));
  const sig = await w.sign(w.cast.verifier, 'plant_clearance', clearance, 'VERIFIED', 'PERFORMED');
  await w.run(w.cast.verifier, (c) => plant.verifyClearance(c, clearance, sig));
  return w.run(w.cast.operator, (c) => plant.startAreaOccupancy(c, code, { batchId, stage: 'COMPRESSION' }));
}

/** The answer of plant.step_rules_problem as the application reads it (null: the command may be written). */
export async function stepProblem(db: TestDatabase, batchId: string, type: string, step: string, room: string | null, personId: string): Promise<string | null> {
  const { rows } = await db.app.query<{ p: string | null }>('select plant.step_rules_problem($1, $2, $3, $4, $5, clock_timestamp()) as p', [batchId, type, step, room, personId]);
  return rows[0]?.p ?? null;
}

/**
 * Bypass: an accepted person's command row written straight into the execution store as the database owner (no
 * engine, no server), in a transaction rolled back. Resolves to the error the database raised.
 */
export async function forgedCommand(db: TestDatabase, batchId: string, type: string, step: string, room: string | null, personId: string): Promise<string> {
  const c: pg.PoolClient = await db.admin.connect();
  try {
    await c.query('begin');
    await c.query('set local role ebmr_owner');
    const h = '0'.repeat(64);
    await c.query(
      `insert into recipe.execution_command (batch_id, seq, kind, command_id, command_type, command, command_hash, actor_person, actor_account, actor_role,
                                             source, session_id, device_class, room_code, now_us, accepted, state_version, state_hash, events_hash,
                                             event_count, prev_row_hash, row_hash, correlation_id)
       values ($1, 2, 'COMMAND', gen_random_uuid()::text, $2, jsonb_build_object('type', $2::text, 'step', $3::text, 'context', '[]'::jsonb), $5, $4, gen_random_uuid(),
               'OPERATOR', 'UI', gen_random_uuid(), 'KIOSK', $6, 0, true, 1, $5, $5, 0, $5, $5, gen_random_uuid())`,
      [batchId, type, step, personId, h, room],
    );
    return 'written';
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  } finally {
    await c.query('rollback');
    c.release();
  }
}

const qaPairs = new WeakMap<PlantWorld, Promise<{ recorder: SeededActor; approver: SeededActor }>>();

/**
 * Room or line `code` dedicated to beta-lactam products (recipe-core 1600, PR-27): recorded by a QA MBR approver and
 * approved by a QA reviewer (0912), so a beta-lactam batch may be cleared for it and started there.
 */
export async function dedicateBetaLactam(w: PlantWorld, db: TestDatabase, code: string): Promise<void> {
  let pair = qaPairs.get(w);
  if (!pair) {
    pair = (async () => ({
      recorder: await seedActor(db, { roleCode: 'QA_MBR_APPROVER', legalName: 'Bina Beta' }),
      approver: await seedActor(db, { roleCode: 'QA_REVIEWER', legalName: 'Bala Beta' }),
    }))();
    qaPairs.set(w, pair);
  }
  const { recorder, approver } = await pair;
  const id = await w.run(recorder, async (c) =>
    (await c.query<{ r: string }>('select plant.record_area_dedication($1::jsonb) as r', [JSON.stringify({ areaCode: code, hazardClass: 'BETA_LACTAM', dedicated: true, breathingAir: 'NOT_USED', justification: 'Beta-lactam suite (test)' })])).rows[0]?.r ?? '');
  const sig = await w.sign(approver, 'area_dedication', id, 'AREA_DEDICATION_APPROVED', 'RECORDED');
  await w.run(approver, (c) => c.query('select plant.approve_area_dedication($1, $2)', [id, sig]));
}
