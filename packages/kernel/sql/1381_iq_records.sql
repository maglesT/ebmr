-- Phase 7 slice 7g-3 (decision 0025 point 2; decision D-P7R-5): the installation qualification run from the web app. The
-- IQ checks (validation kit runIq, the same code as the CLI `pnpm validation:iq`) read the installation and compare it
-- with the release's evidence bundle; the record they give is stored here with its SHA-256, attributed to the person who
-- ran it (controls DI-03, DI-11).
--
-- Handbook: modules/kernel.md
--
--   platform.iq_record                  insert-only, audited: one IQ record as the checks wrote it (JSON text), its
--                                       SHA-256, the schema release it ran on, the evidence bundle's SHA-256, whether
--                                       every check passed and the summary; who ran it and when.
--   platform.record_iq(record, record sha256, bundle sha256)
--                                       needs VALIDATION.MANAGE (the CSV and data-integrity lead), never an
--                                       administrator (DI-18). The database recomputes the SHA-256 of the text and
--                                       takes the release, the outcome and the summary from the record itself
--                                       (EBMR-VAL-020 to -022).
--
-- The IQ reads, as the server's application role, the migration ledger, the audited-table registry and the state
-- machines (catalogue metadata that the inventory lists); the grants below let it read them. Nothing else changes.
--
-- Messages: EBMR-VAL-020 to EBMR-VAL-022.

-- The ledger belongs to the migration runner's role, which runs this file (as kernel 1300 grants it to the owner).
grant select on public.schema_migration to ebmr_app;

set local role ebmr_owner;

create table platform.iq_record (
  id              uuid primary key default gen_random_uuid(),
  schema_release  text not null check (schema_release ~ '^[0-9a-f]{64}$'),
  bundle_sha256   text not null check (bundle_sha256 ~ '^[0-9a-f]{64}$'),
  record          text not null check (length(record) <= 4000000),
  record_sha256   text not null unique check (record_sha256 ~ '^[0-9a-f]{64}$'),
  passed          boolean not null,
  summary         text not null check (btrim(summary) <> '' and length(summary) <= 4000),
  person_id       uuid not null,
  account_id      uuid not null,
  recorded_at     timestamptz not null default clock_timestamp()
);
revoke all on platform.iq_record from public;
grant select on platform.iq_record to ebmr_app;
select platform.enforce_db_time('platform.iq_record', array['recorded_at']);
select kernel.register_audited_table('platform.iq_record', 'iq_record', 'schema_release', true);

create function platform.record_iq(p_record text, p_record_sha256 text, p_bundle_sha256 text) returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, platform, iam, kernel, pg_temp as $$
declare
  v_actor jsonb;
  v_rec   jsonb;
  v_id    uuid;
begin
  perform iam.assert_not_administrator();
  v_actor := iam.require_permission('VALIDATION.MANAGE', '{}'::jsonb);
  if p_record is null or coalesce(p_record_sha256, '') !~ '^[0-9a-f]{64}$' or coalesce(p_bundle_sha256, '') !~ '^[0-9a-f]{64}$'
     or encode(sha256(convert_to(p_record, 'UTF8')), 'hex') <> p_record_sha256 then
    raise exception using errcode = 'P0001', message =
      'EBMR-VAL-020 an IQ record is stored with the SHA-256 of its text and of the evidence bundle it was checked against (64 lowercase hex characters each)';
  end if;
  begin
    v_rec := p_record::jsonb;
  exception when others then
    raise exception using errcode = 'P0001', message = 'EBMR-VAL-021 an IQ record is the JSON the IQ checks wrote';
  end;
  if jsonb_typeof(v_rec) is distinct from 'object' or v_rec ->> 'kind' is distinct from 'iq'
     or jsonb_typeof(v_rec -> 'passed') is distinct from 'boolean' or jsonb_typeof(v_rec -> 'summary') is distinct from 'string'
     or jsonb_typeof(v_rec -> 'checks') is distinct from 'array' or jsonb_array_length(v_rec -> 'checks') = 0
     or coalesce(v_rec #>> '{installation,database}', '') <> current_database() then
    raise exception using errcode = 'P0001', message =
      'EBMR-VAL-021 an IQ record is the JSON the IQ checks wrote (kind iq, its checks, whether they passed, its summary) for this database';
  end if;
  -- The record says whether it passed; the database holds it to its checks.
  if (v_rec ->> 'passed')::boolean is distinct from not exists (select 1 from jsonb_array_elements(v_rec -> 'checks') c where (c ->> 'passed')::boolean is not true) then
    raise exception using errcode = 'P0001', message = 'EBMR-VAL-022 an IQ record passes only when every one of its checks passed';
  end if;
  insert into platform.iq_record (schema_release, bundle_sha256, record, record_sha256, passed, summary, person_id, account_id)
  values (platform.schema_release(), p_bundle_sha256, p_record, p_record_sha256, (v_rec ->> 'passed')::boolean, left(v_rec ->> 'summary', 4000),
          (v_actor ->> 'person_id')::uuid, (v_actor ->> 'account_id')::uuid)
  returning id into v_id;
  return v_id;
end
$$;

revoke all on function platform.record_iq(text, text, text) from public;
grant execute on function platform.record_iq(text, text, text) to ebmr_app;

-- The catalogue metadata the IQ's inventory reads (validation kit databaseInventory).
grant select on kernel.audited_table, platform.machine_version, platform.machine_transition to ebmr_app;

reset role;
