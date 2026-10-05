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

/** The stubs' free text, each written by the application role (kernel 1030's list). */
const STUB_TEXTS = {
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
    const texts = STUB_TEXTS;
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

  it('[DI-05][DI-30][INV-18] kernel 1050: in the sandbox the stubs\' free text holding L2409-0017 with a soft hyphen, a zero-width space or a variation selector after the L, BATCH/2409/0017 with the division slash or in Cyrillic capitals, or L2409-0017 in Devanagari digits, is refused (EBMR-SBX-024) and nothing holds it; prose with an emoji and a soft hyphen in a long word is stored; a GMP installation keeps the same texts', async () => {
    const ch = (cp: number): string => String.fromCodePoint(cp);
    const shown = {
      softHyphen: `Drum of lot L${ch(0xad)}2409-0017 checked`,
      zeroWidthSpace: `Drum of lot L${ch(0x200b)}2409-0017 checked`,
      variationSelector: `Drum of lot L${ch(0xfe0f)}2409-0017 checked`,
      divisionSlash: `after BATCH${ch(0x2215)}2409${ch(0x2215)}0017`,
      cyrillic: 'after ВАТСН/2409/0017',
      devanagariDigits: 'Drum of lot L२४०९-००१७ checked',
    };
    const sandboxOutcomes: Record<string, string> = {};
    const gmpOutcomes: Record<string, string> = {};
    for (const [name, write] of Object.entries(STUB_TEXTS)) {
      for (const [variant, v] of Object.entries(shown)) sandboxOutcomes[`${name}.${variant}`] = await asSteward(sbx, write(v));
      sandboxOutcomes[`${name}.prose`] = await asSteward(sbx, write(`Checked ${ch(0x2714)}${ch(0xfe0f)} on the 2nd shift: pharma${ch(0xad)}ceutical grade, TEST-L26-0101 quarantined`));
      gmpOutcomes[`${name}.softHyphen`] = await asSteward(gmp, write(shown.softHyphen));
    }
    const expected: Record<string, string> = {};
    for (const name of Object.keys(STUB_TEXTS)) {
      for (const variant of Object.keys(shown)) expected[`${name}.${variant}`] = 'EBMR-SBX-024';
      expected[`${name}.prose`] = 'ok';
    }
    expect(sandboxOutcomes).toEqual(expected);
    expect(gmpOutcomes).toEqual(Object.fromEntries(Object.keys(STUB_TEXTS).map((n) => [`${n}.softHyphen`, 'ok'])));
    const holding = await sbx.db.admin.query(
      `select 1 from market.stub_site where predicates::text ~ '2409|२४०९' union all select 1 from market.stub_product where predicates::text ~ '2409|२४०९'
       union all select 1 from market.stub_mbr_limit where value::text ~ '2409|२४०९' union all select 1 from esig.stub_signable where title || value ~ '2409|२४०९'
       union all select 1 from platform.stub_record where body ~ '2409|२४०९'`,
    );
    expect(holding.rowCount).toBe(0);
  }, 180_000);

  it('[DI-05][DI-30][INV-18] kernel 1090: in the sandbox the stubs\' free text holding L2409-0017 with U+FFFC (laid out with no advance and no ink by the E2E browser) or the spacing marks U+1031 or U+0C03 after the L, or B24-0001 with U+FFFC after the B, is refused (EBMR-SBX-024) and nothing holds it; Hindi prose with its vowel signs is stored; a GMP installation keeps the same texts', async () => {
    const ch = (cp: number): string => String.fromCodePoint(cp);
    const shown = {
      objectReplacement: `Drum of lot L${ch(0xfffc)}2409-0017 checked`,
      objectReplacementBatch: `after batch B${ch(0xfffc)}24-0001`,
      myanmarE: `Drum of lot L${ch(0x1031)}2409-0017 checked`,
      teluguVisarga: `Drum of lot L${ch(0xc03)}2409-0017 checked`,
    };
    const sandboxOutcomes: Record<string, string> = {};
    const gmpOutcomes: Record<string, string> = {};
    for (const [name, write] of Object.entries(STUB_TEXTS)) {
      for (const [variant, v] of Object.entries(shown)) sandboxOutcomes[`${name}.${variant}`] = await asSteward(sbx, write(v));
      // The number apart from the word: 25वां is refused in the sandbox since kernel 1120 (decision F12.14).
      sandboxOutcomes[`${name}.prose`] = await asSteward(sbx, write('ड्रम को साफ़ किया गया, बैच 25, TEST-L26-0101 अलग रखा गया'));
      gmpOutcomes[`${name}.objectReplacement`] = await asSteward(gmp, write(shown.objectReplacement));
    }
    const expected: Record<string, string> = {};
    for (const name of Object.keys(STUB_TEXTS)) {
      for (const variant of Object.keys(shown)) expected[`${name}.${variant}`] = 'EBMR-SBX-024';
      expected[`${name}.prose`] = 'ok';
    }
    expect(sandboxOutcomes).toEqual(expected);
    expect(gmpOutcomes).toEqual(Object.fromEntries(Object.keys(STUB_TEXTS).map((n) => [`${n}.objectReplacement`, 'ok'])));
    const holding = await sbx.db.admin.query(
      `select 1 from market.stub_site where predicates::text ~ '2409|24-0001' union all select 1 from market.stub_product where predicates::text ~ '2409|24-0001'
       union all select 1 from market.stub_mbr_limit where value::text ~ '2409|24-0001' union all select 1 from esig.stub_signable where title || value ~ '2409|24-0001'
       union all select 1 from platform.stub_record where body ~ '2409|24-0001'`,
    );
    expect(holding.rowCount).toBe(0);
  }, 180_000);

  it('[DI-05][DI-30][INV-18] kernel 1100: in the sandbox the stubs\' free text holding L2409-0017 or L24-0001 written with the Armenian capital LIWN or the Canadian syllabic MAA for the L (letters the E2E browser draws as L), or L2409-0017 with U+1D1A0 after the L, is refused (EBMR-SBX-024) and nothing holds it; Hindi and Greek prose are stored; a GMP installation keeps the same texts', async () => {
    const ch = (cp: number): string => String.fromCodePoint(cp);
    const drawn = {
      armenianLiwn: `Drum of lot ${ch(0x53c)}2409-0017 checked`,
      armenianLiwnBatch: `after lot ${ch(0x53c)}24-0001`,
      syllabicsMaa: `Drum of lot ${ch(0x14ab)}2409-0017 checked`,
      ornamentStroke: `Drum of lot L${ch(0x1d1a0)}2409-0017 checked`,
    };
    const sandboxOutcomes: Record<string, string> = {};
    const gmpOutcomes: Record<string, string> = {};
    for (const [name, write] of Object.entries(STUB_TEXTS)) {
      for (const [variant, v] of Object.entries(drawn)) sandboxOutcomes[`${name}.${variant}`] = await asSteward(sbx, write(v));
      sandboxOutcomes[`${name}.prose`] = await asSteward(sbx, write('ड्रम 3 तौला गया, Το δοχείο 3, TEST-L26-0101'));
      gmpOutcomes[`${name}.armenianLiwn`] = await asSteward(gmp, write(drawn.armenianLiwn));
    }
    const expected: Record<string, string> = {};
    for (const name of Object.keys(STUB_TEXTS)) {
      for (const variant of Object.keys(drawn)) expected[`${name}.${variant}`] = 'EBMR-SBX-024';
      expected[`${name}.prose`] = 'ok';
    }
    expect(sandboxOutcomes).toEqual(expected);
    expect(gmpOutcomes).toEqual(Object.fromEntries(Object.keys(STUB_TEXTS).map((n) => [`${n}.armenianLiwn`, 'ok'])));
    const holding = await sbx.db.admin.query(
      `select 1 from market.stub_site where predicates::text ~ '2409|24-0001' union all select 1 from market.stub_product where predicates::text ~ '2409|24-0001'
       union all select 1 from market.stub_mbr_limit where value::text ~ '2409|24-0001' union all select 1 from esig.stub_signable where title || value ~ '2409|24-0001'
       union all select 1 from platform.stub_record where body ~ '2409|24-0001'`,
    );
    expect(holding.rowCount).toBe(0);
  }, 180_000);

  it('[DI-05][DI-30][INV-18] kernel 1110: in the sandbox the stubs\' free text holding L2409-0017 written with the Masaram Gondi letter E or B24-0001 written with the Old Italic HE (drawn as L in bold and as B) is refused (EBMR-SBX-024) and nothing holds it; Hindi and Greek prose are stored; a GMP installation keeps the same texts', async () => {
    const ch = (cp: number): string => String.fromCodePoint(cp);
    const drawn = {
      masaramGondiE: `Drum of lot ${ch(0x11d06)}2409-0017 checked`,
      oldItalicHe: `after batch ${ch(0x10307)}24-0001`,
    };
    const sandboxOutcomes: Record<string, string> = {};
    const gmpOutcomes: Record<string, string> = {};
    for (const [name, write] of Object.entries(STUB_TEXTS)) {
      for (const [variant, v] of Object.entries(drawn)) sandboxOutcomes[`${name}.${variant}`] = await asSteward(sbx, write(v));
      sandboxOutcomes[`${name}.prose`] = await asSteward(sbx, write('ड्रम 3 तौला गया, Το δοχείο 3, TEST-L26-0101'));
      gmpOutcomes[`${name}.masaramGondiE`] = await asSteward(gmp, write(drawn.masaramGondiE));
    }
    const expected: Record<string, string> = {};
    for (const name of Object.keys(STUB_TEXTS)) {
      for (const variant of Object.keys(drawn)) expected[`${name}.${variant}`] = 'EBMR-SBX-024';
      expected[`${name}.prose`] = 'ok';
    }
    expect(sandboxOutcomes).toEqual(expected);
    expect(gmpOutcomes).toEqual(Object.fromEntries(Object.keys(STUB_TEXTS).map((n) => [`${n}.masaramGondiE`, 'ok'])));
    const holding = await sbx.db.admin.query(
      `select 1 from market.stub_site where predicates::text ~ '2409|24-0001' union all select 1 from market.stub_product where predicates::text ~ '2409|24-0001'
       union all select 1 from market.stub_mbr_limit where value::text ~ '2409|24-0001' union all select 1 from esig.stub_signable where title || value ~ '2409|24-0001'
       union all select 1 from platform.stub_record where body ~ '2409|24-0001'`,
    );
    expect(holding.rowCount).toBe(0);
  }, 180_000);
});
