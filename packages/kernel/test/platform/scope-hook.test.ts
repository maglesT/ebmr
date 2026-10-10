/**
 * Kernel 1150 (ADR-0018): the platform's SCOPE hook. A domain module may add the scope of the record a transition acts
 * on (for example a product); without a registered SCOPE hook (a kernel-only installation) the platform's permission
 * checks work exactly as before, in the session's location scope.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAggregateState, transition } from '../../src/state/engine.ts';
import { run } from '../esig/helpers.ts';
import { seedActor } from '../identity/seed.ts';
import { createTestDatabase, type TestDatabase } from '../support/db.ts';

let db: TestDatabase;
beforeAll(async () => {
  db = await createTestDatabase();
  await db.admin.query(`create function public.scope_test_hook(p text, t text, i text) returns jsonb language sql as $$ select '{"product": "P-SCOPE-1"}'::jsonb $$`);
  await db.admin.query(`create function public.scope_test_text(p text, t text, i text) returns text language sql as $$ select 'x' $$`);
}, 120_000);
afterAll(async () => {
  await db.drop();
});

async function submitAs(scope: Record<string, string>): Promise<unknown> {
  const author = await seedActor(db, { roleCode: 'MBR_AUTHOR', scope });
  return run(db, author, async (c) => {
    const { rows } = await c.query<{ id: string }>("insert into platform.stub_record (title, body) values ('SCOPE SOP', 'content') returning id");
    const id = rows[0]?.id ?? '';
    await createAggregateState(c, 'sample_record', { aggregateType: 'sample_record', aggregateId: id });
    return transition(c, { machine: 'sample_record', aggregateType: 'sample_record', aggregateId: id, event: 'SUBMIT', expectedVersion: 1, payload: {} });
  });
}

describe('the platform SCOPE hook (kernel 1150, ADR-0018)', () => {
  it('[DI-17] with no SCOPE hook registered (a kernel-only installation) a platform transition is checked in the location scope as before, and the hook adds nothing', async () => {
    await db.admin.query("delete from platform.hook where name = 'SCOPE'");
    expect((await db.admin.query<{ s: unknown }>("select platform.scope_of('sample_record.submit', 'sample_record', 'x') as s")).rows[0]?.s).toEqual({});
    await expect(submitAs({})).resolves.toMatchObject({ to: 'SUBMITTED' });
    await expect(submitAs({ product: 'P-SCOPE-1' })).rejects.toThrow(/EBMR-PLAT-006/);
  });

  it('[DI-17] a registered SCOPE hook adds its members to the evaluated scope: a grant limited to that product now matches, another product is refused, an unlimited grant still matches; a hook of another signature is refused', async () => {
    await db.admin.query("select platform.register_hook('SCOPE', 'public.scope_test_hook(text, text, text)')");
    await expect(submitAs({ product: 'P-SCOPE-1' })).resolves.toMatchObject({ to: 'SUBMITTED' });
    await expect(submitAs({ product: 'P-SCOPE-2' })).rejects.toThrow(/EBMR-PLAT-006/);
    await expect(submitAs({})).resolves.toMatchObject({ to: 'SUBMITTED' });
    await expect(db.admin.query("select platform.register_hook('SCOPE', 'public.scope_test_text(text, text, text)')")).rejects.toThrow(/EBMR-PLAT-004/);
    await expect(db.app.query("select platform.scope_of('x', 'y', 'z')")).rejects.toThrow(/permission denied/);
  });
});
