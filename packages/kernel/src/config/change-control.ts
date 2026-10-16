/**
 * Configuration change control (DI-09; kernel 1195; defaults D-P6f-1, D-P6f-A-1 to A-4).
 *
 * Every write to a configuration table (platform settings, identity and e-signature policies, the signature catalogue,
 * market policies, site values, recipe-core's review-by-exception rules) needs the number of an approved, open change
 * record in the command's actor context (`ActorContext.changeRecord`); the database refuses it otherwise
 * (EBMR-CFG-001 to -004). Every configuration row becomes an insert-only version with the instant it became valid, so
 * the configuration of any past instant and the difference between two instants can be read.
 *
 * The functions here are thin callers of the kernel functions; call them inside `withCommand`.
 */
import type pg from 'pg';

type Db = Pick<pg.PoolClient, 'query'>;

export const CHANGE_RECORD_MEANING = 'CONFIG_CHANGE_APPROVED';
export const CHANGE_RECORD_AGGREGATE = 'config_change_record';

/** Error codes of the configuration guard. */
export const CFG_NO_CHANGE_RECORD = 'EBMR-CFG-001';
export const CFG_UNKNOWN_CHANGE_RECORD = 'EBMR-CFG-002';
export const CFG_NOT_APPROVED = 'EBMR-CFG-003';
export const CFG_AREA_NOT_COVERED = 'EBMR-CFG-004';

export type ChangeRecordState = 'OPEN' | 'APPROVED' | 'CLOSED';

export interface ChangeRecordDefinition {
  number: string;
  title: string;
  description: string;
  /** Configuration area codes (platform.config_area), e.g. PLATFORM_SETTING, RBE_RULE. */
  areas: string[];
}

export interface ChangeRecord extends ChangeRecordDefinition {
  id: string;
  state: ChangeRecordState;
  raisedBy: string;
  raisedAt: string;
  approvedBy: string | null;
  approvedAt: string | null;
  closedAt: string | null;
}

export interface ConfigArea {
  code: string;
  table: string;
  description: string;
}

export interface ConfigItemVersion {
  area: string;
  itemKey: string;
  value: unknown;
  validFrom: string;
  versionId: string;
  basis: 'CHANGE_RECORD' | 'RELEASE' | 'BEFORE_CONTROL';
  changeRecord: string | null;
}

export interface ConfigDifference {
  area: string;
  itemKey: string;
  before: unknown;
  after: unknown;
  changeRecords: string[];
}

const UTC = `'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'`;

/** Raise a change record (CONFIG.CHANGE_RAISE). Returns its id. */
export async function raiseChangeRecord(db: Db, def: ChangeRecordDefinition): Promise<string> {
  const { rows } = await db.query<{ id: string }>('select platform.raise_change_record($1::jsonb) as id', [JSON.stringify(def)]);
  return rows[0]!.id;
}

/** Record the caller's own CONFIG_CHANGE_APPROVED e-signature as the approval (CONFIG.CHANGE_APPROVE; not the raiser). */
export async function approveChangeRecord(db: Db, num: string, signatureId: string): Promise<void> {
  await db.query('select platform.approve_change_record($1, $2::uuid)', [num, signatureId]);
}

/** Close a change record (CONFIG.CHANGE_CLOSE); nothing changes under it afterwards. */
export async function closeChangeRecord(db: Db, num: string, note: string): Promise<void> {
  await db.query('select platform.close_change_record($1, $2)', [num, note]);
}

/** Every change record, newest first, with its state. */
export async function listChangeRecords(db: Db, num?: string): Promise<ChangeRecord[]> {
  const { rows } = await db.query<{
    id: string; number: string; title: string; description: string; areas: string[]; state: ChangeRecordState;
    raised_by: string; raised_at: string; approved_by: string | null; approved_at: string | null; closed_at: string | null;
  }>(
    `select c.id, c.number, c.title, c.description, c.areas, platform.change_record_state(c.id) as state,
            c.raised_by_person::text as raised_by, to_char(c.raised_at at time zone 'UTC', ${UTC}) as raised_at,
            a.person_id::text as approved_by, to_char(a.recorded_at at time zone 'UTC', ${UTC}) as approved_at,
            to_char(x.recorded_at at time zone 'UTC', ${UTC}) as closed_at
       from platform.change_record c
       left join platform.change_record_event a on a.change_record_id = c.id and a.event = 'APPROVED'
       left join platform.change_record_event x on x.change_record_id = c.id and x.event = 'CLOSED'
      where $1::text is null or c.number = $1
      order by c.raised_at desc, c.number`,
    [num ?? null],
  );
  return rows.map((r) => ({
    id: r.id, number: r.number, title: r.title, description: r.description, areas: r.areas, state: r.state,
    raisedBy: r.raised_by, raisedAt: r.raised_at, approvedBy: r.approved_by, approvedAt: r.approved_at, closedAt: r.closed_at,
  }));
}

/** The configuration areas under change control. */
export async function listConfigAreas(db: Db): Promise<ConfigArea[]> {
  const { rows } = await db.query<{ code: string; t: string; description: string }>(
    'select code, table_name::text as t, description from platform.config_area order by code',
  );
  return rows.map((r) => ({ code: r.code, table: r.t, description: r.description }));
}

/** The configuration valid at an instant (ISO 8601 with offset), optionally of one area. */
export async function configurationAsOf(db: Db, at: string, area?: string): Promise<ConfigItemVersion[]> {
  const { rows } = await db.query<{
    area: string; item_key: string; value: unknown; valid_from: string; version_id: string; basis: ConfigItemVersion['basis']; change_record: string | null;
  }>(
    `select area, item_key, value, to_char(valid_from at time zone 'UTC', ${UTC}) as valid_from, version_id::text, basis, change_record
       from platform.config_as_of($1::timestamptz) where $2::text is null or area = $2 order by area, item_key`,
    [at, area ?? null],
  );
  return rows.map((r) => ({
    area: r.area, itemKey: r.item_key, value: r.value, validFrom: r.valid_from, versionId: r.version_id, basis: r.basis, changeRecord: r.change_record,
  }));
}

/** The items whose configuration differs between two instants, with the change records in between. */
export async function configurationDiff(db: Db, from: string, to: string, area?: string): Promise<ConfigDifference[]> {
  const { rows } = await db.query<{ area: string; item_key: string; value_before: unknown; value_after: unknown; change_records: string[] }>(
    'select * from platform.config_diff($1::timestamptz, $2::timestamptz) where $3::text is null or area = $3',
    [from, to, area ?? null],
  );
  return rows.map((r) => ({ area: r.area, itemKey: r.item_key, before: r.value_before, after: r.value_after, changeRecords: r.change_records }));
}

/** Set a platform setting (PLATFORM.SETTINGS_CHANGE) under the change record of the command's context. */
export async function setPlatformSetting(db: Db, key: string, value: string): Promise<string> {
  const { rows } = await db.query<{ id: string }>('select platform.set_setting($1, $2)::text as id', [key, value]);
  return rows[0]!.id;
}
