/**
 * R-flow item 2 (D-0 row 4, EBMR-LIB-024): the edition-neutral seed blocks are generic, so an injectables or API master
 * uses the catalogue's line clearance, room and equipment status, dispensing, sifting, milling, hold, transfer and
 * packaging blocks without a copy. The blocks that name a tablet process (granulation, compression, coating, blistering
 * of tablets and the like) stay tablets blocks. A library that already holds the earlier, unchanged copy of a block that
 * became generic takes the generic one as its next version when the catalogue is loaded; a site's own version is never
 * touched.
 *
 * Controls: PR-05 (versioned, QA-approved content; the edition check at approval), DI-35 (QA's approval signature).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { routes } from '@ebmr/api-contract';
import { librarySeed } from '@ebmr/recipe-core';
import { library } from '@ebmr/recipe-core/pure';
import { startSigningServer, valueOf } from '../esig/support.ts';
import type { TestServer } from '../support/harness.ts';
import { gmpContent, gmpLifecycleWorld } from '../support/gmp-world.ts';
import { signAction } from '../support/signed-acts.ts';
import type { Json } from '../mutation/kill-support.ts';

let gmp: TestServer;
beforeAll(async () => {
  gmp = await startSigningServer('GMP', { stub: false });
}, 600_000);
afterAll(async () => {
  await gmp?.close();
});

const GENERIC = [
  'CTRL-BALANCE-CHECK', 'CTRL-DEVIATION-REF', 'CTRL-EQUIP-STATUS', 'CTRL-LINE-CLEAR-END', 'CTRL-LINE-CLEAR-START', 'CTRL-MATERIAL-RECON',
  'CTRL-PRINTED-RECON', 'CTRL-QA-VERIFY', 'CTRL-ROOM-STATUS', 'CTRL-SAMPLING', 'CTRL-STAGE-SIGNOFF', 'CTRL-YIELD',
  'PACK-CARTON', 'PACK-CODING', 'PACK-LABEL-RECON', 'PACK-LEAK', 'PACK-SHIPPER',
  'PROC-CONE-MILL', 'PROC-DISP', 'PROC-DISP-LIQUID', 'PROC-DISP-POTENCY', 'PROC-HOLD', 'PROC-MILL', 'PROC-SIFT', 'PROC-TRANSFER',
];
const seed = (code: string): librarySeed.SeedItem => {
  const item = librarySeed.SEED_CATALOGUE.find((i) => i.definition.code === code);
  if (!item) throw new Error(`no seed item ${code}`);
  return item;
};

describe('generic seed blocks (R-flow item 2, EBMR-LIB-024)', () => {
  it('[PR-05] exactly the edition-neutral seed blocks are generic, at version 1; the tablet-process blocks stay tablets blocks', () => {
    const generic = librarySeed.SEED_CATALOGUE.filter((i) => library.blockEdition(i.definition) === 'generic').map((i) => i.definition.code).sort();
    expect(generic).toEqual([...GENERIC].sort());
    for (const code of GENERIC) expect(seed(code).definition.version).toBe(1);
    for (const code of ['PROC-RMG', 'PROC-COMPRESS', 'PROC-FBD', 'PROC-BLEND', 'PACK-BLISTER-THERMO']) expect(library.blockEdition(seed(code).definition)).toBe('tablets');
  });

  it('[PR-05][DI-35] the catalogue loads the generic blocks; an injectables and an API master holding one is approved by QA', async () => {
    const [author, approver] = await Promise.all([gmp.asPersona('author'), gmp.asPersona('approver')]);
    // A library holding the earlier tablets copy of PROC-HOLD, unchanged, and a site's own PROC-TRANSFER.
    const tabletsCopy = (code: string): Json => Object.fromEntries(Object.entries(seed(code).definition).filter(([k]) => k !== 'edition'));
    valueOf(await author.call(routes.library.draft, { body: { definition: tabletsCopy('PROC-HOLD') } }));
    valueOf(await author.call(routes.library.draft, { body: { definition: { ...tabletsCopy('PROC-TRANSFER'), title: 'Transfer between areas (site SOP)' } } }));
    const loaded = valueOf(await author.call(routes.library.loadCatalogue, { body: {} }));
    expect(loaded.drafted).toEqual(expect.arrayContaining(['CTRL-LINE-CLEAR-START', 'PROC-HOLD']));
    expect(loaded.skipped).toContain('PROC-TRANSFER');
    const versions = async (code: string) =>
      (await gmp.db.admin.query<{ version: number; edition: string }>('select version, recipe.library_block_edition(definition) as edition from recipe.library_block where code = $1 order by version', [code])).rows;
    expect(await versions('PROC-HOLD')).toEqual([{ version: 1, edition: 'tablets' }, { version: 2, edition: 'generic' }]);
    expect(await versions('PROC-TRANSFER')).toEqual([{ version: 1, edition: 'tablets' }]);

    const item = seed('CTRL-LINE-CLEAR-START');
    const { rows } = await gmp.db.admin.query<{ id: string }>("select id from recipe.library_block where code = 'CTRL-LINE-CLEAR-START' and version = 1");
    const signed = await signAction(gmp, approver, 'approver', { kind: 'LIBRARY_ACT', act: 'BLOCK_APPROVE', subjectId: rows[0]?.id ?? '' });
    if (!signed.ok) throw new Error(`SETUP: the seed block was not approved: ${JSON.stringify(signed.error)}`);
    const world = await gmpLifecycleWorld(gmp);
    for (const edition of ['injectables', 'substance'] as const) {
      const content = gmpContent((m) => {
        (m['header'] as Json)['edition'] = edition;
        const stage = ((((m['procedure'] as Json)['body'] as Json)['children'] as Json[])[0] as Json)['body'] as Json;
        const prep = ((stage['children'] as Json[])[0] as Json)['body'] as Json;
        const step = library.libraryPhase(item.definition, 'p-clear', 'HIGH');
        Object.assign(step.config, structuredClone(item.exampleUse));
        prep['children'] = [step as unknown as Json, ...(prep['children'] as Json[])];
        m['blockDefinitions'] = [item.definition as unknown as Json];
      });
      const v = await world.approvedVersion(content);
      expect((await world.state(v.versionId)).state).toBe('APPROVED');
      const { rows: fam } = await gmp.db.admin.query<{ edition: string }>('select f.edition from recipe.mbr_family f join recipe.mbr_version v on v.family_id = f.id where v.id = $1', [v.versionId]);
      expect(fam).toEqual([{ edition }]);
    }
  }, 240_000);
});
