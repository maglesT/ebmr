-- Recipe core: the mock recall across sites (Phase 6 slice 6i; outline L-41; controls IN-29, PR-57; defaults D-P6i-0-7,
-- D-P6i-0-10 in docs/build-plan/phase-6/slice-6i-0-interfaces.md; recipe-core 1012, 1090).
--
-- Handbook: modules/recipe-core.md
--
--   recipe.mock_recall_result_v2(kind, id, as_of) jsonb   version 1 (1012) plus `transfers`: every outbound TRANSFER node
--       the forward genealogy reaches (package number, destination installation, depth), each the start of the destination
--       site's part. recipe.mock_recall_run_query runs versions 1 and 2; recipe.run_mock_recall (re-created from 1012)
--       stores version 2. A version 1 run still reproduces as version 1.
--   recipe.mock_recall_remote (insert-only, audited, aggregate mock_recall): per outbound transfer of a run, what its
--       destination answered: ANSWERED (a sealed FORWARD excerpt from the destination as of the run's own as-of point),
--       UNREACHABLE or REFUSED (with the last excerpt received, if any, whose as-of is shown), NOT_REGISTERED (the
--       destination is no longer a trusted peer). recipe.record_mock_recall_remote(run, transfer, status, excerpt, detail)
--       uuid: RECALL.MOCK_RUN, never an administrator, before the sign-off only (EBMR-RCL-020 to -024).
--   recipe.mock_recall_federation(run) jsonb   {complete, transfers[]}: complete only when every outbound transfer has an
--       ANSWERED row; computed here, never stored, and part of the content the AP signs off (recipe.mock_recall_content
--       re-created): an incomplete run is signed as incomplete, never shown complete (D-P6i-0-7).
--
-- Messages: EBMR-RCL-020 to EBMR-RCL-024.

set local role ebmr_owner;

create function recipe.mock_recall_result_v2(p_kind text, p_id uuid, p_as_of timestamptz) returns jsonb
language sql stable security definer set search_path = pg_catalog, recipe, site, pg_temp as $$
  with starts as (select coalesce(array_agg(s.kind order by s.kind, s.id), '{}') as ks, coalesce(array_agg(s.id order by s.kind, s.id), '{}') as ids
                    from recipe.mock_recall_starts(p_kind, p_id, p_as_of) s),
  n as materialized (select f.* from starts, recipe.genealogy_forward_set(starts.ks, starts.ids, p_as_of) f)
  select recipe.mock_recall_result_v1(p_kind, p_id, p_as_of) || jsonb_build_object(
    'query_version', 2,
    'transfers', coalesce((select jsonb_agg(jsonb_build_object('transfer_id', p.id, 'package_no', p.package_no, 'destination', p.destination_installation,
                                                               'lot_id', p.lot_id, 'quantity', p.quantity::text, 'unit', p.unit, 'depth', n.depth)
                                            order by n.depth, p.package_no, p.id)
                             from n join site.transfer_package p on n.kind = 'TRANSFER' and p.id = n.id), '[]'))
$$;

create table recipe.mock_recall_remote (
  id               uuid primary key default gen_random_uuid(),
  mock_recall_id   uuid not null references recipe.mock_recall (id),
  transfer_id      uuid not null,
  peer_code        text not null,
  status           text not null check (status in ('ANSWERED', 'UNREACHABLE', 'REFUSED', 'NOT_REGISTERED')),
  excerpt_id       uuid references recipe.federated_excerpt (id),
  detail           text check (detail is null or length(detail) <= 2000),
  person_id        uuid not null,
  account_id       uuid not null,
  correlation_id   uuid not null,
  recorded_at      timestamptz not null default clock_timestamp(),
  check (status <> 'ANSWERED' or excerpt_id is not null)
);
create index mock_recall_remote_run on recipe.mock_recall_remote (mock_recall_id, transfer_id);
revoke all on recipe.mock_recall_remote from public;
grant select on recipe.mock_recall_remote to ebmr_app;
select platform.enforce_db_time('recipe.mock_recall_remote', array['recorded_at']);
select kernel.register_audited_table('recipe.mock_recall_remote', 'mock_recall', 'mock_recall_id', true);

create function recipe.mock_recall_federation(p_id uuid) returns jsonb
language sql stable security definer set search_path = pg_catalog, recipe, platform, pg_temp as $$
  with m as (select * from recipe.mock_recall where id = p_id),
  t as (select (e ->> 'transfer_id')::uuid as transfer_id, e ->> 'package_no' as package_no, e ->> 'destination' as destination, (e ->> 'depth')::integer as depth
          from m, jsonb_array_elements(coalesce(m.result -> 'transfers', '[]'::jsonb)) e),
  best as (
    select t.*, x.status, x.excerpt_id, x.detail, x.recorded_at, fe.as_of as excerpt_as_of
      from t left join lateral (
        select r.* from recipe.mock_recall_remote r where r.mock_recall_id = p_id and r.transfer_id = t.transfer_id
         order by (r.status = 'ANSWERED') desc, r.recorded_at desc, r.id desc limit 1) x on true
      left join recipe.federated_excerpt fe on fe.id = x.excerpt_id)
  select jsonb_build_object(
    'complete', not exists (select 1 from best where best.status is distinct from 'ANSWERED'),
    'transfers', coalesce((select jsonb_agg(jsonb_build_object('transfer_id', b.transfer_id, 'package_no', b.package_no, 'destination', b.destination,
                                                               'depth', b.depth, 'status', coalesce(b.status, 'NOT_ASKED'), 'excerpt_id', b.excerpt_id,
                                                               'excerpt_as_of_us', platform.timestamptz_to_epoch_us(b.excerpt_as_of), 'detail', b.detail)
                                            order by b.depth, b.package_no, b.transfer_id) from best b), '[]'))
$$;

create function recipe.record_mock_recall_remote(p_id uuid, p_transfer uuid, p_status text, p_excerpt uuid, p_detail text) returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, recipe, iam, pg_temp as $$
declare
  v_actor jsonb;
  m       recipe.mock_recall;
  t       jsonb;
  e       recipe.federated_excerpt;
  v_id    uuid;
begin
  perform iam.assert_not_administrator();
  v_actor := iam.require_permission('RECALL.MOCK_RUN', '{}'::jsonb);
  select * into m from recipe.mock_recall where id = p_id for update;
  if m.id is null then
    raise exception using errcode = 'P0001', message = format('EBMR-RCL-010 there is no mock recall %s', coalesce(p_id::text, 'NULL'));
  end if;
  if exists (select 1 from recipe.mock_recall_signoff s where s.mock_recall_id = m.id) then
    raise exception using errcode = 'P0001', message = 'EBMR-RCL-020 the mock recall is signed off; what other sites answer is recorded before the sign-off';
  end if;
  select x into t from jsonb_array_elements(coalesce(m.result -> 'transfers', '[]'::jsonb)) x where x ->> 'transfer_id' = p_transfer::text;
  if t is null then
    raise exception using errcode = 'P0001', message = format('EBMR-RCL-021 transfer %s is not an outbound transfer this mock recall reached', coalesce(p_transfer::text, 'NULL'));
  end if;
  if p_status is null or p_status not in ('ANSWERED', 'UNREACHABLE', 'REFUSED', 'NOT_REGISTERED') then
    raise exception using errcode = 'P0001', message = 'EBMR-RCL-022 a destination ANSWERED, was UNREACHABLE, REFUSED, or is NOT_REGISTERED';
  end if;
  if p_excerpt is not null then
    select * into e from recipe.federated_excerpt where id = p_excerpt;
    if e.id is null or e.transfer_id <> p_transfer or e.direction <> 'FORWARD' or e.peer_code <> t ->> 'destination' then
      raise exception using errcode = 'P0001', message = 'EBMR-RCL-023 the excerpt is not the destination''s forward genealogy of this transfer';
    end if;
  end if;
  if p_status = 'ANSWERED' and (e.id is null or e.as_of <> m.as_of) then
    raise exception using errcode = 'P0001',
      message = 'EBMR-RCL-024 an ANSWERED destination gave its forward genealogy as of the mock recall''s own as-of point; an older excerpt is shown as such, never as the answer (D-P6i-0-7)';
  end if;
  insert into recipe.mock_recall_remote (mock_recall_id, transfer_id, peer_code, status, excerpt_id, detail, person_id, account_id, correlation_id)
  values (m.id, p_transfer, t ->> 'destination', p_status, p_excerpt, nullif(left(btrim(coalesce(p_detail, '')), 2000), ''),
          (v_actor ->> 'person_id')::uuid, (v_actor ->> 'account_id')::uuid, (v_actor ->> 'correlation_id')::uuid)
  returning id into v_id;
  return v_id;
end
$$;

create or replace function recipe.mock_recall_run_query(p_version integer, p_kind text, p_id uuid, p_as_of timestamptz) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, recipe, pg_temp as $$
begin
  if p_version = 1 then
    return recipe.mock_recall_result_v1(p_kind, p_id, p_as_of);
  end if;
  if p_version = 2 then
    return recipe.mock_recall_result_v2(p_kind, p_id, p_as_of);
  end if;
  raise exception using errcode = 'P0001', message = format('EBMR-RCL-005 mock recall query version %s is not runnable here', coalesce(p_version::text, 'NULL'));
end
$$;

create or replace function recipe.run_mock_recall(p_kind text, p_id uuid, p_as_of timestamptz, p_informed boolean, p_reference text) returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, recipe, site, iam, pg_temp as $$
declare
  v_actor  jsonb;
  v_as_of  timestamptz := coalesce(p_as_of, clock_timestamp());
  v_ref    text;
  v_result jsonb;
  v_id     uuid;
begin
  perform iam.assert_not_administrator();
  v_actor := iam.require_permission('RECALL.MOCK_RUN', '{}'::jsonb);
  if p_kind is null or p_kind not in ('LOT', 'DEVIATION') then
    raise exception using errcode = 'P0001', message = format('EBMR-RCL-001 a mock recall starts from a LOT or a DEVIATION, not %s', coalesce(p_kind, 'NULL'));
  end if;
  if v_as_of > clock_timestamp() then
    raise exception using errcode = 'P0001', message = 'EBMR-RCL-002 the as-of point of a mock recall is now or in the past (D-P6d-0-3)';
  end if;
  if p_kind = 'LOT' then
    select l.lot_code into v_ref from site.material_lot l where l.id = p_id and l.received_at <= v_as_of;
  else
    select d.ref into v_ref from site.deviation d where d.id = p_id and d.raised_at <= v_as_of;
  end if;
  if v_ref is null then
    raise exception using errcode = 'P0001', message = format('EBMR-RCL-003 there is no %s %s as of the instant asked', lower(p_kind), coalesce(p_id::text, 'NULL'));
  end if;
  if p_kind = 'DEVIATION' and not exists (select 1 from recipe.mock_recall_starts(p_kind, p_id, v_as_of)) then
    raise exception using errcode = 'P0001', message = format('EBMR-RCL-004 deviation %s links no batch, lot or container as of the instant asked; link the affected subjects first (PR-50)', v_ref);
  end if;
  if p_informed is null or (p_informed and btrim(coalesce(p_reference, '')) = '') or (not p_informed and p_reference is not null) then
    raise exception using errcode = 'P0001',
      message = 'EBMR-RCL-006 a mock recall states whether the licensing authority was informed of the intended recall, with the reference of that notice when it was (IN-29)';
  end if;
  v_result := recipe.mock_recall_run_query(2, p_kind, p_id, v_as_of);
  insert into recipe.mock_recall (subject_kind, subject_id, subject_ref, as_of, query_version, result, result_sha256, authority_informed, authority_reference,
                                  person_id, account_id, role_code, correlation_id)
  values (p_kind, p_id, v_ref, v_as_of, 2, v_result, recipe.mock_recall_sha256(v_result), p_informed, nullif(btrim(coalesce(p_reference, '')), ''),
          (v_actor ->> 'person_id')::uuid, (v_actor ->> 'account_id')::uuid, v_actor ->> 'role_code', (v_actor ->> 'correlation_id')::uuid)
  returning id into v_id;
  return v_id;
end
$$;

create or replace function recipe.mock_recall_content(p_id text) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, recipe, pg_temp as $$
declare
  m recipe.mock_recall;
begin
  if coalesce(p_id, '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return '{"exists": false}'::jsonb;
  end if;
  select * into m from recipe.mock_recall where id = p_id::uuid;
  if m.id is null then
    return '{"exists": false}'::jsonb;
  end if;
  return jsonb_build_object(
    'exists', true, 'content_version', 1,
    'state', case when exists (select 1 from recipe.mock_recall_signoff s where s.mock_recall_id = m.id) then 'SIGNED_OFF' else 'RUN' end,
    'content', jsonb_build_object('mock_recall_id', m.id, 'subject_kind', m.subject_kind, 'subject_ref', m.subject_ref,
                                  'as_of_us', platform.timestamptz_to_epoch_us(m.as_of), 'query_version', m.query_version,
                                  'result_sha256', m.result_sha256, 'counts', m.result -> 'counts',
                                  'authority_informed', m.authority_informed, 'authority_reference', m.authority_reference)
                 -- Version 2 (1091): what the other sites answered is part of what the AP signs off (D-P6i-0-7).
                 || case when m.query_version >= 2 then jsonb_build_object('federation', recipe.mock_recall_federation(m.id)) else '{}'::jsonb end,
    'scope', '{}'::jsonb);
end
$$;

revoke all on function recipe.mock_recall_result_v2(text, uuid, timestamptz), recipe.mock_recall_federation(uuid),
  recipe.record_mock_recall_remote(uuid, uuid, text, uuid, text) from public;
grant execute on function recipe.mock_recall_federation(uuid), recipe.record_mock_recall_remote(uuid, uuid, text, uuid, text) to ebmr_app;

reset role;
