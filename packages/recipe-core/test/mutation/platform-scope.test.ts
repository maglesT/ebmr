/**
 * The plant's answer to the platform's SCOPE hook (SQL mutation group "platform-scope", recipe-core 0523 and 0540,
 * plant.transition_scope): a step.execute transition of a unit is checked for the product of the use this transaction
 * starts or ends, of that unit only; of an output container, for the container's own product; any other permission,
 * aggregate or identifier adds nothing.
 *
 * Controls: DI-17, IN-26.
 */
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { toDbContext } from '../../../kernel/src/db/command.ts';
import { cmd } from '../../../kernel/test/esig/helpers.ts';
import type { SeededActor } from '../../../kernel/test/identity/seed.ts';
import { createTestDatabase, type TestDatabase } from '../../../kernel/test/support/db.ts';
import * as oc from '../../src/containers/index.ts';
import { dbIn, PlantWorld, seedPlantCast } from '../plant/support.ts';

let db: TestDatabase;
let w: PlantWorld;
beforeAll(async () => {
  db = await createTestDatabase();
  w = new PlantWorld(db, await seedPlantCast(db));
}, 300_000);
afterAll(async () => {
  await db.drop();
});

/** `work` in a command of `actor` (superuser connection), always rolled back. */
async function inCommand<T>(actor: SeededActor, work: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const ctx = await cmd(db, actor);
  const c = await db.admin.connect();
  try {
    await c.query('begin');
    await c.query('select kernel.begin_command($1::jsonb)', [JSON.stringify(toDbContext(ctx))]);
    return await work(c);
  } finally {
    await c.query('rollback');
    c.release();
  }
}

const scope = async (c: pg.PoolClient | pg.Pool, permission: string | null, type: string, id: string | null): Promise<unknown> =>
  (await c.query<{ s: unknown }>('select plant.transition_scope($1, $2, $3) as s', [permission, type, id])).rows[0]?.s;

describe('the SCOPE hook of the plant', () => {
  it('[DI-17][IN-26] a unit: the product of the use this transaction starts or ends, of that unit only', async () => {
    const x = await w.product();
    const y = await w.product();
    const press = await w.press();
    const other = await w.press();
    await w.clean('EQUIPMENT', press.code, 'MAJOR');
    await w.clean('EQUIPMENT', other.code, 'MAJOR');
    // A use of the press started before this transaction counts for nothing in it.
    const before = await w.startUse(press.code, 'TS-0', x);
    expect(await scope(db.admin, 'step.execute', 'plant_equipment', press.id)).toEqual({});
    // Ending it in this transaction: its product.
    expect(
      await inCommand(w.cast.operator, async (c) => {
        await c.query('select plant.end_equipment_use($1)', [before]);
        return scope(c, 'STEP.EXECUTE', 'plant_equipment', press.id);
      }),
    ).toEqual({ product: x });
    // Starting a use of the other unit (product Y) in this transaction says nothing about the press.
    const end = await dbIn(db, 3600);
    const b = await w.batch('TS-1', y);
    expect(
      await inCommand(w.cast.operator, async (c) => {
        await c.query('select plant.start_equipment_use($1, $2, $3::timestamptz)', [other.code, b.id, end]);
        return [await scope(c, 'step.execute', 'plant_equipment', other.id), await scope(c, 'step.execute', 'plant_equipment', press.id)];
      }),
    ).toEqual([{ product: y }, {}]);
  });

  it('[DI-17] an output container: its own product; another permission, a malformed or missing identifier: nothing', async () => {
    const x = await w.product();
    const y = await w.product();
    const bx = await w.batch('TS-C1', x);
    const by = await w.batch('TS-C2', y);
    await w.run(w.cast.operator, (c) => oc.openContainer(c, { batchId: by.id, stage: 'COMPRESSION', unit: 'kg' }));
    const cx = await w.run(w.cast.operator, (c) => oc.openContainer(c, { batchId: bx.id, stage: 'COMPRESSION', unit: 'kg' }));
    expect(await scope(db.admin, 'step.execute', 'output_container', cx.containerId)).toEqual({ product: x });
    expect(await scope(db.admin, 'step.verify', 'output_container', cx.containerId)).toEqual({});
    expect(await scope(db.admin, null, 'output_container', cx.containerId)).toEqual({});
    expect(await scope(db.admin, 'step.execute', 'output_container', null)).toEqual({});
    expect(await scope(db.admin, 'step.execute', 'output_container', 'not-a-uuid')).toEqual({});
    expect(await scope(db.admin, 'step.execute', 'plant_area', cx.containerId)).toEqual({});
  });
});
