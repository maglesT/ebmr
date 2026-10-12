/**
 * The platform's hooks (SQL mutation group "platform-scope", kernel 1150): a hook of an unknown name is refused as
 * unknown, before its signature is looked at. The SCOPE hook's answers for the plant are in
 * packages/recipe-core/test/mutation/platform-scope.test.ts.
 *
 * Controls: DI-17, DI-18.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../support/db.ts';

let db: TestDatabase;
beforeAll(async () => {
  db = await createTestDatabase();
}, 120_000);
afterAll(async () => {
  await db.drop();
});

async function refusal(sql: string): Promise<string> {
  const c = await db.admin.connect();
  try {
    await c.query('begin');
    await c.query(sql);
    return '(not refused)';
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  } finally {
    await c.query('rollback');
    c.release();
  }
}

describe('platform hooks (kernel 1150)', () => {
  it('[DI-17][DI-18] a hook of an unknown name is refused as unknown, whatever function it names', async () => {
    expect(await refusal("select platform.register_hook('BOGUS', 'platform.scope_of(text, text, text)'::regprocedure)")).toMatch(/^EBMR-PLAT-004 unknown hook BOGUS$/);
    expect(await refusal("select platform.register_hook(null, 'platform.scope_of(text, text, text)'::regprocedure)")).toMatch(/^EBMR-PLAT-004 unknown hook/);
  });
});
