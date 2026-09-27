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
import { backupTestDatabase, createTestDatabase, dbTime, restoreCopy, tempDir, tempLedger, testActor, type TestDatabase } from './helpers.ts';

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

  it('[IN-18] export the register: allocation date, product identity and batch size are present for every entry', async () => {
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
  let approver: ActorContext;
  const rsv: AllocationRequest = { siteCode: 'PLANT9', productCode: 'RSV5', productName: 'Rosuvastatin Tablets 5 mg', edition: 'TABLETS', batchSize: '100000', batchSizeUnit: '{tbl}' };
  const before: string[] = [];
  let lost: string;
  let restoreEventId: string;

  const allocateIn = (db: TestDatabase, req: AllocationRequest) => withProtectedNumbers(db.app, issuer, ledger, (c) => allocateBatchNumber(c, req));

  beforeAll(async () => {
    src = await createTestDatabase();
    ledger = tempLedger('site-restore', dir.path);
    issuer = await testActor(src, { roleCode: 'BATCH_ISSUER' });
    operator = await testActor(src, { roleCode: 'SYSTEM_ADMINISTRATOR' });
    approver = await testActor(src, { roleCode: 'QA_REVIEWER' });
    // Numbering rules are GMP master data (BATCH_NUMBER.RULE_DEFINE, master-data steward), never an administrator's (DI-18).
    const steward = await testActor(src, { roleCode: 'MASTER_DATA_STEWARD' });
    await withCommand(src.app, steward, (c) =>
      defineBatchNumberRule(c, { ruleCode: 'RS-TAB', siteCode: 'PLANT9', productCode: 'RSV5', batchKind: 'PROCESSING', format: '{SITE}{YY}{SEQ:3}', siteZone, reason: 'SOP', blockSize: 2 }),
    );
    before.push((await allocateIn(src, rsv)).batchNumber, (await allocateIn(src, rsv)).batchNumber);
    await exportAnchor(src.app, ledger);
    const backup = await backupTestDatabase(src, dir.path);
    lost = (await allocateIn(src, rsv)).batchNumber; // issued after the backup, printed on labels, then lost
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
    await approveRestoreEvent(restored.app, approver, event.restoreEventId);
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
