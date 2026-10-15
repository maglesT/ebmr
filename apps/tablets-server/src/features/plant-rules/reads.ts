/**
 * The reads of the plant rules and status displays (Phase 6 slice 6b, builder B; contract ns/plant-rules.ts and the
 * equipmentDisplays block of ns/equipment-data.ts; recipe-core 0973 to 0975, site services 0940). Every value is the
 * database's at the moment of the read: plant.status_board, plant.line_station, plant.room_conditions,
 * plant.room_cleaning_state, plant.area_adjacency_current and site.reagent_lot.
 */
import type pg from 'pg';
import type { AdjacencyView, Instant, LineStationView, ReagentLotView, RoomConditionsView, RoomStateView, StatusBoardEntry } from '@ebmr/api-contract';
import type { AppContext } from '../../platform/context.ts';
import { refusal } from '../../platform/http/refusal.ts';
import { usOf } from '../common/people.ts';

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
    batch: b['batchId'] ? { batchId: String(b['batchId']), batchRef: String(b['batchRef']), product: String(b['product']) } : null,
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
            batchId: String(s['batchId']),
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
