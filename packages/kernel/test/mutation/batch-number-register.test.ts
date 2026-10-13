/**
 * The site batch-number register, guard by guard (SQL mutation group "batch-number-register": site.render_batch_number,
 * define_batch_number_rule, rule_in_force, allocate_batch_number, register_external_batch_number, void_batch_number,
 * batch_number_pattern and recover_batch_number in site-services 0600). The scenario tests in
 * packages/site-services/test/batch-number-register.test.ts go through the TypeScript wrappers, which shape the
 * requests and check some values before the database sees them; these tests call the database functions directly as
 * the application role (the kernel imports nothing from site services), so every refusal is proven where it is
 * enforced, with its own error code and message, and nothing is written after it.
 *
 * Controls: IN-18 (configurable batch-number generator, site-wide uniqueness, a number is never reissued, processing
 * and packaging numbers linked by a defined rule, every allocation written to the register at once); invariant INV-27
 * (identifiers are never reused, also after a restore: a lost number is re-entered only inside the range the restore
 * skipped, only as the rule gives it, and only once).
 */
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { exportAnchor } from '../../src/continuity/anchors.ts';
import type { FileLedger } from '../../src/continuity/ledger.ts';
import { withProtectedNumbers } from '../../src/continuity/numbers.ts';
import { approveRestoreEvent, completeRestore, recordRestoreEvent } from '../../src/continuity/restore.ts';
import { toDbContext, withCommand, type ActorContext } from '../../src/db/command.ts';
import {
  backupTestDatabase,
  dbTime,
  ensureSealKey,
  restoreCopy,
  signerActor,
  signFor,
  tempDir,
  tempLedger,
  testActor,
} from '../continuity/helpers.ts';
import { createTestDatabase, type TestDatabase } from '../support/db.ts';

const SITE = 'PLANT1';
const OTHER_SITE = 'PLANT2';
const ZONE = 'Asia/Kolkata';
const dir = tempDir('bnr-mutation');
afterAll(() => dir.cleanup());

const json = (p: unknown): string | null => (p === null ? null : JSON.stringify(p));
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function count(pool: pg.Pool, from: string, params: unknown[] = []): Promise<number> {
  const { rows } = await pool.query<{ n: string }>(`select count(*)::text as n from ${from}`, params);
  return Number(rows[0]?.n ?? 'NaN');
}

/** The site-local two-digit year now ({YY} of a rule dated in the site's zone). */
async function siteYY(pool: pg.Pool): Promise<string> {
  const { rows } = await pool.query<{ y: string }>('select to_char(clock_timestamp() at time zone $1, $2) as y', [ZONE, 'YY']);
  return rows[0]?.y ?? '';
}

interface Command {
  ctx: ActorContext;
  sql: string;
  params: unknown[];
}

interface RaceOutcome {
  /** 'done', or the error message of the second command. */
  second: string;
  /** The lock type the second command waited for while the first was open (null: it never waited). */
  waitedOn: string | null;
}

/**
 * Runs `first` in an open transaction, then `second` on another connection. Once `second` waits for a lock (or has
 * finished), `first` commits; returns how `second` ended and what it waited for. `second` commits when it succeeded.
 */
async function race(pool: pg.Pool, admin: pg.Pool, first: Command, second: Command): Promise<RaceOutcome> {
  const c1 = await pool.connect();
  const c2 = await pool.connect();
  try {
    await c1.query('begin');
    await c1.query('select kernel.begin_command($1::jsonb)', [JSON.stringify(toDbContext(first.ctx))]);
    await c1.query(first.sql, first.params);
    await c2.query('begin');
    await c2.query('select kernel.begin_command($1::jsonb)', [JSON.stringify(toDbContext(second.ctx))]);
    const pid = (await c2.query<{ pid: number }>('select pg_backend_pid() as pid')).rows[0]?.pid;
    const state = { settled: false };
    const outcome = c2.query(second.sql, second.params).then(
      () => 'done',
      (e: Error) => e.message,
    );
    void outcome.then(() => {
      state.settled = true;
    });
    let waitedOn: string | null = null;
    for (let i = 0; i < 500 && !state.settled && waitedOn === null; i++) {
      const { rows } = await admin.query<{ t: string }>('select locktype as t from pg_locks where pid = $1 and not granted', [pid]);
      waitedOn = rows[0]?.t ?? null;
      if (waitedOn === null) await sleep(20);
    }
    await c1.query('commit');
    const result = await outcome;
    if (result === 'done') await c2.query('commit');
    return { second: result, waitedOn };
  } finally {
    await c2.query('rollback').catch(() => undefined);
    await c1.query('rollback').catch(() => undefined);
    c1.release();
    c2.release();
  }
}

describe('numbering rules, rendering, allocation, registration and voids (IN-18, INV-27)', () => {
  let db: TestDatabase;
  let ledger: FileLedger;
  let steward: ActorContext;
  let issuer: ActorContext;
  /** A second issuer with a session of their own, for the concurrent registrations. */
  let issuer2: ActorContext;
  let yy: string;
  let n = 0;
  const code = (prefix: string) => `${prefix}-${String(++n).padStart(3, '0')}`;

  const defineSql = 'select site.define_batch_number_rule($1::jsonb)::text as id';
  const define = (p: unknown) => withCommand(db.app, steward, async (c) => (await c.query<{ id: string }>(defineSql, [json(p)])).rows[0]?.id);
  const rule = (over: Record<string, unknown> = {}) => ({
    rule_code: code('KR'),
    site_code: SITE,
    product_code: 'KIL1',
    batch_kind: 'PROCESSING',
    format: 'KL{YY}{SEQ:4}',
    site_zone: ZONE,
    reason: 'Numbering SOP-QA-017 rev 3',
    ...over,
  });
  /** No rule row and no protected counter for this rule code. */
  const nothingDefined = async (ruleCode: string) => ({
    rules: await count(db.admin, 'site.batch_number_rule where rule_code = $1', [ruleCode]),
    counters: await count(db.admin, 'continuity.protected_sequence where sequence_key = $1', [`site.batch_number:${ruleCode}`]),
  });

  const allocateSql = 'select allocation_id::text, batch_number, serial::text from site.allocate_batch_number($1::jsonb)';
  const allocate = (p: unknown) =>
    withProtectedNumbers(db.app, issuer, ledger, async (c) => (await c.query<{ allocation_id: string; batch_number: string; serial: string }>(allocateSql, [json(p)])).rows[0]);
  const request = (over: Record<string, unknown> = {}) => ({
    site_code: SITE,
    product_code: 'KIL1',
    product_name: 'Kill Tablets 10 mg',
    edition: 'TABLETS',
    batch_kind: 'PROCESSING',
    batch_size: '200000',
    batch_size_unit: '{tbl}',
    ...over,
  });

  const registerSql = 'select site.register_external_batch_number($1::jsonb)::text as id';
  const register = (p: unknown) => withCommand(db.app, issuer, async (c) => (await c.query<{ id: string }>(registerSql, [json(p)])).rows[0]?.id);
  const external = (batchNumber: string, over: Record<string, unknown> = {}) => ({ ...request(over), batch_number: batchNumber, site_zone: ZONE, ...over });
  const numbered = (batchNumber: string) => count(db.admin, 'site.batch_number_allocation where batch_number = $1', [batchNumber]);

  const voidIt = (id: string, reasonCode = 'ORDER_CANCELLED', reasonText = 'ERP order cancelled before issue') =>
    withCommand(db.app, issuer, (c) => c.query('select site.void_batch_number($1, $2, $3)', [id, reasonCode, reasonText]));

  beforeAll(async () => {
    db = await createTestDatabase();
    ledger = tempLedger('bnr-mutation', dir.path);
    steward = await testActor(db, { roleCode: 'MASTER_DATA_STEWARD', legalName: 'Master Data Steward' });
    issuer = await testActor(db, { roleCode: 'BATCH_ISSUER', legalName: 'Batch Issuer' });
    issuer2 = await testActor(db, { roleCode: 'BATCH_ISSUER', legalName: 'Second Batch Issuer' });
    yy = await siteYY(db.app);
    await define(rule({ rule_code: 'KL-TAB', block_size: 5 }));
    // A rule whose serials 1-100 an ERP registers first (one write-ahead block covers all of them).
    await define(rule({ rule_code: 'CL-TAB', product_code: 'CLS1', format: 'CL{SEQ:3}', block_size: 150 }));
    // A rule whose numbers cannot fit 32 characters: the site (6), a 32-character product code and 9 digits.
    await define(rule({ rule_code: 'LONG-TAB', product_code: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ012345', format: '{SITE}{PRODUCT}{SEQ:9}' }));
  }, 120_000);
  afterAll(async () => {
    await db?.drop();
  });

  // -------------------------------------------------------------------------------------------------------------------
  // site.define_batch_number_rule
  // -------------------------------------------------------------------------------------------------------------------

  it('[IN-18] a numbering rule needs its details as one JSON object: none, an array or a scalar is refused (EBMR-SITE-002) and nothing is defined', async () => {
    const before = await count(db.admin, 'site.batch_number_rule');
    for (const p of [null, [], 'KR-ARRAY']) {
      await expect(define(p), JSON.stringify(p)).rejects.toThrow('EBMR-SITE-002 numbering rule details are required');
    }
    expect(await count(db.admin, 'site.batch_number_rule')).toBe(before);
  });

  it('[IN-18] a format may hold only A-Z 0-9 / . - and the named tokens: anything else is refused by the function itself (EBMR-SITE-010), not left to the table', async () => {
    for (const format of ['kl{SEQ:4}', 'KL{DD}{SEQ:4}', 'KL_{SEQ:4}', 'KL{SEQ:0}', '']) {
      const r = rule({ format });
      await expect(define(r), format).rejects.toThrow(
        'EBMR-SITE-010 the format may contain only A-Z 0-9 / . - and the tokens {SITE} {PRODUCT} {YYYY} {YY} {MM} {SEQ:n} {PARENT}',
      );
      expect(await nothingDefined(r.rule_code)).toEqual({ rules: 0, counters: 0 });
    }
  });

  it('[IN-18][INV-27] a format needs exactly one {SEQ:n} token: none or two are refused (EBMR-SITE-010) and nothing is defined', async () => {
    for (const format of ['KL{YY}', 'KL{SEQ:2}{SEQ:3}', 'KL{SEQ:4}-{SEQ:4}']) {
      const r = rule({ format });
      await expect(define(r), format).rejects.toThrow('EBMR-SITE-010 a batch-number format needs exactly one {SEQ:n} token');
      expect(await nothingDefined(r.rule_code)).toEqual({ rules: 0, counters: 0 });
    }
  });

  it('[IN-18] only a packaging rule may use {PARENT}, and a site-wide rule cannot use {PRODUCT} (EBMR-SITE-010); nothing is defined', async () => {
    const processing = rule({ format: '{PARENT}-{SEQ:2}' });
    await expect(define(processing)).rejects.toThrow('EBMR-SITE-010 only packaging rules may use {PARENT}');
    expect(await nothingDefined(processing.rule_code)).toEqual({ rules: 0, counters: 0 });
    const siteWide = rule({ product_code: null, format: '{PRODUCT}{YY}{SEQ:4}' });
    await expect(define(siteWide)).rejects.toThrow('EBMR-SITE-010 a site-wide rule cannot use {PRODUCT}');
    expect(await nothingDefined(siteWide.rule_code)).toEqual({ rules: 0, counters: 0 });
    // The same formats are accepted where they belong.
    await expect(define(rule({ batch_kind: 'PACKAGING', format: '{PARENT}-{SEQ:2}' }))).resolves.toMatch(/^[0-9a-f-]{36}$/);
    await expect(define(rule({ product_code: 'KIL2', format: '{PRODUCT}{YY}{SEQ:4}' }))).resolves.toMatch(/^[0-9a-f-]{36}$/);
  });

  it('[IN-18] effective_from must be a timestamp and block_size a whole number (EBMR-SITE-002); nothing is defined', async () => {
    for (const over of [{ effective_from: 'next monday' }, { block_size: 'fifty' }, { block_size: '2.5' }]) {
      const r = rule(over);
      await expect(define(r), JSON.stringify(over)).rejects.toThrow('EBMR-SITE-002 effective_from must be a timestamp and block_size a whole number');
      expect(await nothingDefined(r.rule_code)).toEqual({ rules: 0, counters: 0 });
    }
  });

  it('[IN-18][INV-27] a numbering rule never takes effect in the past (EBMR-SITE-010); within the minute the clock may have moved it is accepted', async () => {
    const { rows } = await db.app.query<{ hour: string; seconds: string }>(
      "select (clock_timestamp() - interval '1 hour')::text as hour, (clock_timestamp() - interval '20 seconds')::text as seconds",
    );
    const past = rule({ effective_from: rows[0]?.hour });
    await expect(define(past)).rejects.toThrow('EBMR-SITE-010 a numbering rule cannot take effect in the past');
    expect(await nothingDefined(past.rule_code)).toEqual({ rules: 0, counters: 0 });
    const recent = rule({ product_code: 'KIL3', effective_from: rows[0]?.seconds });
    await expect(define(recent)).resolves.toMatch(/^[0-9a-f-]{36}$/);
  });

  /**
   * Runs `work` as the steward's command (application role) in a transaction of this test's own database in which
   * pg_catalog.clock_timestamp() is a test double returning the transaction start, now(); the transaction is always
   * rolled back, so the stub and anything written are gone afterwards. The guard reads the clock itself (pg_catalog is
   * first in its search_path), so the one-minute edge can only be reached deterministically on a held clock.
   */
  async function atHeldClock<T>(work: (c: pg.PoolClient) => Promise<T>): Promise<T> {
    const c = await db.admin.connect();
    try {
      await c.query('begin');
      await c.query("create or replace function pg_catalog.clock_timestamp() returns timestamptz language sql volatile as 'select pg_catalog.now()'");
      const held = await c.query<{ held: boolean }>('select clock_timestamp() = now() as held');
      expect(held.rows[0]?.held).toBe(true);
      await c.query('set local role ebmr_app');
      await c.query('select kernel.begin_command($1::jsonb)', [JSON.stringify(toDbContext(steward))]);
      return await work(c);
    } finally {
      await c.query('rollback');
      c.release();
    }
  }
  const defineAgoSql = "select site.define_batch_number_rule($1::jsonb || jsonb_build_object('effective_from', now() - $2::interval))::text as id";

  it('[IN-18][INV-27] the past-date tolerance is one minute inclusive: a rule dated exactly one minute before the clock is accepted with that date, one microsecond older is refused (EBMR-SITE-010)', async () => {
    const edge = rule({ product_code: 'KIL5' });
    const accepted = await atHeldClock(async (c) => {
      const id = (await c.query<{ id: string }>(defineAgoSql, [json(edge), '1 minute'])).rows[0]?.id;
      await c.query('reset role');
      const { rows } = await c.query<{ exact: boolean; counters: string }>(
        `select r.effective_from = now() - interval '1 minute' as exact,
                (select count(*) from continuity.protected_sequence s where s.sequence_key = r.counter_key)::text as counters
           from site.batch_number_rule r where r.id = $1 and r.rule_code = $2`,
        [id, edge.rule_code],
      );
      return { id, row: rows[0] };
    });
    expect(accepted.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(accepted.row).toEqual({ exact: true, counters: '1' });

    const older = rule({ product_code: 'KIL5' });
    await expect(atHeldClock((c) => c.query(defineAgoSql, [json(older), '1 minute 1 microsecond']))).rejects.toThrow(
      'EBMR-SITE-010 a numbering rule cannot take effect in the past',
    );

    // The held clock was a rolled-back test double: the live clock is back and neither rule exists.
    const { rows } = await db.admin.query<{ lang: string }>(
      "select l.lanname as lang from pg_proc p join pg_language l on l.oid = p.prolang where p.oid = 'pg_catalog.clock_timestamp()'::regprocedure",
    );
    expect(rows[0]?.lang).toBe('internal');
    expect(await nothingDefined(edge.rule_code)).toEqual({ rules: 0, counters: 0 });
    expect(await nothingDefined(older.rule_code)).toEqual({ rules: 0, counters: 0 });
  });

  it('[IN-18] a rule the table refuses (rule code, kind, reason, a second rule with the same code) is refused as an invalid numbering rule (EBMR-SITE-010), with no counter registered', async () => {
    const taken = rule();
    await define(taken);
    const counters = await count(db.admin, 'continuity.protected_sequence');
    for (const r of [rule({ rule_code: 'kr lower' }), rule({ batch_kind: 'BULK' }), rule({ reason: '  ' }), rule({ rule_code: taken.rule_code, product_code: 'KIL9' })]) {
      await expect(define(r), r.rule_code).rejects.toThrow('EBMR-SITE-010 invalid numbering rule: ');
    }
    expect(await count(db.admin, 'site.batch_number_rule where rule_code = $1', ['kr lower'])).toBe(0);
    expect(await count(db.admin, 'site.batch_number_rule where rule_code = $1', [taken.rule_code])).toBe(1);
    expect(await count(db.admin, 'continuity.protected_sequence')).toBe(counters);
  });

  // -------------------------------------------------------------------------------------------------------------------
  // site.render_batch_number and site.batch_number_pattern (granted to the application role)
  // -------------------------------------------------------------------------------------------------------------------

  const renderSql = 'select site.render_batch_number($1, $2, $3, $4::timestamptz, $5, $6::bigint, $7) as n';
  const render = async (format: string, serial: string | null, opts: { product?: string | null; parent?: string | null; site?: string } = {}) =>
    (
      await db.app.query<{ n: string | null }>(renderSql, [format, opts.site ?? SITE, opts.product ?? null, '2026-12-31T20:00:00Z', ZONE, serial, opts.parent ?? null])
    ).rows[0]?.n;

  it('[IN-18] a number is rendered in the site-local calendar with its serial zero-padded', async () => {
    // 20:00 UTC on 31 December is 01:30 on 1 January in Asia/Kolkata.
    expect(await render('{SITE}/{PRODUCT}/{YYYY}{MM}/{SEQ:5}', '42', { product: 'ATV10' })).toBe('PLANT1/ATV10/202701/00042');
    expect(await render('{PARENT}-P{SEQ:2}', '7', { parent: `AT${yy}0001` })).toBe(`AT${yy}0001-P07`);
  });

  it('[IN-18] rendering refuses a format without its {SEQ:n} token (EBMR-SITE-010) and a serial that is missing or below 1 (EBMR-SITE-012)', async () => {
    await expect(render('KL{YY}', '1')).rejects.toThrow('EBMR-SITE-010 a batch-number format needs exactly one {SEQ:n} token');
    await expect(render('KL{SEQ:3}', null)).rejects.toThrow('EBMR-SITE-012 serial  does not fit the 3 digits of format KL{SEQ:3}');
    await expect(render('KL{SEQ:3}', '0')).rejects.toThrow('EBMR-SITE-012 serial 0 does not fit the 3 digits of format KL{SEQ:3}');
  });

  it('[IN-18] a {PARENT} format is never rendered without its processing batch number (EBMR-SITE-014)', async () => {
    for (const parent of [null, '']) {
      await expect(render('P{PARENT}{SEQ:2}', '1', { parent })).rejects.toThrow('EBMR-SITE-014 this format needs the processing (parent) batch number');
    }
  });

  it('[IN-18] a rendering that is not a valid batch number is refused (EBMR-SITE-010): lower case, or longer than 32 characters', async () => {
    await expect(render('{PRODUCT}{SEQ:2}', '1', { product: 'atv' })).rejects.toThrow('EBMR-SITE-010 format {PRODUCT}{SEQ:2} renders atv01, which is not a valid batch number');
    await expect(render('{SITE}{SITE}{SEQ:9}', '1', { site: 'ABCDEFGHIJKLMNOP' })).rejects.toThrow(
      'EBMR-SITE-010 format {SITE}{SITE}{SEQ:9} renders ABCDEFGHIJKLMNOPABCDEFGHIJKLMNOP000000001, which is not a valid batch number',
    );
  });

  it('[IN-18][INV-27] a rule whose number does not fit 32 characters allocates nothing (EBMR-SITE-010)', async () => {
    const before = await count(db.admin, 'site.batch_number_allocation');
    await expect(allocate(request({ product_code: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ012345' }))).rejects.toThrow(
      'EBMR-SITE-010 format {SITE}{PRODUCT}{SEQ:9} renders PLANT1ABCDEFGHIJKLMNOPQRSTUVWXYZ012345000000001, which is not a valid batch number',
    );
    expect(await count(db.admin, 'site.batch_number_allocation')).toBe(before);
  });

  const patternSql = 'select site.batch_number_pattern($1, $2, $3, $4::bigint, $5) as p';
  const pattern = async (format: string, serial: string | null, parent: string | null = null) =>
    (await db.app.query<{ p: string | null }>(patternSql, [format, SITE, 'KIL1', serial, parent])).rows[0]?.p;

  it('[INV-27] the recovery pattern of a serial is that of the rule: a serial below 1 or wider than {SEQ:n} has none; a serial of the full width has one', async () => {
    expect(await pattern('KL{YY}{SEQ:3}', '123')).toBe('^KL[0-9]{2}123$');
    expect(await pattern('KL{YY}{SEQ:3}', '7')).toBe('^KL[0-9]{2}007$');
    expect(await pattern('{PARENT}.{SEQ:2}', '1', 'KL26.001')).toBe('^KL26\\.001\\.01$');
    for (const serial of ['0', '-5', '1234', null]) {
      expect(await pattern('KL{YY}{SEQ:3}', serial), String(serial)).toBeNull();
    }
    expect(await pattern('KL{YY}', '1')).toBeNull();
  });

  // -------------------------------------------------------------------------------------------------------------------
  // site.rule_in_force
  // -------------------------------------------------------------------------------------------------------------------

  it('[IN-18] a numbering rule is in force from its effective instant itself; just before it, the earlier rule is', async () => {
    const earlier = rule({ product_code: 'RIF1' });
    const later = rule({ product_code: 'RIF1', format: 'RF{YYYY}{SEQ:5}' });
    await define(earlier);
    const { rows } = await db.app.query<{ t: string }>("select (clock_timestamp() + interval '1 day')::text as t");
    await define({ ...later, effective_from: rows[0]?.t });
    const at = (await db.app.query<{ t: string }>('select effective_from::text as t from site.batch_number_rule where rule_code = $1', [later.rule_code])).rows[0]?.t;
    const inForce = async (offset: string) =>
      (
        await db.app.query<{ c: string | null }>(
          "select (site.rule_in_force($1, 'RIF1', 'PROCESSING', $2::timestamptz + $3::interval)).rule_code as c",
          [SITE, at, offset],
        )
      ).rows[0]?.c;
    expect(await inForce('0')).toBe(later.rule_code);
    expect(await inForce('-1 microsecond')).toBe(earlier.rule_code);
    expect(await inForce('1 microsecond')).toBe(later.rule_code);
  });

  // -------------------------------------------------------------------------------------------------------------------
  // site.allocate_batch_number
  // -------------------------------------------------------------------------------------------------------------------

  it('[IN-18] an allocation needs its details as one JSON object: none or an array is refused (EBMR-SITE-002) and nothing is allocated', async () => {
    const before = await count(db.admin, 'site.batch_number_allocation');
    for (const p of [null, [], 'KIL1']) {
      await expect(allocate(p), JSON.stringify(p)).rejects.toThrow('EBMR-SITE-002 allocation details are required');
    }
    expect(await count(db.admin, 'site.batch_number_allocation')).toBe(before);
  });

  it('[IN-18][INV-27] an allocation the register refuses (edition, batch size, unit) is refused as invalid (EBMR-SITE-002) and leaves no entry', async () => {
    const before = await count(db.admin, 'site.batch_number_allocation');
    for (const over of [{ edition: 'CAPSULES' }, { batch_size: '0' }, { batch_size: 'lots' }, { batch_size_unit: '' }, { product_name: ' ' }]) {
      await expect(allocate(request(over)), JSON.stringify(over)).rejects.toThrow('EBMR-SITE-002 invalid allocation: ');
    }
    expect(await count(db.admin, 'site.batch_number_allocation')).toBe(before);
    // The same request with valid values gets the rule's first serial: the refused attempts kept nothing.
    expect(await allocate(request())).toMatchObject({ batch_number: `KL${yy}0001`, serial: '1' });
  });

  it('[IN-18][INV-27] a rule whose next 100 numbers are all registered already allocates nothing and says so (EBMR-SITE-013); no serial is skipped', async () => {
    await withCommand(db.app, issuer, (c) =>
      c.query(
        `select site.register_external_batch_number(jsonb_build_object('batch_number', 'CL' || lpad(g::text, 3, '0'), 'site_code', $1::text,
                  'site_zone', $2::text, 'product_code', 'ERP1', 'product_name', 'ERP product', 'edition', 'INJECTABLES', 'batch_size', '10',
                  'batch_size_unit', 'L', 'external_reference', 'ERP order ' || g))
           from generate_series(1, 100) g`,
        [SITE, ZONE],
      ),
    );
    const before = await count(db.admin, 'site.batch_number_allocation');
    await expect(allocate(request({ product_code: 'CLS1' }))).rejects.toThrow('EBMR-SITE-013 rule CL-TAB produced 100 numbers in a row that are already allocated');
    expect(await count(db.admin, 'site.batch_number_allocation')).toBe(before);
    expect(await count(db.admin, 'site.batch_number_serial_skip s join site.batch_number_rule r on r.id = s.rule_id where r.rule_code = $1', ['CL-TAB'])).toBe(0);
  });

  // -------------------------------------------------------------------------------------------------------------------
  // site.register_external_batch_number
  // -------------------------------------------------------------------------------------------------------------------

  it('[IN-18] a registration needs its details as one JSON object: none or an array is refused (EBMR-SITE-002)', async () => {
    const before = await count(db.admin, 'site.batch_number_allocation');
    for (const p of [null, [], 'ERP-1']) {
      await expect(register(p), JSON.stringify(p)).rejects.toThrow('EBMR-SITE-002 registration details are required');
    }
    expect(await count(db.admin, 'site.batch_number_allocation')).toBe(before);
  });

  it('[IN-18] a registered number must already be a valid batch number; it is never changed for the caller (EBMR-SITE-002)', async () => {
    for (const batchNumber of ['erp-7002', '-ERP7002', 'ERP 7002', 'A'.repeat(33), '']) {
      await expect(register(external(batchNumber)), batchNumber).rejects.toThrow(
        'EBMR-SITE-002 a batch number is 1-32 characters: upper-case letters, digits, / . - (it is not changed for you)',
      );
      expect(await numbered(batchNumber)).toBe(0);
    }
  });

  it('[IN-18][DI-27] a registered number names a time zone the database knows (EBMR-SITE-002)', async () => {
    for (const zone of ['Mars/Olympus_Mons', 'IST']) {
      await expect(register(external('ERP-ZONE-1', { site_zone: zone })), zone).rejects.toThrow(`EBMR-SITE-002 unknown site time zone ${zone}`);
    }
    expect(await numbered('ERP-ZONE-1')).toBe(0);
  });

  it('[IN-18][INV-27][PR-10] a number already in the register is refused before anything else is checked (EBMR-SITE-013), voided numbers included', async () => {
    const id = await register(external('ERP-800'));
    for (const over of [{}, { edition: 'INJECTABLES', product_code: 'INJ1' }, { batch_kind: 'PACKAGING', parent_batch_number: 'NO-SUCH-PARENT' }]) {
      await expect(register(external('ERP-800', over)), JSON.stringify(over)).rejects.toThrow(
        'EBMR-SITE-013 batch number ERP-800 is already in the allocation register (voided numbers included); numbers are never reused',
      );
    }
    await voidIt(id ?? '');
    await expect(register(external('ERP-800'))).rejects.toThrow(
      'EBMR-SITE-013 batch number ERP-800 is already in the allocation register (voided numbers included); numbers are never reused',
    );
    expect(await numbered('ERP-800')).toBe(1);
  });

  it('[IN-18] a registered packaging number links to an allocated, not voided processing number of the same site (EBMR-SITE-014)', async () => {
    const parent = await register(external('ERP-900'));
    const voided = await register(external('ERP-901'));
    await voidIt(voided ?? '');
    await register(external('ERP-902', { site_code: OTHER_SITE }));
    // A packaging number of ERP-900 at the site, with its own parent link.
    const pack = await register(external('ERP-900-P1', { batch_kind: 'PACKAGING', parent_batch_number: 'ERP-900' }));
    const link = await db.app.query<{ parent: string | null; parent_id: string | null }>(
      'select r.parent_batch_number as parent, a.parent_allocation_id::text as parent_id from site.batch_number_register r join site.batch_number_allocation a on a.id = r.allocation_id where r.allocation_id = $1',
      [pack],
    );
    expect(link.rows).toEqual([{ parent: 'ERP-900', parent_id: parent }]);
    const refusals: [string, string | null][] = [
      ['ERP-990-P1', 'ERP-990'], // not allocated
      ['ERP-990-P2', null], // no parent given
      ['ERP-900-P1-P1', 'ERP-900-P1'], // a packaging number
      ['ERP-901-P1', 'ERP-901'], // voided
      ['ERP-902-P1', 'ERP-902'], // another site's
    ];
    for (const [batchNumber, parentNumber] of refusals) {
      await expect(register(external(batchNumber, { batch_kind: 'PACKAGING', parent_batch_number: parentNumber })), batchNumber).rejects.toThrow(
        `EBMR-SITE-014 packaging numbers link to an allocated, not voided processing batch number of the same site (${parentNumber ?? ''})`,
      );
      expect(await numbered(batchNumber)).toBe(0);
    }
  });

  it('[IN-18] a registration the register refuses (edition, batch size, unit) is refused as invalid (EBMR-SITE-002) and leaves no entry', async () => {
    for (const over of [{ edition: 'CAPSULES' }, { batch_size: '0' }, { batch_size: 'lots' }, { batch_size_unit: '' }, { product_code: 'kil1' }]) {
      await expect(register(external('ERP-950', over)), JSON.stringify(over)).rejects.toThrow('EBMR-SITE-002 invalid registration: ');
    }
    expect(await numbered('ERP-950')).toBe(0);
  });

  it('[IN-18][INV-27] two registrations of one number at the same time: the second waits for the first and is refused (EBMR-SITE-013); the number is in the register once', async () => {
    const sql = registerSql;
    const params = [json(external('ERP-777'))];
    const outcome = await race(db.app, db.admin, { ctx: issuer, sql, params }, { ctx: issuer2, sql, params: [json(external('ERP-777', { edition: 'INJECTABLES', product_code: 'INJ7' }))] });
    // The second could not see the first's uncommitted number, so it reached the insert and waited on the unique index.
    expect(outcome).toEqual({
      second: 'EBMR-SITE-013 batch number ERP-777 is already in the allocation register; numbers are never reused',
      waitedOn: 'transactionid',
    });
    expect((await db.app.query<{ edition: string }>('select edition from site.batch_number_allocation where batch_number = $1', ['ERP-777'])).rows).toEqual([
      { edition: 'TABLETS' },
    ]);
  });

  // -------------------------------------------------------------------------------------------------------------------
  // site.void_batch_number
  // -------------------------------------------------------------------------------------------------------------------

  it('[IN-18] a void names an allocation in the register: an unknown one is refused (EBMR-SITE-015) and nothing is voided', async () => {
    const before = await count(db.admin, 'site.batch_number_void');
    const unknown = randomUUID();
    await expect(voidIt(unknown)).rejects.toThrow(`EBMR-SITE-015 allocation ${unknown} does not exist`);
    expect(await count(db.admin, 'site.batch_number_void')).toBe(before);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// site.recover_batch_number, in a database restored from a backup taken before numbers were issued
// ---------------------------------------------------------------------------------------------------------------------

describe('re-entering a number lost by a restore (INV-27, IN-18)', () => {
  const site = 'PLANT9';
  let src: TestDatabase;
  let restored: TestDatabase;
  let ledger: FileLedger;
  let issuer: ActorContext;
  let issuer2: ActorContext;
  let restoreEventId: string;
  let yy: string;
  /** The range of serials the restore skipped for the processing rule: (before, after]. */
  let skipped: { before: string; after: string };
  let firstProcessing: string;

  const base = { site_code: site, product_code: 'KRP1', product_name: 'Kill Recovery Tablets 5 mg', edition: 'TABLETS', batch_size: '50000', batch_size_unit: '{tbl}' };
  const recoverSql = 'select site.recover_batch_number($1::jsonb)::text as id';
  const recovery = (over: Record<string, unknown> = {}) => ({
    ...base,
    restore_event_id: restoreEventId,
    rule_code: 'KR-TAB',
    evidence_reference: 'Paper BMR page 1 and label specimen',
    ...over,
  });
  const recover = (p: unknown, ctx: ActorContext = issuer) =>
    withCommand(restored.app, ctx, async (c) => (await c.query<{ id: string }>(recoverSql, [json(p)])).rows[0]?.id);
  const recovered = () => count(restored.admin, "site.batch_number_allocation where source = 'RECOVERED_AFTER_RESTORE'");
  const allocateIn = (db: TestDatabase, p: Record<string, unknown>) =>
    withProtectedNumbers(db.app, issuer, ledger, async (c) =>
      (await c.query<{ batch_number: string }>('select batch_number from site.allocate_batch_number($1::jsonb)', [json(p)])).rows[0]?.batch_number ?? '',
    );

  beforeAll(async () => {
    src = await createTestDatabase();
    ledger = tempLedger('bnr-mutation-restore', dir.path);
    issuer = await testActor(src, { roleCode: 'BATCH_ISSUER' });
    issuer2 = await testActor(src, { roleCode: 'BATCH_ISSUER', legalName: 'Second Batch Issuer' });
    const operator = await testActor(src, { roleCode: 'SYSTEM_ADMINISTRATOR' });
    const approver = await signerActor(src, 'QA_REVIEWER');
    await ensureSealKey(src);
    const steward = await testActor(src, { roleCode: 'MASTER_DATA_STEWARD' });
    const rule = { site_code: site, product_code: 'KRP1', site_zone: ZONE, reason: 'Numbering SOP-QA-017 rev 3', block_size: 10 };
    for (const r of [
      { ...rule, rule_code: 'KR-TAB', batch_kind: 'PROCESSING', format: 'KR{YY}{SEQ:3}' },
      { ...rule, rule_code: 'KR-PACK', batch_kind: 'PACKAGING', format: '{PARENT}-P{SEQ:2}' },
    ]) {
      await withCommand(src.app, steward, (c) => c.query('select site.define_batch_number_rule($1::jsonb)', [json(r)]));
    }
    // Serial 1 of each rule before the backup: each reserved a write-ahead block of 10 in the external ledger.
    firstProcessing = await allocateIn(src, base);
    await allocateIn(src, { ...base, batch_kind: 'PACKAGING', parent_batch_number: firstProcessing });
    await exportAnchor(src.app, ledger);
    const backup = await backupTestDatabase(src, dir.path);
    // Issued after the backup (on paper and labels), then lost by the restore.
    await allocateIn(src, base);
    await exportAnchor(src.app, ledger);
    restored = await restoreCopy(src, backup, dir.path);
    const event = await recordRestoreEvent(restored.app, operator, ledger, {
      eventKind: 'FULL_RESTORE',
      backupId: backup.backupId,
      backupTakenAt: backup.snapshotTakenAt,
      performedAt: await dbTime(restored),
      reason: 'Disk failure',
      changeReference: 'INC-2026-0201',
      approverPersonIds: [approver.personId],
    });
    restoreEventId = event.restoreEventId;
    const signature = await signFor(restored, approver, { type: 'restore_event', id: restoreEventId }, 'RESTORE_APPROVED', 'RECORDED', { registerKey: false });
    await approveRestoreEvent(restored.app, approver, restoreEventId, signature);
    await completeRestore(restored.app, operator, ledger, restoreEventId);
    yy = await siteYY(restored.app);
    const bump = await restored.admin.query<{ before: string; after: string }>(
      "select value_before::text as before, value_after::text as after from continuity.sequence_bump where restore_event_id = $1 and sequence_key = 'site.batch_number:KR-TAB'",
      [restoreEventId],
    );
    skipped = bump.rows[0] ?? { before: '', after: '' };
    // A number an ERP registered after the restore (it fits no serial of the rule).
    await withCommand(restored.app, issuer, (c) =>
      c.query('select site.register_external_batch_number($1::jsonb)', [json({ ...base, batch_number: 'KRX-1', site_zone: ZONE, external_reference: 'ERP order 1' })]),
    );
  }, 120_000);
  afterAll(async () => {
    await restored?.drop();
    await src?.drop();
  });

  it('[INV-27] the restore skipped serials 2-10 of the processing rule: the backup had issued 1, the ledger had reserved up to 10', () => {
    expect(firstProcessing).toBe(`KR${yy}001`);
    expect(skipped).toEqual({ before: '1', after: '10' });
  });

  it('[INV-27] the restore event must be a UUID and the serial a whole number (EBMR-SITE-016); nothing is recovered', async () => {
    for (const over of [{ restore_event_id: 'restore-1' }, { serial: '2.5', batch_number: `KR${yy}002` }, { serial: 'two', batch_number: `KR${yy}002` }]) {
      await expect(recover(recovery({ serial: '2', batch_number: `KR${yy}002`, ...over })), JSON.stringify(over)).rejects.toThrow(
        'EBMR-SITE-016 restore_event_id must be a UUID and serial a whole number',
      );
    }
    expect(await recovered()).toBe(0);
  });

  it('[INV-27] a recovery names a numbering rule of the register (EBMR-SITE-016); nothing is recovered', async () => {
    await expect(recover(recovery({ rule_code: 'NO-SUCH-RULE', serial: '2', batch_number: `KR${yy}002` }))).rejects.toThrow(
      'EBMR-SITE-016 unknown numbering rule NO-SUCH-RULE',
    );
    expect(await recovered()).toBe(0);
  });

  it('[INV-27] a recovery needs a completed restore event: another event id is refused although this database has a completed one (EBMR-SITE-016)', async () => {
    await expect(recover(recovery({ restore_event_id: randomUUID(), serial: '2', batch_number: `KR${yy}002` }))).rejects.toThrow(
      'EBMR-SITE-016 recovery needs a completed restore event',
    );
    expect(await recovered()).toBe(0);
  });

  it('[INV-27] only serials after the restored value are in the skipped range: the last serial the backup kept is refused as such (EBMR-SITE-016)', async () => {
    await expect(recover(recovery({ serial: skipped.before, batch_number: `KR${yy}00${skipped.before}` }))).rejects.toThrow(
      `EBMR-SITE-016 serial ${skipped.before} of rule KR-TAB is not in the range that restore event ${restoreEventId} skipped`,
    );
    expect(await recovered()).toBe(0);
  });

  it('[INV-27] a recovery needs the evidence that the number was issued (EBMR-SITE-016); nothing is recovered', async () => {
    for (const evidence of [' ', '', null]) {
      await expect(recover(recovery({ serial: '2', batch_number: `KR${yy}002`, evidence_reference: evidence })), String(evidence)).rejects.toThrow(
        'EBMR-SITE-016 recovery needs the evidence (paper record, ERP document or label) that the number was issued',
      );
    }
    expect(await recovered()).toBe(0);
  });

  it('[INV-27] a recovered number must be a valid batch number as given (EBMR-SITE-016)', async () => {
    for (const batchNumber of [`kr${yy}002`, '', null]) {
      await expect(recover(recovery({ serial: '2', batch_number: batchNumber })), String(batchNumber)).rejects.toThrow(/^EBMR-SITE-016 invalid batch number$/);
    }
    expect(await recovered()).toBe(0);
  });

  it('[INV-27][IN-18] a number already in the register is refused (EBMR-SITE-013) even with a free serial in the skipped range', async () => {
    await expect(recover(recovery({ serial: '3', batch_number: 'KRX-1' }))).rejects.toThrow('EBMR-SITE-013 that batch number or serial is already in the allocation register');
    expect(await recovered()).toBe(0);
  });

  it('[INV-27][IN-18] a recovered packaging number needs its processing number in the register (EBMR-SITE-014)', async () => {
    await expect(
      recover(recovery({ rule_code: 'KR-PACK', serial: '2', batch_number: 'KRZ-9-P02', parent_batch_number: 'KRZ-9' })),
    ).rejects.toThrow('EBMR-SITE-014 a recovered packaging number needs its processing batch number of the same site (KRZ-9)');
    expect(await recovered()).toBe(0);
    // With its processing number it is recovered.
    await expect(
      recover(recovery({ rule_code: 'KR-PACK', serial: '2', batch_number: `${firstProcessing}-P02`, parent_batch_number: firstProcessing })),
    ).resolves.toMatch(/^[0-9a-f-]{36}$/);
    expect(await recovered()).toBe(1);
  });

  it('[INV-27] a recovery the register refuses (edition, batch size, unit) is refused as invalid (EBMR-SITE-016) and leaves no entry', async () => {
    const before = await recovered();
    for (const over of [{ edition: 'CAPSULES' }, { batch_size: '0' }, { batch_size: 'lots' }, { batch_size_unit: '' }]) {
      await expect(recover(recovery({ serial: '4', batch_number: `KR${yy}004`, ...over })), JSON.stringify(over)).rejects.toThrow('EBMR-SITE-016 invalid recovery: ');
    }
    expect(await recovered()).toBe(before);
    await expect(recover(recovery({ serial: '4', batch_number: `KR${yy}004` }))).resolves.toMatch(/^[0-9a-f-]{36}$/);
    expect(await recovered()).toBe(before + 1);
  });

  it('[INV-27] two recoveries of one serial at the same time: the second waits for the first and is refused (EBMR-SITE-013); the serial is recovered once', async () => {
    const before = await recovered();
    const first = { ctx: issuer, sql: recoverSql, params: [json(recovery({ serial: '5', batch_number: `KR${yy}005` }))] };
    // The same serial dated in another year: another number, the same serial of the rule.
    const second = { ctx: issuer2, sql: recoverSql, params: [json(recovery({ serial: '5', batch_number: `KR${yy === '99' ? '00' : '99'}005` }))] };
    expect(await race(restored.app, restored.admin, first, second)).toEqual({
      second: 'EBMR-SITE-013 that batch number or serial is already in the allocation register',
      waitedOn: 'transactionid',
    });
    expect(await recovered()).toBe(before + 1);
    expect(await count(restored.admin, "site.batch_number_allocation a join site.batch_number_rule r on r.id = a.rule_id where r.rule_code = 'KR-TAB' and a.serial = 5")).toBe(1);
  });
});
