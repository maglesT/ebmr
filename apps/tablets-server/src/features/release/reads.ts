/**
 * The reads of the release cockpit (Phase 4 slice 3a; contract ns/release.ts): G-REL per market with this person's
 * acknowledgements, the finished lots and one lot's facts. Every value is the database's (recipe-core 0781, 0782).
 */
import type pg from 'pg';
import type { GrelView, LotReleaseSummaryView, LotReleaseView, ManufacturerReleaseState, ReleaseMarket } from '@ebmr/api-contract';
import type { AppContext } from '../../platform/context.ts';
import { refusal } from '../../platform/http/refusal.ts';
import { peopleOf, personRef } from '../common/people.ts';

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
export async function grelView(db: Db, lotId: string, market: ReleaseMarket, personId: string): Promise<GrelView> {
  const { rows } = await db.query<{ g: GrelRow }>('select recipe.grel_evaluate($1, $2) as g', [lotId, market]);
  const g = rows[0]?.g;
  if (!g) throw noLot(lotId);
  const acked = new Set(
    (await db.query<{ a: string[] }>('select recipe.grel_acknowledged($1, $2, $3, $4) as a', [lotId, market, g.epoch, personId])).rows[0]?.a ?? [],
  );
  return {
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
  const grel = await grelView(db, lotId, 'IN', personId);
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
