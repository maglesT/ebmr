/**
 * Phase 6A slice 6A-0 (tablets 1330; kernel 1240 to 1244): on a Tablets GMP database the analytics permissions are held
 * by exactly the mapped Tablets roles and by no administration role, flags about a person stay with the data-integrity
 * reviewer, and the analytics role holds nothing beyond its allow-list there either.
 */
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { sandbox } from '@ebmr/kernel';
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

describe('the analytics permissions of the Tablets roles (tablets 1330)', () => {
  it('[DI-52][DI-53] each analytics permission is held by exactly its Tablets roles, ANALYTICS.DI_REVIEW by the data-integrity reviewer alone, none by an administration role', async () => {
    const { rows } = await db.admin.query<{ code: string; roles: string[] }>(`
      select p.code, coalesce(array_agg(rp.role_code order by rp.role_code collate "C") filter (where rp.role_code is not null), '{}') as roles
        from iam.permission p left join iam.role_permission rp on rp.permission_code = p.code and rp.removed_at is null
       where p.code like 'ANALYTICS.%' group by p.code order by p.code`);
    expect(Object.fromEntries(rows.map((r) => [r.code, r.roles]))).toEqual({
      'ANALYTICS.DISPOSITION': ['CSV_DI_LEAD', 'QA_REVIEWER'],
      'ANALYTICS.DI_REVIEW': ['CSV_DI_LEAD'],
      'ANALYTICS.METHOD': ['PROCESS_OWNER', 'QA_REVIEWER'],
      'ANALYTICS.VIEW': ['AUTHORISED_PERSON', 'CSV_DI_LEAD', 'EU_QP', 'HEAD_OF_PRODUCTION', 'QA_REVIEWER'],
    });
    const { rows: admins } = await db.admin.query(`
      select rp.role_code, rp.permission_code from iam.role_permission rp
       where rp.removed_at is null and rp.permission_code like 'ANALYTICS.%'
         and (rp.role_code in ('SYSTEM_ADMINISTRATOR', 'BREAK_GLASS_ADMIN', 'SERVICE_ACCOUNT', 'STATUS_DISPLAY', 'VENDOR_SUPPORT')
              or exists (select 1 from iam.role_permission x join iam.permission p on p.code = x.permission_code
                          where x.role_code = rp.role_code and x.removed_at is null and p.domain = 'ADMINISTRATION'))`);
    expect(admins).toEqual([]);
    // The grants are the release's, in the audit trail.
    const { rows: audit } = await db.admin.query<{ role: string }>(
      "select distinct payload -> 'actor' ->> 'role_code' as role from kernel.audit_event where table_name = 'iam.role_permission' and record_id in (select id::text from iam.role_permission where permission_code like 'ANALYTICS.%')",
    );
    expect(audit.map((a) => a.role)).toEqual(['SOFTWARE_RELEASE']);
  });

  it('[DI-51] on the Tablets GMP database the analytics role connects and holds nothing beyond its allow-list', async () => {
    const { rows } = await db.admin.query<{ connect: boolean }>("select has_database_privilege('ebmr_analytics', current_database(), 'CONNECT') as connect");
    expect(rows).toEqual([{ connect: true }]);
    expect(await sandbox.segregationProblems(db.app)).toEqual([]);
  });
});
