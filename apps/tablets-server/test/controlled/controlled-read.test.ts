/**
 * Who reads controlled-substance records (Phase 7 slice 7a, 6jc-R2; draft control IN-53, status U; owner decision 0022).
 * The controlled list, the custody records, the batch account and the register exports are read only by a session
 * whose role holds CONTROLLED.READ (tablets 1400: every role holding a CONTROLLED.* permission, and QA_REVIEWER) in the
 * record's {site, product} scope; the database decides it (tablets 1413, 1414) and the application role reads none of the
 * tables or the read functions directly (recipe-core 1214). The records are test set-up written by the superuser with
 * triggers off (as in the controlled routes test); every read is the server's or the database's own.
 */
import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { routes, type Result } from '@ebmr/api-contract';
import type { TestDatabase } from '../../../../packages/kernel/test/support/db.ts';
import { tokenHash } from '../../src/platform/auth/session.ts';
import { startSigningServer, valueOf } from '../esig/support.ts';
import { grantedPerson, loginOf } from '../support/granted-person.ts';
import type { TestBrowser, TestServer } from '../support/harness.ts';

let server: TestServer;
let db: TestDatabase;
let operator: TestBrowser;
let admin: TestBrowser;
let custodian: TestBrowser;
let qa: TestBrowser;
let otherProduct: TestBrowser;
let ownProduct: TestBrowser;
let otherSite: TestBrowser;

const tag = (): string => randomUUID().slice(0, 6).toUpperCase();
const material = `API-CTR-${tag()}`;
const product = `PCTR-${tag()}`;
const lotId = randomUUID();
const batchId = randomUUID();
const dispenseId = randomUUID();
const transferId = randomUUID();
const productRecordId = randomUUID();
const checkpointId = randomUUID();
const extractId = randomUUID();

async function setup(sql: string, params: unknown[]): Promise<void> {
  const c = await db.admin.connect();
  try {
    await c.query('begin');
    await c.query('set local session_replication_role = replica');
    await c.query(sql, params);
    await c.query('commit');
  } finally {
    c.release();
  }
}

beforeAll(async () => {
  server = await startSigningServer('GMP');
  db = server.db as unknown as TestDatabase;
  [operator, custodian, qa] = await Promise.all([server.asPersona('operator1'), server.asPersona('stores'), server.asPersona('qaInvestigator')]);
  admin = await loginOf(server, await grantedPerson(server, 'SYSTEM_ADMINISTRATOR', 'Sanjay Kulkarni'));
  otherProduct = await loginOf(server, await grantedPerson(server, 'QA_REVIEWER', 'Leela Iyer', undefined, { product: `POTHER-${tag()}` }));
  ownProduct = await loginOf(server, await grantedPerson(server, 'QA_REVIEWER', 'Farah Khan', undefined, { product }));
  otherSite = await loginOf(server, await grantedPerson(server, 'QA_REVIEWER', 'Vikram Rao', undefined, { site: 'SITE-9' }));
  const who = randomUUID();
  const hash = createHash('sha256').update(batchId).digest('hex');
  const cr = randomUUID();
  await setup(
    `insert into site.erp_material (material_code, material_name, material_kind, unit, erp_reference, received_by_person, received_by_account, correlation_id)
     values ($1, 'Controlled API', 'API', 'kg', 'ERP-CTR', $2, $2, $2)`,
    [material, who],
  );
  await setup(
    `insert into site.material_lot (id, site_code, lot_code, material_code, material_name, material_kind, received_quantity, unit, expires_at,
                                    received_by_person, received_by_account, correlation_id)
     values ($1, 'SITE-1', $2, $3, 'Controlled API', 'API', 10, 'kg', '2030-01-01T00:00:00Z', $4, $4, $4)`,
    [lotId, `L-${tag()}`, material, who],
  );
  await setup(
    `insert into recipe.control_recipe (id, batch_id, pin_id, version_id, mbr_content_hash, snapshot, snapshot_hash, person_id, account_id)
     values ($1, $4, gen_random_uuid(), gen_random_uuid(), $2, $3::jsonb, $2, gen_random_uuid(), gen_random_uuid())`,
    [cr, hash, JSON.stringify({ mbr: { content: { header: { product: { code: product, name: 'Controlled tablets', strength: '10 mg' } } } } }), batchId],
  );
  await setup(
    `insert into recipe.batch_execution (id, batch_number, control_recipe_id, issue_signature_id, content_hash, installation, purpose, engine_version, registry_fingerprint,
                                         policy, policy_hash, issue_request, market_set, batch_size, site_code, site_zone, issued_at_us, issued_by_person, issued_by_account, correlation_id)
     values ($1, $2, $3, gen_random_uuid(), $4, 'GMP', 'GMP_BATCH', '1', $4, '{}', $4, '{}', '{IN}', 'BS', 'SITE-1', 'Asia/Kolkata', 0, gen_random_uuid(), gen_random_uuid(), gen_random_uuid())`,
    [batchId, `B26-${tag()}`, cr, hash],
  );
  await setup(
    `insert into plant.controlled_product (id, product_code, controlled, material_codes, basis_ref, recorded_by_person, recorded_by_account, correlation_id)
     values ($1, $2, true, array[$3], 'NDPS licence ML-17 (draft)', $4, $4, $4)`,
    [productRecordId, product, material, who],
  );
  await setup(
    `insert into plant.controlled_product_approval (record_id, signature_id, approved_by_person, approved_by_account) values ($1, gen_random_uuid(), $2, $2)`,
    [productRecordId, who],
  );
  await setup(
    `insert into recipe.controlled_custody (id, kind, lot_id, material_code, quantity, unit, batch_id, from_location, to_location, proposed_by_person, proposed_by_account, correlation_id)
     values ($1, 'DISPENSE', $3, $4, 1.5, 'kg', $5, null, null, $6, $6, $6),
            ($2, 'TRANSFER', $3, $4, 2, 'kg', null, 'WH-A-01', 'DISP-01', $6, $6, $6)`,
    [dispenseId, transferId, lotId, material, batchId, who],
  );
  await setup(
    `insert into recipe.controlled_checkpoint (id, batch_id, stage_key, material_code, unit, dispensed, consumed, in_process, returned, destroyed, difference,
                                               recorded_by_person, recorded_by_account, correlation_id)
     values ($1, $2, 'S1', $3, 'kg', 0, 0, 0, 0, 0, 0, $4, $4, $4)`,
    [checkpointId, batchId, material, who],
  );
  await setup(
    `insert into recipe.controlled_register_extract (id, material_code, period_from, period_to, query_version, result, result_sha256, run_by_person, run_by_account, role_code, correlation_id)
     values ($1, $2, '2026-01-01', '2026-02-01', 1, $5::jsonb, $3, $4, $4, 'QA_REVIEWER', $4)`,
    [extractId, material, 'a'.repeat(64), who,
     JSON.stringify({ queryVersion: 1, materialCode: material, from: '2026-01-01', to: '2026-02-01', statusNote: 'Draft control IN-53', rows: [], totals: {} })],
  );
}, 600_000);
afterAll(async () => {
  await server?.close();
});

const hashOf = (b: TestBrowser): string => tokenHash(b.cookies.get(server.config.cookies.session) ?? '');

/** The five gated reads of tablets 1413 for a browser's session: 'ok:<count>' or the code it was refused with. */
type ReadName = 'list' | 'custody' | 'checkpoints' | 'balance' | 'register';
async function dbReads(b: TestBrowser): Promise<Record<ReadName, string>> {
  const h = hashOf(b);
  const reads: Record<ReadName, [string, unknown[]]> = {
    list: ['select tab.controlled_products($1, $2) as r', [h, product]],
    custody: ['select tab.controlled_custody($1, $2, null, null) as r', [h, lotId]],
    checkpoints: ['select tab.controlled_checkpoints($1, $2, null) as r', [h, batchId]],
    balance: ['select jsonb_build_array(tab.controlled_balance($1, $2)) as r', [h, batchId]],
    register: ['select tab.controlled_register_extracts($1, $2) as r', [h, extractId]],
  };
  const out = {} as Record<ReadName, string>;
  for (const [name, [sql, args]] of Object.entries(reads) as [ReadName, [string, unknown[]]][]) {
    try {
      const r = (await db.app.query<{ r: unknown[] }>(sql, args)).rows[0]?.r ?? [];
      out[name] = `ok:${r.length}`;
    } catch (e) {
      out[name] = /EBMR-[A-Z]+-\d{3}/.exec((e as Error).message)?.[0] ?? (e as Error).message;
    }
  }
  return out;
}

const outcome = (r: Result<unknown>): string => (r.ok ? 'ok' : r.error.kind === 'REFUSAL' ? `${r.error.status}:${r.error.envelope.refusal.code}` : r.error.kind);

/** The five reads over HTTP: 'ok' or '<status>:<code>'. */
async function httpReads(b: TestBrowser): Promise<Record<string, string>> {
  return {
    list: outcome(await b.call(routes.controlled.products)),
    custody: outcome(await b.call(routes.controlled.custody, { query: { lotId } })),
    balance: outcome(await b.call(routes.controlled.balance, { params: { batchId } })),
    registerList: outcome(await b.call(routes.controlled.registerExtracts)),
    register: outcome(await b.call(routes.controlled.registerExtract, { params: { extractId } })),
  };
}

describe('controlled-substance reads need CONTROLLED.READ (IN-53, draft; 6jc-R2)', () => {
  it('[IN-53] the controlled register and balance reads need CONTROLLED.READ', async () => {
    const may = (await db.admin.query<{ role: string; read: boolean }>(
      "select r.role as role, tab.role_may(r.role, array['CONTROLLED.READ']) as read from unnest(array['OPERATOR', 'SYSTEM_ADMINISTRATOR', 'WAREHOUSE_LABELLING', 'QA_REVIEWER']) r(role) order by 1",
    )).rows;
    expect(may, 'SETUP: the operator and the administrator hold no CONTROLLED.READ; the custodian and QA do').toEqual([
      { role: 'OPERATOR', read: false }, { role: 'QA_REVIEWER', read: true }, { role: 'SYSTEM_ADMINISTRATOR', read: false }, { role: 'WAREHOUSE_LABELLING', read: true },
    ]);
    const refused = { list: 'EBMR-CSM-060', custody: 'EBMR-CSM-060', checkpoints: 'EBMR-CSM-060', balance: 'EBMR-CSM-060', register: 'EBMR-CSM-060' };
    expect(await dbReads(operator), 'an operator').toEqual(refused);
    expect(await dbReads(admin), 'a system administrator').toEqual(refused);
    const allowed = { list: 'ok:1', custody: 'ok:2', checkpoints: 'ok:1', balance: 'ok:1', register: 'ok:1' };
    expect(await dbReads(custodian), 'a custodian').toEqual(allowed);
    expect(await dbReads(qa), 'QA').toEqual(allowed);
    // Without a session the reads are refused before anything is read (EBMR-TAB-018).
    await expect(db.app.query('select tab.controlled_balance($1, $2)', ['0'.repeat(64), batchId])).rejects.toThrow(/EBMR-TAB-018/);
  });

  it('[IN-53] the application role reads no controlled-substance table or read function directly (recipe-core 1214; bypass)', async () => {
    const tables = ['plant.controlled_product', 'plant.controlled_product_approval', 'recipe.controlled_custody', 'recipe.controlled_custody_signature',
      'recipe.controlled_custody_use', 'recipe.controlled_checkpoint', 'recipe.controlled_checkpoint_signature', 'recipe.controlled_register_extract'];
    for (const t of tables) await expect(db.app.query(`select count(*) from ${t}`), t).rejects.toThrow(/permission denied/);
    const reads: [string, unknown[]][] = [
      ['select plant.controlled_materials($1)', [product]],
      ['select plant.material_is_controlled($1)', [material]],
      ['select plant.controlled_product_state($1)', [product]],
      ['select plant.controlled_record_state($1)', [productRecordId]],
      ['select recipe.batch_controlled_materials($1)', [batchId]],
      ['select recipe.controlled_moved_materials($1)', [batchId]],
      ['select recipe.controlled_custody_state($1)', [dispenseId]],
      ['select recipe.controlled_custodians($1)', [dispenseId]],
      ['select recipe.controlled_balance($1, $2)', [batchId, material]],
      ['select recipe.controlled_checkpoint_state($1)', [checkpointId]],
      ['select recipe.controlled_checkpoint_current($1)', [checkpointId]],
      ['select recipe.controlled_checkpoint_problem($1, $2)', [batchId, 'S1']],
      ['select recipe.controlled_batch_end_problem($1)', [batchId]],
      ['select recipe.controlled_register_reproduces($1)', [extractId]],
      ['select tab.controlled_checkpoint_rows($1, null)', [batchId]],
      ['select tab.controlled_reader_problem(row(null, null, null, $1, false)::tab.reader, null, null, true)', ['QA_REVIEWER']],
    ];
    for (const [sql, args] of reads) await expect(db.app.query(sql, args), sql).rejects.toThrow(/permission denied/);
  });

  it('[IN-53] each controlled read over HTTP answers 403 with EBMR-CSM-060 for a session without CONTROLLED.READ; a custodian and QA read them', async () => {
    const refused = { list: '403:EBMR-CSM-060', custody: '403:EBMR-CSM-060', balance: '403:EBMR-CSM-060', registerList: '403:EBMR-CSM-060', register: '403:EBMR-CSM-060' };
    expect(await httpReads(operator), 'an operator').toEqual(refused);
    expect(await httpReads(admin), 'a system administrator').toEqual(refused);
    const allowed = { list: 'ok', custody: 'ok', balance: 'ok', registerList: 'ok', register: 'ok' };
    expect(await httpReads(custodian), 'a custodian').toEqual(allowed);
    expect(await httpReads(qa), 'QA').toEqual(allowed);
    const bal = valueOf(await qa.call(routes.controlled.balance, { params: { batchId } }));
    expect(bal).toMatchObject({ productCode: product, materials: [{ materialCode: material, dispensed: '0', checkpoints: [{ checkpointId, stageKey: 'S1', state: 'RECORDED' }] }] });
    expect(valueOf(await custodian.call(routes.controlled.custody, { query: { lotId } })).records.map((r) => r.custodyId).sort()).toEqual([dispenseId, transferId].sort());
  });

  it('[IN-53] a CONTROLLED.READ holder limited to another product or site is refused; one limited to the product reads only that product\'s records', async () => {
    // A batch's account, a custody record naming the batch, its checkpoints: the batch's {site, product}.
    for (const [who, b, code] of [['another product', otherProduct, 'EBMR-CSM-061'], ['another site', otherSite, 'EBMR-CSM-060|EBMR-CSM-061']] as const) {
      const r = await dbReads(b);
      expect(r.balance, who).toMatch(new RegExp(`^(${code})$`));
      expect(r.checkpoints, who).toMatch(new RegExp(`^(${code})$`));
      expect(r.register, who).toMatch(/^EBMR-CSM-06[01]$/);
      expect(outcome(await b.call(routes.controlled.balance, { params: { batchId } })), who).toMatch(/^403:EBMR-CSM-06[01]$/);
      await expect(db.app.query('select tab.controlled_custody($1, null, null, $2)', [hashOf(b), dispenseId]), who).rejects.toThrow(/EBMR-CSM-06[01]/);
    }
    // The product-limited holder lists no record of another product, and no custody record without a product.
    expect((await dbReads(otherProduct)).list).toBe('ok:0');
    expect((await dbReads(otherProduct)).custody).toBe('ok:0');
    // The holder limited to this product reads its flag, account and the dispensing to its batch; the transfer (no
    // batch, so no product) and the register (every product of the material) need a grant without a product limit.
    const own = await dbReads(ownProduct);
    expect(own).toEqual({ list: 'ok:1', custody: 'ok:1', checkpoints: 'ok:1', balance: 'ok:1', register: 'EBMR-CSM-061' });
    const rows = (await db.app.query<{ r: { id: string }[] }>('select tab.controlled_custody($1, $2, null, null) as r', [hashOf(ownProduct), lotId])).rows[0]?.r ?? [];
    expect(rows.map((x) => x.id)).toEqual([dispenseId]);
    await expect(db.app.query('select tab.controlled_custody($1, null, null, $2)', [hashOf(ownProduct), transferId])).rejects.toThrow(/EBMR-CSM-061/);
  });

  it('[IN-53] a controlled record is read as content to be signed, or through its signatures and their audit chains, only with CONTROLLED.READ in its scope (tablets 1414)', async () => {
    const problem = async (b: TestBrowser, type: string, id: string): Promise<string | null> =>
      (await db.admin.query<{ p: string | null }>('select tab.record_read_problem(tab.reader_of($1), $2, $3) as p', [hashOf(b), type, id])).rows[0]?.p ?? null;
    // QA_REVIEWER holds CONTROLLED.APPROVE and a governance read permission: it passes the rule of 1290 for every type.
    for (const [type, id] of [['controlled_product', productRecordId], ['controlled_custody', dispenseId], ['controlled_checkpoint', checkpointId]] as const) {
      expect(await problem(qa, type, id), `${type} by QA`).toBeNull();
      expect(await problem(ownProduct, type, id), `${type} by QA limited to the product`).toBeNull();
      expect(await problem(otherProduct, type, id), `${type} by QA limited to another product`).toMatch(/holds CONTROLLED\.READ in no grant covering scope .*\(IN-53\)$/);
      expect(await problem(operator, type, id), `${type} by an operator`).toMatch(/^controlled_\w+ records are read only by the roles that record or sign them \(IN-53\); the role OPERATOR does not$/);
    }
    // The transfer names no batch: only a grant without a product limit covers it.
    expect(await problem(ownProduct, 'controlled_custody', transferId)).toMatch(/no grant covering scope/);
    expect(await problem(qa, 'controlled_custody', transferId)).toBeNull();
    // The signing preview of tablets 1250 asks the same rule after the meaning's permission.
    const preview = (b: TestBrowser): Promise<unknown> =>
      db.app.query('select tab.controlled_preview($1, $2, $3, $4)', [hashOf(b), 'controlled_product', productRecordId, 'CONTROLLED_PRODUCT_APPROVED']);
    await expect(preview(otherProduct)).rejects.toThrow(/EBMR-CSM-061/);
    await expect(preview(qa)).resolves.toBeDefined();
    await expect(preview(operator)).rejects.toThrow(/EBMR-TAB-020/);
  });
});
