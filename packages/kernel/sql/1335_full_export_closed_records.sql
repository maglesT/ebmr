-- Phase 7 slice 7b-2: the closed records of the installation, their seeded readability sample, and the full export of
-- the installation for the stand-alone record viewer (DI-08 clause 2, DI-44 clause 1; plan phase-7-plan.md "Slice 7b-2").
--
-- Handbook: modules/kernel.md
--
-- Closed records (read through the reporting path, ebmr_report):
--   report.closed_record_source            insert-only registry: per record type, a STABLE row function of the owning
--                                          module returning (record_id, label, closed_at, chain_keys text[]): the
--                                          records of that type that are closed (no entry is added to them any more),
--                                          with the audit chains that make up their archive package (its own first).
--                                          The signature chain of each listed chain (esig_signature:<chain>) belongs to
--                                          the package by itself; a source lists further signature chains (signatures
--                                          of the record's parts, such as a batch's steps) as esig_signature:<ref>.
--                                          The kernel registers closed incidents and closed DI investigations here;
--                                          recipe-core 1240 adds the closed batch records. Only migrations register.
--   report.closed_record_v1                every closed record of every registered type (view over
--                                          report.closed_record_rows_v1()).
--   report.readability_sample_rows_v1(seed, closed_before, size)
--                                          the seeded readability sample (DI-44): the `size` closed records closed before
--                                          `closed_before` with the smallest SHA-256 of `seed:record_type:record_id`
--                                          (byte order), ranked 1..n. The same seed gives the same sample; the evaluation
--                                          pack's store (kernel 1336) recomputes it.
--
-- The full export (DI-08 clause 2; RECORD.EXPORT, "every export is logged"). One export is one run, made in one
-- REPEATABLE READ transaction (packages/kernel/src/records/full-export.ts):
--   records.begin_full_export()           RECORD.EXPORT, and every permission records.export_restricted_table names for
--                                          a table holding rows of an exported chain (CONTROLLED.READ for the controlled
--                                          substance tables, recipe-core 1240), in the scope {}: an export is complete,
--                                          so a holder without it is refused, never served an export with rows left out.
--                                          Computes the closed records once and stores the run's scope: every record in
--                                          order with its chains that exist and its signature chains, and every seal key
--                                          chain (records.full_export_run, records.full_export_scope; audited on the
--                                          run's chain).
--   records.full_export_records(run, after, limit)
--                                          the scope's records page by page (keyset on the ordinal, at most 500).
--   records.full_export_snapshot(run, keys) the true-copy parts (records.true_copy_parts, latest 1173) of up to 200 chains
--                                          of the run's scope, and for a signature chain the seal payload of each
--                                          signature (esig.seal_payload). A chain outside the scope, or another person's
--                                          run, is refused.
--   records.full_export                    insert-only register of every full export: its run, its manifest and SHA-256
--                                          (the reference the viewer compares with), its record and file counts, who.
--   records.register_full_export(run, m, sha)
--                                          recomputes the SHA-256 and requires that the manifest lists exactly the run's
--                                          records in order, each with exactly its chains and signature chains, every
--                                          chain at the head (seq and hash) kernel.audit_chain_head holds in this
--                                          snapshot, exactly the seal key chains, and every chain file and the seal
--                                          payloads among its files. The head hash binds every event of a chain, and the
--                                          viewer checks every row of a bundle against its chain.
--   records.readability_snapshot(seed, closed_before, size, rank)
--                                          the archive package of the sampled record of that rank (RECORD.EXPORT and the
--                                          restricted tables' permissions, as above), for the readability report.
--   An index on esig.signature (aggregate_type, aggregate_id collate "C") serves the closed-record sources' lookup of
--   the signatures of a record's parts by a range of the aggregate id.
--
-- Messages: EBMR-REC-140 to EBMR-REC-149.

set local role ebmr_owner;

select kernel.set_actor_context(jsonb_build_object(
  'person_id', '00000000-0000-0000-0000-000000000000', 'account_id', '00000000-0000-0000-0000-000000000000',
  'role_code', 'SOFTWARE_RELEASE', 'session_id', '00000000-0000-0000-0000-000000000000', 'source', 'SYSTEM',
  'site_zone', 'UTC', 'correlation_id', gen_random_uuid(),
  'legal_name', 'Software release (kernel migration 1335_full_export_closed_records)',
  'reason_code', 'SOFTWARE_RELEASE',
  'reason_text', 'the closed records, their readability sample and the full export of the installation (DI-08, DI-44)'));

-- ---------------------------------------------------------------------------------------------
-- Closed records
-- ---------------------------------------------------------------------------------------------

create table report.closed_record_source (
  record_type   text primary key check (record_type ~ '^[a-z][a-z0-9_]*$'),
  row_function  regprocedure not null,
  description   text not null check (btrim(description) <> ''),
  recorded_at   timestamptz not null default clock_timestamp()
);
revoke all on report.closed_record_source from public;
create trigger aa_insert_only before update or delete on report.closed_record_source for each row execute function kernel.reject_mutation();
create trigger aa_no_truncate before truncate on report.closed_record_source for each statement execute function kernel.reject_mutation();

-- Registers the closed records of one record type (migrations only: the owner). The function takes no argument, is
-- STABLE (it cannot write) and returns (record_id text, label text, closed_at timestamptz, chain_keys text[]).
create function report.register_closed_record_source(p_record_type text, p_function regprocedure, p_description text) returns void
language plpgsql volatile security definer set search_path = pg_catalog, report, pg_temp as $$
declare
  v_cols text;
begin
  select pg_catalog.string_agg(a.name || ' ' || a.type, ', ' order by a.n) into v_cols
    from pg_catalog.pg_proc p
    cross join lateral rows from (pg_catalog.unnest(p.proargnames), pg_catalog.unnest(p.proallargtypes::regtype[]::text[]),
                                 pg_catalog.unnest(p.proargmodes::text[])) with ordinality as a(name, type, mode, n)
   where p.oid = p_function and a.mode = 't';
  if not exists (select 1 from pg_catalog.pg_proc p where p.oid = p_function and p.pronargs = 0 and p.provolatile <> 'v' and p.proretset)
     or v_cols is distinct from 'record_id text, label text, closed_at timestamp with time zone, chain_keys text[]' then
    raise exception using errcode = 'P0001', message = format(
      'EBMR-REC-140 %s is no closed-record source: a STABLE function without arguments returning table (record_id text, label text, closed_at timestamptz, chain_keys text[]) (DI-08, DI-44)',
      p_function);
  end if;
  insert into report.closed_record_source (record_type, row_function, description) values (p_record_type, p_function, btrim(p_description));
end
$$;
revoke all on function report.register_closed_record_source(text, regprocedure, text) from public;

-- Every closed record of every registered type, in closing order. The first chain key is the record's own chain.
create function report.closed_record_rows_v1()
returns table (record_type text, record_id text, label text, closed_at timestamptz, chain_keys text[], read_at timestamptz, data_as_of timestamptz)
language plpgsql stable security definer set search_path = pg_catalog, report, pg_temp as $$
declare
  s record;
begin
  for s in select c.record_type, c.row_function from report.closed_record_source c order by c.record_type collate "C" loop
    return query execute format(
      'select %L::text, x.record_id, x.label, x.closed_at, x.chain_keys, pg_catalog.statement_timestamp(), report.data_as_of() from %s x',
      s.record_type, s.row_function::text);
  end loop;
end
$$;

create view report.closed_record_v1 as
  select * from report.closed_record_rows_v1() r order by r.closed_at, r.record_type collate "C", r.record_id collate "C";

-- The seeded readability sample (DI-44): repeatable for the same seed, period end and size.
create function report.readability_sample_rows_v1(p_seed text, p_closed_before timestamptz, p_size integer)
returns table (rank integer, record_type text, record_id text, label text, closed_at timestamptz, chain_keys text[], sample_key text)
language plpgsql stable security definer set search_path = pg_catalog, report, pg_temp as $$
begin
  if p_seed is null or btrim(p_seed) = '' or length(p_seed) > 200 or p_closed_before is null or p_size is null or p_size < 1 or p_size > 1000 then
    raise exception using errcode = 'P0001', message =
      'EBMR-REC-141 a readability sample names a seed (1 to 200 characters), the time its records closed before and a size of 1 to 1000 (DI-44)';
  end if;
  return query
    select (pg_catalog.row_number() over (order by k.sample_key collate "C"))::integer, k.record_type, k.record_id, k.label, k.closed_at, k.chain_keys, k.sample_key
      from (select c.record_type, c.record_id, c.label, c.closed_at, c.chain_keys,
                   pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p_seed || ':' || c.record_type || ':' || c.record_id, 'UTF8')), 'hex') as sample_key
              from report.closed_record_rows_v1() c
             where c.closed_at < p_closed_before) k
     order by k.sample_key collate "C"
     limit p_size;
end
$$;

-- The kernel's closed records: closed incidents (DI-12) and closed DI investigations (DI-50).
create function records.closed_incident_records()
returns table (record_id text, label text, closed_at timestamptz, chain_keys text[])
language sql stable security definer set search_path = pg_catalog, records, pg_temp as $$
  select i.id::text, i.reference || ' ' || i.title, i.closed_at, array['incident:' || i.id::text]
    from records.incident_current i
   where i.status = 'CLOSED'
$$;
create function records.closed_di_investigation_records()
returns table (record_id text, label text, closed_at timestamptz, chain_keys text[])
language sql stable security definer set search_path = pg_catalog, records, pg_temp as $$
  select d.id::text, 'DI investigation ' || d.investigation_no::text, c.recorded_at, array['di_investigation:' || d.id::text]
    from records.di_investigation d join records.di_investigation_closure c on c.investigation_id = d.id
$$;
revoke all on function records.closed_incident_records(), records.closed_di_investigation_records() from public;

select report.register_closed_record_source('incident', 'records.closed_incident_records()',
  'Closed incidents (DI-12): the incident chain');
select report.register_closed_record_source('di_investigation', 'records.closed_di_investigation_records()',
  'Closed data-integrity investigations (DI-50): the investigation chain');

revoke all on function report.closed_record_rows_v1(), report.readability_sample_rows_v1(text, timestamptz, integer) from public;
grant execute on function report.closed_record_rows_v1(), report.readability_sample_rows_v1(text, timestamptz, integer) to ebmr_app, ebmr_report;
revoke all on report.closed_record_v1 from public;
grant select on report.closed_record_v1 to ebmr_app, ebmr_report;
insert into report.view_registry (view_name, version, grain, description)
values ('closed_record_v1', 1, 'closed record', 'Every closed record of the installation, when it closed and the audit chains of its archive package');

-- ---------------------------------------------------------------------------------------------
-- The full export
-- ---------------------------------------------------------------------------------------------

-- The closed-record sources find the signatures of a record's parts by a range of the aggregate id (byte order).
create index signature_type_id_c on esig.signature (aggregate_type, aggregate_id collate "C");

-- Tables whose rows an export carries only to a holder of a permission (registered by the owning module).
create table records.export_restricted_table (
  table_name      regclass primary key,
  permission_code text not null,
  description     text not null check (btrim(description) <> ''),
  recorded_at     timestamptz not null default clock_timestamp()
);
revoke all on records.export_restricted_table from public;
select platform.enforce_db_time('records.export_restricted_table', array['recorded_at']);
select kernel.register_audited_table('records.export_restricted_table', 'export_restricted_table', 'table_name', true);

-- Registers a restricted table (migrations only: the owner): an audited table and a known permission.
create function records.register_export_restricted_table(p_table regclass, p_permission text, p_description text) returns void
language plpgsql volatile security definer set search_path = pg_catalog, records, kernel, iam, pg_temp as $$
begin
  if not exists (select 1 from kernel.audited_table a where a.table_name = p_table)
     or not exists (select 1 from iam.permission p where p.code = p_permission) then
    raise exception using errcode = 'P0001', message = format(
      'EBMR-REC-140 %s is no audited table or %s no permission: a restricted table of the export is an audited table with a known permission (DI-08)', p_table, p_permission);
  end if;
  insert into records.export_restricted_table (table_name, permission_code, description) values (p_table, p_permission, btrim(p_description));
end
$$;
revoke all on function records.register_export_restricted_table(regclass, text, text) from public;

-- The permissions an export of these chains needs, checked through iam.require_permission in the scope {} (a grant with
-- no site and no product limit: an export spans every site and product). Refuses, never omits (owner only).
create function records.require_export_permissions(p_chain_keys text[]) returns void
language plpgsql volatile security definer set search_path = pg_catalog, records, kernel, iam, pg_temp as $$
declare
  r       record;
  v_ids   text[];
  v_found boolean;
begin
  for r in select x.table_name, x.permission_code, a.aggregate_type, a.aggregate_column
             from records.export_restricted_table x join kernel.audited_table a on a.table_name = x.table_name
            order by x.table_name::text collate "C" loop
    select coalesce(pg_catalog.array_agg(substr(k, length(r.aggregate_type) + 2)), '{}') into v_ids
      from pg_catalog.unnest(p_chain_keys) k where pg_catalog.starts_with(k, r.aggregate_type || ':');
    continue when cardinality(v_ids) = 0;
    execute format('select exists (select 1 from %s t where t.%I::text = any ($1))', r.table_name, r.aggregate_column) into v_found using v_ids;
    if v_found then
      perform iam.require_permission(r.permission_code, '{}'::jsonb);
    end if;
  end loop;
end
$$;
revoke all on function records.require_export_permissions(text[]) from public;

-- The chains of a closed record's archive package that exist (owner only): its own chains (RECORD) in the source's
-- order, then the signature chains (SIGNATURE): the signature chain of each own chain and the signature chains the
-- source lists itself.
create function records.closed_record_chains(p_chain_keys text[]) returns table (chain_key text, kind text, place integer)
language sql stable security definer set search_path = pg_catalog, records, kernel, pg_temp as $$
  select x.k, x.kind, min(x.o)::integer
    from (select u.k, 'RECORD' as kind, u.o from pg_catalog.unnest(p_chain_keys) with ordinality u(k, o) where not pg_catalog.starts_with(u.k, 'esig_signature:')
          union all
          select 'esig_signature:' || u.k, 'SIGNATURE', u.o from pg_catalog.unnest(p_chain_keys) with ordinality u(k, o) where not pg_catalog.starts_with(u.k, 'esig_signature:')
          union all
          select u.k, 'SIGNATURE', u.o from pg_catalog.unnest(p_chain_keys) with ordinality u(k, o) where pg_catalog.starts_with(u.k, 'esig_signature:')) x
   where exists (select 1 from kernel.audit_chain_head h where h.chain_key = x.k)
   group by x.k, x.kind
$$;
revoke all on function records.closed_record_chains(text[]) from public;

-- One chain's parts for an export (owner only): the true-copy parts and, for a signature chain, the seal payloads.
create function records.export_chain_parts(p_chain_key text) returns jsonb
language sql stable security definer set search_path = pg_catalog, records, esig, pg_temp as $$
  select jsonb_build_object(
    'chainKey', p_chain_key,
    'snapshot', records.true_copy_parts(p_chain_key, null),
    'sealPayloads', case when pg_catalog.starts_with(p_chain_key, 'esig_signature:') then coalesce((
        select jsonb_agg(jsonb_build_object('signatureId', s.id::text, 'payload', esig.seal_payload(s.id)) order by s.recorded_at, s.id)
          from esig.signature s where 'esig_signature:' || s.aggregate_ref = p_chain_key), '[]'::jsonb) else '[]'::jsonb end)
$$;
revoke all on function records.export_chain_parts(text) from public;

-- A full export run and its scope: computed once, at its start, in the exporter's snapshot. Both are insert-only and
-- audited on the run's chain (full_export_run:<run>), so the run's audit trail shows what the export was to hold.
create table records.full_export_run (
  id               uuid primary key default gen_random_uuid(),
  person_id        uuid not null,
  account_id       uuid not null,
  seal_key_chains  text[] not null,
  started_at       timestamptz not null default clock_timestamp()
);
revoke all on records.full_export_run from public;
select platform.enforce_db_time('records.full_export_run', array['started_at']);
select kernel.register_audited_table('records.full_export_run', 'full_export_run', 'id', true);

-- One row per closed record of the run, in export order, with the chains of its archive package that exist: its own
-- (RECORD, the source's order) and its signature chains (SIGNATURE).
create table records.full_export_scope (
  run_id                uuid not null references records.full_export_run (id),
  ordinal               integer not null check (ordinal >= 1),
  record_type           text not null,
  record_id             text not null,
  label                 text not null,
  closed_at             timestamptz not null,
  source_chain_keys     text[] not null,
  chain_keys            text[] not null,
  signature_chain_keys  text[] not null,
  primary key (run_id, ordinal),
  unique (run_id, record_type, record_id)
);
-- The snapshot finds a chain of the run by containment (GIN), whatever the number of records.
create index full_export_scope_chains on records.full_export_scope using gin ((chain_keys || signature_chain_keys));
revoke all on records.full_export_scope from public;
select kernel.register_audited_table('records.full_export_scope', 'full_export_run', 'run_id', true);

create table records.full_export (
  id                  uuid primary key default gen_random_uuid(),
  run_id              uuid not null unique references records.full_export_run (id),
  manifest_sha256     text not null unique check (manifest_sha256 ~ '^[0-9a-f]{64}$'),
  manifest            text not null,
  record_count        integer not null check (record_count >= 0),
  file_count          integer not null check (file_count >= 0),
  exported_by_person  uuid not null,
  exported_by_account uuid not null,
  recorded_at         timestamptz not null default clock_timestamp()
);
revoke all on records.full_export from public;
grant select on records.full_export to ebmr_app;
select platform.enforce_db_time('records.full_export', array['recorded_at']);
select kernel.register_audited_table('records.full_export', 'full_export', 'id', true);

-- The run, checked to be the acting person's own and not registered yet (owner only).
create function records.open_export_run(p_run uuid, p_actor jsonb) returns void
language plpgsql stable security definer set search_path = pg_catalog, records, pg_temp as $$
begin
  if not exists (select 1 from records.full_export_run r where r.id = p_run and r.person_id = (p_actor ->> 'person_id')::uuid)
     or exists (select 1 from records.full_export e where e.run_id = p_run) then
    raise exception using errcode = 'P0001', message = format(
      'EBMR-REC-146 %s is no open full export run of this person: an export is read and registered by the person who started it, once (DI-08)',
      coalesce(p_run::text, 'NULL'));
  end if;
end
$$;
revoke all on function records.open_export_run(uuid, jsonb) from public;

create function records.begin_full_export() returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, records, kernel, report, esig, iam, pg_temp as $$
declare
  v_actor jsonb;
  v_run   uuid;
  v_seal  text[];
  v_keys  text[];
begin
  perform iam.assert_not_administrator();
  v_actor := iam.require_permission('RECORD.EXPORT', '{}'::jsonb);
  select coalesce(pg_catalog.array_agg('esig_seal_key:' || k.key_id order by k.key_id collate "C"), '{}') into v_seal
    from esig.seal_key k
   where exists (select 1 from kernel.audit_chain_head h where h.chain_key = 'esig_seal_key:' || k.key_id);
  insert into records.full_export_run (person_id, account_id, seal_key_chains)
  values ((v_actor ->> 'person_id')::uuid, (v_actor ->> 'account_id')::uuid, v_seal)
  returning id into v_run;
  -- The closed records, computed once.
  insert into records.full_export_scope (run_id, ordinal, record_type, record_id, label, closed_at, source_chain_keys, chain_keys, signature_chain_keys)
  select v_run, (pg_catalog.row_number() over (order by c.closed_at, c.record_type collate "C", c.record_id collate "C"))::integer,
         c.record_type, c.record_id, c.label, c.closed_at, c.chain_keys,
         coalesce((select pg_catalog.array_agg(k.chain_key order by k.place, k.chain_key collate "C") from records.closed_record_chains(c.chain_keys) k where k.kind = 'RECORD'), '{}'),
         coalesce((select pg_catalog.array_agg(k.chain_key order by k.place, k.chain_key collate "C") from records.closed_record_chains(c.chain_keys) k where k.kind = 'SIGNATURE'), '{}')
    from report.closed_record_rows_v1() c;
  select coalesce(pg_catalog.array_agg(k), '{}') || v_seal into v_keys
    from records.full_export_scope s cross join lateral pg_catalog.unnest(s.chain_keys || s.signature_chain_keys) k
   where s.run_id = v_run;
  perform records.require_export_permissions(v_keys);
  return jsonb_build_object(
    'runId', v_run,
    'generatedAt', pg_catalog.to_char(pg_catalog.clock_timestamp() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'installation', jsonb_build_object('kind', kernel.installation_kind(), 'schemaRelease', platform.schema_release()),
    'records', (select count(*) from records.full_export_scope s where s.run_id = v_run),
    'chains', cardinality(v_keys),
    'sealKeyChainKeys', to_jsonb(v_seal));
end
$$;

create function records.full_export_records(p_run uuid, p_after integer, p_limit integer) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, records, iam, pg_temp as $$
declare
  v_actor jsonb;
begin
  perform iam.assert_not_administrator();
  v_actor := iam.require_permission('RECORD.EXPORT', '{}'::jsonb);
  perform records.open_export_run(p_run, v_actor);
  if p_after is null or p_after < 0 or p_limit is null or p_limit < 1 or p_limit > 500 then
    raise exception using errcode = 'P0001', message = 'EBMR-REC-142 a page of the full export starts after an ordinal of 0 or more and holds 1 to 500 records (DI-08)';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'ordinal', s.ordinal, 'recordType', s.record_type, 'recordId', s.record_id, 'label', s.label,
             'closedAt', pg_catalog.to_char(s.closed_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
             'chainKeys', to_jsonb(s.chain_keys), 'signatureChainKeys', to_jsonb(s.signature_chain_keys))
           order by s.ordinal)
      from (select * from records.full_export_scope x where x.run_id = p_run and x.ordinal > p_after order by x.ordinal limit p_limit) s), '[]'::jsonb);
end
$$;

create function records.full_export_snapshot(p_run uuid, p_chain_keys text[]) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, records, kernel, esig, iam, pg_temp as $$
declare
  v_actor   jsonb;
  v_outside text;
begin
  perform iam.assert_not_administrator();
  v_actor := iam.require_permission('RECORD.EXPORT', '{}'::jsonb);
  perform records.open_export_run(p_run, v_actor);
  if p_chain_keys is null or cardinality(p_chain_keys) < 1 or cardinality(p_chain_keys) > 200
     or exists (select 1 from pg_catalog.unnest(p_chain_keys) x where x is null) then
    raise exception using errcode = 'P0001', message = 'EBMR-REC-142 a full-export snapshot names 1 to 200 chains (DI-08)';
  end if;
  select pg_catalog.string_agg(x, ', ' order by x) into v_outside
    from pg_catalog.unnest(p_chain_keys) x
   where not exists (select 1 from records.full_export_scope c where c.run_id = p_run and (c.chain_keys || c.signature_chain_keys) @> array[x])
     and not exists (select 1 from records.full_export_run r where r.id = p_run and x = any (r.seal_key_chains));
  if v_outside is not null then
    raise exception using errcode = 'P0001', message = format(
      'EBMR-REC-143 %s is no chain of the full export: it holds the closed records, their signatures and the seal keys only (DI-08)', v_outside);
  end if;
  return (select jsonb_agg(records.export_chain_parts(u.k) order by u.o) from pg_catalog.unnest(p_chain_keys) with ordinality u(k, o));
end
$$;

create function records.register_full_export(p_run uuid, p_manifest text, p_manifest_sha256 text) returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, records, kernel, iam, pg_temp as $$
declare
  v_actor    jsonb;
  v_m        jsonb;
  v_given    text[];
  v_expected text[];
  v_given_j    jsonb;
  v_expected_j jsonb;
  v_id       uuid;
begin
  perform iam.assert_not_administrator();
  v_actor := iam.require_permission('RECORD.EXPORT', '{}'::jsonb);
  perform records.open_export_run(p_run, v_actor);
  if p_manifest is null or coalesce(p_manifest_sha256, '') !~ '^[0-9a-f]{64}$'
     or pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p_manifest, 'UTF8')), 'hex') <> p_manifest_sha256 then
    raise exception using errcode = 'P0001', message =
      'EBMR-REC-144 a full export is registered with its manifest and the manifest''s SHA-256 (64 lowercase hex characters), which must match (DI-08)';
  end if;
  begin
    v_m := p_manifest::jsonb;
  exception when others then
    v_m := null;
  end;
  if v_m is null or jsonb_typeof(v_m) <> 'object' or v_m ->> 'format' is distinct from 'ebmr.full-export/1'
     or jsonb_typeof(v_m -> 'records') is distinct from 'array' or jsonb_typeof(v_m -> 'files') is distinct from 'array'
     or jsonb_typeof(v_m -> 'sealKeys') is distinct from 'array' or jsonb_typeof(v_m -> 'seals') is distinct from 'string' then
    raise exception using errcode = 'P0001', message = 'EBMR-REC-144 the manifest is no ebmr.full-export/1 manifest with its records, seal keys, seals and files (DI-08)';
  end if;
  -- Exactly the run's records in order, each with exactly its chains and signature chains; exactly its seal key chains.
  select coalesce(jsonb_agg(jsonb_build_array(o, r -> 'recordType', r -> 'recordId', r -> 'label', r -> 'closedAt',
                    (select coalesce(jsonb_agg(c -> 'chainKey' order by n), '[]') from jsonb_array_elements(case when jsonb_typeof(r -> 'chains') = 'array' then r -> 'chains' else '[]' end) with ordinality q(c, n)),
                    (select coalesce(jsonb_agg(c -> 'chainKey' order by n), '[]') from jsonb_array_elements(case when jsonb_typeof(r -> 'signatureChains') = 'array' then r -> 'signatureChains' else '[]' end) with ordinality q(c, n)))
                  order by o), '[]')
    into v_given_j from jsonb_array_elements(v_m -> 'records') with ordinality a(r, o);
  select coalesce(jsonb_agg(jsonb_build_array(s.ordinal, s.record_type, s.record_id, s.label,
                    pg_catalog.to_char(s.closed_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
                    to_jsonb(s.chain_keys), to_jsonb(s.signature_chain_keys)) order by s.ordinal), '[]')
    into v_expected_j from records.full_export_scope s where s.run_id = p_run;
  if v_given_j is distinct from v_expected_j
     or (select coalesce(pg_catalog.array_agg(k ->> 'chainKey' order by n), '{}') from jsonb_array_elements(v_m -> 'sealKeys') with ordinality q(k, n))
        is distinct from (select r.seal_key_chains from records.full_export_run r where r.id = p_run) then
    raise exception using errcode = 'P0001', message = format(
      'EBMR-REC-145 the export does not list exactly the closed records of the run (%s listed, %s in the run), each once with exactly the chains of its archive package, and the seal keys (DI-08)',
      jsonb_array_length(v_m -> 'records'), jsonb_array_length(v_expected_j));
  end if;
  -- Every chain at the head the database holds in this snapshot: the head hash binds every event of the chain.
  select coalesce(pg_catalog.array_agg(x order by x collate "C"), '{}') into v_given
    from (select distinct (c ->> 'chainKey') || '|' || coalesce(c ->> 'headSeq', '') || '|' || coalesce(c ->> 'headHash', '') as x
            from (select c from jsonb_array_elements(v_m -> 'records') r
                   cross join lateral jsonb_array_elements(coalesce(r -> 'chains', '[]') || coalesce(r -> 'signatureChains', '[]')) c
                  union all
                  select c from jsonb_array_elements(v_m -> 'sealKeys') c) z) g;
  select coalesce(pg_catalog.array_agg(x order by x collate "C"), '{}') into v_expected
    from (select distinct k.k || '|' || h.last_seq::text || '|' || pg_catalog.encode(h.last_hash, 'hex') as x
            from (select pg_catalog.unnest(s.chain_keys || s.signature_chain_keys) as k from records.full_export_scope s where s.run_id = p_run
                  union all
                  select pg_catalog.unnest(r.seal_key_chains) from records.full_export_run r where r.id = p_run) k
            join kernel.audit_chain_head h on h.chain_key = k.k) g;
  if v_given is distinct from v_expected then
    raise exception using errcode = 'P0001', message =
      'EBMR-REC-147 a chain of the export is not at the head the database holds (a chain changed after the run started, or the manifest was altered) (DI-08)';
  end if;
  -- Every chain's file and the seal payloads are files of the export, each with its SHA-256 and size, each listed once.
  if exists (select 1 from jsonb_array_elements(v_m -> 'files') f
              where coalesce(f ->> 'sha256', '') !~ '^[0-9a-f]{64}$' or jsonb_typeof(f -> 'bytes') is distinct from 'number'
                 or coalesce(f ->> 'kind', '') not in ('TRUE_COPY', 'SEALS'))
     or (select count(*) from jsonb_array_elements(v_m -> 'files') f) <> (select count(distinct f ->> 'path') from jsonb_array_elements(v_m -> 'files') f)
     or exists (select 1 from (select c ->> 'path' as p from jsonb_array_elements(v_m -> 'records') r
                                cross join lateral jsonb_array_elements(coalesce(r -> 'chains', '[]') || coalesce(r -> 'signatureChains', '[]')) c
                               union all select c ->> 'path' from jsonb_array_elements(v_m -> 'sealKeys') c) z
                 where not exists (select 1 from jsonb_array_elements(v_m -> 'files') f where f ->> 'path' = z.p and f ->> 'kind' = 'TRUE_COPY'))
     or not exists (select 1 from jsonb_array_elements(v_m -> 'files') f where f ->> 'path' = v_m ->> 'seals' and f ->> 'kind' = 'SEALS') then
    raise exception using errcode = 'P0001', message =
      'EBMR-REC-148 the export''s files do not list every chain''s true copy and the seal payloads, each once with its SHA-256 and size (DI-08)';
  end if;
  insert into records.full_export (run_id, manifest_sha256, manifest, record_count, file_count, exported_by_person, exported_by_account)
  values (p_run, p_manifest_sha256, p_manifest, jsonb_array_length(v_m -> 'records'), jsonb_array_length(v_m -> 'files'),
          (v_actor ->> 'person_id')::uuid, (v_actor ->> 'account_id')::uuid)
  returning id into v_id;
  return v_id;
end
$$;

-- The archive package of the sampled record of one rank, for the readability report (DI-44).
create function records.readability_snapshot(p_seed text, p_closed_before timestamptz, p_size integer, p_rank integer) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, records, report, iam, pg_temp as $$
declare
  s      record;
  v_keys text[];
begin
  perform iam.assert_not_administrator();
  perform iam.require_permission('RECORD.EXPORT', '{}'::jsonb);
  select * into s from report.readability_sample_rows_v1(p_seed, p_closed_before, p_size) x where x.rank = p_rank;
  if not found then
    raise exception using errcode = 'P0001', message = format('EBMR-REC-149 the readability sample has no record of rank %s (DI-44)', coalesce(p_rank::text, 'NULL'));
  end if;
  select coalesce(pg_catalog.array_agg(c.chain_key), '{}') into v_keys from records.closed_record_chains(s.chain_keys) c;
  perform records.require_export_permissions(v_keys);
  return jsonb_build_object(
    'recordType', s.record_type, 'recordId', s.record_id, 'label', s.label,
    'chains', coalesce((select jsonb_agg(records.export_chain_parts(c.chain_key) || jsonb_build_object('kind', c.kind)
                                         order by case c.kind when 'RECORD' then 0 else 1 end, c.place, c.chain_key collate "C")
                          from records.closed_record_chains(s.chain_keys) c), '[]'::jsonb));
end
$$;

select kernel.set_actor_context(null);

revoke all on function records.begin_full_export(), records.full_export_records(uuid, integer, integer), records.full_export_snapshot(uuid, text[]),
                       records.register_full_export(uuid, text, text), records.readability_snapshot(text, timestamptz, integer, integer) from public;
grant execute on function records.begin_full_export(), records.full_export_records(uuid, integer, integer), records.full_export_snapshot(uuid, text[]),
                          records.register_full_export(uuid, text, text), records.readability_snapshot(text, timestamptz, integer, integer) to ebmr_app;

reset role;
