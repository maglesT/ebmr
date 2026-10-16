/**
 * The pharmacopoeia edition review lists the master records whose limits cite an older edition (recipe-core 1061; IN-33).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedActor, type SeededActor } from '../../../kernel/test/identity/seed.ts';
import { createTestDatabase, type TestDatabase } from '../../../kernel/test/support/db.ts';
import type { MbrContent } from '../../src/flow/model.ts';
import { seedCast, uniqueContent, World } from './support.ts';

let db: TestDatabase;
let w: World;
let qa: SeededActor;

interface ReviewItem {
  familyCode: string;
  versionId: string;
  state: string | null;
  citedIn: string;
  pharmacopoeia: string;
  cited: string;
  effective: string;
}

/** The fixture's content with every IP citation set to `edition`. */
function citing(edition: string): MbrContent {
  return JSON.parse(JSON.stringify(uniqueContent('tablet-granulation-compression', ['EU', 'IN', 'US'])).replace(/("code":"IP","edition":)"[^"]*"/g, `$1"${edition}"`)) as MbrContent;
}

const review = async (): Promise<ReviewItem[]> => (await db.app.query<{ r: ReviewItem[] }>('select recipe.mbr_edition_review() as r')).rows[0]?.r ?? [];

beforeAll(async () => {
  db = await createTestDatabase();
  w = new World(db, await seedCast(db));
  qa = await seedActor(db, { roleCode: 'QA_REVIEWER', legalName: 'QA Edition Reviewer' });
});
afterAll(async () => {
  await db?.drop();
});

describe('the MBR edition review (recipe-core 1061; IN-33)', () => {
  it('[IN-33] marking IP 2026 effective lists every MBR citing IP 2022', async () => {
    const old = citing('2022');
    expect(JSON.stringify(old)).toContain('"edition":"2022"');
    const approved = await w.approvedVersion(old);
    const draft = await w.newVersion(citing('2022'));
    const current = await w.newVersion(citing('2026'));
    await w.run(qa, (c) => c.query("select site.mark_edition_effective('IP', '2022', '2022-12-01T00:00:00Z')"));
    // While IP 2022 is the edition in force nothing is listed.
    expect((await review()).filter((i) => [approved.versionId, draft.versionId, current.versionId].includes(i.versionId))).toEqual([]);
    await w.run(qa, (c) => c.query("select site.mark_edition_effective('IP', '2026', '2026-07-01T00:00:00Z')"));
    const listed = (await review()).filter((i) => [approved.versionId, draft.versionId, current.versionId].includes(i.versionId));
    expect(new Set(listed.map((i) => i.versionId))).toEqual(new Set([approved.versionId, draft.versionId]));
    for (const i of listed) expect(i).toMatchObject({ pharmacopoeia: 'IP', cited: '2022', effective: '2026' });
    // Every citing element is named (the IP average-weight criterion among them), for each listed version.
    expect(listed.filter((i) => i.versionId === approved.versionId).map((i) => i.citedIn)).toContain('IP-AVG');
    expect(listed.find((i) => i.versionId === approved.versionId)?.state).toBe('APPROVED');
    // An edition not recorded yet is never listed as older.
    const unknown = await w.newVersion(citing('2018'));
    expect((await review()).some((i) => i.versionId === unknown.versionId)).toBe(false);
  });
});
