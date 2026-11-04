/**
 * MEDHANTA platform, Phase B slice 3 (docs/build-plan/phase-b/platform-move-plan.md, "Guard facts"): master data through
 * the platform's versioned views on the platform build. The server reads the item through report.<kind>_v1 (a stand-in
 * master_data database, test/support/fake-master.ts) in the request that writes and records it in the writing
 * transaction (md.record_fact); the database refuses a write without that fact, or whose fact says unknown or inactive
 * (md.require_active, apps/tablets-server/sql/1900).
 *
 * Platform rules PL-07 (values as at the write, the id map keeps the local code) and PL-08 (the write-time active-item
 * check, connection off when the link is cut). The standalone build is unchanged.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { routes } from '@ebmr/api-contract';
import type { PoolClient } from 'pg';
import { withCommand } from '@ebmr/kernel';
import { asAdmin, passwordActor } from '@ebmr/test-kit';
import { platformEnv } from '../../src/config.ts';
import { FakeCore, type CorePerson } from '../support/fake-core.ts';
import { FakeMaster } from '../support/fake-master.ts';
import type { TestBrowser, TestServer } from '../support/harness.ts';
import { refusalOf, startSigningServer, valueOf } from '../esig/support.ts';

const core = new FakeCore();
const master = new FakeMaster();
let plat: TestServer;
let solo: TestServer;
let steward: TestBrowser;

const tag = (): string => randomUUID().slice(0, 6).toUpperCase();

async function signIn(b: TestBrowser, p: CorePerson): Promise<void> {
  const { proof, error } = await core.roundTrip(b, '/signin', p);
  if (!proof) throw new Error(`no sign-on proof: ${error}`);
  const body = { method: 'PLATFORM' as const, signonProof: proof };
  valueOf(await b.call(routes.session.login, { body: { ...body, proof: await b.proof('POST', '/api/session/login', body) } }));
}

beforeAll(async () => {
  await master.create();
  [plat, solo] = await Promise.all([
    startSigningServer('GMP', {
      env: { ...core.env, EBMR_MASTER_DATA_URL: master.url },
      coreFetch: core.fetch,
      beforeStart: (db) => asAdmin(db.name, (c) => c.query('select iam.enable_platform_build()')).then(() => undefined),
    }),
    startSigningServer('GMP'),
  ]);
  steward = plat.browser('PC-DESIGN-01');
  const t = tag();
  await signIn(steward, { sub: `E-${t}`, login: `core.md.${t}`, name: `Master Steward ${t}`, codes: ['ebmr.masterdata.change'] });
}, 300_000);
afterAll(async () => {
  await Promise.all([plat?.close(), solo?.close()]);
  await master.drop();
});

const q = async <T>(sql: string, params: unknown[] = []): Promise<T[]> => (await plat.db.admin.query(sql, params)).rows as T[];
const factsOf = (kind: string, code: string) =>
  q<{ master_id: string | null; code: string | null; name: string | null; version: string | null; active: boolean }>(
    'select master_id, code, name, version, active from md.master_fact where kind = $1 and local_code = $2 order by read_at', [kind, code]);

describe('the write-time active-item check (PL-08)', () => {
  it('[PL-08][PL-07] a product is defined only while core holds it active, with the name core holds; the read is recorded in the write and links the id map', async () => {
    const code = `FG-${tag()}`;
    const id = await master.put('product', code, 'Rabeprazole sodium gastro-resistant tablets 20 mg');
    // The name is core's: what was typed is not used.
    const p = valueOf(await steward.call(routes.plant.defineProduct, { body: { code, name: 'Rabeprazole 20', highlyPotent: false } }));
    expect(p).toMatchObject({ code, name: 'Rabeprazole sodium gastro-resistant tablets 20 mg' });
    expect(await factsOf('product', code)).toEqual([{ master_id: id, code, name: 'Rabeprazole sodium gastro-resistant tablets 20 mg', version: '1', active: true }]);
    expect(await q('select master_id from md.item_map where kind = $1 and local_code = $2', ['product', code])).toEqual([{ master_id: id }]);
  });

  it('[PL-08] refuses an inactive or unknown product, and nothing is saved', async () => {
    const retired = `FG-${tag()}`;
    await master.put('product', retired, 'Retired tablets', false);
    const unknown = `FG-${tag()}`;
    for (const code of [retired, unknown]) {
      const r = refusalOf(await steward.call(routes.plant.defineProduct, { body: { code, name: 'Some tablets', highlyPotent: false } }));
      expect(r.code).toBe('EBMR-MD-001');
      expect(await q('select 1 from plant.product where code = $1', [code])).toEqual([]);
      expect(await factsOf('product', code)).toEqual([]);
    }
  });

  it('[PL-08] refuses an inactive or unknown room; a line is no master item', async () => {
    const room = `RM-${tag()}`;
    await master.put('room', room, 'Compression room 1');
    valueOf(await steward.call(routes.plant.defineArea, { body: { code: room, kind: 'ROOM', name: 'Compression room 1' } }));
    const retired = `RM-${tag()}`;
    await master.put('room', retired, 'Old room', false);
    for (const code of [retired, `RM-${tag()}`]) {
      expect(refusalOf(await steward.call(routes.plant.defineArea, { body: { code, kind: 'ROOM', name: 'Some room' } })).code).toBe('EBMR-MD-001');
    }
    const line = `LN-${tag()}`;
    valueOf(await steward.call(routes.plant.defineArea, { body: { code: line, kind: 'LINE', name: 'Packing line' } }));
    expect(await factsOf('room', line)).toEqual([]);
  });

  it('[PL-08] refuses inactive or unknown equipment and instruments, each through its own master view', async () => {
    const t = tag();
    valueOf(await steward.call(routes.plant.defineEquipmentClass, { body: { code: `CMP${t}`, kind: 'PROCESS', description: 'Tablet press', cleanHold: '72 hours', dirtyHold: '24 hours' } }));
    valueOf(await steward.call(routes.plant.defineEquipmentClass, { body: { code: `BAL${t}`, kind: 'INSTRUMENT', description: 'Balance', calibrationRequired: true, checkRegime: 'DAILY' } }));
    const press = `EQ-CMP-${t}`;
    await master.put('equipment', press, 'Rotary tablet press 27 station');
    valueOf(await steward.call(routes.plant.defineEquipment, { body: { code: press, name: 'Rotary tablet press 27 station', classCode: `CMP${t}` } }));
    const coater = `EQ-CTG-${t}`;
    await master.put('equipment', coater, 'Auto coater 36 inch', false);
    expect(refusalOf(await steward.call(routes.plant.defineEquipment, { body: { code: coater, name: 'Auto coater 36 inch', classCode: `CMP${t}` } })).code).toBe('EBMR-MD-001');
    const balance = `IN-BAL-${t}`;
    // Held as equipment at core, not as an instrument: unknown in the instrument view.
    await master.put('equipment', balance, 'Analytical balance 220 g');
    expect(refusalOf(await steward.call(routes.plant.defineEquipment, { body: { code: balance, name: 'Analytical balance 220 g', classCode: `BAL${t}` } })).code).toBe('EBMR-MD-001');
    await master.put('instrument', balance, 'Analytical balance 220 g');
    valueOf(await steward.call(routes.plant.defineEquipment, { body: { code: balance, name: 'Analytical balance 220 g', classCode: `BAL${t}` } }));
    expect((await factsOf('instrument', balance)).at(-1)).toMatchObject({ code: balance, active: true });
  });

  it('[PL-08] connection off: a cut link stops the write with MASTER_DATA_OFF and serves nothing stale; existing records still read', async () => {
    const code = `FG-${tag()}`;
    await master.put('product', code, 'Paracetamol tablets 500 mg');
    await master.cut('product');
    try {
      const r = refusalOf(await steward.call(routes.plant.defineProduct, { body: { code, name: 'Paracetamol tablets 500 mg', highlyPotent: false } }));
      expect([r.status, r.code, r.whatHappened]).toEqual([503, 'MASTER_DATA_OFF', 'Connection to master data is off. Ask your administrator.']);
      expect(await q('select 1 from plant.product where code = $1', [code])).toEqual([]);
      expect(valueOf(await steward.call(routes.plant.products, {})).products.length).toBeGreaterThan(0);
    } finally {
      await master.restore('product');
    }
    valueOf(await steward.call(routes.plant.defineProduct, { body: { code, name: 'Paracetamol tablets 500 mg', highlyPotent: false } }));
  });
});

describe('the guard in the database (PL-08, PL-07)', () => {
  /** Runs `sql` in one command of the bootstrap administrator, on the admin pool (no fact resolver: the refusal as it is). */
  async function inCommand(server: TestServer, work: (c: PoolClient) => Promise<unknown>): Promise<unknown> {
    const admin = await passwordActor(server.db, server.seed.bootstrap.admin, server.seed.bootstrap.admin.fingerprint, { reasonCode: 'TEST', reasonText: 'slice 3', correlationId: randomUUID() });
    return withCommand(server.db.admin, admin, work);
  }
  const insertMaterial = (c: PoolClient, code: string) =>
    c.query("insert into site.erp_material (material_code, material_name, material_kind, unit, erp_reference, received_by_person, received_by_account, correlation_id) values ($1, 'x', 'API', 'kg', 'ERP-1', gen_random_uuid(), gen_random_uuid(), gen_random_uuid())", [code]);

  it('[PL-08] a write without a fact of its own transaction is refused (EBM01); a fact of another transaction does not count', async () => {
    const code = `API-${tag()}`;
    const id = randomUUID();
    await inCommand(plat, (c) => c.query("select md.record_fact('material', $1, $2, $1, 'Rabeprazole sodium', '1', true)", [code, id]));
    const e = (await inCommand(plat, (c) => insertMaterial(c, code)).catch((error: unknown) => error)) as { code?: string; detail?: string };
    expect(e.code).toBe('EBM01');
    expect(JSON.parse(e.detail ?? '{}')).toEqual({ kind: 'material', code, masterId: id });
    await inCommand(plat, async (c) => {
      await c.query("select md.record_fact('material', $1, $2, $1, 'Rabeprazole sodium', '2', true)", [code, id]);
      await insertMaterial(c, code);
    });
  });

  it('[PL-08] the database refuses an inactive or unknown item at each write path, and a read that names another master item (EBMR-MD-002)', async () => {
    const code = `API-${tag()}`;
    await expect(inCommand(plat, async (c) => {
      await c.query("select md.record_fact('material', $1, null, null, null, null, false)", [code]);
      await insertMaterial(c, code);
    })).rejects.toThrow(/EBMR-MD-001/);
    const id = randomUUID();
    await inCommand(plat, async (c) => {
      await c.query("select md.record_fact('material', $1, $2, $1, 'Mannitol', '1', true)", [code, id]);
      await insertMaterial(c, code);
    });
    await expect(inCommand(plat, async (c) => {
      await c.query("select md.record_fact('material', $1, $2, $1, 'Mannitol', '2', false)", [code, id]);
      await insertMaterial(c, code);
    })).rejects.toThrow(/EBMR-MD-001/);
    await expect(inCommand(plat, (c) => c.query("select md.record_fact('material', $1, $2, $1, 'Mannitol', '1', true)", [code, randomUUID()]))).rejects.toThrow(/EBMR-MD-002/);
    const guarded = await q<{ t: string }>(
      "select tgrelid::regclass::text || ':' || tgname as t from pg_trigger where tgname like 'ab_md_active_%' order by 1");
    expect(guarded.map((r) => r.t)).toEqual([
      'plant.area:ab_md_active_area', 'plant.equipment:ab_md_active_equipment', 'plant.equipment_use:ab_md_active_equipment_use',
      'plant.instrument_use:ab_md_active_instrument_use', 'plant.product:ab_md_active_product', 'recipe.execution_command:ab_md_active_entry',
      'site.erp_material:ab_md_active_erp_material', 'site.material_lot:ab_md_active_material_lot',
    ]);
    expect((await q<{ s: string }>("select prosrc as s from pg_proc where oid = 'recipe.require_issue_permission(text)'::regprocedure"))[0]?.s).toContain("md.require_active('product', p_product)");
  });

  it('[PL-07] a rename at core keeps the link: the local code stays, the fact keeps the code and name that applied', async () => {
    const code = `RM-${tag()}`;
    const id = await master.put('room', code, 'Granulation room 1');
    valueOf(await steward.call(routes.plant.defineArea, { body: { code, kind: 'ROOM', name: 'Granulation room 1' } }));
    await master.rename('room', id, `${code}-N`, 'Granulation room 1 (new wing)');
    const item = await plat.built.ctx.platform.master?.read('room', { masterId: id, code });
    expect(item).toMatchObject({ id, code: `${code}-N`, version: 2 });
    expect(await factsOf('room', code)).toEqual([{ master_id: id, code, name: 'Granulation room 1', version: '1', active: true }]);
    expect(await q('select code from plant.area where code = $1', [code])).toEqual([{ code }]);
  });

  it('[PL-08] the standalone build is unchanged: no master check, and ebmr_app cannot write a fact row directly', async () => {
    await expect(inCommand(solo, (c) => insertMaterial(c, `API-${tag()}`))).resolves.toBeDefined();
    await expect(plat.db.app.query("insert into md.master_fact (kind, local_code, active) values ('product', 'X', true)")).rejects.toMatchObject({ code: '42501' });
  });
});

describe('the master-data link (PL-08, DI-13)', () => {
  it('[PL-08][DI-13] the platform\'s MASTER_DATA_DATABASE_URL becomes the master read on verified TLS against the platform database\'s certificate', () => {
    const env = platformEnv({
      EBMR_DATABASE_URL: 'postgres://ebmr_app:pw@db:5432/ebmr',
      EBMR_DB_CA_FILE: '/tls-ca/server.crt',
      MASTER_DATA_DATABASE_URL: 'postgres://ebmr_app:pw@db:5432/master_data',
    });
    const u = new URL(env['EBMR_MASTER_DATA_URL'] ?? '');
    expect([u.username, u.pathname, u.searchParams.get('sslmode'), u.searchParams.get('sslrootcert')]).toEqual(['ebmr_app', '/master_data', 'verify-full', '/tls-ca/server.crt']);
    expect(platformEnv({ EBMR_DATABASE_URL: 'postgres://ebmr_app:pw@db:5432/ebmr', EBMR_DB_CA_FILE: '/tls-ca/server.crt' })['EBMR_MASTER_DATA_URL']).toBeUndefined();
  });
});
