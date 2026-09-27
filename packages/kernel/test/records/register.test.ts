import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withCommand } from '../../src/db/command.ts';
import {
  approveRecordType,
  assertClassificationValid,
  BASELINE_RECORD_TYPES,
  classificationProblems,
  defineRecordType,
} from '../../src/records/register.ts';
import { createTestDatabase, type TestDatabase } from '../support/db.ts';
import { recordType, registerType, testActor } from './helpers.ts';

let db: TestDatabase;

beforeAll(async () => {
  db = await createTestDatabase();
  // Stub MBR (the real MBR validator arrives in Phase 2): approval checks every element's
  // classification through records.assert_classification_valid, as the Phase 2 validator will.
  await db.admin.query(`
    create schema stub_mbr authorization ebmr_owner;
    set role ebmr_owner;
    grant usage on schema stub_mbr to ebmr_app;
    create table stub_mbr.stub_mbr (id uuid primary key, status text not null default 'DRAFT');
    create table stub_mbr.stub_mbr_element (
      id uuid primary key default gen_random_uuid(),
      mbr_id uuid not null references stub_mbr.stub_mbr (id),
      element_ref text not null,
      record_type_code text,
      data_class text not null,
      feeds_acceptance_limit boolean not null
    );
    grant select, insert on stub_mbr.stub_mbr, stub_mbr.stub_mbr_element to ebmr_app;
    grant update (status) on stub_mbr.stub_mbr to ebmr_app;
    create function stub_mbr.stub_approve_mbr(p_mbr uuid) returns void language plpgsql as $$
    declare e record;
    begin
      for e in select * from stub_mbr.stub_mbr_element where mbr_id = p_mbr order by element_ref loop
        perform records.assert_classification_valid(e.element_ref, e.data_class, e.feeds_acceptance_limit, e.record_type_code);
      end loop;
      update stub_mbr.stub_mbr set status = 'APPROVED' where id = p_mbr;
    end $$;
    grant execute on function stub_mbr.stub_approve_mbr(uuid) to ebmr_app;
    reset role;
  `);
  await registerType(db, recordType('IPC_RESULT', { feedsAcceptanceLimit: true, dataClass: 'RAW' }));
  await registerType(db, recordType('OPERATOR_NOTE', { feedsAcceptanceLimit: false, dataClass: 'INFORMATIONAL', gmpCriticality: 'LOW' }));
});

afterAll(async () => {
  await db.drop();
});

async function mbrWith(elements: { ref: string; type?: string; dataClass: string; feeds: boolean }[]): Promise<string> {
  const id = randomUUID();
  await db.app.query('insert into stub_mbr.stub_mbr (id) values ($1)', [id]);
  for (const e of elements) {
    await db.app.query(
      'insert into stub_mbr.stub_mbr_element (mbr_id, element_ref, record_type_code, data_class, feeds_acceptance_limit) values ($1, $2, $3, $4, $5)',
      [id, e.ref, e.type ?? null, e.dataClass, e.feeds],
    );
  }
  return id;
}

async function mbrStatus(id: string): Promise<string> {
  const { rows } = await db.app.query<{ status: string }>('select status from stub_mbr.stub_mbr where id = $1', [id]);
  return rows[0]?.status ?? '';
}

describe('DI-01 raw-data floor', () => {
  it('[DI-01] approving an MBR whose IPC result feeding an acceptance limit is classified informational is blocked', async () => {
    const mbr = await mbrWith([
      { ref: 'STEP-3/IPC-hardness', type: 'IPC_RESULT', dataClass: 'INFORMATIONAL', feeds: true },
      { ref: 'STEP-3/operator-note', type: 'OPERATOR_NOTE', dataClass: 'INFORMATIONAL', feeds: false },
    ]);
    await expect(db.app.query('select stub_mbr.stub_approve_mbr($1)', [mbr])).rejects.toThrow(/EBMR-REC-010 .*\[item STEP-3\/IPC-hardness\]/);
    expect(await mbrStatus(mbr)).toBe('DRAFT');
  });

  it('[DI-01] the register class of the record type counts even when the element claims it feeds no limit', async () => {
    const mbr = await mbrWith([{ ref: 'STEP-4/IPC-weight', type: 'IPC_RESULT', dataClass: 'DERIVED', feeds: false }]);
    await expect(db.app.query('select stub_mbr.stub_approve_mbr($1)', [mbr])).rejects.toThrow('EBMR-REC-010');
    expect(await mbrStatus(mbr)).toBe('DRAFT');
  });

  it('[DI-01] the same MBR with the IPC result classified raw is approved', async () => {
    const mbr = await mbrWith([
      { ref: 'STEP-3/IPC-hardness', type: 'IPC_RESULT', dataClass: 'RAW', feeds: true },
      { ref: 'STEP-3/operator-note', type: 'OPERATOR_NOTE', dataClass: 'INFORMATIONAL', feeds: false },
    ]);
    await db.app.query('select stub_mbr.stub_approve_mbr($1)', [mbr]);
    expect(await mbrStatus(mbr)).toBe('APPROVED');
  });

  it('[DI-01] an element of an unregistered record type, or weaker than its register class, is refused', async () => {
    await expect(assertClassificationValid(db.app, { itemRef: 'X', dataClass: 'RAW', feedsAcceptanceLimit: true, recordTypeCode: 'NOT_REGISTERED' })).rejects.toThrow(
      'EBMR-REC-013',
    );
    // A DERIVED type cannot be declared through the register when it feeds a limit, so use a RAW type
    // that feeds nothing: classifying its element INFORMATIONAL is weaker than the register allows.
    await registerType(db, recordType('LOGBOOK_ENTRY', { feedsAcceptanceLimit: false, dataClass: 'RAW', retentionKey: 'SUPPORTING_RECORD' }));
    await expect(assertClassificationValid(db.app, { itemRef: 'Y', dataClass: 'INFORMATIONAL', feedsAcceptanceLimit: false, recordTypeCode: 'LOGBOOK_ENTRY' })).rejects.toThrow(
      'EBMR-REC-014',
    );
  });

  it('[DI-01] the bulk check lists every problem for a validator', async () => {
    const problems = await classificationProblems(db.app, [
      { itemRef: 'A', dataClass: 'RAW', feedsAcceptanceLimit: true },
      { itemRef: 'B', dataClass: 'INFORMATIONAL', feedsAcceptanceLimit: true },
      { itemRef: 'C', dataClass: 'DERIVED', feedsAcceptanceLimit: true, recordTypeCode: 'IPC_RESULT' },
      { itemRef: 'D', dataClass: 'INFORMATIONAL', feedsAcceptanceLimit: false, recordTypeCode: 'OPERATOR_NOTE' },
    ]);
    expect(problems.map((p) => p.itemRef)).toEqual(['B', 'C']);
    expect(problems.every((p) => p.problem.startsWith('EBMR-REC-010'))).toBe(true);
  });

  it('[DI-01] the register refuses a record type that feeds an acceptance limit but is not raw, through the function and by constraint', async () => {
    const qa = await testActor(db, { roleCode: 'QA_MBR_APPROVER' });
    await expect(withCommand(db.app, qa, (c) => defineRecordType(c, recordType('YIELD_CALC', { dataClass: 'DERIVED', feedsAcceptanceLimit: true })))).rejects.toThrow(
      'EBMR-REC-010',
    );
    // Even the table owner cannot store it: the raw-data floor is also a table constraint.
    await expect(
      db.admin.query(
        `insert into records.record_type (code, version, title, description, official_record, data_class, gmp_criticality, official_medium,
           original_and_copies, storage_location, owning_module, owner_role, retention_key, review_rule, feeds_acceptance_limit, defined_by_person)
         values ('SNEAKY', 1, 't', 'd', true, 'INFORMATIONAL', 'HIGH', 'ELECTRONIC', 'o', 's', 'm', 'QA', 'BATCH_RECORD', 'r', true, gen_random_uuid())`,
      ),
    ).rejects.toThrow(/record_type_raw_data_floor/);
  });
});

describe('DI-01 register content and control', () => {
  it('[DI-01] the register shows the official medium and storage location of each approved record type', async () => {
    await registerType(
      db,
      recordType('BALANCE_PRINTOUT', {
        officialMedium: 'HYBRID',
        hybridLinkage: 'scanned promptly; true copy linked to its step with checksum and verifier signature',
        storageLocation: 'paper in the batch dossier; scan in the eBMR database',
      }),
    );
    const { rows } = await db.app.query<{ code: string; official_medium: string; storage_location: string; raw_data: boolean; version: number }>(
      'select code, official_medium, storage_location, raw_data, version from records.record_register order by code',
    );
    const byCode = new Map(rows.map((r) => [r.code, r]));
    expect(byCode.get('BALANCE_PRINTOUT')).toMatchObject({ official_medium: 'HYBRID', storage_location: 'paper in the batch dossier; scan in the eBMR database', raw_data: true });
    expect(byCode.get('IPC_RESULT')).toMatchObject({ official_medium: 'ELECTRONIC', storage_location: 'eBMR edition database' });
    for (const r of rows) {
      expect(r.official_medium).toMatch(/^(ELECTRONIC|PAPER|HYBRID)$/);
      expect(r.storage_location.length).toBeGreaterThan(0);
    }
  });

  it('[DI-01] a hybrid record type must declare how paper and electronic parts are linked', async () => {
    const qa = await testActor(db, { roleCode: 'QA_MBR_APPROVER' });
    await expect(withCommand(db.app, qa, (c) => defineRecordType(c, recordType('PAPER_FORM', { officialMedium: 'HYBRID' })))).rejects.toThrow('EBMR-REC-016');
  });

  it('[DI-01] a version is in force only after approval by a person other than its author; later versions supersede it', async () => {
    const author = await testActor(db, { roleCode: 'QA_MBR_APPROVER' });
    const other = await testActor(db, { roleCode: 'QA_MBR_APPROVER' });
    const v1 = await withCommand(db.app, author, (c) => defineRecordType(c, recordType('EM_RESULT')));
    expect(await db.app.query("select 1 from records.record_register where code = 'EM_RESULT'").then((r) => r.rowCount)).toBe(0);
    await expect(withCommand(db.app, author, (c) => approveRecordType(c, 'EM_RESULT', v1, randomUUID()))).rejects.toThrow('EBMR-REC-012');
    const system = await testActor(db, { source: 'SYSTEM', roleCode: 'SYSTEM' });
    await expect(withCommand(db.app, system, (c) => approveRecordType(c, 'EM_RESULT', v1, randomUUID()))).rejects.toThrow('EBMR-REC-012');
    await withCommand(db.app, other, (c) => approveRecordType(c, 'EM_RESULT', v1, randomUUID()));
    const v2 = await withCommand(db.app, author, (c) => defineRecordType(c, recordType('EM_RESULT', { storageLocation: 'moved to site archive' })));
    expect(v2).toBe(v1 + 1);
    await withCommand(db.app, other, (c) => approveRecordType(c, 'EM_RESULT', v2, randomUUID()));
    await expect(withCommand(db.app, other, (c) => approveRecordType(c, 'EM_RESULT', v1, randomUUID()))).rejects.toThrow('EBMR-REC-015');
    const { rows } = await db.app.query<{ version: number; storage_location: string }>("select version, storage_location from records.record_register where code = 'EM_RESULT'");
    expect(rows).toEqual([{ version: v2, storage_location: 'moved to site archive' }]);
  });

  it('[DI-01] register rows cannot be written or changed by the application role, and are insert-only for everyone', async () => {
    await expect(db.app.query("update records.record_type set storage_location = 'x'")).rejects.toThrow(/permission denied/);
    await expect(db.app.query("insert into records.record_type_approval (code, version, approved_by_person, approval_signature_id) values ('IPC_RESULT', 9, gen_random_uuid(), gen_random_uuid())")).rejects.toThrow(
      /permission denied/,
    );
    await expect(db.app.query('delete from records.record_type_approval')).rejects.toThrow(/permission denied/);
    await expect(db.admin.query("update records.record_type set storage_location = 'x' where code = 'IPC_RESULT'")).rejects.toThrow('EBMR-AUDIT-004');
  });

  it('[DI-01] every register change is in the audit trail', async () => {
    const { rows } = await db.app.query<{ action: string; table_name: string }>(
      "select action, table_name from kernel.audit_event where chain_key = 'record_type:IPC_RESULT' order by seq",
    );
    expect(rows).toEqual([
      { action: 'INSERT', table_name: 'records.record_type' },
      { action: 'INSERT', table_name: 'records.record_type_approval' },
    ]);
  });

  it('[DI-01] the proposed baseline register is accepted by the database and keeps the raw-data floor', async () => {
    for (const def of BASELINE_RECORD_TYPES) {
      if (def.feedsAcceptanceLimit) expect(def.dataClass).toBe('RAW');
      await registerType(db, { ...def, code: `BL_${def.code}`.slice(0, 64) });
    }
    const { rows } = await db.app.query<{ n: string }>("select count(*)::text as n from records.record_register where code like 'BL\\_%'");
    expect(Number(rows[0]?.n)).toBe(BASELINE_RECORD_TYPES.length);
  });
});
