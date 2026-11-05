/**
 * API edition plan A0 (docs/build-plan/api/plan.md, platform-fit.md; lead decision of 5 November 2026): the API edition
 * is the edition value `substance`, data in the one database like injectables (I-0). The list of editions lives in one
 * place: kernel.editions() in the database (kernel 1403), with every edition column's check re-created against it
 * (kernel 1403, site-services 1731, recipe-core 1872); the kernel's EDITIONS and the pure recipe-core flow.EDITIONS in
 * code. Nothing is narrowed: tablets and injectables behave as before.
 *
 * Controls: PR-01 (a master family per product and edition), PR-03 and PR-05 (the library definition check and the
 * approval that refuses a block of another edition), DI-35 (QA's approval signature).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { routes } from '@ebmr/api-contract';
import { EDITIONS } from '@ebmr/kernel';
import { flow, library } from '@ebmr/recipe-core/pure';
import { refusalOf, startSigningServer, valueOf } from '../esig/support.ts';
import type { TestServer } from '../support/harness.ts';
import { gmpContent, gmpLifecycleWorld } from '../support/gmp-world.ts';
import { signAction } from '../support/signed-acts.ts';
import { tag, type Json } from '../mutation/kill-support.ts';

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
  category: 'PROCESS',
  ...(edition === undefined ? {} : { edition }),
  sections: [{ id: 'run', title: 'Run', fields: [{ id: 't', label: 'Temperature', type: 'NUMBER', unit: 'Cel' }] }],
  signatures: [{ meaning: 'PERFORMED', role: 'PRODUCTION_OPERATOR' }],
});

async function approved(edition?: string): Promise<{ id: string; definition: Json }> {
  const [author, approver] = await Promise.all([gmp.asPersona('author'), gmp.asPersona('approver')]);
  const definition = defOf(`SB-${tag()}`, edition);
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

describe('the API edition as data (API plan A0)', () => {
  it('[PR-01] one list of editions: the database (kernel.editions(), upper-case codes, the library list) and the code (kernel EDITIONS, recipe-core flow.EDITIONS, library LIBRARY_EDITIONS) agree, and every edition check names the list instead of literals (the installation keys keep theirs)', async () => {
    const q = async <T>(sql: string): Promise<T> => ((await gmp.db.admin.query<{ r: T }>(sql)).rows[0] as { r: T }).r;
    const db = await q<string[]>('select kernel.editions() as r');
    expect(db).toEqual([...EDITIONS]);
    expect(db).toEqual([...flow.EDITIONS]);
    expect(db).toContain('substance');
    expect(await q<string[]>('select kernel.edition_codes() as r')).toEqual(EDITIONS.map((e) => e.toUpperCase()));
    expect(await q<string[]>('select recipe.library_editions() as r')).toEqual(['generic', ...EDITIONS]);
    expect([...library.LIBRARY_EDITIONS]).toEqual(['generic', ...EDITIONS]);
    const { rows } = await gmp.db.admin.query<{ t: string; def: string }>(
      `select c.relnamespace::regnamespace || '.' || c.relname as t, pg_get_constraintdef(con.oid) as def
         from pg_constraint con join pg_class c on c.oid = con.conrelid
        where con.contype = 'c' and con.conname ~ 'edition' order by 1`,
    );
    const literal = rows.filter((r) => /'(tablets|injectables|TABLETS|INJECTABLES)'/.test(r.def)).map((r) => r.t);
    expect(literal).toEqual(['platform.installation_identity', 'platform.peer_installation']);
    const listed = rows.filter((r) => /kernel\.edition(s|_codes)\(\)/.test(r.def)).map((r) => r.t);
    expect(listed).toEqual([
      'market.stub_equipment', 'market.stub_line', 'market.stub_product', 'market.stub_room',
      'recipe.grel_edition_hook', 'recipe.mbr_family', 'recipe.packaging_completion_block',
      'site.batch_number_allocation', 'site.deviation_link', 'site.finished_lot', 'site.lot_reservation', 'site.qc_extra_testing_decision',
    ]);
  });

  it('[PR-01] the rule tables a master binds: tablets the tablets table, injectables the sterile table (as before), an API master the kernel table only', async () => {
    const tables = async (edition: string) =>
      Object.keys((await gmp.db.admin.query<{ r: Record<string, unknown> }>('select recipe.rule_table_versions($1) as r', [edition])).rows[0]?.r ?? {});
    const published = (await gmp.db.admin.query<{ code: string }>('select code from market.rule_table order by code')).rows.map((r) => r.code);
    expect(await tables('tablets')).toEqual(['kernel', 'tablets'].filter((c) => published.includes(c)));
    expect(await tables('injectables')).toEqual(['kernel', 'sterile'].filter((c) => published.includes(c)));
    expect(await tables('substance')).toEqual(['kernel'].filter((c) => published.includes(c)));
  });

  it('[PR-03][PR-05] a substance block is drafted, approved and offered only to API masters (and the generic ones to all); the edition check refuses it in a tablets or injectables master and a tablets block in an API master', async () => {
    const author = await gmp.asPersona('author');
    const sub = await approved('substance');
    const tab = await approved();
    const gen = await approved('generic');
    const listed = async (edition: string) => valueOf(await author.call(routes.library.list, { query: { state: 'APPROVED', edition } })).blocks.map((b) => b.blockId);
    const forSubstance = await listed('substance');
    expect(forSubstance).toEqual(expect.arrayContaining([sub.id, gen.id]));
    expect(forSubstance).not.toContain(tab.id);
    expect(await listed('tablets')).not.toContain(sub.id);
    expect(await listed('injectables')).not.toContain(sub.id);
    expect(valueOf(await author.call(routes.library.check, { body: { definition: defOf(`SB-${tag()}`, 'substance') } })).problems.map((p) => p.code)).not.toContain('LIB-EDITION');
    const problem = async (defs: Json[], edition: string): Promise<string | null> =>
      (await gmp.db.admin.query<{ p: string | null }>('select recipe.library_edition_problem($1::jsonb, $2) as p', [JSON.stringify({ blockDefinitions: defs }), edition])).rows[0]?.p ?? null;
    expect(await problem([defOf('SB-API', 'substance')], 'tablets')).toBe('SB-API@1 belongs to the substance edition and this master to the tablets edition');
    expect(await problem([defOf('SB-API', 'substance')], 'injectables')).toMatch(/SB-API@1 belongs to the substance edition/);
    expect(await problem([defOf('SB-TAB')], 'substance')).toBe('SB-TAB@1 belongs to the tablets edition and this master to the substance edition');
    expect(await problem([defOf('SB-GEN', 'generic'), defOf('SB-API', 'substance')], 'substance')).toBeNull();
    expect(library.editionFits('substance', 'substance') && !library.editionFits('substance', 'tablets')).toBe(true);
  });

  it('[PR-05][DI-35] on the real approval path, a tablets master holding an approved substance block is refused at QA approval (EBMR-LIB-024)', async () => {
    const world = await gmpLifecycleWorld(gmp);
    const sub = await approved('substance');
    const content = withLibraryStep(sub.definition);
    const v = await world.newVersion(content);
    await world.prepare(v.versionId, content);
    await world.startVerification(v.versionId);
    await world.submit(v.versionId);
    await world.check(v.versionId);
    await expect(world.approve(v.versionId)).rejects.toThrow(new RegExp(`EBMR-LIB-024 this master cannot be approved: ${String(sub.definition['code'])}@1 belongs to the substance edition and this master to the tablets edition`));
    expect((await world.state(v.versionId)).state).toBe('CHECKED');
    // An unknown edition is still refused (the list grew; nothing else changed).
    const author = await gmp.asPersona('author');
    expect(refusalOf(await author.call(routes.library.draft, { body: { definition: defOf(`SB-${tag()}`, 'ointments') } })).code).toBe('LIB-EDITION');
  });
});
