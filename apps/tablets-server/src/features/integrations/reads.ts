/**
 * The reads of the integrations namespace (Phase 6 slice 6a-0; contract ns/integrations.ts; kernel 1180). Every value
 * is the database's: the adapter registry, the accepted messages, the recorded refusals, the reconciliation reports,
 * the integration alarms and their acknowledgments, and platform.mirror_freshness per data class.
 */
import type pg from 'pg';
import type {
  AdapterDetailView,
  AdapterHealthView,
  AdapterWorkerView,
  InboundMessageView,
  InboundRefusalView,
  IntegrationAlarmView,
  MirrorFreshnessView,
  ReconciliationReportView,
} from '@ebmr/api-contract';
import type { AppContext } from '../../platform/context.ts';
import type { AdapterHealth } from './adapters/framework.ts';
import { refusal } from '../../platform/http/refusal.ts';
import { peopleOf, personRef, usOf } from '../common/people.ts';

type Db = Pick<pg.Pool, 'query'>;

/** The health of this server's worker for an adapter, or null when none runs (adapters/start.ts). */
export type WorkerHealthOf = (adapterCode: string) => AdapterHealth | null;

function workerView(h: AdapterHealth | null): AdapterWorkerView | null {
  if (!h) return null;
  return {
    state: h.state,
    cursor: h.cursor,
    head: h.head === null ? null : h.head.slice(0, 64),
    cycles: h.cycles.toString(),
    attempts: h.attempts.toString(),
    lastError: h.lastError === null ? null : h.lastError.slice(0, 500),
    accepted: h.accepted.toString(),
    duplicates: h.duplicates.toString(),
    refused: h.refused.toString(),
  };
}

interface AdapterRow {
  id: string;
  code: string;
  source_system: AdapterHealthView['sourceSystem'];
  status: AdapterHealthView['status'];
  description: string;
  age_s: string | null;
  open_alarms: string;
}
interface MessageRow {
  id: string;
  message_type: string;
  source_record_id: string;
  source_us: string;
  sequence_no: string;
  sequence_status: InboundMessageView['sequenceStatus'];
  received_us: string;
}
interface ReportRow {
  id: string;
  adapter_code: string;
  from_us: string;
  to_us: string;
  source_count: string;
  received_count: string;
  accepted_count: string;
  refused_count: string;
  matched: boolean;
  alarm_id: string | null;
  recorded_us: string;
}
interface AlarmRow {
  id: string;
  adapter_code: string;
  source_system: IntegrationAlarmView['sourceSystem'];
  kind: IntegrationAlarmView['kind'];
  severity: IntegrationAlarmView['severity'];
  message_id: string | null;
  details: Record<string, string | null>;
  raised_us: string;
  ack: { person_id: string; role_code: string; us: string; note: string } | null;
}
interface FreshnessJson {
  dataClass: MirrorFreshnessView['dataClass'];
  sourceSystem: MirrorFreshnessView['sourceSystem'];
  mode: MirrorFreshnessView['mode'];
  blocking: boolean;
  asOfUs: string | null;
  ageSeconds: string | null;
  boundSeconds: string | null;
  stale: boolean;
}

const ADAPTERS = `select a.id, a.code, a.source_system, a.status, a.description,
                         (select floor(extract(epoch from clock_timestamp() - max(m.received_at)))::bigint::text
                            from platform.inbound_message m where m.adapter_id = a.id) as age_s,
                         (select count(*)::text from platform.integration_alarm x
                           where x.adapter_id = a.id and not exists (select 1 from platform.integration_alarm_ack k where k.alarm_id = x.id)) as open_alarms
                  from iam.integration_adapter a`;
const MESSAGES = `select m.id, m.message_type, m.source_record_id, ${usOf('m.source_timestamp')} as source_us, m.sequence_no::text as sequence_no,
                         m.sequence_status, ${usOf('m.received_at')} as received_us
                  from platform.inbound_message m`;
const REPORTS = `select r.id, r.adapter_code, ${usOf('r.period_from')} as from_us, ${usOf('r.period_to')} as to_us, r.source_count::text as source_count,
                        r.received_count::text as received_count, r.accepted_count::text as accepted_count, r.refused_count::text as refused_count,
                        r.matched, r.alarm_id, ${usOf('r.recorded_at')} as recorded_us
                 from platform.reconciliation_report r`;
const ALARMS = `select x.id, x.adapter_code, a.source_system, x.kind, x.severity, x.message_id, x.details, ${usOf('x.raised_at')} as raised_us,
                       (select jsonb_build_object('person_id', k.acknowledged_by, 'role_code', k.acknowledged_role, 'us', ${usOf('k.acknowledged_at')}, 'note', k.note)
                          from platform.integration_alarm_ack k where k.alarm_id = x.id) as ack
                from platform.integration_alarm x join iam.integration_adapter a on a.id = x.adapter_id`;

function messageView(app: AppContext, r: MessageRow): InboundMessageView {
  return {
    messageId: r.id,
    messageType: r.message_type,
    sourceRecordId: r.source_record_id,
    sourceTimestamp: app.formatInstant(r.source_us),
    sequenceNo: r.sequence_no,
    sequenceStatus: r.sequence_status,
    receivedAt: app.formatInstant(r.received_us),
  };
}

function reportView(app: AppContext, r: ReportRow): ReconciliationReportView {
  return {
    reportId: r.id,
    adapterCode: r.adapter_code,
    periodFrom: app.formatInstant(r.from_us),
    periodTo: app.formatInstant(r.to_us),
    sourceCount: r.source_count,
    receivedCount: r.received_count,
    acceptedCount: r.accepted_count,
    refusedCount: r.refused_count,
    matched: r.matched,
    alarmId: r.alarm_id,
    recordedAt: app.formatInstant(r.recorded_us),
  };
}

/** One line a person can read, from what the database recorded with the alarm. */
export function alarmSummary(kind: AlarmRow['kind'], d: Record<string, string | null>): string {
  switch (kind) {
    case 'SEQUENCE_GAP':
      return `Messages ${d['missingFrom'] ?? '?'} to ${d['missingTo'] ?? '?'} missing: received ${d['received'] ?? '?'} when ${d['expected'] ?? '?'} was expected`;
    case 'OUT_OF_ORDER':
      return `Message ${d['received'] ?? '?'} arrived after message ${d['highestBefore'] ?? '?'}`;
    case 'RECONCILIATION_MISMATCH':
      return `The source reports ${d['sourceCount'] ?? '?'} messages for the period; the eBMR received ${d['receivedCount'] ?? '?'}`;
    case 'SERIES_GAP':
      return `The gateway could not record ${d['tag'] ?? '?'} of ${d['unit'] ?? '?'} from ${d['fromUs'] ?? '?'} to ${d['toUs'] ?? '?'} (epoch microseconds): ${d['detail'] ?? d['reason'] ?? ''}`;
    default:
      return d['detail'] ?? kind;
  }
}

async function freshness(app: AppContext, db: Db, system?: string): Promise<MirrorFreshnessView[]> {
  const { rows } = await db.query<{ f: FreshnessJson }>(
    `select platform.mirror_freshness(c.code) as f from platform.mirror_data_class c where $1::text is null or c.source_system = $1 order by c.source_system, c.code`,
    [system ?? null],
  );
  return rows.map(({ f }) => ({
    dataClass: f.dataClass,
    sourceSystem: f.sourceSystem,
    mode: f.mode,
    blocking: f.blocking,
    asOf: f.asOfUs === null ? null : app.formatInstant(f.asOfUs),
    ageSeconds: f.ageSeconds,
    boundSeconds: f.boundSeconds,
    stale: f.stale,
  }));
}

export function mirrorList(app: AppContext, db: Db): Promise<MirrorFreshnessView[]> {
  return freshness(app, db);
}

async function healthOf(app: AppContext, db: Db, a: AdapterRow, live: WorkerHealthOf): Promise<AdapterHealthView> {
  const last = (await db.query<MessageRow>(`${MESSAGES} where m.adapter_id = $1 order by m.received_at desc, m.sequence_no desc limit 1`, [a.id])).rows[0];
  const report = (await db.query<ReportRow>(`${REPORTS} where r.adapter_id = $1 order by r.period_to desc, r.recorded_at desc limit 1`, [a.id])).rows[0];
  return {
    adapterCode: a.code,
    sourceSystem: a.source_system,
    status: a.status,
    description: a.description,
    lastMessage: last ? messageView(app, last) : null,
    dataAgeSeconds: a.age_s === null ? null : a.age_s.startsWith('-') ? '0' : a.age_s,
    openAlarms: a.open_alarms,
    lastReconciliation: report ? reportView(app, report) : null,
    mirrors: await freshness(app, db, a.source_system),
    worker: workerView(live(a.code)),
  };
}

export async function adapterList(app: AppContext, db: Db, live: WorkerHealthOf = () => null): Promise<AdapterHealthView[]> {
  const { rows } = await db.query<AdapterRow>(`${ADAPTERS} order by a.source_system, a.code`);
  const out: AdapterHealthView[] = [];
  for (const a of rows) out.push(await healthOf(app, db, a, live));
  return out;
}

async function adapterRow(db: Db, code: string): Promise<AdapterRow> {
  const a = (await db.query<AdapterRow>(`${ADAPTERS} where a.code = $1`, [code])).rows[0];
  if (!a) {
    throw refusal(404, {
      code: 'EBMR-INT-017',
      kind: 'INVALID_INPUT',
      whatHappened: 'There is no integration adapter with this code.',
      why: `Adapter ${code} is not registered.`,
      whatYouCanDo: ['Open the adapter from the integration health page.'],
    });
  }
  return a;
}

export async function adapterDetail(app: AppContext, db: Db, code: string, live: WorkerHealthOf = () => null): Promise<AdapterDetailView> {
  const a = await adapterRow(db, code);
  const messages = (await db.query<MessageRow>(`${MESSAGES} where m.adapter_id = $1 order by m.received_at desc, m.sequence_no desc limit 50`, [a.id])).rows;
  const refusals = (
    await db.query<{ id: string; error_class: InboundRefusalView['errorClass']; idempotency_key: string | null; sequence_no: string | null; detail: string; alarm_id: string; recorded_us: string }>(
      `select e.id, e.error_class, e.idempotency_key, e.sequence_no::text as sequence_no, e.detail, e.alarm_id, ${usOf('e.recorded_at')} as recorded_us
       from platform.inbound_exception e where e.adapter_id = $1 and e.kind = 'REFUSED' order by e.recorded_at desc limit 50`,
      [a.id],
    )
  ).rows;
  return {
    health: await healthOf(app, db, a, live),
    messages: messages.map((m) => messageView(app, m)),
    refusals: refusals.map((r) => ({
      refusalId: r.id,
      errorClass: r.error_class,
      idempotencyKey: r.idempotency_key,
      sequenceNo: r.sequence_no,
      detail: r.detail,
      alarmId: r.alarm_id,
      recordedAt: app.formatInstant(r.recorded_us),
    })),
  };
}

export async function reconciliationList(app: AppContext, db: Db, code: string): Promise<ReconciliationReportView[]> {
  const a = await adapterRow(db, code);
  const { rows } = await db.query<ReportRow>(`${REPORTS} where r.adapter_id = $1 order by r.period_to desc, r.recorded_at desc limit 200`, [a.id]);
  return rows.map((r) => reportView(app, r));
}

async function alarmViews(app: AppContext, db: Db, rows: AlarmRow[]): Promise<IntegrationAlarmView[]> {
  const people = await peopleOf(db, rows.map((r) => r.ack?.person_id));
  return rows.map((r) => ({
    alarmId: r.id,
    adapterCode: r.adapter_code,
    sourceSystem: r.source_system,
    kind: r.kind,
    severity: r.severity,
    messageId: r.message_id,
    summary: alarmSummary(r.kind, r.details),
    raisedAt: app.formatInstant(r.raised_us),
    acknowledgement: r.ack ? { by: personRef(people, r.ack.person_id, r.ack.role_code), at: app.formatInstant(r.ack.us), note: r.ack.note } : null,
  }));
}

export async function alarmList(app: AppContext, db: Db, state: 'OPEN' | 'ACKNOWLEDGED' | 'ALL', adapterCode?: string): Promise<IntegrationAlarmView[]> {
  const ack = 'exists (select 1 from platform.integration_alarm_ack k where k.alarm_id = x.id)';
  const filter = state === 'OPEN' ? `not ${ack}` : state === 'ACKNOWLEDGED' ? ack : 'true';
  const { rows } = await db.query<AlarmRow>(`${ALARMS} where ${filter} and ($1::text is null or x.adapter_code = $1) order by x.raised_at desc limit 500`, [
    adapterCode ?? null,
  ]);
  return alarmViews(app, db, rows);
}

export async function alarmView(app: AppContext, db: Db, alarmId: string): Promise<IntegrationAlarmView> {
  const { rows } = await db.query<AlarmRow>(`${ALARMS} where x.id = $1`, [alarmId]);
  const [view] = await alarmViews(app, db, rows);
  if (!view) {
    throw refusal(404, {
      code: 'EBMR-INT-007',
      kind: 'INVALID_INPUT',
      whatHappened: 'There is no integration alarm with this id.',
      why: `Alarm ${alarmId} was never raised.`,
      whatYouCanDo: ['Open the alarm from the integration health page.'],
    });
  }
  return view;
}
