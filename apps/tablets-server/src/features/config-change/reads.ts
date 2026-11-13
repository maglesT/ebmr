/**
 * Reads of the configuration change control (Phase 6 slice 6f, builder A; kernel 1195, recipe-core 1050): change records
 * with their state, the configuration of an instant and the difference between two, platform settings and RBE rules.
 */
import type { ChangeRecordView, PlatformSettingView, RbeRuleView } from '@ebmr/api-contract';
import type pg from 'pg';
import type { AppContext } from '../../platform/context.ts';
import { peopleOf, personRef, usOf } from '../common/people.ts';

type Db = Pick<pg.Pool, 'query'>;

interface RecordRow {
  id: string;
  number: string;
  title: string;
  description: string;
  areas: string[];
  aps_lines: string[];
  state: ChangeRecordView['state'];
  raised_by: string;
  raised_us: string;
  approved_by: string | null;
  approved_us: string | null;
  closed_us: string | null;
}

export async function changeRecordViews(app: AppContext, db: Db, filter: { number?: string; state?: string }): Promise<ChangeRecordView[]> {
  const { rows } = await db.query<RecordRow>(
    `select c.id, c.number, c.title, c.description, c.areas, platform.change_record_state(c.id) as state,
            array(select e.code from plant.aps_required_line l join plant.equipment e on e.id = l.equipment_id
                   where l.change_record_id = c.id order by e.code) as aps_lines,
            c.raised_by_person::text as raised_by, ${usOf('c.raised_at')} as raised_us,
            a.person_id::text as approved_by, case when a.id is null then null else ${usOf('a.recorded_at')} end as approved_us,
            case when x.id is null then null else ${usOf('x.recorded_at')} end as closed_us
       from platform.change_record c
       left join platform.change_record_event a on a.change_record_id = c.id and a.event = 'APPROVED'
       left join platform.change_record_event x on x.change_record_id = c.id and x.event = 'CLOSED'
      where ($1::text is null or c.number = $1) and ($2::text is null or platform.change_record_state(c.id) = $2)
      order by c.raised_at desc, c.number
      limit 500`,
    [filter.number ?? null, filter.state ?? null],
  );
  const people = await peopleOf(db, rows.flatMap((r) => [r.raised_by, r.approved_by]));
  return rows.map((r) => ({
    changeRecordId: r.id,
    number: r.number,
    title: r.title,
    description: r.description,
    areas: r.areas,
    apsLines: r.aps_lines,
    state: r.state,
    raisedBy: personRef(people, r.raised_by, ''),
    raisedAt: app.formatInstant(r.raised_us),
    approvedBy: r.approved_by === null ? null : personRef(people, r.approved_by, ''),
    approvedAt: r.approved_us === null ? null : app.formatInstant(r.approved_us),
    closedAt: r.closed_us === null ? null : app.formatInstant(r.closed_us),
    signable: { aggregateType: 'config_change_record', aggregateId: r.number, meaning: 'CONFIG_CHANGE_APPROVED', expectedState: 'OPEN' },
  }));
}

export async function platformSettingViews(db: Db, key?: string): Promise<PlatformSettingView[]> {
  const { rows } = await db.query<{
    key: string; value: string; default_value: string; value_type: PlatformSettingView['valueType']; allowed_values: string[] | null;
    min_value: string | null; max_value: string | null; unit: string | null; description: string; basis: string;
  }>(
    `select d.key, platform.setting_text(d.key) as value, d.default_value, d.value_type, d.allowed_values, d.min_value::text, d.max_value::text,
            d.unit, d.description, d.basis
       from platform.setting_definition d where $1::text is null or d.key = $1 order by d.key`,
    [key ?? null],
  );
  return rows.map((r) => ({
    key: r.key, value: r.value, defaultValue: r.default_value, valueType: r.value_type, allowedValues: r.allowed_values,
    minValue: r.min_value, maxValue: r.max_value, unit: r.unit, description: r.description, basis: r.basis,
  }));
}

export async function rbeRuleViews(db: Db, at?: string, category?: string): Promise<RbeRuleView[]> {
  const { rows } = await db.query<{
    category: string; mandatory: boolean; included: boolean; min_severity: RbeRuleView['minSeverity']; version: number | null; rationale: string | null; valid_from: string | null;
  }>(
    `select category, mandatory, included, min_severity, version, rationale,
            to_char(valid_from at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as valid_from
       from recipe.rbe_rules_as_of(coalesce($1::timestamptz, clock_timestamp())) where $2::text is null or category = $2`,
    [at ?? null, category ?? null],
  );
  return rows.map((r) => ({
    category: r.category, mandatory: r.mandatory, included: r.included, minSeverity: r.min_severity, version: r.version, rationale: r.rationale, validFrom: r.valid_from,
  }));
}
