/**
 * Injectables plan I-0 (docs/build-plan/injectables/platform-fit.md; ADR 0001 amendment of 4 November 2026): the edition
 * is data. A library block names its edition inside the definition (so the hash QA approves covers it); a block of an
 * edition is offered to, and approved in, only a master of that edition, and a generic block in any (recipe-core 1871,
 * EBMR-LIB-023 and EBMR-LIB-024).
 *
 * Controls: PR-03 (the definition check), PR-05 (versioned, approved content; the approval refuses a wrong-edition
 * block), DI-35 (QA's approval signature).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { routes } from '@ebmr/api-contract';
import { library } from '@ebmr/recipe-core/pure';
import { refusalOf, startSigningServer, valueOf } from '../esig/support.ts';
import type { TestServer } from '../support/harness.ts';
import { gmpContent, gmpLifecycleWorld } from '../support/gmp-world.ts';
import { signAction } from '../support/signed-acts.ts';
import { attempt, tag, type Json } from '../mutation/kill-support.ts';

let gmp: TestServer;
beforeAll(async () => {
  gmp = await startSigningServer('GMP', { stub: false });
}, 600_000);
afterAll(async () => {
  await gmp?.close();
});

const defOf = (code: string, edition?: string): Json => ({
  code,
  version: 1,
  title: 'Edition block',
  category: 'TEST_IPC',
  ...(edition === undefined ? {} : { edition }),
  sections: [{ id: 'run', title: 'Run', fields: [{ id: 'w', label: 'W', type: 'NUMBER', unit: 'g' }] }],
  signatures: [{ meaning: 'PERFORMED', role: 'IPC_OPERATOR' }],
});

/** A block drafted by the author and approved by QA through the routes. */
async function approved(edition?: string): Promise<{ id: string; definition: Json }> {
  const [author, approver] = await Promise.all([gmp.asPersona('author'), gmp.asPersona('approver')]);
  const definition = defOf(`ED-${tag()}`, edition);
  const { block: b } = valueOf(await author.call(routes.library.draft, { body: { definition } }));
  const signed = await signAction(gmp, approver, 'approver', { kind: 'LIBRARY_ACT', act: 'BLOCK_APPROVE', subjectId: b.blockId });
  if (!signed.ok) throw new Error(`SETUP: the library block was not approved: ${JSON.stringify(signed.error)}`);
  return { id: b.blockId, definition };
}

/** The tablets GMP master with one library step of `def` in it. */
const withLibraryStep = (def: Json) =>
  gmpContent((m) => {
    const stage = ((((m['procedure'] as Json)['body'] as Json)['children'] as Json[])[0] as Json)['body'] as Json;
    const prep = ((stage['children'] as Json[])[0] as Json)['body'] as Json;
    const lib: Json = {
      kind: 'phase', id: 'p-lib', name: 'Edition (library)', block: { type: `LIB-${String(def['code'])}`, version: '1' },
      config: { hash: library.definitionHash(def as unknown as library.BlockDefinition) },
      records: [], computes: [], reads: [], consumes: [], produces: [], uses: [], equipment: [], signatures: { perform: { role: 'PRODUCTION_OPERATOR' } }, significant: false, riskClass: 'HIGH',
    };
    prep['children'] = [lib, ...(prep['children'] as Json[])];
    m['blockDefinitions'] = [def];
  });

describe('library block editions (injectables plan I-0; recipe-core 1871)', () => {
  it('[PR-03][PR-05] a block names its edition in the definition (tablets when it names none); the list offers a master only its edition\'s blocks and the generic ones; an unknown edition is refused by the check and by the table (EBMR-LIB-023)', async () => {
    const author = await gmp.asPersona('author');
    const inj = await approved('injectables');
    const gen = await approved('generic');
    const tab = await approved();
    const listed = async (edition: string) => valueOf(await author.call(routes.library.list, { query: { state: 'APPROVED', edition } })).blocks.map((b) => b.blockId);
    const forTablets = await listed('tablets');
    const forInjectables = await listed('injectables');
    expect(forTablets).toEqual(expect.arrayContaining([tab.id, gen.id]));
    expect(forTablets).not.toContain(inj.id);
    expect(forInjectables).toEqual(expect.arrayContaining([inj.id, gen.id]));
    expect(forInjectables).not.toContain(tab.id);
    const all = valueOf(await author.call(routes.library.list, { query: { state: 'APPROVED' } })).blocks;
    expect(all.find((b) => b.blockId === tab.id)?.edition).toBe('tablets');
    expect(all.find((b) => b.blockId === inj.id)?.edition).toBe('injectables');
    // The definition check and the draft refuse an unknown edition; the table refuses it on a direct insert too.
    const bad = defOf(`ED-${tag()}`, 'ointments');
    expect(valueOf(await author.call(routes.library.check, { body: { definition: bad } })).problems.map((p) => p.code)).toContain('LIB-EDITION');
    expect(refusalOf(await author.call(routes.library.draft, { body: { definition: bad } })).code).toBe('LIB-EDITION');
    const c = await gmp.db.admin.connect();
    try {
      await c.query('begin');
      const o = await attempt(
        c,
        `insert into recipe.library_block (code, version, title, category, definition, content_hash, drafted_by_person, drafted_by_account, correlation_id)
         values ($1::jsonb ->> 'code', 1, $1::jsonb ->> 'title', $1::jsonb ->> 'category', $1::jsonb, recipe.json_hash($1::jsonb), gen_random_uuid(), gen_random_uuid(), gen_random_uuid())`,
        [JSON.stringify(bad)],
      );
      expect(o.ok ? '' : o.message).toMatch(/EBMR-LIB-023 .* names the edition "ointments"/);
    } finally {
      await c.query('rollback');
      c.release();
    }
  });

  it('[PR-05] the edition check fits each direction: an injectables block in a tablets master, a tablets block in an injectables master, and generic blocks in both', async () => {
    const problem = async (defs: Json[], edition: string): Promise<string | null> =>
      (await gmp.db.admin.query<{ p: string | null }>('select recipe.library_edition_problem($1::jsonb, $2) as p', [JSON.stringify({ blockDefinitions: defs }), edition])).rows[0]?.p ?? null;
    expect(await problem([defOf('ED-INJ', 'injectables')], 'tablets')).toBe('ED-INJ@1 belongs to the injectables edition and this master to the tablets edition');
    expect(await problem([defOf('ED-TAB')], 'injectables')).toBe('ED-TAB@1 belongs to the tablets edition and this master to the injectables edition');
    expect(await problem([defOf('ED-TAB2', 'tablets')], 'injectables')).toMatch(/ED-TAB2@1 belongs to the tablets edition/);
    expect(await problem([defOf('ED-GEN', 'generic'), defOf('ED-TAB')], 'tablets')).toBeNull();
    expect(await problem([defOf('ED-GEN', 'generic'), defOf('ED-INJ', 'injectables')], 'injectables')).toBeNull();
    expect(library.editionFits('generic', 'injectables') && library.editionFits('tablets', 'tablets')).toBe(true);
    expect(library.editionFits('injectables', 'tablets') || library.editionFits('tablets', 'injectables')).toBe(false);
  });

  it('[PR-05][DI-35] on the real approval path, a tablets master holding an approved injectables block passes its earlier steps and is refused at QA approval (EBMR-LIB-024)', async () => {
    const world = await gmpLifecycleWorld(gmp);
    const inj = await approved('injectables');
    const content = withLibraryStep(inj.definition);
    const v = await world.newVersion(content);
    await world.prepare(v.versionId, content);
    await world.startVerification(v.versionId);
    await world.submit(v.versionId);
    await world.check(v.versionId);
    await expect(world.approve(v.versionId)).rejects.toThrow(new RegExp(`EBMR-LIB-024 this master cannot be approved: ${String(inj.definition['code'])}@1 belongs to the injectables edition and this master to the tablets edition`));
    expect((await world.state(v.versionId)).state).toBe('CHECKED');
  });
});
