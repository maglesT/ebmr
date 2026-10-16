/**
 * The reads of the alarms namespace (Phase 6 slice 6b-0; contract ns/alarms.ts; recipe-core 0960; DI-49). Every value
 * is the database's: plant.alarm_status (each occurrence with its transitions and acknowledgment) and plant.alarm_batch
 * (the batches and steps it is bound to).
 */
import type pg from 'pg';
import type { PlantAlarmView } from '@ebmr/api-contract';
import type { AppContext } from '../../platform/context.ts';
import { refusal } from '../../platform/http/refusal.ts';
import { peopleOf, personRef, usOf } from '../common/people.ts';

type Db = Pick<pg.Pool, 'query'>;

interface AlarmRow {
  id: string;
  source: PlantAlarmView['source'];
  occurrence_id: string;
  subject_kind: 'EQUIPMENT' | 'AREA';
  subject_code: string;
  alarm_code: string;
  code_version: number | null;
  gmp_critical: boolean;
  deviation_required: boolean;
  severity: number;
  tag: string | null;
  value: string | null;
  value_unit: string | null;
  limit_value: string | null;
  limit_unit: string | null;
  limit_kind: NonNullable<PlantAlarmView['limit']>['kind'] | null;
  message: string;
  raised_us: string;
  received_us: string;
  cleared_us: string | null;
  source_acked_us: string | null;
  action_taken: string | null;
  ack_comment: string | null;
  deviation_ref: string | null;
  acked_by_person: string | null;
  acked_by_role: string | null;
  acked_us: string | null;
  batches: { batchId: string; batchNumber: string; step: string | null }[];
}

const ALARMS = `
  select s.id, s.source, s.occurrence_id, s.subject_kind, coalesce(e.code, a.code) as subject_code, s.alarm_code, s.code_version, s.gmp_critical,
         s.deviation_required, s.severity, s.tag, s.value, s.value_unit, s.limit_value, s.limit_unit, s.limit_kind, s.message,
         s.raised_source_us::text as raised_us, ${usOf('s.received_at')} as received_us, s.cleared_source_us::text as cleared_us,
         s.source_acked_us::text as source_acked_us, s.action_taken, s.ack_comment, s.deviation_ref, s.acked_by_person, s.acked_by_role,
         case when s.acked_at is null then null else ${usOf('s.acked_at')} end as acked_us,
         coalesce((select jsonb_agg(jsonb_build_object('batchId', ab.batch_id, 'batchNumber', b.batch_number, 'step', ab.step) order by b.batch_number)
                     from plant.alarm_batch ab join recipe.batch_execution b on b.id = ab.batch_id where ab.alarm_id = s.id), '[]'::jsonb) as batches
  from plant.alarm_status s
  left join plant.equipment e on e.id = s.equipment_id
  left join plant.area a on a.id = s.area_id`;

async function views(app: AppContext, db: Db, rows: AlarmRow[]): Promise<PlantAlarmView[]> {
  const people = await peopleOf(db, rows.map((r) => r.acked_by_person));
  return rows.map((r) => ({
    alarmId: r.id,
    source: r.source,
    occurrenceId: r.occurrence_id,
    subject: { kind: r.subject_kind, code: r.subject_code },
    alarmCode: r.alarm_code,
    codeVersion: r.code_version === null ? null : r.code_version.toString(),
    gmpCritical: r.gmp_critical,
    deviationRequired: r.deviation_required,
    severity: r.severity.toString(),
    tag: r.tag,
    value: r.value !== null && r.value_unit !== null ? { value: r.value, unit: r.value_unit } : null,
    limit: r.limit_kind === null ? null : { value: r.limit_value, unit: r.limit_unit, kind: r.limit_kind },
    message: r.message,
    raisedAtSource: app.formatInstant(r.raised_us),
    receivedAt: app.formatInstant(r.received_us),
    clearedAtSource: r.cleared_us === null ? null : app.formatInstant(r.cleared_us),
    sourceAcknowledgedAt: r.source_acked_us === null ? null : app.formatInstant(r.source_acked_us),
    batches: r.batches,
    acknowledgement:
      r.acked_by_person !== null && r.acked_us !== null && r.action_taken !== null
        ? { by: personRef(people, r.acked_by_person, r.acked_by_role ?? ''), at: app.formatInstant(r.acked_us), actionTaken: r.action_taken, comment: r.ack_comment, deviationRef: r.deviation_ref }
        : null,
  }));
}

export async function alarmList(
  app: AppContext,
  db: Db,
  q: { state?: 'OPEN' | 'ACKNOWLEDGED' | 'ALL' | undefined; source?: PlantAlarmView['source'] | undefined; subjectCode?: string | undefined },
): Promise<PlantAlarmView[]> {
  const state = q.state ?? 'OPEN';
  const filter = state === 'OPEN' ? 's.acked_at is null' : state === 'ACKNOWLEDGED' ? 's.acked_at is not null' : 'true';
  const { rows } = await db.query<AlarmRow>(
    `${ALARMS} where ${filter} and ($1::text is null or s.source = $1) and ($2::text is null or coalesce(e.code, a.code) = $2) order by s.received_at desc limit 500`,
    [q.source ?? null, q.subjectCode ?? null],
  );
  return views(app, db, rows);
}

export async function batchAlarmLog(app: AppContext, db: Db, batchId: string, step?: string): Promise<PlantAlarmView[]> {
  const { rows } = await db.query<AlarmRow>(
    `${ALARMS} where exists (select 1 from plant.alarm_batch ab where ab.alarm_id = s.id and ab.batch_id = $1 and ($2::text is null or ab.step = $2))
     order by s.raised_source_us, s.id`,
    [batchId, step ?? null],
  );
  return views(app, db, rows);
}

export async function alarmView(app: AppContext, db: Db, alarmId: string): Promise<PlantAlarmView> {
  const { rows } = await db.query<AlarmRow>(`${ALARMS} where s.id = $1`, [alarmId]);
  const [view] = await views(app, db, rows);
  if (!view) {
    throw refusal(404, {
      code: 'EBMR-ALM-011',
      kind: 'INVALID_INPUT',
      whatHappened: 'There is no plant alarm with this id.',
      why: `Alarm ${alarmId} was never raised.`,
      whatYouCanDo: ['Open the alarm from the batch alarm log or the alarm list.'],
    });
  }
  return view;
}
