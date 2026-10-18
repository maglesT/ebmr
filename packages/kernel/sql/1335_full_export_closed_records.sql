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
-- The full export (DI-08 clause 2; RECORD.EXPORT, "every export is logged"):
--   records.full_export_index()            the closed records with the chains of their archive package that exist,
--                                          each record's signature chains (esig_signature:<chain>) and every seal key
--                                          chain (esig_seal_key:<key id>), with the installation kind and release.
--   records.full_export_snapshot(keys)     the true-copy parts (records.true_copy_parts, latest 1173) of up to 200 of
--                                          those chains, and for a signature chain the seal payload of each signature
--                                          (esig.seal_payload), which the viewer checks against the audited seal row's
--                                          payload SHA-256 and the seal. A chain outside the export is refused.
--   records.full_export                    insert-only register of every full export: its manifest and SHA-256 (the
--                                          reference the viewer compares with), its record and file counts, who.
--   records.register_full_export(m, sha)   recomputes the SHA-256 of the manifest and requires that it lists exactly
--                                          the closed records of the snapshot it runs in (the exporter runs the index,
--                                          the snapshots and the register in one REPEATABLE READ transaction).
--
-- Messages: EBMR-REC-140 to EBMR-REC-145.

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

create table records.full_export (
  id                  uuid primary key default gen_random_uuid(),
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

-- The chains a full export holds (owner only): every chain of every closed record that exists, the signature chain of
-- each of them, and every seal key chain.
create function records.full_export_chain_keys() returns table (chain_key text)
language sql stable security definer set search_path = pg_catalog, records, kernel, report, esig, pg_temp as $$
  select k from (
    select pg_catalog.unnest(c.chain_keys) as k from report.closed_record_rows_v1() c
    union
    select 'esig_signature:' || pg_catalog.unnest(c.chain_keys) from report.closed_record_rows_v1() c
    union
    select 'esig_seal_key:' || s.key_id from esig.seal_key s
  ) x
  where exists (select 1 from kernel.audit_chain_head h where h.chain_key = x.k)
$$;
revoke all on function records.full_export_chain_keys() from public;

create function records.full_export_index() returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, records, kernel, report, esig, iam, pg_temp as $$
declare
  v_keys text[];
begin
  perform iam.assert_not_administrator();
  perform iam.require_permission('RECORD.EXPORT', '{}'::jsonb);
  select coalesce(pg_catalog.array_agg(k.chain_key), '{}') into v_keys from records.full_export_chain_keys() k;
  return jsonb_build_object(
    'generatedAt', pg_catalog.to_char(pg_catalog.clock_timestamp() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'installation', jsonb_build_object('kind', kernel.installation_kind(), 'schemaRelease', platform.schema_release()),
    'records', coalesce((
      select jsonb_agg(jsonb_build_object(
               'recordType', c.record_type, 'recordId', c.record_id, 'label', c.label,
               'closedAt', pg_catalog.to_char(c.closed_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
               'chainKeys', (select coalesce(jsonb_agg(k order by o), '[]'::jsonb) from pg_catalog.unnest(c.chain_keys) with ordinality u(k, o)
                              where k = any (v_keys) and k not like 'esig\_signature:%'),
               'signatureChainKeys', (select coalesce(jsonb_agg(g.k order by g.o, g.k collate "C"), '[]'::jsonb)
                                        from (select distinct on (x.k) x.k, x.o
                                                from (select 'esig_signature:' || k as k, o from pg_catalog.unnest(c.chain_keys) with ordinality u(k, o)
                                                       where k not like 'esig\_signature:%'
                                                      union all
                                                      select k, o from pg_catalog.unnest(c.chain_keys) with ordinality u(k, o) where k like 'esig\_signature:%') x
                                               where x.k = any (v_keys)
                                               order by x.k, x.o) g))
             order by c.closed_at, c.record_type collate "C", c.record_id collate "C")
        from report.closed_record_rows_v1() c), '[]'::jsonb),
    'sealKeyChainKeys', coalesce((select jsonb_agg('esig_seal_key:' || s.key_id order by s.key_id collate "C")
                                    from esig.seal_key s where ('esig_seal_key:' || s.key_id) = any (v_keys)), '[]'::jsonb));
end
$$;

create function records.full_export_snapshot(p_chain_keys text[]) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, records, kernel, esig, iam, pg_temp as $$
declare
  v_out     jsonb := '[]'::jsonb;
  v_outside text;
  k         text;
begin
  perform iam.assert_not_administrator();
  perform iam.require_permission('RECORD.EXPORT', '{}'::jsonb);
  if p_chain_keys is null or cardinality(p_chain_keys) < 1 or cardinality(p_chain_keys) > 200
     or exists (select 1 from pg_catalog.unnest(p_chain_keys) x where x is null) then
    raise exception using errcode = 'P0001', message = 'EBMR-REC-142 a full-export snapshot names 1 to 200 chains (DI-08)';
  end if;
  select pg_catalog.string_agg(x, ', ' order by x) into v_outside
    from pg_catalog.unnest(p_chain_keys) x
   where x not in (select e.chain_key from records.full_export_chain_keys() e);
  if v_outside is not null then
    raise exception using errcode = 'P0001', message = format(
      'EBMR-REC-143 %s is no chain of the full export: it holds the closed records, their signatures and the seal keys only (DI-08)', v_outside);
  end if;
  foreach k in array p_chain_keys loop
    v_out := v_out || jsonb_build_array(jsonb_build_object(
      'chainKey', k,
      'snapshot', records.true_copy_parts(k, null),
      'sealPayloads', case when k like 'esig_signature:%' then coalesce((
          select jsonb_agg(jsonb_build_object('signatureId', s.id::text, 'payload', esig.seal_payload(s.id)) order by s.recorded_at, s.id)
            from esig.signature s where 'esig_signature:' || s.aggregate_ref = k), '[]'::jsonb) else '[]'::jsonb end));
  end loop;
  return v_out;
end
$$;

create function records.register_full_export(p_manifest text, p_manifest_sha256 text) returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, records, kernel, report, iam, pg_temp as $$
declare
  v_actor  jsonb;
  v_m      jsonb;
  v_listed text[];
  v_closed text[];
  v_id     uuid;
begin
  perform iam.assert_not_administrator();
  v_actor := iam.require_permission('RECORD.EXPORT', '{}'::jsonb);
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
     or jsonb_typeof(v_m -> 'records') is distinct from 'array' or jsonb_typeof(v_m -> 'files') is distinct from 'array' then
    raise exception using errcode = 'P0001', message = 'EBMR-REC-144 the manifest is no ebmr.full-export/1 manifest with its records and files (DI-08)';
  end if;
  select coalesce(pg_catalog.array_agg((r ->> 'recordType') || ':' || (r ->> 'recordId') order by 1), '{}') into v_listed
    from jsonb_array_elements(v_m -> 'records') r;
  select coalesce(pg_catalog.array_agg(c.record_type || ':' || c.record_id order by 1), '{}') into v_closed
    from report.closed_record_rows_v1() c;
  if (select pg_catalog.array_agg(x order by x collate "C") from pg_catalog.unnest(v_listed) x)
     is distinct from (select pg_catalog.array_agg(x order by x collate "C") from pg_catalog.unnest(v_closed) x) then
    raise exception using errcode = 'P0001', message = format(
      'EBMR-REC-145 the export lists %s records, but the installation has %s closed records: a full export holds every closed record, once (DI-08)',
      cardinality(v_listed), cardinality(v_closed));
  end if;
  insert into records.full_export (manifest_sha256, manifest, record_count, file_count, exported_by_person, exported_by_account)
  values (p_manifest_sha256, p_manifest, cardinality(v_listed), jsonb_array_length(v_m -> 'files'),
          (v_actor ->> 'person_id')::uuid, (v_actor ->> 'account_id')::uuid)
  returning id into v_id;
  return v_id;
end
$$;

select kernel.set_actor_context(null);

revoke all on function records.full_export_index(), records.full_export_snapshot(text[]), records.register_full_export(text, text) from public;
grant execute on function records.full_export_index(), records.full_export_snapshot(text[]), records.register_full_export(text, text) to ebmr_app;

reset role;
