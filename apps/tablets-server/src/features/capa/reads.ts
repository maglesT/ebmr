/**
 * The CAPA register's reads (Phase 6 slice 6a, builder B; ns/capa.ts; site services 0925). Every value is the
 * database's: the state, the overdue flags and the checks' due dates come from site.capa_view (computed on the site's
 * date), the reason a CAPA cannot close from site.capa_close_problem. Names are read for the person ids.
 */
import type { CapaSummaryView, CapaView } from '@ebmr/api-contract';
import type pg from 'pg';
import { refusal } from '../../platform/http/refusal.ts';
import { peopleOf } from '../common/people.ts';

type Db = Pick<pg.Pool, 'query'>;

interface RawView {
  capaId: string; ref: string; origin: 'STAND_IN' | 'QMS'; title: string; description: string | null; sourceKind: CapaSummaryView['sourceKind'];
  sourceRef: string | null; ownerPersonId: string | null; dueOn: string | null; needsMasterChange: boolean; raisedBy: string; state: CapaSummaryView['state'];
  overdue: boolean; versionToken: string | null; qmsEffectivenessDueOn: string | null;
  deviations: CapaView['deviations']; masterVersions: CapaView['masterVersions'];
  checks: CapaView['checks']; events: { event: CapaView['events'][number]['event']; note: string | null; by: string }[];
  qmsHistory: { status: string; versionToken: string; messageId: string }[];
}

async function rawViews(db: Db, ids: string[]): Promise<{ raw: RawView; closeProblem: string | null }[]> {
  if (ids.length === 0) return [];
  const { rows } = await db.query<{ v: RawView; p: string | null }>(
    'select site.capa_view(x.id) as v, site.capa_close_problem(x.id) as p from unnest($1::uuid[]) with ordinality x(id, n) order by x.n',
    [ids],
  );
  return rows.map((r) => ({ raw: r.v, closeProblem: r.p }));
}

function summary(v: RawView, names: Map<string, { legalName: string }>): CapaSummaryView {
  return {
    capaId: v.capaId, ref: v.ref, origin: v.origin, title: v.title, sourceKind: v.sourceKind, sourceRef: v.sourceRef, ownerPersonId: v.ownerPersonId,
    ownerName: v.ownerPersonId ? (names.get(v.ownerPersonId)?.legalName ?? null) : null, dueOn: v.dueOn, state: v.state, overdue: v.overdue,
    versionToken: v.versionToken, overdueChecks: v.checks.filter((c) => c.status === 'OVERDUE').length, needsMasterChange: v.needsMasterChange,
  };
}

export async function capaRegister(db: Db, query: { state?: CapaSummaryView['state'] | undefined; overdue?: 'true' | undefined }): Promise<{ mode: 'STAND_IN' | 'MIRROR'; capas: CapaSummaryView[] }> {
  const mode = (await db.query<{ m: 'STAND_IN' | 'MIRROR' }>('select site.qms_mode() as m')).rows[0]?.m ?? 'STAND_IN';
  const { rows } = await db.query<{ id: string }>(
    `select c.id from site.capa c
      where ($1::text is null or site.capa_state(c.id) = $1)
      order by case when site.capa_state(c.id) in ('CLOSED', 'CANCELLED') then 1 else 0 end, c.due_on nulls last, c.raised_at desc
      limit 500`,
    [query.state ?? null],
  );
  const views = await rawViews(db, rows.map((r) => r.id));
  const names = await peopleOf(db, views.map((v) => v.raw.ownerPersonId));
  const capas = views.map((v) => summary(v.raw, names)).filter((c) => query.overdue !== 'true' || c.overdue || c.overdueChecks > 0);
  return { mode, capas };
}

export async function capaDetail(db: Db, capaId: string): Promise<CapaView> {
  const [found] = await rawViews(db, [capaId]);
  if (!found?.raw) {
    throw refusal(404, { code: 'EBMR-CAPA-003', kind: 'INVALID_INPUT', whatHappened: 'There is no CAPA with this id.', why: `CAPA ${capaId} does not exist.`, whatYouCanDo: ['Open the CAPA from the register.'] });
  }
  const v = found.raw;
  const names = await peopleOf(db, [v.ownerPersonId, v.raisedBy, ...v.events.map((e) => e.by)]);
  const name = (id: string): string => names.get(id)?.legalName ?? 'unknown person';
  return {
    ...summary(v, names),
    description: v.description,
    raisedBy: name(v.raisedBy),
    qmsEffectivenessDueOn: v.qmsEffectivenessDueOn,
    deviations: v.deviations,
    masterVersions: v.masterVersions,
    checks: v.checks.map((c) => ({ checkId: c.checkId, criteria: c.criteria, periodDays: c.periodDays, scheduledOn: c.scheduledOn, dueOn: c.dueOn, status: c.status, effective: c.effective, evidence: c.evidence })),
    events: v.events.map((e) => ({ event: e.event, note: e.note, by: name(e.by) })),
    qmsHistory: v.qmsHistory.map((h) => ({ status: h.status, versionToken: h.versionToken, messageId: h.messageId })),
    closeProblem: found.closeProblem,
    signable: { aggregateType: 'capa', aggregateId: v.capaId, meaning: 'CAPA_CLOSED', expectedState: 'IMPLEMENTED' },
  };
}
