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
  const a = await db.query<{ basis: NonNullable<View['assay']>['basis']; assay: string; water: string | null; lod: string | null; solvents: string | null; certificate_ref: string; us: string }>(
    `select r.basis, r.assay::text as assay, r.water::text as water, r.lod::text as lod, r.solvents::text as solvents, r.certificate_ref,
            (extract(epoch from r.recorded_at) * 1000000)::numeric(20, 0)::text as us
       from tab.lot_assay_result r
      where r.${where} and not exists (select 1 from tab.lot_assay_result n where n.supersedes = r.id)`,
    params,
  );
  const w = await db.query<{ artwork: string }>(`select artwork_version as artwork from tab.printed_lot_artwork where ${where}`, params);
  const r = a.rows[0];
  return {
    lotCode: code,
    assay: r ? { basis: r.basis, assay: r.assay, water: r.water, lod: r.lod, solvents: r.solvents, certificateRef: r.certificate_ref, recordedAt: app.formatInstant(r.us) } : null,
    artwork: w.rows[0]?.artwork ?? null,
  };
}
