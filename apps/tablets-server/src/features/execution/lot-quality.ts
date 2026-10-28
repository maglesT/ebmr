/**
 * A lot's facts for the blocks besides its status (Phase 7 slice 7o; R4, R8): the current approved assay result a
 * potency-adjusted dispensing reads (TB-01; tablets 0841 tab.record_lot_assay, tab.lot_assay_result) and the artwork
 * version a printed packaging lot was checked with (G-21; tablets 0950 tab.record_lot_artwork). Before, only the demo
 * seed recorded them, so a company's own lot could never be dispensed potency-adjusted or issued as printed packaging.
 * On both installations, each against its own database: a TEST- lot in the sandbox (MASTERDATA.CHANGE), a material lot
 * of the site on GMP (QC.RESULT_RECORD at the lot's site); every rule is the database's (a later assay supersedes the
 * current one with the person's reason; an artwork version is recorded once and never changes).
 */
import type { LotQualityView } from '@ebmr/api-contract';
import type { z } from 'zod';
import { sandbox } from '@ebmr/kernel';
import type { AppContext } from '../../platform/context.ts';
import { refusal } from '../../platform/http/refusal.ts';
import type { Db } from './runs.ts';
import { asIsAssay, exact, type LotAssay } from '../../blocks/dispensing/potency.ts';

type View = z.infer<typeof LotQualityView>;

/** The lot's site on GMP (the one site whose register holds the code), null in the sandbox. */
export async function lotSite(app: AppContext, db: Db, code: string): Promise<string | null> {
  if (app.installation !== 'GMP') return null;
  const problem = sandbox.identifierProblem('GMP', 'LOT_NUMBER', code);
  if (problem) {
    throw refusal(422, { code: problem.code, kind: 'NOT_ALLOWED', whatHappened: 'This lot is not a lot of this installation.', why: problem.message, controls: ['DI-05'], whatYouCanDo: ['Name a material lot of this site; test lots (TEST-) belong to the sandbox only.'] });
  }
  const { rows } = await db.query<{ site: string }>('select site_code as site from site.material_lot where lot_code = $1', [code]);
  if (rows.length !== 1) {
    throw refusal(404, { code: 'EBMR-API-NOT-FOUND', kind: 'STALE', whatHappened: `Lot ${code} was not found.`, why: rows.length === 0 ? 'No material lot has this code.' : 'Several sites hold a lot of this code.', whatYouCanDo: ['Check the lot code on the label.'] });
  }
  return rows[0]?.site ?? null;
}

/** The current assay result and the artwork version of lot `code` of this installation's register. */
export async function lotQuality(app: AppContext, db: Db, code: string): Promise<View> {
  const site = await lotSite(app, db, code);
  const lotFilter = app.installation === 'GMP'
    ? '(select l.id from site.material_lot l where l.lot_code = $1 and l.site_code = $2)'
    : null;
  const where = lotFilter ? `material_lot_id = ${lotFilter}` : 'sandbox_lot_code = $1';
  const params = lotFilter ? [code, site] : [code];
  if (!lotFilter) {
    const known = await db.query('select 1 from tab.sandbox_lot where lot_code = $1', [code]);
    if ((known.rowCount ?? 0) === 0) throw refusal(404, { code: 'EBMR-API-NOT-FOUND', kind: 'STALE', whatHappened: `Lot ${code} was not found.`, why: 'No test lot has this code.', whatYouCanDo: ['Check the lot code.'] });
  }
  const a = await db.query<{ id: string; basis: NonNullable<View['assay']>['basis']; assay: string; water: string | null; lod: string | null; solvents: string | null; certificate_ref: string; reason: string | null; by: string | null; us: string; current: boolean }>(
    `select r.id::text as id, r.basis, r.assay::text as assay, r.water::text as water, r.lod::text as lod, r.solvents::text as solvents, r.certificate_ref, r.reason,
            (select p.legal_name from iam.person p where p.id = r.recorded_by_person) as by,
            (extract(epoch from r.recorded_at) * 1000000)::numeric(20, 0)::text as us,
            not exists (select 1 from tab.lot_assay_result n where n.supersedes = r.id) as current
       from tab.lot_assay_result r
      where r.${where}
      order by r.recorded_at desc, r.id`,
    params,
  );
  const w = await db.query<{ artwork: string }>(`select artwork_version as artwork from tab.printed_lot_artwork where ${where}`, params);
  const r = a.rows.find((x) => x.current);
  // R13: on GMP, the LIMS results the current result's values were copied from, and whether all are still approved.
  const sources = r && app.installation === 'GMP'
    ? (
        await db.query<{ value: 'assay' | 'water' | 'lod' | 'solvents'; result_id: string; test_code: string; result: string; unit: string; state: string | null }>(
          `select s.value_kind as value, s.lims_result_id::text as result_id, t.test_code, trim_scale(t.result_value)::text as result, t.unit, site.lot_test_state(t.id) as state
             from tab.lot_assay_source s join site.lot_test_result t on t.id = s.lims_result_id
            where s.assay_result_id = $1 order by array_position(array['assay', 'water', 'lod', 'solvents'], s.value_kind)`,
          [r.id],
        )
      ).rows
    : null;
  return {
    lotCode: code,
    assay: r
      ? {
          basis: r.basis,
          assay: r.assay,
          water: r.water,
          lod: r.lod,
          solvents: r.solvents,
          certificateRef: r.certificate_ref,
          recordedAt: app.formatInstant(r.us),
          asIs: asIsOf(r),
          ...(sources
            ? {
                usable: sources.some((x) => x.value === 'assay') && sources.every((x) => x.state === 'APPROVED'),
                sources: sources.map((x) => ({ value: x.value, resultId: x.result_id, testCode: x.test_code, result: x.result, unit: x.unit, state: x.state ?? 'UNKNOWN' })),
              }
            : {}),
        }
      : null,
    artwork: w.rows[0]?.artwork ?? null,
    history: a.rows.map((x) => ({
      basis: x.basis,
      assay: x.assay,
      water: x.water,
      lod: x.lod,
      solvents: x.solvents,
      asIs: asIsOf(x),
      certificateRef: x.certificate_ref,
      reason: x.reason,
      by: x.by ?? 'unknown person',
      recordedAt: app.formatInstant(x.us),
      current: x.current,
    })),
  };
}

/** R13: the as-is potency in % of a result's values, exactly as TB-01 takes it (null when it cannot be computed). */
function asIsOf(r: { basis: string; assay: string; water: string | null; lod: string | null; solvents: string | null }): string | null {
  const v = asIsAssay({ basis: r.basis as LotAssay['basis'], assay: r.assay, ...(r.water !== null ? { water: r.water } : {}), ...(r.lod !== null ? { lod: r.lod } : {}), ...(r.solvents !== null ? { solvents: r.solvents } : {}) });
  return v.ok ? exact(v.value) : null;
}
