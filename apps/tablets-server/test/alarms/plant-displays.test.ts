/**
 * The status displays and plant-rule routes over HTTP (Phase 6 slice 6b, builder B; contract equipmentDisplays and
 * plantRules; recipe-core 0973 to 0975): the status board shows what the database holds after each transition (PR-22),
 * the line station shows the product and batch on the line (PR-35), a spill recorded on the room screen sets the room to
 * cleaning required (PR-27). The GMP batch and its line occupancy are arranged by the superuser with triggers off (test
 * set-up only; the occupancy rules are proven in recipe-core's plant-rules tests).
 */
import { createHash, randomUUID } from 'node:crypto';
import { routes } from '@ebmr/api-contract';
import { withCommand, type ActorContext } from '@ebmr/kernel';
import { plant } from '@ebmr/recipe-core';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { actorOfBrowser, refusalOf, valueOf } from '../esig/support.ts';
import { startServer, type TestServer, type TestBrowser } from '../support/harness.ts';

let gmp: TestServer;
let steward: TestBrowser;
let tech: TestBrowser;
const tag = () => randomUUID().slice(0, 6).toUpperCase();
const reason = <T extends ActorContext>(ctx: T): T => ({ ...ctx, reasonCode: 'TEST_SETUP', reasonText: 'plant displays', correlationId: randomUUID() });

async function setup(sql: string, params: unknown[]): Promise<void> {
  const c = await gmp.db.admin.connect();
  try {
    await c.query('begin');
    await c.query('set local session_replication_role = replica');
    await c.query(sql, params);
    await c.query('commit');
  } finally {
    c.release();
  }
}

async function as(b: TestBrowser, key: string): Promise<ActorContext> {
  vi.advanceTimersByTime(7_000);
  return reason(await actorOfBrowser(gmp, b, key));
}

beforeAll(async () => {
  gmp = await startServer('GMP');
  vi.useFakeTimers({ toFake: ['performance'] });
  steward = await gmp.asPersona('steward');
  tech = await gmp.asPersona('technician1');
}, 300_000);
afterAll(async () => {
  vi.useRealTimers();
  await gmp?.close();
});

describe('the status displays (PR-22, PR-35)', () => {
  it('[PR-22] the status display matches the system state after each transition', async () => {
    const qa = await gmp.asPersona('qaInvestigator');
    const classCode = `CL-${tag()}`;
    const code = `EQ-${tag()}`;
    const room = `RM-${tag()}`;
    await withCommand(gmp.db.app, await as(steward, 'steward'), async (c) => {
      await plant.defineEquipmentClass(c, { code: classCode, description: 'Rotary press', kind: 'PROCESS', cleanHold: '72 hours', dirtyHold: '48 hours', calibrationRequired: false });
      await plant.defineEquipment(c, { code, name: 'Rotary press (board test)', classCode });
      await plant.defineArea(c, { code: room, kind: 'ROOM', name: 'Compression room (board test)' });
    });
    /** Every entry of the board equals the machine state the database holds for it at the same moment. */
    const matches = async (): Promise<Record<string, string | null>> => {
      const board = valueOf(await qa.call(routes.equipmentDisplays.statusBoard));
      const { rows } = await gmp.db.app.query<{ code: string; state: string; version: string }>(
        `select coalesce(e.code, a.code) as code, s.state, s.version::text from platform.aggregate_state s
           left join plant.equipment e on s.aggregate_type = 'plant_equipment' and e.id = s.aggregate_id
           left join plant.area a on s.aggregate_type = 'plant_area' and a.id = s.aggregate_id
          where s.aggregate_type in ('plant_equipment', 'plant_area')`,
      );
      const system = new Map(rows.map((r) => [r.code, r]));
      for (const e of board.entries) {
        const s = system.get(e.code);
        expect({ code: e.code, state: e.state, version: e.stateVersion }).toEqual({ code: e.code, state: s?.state ?? null, version: s?.version ?? null });
      }
      const of = (c: string) => board.entries.find((x) => x.code === c);
      return { press: of(code)?.state ?? null, room: of(room)?.state ?? null, roomCleaning: of(room)?.cleaningState ?? null };
    };
    const seen = [await matches()];
    const cleaning = await withCommand(gmp.db.app, await as(tech, 'technician1'), (c) => plant.startCleaning(c, 'EQUIPMENT', code, 'MAJOR'));
    seen.push(await matches());
    await withCommand(gmp.db.app, await as(tech, 'technician1'), (c) => plant.completeCleaning(c, cleaning));
    seen.push(await matches());
    const roomCleaning = await withCommand(gmp.db.app, await as(tech, 'technician1'), (c) => plant.startCleaning(c, 'AREA', room, 'MAJOR'));
    seen.push(await matches());
    await withCommand(gmp.db.app, await as(tech, 'technician1'), (c) => plant.abandonCleaning(c, roomCleaning));
    seen.push(await matches());
    expect(seen).toEqual([
      { press: 'DIRTY', room: 'DIRTY', roomCleaning: 'NOT_CLEANED' },
      { press: 'CLEANING', room: 'DIRTY', roomCleaning: 'NOT_CLEANED' },
      { press: 'CLEANING', room: 'DIRTY', roomCleaning: 'NOT_CLEANED' },
      { press: 'CLEANING', room: 'CLEANING', roomCleaning: 'NOT_CLEANED' },
      { press: 'CLEANING', room: 'DIRTY', roomCleaning: 'NOT_CLEANED' },
    ]);
    // A spill recorded on the room screen by a person sets it to cleaning required (PR-27).
    const op = tech;
    const body = { description: 'Granulate spilt by the sieve', material: 'Granulate' };
    const spilt = valueOf(await op.call(routes.plantRules.recordSpill, { params: { code: room }, body }));
    expect(spilt).toMatchObject({ code: room, cleaningState: 'CLEANING_REQUIRED', openSpills: 1 });
    expect(await matches()).toMatchObject({ roomCleaning: 'CLEANING_REQUIRED' });
    // Bypass: a person without the logbook permission cannot record one.
    expect(refusalOf(await qa.call(routes.plantRules.recordSpill, { params: { code: room }, body })).status).toBeGreaterThanOrEqual(400);
  });

  it('[PR-35] the station display shows the product and batch', async () => {
    const qa = await gmp.asPersona('qaInvestigator');
    const line = `LN-${tag()}`;
    const product = `PRD-${tag()}`;
    const batchId = randomUUID();
    const number = `B26-${tag()}`;
    await withCommand(gmp.db.app, await as(steward, 'steward'), (c) => plant.defineArea(c, { code: line, kind: 'LINE', name: 'Blister line (station test)' }));
    const idle = valueOf(await qa.call(routes.equipmentDisplays.lineStation, { params: { code: line } }));
    expect(idle).toMatchObject({ code: line, kind: 'LINE', state: 'DIRTY', batch: null });
    const hash = createHash('sha256').update(batchId).digest('hex');
    const cr = randomUUID();
    await setup(`insert into plant.product (code, name, highly_potent, recorded_by) values ($1, 'Paracetamol tablets 500 mg', false, gen_random_uuid())`, [product]);
    await setup(
      `insert into recipe.control_recipe (id, batch_id, pin_id, version_id, mbr_content_hash, snapshot, snapshot_hash, person_id, account_id)
       values ($1, gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), $2, $3::jsonb, $2, gen_random_uuid(), gen_random_uuid())`,
      [cr, hash, JSON.stringify({ mbr: { content: { header: { product: { code: product, name: 'Paracetamol tablets', strength: '500 mg' } } } } })],
    );
    await setup(
      `insert into recipe.batch_execution (id, batch_number, control_recipe_id, issue_signature_id, content_hash, installation, purpose, engine_version, registry_fingerprint,
                                           policy, policy_hash, issue_request, market_set, batch_size, site_code, site_zone, issued_at_us, issued_by_person, issued_by_account, correlation_id)
       values ($1, $2, $3, gen_random_uuid(), $4, 'GMP', 'GMP_BATCH', '1', $4, '{}', $4, '{}', '{IN}', 'BS', 'SITE-1', 'Asia/Kolkata', 0, gen_random_uuid(), gen_random_uuid(), gen_random_uuid())`,
      [batchId, number, cr, hash],
    );
    await setup(
      `insert into plant.area_occupancy (area_id, exclusive, batch_id, batch_ref, product_code, stage, packaging_order, artwork_set, clearance_id, started_by)
       select a.id, true, $2, $3, $4, 'PACKAGING', 'PO-26-0107', 'ART-IN-v3', gen_random_uuid(), gen_random_uuid() from plant.area a where a.code = $1`,
      [line, batchId, number, product],
    );
    const shown = valueOf(await qa.call(routes.equipmentDisplays.lineStation, { params: { code: line } }));
    expect(shown.batch).toMatchObject({ batchId, batchRef: number, product, productName: 'Paracetamol tablets 500 mg', stage: 'PACKAGING', packagingOrder: 'PO-26-0107', artworkSet: 'ART-IN-v3' });
    expect(refusalOf(await qa.call(routes.equipmentDisplays.lineStation, { params: { code: 'NO-SUCH-LINE' } }))).toMatchObject({ status: 404, code: 'EBMR-PLANT-011' });
  });
});
