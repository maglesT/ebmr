/**
 * The release demo of the set-up CLI (`--gmp-packaging`, Phase 4 slice 3c; since slice 7b through real signed acts,
 * release-path.ts, no DEMO SHORTCUT on the release path): a GB-T-02 batch released for packing by QA at its hold point and
 * two bottle orders run to their end. The first order's finished lot is tested, sampled and its records reviewed, so the
 * database computes it READY with no red G-REL item for IN, US and EU (the green release specs); the second order's lot,
 * posted in quarantine with an open deviation on its record, is NOT_READY (the rejection specs).
 */
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { routes } from '@ebmr/api-contract';
import { setupInstallation } from '../../src/cli/setup.ts';
import { valueOf } from '../esig/support.ts';
import { signAction } from '../support/signed-acts.ts';
import type { ReviewBatchSeed } from '../../src/cli/review-batch.ts';
import { startServer, type TestServer } from '../support/harness.ts';

const database = `ebmr_release_e2e_${randomBytes(4).toString('hex')}`;
const dir = mkdtempSync(join(tmpdir(), 'ebmr-release-seed-'));
let server: TestServer;
let batch: ReviewBatchSeed;

beforeAll(async () => {
  const keysDir = join(dir, 'keys');
  const seed = await setupInstallation({ installation: 'GMP', database, keysDir, exchangeDir: join(dir, 'exchange'), personaSets: 1, recreate: true, reviewBatch: true, packaging: true, log: () => undefined });
  batch = JSON.parse(readFileSync(join(keysDir, 'gmp-review-batch.json'), 'utf8')) as ReviewBatchSeed;
  server = await startServer('GMP', { prepared: { database, seed }, env: { EBMR_SEAL_KEY_FILE: join(keysDir, 'gmp-seal-key.json') } });
}, 1_200_000);

afterAll(async () => {
  await server?.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('the release demo of the set-up CLI (demo seed)', () => {
  it('posts a finished lot in quarantine from a packaging order of the review batch; the database computes it NOT_READY with a release gate to show', async () => {
    const r = batch.release;
    expect(r).toBeDefined();
    const db = server.db.app;
    const lot = await db.query<{ status: string; batch: string; state: string }>('select lot_status as status, batch_id::text as batch, state from recipe.release_lots() where lot_id = $1', [r?.lotId]);
    expect(lot.rows).toEqual([{ status: 'QUARANTINE', batch: r?.orderBatchId, state: 'NOT_READY' }]);
    expect((await db.query<{ s: string }>('select recipe.manufacturer_release_state($1) as s', [r?.lotId])).rows[0]?.s).toBe('NOT_READY');
    const g = (await db.query<{ g: { ready: boolean; items: { status: string }[] } }>("select recipe.grel_evaluate($1, 'IN') as g", [r?.lotId])).rows[0]?.g;
    expect(g?.ready).toBe(false);
    expect(g?.items.some((i) => i.status === 'RED')).toBe(true);
    expect(g?.items.some((i) => i.status === 'GREEN')).toBe(true);
    expect(r?.orderBatchNumber).toBe(`${batch.packaging?.parentBatchNumber ?? ''}/P02`);
  }, 120_000);

  it('[IN-05][INV-05] the ready lot, tested, sampled and reviewed through real signed acts, is READY with no red G-REL item for IN, US and EU', async () => {
    const r = batch.readyLot;
    expect(r).toBeDefined();
    const db = server.db.app;
    expect((await db.query<{ s: string }>('select recipe.manufacturer_release_state($1) as s', [r?.lotId])).rows[0]?.s).toBe('READY');
    for (const market of ['IN', 'US', 'EU']) {
      const g = (await db.query<{ g: { ready: boolean; items: { id: string; status: string }[] } }>('select recipe.grel_evaluate($1, $2) as g', [r?.lotId, market])).rows[0]?.g;
      expect(g?.items.filter((i) => i.status === 'RED').map((i) => i.id), market).toEqual([]);
    }
    expect(r?.orderBatchNumber).toBe(`${batch.packaging?.parentBatchNumber ?? ''}/P01`);
  }, 120_000);

  it('[PR-43] the finished lot expires at the end of recipe.batch_expiry\'s date in the site\'s zone (tablets 1201); the application can neither type an expiry nor change one', async () => {
    const r = batch.release;
    const db = server.db.app;
    const { rows } = await server.db.admin.query<{ local: string; exp: string; eod: boolean }>(
      `select to_char(l.expires_at at time zone kernel.site_zone(), 'YYYY-MM-DD') as local, recipe.batch_expiry(f.batch_id) ->> 'expiryDate' as exp,
              l.expires_at = (((recipe.batch_expiry(f.batch_id) ->> 'expiryDate')::date + 1)::timestamp at time zone kernel.site_zone()) - interval '1 microsecond' as eod
         from site.finished_lot f join site.material_lot l on l.id = f.lot_id where f.lot_id = $1`,
      [r?.lotId],
    );
    expect(rows[0]?.exp).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(rows[0]?.local).toBe(rows[0]?.exp);
    expect(rows[0]?.eod).toBe(true);
    await expect(db.query('select site.create_finished_lot($1::jsonb)', [JSON.stringify({ expiresAt: '2099-12-31T00:00:00Z' })])).rejects.toThrow(/permission denied/);
    await expect(db.query("update site.material_lot set expires_at = '2099-12-31' where id = $1", [r?.lotId])).rejects.toThrow(/permission denied/);
  }, 120_000);

  it('[IN-05][IN-39] the AP rejects the NOT_READY lot over HTTP on the epoch shown; production and QA are notified and each acknowledges', async () => {
    const lotId = batch.release?.lotId ?? '';
    const ap = await server.asPersona('qcuAuthoriser');
    const view = valueOf(await ap.call(routes.release.lot, { params: { lotId } }));
    expect(view.gates.reject).toEqual({ ready: true, problems: [] });
    expect(view.gates.release.ready).toBe(false);
    valueOf(await signAction(server, ap, 'qcuAuthoriser', { kind: 'RELEASE_ACT', act: 'MANUFACTURER_REJECT', lotId, input: { expectedEpoch: view.grel.epoch, reason: { code: 'NOT_TESTED', text: 'Demo lot never tested' } } }));
    const after = valueOf(await ap.call(routes.release.lot, { params: { lotId } }));
    expect(after.state).toBe('REJECTED');
    const notes = valueOf(await ap.call(routes.notifications.list, { query: { subjectId: lotId } })).notifications;
    expect(notes.map((n) => [n.department, n.event]).sort()).toEqual([['PRODUCTION', 'MANUFACTURER_REJECTED'], ['QA', 'MANUFACTURER_REJECTED']]);
    for (const [persona, department] of [['qaInvestigator', 'QA'], ['head1', 'PRODUCTION']] as const) {
      const b = await server.asPersona(persona);
      const n = notes.find((x) => x.department === department);
      const acked = valueOf(await b.call(routes.notifications.acknowledge, { params: { notificationId: n?.notificationId ?? '' }, body: {} }));
      expect(acked.acknowledgedByMe).toBe(true);
    }
  }, 120_000);
});
