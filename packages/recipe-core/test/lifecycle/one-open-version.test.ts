/**
 * Owner decision, 13 November 2026 (demo report r13 bug 2): a master family has at most one version in preparation
 * (DRAFT, IN_VERIFICATION, SUBMITTED or CHECKED) at a time, enforced by the database for every writer (recipe-core
 * 1925, EBMR-RCP-436): recipe.create_version and recipe.derive_version refuse a new version while one is open, under
 * the family's row lock. A withdrawn version is not open; an approved one is in force, not in preparation. Rows that
 * existed before the rule are not changed.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../../kernel/test/support/db.ts';
import * as lc from '../../src/lifecycle/index.ts';
import { reason, seedCast, uniqueContent, World } from './support.ts';

let db: TestDatabase;
let w: World;

beforeAll(async () => {
  db = await createTestDatabase();
  w = new World(db, await seedCast(db));
}, 300_000);

afterAll(async () => {
  await db.drop();
});

const derive = (from: string, why = 'change under test') => w.run(w.cast.author, (c) => lc.deriveVersion(c, from, why));
const OPEN = /EBMR-RCP-436/;

describe('one version in preparation per master family (recipe-core 1925)', () => {
  it('[PR-06][DI-22] a second version derived while one is in DRAFT or in verification is refused by the database; once it is withdrawn or approved, the next one starts', async () => {
    const v1 = await w.approvedVersion(uniqueContent());
    const v2 = await derive(v1.versionId);
    await expect(derive(v1.versionId, 'a competing change')).rejects.toThrow(OPEN);
    // In verification it is still open.
    const content = (await lc.loadContent(db.app, v2.versionId)).content;
    await w.prepare(v2.versionId, content);
    await w.startVerification(v2.versionId);
    expect((await w.state(v2.versionId)).state).toBe('IN_VERIFICATION');
    await expect(derive(v1.versionId, 'a competing change')).rejects.toThrow(OPEN);
    // Returned to DRAFT and withdrawn: no longer open, so the next version starts.
    const s = await w.state(v2.versionId);
    await w.run(w.cast.author, (c) => lc.returnToDraft(c, v2.versionId, s.version), reason('abandoned'));
    const d = await w.state(v2.versionId);
    await w.run(w.cast.author, (c) => lc.withdrawVersion(c, v2.versionId, d.version), reason('abandoned'));
    const v3 = await derive(v1.versionId);
    expect(v3.versionNumber).toBe(3);
    const count = await db.admin.query<{ n: number }>('select count(*)::int as n from recipe.mbr_version where family_id = $1', [v1.familyId]);
    expect(count.rows[0]?.n).toBe(3);
  }, 300_000);

  it('[PR-06] a first version is not created twice in one family: create_version is refused while the family has an open version', async () => {
    const content = uniqueContent();
    const v = await w.newVersion(content);
    await expect(w.run(w.cast.author, (c) => lc.createVersion(c, v.familyId, content, 'a twin draft'))).rejects.toThrow(OPEN);
  }, 300_000);

  it('[PR-06] two derivations at the same time: exactly one succeeds (the family row lock)', async () => {
    const v1 = await w.approvedVersion(uniqueContent());
    const results = await Promise.allSettled([derive(v1.versionId, 'first'), derive(v1.versionId, 'second')]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const refused = results.find((r) => r.status === 'rejected');
    expect(String(refused?.reason)).toMatch(OPEN);
  }, 300_000);
});
