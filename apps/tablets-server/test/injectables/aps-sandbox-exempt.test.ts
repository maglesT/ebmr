/**
 * Injectables I-6, INV-23 (c) (tablets 1915): the APS gate reads GMP batches only (purpose GMP_BATCH). A sandbox test run
 * is exempt because it fills no product: no finished lot can be posted from it (tablets 1150, EBMR-TAB-850), so nothing
 * of it can be released for sale. This test proves both on the sandbox installation, where test runs live.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { withCommand } from '@ebmr/kernel';
import { actorOfBrowser } from '../esig/support.ts';
import { dcMini, importAndIssue, startExecServer, writePackage, type ExecServer } from '../execution/support.ts';

let sbx: ExecServer;
beforeAll(async () => {
  sbx = await startExecServer();
  vi.useFakeTimers({ toFake: ['performance'] });
}, 180_000);
afterAll(async () => {
  vi.useRealTimers();
  await sbx?.close();
});

async function messageOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'ok';
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

describe('a sandbox test run is outside the APS gate and yields no lot (INV-23 (c))', () => {
  it('[INV-23][DI-05] a sandbox test run is not checked by the APS gate, even with an aseptic injectables processing header, and the database refuses to post a finished lot of it, so nothing of it is released (EBMR-TAB-850)', async () => {
    const issuer = await sbx.asPersona('issuer');
    const runId = await importAndIssue(sbx, issuer, writePackage(sbx, dcMini()));
    const { rows } = await sbx.db.admin.query<{ purpose: string; scoped: boolean }>(
      `select b.purpose, plant.aps_interval_scope(b.id, jsonb_set(recipe.batch_mbr_content(b.id), '{header}',
                recipe.batch_mbr_content(b.id) -> 'header' || '{"edition": "injectables", "recordKind": "PROCESSING"}'::jsonb)) as scoped
         from recipe.batch_execution b where b.id = $1`,
      [runId],
    );
    expect(rows).toEqual([{ purpose: 'SANDBOX_TEST_RUN', scoped: false }]);
    expect((await sbx.db.admin.query<{ f: unknown }>("select plant.aps_sign_off_facts($1, 'x', 'x@', 0) as f", [runId])).rows[0]!.f).toEqual({});
    const stores = await sbx.asPersona('stores');
    const posted = withCommand(sbx.db.app, { ...(await actorOfBrowser(sbx, stores, 'stores')), correlationId: randomUUID() }, (c) =>
      c.query('select tab.post_finished_lot($1, $2, $3)', [runId, '40', 'packs']));
    expect(await messageOf(posted)).toMatch(/EBMR-TAB-850 batch .* is not a GMP batch of this installation/);
    expect((await sbx.db.admin.query<{ n: number }>("select count(*)::int as n from site.material_lot where lot_code = (select batch_number from recipe.batch_execution where id = $1)", [runId])).rows[0]!.n).toBe(0);
  });
});
