/**
 * Phase 7 slice 7-0 (tablets 1400; kernel 1300): on a Tablets GMP database the validation-summary approval is QA's
 * alone, the system description is the system owner's, CONTROLLED.READ is held by every role that holds another
 * CONTROLLED.* permission and by QA, and no administration role holds any of them.
 */
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { copyDatabase, dropDatabase, openDatabase, uniqueSuffix, type DatabaseHandle } from '@ebmr/test-kit';

let db: DatabaseHandle;

beforeAll(async () => {
  const name = `ebmr_t_${uniqueSuffix()}`;
  await copyDatabase(inject('serverTemplates').gmp.template, name);
  db = openDatabase(name, 'GMP');
});

afterAll(async () => {
  if (!db) return;
  await db.close();
  await dropDatabase(db.name);
});

const holders = async (code: string): Promise<string[]> =>
  (await db.admin.query<{ role_code: string }>(
    'select role_code from iam.role_permission where permission_code = $1 and removed_at is null order by role_code collate "C"', [code])).rows.map((r) => r.role_code);

describe('the Phase 7 permissions of the Tablets roles (tablets 1400)', () => {
  it('[DI-03] VALIDATION.APPROVE_SUMMARY is held by the quality unit only', async () => {
    expect(await holders('VALIDATION.APPROVE_SUMMARY')).toEqual(['QA_MBR_APPROVER', 'QA_REVIEWER']);
  });

  it('[DI-06] CONFIG.SYSTEM_DESCRIPTION is held by the system owner and the CSV and data-integrity lead', async () => {
    expect(await holders('CONFIG.SYSTEM_DESCRIPTION')).toEqual(['CSV_DI_LEAD', 'PROCESS_OWNER']);
  });

  it('[IN-53] CONTROLLED.READ is held by every role holding another CONTROLLED permission and by QA, and by no other role', async () => {
    const { rows } = await db.admin.query<{ role_code: string }>(`
      select distinct role_code from iam.role_permission
       where permission_code like 'CONTROLLED.%' and permission_code <> 'CONTROLLED.READ' and removed_at is null
      union select 'QA_REVIEWER' order by 1`);
    expect(await holders('CONTROLLED.READ')).toEqual(rows.map((r) => r.role_code).sort());
    expect(await holders('CONTROLLED.READ')).toEqual(expect.arrayContaining(['QA_REVIEWER', 'QA_SHOP_FLOOR', 'DISPENSER']));
  });

  it('[DI-18] no administration role holds a Phase 7 permission, and the grants are the release\'s', async () => {
    const { rows } = await db.admin.query(`
      select rp.role_code, rp.permission_code from iam.role_permission rp
       where rp.removed_at is null and rp.permission_code in ('VALIDATION.APPROVE_SUMMARY', 'CONFIG.SYSTEM_DESCRIPTION', 'CONTROLLED.READ')
         and (rp.role_code in ('SYSTEM_ADMINISTRATOR', 'BREAK_GLASS_ADMIN', 'SERVICE_ACCOUNT', 'STATUS_DISPLAY', 'VENDOR_SUPPORT')
              or exists (select 1 from iam.role_permission x join iam.permission p on p.code = x.permission_code
                          where x.role_code = rp.role_code and x.removed_at is null and p.domain = 'ADMINISTRATION'))`);
    expect(rows).toEqual([]);
    const { rows: audit } = await db.admin.query<{ role: string }>(
      "select distinct payload -> 'actor' ->> 'role_code' as role from kernel.audit_event where table_name = 'iam.role_permission' and record_id in (select id::text from iam.role_permission where permission_code in ('VALIDATION.APPROVE_SUMMARY', 'CONFIG.SYSTEM_DESCRIPTION', 'CONTROLLED.READ'))",
    );
    expect(audit.map((a) => a.role)).toEqual(['SOFTWARE_RELEASE']);
  });
});
