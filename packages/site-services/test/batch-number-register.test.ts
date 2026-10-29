import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { verifyChain } from '../../kernel/src/audit/verify.ts';
import { exportAnchor } from '../../kernel/src/continuity/anchors.ts';
import type { FileLedger } from '../../kernel/src/continuity/ledger.ts';
import { withProtectedNumbers } from '../../kernel/src/continuity/numbers.ts';
import { approveRestoreEvent, completeRestore, recordRestoreEvent } from '../../kernel/src/continuity/restore.ts';
import { withCommand, type ActorContext } from '../../kernel/src/db/command.ts';
import {
  allocateBatchNumber,
  batchNumberInvariantViolations,
  defineBatchNumberRule,
  exportBatchNumberRegister,
  recoverBatchNumber,
  registerExternalBatchNumber,
  registerToCsv,
  voidBatchNumber,
  type AllocationRequest,
  type BatchNumberRuleInput,
} from '../src/index.ts';
import type { SeededActor } from '../../kernel/test/identity/seed.ts';
import {
  backupTestDatabase,
  createTestDatabase,
  dbTime,
  ensureSealKey,
  restoreCopy,
  scopedTestActor,
  signerActor,
  signFor,
  tempDir,
  tempLedger,
  testActor,
  type TestDatabase,
} from './helpers.ts';

const SITE = 'PLANT1';
const ZONE = 'Asia/Kolkata';
const dir = tempDir('site-register');
afterAll(() => dir.cleanup());

const atv: AllocationRequest = {
  siteCode: SITE,
  productCode: 'ATV10',
  productName: 'Atorvastatin Tablets IP 10 mg',
  edition: 'TABLETS',
  batchSize: '200000',
  batchSizeUnit: '{tbl}',
};

async function siteYear(db: TestDatabase, pattern: 'YY' | 'YYYY'): Promise<string> {
  const { rows } = await db.app.query<{ y: string }>('select to_char(clock_timestamp() at time zone $1, $2) as y', [ZONE, pattern]);
  return rows[0]?.y ?? '';
}

describe('batch-number register', () => {
  let db: TestDatabase;
  let ledger: FileLedger;
  let steward: ActorContext;
  let issuer: ActorContext;
  let yy: string;

  const define = (rule: BatchNumberRuleInput) => withCommand(db.app, steward, (c) => defineBatchNumberRule(c, rule));
  const allocate = (req: AllocationRequest) => withProtectedNumbers(db.app, issuer, ledger, (c) => allocateBatchNumber(c, req));
  const register = (req: AllocationRequest & { batchNumber: string }) => withCommand(db.app, issuer, (c) => registerExternalBatchNumber(c, { ...req, siteZone: ZONE }));
  const voidIt = (id: string, code: string, text: string) => withCommand(db.app, issuer, (c) => voidBatchNumber(c, id, code, text));

  beforeAll(async () => {
    db = await createTestDatabase();
    ledger = tempLedger('site-register', dir.path);
    steward = await testActor(db, { roleCode: 'MASTER_DATA_STEWARD', legalName: 'Master Data Steward' });
    issuer = await testActor(db, { roleCode: 'BATCH_ISSUER', legalName: 'Batch Issuer' });
    yy = await siteYear(db, 'YY');
    const base = { siteCode: SITE, siteZone: ZONE, reason: 'Numbering SOP-QA-017 rev 3' };
    await define({ ...base, ruleCode: 'AT-TAB', productCode: 'ATV10', batchKind: 'PROCESSING', format: 'AT{YY}{SEQ:4}', blockSize: 5 });
    await define({ ...base, ruleCode: 'AT-PACK', productCode: 'ATV10', batchKind: 'PACKAGING', format: '{PARENT}-P{SEQ:2}' });
    await define({ ...base, ruleCode: 'SITE-WIDE', batchKind: 'PROCESSING', format: '{SITE}-{YYYY}-{SEQ:5}' });
    await define({ ...base, ruleCode: 'TINY', productCode: 'TINY1', batchKind: 'PROCESSING', format: 'TN{SEQ:1}', blockSize: 3 });
  });
  afterAll(async () => {
    await db.drop();
  });

  it('[IN-18][INV-27] a generated number follows its rule and is written to the register at once with date, product and batch size', async () => {
    const a = await allocate(atv);
    expect(a).toMatchObject({ batchNumber: `AT${yy}0001`, serial: '1' });
    const row = (await exportBatchNumberRegister(db.app, { siteCode: SITE })).find((r) => r.allocationId === a.allocationId);
    expect(row).toMatchObject({
      batchNumber: `AT${yy}0001`,
      productCode: 'ATV10',
      productName: 'Atorvastatin Tablets IP 10 mg',
      batchSize: '200000',
      batchSizeUnit: '{tbl}',
      edition: 'TABLETS',
      source: 'GENERATED',
      ruleCode: 'AT-TAB',
      status: 'ALLOCATED',
    });
    expect(row?.allocationDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // The register is one tamper-evident audit chain per site.
    expect(await verifyChain(db.app, `batch_number_register:${SITE}`)).toEqual([]);
  });

  it('[IN-18][INV-27] cancel a batch: its number is never offered again', async () => {
    const b = await allocate(atv);
    expect(b.batchNumber).toBe(`AT${yy}0002`);
    await voidIt(b.allocationId, 'ORDER_CANCELLED', 'ERP order cancelled before issue');
    expect((await allocate(atv)).batchNumber).toBe(`AT${yy}0003`);
    const row = (await exportBatchNumberRegister(db.app)).find((r) => r.allocationId === b.allocationId);
    expect(row).toMatchObject({ status: 'VOIDED', voidReasonCode: 'ORDER_CANCELLED', voidReasonText: 'ERP order cancelled before issue' });
    await expect(register({ ...atv, edition: 'INJECTABLES', batchNumber: b.batchNumber })).rejects.toThrow('EBMR-SITE-013');
    await expect(voidIt(b.allocationId, 'ORDER_CANCELLED', 'again')).rejects.toThrow('EBMR-SITE-015');
    const c = await allocate(atv);
    await expect(voidIt(c.allocationId, 'ORDER_CANCELLED', ' ')).rejects.toThrow('EBMR-SITE-015');
  });

  it('[IN-18][INV-27] a number is unique across both editions at the site, and generation skips a number registered from outside', async () => {
    await register({ ...atv, batchNumber: 'ERP-7001', externalReference: 'SAP PO 4711' });
    await expect(register({ ...atv, edition: 'INJECTABLES', productCode: 'INJ1', productName: 'Injection', batchNumber: 'ERP-7001' })).rejects.toThrow('EBMR-SITE-013');
    await expect(register({ ...atv, batchNumber: 'erp-7002' })).rejects.toThrow('EBMR-SITE-002'); // never silently changed

    // The next generated number (serial 5) was already registered by the other edition.
    const taken = await register({ ...atv, edition: 'INJECTABLES', productCode: 'INJ1', productName: 'Injection', batchNumber: `AT${yy}0005` });
    const next = await allocate(atv);
    expect(next.batchNumber).toBe(`AT${yy}0006`);
    const skip = await db.app.query<{ serial: string; colliding_allocation_id: string }>(
      "select s.serial::text, s.colliding_allocation_id::text from site.batch_number_serial_skip s join site.batch_number_rule r on r.id = s.rule_id where r.rule_code = 'AT-TAB'",
    );
    expect(skip.rows).toEqual([{ serial: '5', colliding_allocation_id: taken }]);
  });

  it('[IN-18][DI-42] export the register: allocation date, product identity and batch size are present for every entry', async () => {
    await allocate({ ...atv, productCode: 'PCM500', productName: 'Paracetamol Injection 150 mg/mL', edition: 'INJECTABLES', batchSize: '150.125', batchSizeUnit: 'kg' });
    const rows = await exportBatchNumberRegister(db.app, { siteCode: SITE });
    expect(rows.length).toBeGreaterThanOrEqual(7);
    for (const r of rows) {
      expect(r.allocationDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(r.productCode).not.toBe('');
      expect(r.productName).not.toBe('');
      expect(r.batchSize).toMatch(/^\d+(\.\d+)?$/);
      expect(r.batchSizeUnit).not.toBe('');
    }
    expect(rows.find((r) => r.productCode === 'PCM500')).toMatchObject({ batchSize: '150.125', batchSizeUnit: 'kg', ruleCode: 'SITE-WIDE' });
    const csv = registerToCsv(rows).split('\r\n');
    expect(csv[0]).toContain('"Batch number","Allocation date","Allocated at (UTC)","Product code","Product name","Batch size","Batch size unit"');
    expect(csv.filter((l) => l !== '')).toHaveLength(rows.length + 1);
  });

  it('[IN-18] a product without its own rule uses the site-wide rule; without any rule no number is issued', async () => {
    const x = await allocate({ ...atv, productCode: 'MTF500', productName: 'Metformin Tablets 500 mg' });
    expect(x.batchNumber).toMatch(new RegExp(`^PLANT1-${await siteYear(db, 'YYYY')}-\\d{5}$`));
    await expect(allocate({ ...atv, siteCode: 'PLANT2' })).rejects.toThrow('EBMR-SITE-011');
  });

  it('[IN-18] a packaging number is linked to its processing number by the packaging rule', async () => {
    const bulk = await allocate(atv);
    const pack = await allocate({ ...atv, batchKind: 'PACKAGING', parentBatchNumber: bulk.batchNumber, batchSize: '100000' });
    expect(pack.batchNumber).toBe(`${bulk.batchNumber}-P01`);
    expect((await exportBatchNumberRegister(db.app)).find((r) => r.allocationId === pack.allocationId)?.parentBatchNumber).toBe(bulk.batchNumber);
    await expect(allocate({ ...atv, batchKind: 'PACKAGING', parentBatchNumber: `AT${yy}0002`, batchSize: '1' })).rejects.toThrow('EBMR-SITE-014'); // voided
    await expect(allocate({ ...atv, batchKind: 'PACKAGING', parentBatchNumber: 'NOPE', batchSize: '1' })).rejects.toThrow('EBMR-SITE-014');
    await expect(allocate({ ...atv, batchKind: 'PACKAGING', parentBatchNumber: pack.batchNumber, batchSize: '1' })).rejects.toThrow('EBMR-SITE-014');
  });

  it('[IN-18][INV-27] a packaging rule counts {SEQ:n} per processing batch unless it says otherwise: each batch\'s first packaging number is P01 (owner report #19)', async () => {
    const pack = (parent: string) => allocate({ ...atv, batchKind: 'PACKAGING', parentBatchNumber: parent, batchSize: '1000' });
    const [b1, b2] = [(await allocate(atv)).batchNumber, (await allocate(atv)).batchNumber];
    expect([(await pack(b1)).batchNumber, (await pack(b1)).batchNumber, (await pack(b2)).batchNumber]).toEqual([`${b1}-P01`, `${b1}-P02`, `${b2}-P01`]);
    // A number already in the register (here registered from outside) moves on to the parent's next serial; the skip is recorded.
    await register({ ...atv, batchKind: 'PACKAGING', parentBatchNumber: b2, batchSize: '1', batchNumber: `${b2}-P02` });
    expect((await pack(b2)).batchNumber).toBe(`${b2}-P03`);
    const skip = await db.admin.query<{ n: string; ps: string }>('select rendered_number as n, parent_serial::text as ps from site.batch_number_serial_skip where rendered_number = $1', [`${b2}-P02`]);
    expect(skip.rows).toEqual([{ n: `${b2}-P02`, ps: '2' }]);
    // The rule's own serial is still drawn for every number, unique per rule.
    const serials = await db.admin.query<{ s: string; ps: string | null }>(
      "select a.serial::text as s, a.parent_serial::text as ps from site.batch_number_allocation a join site.batch_number_rule r on r.id = a.rule_id where r.rule_code = 'AT-PACK' order by a.serial",
    );
    expect(new Set(serials.rows.map((r) => r.s)).size).toBe(serials.rows.length);
    // A rule that says RULE counts across the rule, as before; PARENT without {PARENT} in the format is refused.
    const base = { siteCode: SITE, siteZone: ZONE, reason: 'Numbering SOP-QA-017 rev 4' };
    const rw: AllocationRequest = { ...atv, productCode: 'RW1', productName: 'Rule-wide product' };
    await define({ ...base, ruleCode: 'RW-TAB', productCode: 'RW1', batchKind: 'PROCESSING', format: 'RW{SEQ:3}' });
    await define({ ...base, ruleCode: 'RW-PACK', productCode: 'RW1', batchKind: 'PACKAGING', format: '{PARENT}-Q{SEQ:2}', serialScope: 'RULE' });
    const [r1, r2] = [(await allocate(rw)).batchNumber, (await allocate(rw)).batchNumber];
    const rwPack = (parent: string) => allocate({ ...rw, batchKind: 'PACKAGING', parentBatchNumber: parent, batchSize: '1' });
    expect([(await rwPack(r1)).batchNumber, (await rwPack(r2)).batchNumber]).toEqual([`${r1}-Q01`, `${r2}-Q02`]);
    await expect(define({ ...base, ruleCode: 'NP-PACK', productCode: 'NP1', batchKind: 'PACKAGING', format: 'NP{SEQ:3}', serialScope: 'PARENT' })).rejects.toThrow(
      'EBMR-SITE-010 a serial per parent batch needs {PARENT} in the format',
    );
    // The database holds it for a direct write too: a second number of the same parent serial, or a parent serial on a processing number.
    const c = await db.admin.connect();
    try {
      for (const sql of [
        `insert into site.batch_number_allocation (batch_number, site_code, site_zone, product_code, product_name, edition, batch_kind, parent_allocation_id, batch_size, batch_size_unit, source, rule_id, serial, parent_serial, allocated_by_person_id, allocated_by_account_id, correlation_id)
         select '${b1}-X01', a.site_code, a.site_zone, a.product_code, a.product_name, a.edition, a.batch_kind, a.parent_allocation_id, 1, '{tbl}', 'GENERATED', a.rule_id, 99, a.parent_serial, a.allocated_by_person_id, a.allocated_by_account_id, gen_random_uuid()
         from site.batch_number_allocation a where a.batch_number = '${b1}-P01'`,
        `insert into site.batch_number_allocation (batch_number, site_code, site_zone, product_code, product_name, edition, batch_kind, batch_size, batch_size_unit, source, rule_id, serial, parent_serial, allocated_by_person_id, allocated_by_account_id, correlation_id)
         select 'ATZ0001', a.site_code, a.site_zone, a.product_code, a.product_name, a.edition, a.batch_kind, 1, '{tbl}', 'GENERATED', a.rule_id, 98, 1, a.allocated_by_person_id, a.allocated_by_account_id, gen_random_uuid()
         from site.batch_number_allocation a where a.batch_number = '${b1}'`,
      ]) {
        await c.query('begin');
        try {
          await c.query('set local role ebmr_owner');
          await expect(c.query(sql)).rejects.toThrow(/batch_number_allocation_parent_serial/);
        } finally {
          await c.query('rollback');
        }
      }
    } finally {
      c.release();
    }
  });

  it('[IN-18][INV-27] after the rule\'s counter skipped (restart, restore, ledger ahead) a parent\'s next packaging number passes every number that may have been lost; a parent from before per-parent numbering keeps the rule-wide serial', async () => {
    const pack = (parent: string) => allocate({ ...atv, batchKind: 'PACKAGING', parentBatchNumber: parent, batchSize: '1000' });
    const b = (await allocate(atv)).batchNumber;
    expect((await pack(b)).batchNumber).toBe(`${b}-P01`);
    const c = await db.admin.connect();
    try {
      // The rule's counter skipped three serials after the parent was allocated: up to three of its numbers may exist elsewhere.
      await c.query(
        "begin; set local session_replication_role = replica; insert into continuity.sequence_bump (sequence_key, source_kind, reason, value_before, value_after, correlation_id) values ('site.batch_number:AT-PACK', 'COUNTER', 'SERVER_RESTART', 100, 103, gen_random_uuid()); commit",
      );
      expect((await pack(b)).batchNumber).toBe(`${b}-P05`);
      expect((await pack(b)).batchNumber).toBe(`${b}-P06`);
      // A parent allocated after the skip starts at P01.
      const later = (await allocate(atv)).batchNumber;
      expect((await pack(later)).batchNumber).toBe(`${later}-P01`);
      // A parent allocated before per-parent numbering came into force continues on the rule's serial.
      await c.query("begin; set local session_replication_role = replica; update site.batch_number_parent_serial_since set since = clock_timestamp() + interval '1 day'; commit");
      const old = await pack(later);
      expect(old.batchNumber).toBe(`${later}-P${String(old.serial).padStart(2, '0')}`);
      expect(Number(old.serial)).toBeGreaterThan(2);
    } finally {
      await c.query("begin; set local session_replication_role = replica; update site.batch_number_parent_serial_since set since = '-infinity'; commit");
      c.release();
    }
    expect(await batchNumberInvariantViolations(db.app)).toEqual([]);
  });

  it('[DI-27][IN-18] a numbering rule or a registered number dated in another zone than the site\'s (an Etc offset, an alias, another IANA zone) is refused (EBMR-SITE-002) and nothing is written, also when the owner writes the row (lead TODO T10)', async () => {
    const counts = async () =>
      (await db.admin.query<{ rules: string; numbers: string }>('select (select count(*) from site.batch_number_rule)::text as rules, (select count(*) from site.batch_number_allocation)::text as numbers')).rows[0];
    const before = await counts();
    const notTheSite = (zone: string) => new RegExp(`^EBMR-SITE-002 site zone ${zone.replace('/', '\\/').replace('+', '\\+')} is not the zone of this site \\(Asia\\/Kolkata\\)`);
    const rule = { siteCode: SITE, productCode: 'ZONE1', batchKind: 'PROCESSING' as const, format: 'ZN{YY}{SEQ:3}', reason: 'Numbering SOP-QA-017 rev 3' };
    // Etc/GMT-5 is five hours ahead of UTC (inverted POSIX sign): the database knows it, it names no place, and it is not the site's.
    for (const zone of ['Etc/GMT-5', 'Europe/Berlin', 'UTC']) {
      await expect(define({ ...rule, ruleCode: `ZONE-${randomUUID().slice(0, 6).toUpperCase()}`, siteZone: zone })).rejects.toThrow(notTheSite(zone));
      await expect(
        withCommand(db.app, issuer, (c) => registerExternalBatchNumber(c, { ...atv, batchNumber: `ZX${randomUUID().slice(0, 6).toUpperCase()}`, siteZone: zone })),
      ).rejects.toThrow(notTheSite(zone));
    }
    // An alias the database does not list is refused by the function's own check, as before.
    await expect(define({ ...rule, ruleCode: 'ZONE-IST', siteZone: 'IST' })).rejects.toThrow('EBMR-SITE-002 unknown site time zone IST');
    // The row guard holds for the owner's direct write too (no function in between).
    const c = await db.admin.connect();
    try {
      await expect(
        c.query(
          `insert into site.batch_number_rule (rule_code, site_code, batch_kind, format, site_zone, counter_key, effective_from, reason, created_by_person_id, created_by_account_id, correlation_id)
           values ('ZONE-OWNER', $1, 'PROCESSING', 'ZO{SEQ:3}', 'Etc/GMT-5', 'site.batch_number:ZONE-OWNER', clock_timestamp(), 'test', gen_random_uuid(), gen_random_uuid(), gen_random_uuid())`,
          [SITE],
        ),
      ).rejects.toThrow(notTheSite('Etc/GMT-5'));
    } finally {
      c.release();
    }
    expect(await counts()).toEqual(before);
  });

  it('[INV-27] a rule never wraps its serial around; it is exhausted instead', async () => {
    const tiny: AllocationRequest = { ...atv, productCode: 'TINY1', productName: 'Tiny', batchSize: '1', batchSizeUnit: '{tbl}' };
    const numbers: string[] = [];
    for (let i = 0; i < 9; i++) numbers.push((await allocate(tiny)).batchNumber);
    expect(numbers).toEqual(['TN1', 'TN2', 'TN3', 'TN4', 'TN5', 'TN6', 'TN7', 'TN8', 'TN9']);
    await expect(allocate(tiny)).rejects.toThrow('EBMR-SITE-012');
  });

  it('[INV-27][IN-18] the application role cannot write the register, draw a serial or rewrite history directly', async () => {
    await expect(
      db.app.query(
        "insert into site.batch_number_allocation (batch_number, site_code, site_zone, product_code, product_name, edition, batch_kind, batch_size, batch_size_unit, source, allocated_by_person_id, allocated_by_account_id, correlation_id) values ('X1', 'PLANT1', 'Asia/Kolkata', 'P', 'P', 'TABLETS', 'PROCESSING', 1, 'kg', 'EXTERNAL', gen_random_uuid(), gen_random_uuid(), gen_random_uuid())",
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(db.app.query("update site.batch_number_allocation set batch_number = 'X2'")).rejects.toThrow(/permission denied/);
    await expect(db.app.query('delete from site.batch_number_void')).rejects.toThrow(/permission denied/);
    await expect(db.app.query("select continuity.next_counter_value('site.batch_number:AT-TAB')")).rejects.toThrow(/permission denied/);
    await expect(db.app.query('select site.allocate_batch_number($1::jsonb)', [JSON.stringify({ site_code: SITE })])).rejects.toThrow('EBMR-SITE-001');
    const c = await db.admin.connect();
    try {
      for (const sql of ['update site.batch_number_allocation set product_name = product_name', 'delete from site.batch_number_void', 'delete from site.batch_number_allocation']) {
        await c.query('begin');
        try {
          await c.query('set local role ebmr_owner');
          await expect(c.query(sql)).rejects.toThrow(/EBMR-AUDIT-004|violates foreign key/);
        } finally {
          await c.query('rollback');
        }
      }
    } finally {
      c.release();
    }
  });

  it('[INV-27] a superuser who moves a counter back cannot cause reuse: allocation refuses and the invariant query reports it', async () => {
    expect(await batchNumberInvariantViolations(db.app)).toEqual([]);
    const before = await db.admin.query<{ v: string }>("select last_value::text as v from continuity.counter where sequence_key = 'site.batch_number:AT-TAB'");
    const c = await db.admin.connect();
    try {
      await c.query("begin; set local session_replication_role = replica; update continuity.counter set last_value = 1 where sequence_key = 'site.batch_number:AT-TAB'; commit");
      expect((await batchNumberInvariantViolations(db.app)).join()).toContain('rule AT-TAB: counter 1 is behind serial');
      await expect(allocate(atv)).rejects.toThrow('EBMR-SITE-017');
    } finally {
      await c.query(`begin; set local session_replication_role = replica; update continuity.counter set last_value = ${Number(before.rows[0]?.v)} where sequence_key = 'site.batch_number:AT-TAB'; commit`);
      c.release();
    }
    expect(await batchNumberInvariantViolations(db.app)).toEqual([]);
  });
});

describe('batch-number register across a restore', () => {
  const siteZone = ZONE;
  let src: TestDatabase;
  let restored: TestDatabase;
  let ledger: FileLedger;
  let issuer: ActorContext;
  let operator: ActorContext;
  let approver: SeededActor;
  const rsv: AllocationRequest = { siteCode: 'PLANT9', productCode: 'RSV5', productName: 'Rosuvastatin Tablets 5 mg', edition: 'TABLETS', batchSize: '100000', batchSizeUnit: '{tbl}' };
  const before: string[] = [];
  let lost: string;
  let restoreEventId: string;
  const pk8: AllocationRequest = { siteCode: 'PLANT8', productCode: 'PK8', productName: 'Packed product 8', edition: 'TABLETS', batchSize: '1000', batchSizeUnit: '{tbl}' };
  let packParent: string;
  let packBefore: string;
  let packLost: string;

  const allocateIn = (db: TestDatabase, req: AllocationRequest) => withProtectedNumbers(db.app, issuer, ledger, (c) => allocateBatchNumber(c, req));

  beforeAll(async () => {
    src = await createTestDatabase();
    ledger = tempLedger('site-restore', dir.path);
    issuer = await testActor(src, { roleCode: 'BATCH_ISSUER' });
    operator = await testActor(src, { roleCode: 'SYSTEM_ADMINISTRATOR' });
    approver = await signerActor(src, 'QA_REVIEWER');
    await ensureSealKey(src); // registered before the backup, so the restored copy can seal the approval
    // Numbering rules are GMP master data (BATCH_NUMBER.RULE_DEFINE, master-data steward), never an administrator's (DI-18).
    const steward = await testActor(src, { roleCode: 'MASTER_DATA_STEWARD' });
    await withCommand(src.app, steward, (c) =>
      defineBatchNumberRule(c, { ruleCode: 'RS-TAB', siteCode: 'PLANT9', productCode: 'RSV5', batchKind: 'PROCESSING', format: '{SITE}{YY}{SEQ:3}', siteZone, reason: 'SOP', blockSize: 2 }),
    );
    // A packaging rule of another site and product, counting per parent batch (recipe-core 1790).
    await withCommand(src.app, steward, (c) =>
      defineBatchNumberRule(c, { ruleCode: 'P8-TAB', siteCode: 'PLANT8', productCode: 'PK8', batchKind: 'PROCESSING', format: 'P8{SEQ:3}', siteZone, reason: 'SOP', blockSize: 2 }),
    );
    await withCommand(src.app, steward, (c) =>
      defineBatchNumberRule(c, { ruleCode: 'P8-PACK', siteCode: 'PLANT8', productCode: 'PK8', batchKind: 'PACKAGING', format: '{PARENT}/P{SEQ:2}', siteZone, reason: 'SOP', blockSize: 2 }),
    );
    before.push((await allocateIn(src, rsv)).batchNumber, (await allocateIn(src, rsv)).batchNumber);
    packParent = (await allocateIn(src, pk8)).batchNumber;
    packBefore = (await allocateIn(src, { ...pk8, batchKind: 'PACKAGING', parentBatchNumber: packParent })).batchNumber;
    await exportAnchor(src.app, ledger);
    const backup = await backupTestDatabase(src, dir.path);
    lost = (await allocateIn(src, rsv)).batchNumber; // issued after the backup, printed on labels, then lost
    packLost = (await allocateIn(src, { ...pk8, batchKind: 'PACKAGING', parentBatchNumber: packParent })).batchNumber;
    await exportAnchor(src.app, ledger);
    restored = await restoreCopy(src, backup, dir.path);

    await expect(allocateIn(restored, rsv)).rejects.toThrow('EBMR-CONT-012');
    const event = await recordRestoreEvent(restored.app, operator, ledger, {
      eventKind: 'FULL_RESTORE',
      backupId: backup.backupId,
      backupTakenAt: backup.snapshotTakenAt,
      performedAt: await dbTime(restored),
      reason: 'Disk failure',
      changeReference: 'INC-2026-0099',
      approverPersonIds: [approver.personId],
    });
    const signature = await signFor(restored, approver, { type: 'restore_event', id: event.restoreEventId }, 'RESTORE_APPROVED', 'RECORDED', { registerKey: false });
    await approveRestoreEvent(restored.app, approver, event.restoreEventId, signature);
    await completeRestore(restored.app, operator, ledger, event.restoreEventId);
    restoreEventId = event.restoreEventId;
  }, 60_000);
  afterAll(async () => {
    await restored?.drop();
    await src?.drop();
  });

  it('[IN-18][INV-27] after a restore the register never reissues a number allocated in the lost window', async () => {
    const yy = await siteYear(restored, 'YY');
    expect(before).toEqual([`PLANT9${yy}001`, `PLANT9${yy}002`]);
    expect(lost).toBe(`PLANT9${yy}003`);
    const next = await allocateIn(restored, { ...rsv, externalReference: 'ERP 1' });
    expect(next.batchNumber).toBe(`PLANT9${yy}005`); // serials 3 and 4 were covered by the lost write-ahead block
    expect([...before, lost]).not.toContain(next.batchNumber);
  });

  it('[IN-18][INV-27] after a restore a packaging number counted per parent batch is never reissued: the parent\'s next number passes every number the skipped serials may have given', async () => {
    expect([packBefore, packLost]).toEqual([`${packParent}/P01`, `${packParent}/P02`]);
    const next = (await allocateIn(restored, { ...pk8, batchKind: 'PACKAGING', parentBatchNumber: packParent })).batchNumber;
    expect([packBefore, packLost]).not.toContain(next);
    expect(next).toBe(`${packParent}/P03`); // the restore skipped one serial: P02 may exist, so P03
    // The lost number is re-entered with the parent serial it shows (and the rule's serial in the skipped range).
    const recover = (parentSerial: string, ruleCode = 'P8-PACK') =>
      withCommand(restored.app, issuer, (c) =>
        recoverBatchNumber(c, { ...pk8, restoreEventId, ruleCode, serial: '2', parentSerial, batchNumber: packLost, parentBatchNumber: packParent, evidenceReference: 'Label specimen' }),
      );
    await expect(recover('3')).rejects.toThrow(`EBMR-SITE-016 ${packLost} is not what rule P8-PACK`);
    await expect(recover('2', 'P8-TAB')).rejects.toThrow('EBMR-SITE-016 rule P8-TAB does not number per parent batch');
    await recover('2');
    const row = await restored.admin.query<{ s: string; ps: string }>('select serial::text as s, parent_serial::text as ps from site.batch_number_allocation where batch_number = $1', [packLost]);
    expect(row.rows).toEqual([{ s: '2', ps: '2' }]);
    expect(await batchNumberInvariantViolations(restored.app)).toEqual([]);
  });

  it('[IN-18][INV-27] a lost number is re-entered only with evidence and only inside the range the restore skipped', async () => {
    const yy = await siteYear(restored, 'YY');
    const recover = (serial: string, batchNumber: string, evidence = 'Paper BMR page 1 and label specimen') =>
      withCommand(restored.app, issuer, (c) => recoverBatchNumber(c, { ...rsv, restoreEventId, ruleCode: 'RS-TAB', serial, batchNumber, evidenceReference: evidence }));

    await expect(recover('3', lost, ' ')).rejects.toThrow('EBMR-SITE-016');
    await expect(recover('7', `PLANT9${yy}007`)).rejects.toThrow('EBMR-SITE-016'); // not skipped by the restore
    await recover('3', lost);
    await expect(recover('3', lost)).rejects.toThrow('EBMR-SITE-013');
    const rows = await exportBatchNumberRegister(restored.app, { siteCode: 'PLANT9' });
    expect(rows.map((r) => [r.batchNumber, r.source])).toEqual([
      [`PLANT9${yy}001`, 'GENERATED'],
      [`PLANT9${yy}002`, 'GENERATED'],
      [`PLANT9${yy}005`, 'GENERATED'],
      [lost, 'RECOVERED_AFTER_RESTORE'],
    ]);
    expect(await batchNumberInvariantViolations(restored.app)).toEqual([]);
  });
});

describe('recovery after a restore is held to the rule it recovers for (F62)', () => {
  const site = 'PLANT7';
  let src: TestDatabase;
  let restored: TestDatabase;
  let ledger: FileLedger;
  let issuer: ActorContext;
  let otherProductIssuer: ActorContext;
  let restoreEventId: string;
  let lostProcessing: string;
  let lostPackaging: string;
  const rpa: AllocationRequest = { siteCode: site, productCode: 'RPA5', productName: 'Ramipril Tablets 5 mg', edition: 'TABLETS', batchSize: '50000', batchSizeUnit: '{tbl}' };
  let yy: string;

  const allocateIn = (db: TestDatabase, req: AllocationRequest) => withProtectedNumbers(db.app, issuer, ledger, (c) => allocateBatchNumber(c, req));
  const recoverAs = (ctx: ActorContext, over: Partial<Parameters<typeof recoverBatchNumber>[1]>) =>
    withCommand(restored.app, { ...ctx, correlationId: randomUUID() }, (c) =>
      recoverBatchNumber(c, { ...rpa, restoreEventId, ruleCode: 'RP-TAB', serial: '2', batchNumber: lostProcessing, evidenceReference: 'Paper BMR page 1 and label specimen', ...over }),
    );

  beforeAll(async () => {
    src = await createTestDatabase();
    ledger = tempLedger('site-recovery', dir.path);
    issuer = await testActor(src, { roleCode: 'BATCH_ISSUER' });
    // A BATCH_ISSUER whose grant is limited to another product at the same site.
    otherProductIssuer = await scopedTestActor(src, 'BATCH_ISSUER', { site, product: 'RPB9' });
    const operator = await testActor(src, { roleCode: 'SYSTEM_ADMINISTRATOR' });
    const approver = await signerActor(src, 'QA_REVIEWER');
    await ensureSealKey(src);
    const steward = await testActor(src, { roleCode: 'MASTER_DATA_STEWARD' });
    const base = { siteCode: site, siteZone: ZONE, reason: 'SOP', blockSize: 1 };
    await withCommand(src.app, steward, (c) => defineBatchNumberRule(c, { ...base, ruleCode: 'RP-TAB', productCode: 'RPA5', batchKind: 'PROCESSING', format: 'RP{YY}{SEQ:3}' }));
    await withCommand(src.app, steward, (c) => defineBatchNumberRule(c, { ...base, ruleCode: 'RP-PACK', productCode: 'RPA5', batchKind: 'PACKAGING', format: '{PARENT}-P{SEQ:2}' }));
    const first = (await allocateIn(src, rpa)).batchNumber;
    await exportAnchor(src.app, ledger);
    const backup = await backupTestDatabase(src, dir.path);
    // Issued after the backup (on paper and labels), then lost by the restore.
    lostProcessing = (await allocateIn(src, rpa)).batchNumber;
    lostPackaging = (await allocateIn(src, { ...rpa, batchKind: 'PACKAGING', parentBatchNumber: first })).batchNumber;
    await exportAnchor(src.app, ledger);
    restored = await restoreCopy(src, backup, dir.path);
    const event = await recordRestoreEvent(restored.app, operator, ledger, {
      eventKind: 'FULL_RESTORE',
      backupId: backup.backupId,
      backupTakenAt: backup.snapshotTakenAt,
      performedAt: await dbTime(restored),
      reason: 'Disk failure',
      changeReference: 'INC-2026-0162',
      approverPersonIds: [approver.personId],
    });
    restoreEventId = event.restoreEventId;
    const signature = await signFor(restored, approver, { type: 'restore_event', id: restoreEventId }, 'RESTORE_APPROVED', 'RECORDED', { registerKey: false });
    await approveRestoreEvent(restored.app, approver, restoreEventId, signature);
    await completeRestore(restored.app, operator, ledger, restoreEventId);
    yy = await siteYear(restored, 'YY');
    expect(lostProcessing).toBe(`RP${yy}002`);
    expect(lostPackaging).toBe(`${first}-P01`);
  }, 90_000);
  afterAll(async () => {
    await restored?.drop();
    await src?.drop();
  });

  it('[DI-17][INV-27] a product-specific rule recovers only its own product, and only under a grant covering that product', async () => {
    await expect(recoverAs(issuer, { productCode: 'RPB9' })).rejects.toThrow('EBMR-SITE-016 rule RP-TAB numbers product RPA5 only, not RPB9');
    // A BATCH_ISSUER limited to another product at the same site is refused in the rule's product scope.
    await expect(recoverAs(otherProductIssuer, { productCode: 'RPB9' })).rejects.toThrow(/EBMR-IAM-040 .*BATCH_NUMBER\.RECOVER/);
    expect((await restored.app.query('select 1 from site.batch_number_allocation where serial = 2 and rule_id = (select id from site.batch_number_rule where rule_code = $1)', ['RP-TAB'])).rowCount).toBe(0);
  });

  it('[INV-27][IN-18] the recovered number must be what the rule gives for that serial; a packaging number links to a processing number of its own site', async () => {
    await expect(recoverAs(issuer, { batchNumber: `RP${yy}005` })).rejects.toThrow(`EBMR-SITE-016 RP${yy}005 is not what rule RP-TAB (format RP{YY}{SEQ:3}) gives for serial 2`);
    await expect(recoverAs(issuer, { batchNumber: 'XX99002' })).rejects.toThrow('EBMR-SITE-016');
    // A processing number of another site, registered from outside, cannot be the parent.
    const elsewhere = `EXT${yy}777`;
    await withCommand(restored.app, { ...issuer, correlationId: randomUUID() }, (c) =>
      registerExternalBatchNumber(c, { ...rpa, siteCode: 'PLANT8', batchNumber: elsewhere, siteZone: ZONE }),
    );
    const packaging = { ruleCode: 'RP-PACK', serial: '1' };
    await expect(recoverAs(issuer, { ...packaging, batchNumber: `${elsewhere}-P01`, parentBatchNumber: elsewhere })).rejects.toThrow('EBMR-SITE-014');
    // The genuine numbers are re-entered.
    await recoverAs(issuer, {});
    const parent = lostPackaging.slice(0, -'-P01'.length);
    await recoverAs(issuer, { ...packaging, batchNumber: lostPackaging, parentBatchNumber: parent });
    const rows = await exportBatchNumberRegister(restored.app, { siteCode: site });
    expect(rows.filter((r) => r.source === 'RECOVERED_AFTER_RESTORE').map((r) => r.batchNumber).sort()).toEqual([lostPackaging, lostProcessing].sort());
    expect(await batchNumberInvariantViolations(restored.app)).toEqual([]);
  });
});
