/**
 * The reads of the PQR extract (Phase 4 slice 6c; contract ns/pqr.ts). Every value is the database's (recipe-core 0910):
 * the stored result, its SHA-256 and reconciliation, whether it reproduces now, and the AP's sign-off.
 */
import type pg from 'pg';
import type { PqrCounts, PqrExtractSummaryView, PqrExtractView, PqrReconciliation } from '@ebmr/api-contract';
import type { AppContext } from '../../platform/context.ts';
import { refusal } from '../../platform/http/refusal.ts';
import { peopleOf, personRef, usOf } from '../common/people.ts';

type Db = Pick<pg.Pool, 'query'>;

interface Line {
  extract: number;
  register: number;
  missing_from_extract: string[];
  missing_from_register: string[];
}
interface ResultJson {
  counts: Record<string, number>;
  batches: {
    batch_id: string;
    batch_number: string;
    site_code: string;
    record_kind: string;
    purpose: string;
    issued_on: string;
    status: string | null;
    markets: string[];
    export_only: boolean;
    failed: boolean;
    lots: { lot_id: string; lot_code: string; markets: string[]; export_only: boolean; manufacturer_release: string | null; markets_state: Record<string, string | null> | null }[];
    market_removals: { market: string; subject_kind: 'BATCH' | 'LOT'; subject_id: string; sequence: number; deviation_id: string | null; removed_after_failure: boolean }[];
    change_record: string | null;
    deviations: string[];
  }[];
  deviations: { deviation_id: string; ref: string; kind: string; title: string; classification: string; state: string; capa_refs: string[]; no_capa_reason: string | null; batches: string[] }[];
  changes: { change_record_id: string; number: string; title: string; change_class: string }[];
}
interface Row {
  id: string;
  product_code: string;
  period_from: string;
  period_to: string;
  query_version: number;
  result_sha256: string;
  counts: Record<string, number>;
  person_id: string;
  role_code: string;
  ran_us: string;
  signoff: { person_id: string; role_code: string; us: string; signature_id: string } | null;
}

const SUMMARY = `select x.id, x.product_code, x.period_from::text as period_from, x.period_to::text as period_to, x.query_version, x.result_sha256,
                        x.result -> 'counts' as counts, x.person_id, x.role_code, ${usOf('x.recorded_at')} as ran_us,
                        (select jsonb_build_object('person_id', s.person_id, 'role_code', s.role_code, 'us', ${usOf('s.recorded_at')}, 'signature_id', s.signature_id)
                           from recipe.pqr_signoff s where s.extract_id = x.id) as signoff
                   from recipe.pqr_extract x`;

const countsOf = (c: Record<string, number>): PqrCounts => ({
  batches: c['batches'] ?? 0,
  exportOnlyBatches: c['export_only_batches'] ?? 0,
  failedBatches: c['failed_batches'] ?? 0,
  lots: c['lots'] ?? 0,
  exportOnlyLots: c['export_only_lots'] ?? 0,
  marketRemovals: c['market_removals'] ?? 0,
  deviations: c['deviations'] ?? 0,
  deviationsWithCapa: c['deviations_with_capa'] ?? 0,
  changes: c['changes'] ?? 0,
});

async function summaries(app: AppContext, db: Db, rows: Row[]): Promise<PqrExtractSummaryView[]> {
  const people = await peopleOf(db, rows.flatMap((r) => [r.person_id, r.signoff?.person_id]));
  return rows.map((r) => ({
    extractId: r.id,
    productCode: r.product_code,
    periodFrom: r.period_from,
    periodTo: r.period_to,
    queryVersion: r.query_version,
    resultSha256: r.result_sha256,
    counts: countsOf(r.counts),
    ranBy: personRef(people, r.person_id, r.role_code),
    ranAt: app.formatInstant(r.ran_us),
    signOff: r.signoff ? { signedBy: personRef(people, r.signoff.person_id, r.signoff.role_code), signedAt: app.formatInstant(r.signoff.us), signatureId: r.signoff.signature_id } : null,
  }));
}

export async function extractList(app: AppContext, db: Db, productCode: string | undefined): Promise<PqrExtractSummaryView[]> {
  const { rows } = await db.query<Row>(`${SUMMARY} where ($1::text is null or x.product_code = $1) order by x.recorded_at desc, x.id limit 200`, [productCode ?? null]);
  return summaries(app, db, rows);
}

const lineOf = (l: Line | undefined): PqrReconciliation['batches'] => ({
  extract: l?.extract ?? 0,
  register: l?.register ?? 0,
  missingFromExtract: l?.missing_from_extract ?? [],
  missingFromRegister: l?.missing_from_register ?? [],
});

export async function extractView(app: AppContext, db: Db, extractId: string): Promise<PqrExtractView> {
  const { rows } = await db.query<Row & { result: ResultJson; reconciliation: { ok: boolean; problems: string[]; batches?: Line; deviations?: Line; changes?: Line }; query_problem: string | null }>(
    `select s.*, x.result, x.reconciliation, recipe.pqr_query_problem(x.query_version) as query_problem
       from (${SUMMARY} where x.id = $1) s join recipe.pqr_extract x on x.id = s.id`,
    [extractId],
  );
  const r = rows[0];
  if (!r) {
    throw refusal(404, { code: 'EBMR-PQR-020', kind: 'INVALID_INPUT', whatHappened: 'There is no PQR extract with this id.', why: `Extract ${extractId} was never run.`, whatYouCanDo: ['Open the extract from the list.'] });
  }
  // A query whose definition changed cannot be re-run; the extract then does not reproduce (D-P4-8).
  const reproduces = r.query_problem === null && (await db.query<{ r: boolean }>('select recipe.pqr_reproduces($1) as r', [extractId])).rows[0]?.r === true;
  const [summary] = await summaries(app, db, [r]);
  const res = r.result;
  return {
    ...summary!,
    reproduces,
    queryProblem: r.query_problem,
    reconciliation: { ok: r.reconciliation.ok, problems: r.reconciliation.problems, batches: lineOf(r.reconciliation.batches), deviations: lineOf(r.reconciliation.deviations), changes: lineOf(r.reconciliation.changes) },
    batches: res.batches.map((b) => ({
      batchId: b.batch_id,
      batchNumber: b.batch_number,
      siteCode: b.site_code,
      recordKind: b.record_kind,
      purpose: b.purpose,
      issuedOn: b.issued_on,
      status: b.status,
      markets: b.markets,
      exportOnly: b.export_only,
      failed: b.failed,
      lots: b.lots.map((l) => ({ lotId: l.lot_id, lotCode: l.lot_code, markets: l.markets, exportOnly: l.export_only, manufacturerRelease: l.manufacturer_release, marketStates: l.markets_state ?? {} })),
      marketRemovals: b.market_removals.map((m) => ({ market: m.market, subjectKind: m.subject_kind, subjectId: m.subject_id, sequence: m.sequence, deviationId: m.deviation_id, removedAfterFailure: m.removed_after_failure })),
      changeRecord: b.change_record,
      deviations: b.deviations,
    })),
    deviations: res.deviations.map((d) => ({
      deviationId: d.deviation_id,
      ref: d.ref,
      kind: d.kind,
      title: d.title,
      classification: d.classification,
      state: d.state,
      capaRefs: d.capa_refs,
      noCapaReason: d.no_capa_reason,
      batches: d.batches,
    })),
    changes: res.changes.map((c) => ({ changeRecordId: c.change_record_id, number: c.number, title: c.title, changeClass: c.change_class })),
  };
}
