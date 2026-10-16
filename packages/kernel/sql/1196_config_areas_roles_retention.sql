-- Phase 6 slice 6f (builder A): roles and permission sets and the retention rules come under configuration change
-- control (DI-09; lead decision D-P6f-A-9: they decide who may sign and how long GMP records are kept; the stricter rule
-- wins).
--
-- Handbook: modules/kernel.md
--
--   * platform.config_version_log (1195) is replaced to version updates as well as inserts: an UPDATE of a registered
--     row (a role's description, a permission removed from a role) is a new version valid from the instant of the update.
--   * platform.register_config_area (1195) is replaced: the version trigger fires AFTER INSERT OR UPDATE, and a table
--     without a time column of its own may pass NULL for the validity and recorded columns (validity: the instant the
--     row is written; the back-fill uses p_backfill_from, an expression over the row `t`). Areas already registered keep
--     their insert-only triggers (their tables are insert-only).
--   * New areas: ROLE (iam.role: role definitions), ROLE_PERMISSION (iam.role_permission: the permissions of each role,
--     including a removal), RETENTION_RULE_SET (records.retention_rule_set) and RETENTION_RULE (records.retention_rule).
--     A person's role grant (iam.role_grant) and a delegation from one person to another (iam.delegation) are a person's
--     own signed IAM acts, not configuration; whether a meaning may be delegated is the signature catalogue's
--     (ESIG_MEANING, 1195).
--
-- Messages: EBMR-CFG-010 (as 1195).

set local role ebmr_owner;

create or replace function platform.config_version_log() returns trigger
language plpgsql security definer set search_path = pg_catalog, platform, kernel, pg_temp as $$
declare
  a      platform.config_area;
  v_ctx  jsonb := kernel.current_actor();
  v_row  jsonb := to_jsonb(new);
  v_rel  boolean := platform.is_release_actor(v_ctx);
  v_cr   uuid;
  v_from timestamptz;
begin
  select * into a from platform.config_area where code = tg_argv[0];
  if not v_rel then
    v_cr := platform.require_change_record(a.code, format('%s on %s', lower(tg_op), tg_relid::regclass));
  end if;
  v_from := case when tg_op = 'UPDATE' or a.valid_from_column is null then clock_timestamp()
                 else coalesce((v_row ->> a.valid_from_column)::timestamptz, clock_timestamp()) end;
  insert into platform.config_version (area, item_key, value, valid_from, source_row, basis, change_record_id, person_id)
  values (a.code, platform.config_item_key(a, v_row), platform.config_item_value(a, v_row), v_from, v_row,
          case when v_rel then 'RELEASE' else 'CHANGE_RECORD' end, v_cr,
          case when v_rel then null else (v_ctx ->> 'person_id')::uuid end);
  return null;
end
$$;

alter table platform.config_area alter column valid_from_column drop not null, alter column recorded_column drop not null;

drop function platform.register_config_area(text, regclass, text, text[], text[], text, text);
create function platform.register_config_area(p_code text, p_table regclass, p_description text, p_key_columns text[],
                                              p_value_columns text[], p_valid_from_column text, p_recorded_column text,
                                              p_backfill_from text default null)
returns void
language plpgsql volatile security definer set search_path = pg_catalog, platform, pg_temp as $$
declare
  a      platform.config_area;
  c      text;
  v_from text := coalesce(p_backfill_from, format('(to_jsonb(t) ->> %L)::timestamptz', p_valid_from_column));
begin
  if p_valid_from_column is null and p_backfill_from is null then
    raise exception using errcode = 'P0001', message = format('EBMR-CFG-010 %s has no validity column: name the back-fill instant', p_table);
  end if;
  foreach c in array p_key_columns || p_value_columns || array_remove(array[p_valid_from_column, p_recorded_column], null) loop
    if not exists (select 1 from pg_catalog.pg_attribute t where t.attrelid = p_table and t.attname = c and t.attnum > 0 and not t.attisdropped) then
      raise exception using errcode = 'P0001', message = format('EBMR-CFG-010 %s has no column %s', p_table, c);
    end if;
  end loop;
  insert into platform.config_area (code, table_name, description, key_columns, value_columns, valid_from_column, recorded_column)
  values (p_code, p_table, p_description, p_key_columns, p_value_columns, p_valid_from_column, p_recorded_column)
  returning * into a;
  execute format('create trigger a00_config_change before insert or update on %s for each row execute function platform.config_change_guard(%L)', p_table, p_code);
  execute format('create trigger zz_config_version after insert or update on %s for each row execute function platform.config_version_log(%L)', p_table, p_code);
  execute format(
    'insert into platform.config_version (area, item_key, value, valid_from, source_row, basis)
     select %L, platform.config_item_key(a, to_jsonb(t)), platform.config_item_value(a, to_jsonb(t)), %s, to_jsonb(t), ''BEFORE_CONTROL''
       from %s t cross join (select * from platform.config_area where code = %L) a
      order by 4', p_code, v_from, p_table, p_code);
end
$$;
revoke all on function platform.register_config_area(text, regclass, text, text[], text[], text, text, text) from public;

select kernel.set_actor_context(jsonb_build_object(
  'person_id', '00000000-0000-0000-0000-000000000000', 'account_id', '00000000-0000-0000-0000-000000000000',
  'role_code', 'SOFTWARE_RELEASE', 'session_id', '00000000-0000-0000-0000-000000000000', 'source', 'SYSTEM',
  'site_zone', 'UTC', 'correlation_id', gen_random_uuid(),
  'legal_name', 'Software release (kernel migration 1196_config_areas_roles_retention)',
  'reason_code', 'SOFTWARE_RELEASE',
  'reason_text', 'roles, permission sets and retention rules under configuration change control (DI-09, D-P6f-A-9)'));

select platform.register_config_area('ROLE', 'iam.role',
  'Role definitions: name, group, description, the account kinds that may hold the role',
  array['code'], array['name', 'role_group', 'description', 'account_kinds', 'catalogue_ref', 'is_kernel'], 'created_at', 'created_at');
select platform.register_config_area('ROLE_PERMISSION', 'iam.role_permission',
  'The permission sets of the roles: a permission added to a role or removed from it',
  array['role_code', 'permission_code'], array['added_at', 'removed_at'], 'added_at', 'added_at');
select platform.register_config_area('RETENTION_RULE_SET', 'records.retention_rule_set',
  'Retention rule sets (versions of the retention rules)', array['version'], array['note'], 'published_at', 'published_at');
select platform.register_config_area('RETENTION_RULE', 'records.retention_rule',
  'Retention rules: how long each kind of GMP record is kept, per market, from which anchor',
  array['rule_set_version', 'rule_id'],
  array['proposed_rule_key', 'retention_keys', 'market', 'predicate', 'anchor', 'period_years', 'period_months', 'open_reason', 'source', 'verification'],
  null, null,
  '(select s.published_at from records.retention_rule_set s where s.version = t.rule_set_version)');

select kernel.set_actor_context(null);

reset role;
