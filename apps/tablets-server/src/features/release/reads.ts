/**
 * The reads of the release cockpit (Phase 4 slice 3a; contract ns/release.ts): G-REL per market with this person's
 * acknowledgements, the finished lots and one lot's facts. Every value is the database's (recipe-core 0781, 0782).
 */
import type pg from 'pg';
import type {
  EuImporterView,
  GrelView,
  LotMarketsView,
  LotReleaseSummaryView,
  LotReleaseView,
  ManufacturerReleaseState,
  MarketAddEvaluationView,
  MarketAddOutcome,
  MarketDispositionState,
  MarketDispositionView,
  ReleaseMarket,
} from '@ebmr/api-contract';
import type { AppContext } from '../../platform/context.ts';
import { refusal } from '../../platform/http/refusal.ts';
import { peopleOf, personRef } from '../common/people.ts';
import type { Deviations } from '../../platform/deviations.ts';
import { linkedDeviations, linkedProblem } from '../quality/deviation.ts';

type Db = Pick<pg.Pool, 'query'>;

interface GrelRow {
  lot: string;
  market: ReleaseMarket;
  epoch: string;
  ready: boolean;
  items: { id: string; group: string; title: string; status: 'GREEN' | 'RED' | 'NA'; problem: string | null; evidence: { kind: string; ref: string; label: string }[]; since_review: boolean }[];
}

interface LotRow {
  lot_id: string;
  lot_code: string;
  batch_id: string;
  batch_number: string;
  product_code: string;
  strength: string;
  markets: string[];
  lot_status: string;
  state: ManufacturerReleaseState;
}

interface Facts {
  decision: { decision: 'RELEASED' | 'REJECTED'; person_id: string; role_code: string; us: string; signature_id: string; delegation_id: string | null; reason: string | null; epoch: string; checklist_hash: string } | null;
  justifications: { deviation_id: string; text: string; signature_id: string }[];
  incidents: { incident_id: string; number: string; severity: string; status: string; assessed: boolean }[];
  registration_relevant: { batch_id: string; exception_id: string; title: string; deviation_ref: string | null }[];
  open_investigation_path: boolean;
  validation_batches: { batch_id: string; batch_number: string; purpose: string; outcome: string | null }[];
  post_change: { batch_id: string; batch_number: string; change_record: string; evaluated: boolean }[];
  gates: { release: string[]; reject: string[] };
}

function noLot(lotId: string): Error {
  return refusal(404, { code: 'EBMR-REL-010', kind: 'INVALID_INPUT', whatHappened: 'There is no finished lot with this id.', why: `Lot ${lotId} is no finished lot of a packaging batch.`, whatYouCanDo: ['Open the release queue.'] });
}

/** G-REL of the lot for the market, evaluated now, with the items this person acknowledged at its epoch. */
/**
 * MEDHANTA slice 2: with a Deviations link, the Deviations numbers linked to the lot's batches, each closed or rejected in
 * Deviations, as one more item of group 2 (the database refuses the release itself: sql/1907, dv.release_problem). An
 * unreadable view is RED: release is never shown as allowed without the read.
 */
async function linkedDeviationItem(db: Db, link: Deviations, lotId: string): Promise<GrelView['items'][number] | null> {
  const batches = (await db.query<{ b: string[] }>("select dv.subject_batches('LOT', $1)::text[] as b", [lotId])).rows[0]?.b ?? [];
  const { rows } = await db.query<{ n: number }>('select count(*)::int as n from dv.batch_number_link where batch_id = any ($1::uuid[])', [batches]);
  if ((rows[0]?.n ?? 0) === 0) return null;
  const item = { id: 'G2.DEVIATIONS_LINKED', group: '2', title: 'Deviations linked in the Deviations product are closed or rejected', sinceReview: false, acknowledged: false };
  try {
    const linked = await linkedDeviations(db, link, batches);
    const problem = linkedProblem(linked);
    return {
      ...item,
      status: problem === null ? 'GREEN' : 'RED',
      problem,
      evidence: linked.map((l) => ({ kind: 'DEVIATION_NUMBER', ref: l.number, label: `${l.number} (batch ${l.batchNumber}): ${l.status ?? 'not in Deviations'}` })),
    };
  } catch {
    return { ...item, status: 'RED', problem: 'Connection to Deviations is off: the linked deviations cannot be read, so release is blocked', evidence: [] };
  }
}

export async function grelView(db: Db, lotId: string, market: ReleaseMarket, personId: string, link: Deviations | null = null): Promise<GrelView> {
  const { rows } = await db.query<{ g: GrelRow }>('select recipe.grel_evaluate($1, $2) as g', [lotId, market]);
  const g = rows[0]?.g;
  if (!g) throw noLot(lotId);
  const acked = new Set(
    (await db.query<{ a: string[] }>('select recipe.grel_acknowledged($1, $2, $3, $4) as a', [lotId, market, g.epoch, personId])).rows[0]?.a ?? [],
  );
  const view: GrelView = {
    lotId: g.lot,
    market: g.market,
    epoch: g.epoch,
    ready: g.ready,
    items: g.items.map((i) => ({
      id: i.id,
      group: i.group,
      title: i.title,
      status: i.status,
      problem: i.problem,
      evidence: i.evidence,
      sinceReview: i.since_review,
      acknowledged: i.since_review && acked.has(i.id),
    })),
  };
  const linked = link ? await linkedDeviationItem(db, link, lotId) : null;
  return linked ? { ...view, ready: view.ready && linked.status !== 'RED', items: [...view.items, linked] } : view;
}

function summary(r: LotRow): LotReleaseSummaryView {
  return {
    lotId: r.lot_id,
    lotCode: r.lot_code,
    batchId: r.batch_id,
    batchNumber: r.batch_number,
    productCode: r.product_code,
    strength: r.strength,
    markets: r.markets,
    lotStatus: r.lot_status,
    state: r.state,
  };
}

export async function releaseQueue(db: Db, state?: ManufacturerReleaseState): Promise<LotReleaseSummaryView[]> {
  const { rows } = await db.query<LotRow>('select * from recipe.release_lots()');
  return rows.filter((r) => state === undefined || r.state === state).map(summary);
}

export async function lotRelease(app: AppContext, db: Db, lotId: string, personId: string): Promise<LotReleaseView> {
  const { rows } = await db.query<LotRow>('select * from recipe.release_lots() where lot_id = $1', [lotId]);
  const row = rows[0];
  if (!row) throw noLot(lotId);
  const facts = (await db.query<{ f: Facts }>('select recipe.release_lot_facts($1) as f', [lotId])).rows[0]?.f;
  if (!facts) throw noLot(lotId);
  const grel = await grelView(db, lotId, 'IN', personId, app.platform.deviations);
  const d = facts.decision;
  const people = await peopleOf(db, [d?.person_id]);
  return {
    ...summary(row),
    grel,
    decision: d
      ? {
          decision: d.decision,
          by: personRef(people, d.person_id, d.role_code),
          at: app.formatInstant(d.us),
          signatureId: d.signature_id,
          delegationId: d.delegation_id,
          reason: d.reason,
          epoch: d.epoch,
          checklistHash: d.checklist_hash,
          justifications: facts.justifications.map((j) => ({ deviationId: j.deviation_id, text: j.text, signatureId: j.signature_id })),
        }
      : null,
    incidents: facts.incidents.map((i) => ({ incidentId: i.incident_id, number: i.number, severity: i.severity, status: i.status, assessed: i.assessed })),
    registrationRelevant: facts.registration_relevant.map((r) => ({ batchId: r.batch_id, exceptionId: r.exception_id, title: r.title, deviationRef: r.deviation_ref })),
    openInvestigationPath: facts.open_investigation_path,
    validationBatches: facts.validation_batches.map((b) => ({ batchId: b.batch_id, batchNumber: b.batch_number, purpose: b.purpose, outcome: b.outcome })),
    postChange: facts.post_change.map((b) => ({ batchId: b.batch_id, batchNumber: b.batch_number, changeRecord: b.change_record, evaluated: b.evaluated })),
    gates: {
      release: { ready: facts.gates.release.length === 0, problems: facts.gates.release },
      reject: { ready: facts.gates.reject.length === 0, problems: facts.gates.reject },
    },
    signable: { aggregateType: 'manufacturer_release', release: `${lotId}/RELEASE`, reject: `${lotId}/REJECT` },
  };
}

// ---------------------------------------------------------------------------------------------
// Phase 4 slice 4a: the market dispositions, market-add evaluations and importers (recipe-core 0820 to 0824)
// ---------------------------------------------------------------------------------------------

const micros = (col: string): string => `(extract(epoch from ${col}) * 1000000)::numeric(20, 0)::text`;

interface EvaluationRow {
  subject_kind: 'BATCH' | 'LOT';
  subject_id: string;
  market: ReleaseMarket;
  outcome: MarketAddOutcome;
  items: { id: string; title: string; outcome: MarketAddOutcome; detail: string | null; evidence: { kind: string; ref: string; label: string }[] }[];
}

function evaluationView(e: EvaluationRow): MarketAddEvaluationView {
  return {
    subjectKind: e.subject_kind,
    subjectId: e.subject_id,
    market: e.market,
    outcome: e.outcome,
    items: e.items.map((i) => ({ id: i.id, title: i.title, outcome: i.outcome, detail: i.detail, evidence: i.evidence })),
  };
}

/** The market-add evaluation of a lot or an issued batch for a market, evaluated now (3.3.3). */
export async function marketAddView(db: Db, kind: 'BATCH' | 'LOT', id: string, market: ReleaseMarket): Promise<MarketAddEvaluationView> {
  const { rows } = await db.query<{ e: EvaluationRow }>('select recipe.market_add_evaluate($1, $2, $3) as e', [kind, id, market]);
  const e = rows[0]?.e;
  if (!e || e.items.some((i) => i.id === 'MA.SUBJECT')) {
    throw refusal(404, {
      code: 'EBMR-DSP-011',
      kind: 'INVALID_INPUT',
      whatHappened: `There is no ${kind === 'LOT' ? 'finished lot' : 'issued GMP batch'} with this id.`,
      why: `${kind} ${id} is unknown.`,
      whatYouCanDo: ['Open the release queue.'],
    });
  }
  return evaluationView(e);
}

interface ChangeRow {
  id: string;
  change: 'ADD' | 'REMOVE';
  market: ReleaseMarket;
  subject_kind: 'BATCH' | 'LOT';
  subject_id: string;
  person_id: string;
  us: string;
  signature_id: string;
  change_record: string | null;
  deviation_ref: string | null;
  removed_after_failure: boolean;
  evaluation: EvaluationRow | null;
}

interface CertificationRow {
  id: string;
  source: 'MESSAGE' | 'TRANSCRIBED' | 'IN_SYSTEM';
  outcome: 'CERTIFIED' | 'REJECTED_BY_QP';
  certifier: string;
  mia_number: string;
  certified_us: string;
  importer_code: string | null;
  reference: string;
  verified: boolean;
  person_id: string;
  source_role: string;
  verified_by: string | null;
  reason: string | null;
}

interface UsDecisionRow {
  decision: 'RELEASED' | 'REJECTED';
  person_id: string;
  role_code: string;
  us: string;
  signature_id: string;
  epoch: string;
  checklist_hash: string;
  reason: string | null;
  deviation_id: string | null;
  with_mr: boolean;
}

const gate = (p: string[]): { ready: boolean; problems: string[] } => ({ ready: p.length === 0, problems: p });

/** The US and EU dispositions of the lot: state, G-REL, decision, certifications, market changes and gates. */
export async function lotMarkets(app: AppContext, db: Db, lotId: string, personId: string): Promise<LotMarketsView> {
  const { rows } = await db.query<{ m: ManufacturerReleaseState | null; set: ReleaseMarket[] | null; qp: boolean }>(
    "select recipe.manufacturer_release_state($1) as m, recipe.market_set('LOT', $1) as set, platform.setting_text('release.in_system_qp_certification') = 'ON' as qp",
    [lotId],
  );
  const head = rows[0];
  if (!head?.set) throw noLot(lotId);
  const changes = (
    await db.query<ChangeRow>('select * from recipe.lot_market_changes($1)', [lotId])
  ).rows;
  const decision = (
    await db.query<UsDecisionRow>(
      `select d.decision, d.person_id, d.role_code, ${micros('d.recorded_at')} as us, d.signature_id, d.epoch, d.checklist_hash, d.reason, d.deviation_id,
              d.with_manufacturer_release as with_mr
         from recipe.us_disposition_decision d where d.lot_id = $1`,
      [lotId],
    )
  ).rows[0];
  const certs = (
    await db.query<CertificationRow>('select * from recipe.lot_qp_certifications($1)', [lotId])
  ).rows;
  const people = await peopleOf(db, [decision?.person_id, ...changes.map((c) => c.person_id), ...certs.flatMap((c) => [c.person_id, c.verified_by])]);
  const gates = (
    await db.query<{ release: string[]; reject: string[]; certify: string[] }>(
      "select recipe.us_disposition_gate_problems($1, 'RELEASE') as release, recipe.us_disposition_gate_problems($1, 'REJECT') as reject, recipe.eu_certification_gate_problems($1) as certify",
      [lotId],
    )
  ).rows[0]!;
  const dispositions: MarketDispositionView[] = [];
  for (const market of ['US', 'EU'] as const) {
    const st = (await db.query<{ s: MarketDispositionState | null }>('select recipe.disposition_state($1, $2) as s', [lotId, market])).rows[0]?.s ?? null;
    if (st === null) continue;
    const added = (await db.query<{ a: boolean }>('select recipe.market_added($1, $2) as a', [lotId, market])).rows[0]?.a ?? false;
    const notHere = [`the ${market} disposition is not decided by this act`];
    dispositions.push({
      market,
      state: st,
      grel: st === 'REMOVED' ? null : await grelView(db, lotId, market, personId, app.platform.deviations),
      decision:
        market === 'US' && decision
          ? {
              decision: decision.decision,
              by: personRef(people, decision.person_id, decision.role_code),
              at: app.formatInstant(decision.us),
              signatureId: decision.signature_id,
              epoch: decision.epoch,
              checklistHash: decision.checklist_hash,
              reason: decision.reason,
              deviationId: decision.deviation_id,
              withManufacturerRelease: decision.with_mr,
            }
          : null,
      certifications:
        market === 'EU'
          ? certs.map((c) => ({
              certificationId: c.id,
              source: c.source,
              outcome: c.outcome,
              certifier: c.certifier,
              miaNumber: c.mia_number,
              certifiedAt: app.formatInstant(c.certified_us),
              importerCode: c.importer_code,
              reference: c.reference,
              verified: c.verified,
              recordedBy: personRef(people, c.person_id, c.source_role),
              verifiedBy: c.verified_by ? personRef(people, c.verified_by, '') : null,
              reason: c.reason,
            }))
          : [],
      marketAdd: added && st !== 'REMOVED' ? await marketAddView(db, 'LOT', lotId, market) : null,
      changes: changes
        .filter((c) => c.market === market)
        .map((c) => ({
          changeId: c.id,
          change: c.change,
          market: c.market,
          subjectKind: c.subject_kind,
          subjectId: c.subject_id,
          by: personRef(people, c.person_id, ''),
          at: app.formatInstant(c.us),
          signatureId: c.signature_id,
          changeRecord: c.change_record,
          deviationRef: c.deviation_ref,
          removedAfterFailure: c.removed_after_failure,
          evaluation: c.evaluation ? evaluationView(c.evaluation) : null,
        })),
      inSystemQp: head.qp,
      gates:
        market === 'US'
          ? { release: gate(gates.release), reject: gate(gates.reject), certify: gate(notHere) }
          : { release: gate(notHere), reject: gate(notHere), certify: gate(gates.certify) },
    });
  }
  return { lotId, manufacturerState: head.m ?? 'NOT_READY', markets: head.set, dispositions };
}

/** The EU importers named in technical agreements. */
export async function euImporters(db: Db): Promise<EuImporterView[]> {
  const { rows } = await db.query<{ id: string; code: string; name: string; ta: string; mia: string; fp: string; products: string[] }>(
    `select i.id, i.code, i.name, i.technical_agreement_ref as ta, i.mia_number as mia, i.key_fingerprint as fp,
            coalesce((select array_agg(p.product_code order by p.product_code) from recipe.eu_importer_product p where p.importer_id = i.id), '{}') as products
       from recipe.eu_importer i order by i.code`,
  );
  return rows.map((r) => ({ importerId: r.id, code: r.code, name: r.name, technicalAgreementRef: r.ta, miaNumber: r.mia, keyFingerprint: r.fp, products: r.products }));
}
