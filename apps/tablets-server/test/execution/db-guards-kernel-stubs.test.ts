/**
 * Phase 2 exit follow-up F12.KERNEL (DI-05, INV-18; kernel 1030; ADR 0012): the kernel's stub tables, which the
 * application role writes directly, under the sandbox identifier rule.
 *
 * Decision F12.7 reported to the lead that the stand-ins for the GMP master data (market.stub_batch.batch_number,
 * market.stub_material_lot.code, market.stub_pack.code and the stubs' free text) carried no sandbox guard: a sandbox
 * stored a real-format lot or batch number in them, and a GMP installation a reserved TEST- one. Kernel 1030 puts
 * sandbox.guard_identifier on the three identifiers and sandbox.guard_free_text on the stubs' free text. Both
 * installations are tested: a GMP installation keeps its real identifiers and its texts and refuses TEST- identifiers
 * (EBMR-SBX-021); the sandbox refuses real-format ones (EBMR-SBX-022, and EBMR-SBX-024 in free text).
 *
 * The writer is the application role (ebmr_app in GMP, ebmr_sandbox in the sandbox) in a command of the master-data
 * steward persona, who holds MASTERDATA.CHANGE (kernel 0310's statement trigger asks for it before any row trigger).
 */
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withCommand } from '@ebmr/kernel';
import { openPersonaSession } from '@ebmr/test-kit';
import { startServer, type TestServer } from '../support/harness.ts';
import { codeOf } from './db-guards-support.ts';

let gmp: TestServer;
let sbx: TestServer;
beforeAll(async () => {
  [gmp, sbx] = await Promise.all([startServer('GMP'), startServer('SANDBOX')]);
}, 180_000);
afterAll(async () => {
  await Promise.all([gmp?.close(), sbx?.close()]);
});

const LOT = 'L2409-0017';
const BATCH = 'B24-0001';

/** `work` through the application role in a command of the steward persona of `server`; 'ok' or the refusal's code. */
async function asSteward(server: TestServer, work: (c: pg.PoolClient) => Promise<unknown>): Promise<string> {
  const steward = await openPersonaSession(server.db, server.seed, 'steward');
  return codeOf(withCommand(server.db.app, { ...steward, correlationId: randomUUID() }, work));
}

/** A stub product made for India, its code unique to the call. */
async function product(server: TestServer): Promise<string> {
  let id = '';
  const out = await asSteward(server, async (c) => {
    const { rows } = await c.query<{ id: string }>("insert into market.stub_product (code, edition, markets) values ($1, 'tablets', '{IN}') returning id", [`PRD-${randomUUID().slice(0, 8)}`]);
    id = rows[0]?.id ?? '';
  });
  if (out !== 'ok') throw new Error(`SETUP: stub product refused: ${out}`);
  return id;
}

async function stored(server: TestServer, sql: string, value: string): Promise<number> {
  return (await server.db.admin.query(sql, [value])).rowCount ?? 0;
}

describe('F12.KERNEL: the kernel\'s stub tables under the sandbox identifier rule (DI-05, INV-18)', () => {
  it('[DI-05][INV-18] F12.KERNEL (kernel 1030): in the sandbox a stub material lot, stub batch and stub pack carry test identifiers only: L2409-0017, B24-0001 and the pack L2409-0017/1 are refused (EBMR-SBX-022) and none is stored, the TEST- ones are stored; a GMP installation keeps the real ones and refuses the TEST- ones (EBMR-SBX-021)', async () => {
    const lot = (code: string) => (c: pg.PoolClient) => c.query('insert into market.stub_material_lot (code) values ($1)', [code]);
    const batch = (number: string, productId: string) => (c: pg.PoolClient) =>
      c.query("insert into market.stub_batch (batch_number, product_id, markets) values ($1, $2, '{IN}') returning id", [number, productId]);
    const pack = (code: string, batchNumber: string) => (c: pg.PoolClient) =>
      c.query("insert into market.stub_pack (code, batch_id, destination) select $1, b.id, 'IN' from market.stub_batch b where b.batch_number = $2", [code, batchNumber]);

    const sProduct = await product(sbx);
    const gProduct = await product(gmp);
    const outcomes = {
      sandbox: {
        realLot: await asSteward(sbx, lot(LOT)),
        realBatch: await asSteward(sbx, batch(BATCH, sProduct)),
        testLot: await asSteward(sbx, lot('TEST-L26-0901')),
        testBatch: await asSteward(sbx, batch('TEST-B26-0901', sProduct)),
        realPack: await asSteward(sbx, pack(`${LOT}/1`, 'TEST-B26-0901')),
        testPack: await asSteward(sbx, pack('TEST-PK-0901', 'TEST-B26-0901')),
        // An update to a real-format identifier is refused too.
        lotRenamed: await asSteward(sbx, (c) => c.query("update market.stub_material_lot set code = $1 where code = 'TEST-L26-0901'", [LOT])),
      },
      gmp: {
        realLot: await asSteward(gmp, lot(LOT)),
        realBatch: await asSteward(gmp, batch(BATCH, gProduct)),
        realPack: await asSteward(gmp, pack(`${LOT}/1`, BATCH)),
        testLot: await asSteward(gmp, lot('TEST-L26-0901')),
        testBatch: await asSteward(gmp, batch('TEST-B26-0901', gProduct)),
        testPack: await asSteward(gmp, pack('TEST-PK-0901', BATCH)),
      },
    };
    expect(outcomes).toEqual({
      sandbox: { realLot: 'EBMR-SBX-022', realBatch: 'EBMR-SBX-022', testLot: 'ok', testBatch: 'ok', realPack: 'EBMR-SBX-022', testPack: 'ok', lotRenamed: 'EBMR-SBX-022' },
      gmp: { realLot: 'ok', realBatch: 'ok', realPack: 'ok', testLot: 'EBMR-SBX-021', testBatch: 'EBMR-SBX-021', testPack: 'EBMR-SBX-021' },
    });
    const held = async (server: TestServer) => ({
      lots: await stored(server, 'select 1 from market.stub_material_lot where code like $1', '%2409-0017%'),
      batches: await stored(server, 'select 1 from market.stub_batch where batch_number = $1', BATCH),
      packs: await stored(server, 'select 1 from market.stub_pack where code like $1', '%2409-0017%'),
    });
    expect(await held(sbx)).toEqual({ lots: 0, batches: 0, packs: 0 });
    expect(await held(gmp)).toEqual({ lots: 1, batches: 1, packs: 1 });
  }, 180_000);

  it('[DI-05][INV-18] F12.KERNEL (kernel 1030): in the sandbox the stubs\' free text names no real-format batch or lot: a stub site\'s or product\'s predicates, a stub MBR limit\'s value and predicates, a stub signable\'s title, value and unit, a sample record\'s title and body, each holding L2409-0017 or B24-0001 (nested, in prose, in lower case, in full-width letters), are refused (EBMR-SBX-024) and nothing holds them; prose and TEST- identifiers are stored; a GMP installation keeps the same texts', async () => {
    const texts = {
      sitePredicates: (v: string) => (c: pg.PoolClient) =>
        c.query("insert into market.stub_site (code, markets, predicates) values ($1, '{IN}', $2::jsonb)", [`SITE-${randomUUID().slice(0, 8)}`, JSON.stringify({ note: { last: [v] } })]),
      productPredicates: (v: string) => (c: pg.PoolClient) =>
        c.query("insert into market.stub_product (code, edition, markets, predicates) values ($1, 'tablets', '{IN}', $2::jsonb)", [`PRD-${randomUUID().slice(0, 8)}`, JSON.stringify({ [v]: true })]),
      limitValue: (v: string) => (c: pg.PoolClient) =>
        c.query("insert into market.stub_mbr_limit (mbr_code, mbr_version, key, value, markets) values ($1, 1, 'blend.time', $2::jsonb, '{IN}')", [`MBR-${randomUUID().slice(0, 8)}`, JSON.stringify({ min: '10', source: v })]),
      signableTitle: (v: string) => (c: pg.PoolClient) => c.query("insert into esig.stub_signable (kind, title, value, unit) values ('STEP', $1, '12.503', 'kg')", [v]),
      signableValue: (v: string) => (c: pg.PoolClient) => c.query("insert into esig.stub_signable (kind, title, value, unit) values ('STEP', 'Binder added', $1, 'kg')", [v]),
      recordBody: (v: string) => (c: pg.PoolClient) => c.query("insert into platform.stub_record (title, body) values ('Cleaning record', $1)", [v]),
    };
    const sandboxOutcomes: Record<string, string> = {};
    const gmpOutcomes: Record<string, string> = {};
    for (const [name, write] of Object.entries(texts)) {
      for (const [variant, v] of Object.entries({ real: `Drum of lot ${LOT} checked`, batch: `after batch ${BATCH}`, lower: 'l2409-0017', wide: 'Ｌ２４０９－００１７' })) {
        sandboxOutcomes[`${name}.${variant}`] = await asSteward(sbx, write(v));
      }
      sandboxOutcomes[`${name}.prose`] = await asSteward(sbx, write('Checked twice on the 2nd shift: 12.5 g, 100% of drums, TEST-L26-0101 quarantined'));
      gmpOutcomes[`${name}.real`] = await asSteward(gmp, write(`Drum of lot ${LOT} checked`));
    }
    const expected: Record<string, string> = {};
    for (const name of Object.keys(texts)) {
      for (const variant of ['real', 'batch', 'lower', 'wide']) expected[`${name}.${variant}`] = 'EBMR-SBX-024';
      expected[`${name}.prose`] = 'ok';
    }
    expect(sandboxOutcomes).toEqual(expected);
    expect(gmpOutcomes).toEqual(Object.fromEntries(Object.keys(texts).map((n) => [`${n}.real`, 'ok'])));
    const holding = await sbx.db.admin.query(
      `select 1 from market.stub_site where predicates::text ~* '2409' union all select 1 from market.stub_product where predicates::text ~* '2409'
       union all select 1 from market.stub_mbr_limit where value::text ~* '2409' union all select 1 from esig.stub_signable where title || value ~* '2409|B24-0001'
       union all select 1 from platform.stub_record where body ~* '2409'`,
    );
    expect(holding.rowCount).toBe(0);
    // The message names the table and the column, never the word (a log that records the refusal does not copy it).
    const steward = await openPersonaSession(sbx.db, sbx.seed, 'steward');
    await expect(withCommand(sbx.db.app, { ...steward, correlationId: randomUUID() }, (c) => c.query("insert into platform.stub_record (title, body) values ('Cleaning record', 'lot L2409-0017')"))).rejects.toThrow(
      /^platform\.stub_record body holds a word of the form of a batch or lot number that is not a test one: in the sandbox a text names a batch, lot or container only by a TEST- identifier \(for example TEST-L24-0001\), or describes it in words, so a real GMP identifier is never reused \(DI-05, INV-18\)\. \[EBMR-SBX-024\]$/,
    );
  }, 180_000);
});
