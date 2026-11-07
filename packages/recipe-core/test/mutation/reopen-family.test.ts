/**
 * Demo finding D-3 (recipe-core 1878): recipe.reopen_family answers a family only when its code and its whole identity
 * match and every version of it was discarded (WITHDRAWN, never approved); anything else leaves define_family to refuse
 * the twin, as before (INV-17, PR-06).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../../kernel/test/support/db.ts';
import type { MbrContent } from '../../src/flow/model.ts';
import * as lc from '../../src/lifecycle/index.ts';
import { clone, reason, seedCast, uniqueContent, World } from '../lifecycle/support.ts';

let db: TestDatabase;
let w: World;

beforeAll(async () => {
  db = await createTestDatabase();
  w = new World(db, await seedCast(db));
}, 300_000);
afterAll(async () => {
  await db.drop();
});

const reopen = (def: lc.FamilyDefinition, who = w.cast.author) => w.run(who, (c) => lc.reopenFamily(c, def));
const discard = async (versionId: string, who = w.cast.author): Promise<void> => {
  const s = await w.state(versionId);
  await w.run(who, (c) => lc.withdrawVersion(c, versionId, s.version), reason('draft abandoned'));
};

describe('recipe.reopen_family (demo finding D-3)', () => {
  it('[PR-05][INV-17] a family whose only draft was discarded is answered for its own code and identity; another code, batch-size set or dosage form, an open draft, or an unknown code answer none', async () => {
    const content = uniqueContent('tablet-granulation-compression', ['IN']);
    const v = await w.newVersion(content);
    const def = lc.familyOf(content);
    expect(await reopen(def)).toBeNull();
    await discard(v.versionId);
    expect(await reopen(def)).toBe(v.familyId);
    expect(await reopen({ ...def, code: `${def.code}-X` })).toBeNull();
    expect(await reopen({ ...def, product: { ...def.product, dosageForm: `${def.product.dosageForm} (other)` } })).toBeNull();
    expect(await reopen({ ...def, batchSizes: def.batchSizes.map((b) => ({ ...b, quantity: { ...b.quantity, value: `${b.quantity.value}1` } })) })).toBeNull();
    // A second draft in it: open, so the family is not answered again until that one is discarded too.
    const v2 = await w.run(w.cast.author, (c) => lc.createVersion(c, v.familyId, clone(content), 'started again'));
    expect(await reopen(def)).toBeNull();
    await discard(v2.versionId);
    expect(await reopen(def)).toBe(v.familyId);
  });

  it('[PR-05][PR-06] a family that had an approved version is never reopened, even when that version was withdrawn before any authorisation', async () => {
    const content: MbrContent = uniqueContent('tablet-granulation-compression', ['IN']);
    const v = await w.approvedVersion(content);
    await discard(v.versionId, w.cast.qa);
    expect((await w.state(v.versionId)).state).toBe('WITHDRAWN');
    expect(await reopen(lc.familyOf(content))).toBeNull();
    // And recipe.create_version still refuses a new draft in it (EBMR-RCP-025).
    await expect(w.run(w.cast.author, (c) => lc.createVersion(c, v.familyId, clone(content)))).rejects.toThrow(/EBMR-RCP-025/);
  });
});
