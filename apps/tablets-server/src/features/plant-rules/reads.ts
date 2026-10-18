/**
 * The reads of the plant rules and status displays (Phase 6 slice 6b, builder B; contract ns/plant-rules.ts and the
 * equipmentDisplays block of ns/equipment-data.ts; recipe-core 0973 to 0975, site services 0940). Every value is the
 * database's at the moment of the read: plant.status_board, plant.line_station, plant.room_conditions,
 * plant.room_cleaning_state, plant.area_adjacency_current and site.reagent_lot; the area authorisations of the
 * qualification matrix from iam.person_qualification (PR-15).
 */
import type pg from 'pg';
import type { AdjacencyView, AreaAuthorisationMatrixView, AreaAuthorisationRecordView, BetaLactamSubjectView, FacilityRuleSubjectView, Instant, PlantRuleProposalView, LineStationView, ReagentLotView, RoomConditionsView, RoomStateView, StatusBoardEntry } from '@ebmr/api-contract';
import type { AppContext } from '../../platform/context.ts';
import { refusal } from '../../platform/http/refusal.ts';
import { peopleOf, personRef, usOf } from '../common/people.ts';

type Db = Pick<pg.Pool, 'query'>;

const NOW_US = usOf('clock_timestamp()');
const tsUs = (expr: string): string => `case when (${expr}) is null then null else ${usOf(`(${expr})::timestamptz`)} end`;

export async function statusBoard(app: AppContext, db: Db): Promise<{ entries: StatusBoardEntry[]; readAt: Instant }> {
  const { rows } = await db.query<{ b: Record<string, unknown>; since_us: string | null; cleaned_us: string | null; now_us: string }>(
    `select b, ${tsUs("b ->> 'stateSince'")} as since_us, ${tsUs("b ->> 'lastCleanedAt'")} as cleaned_us, ${NOW_US} as now_us
       from plant.status_board() b order by b ->> 'subjectKind' desc, b ->> 'code'`,
  );
  const readAt = app.formatInstant(rows[0]?.now_us ?? (await db.query<{ us: string }>(`select ${NOW_US} as us`)).rows[0]?.us ?? '0');
  const entries = rows.map(({ b, since_us, cleaned_us }): StatusBoardEntry => ({
    subjectKind: b['subjectKind'] as StatusBoardEntry['subjectKind'],
    code: String(b['code']),
    name: String(b['name']),
    kind: String(b['kind']),
    classCode: (b['classCode'] as string | null) ?? null,
    state: (b['state'] as string | null) ?? null,
    stateVersion: (b['stateVersion'] as string | null) ?? null,
    stateSince: since_us === null ? null : app.formatInstant(since_us),
    batch: b['batchId'] ? { batchId: b['batchId'] as string, batchRef: String(b['batchRef']), product: String(b['product']) } : null,
    cleaningState: (b['cleaningState'] as StatusBoardEntry['cleaningState']) ?? null,
    lastCleanedAt: cleaned_us === null ? null : app.formatInstant(cleaned_us),
    openAlarms: Number(b['openAlarms'] ?? 0),
  }));
  return { entries, readAt };
}

export async function lineStation(app: AppContext, db: Db, code: string): Promise<LineStationView> {
  const known = await db.query('select 1 from plant.area where code = $1', [code]);
  if (known.rowCount === 0) throw refusal(404, { code: 'EBMR-PLANT-011', kind: 'INVALID_INPUT', whatHappened: `There is no room or line ${code}.`, whatYouCanDo: ['Check the line code on the station.'], whoCanHelp: ['The shift supervisor'], controls: ['PR-35'] });
  const { rows } = await db.query<{ s: Record<string, unknown>; since_us: string | null; now_us: string }>(
    `select s, ${tsUs("s ->> 'since'")} as since_us, ${NOW_US} as now_us from plant.line_station($1) s`,
    [code],
  );
  const r = rows[0];
  const s = r?.s ?? {};
  return {
    code: String(s['code']),
    name: String(s['name']),
    kind: s['kind'] as LineStationView['kind'],
    state: (s['state'] as string | null) ?? null,
    stateVersion: (s['stateVersion'] as string | null) ?? null,
    batch:
      s['batchId'] && r?.since_us
        ? {
            batchId: s['batchId'] as string,
            batchRef: String(s['batchRef']),
            product: String(s['product']),
            productName: (s['productName'] as string | null) ?? null,
            stage: String(s['stage']),
            packagingOrder: (s['packagingOrder'] as string | null) ?? null,
            artworkSet: (s['artworkSet'] as string | null) ?? null,
            since: app.formatInstant(r.since_us),
          }
        : null,
    readAt: app.formatInstant(r?.now_us ?? '0'),
  };
}

interface RoomRow {
  code: string;
  name: string;
  kind: 'ROOM' | 'LINE';
  cleaning_state: RoomStateView['cleaningState'];
  cleaned_us: string | null;
  hold_s: string | null;
  authorisation_required: boolean | null;
  version: number | null;
  open_spills: number;
}

const ROOMS = `
  select a.code, a.name, a.kind, c.cleaning_state, ${tsUs('c.last_cleaned_at')} as cleaned_us,
         case when r.clean_hold is null then null else floor(extract(epoch from r.clean_hold))::bigint::text end as hold_s,
         r.authorisation_required, r.version, c.open_spills
  from plant.area a join plant.room_cleaning_state c on c.area_id = a.id left join plant.area_rule_current r on r.area_id = a.id`;

const roomView = (app: AppContext, r: RoomRow): RoomStateView => ({
  code: r.code,
  name: r.name,
  kind: r.kind,
  cleaningState: r.cleaning_state,
  lastCleanedAt: r.cleaned_us === null ? null : app.formatInstant(r.cleaned_us),
  cleanHoldSeconds: r.hold_s,
  authorisationRequired: r.authorisation_required ?? false,
  ruleVersion: r.version === null ? null : r.version.toString(),
  openSpills: r.open_spills,
});

export async function rooms(app: AppContext, db: Db): Promise<RoomStateView[]> {
  const { rows } = await db.query<RoomRow>(`${ROOMS} order by a.code`);
  return rows.map((r) => roomView(app, r));
}

export async function room(app: AppContext, db: Db, code: string): Promise<RoomStateView> {
  const { rows } = await db.query<RoomRow>(`${ROOMS} where a.code = $1`, [code]);
  const r = rows[0];
  if (!r) throw refusal(404, { code: 'EBMR-PLANT-011', kind: 'INVALID_INPUT', whatHappened: `There is no room or line ${code}.`, whatYouCanDo: ['Check the room code.'], whoCanHelp: ['The shift supervisor'], controls: ['PR-25'] });
  return roomView(app, r);
}

export async function roomConditions(app: AppContext, db: Db, code: string): Promise<RoomConditionsView> {
  await room(app, db, code);
  const { rows } = await db.query<{ c: Record<string, unknown>; now_us: string }>(`select plant.room_conditions($1) as c, ${NOW_US} as now_us`, [code]);
  const c = rows[0]?.c ?? {};
  const received = await db.query<{ tag: string; us: string | null }>(
    `select t ->> 'tag' as tag, ${tsUs("t ->> 'receivedAt'")} as us from jsonb_array_elements($1::jsonb) t`,
    [JSON.stringify(c['tags'] ?? [])],
  );
  const receivedOf = new Map(received.rows.map((x) => [x.tag, x.us]));
  const tags = (c['tags'] as { tag: string; unit: string; sample: Record<string, unknown> | null }[]).map((t) => {
    const us = receivedOf.get(t.tag) ?? null;
    const s = t.sample;
    return {
      tag: t.tag,
      unit: t.unit,
      sample: s
        ? {
            sourceTime: String(s['sourceTime']),
            serverTime: (s['serverTime'] as string | null) ?? null,
            raw: String(s['raw']),
            value: (s['value'] as string | null) ?? null,
            status: String(s['status']),
            quality: qualityOf(String(s['status'])),
          }
        : null,
      receivedAt: us === null ? null : app.formatInstant(us),
    };
  });
  const alarms = (c['openAlarms'] as { id: string; source: 'EBMR' | 'OPCUA' | 'EMS'; alarmCode: string; message: string; gmpCritical: boolean; raisedSourceUs: string }[]).map((a) => ({
    alarmId: a.id,
    source: a.source,
    alarmCode: a.alarmCode,
    message: a.message,
    gmpCritical: a.gmpCritical,
    raisedAtSource: app.formatInstant(a.raisedSourceUs),
  }));
  return { code: String(c['code']), name: String(c['name']), cleaningState: (c['cleaningState'] as RoomConditionsView['cleaningState']) ?? null, tags, openAlarms: alarms, readAt: app.formatInstant(rows[0]?.now_us ?? '0') };
}

/** OPC UA status code severity (the top two bits): GOOD, UNCERTAIN or BAD. */
function qualityOf(status: string): 'GOOD' | 'UNCERTAIN' | 'BAD' {
  const top = Number.parseInt(status.slice(2, 3), 16) >> 2;
  return top === 0 ? 'GOOD' : top === 1 ? 'UNCERTAIN' : 'BAD';
}

export async function adjacencies(app: AppContext, db: Db): Promise<AdjacencyView[]> {
  const { rows } = await db.query<{ one: string; two: string; version: number; adjacent: boolean; segregated: boolean; justification: string | null; us: string }>(
    `select a.code as one, b.code as two, j.version, j.adjacent, j.segregated, j.segregation_justification as justification, ${usOf('j.recorded_at')} as us
       from plant.area_adjacency_current j join plant.area a on a.id = j.area_a join plant.area b on b.id = j.area_b order by a.code, b.code`,
  );
  return rows.map((r) => ({ one: r.one, two: r.two, version: r.version.toString(), adjacent: r.adjacent, segregated: r.segregated, justification: r.justification, recordedAt: app.formatInstant(r.us) }));
}

interface LotRow {
  lot_code: string;
  kind: ReagentLotView['kind'];
  reagent_code: string;
  name: string;
  nominal: string | null;
  prepared_us: string;
  expires_us: string;
  state: ReagentLotView['state'];
  reason: string | null;
}

const LOTS = `
  select l.lot_code, l.kind, l.reagent_code, l.name, l.nominal, ${usOf('l.prepared_at')} as prepared_us, ${usOf('l.expires_at')} as expires_us,
         case when w.reagent_lot_id is not null then 'WITHDRAWN' when l.expires_at <= clock_timestamp() then 'EXPIRED' else 'IN_DATE' end as state, w.reason
  from site.reagent_lot l left join site.reagent_lot_withdrawal w on w.reagent_lot_id = l.id`;

const lotView = (app: AppContext, r: LotRow): ReagentLotView => ({
  lotCode: r.lot_code,
  kind: r.kind,
  reagentCode: r.reagent_code,
  name: r.name,
  nominal: r.nominal,
  preparedAt: app.formatInstant(r.prepared_us),
  expiresAt: app.formatInstant(r.expires_us),
  state: r.state,
  withdrawalReason: r.reason,
});

export async function reagentLots(app: AppContext, db: Db): Promise<ReagentLotView[]> {
  const { rows } = await db.query<LotRow>(`${LOTS} order by l.expires_at desc, l.lot_code limit 500`);
  return rows.map((r) => lotView(app, r));
}

export async function reagentLot(app: AppContext, db: Db, lotCode: string): Promise<ReagentLotView> {
  const { rows } = await db.query<LotRow>(`${LOTS} where l.lot_code = $1`, [lotCode]);
  const r = rows[0];
  if (!r) throw refusal(404, { code: 'EBMR-SITE-953', kind: 'INVALID_INPUT', whatHappened: `There is no reagent lot ${lotCode}.`, whatYouCanDo: ['Check the lot code on the bottle label.'], whoCanHelp: ['The QC laboratory'], controls: ['PR-29'] });
  return lotView(app, r);
}

// ---------------------------------------------------------------------------------------------------------------
// Area authorisations in the qualification matrix (PR-15; kernel 0130 iam.person_qualification, kernel 1190)
// ---------------------------------------------------------------------------------------------------------------

interface AuthRow {
  id: string;
  person_id: string;
  code: string;
  source_code: string;
  from_us: string;
  to_us: string | null;
  recorded_by_person: string;
  recorded_us: string;
  withdrawn_us: string | null;
  withdrawal_reason: string | null;
  current: boolean;
}

const AUTH_RECORDS = `
  select q.id, q.person_id, q.qualification_code as code, q.source_code, ${usOf('q.valid_from')} as from_us,
         ${tsUs('q.valid_to')} as to_us, q.recorded_by_person, ${usOf('q.recorded_at')} as recorded_us,
         ${tsUs('q.withdrawn_at')} as withdrawn_us, q.withdrawal_reason,
         iam.person_area_authorised(q.person_id, substr(q.qualification_code, 6), clock_timestamp()) as current
    from iam.person_qualification q`;

async function authViews(app: AppContext, db: Db, rows: AuthRow[]): Promise<Map<string, AreaAuthorisationRecordView>> {
  const people = await peopleOf(db, rows.flatMap((r) => [r.person_id, r.recorded_by_person]));
  return new Map(
    rows.map((r): [string, AreaAuthorisationRecordView] => [
      r.id,
      {
        recordId: r.id,
        person: personRef(people, r.person_id, ''),
        validFrom: app.formatInstant(r.from_us),
        validTo: r.to_us === null ? null : app.formatInstant(r.to_us),
        source: r.source_code,
        recordedBy: personRef(people, r.recorded_by_person, ''),
        recordedAt: app.formatInstant(r.recorded_us),
        withdrawnAt: r.withdrawn_us === null ? null : app.formatInstant(r.withdrawn_us),
        withdrawalReason: r.withdrawal_reason,
        current: r.current,
      },
    ]),
  );
}

/** Every room or line that is a controlled area or has an area authorisation type, with each record of it. */
export async function areaAuthorisations(app: AppContext, db: Db): Promise<AreaAuthorisationMatrixView> {
  const areas = await db.query<{ code: string; name: string; kind: 'ROOM' | 'LINE'; required: boolean; qcode: string; defined: boolean }>(
    `select a.code, a.name, a.kind, coalesce(r.authorisation_required, false) as required, iam.area_authorisation_code(a.code) as qcode,
            exists (select 1 from iam.qualification_type t where t.code = iam.area_authorisation_code(a.code)) as defined
       from plant.area a left join plant.area_rule_current r on r.area_id = a.id
      where coalesce(r.authorisation_required, false)
         or exists (select 1 from iam.qualification_type t where t.code = iam.area_authorisation_code(a.code))
      order by a.code`,
  );
  const recs = await db.query<AuthRow>(`${AUTH_RECORDS} where q.qualification_code = any ($1::text[]) order by q.recorded_at, q.id`, [areas.rows.map((a) => a.qcode)]);
  const views = await authViews(app, db, recs.rows);
  const now = (await db.query<{ us: string }>(`select ${NOW_US} as us`)).rows[0]?.us ?? '0';
  return {
    areas: areas.rows.map((a) => ({
      code: a.code,
      name: a.name,
      kind: a.kind,
      authorisationRequired: a.required,
      qualificationCode: a.qcode,
      typeDefined: a.defined,
      records: recs.rows.filter((r) => r.code === a.qcode).map((r) => views.get(r.id) as AreaAuthorisationRecordView),
    })),
    readAt: app.formatInstant(now),
  };
}

/** One area authorisation record (an AREA.* qualification record), or 404. */
export async function areaAuthorisationRecord(app: AppContext, db: Db, id: string): Promise<AreaAuthorisationRecordView> {
  const { rows } = await db.query<AuthRow>(`${AUTH_RECORDS} where q.id = $1 and q.qualification_code like 'AREA.%'`, [id]);
  const r = rows[0];
  if (!r) throw refusal(404, { code: 'EBMR-PLANT-185', kind: 'INVALID_INPUT', whatHappened: 'There is no such area authorisation record.', whatYouCanDo: ['Open the area authorisations again and choose the record from the list.'], whoCanHelp: ['The training coordinator'], controls: ['PR-15'] });
  return (await authViews(app, db, [r])).get(r.id) as AreaAuthorisationRecordView;
}

interface ProposalRow {
  subject: string; kind: 'MATERIAL' | 'PRODUCT' | null; id: string; version: string; state: PlantRuleProposalView['state']; value: boolean; reason: string;
  prev: boolean; by: string; at_us: string; approver: string | null; approved_us: string | null;
}

/**
 * The penicillin facility rules and beta-lactam classifications (recipe-core 0973, 1210; PR-27; Phase 7 slice 7g-2): per
 * subject the value in force and whether a proposal waits (the database's views), and every version with its state, its
 * effect against the value approved before it (as the signed content states it), its proposer and its approver.
 */
export async function plantRuleProposals(app: AppContext, db: Db): Promise<{ facilityRules: FacilityRuleSubjectView[]; betaLactam: BetaLactamSubjectView[]; readAt: Instant }> {
  const effect = (value: boolean, prev: boolean, tightensWhen: boolean): PlantRuleProposalView['effect'] => (value === prev ? 'UNCHANGED' : value === tightensWhen ? 'TIGHTENS' : 'LOOSENS');
  const facility = (await db.query<ProposalRow>(
    `select f.site_code as subject, null::text as kind, f.id, f.version::text, plant.facility_rule_state(f.id) as state, f.penicillin_facility as value, f.justification as reason,
            coalesce((select p.penicillin_facility from plant.facility_rule p join plant.facility_rule_approval a on a.rule_id = p.id
                       where p.site_code = f.site_code and p.version < f.version order by p.version desc limit 1), false) as prev,
            f.recorded_by_person as by, ${usOf('f.recorded_at')} as at_us, ap.approved_by_person as approver, ${tsUs('ap.approved_at')} as approved_us
       from plant.facility_rule f left join plant.facility_rule_approval ap on ap.rule_id = f.id
      order by f.site_code, f.version desc`,
  )).rows;
  const classes = (await db.query<ProposalRow>(
    `select c.code as subject, c.subject_kind as kind, c.id, c.version::text, plant.beta_lactam_class_state(c.id) as state, c.beta_lactam as value, c.reason,
            coalesce((select p.beta_lactam from plant.beta_lactam_class p join plant.beta_lactam_class_approval a on a.class_id = p.id
                       where p.subject_kind = c.subject_kind and p.code = c.code and p.version < c.version order by p.version desc limit 1), false) as prev,
            c.recorded_by_person as by, ${usOf('c.recorded_at')} as at_us, ap.approved_by_person as approver, ${tsUs('ap.approved_at')} as approved_us
       from plant.beta_lactam_class c left join plant.beta_lactam_class_approval ap on ap.class_id = c.id
      order by c.subject_kind, c.code, c.version desc`,
  )).rows;
  const inForceF = new Map((await db.query<{ site_code: string; penicillin_facility: boolean; approved_version: number | null; pending: boolean }>(
    'select site_code, penicillin_facility, approved_version, pending from plant.facility_rule_in_force')).rows.map((r) => [r.site_code, r]));
  const inForceB = new Map((await db.query<{ subject_kind: string; code: string; beta_lactam: boolean; approved_version: number | null; pending: boolean }>(
    'select subject_kind, code, beta_lactam, approved_version, pending from plant.beta_lactam_class_in_force')).rows.map((r) => [`${r.subject_kind}:${r.code}`, r]));
  const people = await peopleOf(db, [...facility, ...classes].flatMap((r) => [r.by, r.approver]));
  const view = (r: ProposalRow, tightensWhen: boolean): PlantRuleProposalView => ({
    proposalId: r.id, version: r.version, state: r.state, effect: effect(r.value, r.prev, tightensWhen), value: r.value, reason: r.reason,
    proposedBy: personRef(people, r.by, 'MASTER_DATA_STEWARD'), proposedAt: app.formatInstant(r.at_us),
    approvedBy: r.approver ? personRef(people, r.approver, 'QA_APPROVED') : null, approvedAt: r.approved_us ? app.formatInstant(r.approved_us) : null,
  });
  const group = <T>(rows: ProposalRow[], key: (r: ProposalRow) => string, make: (k: string, rows: ProposalRow[]) => T): T[] => {
    const m = new Map<string, ProposalRow[]>();
    for (const r of rows) m.set(key(r), [...(m.get(key(r)) ?? []), r]);
    return [...m.entries()].map(([k, rs]) => make(k, rs));
  };
  const text = (v: number | null): string | null => (v === null ? null : String(v));
  // A facility rule that says "not a penicillin facility" tightens; a beta-lactam classification that says "beta-lactam" does.
  const facilityRules = group(facility, (r) => r.subject, (site, rs): FacilityRuleSubjectView => {
    const f = inForceF.get(site);
    return { site, inForce: f?.penicillin_facility ?? false, approvedVersion: text(f?.approved_version ?? null), pending: f?.pending ?? false, versions: rs.map((r) => view(r, false)) };
  });
  const betaLactam = group(classes, (r) => `${r.kind ?? ''}:${r.subject}`, (k, rs): BetaLactamSubjectView => {
    const b = inForceB.get(k);
    const first = rs[0] as ProposalRow;
    return { kind: first.kind ?? 'MATERIAL', code: first.subject, inForce: b?.beta_lactam ?? false, approvedVersion: text(b?.approved_version ?? null), pending: b?.pending ?? false, versions: rs.map((r) => view(r, true)) };
  });
  const now = (await db.query<{ us: string }>(`select ${NOW_US} as us`)).rows[0]?.us ?? '0';
  return { facilityRules, betaLactam, readAt: app.formatInstant(now) };
}
