/**
 * Phase 7 slice 7b-2 (kernel 1335, 1336): on a Tablets GMP database the sign-off of the periodic evaluation pack is the
 * quality unit's alone, generating it is the CSV and data-integrity lead's, the full export is the CSV / DI lead's and
 * the read-only auditor's, and no administration role holds any of them. The closed batch records and the evaluation
 * sources of every module are registered.
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

describe('the periodic evaluation and the full export on the Tablets roles (kernel 1335, 1336)', () => {
  it('[DI-11] VALIDATION.APPROVE_EVALUATION is held by the quality unit only, VALIDATION.MANAGE by the CSV and data-integrity lead', async () => {
    expect(await holders('VALIDATION.APPROVE_EVALUATION')).toEqual(['QA_MBR_APPROVER', 'QA_REVIEWER']);
    expect(await holders('VALIDATION.MANAGE')).toEqual(['CSV_DI_LEAD']);
  });

  it('[DI-08] RECORD.EXPORT, which the full export needs, is held by the CSV and data-integrity lead and the read-only auditor, and by no administration role', async () => {
    expect(await holders('RECORD.EXPORT')).toEqual(['AUDITOR_READONLY', 'CSV_DI_LEAD']);
    const { rows } = await db.admin.query(`
      select rp.role_code, rp.permission_code from iam.role_permission rp
       where rp.removed_at is null and rp.permission_code in ('VALIDATION.APPROVE_EVALUATION', 'VALIDATION.MANAGE', 'RECORD.EXPORT')
         and exists (select 1 from iam.role_permission x join iam.permission p on p.code = x.permission_code
                      where x.role_code = rp.role_code and x.removed_at is null and p.domain = 'ADMINISTRATION')`);
    expect(rows).toEqual([]);
  });

  it('[DI-08][DI-11] the Tablets database knows the closed batch records and every topic of the evaluation, with the source logs of each module', async () => {
    const { rows: types } = await db.admin.query<{ record_type: string }>('select record_type from report.closed_record_source order by 1');
    expect(types.map((t) => t.record_type)).toEqual(['batch', 'di_investigation', 'incident']);
    const { rows: sources } = await db.admin.query<{ s: string }>("select topic || ' ' || source_log as s from report.evaluation_source order by 1");
    expect(sources.map((s) => s.s)).toEqual([
      'ACCESS_RECERTIFICATION iam.access_recertification', 'AUDIT_TRAIL_REVIEW recipe.batch_review_act', 'BACKUP continuity.backup_job_run',
      'CHANGE_RECORD platform.change_record', 'CHANGE_RECORD recipe.change_record', 'CONFIG_CHANGE platform.config_version', 'DEVIATION site.deviation',
      'INCIDENT records.incident', 'INTEGRATION_ALARM platform.integration_alarm', 'INTEGRITY_CHECK kernel.audit_verification_run',
      'OPEN_ISSUE records.di_investigation', 'OPEN_ISSUE records.incident', 'RESTORE_DRILL continuity.restore_drill', 'TIME_SYNC platform.time_anomaly',
    ]);
  });
});
