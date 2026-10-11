-- The signed retest binds what it decides and is used once (Phase 3 slice 6a, slice 6 review; controls PR-18, DI-35,
-- DI-37). 0760's signature named only material_lot:<id>, whose content does not change with a retest: the new date and
-- the results were not in what was signed, and one signature could serve later retests.
--
--   aggregate lot_retest:<lot>/<new retest instant in UTC, site.utc_text>/<result ids, distinct and sorted, joined by +>
--                                    its content: the lot, its material and current retest instant, the new instant and each
--                                    named result (test, value, unit, limits, verdict, state); its performers the lot's and
--                                    the results' recorders (ESIG-044); state OPEN until a retest
--                                    with exactly that lot, instant and results is recorded, then DECIDED
--   site.lot_retest_signature        insert-only, audited: the signature of each recorded retest, once (a signature is
--                                    used by one retest only, unique)
--   site.record_signed_lot_retest    (replaces 0760) the actor's valid LOT_RETEST_APPROVED signature of that aggregate,
--                                    the permission (QC.RESULT_APPROVE), never an administrator; then 0752's rules; then
--                                    the signature recorded with the retest
-- The unsigned writer is the owner's only since 0761. Messages: EBMR-SITE-190, EBMR-SITE-191.

set local role ebmr_owner;

create table site.lot_retest_signature (
  retest_id     uuid primary key references site.lot_retest (id),
  lot_id        uuid not null references site.material_lot (id),
  signature_id  uuid not null unique,
  signer_person uuid not null,
  recorded_at   timestamptz not null default clock_timestamp()
);
revoke all on site.lot_retest_signature from public;
select platform.enforce_db_time('site.lot_retest_signature', array['recorded_at']);
select kernel.register_audited_table('site.lot_retest_signature', 'material_lot', 'lot_id', true);
grant select on site.lot_retest_signature to ebmr_app;

-- The aggregate id a retest decision is signed under (a pure function of its arguments; definer for site.utc_text).
create function site.lot_retest_aggregate_id(p_lot uuid, p_at timestamptz, p_results uuid[]) returns text
language sql immutable security definer set search_path = pg_catalog, site, pg_temp as $$
  select format('%s/%s/%s', p_lot, site.utc_text(p_at), array_to_string(array(select d.t from (select distinct x::text as t from unnest(coalesce(p_results, '{}'::uuid[])) x) d order by d.t collate "C"), '+'))
$$;

create function site.lot_retest_content(p_id text) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, site, pg_temp as $$
declare
  m       text[];
  l       site.material_lot;
  v_at    timestamptz;
  v_ids   uuid[];
  v_state text;
begin
  m := regexp_match(coalesce(p_id, ''), '^([0-9a-f-]{36})/([0-9T:.Z-]+)/([0-9a-f+-]*)$');
  if m is null then
    return '{"exists": false}'::jsonb;
  end if;
  select * into l from site.material_lot where id = m[1]::uuid;
  if not found then
    return '{"exists": false}'::jsonb;
  end if;
  v_at := m[2]::timestamptz;
  v_ids := case when m[3] = '' then '{}'::uuid[] else string_to_array(m[3], '+')::uuid[] end;
  if site.lot_retest_aggregate_id(l.id, v_at, v_ids) <> p_id then
    return '{"exists": false}'::jsonb;
  end if;
  v_state := case when exists (select 1 from site.lot_retest x where x.lot_id = l.id and x.retest_at = v_at
                                 and x.result_ids = array(select distinct unnest(v_ids) order by 1)) then 'DECIDED' else 'OPEN' end;
  return jsonb_build_object(
    'exists', true,
    'content_version', 1,
    'content', jsonb_build_object(
      'lot_code', l.lot_code, 'material_code', l.material_code, 'material_name', l.material_name,
      'current_retest', site.utc_text(site.lot_retest_at(l.id)), 'new_retest', site.utc_text(v_at), 'expires', site.utc_text(l.expires_at),
      'results', coalesce((select jsonb_agg(jsonb_build_object('result_id', r.id, 'test_code', r.test_code, 'purpose', r.purpose, 'value', r.result_value::text,
                                                               'unit', r.unit, 'lower_limit', r.lower_limit::text, 'upper_limit', r.upper_limit::text,
                                                               'verdict', r.verdict, 'state', site.lot_test_state(r.id)) order by r.id)
                             from site.lot_test_result r where r.id = any (v_ids)), '[]'::jsonb)),
    'state', v_state,
    'scope', jsonb_build_object('site', l.site_code),
    -- ESIG-044: whoever entered the lot's data (as its own content says) or recorded a named result does not approve the retest.
    'entered_by', coalesce((select to_jsonb(array_agg(distinct p)) from (
                    select x as p from jsonb_array_elements_text(coalesce(site.material_lot_content(l.id::text) -> 'entered_by', '[]'::jsonb)) x
                    union select r.recorded_by_person::text from site.lot_test_result r where r.id = any (v_ids)) q), '[]'::jsonb));
end
$$;

select esig.register_content_provider('lot_retest', 'site.lot_retest_content(text)',
  'A retest decision of a material lot: the lot, its new retest instant and the approved retest results it rests on (PR-18)');

create or replace function site.record_signed_lot_retest(p_lot uuid, p_retest_at timestamptz, p_results uuid[], p_signature uuid) returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, site, iam, esig, pg_temp as $$
declare
  v_ctx jsonb := site.require_actor();
  v_sig jsonb;
  v_id  uuid;
begin
  perform iam.assert_not_administrator();
  perform iam.require_permission('QC.RESULT_APPROVE', jsonb_build_object('site', (select l.site_code from site.material_lot l where l.id = p_lot)));
  if p_signature is null then
    raise exception using errcode = 'P0001', message = 'EBMR-SITE-190 a retest decision is signed LOT_RETEST_APPROVED by the QC person who takes it (PR-18, DI-35)';
  end if;
  -- DI-37: the signature names this lot, this new instant and these results.
  v_sig := esig.assert_signature(p_signature, 'LOT_RETEST_APPROVED', 'lot_retest', site.lot_retest_aggregate_id(p_lot, p_retest_at, p_results));
  if (v_sig ->> 'signer_person') is distinct from (v_ctx ->> 'person_id') then
    raise exception using errcode = 'P0001', message = 'EBMR-SITE-190 a retest decision is recorded by the QC person who signed it (PR-18, DI-35)';
  end if;
  if exists (select 1 from site.lot_retest_signature s where s.signature_id = p_signature) then
    raise exception using errcode = 'P0001', message = 'EBMR-SITE-191 this signature already records a retest; each retest decision is signed on its own (DI-37)';
  end if;
  v_id := site.record_lot_retest(p_lot, p_retest_at, p_results);
  insert into site.lot_retest_signature (retest_id, lot_id, signature_id, signer_person) values (v_id, p_lot, p_signature, (v_ctx ->> 'person_id')::uuid);
  return v_id;
end
$$;

revoke all on function site.lot_retest_aggregate_id(uuid, timestamptz, uuid[]), site.lot_retest_content(text) from public;
grant execute on function site.lot_retest_aggregate_id(uuid, timestamptz, uuid[]) to ebmr_app;

reset role;
