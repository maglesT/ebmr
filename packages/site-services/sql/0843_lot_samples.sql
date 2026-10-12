-- Reserve and retention samples of lots (Phase 4 slice 2b; controls PR-44, IN-32; plan defaults D-2b-4 and D-2b-5).
--
--   site.lot_sample           a sample pulled from a lot (insert-only): RESERVE for a finished lot (its final pack),
--                             RETENTION for a starting material; quantity and unit, the container and storage place, the
--                             quantity the rule requires and the instant the sample is kept until, both computed by the
--                             database when it is pulled:
--                               * required quantity: twice the sample quantities of every test of the specification in
--                                 effect for the lot's material (all tests: the Indian condition covers all tests on the
--                                 batch, so the US allowance to leave out sterility and pyrogen tests is not used; IN-32);
--                                 a test whose sample unit is not the lot's unit cannot be counted and the pull is refused;
--                               * kept until: a finished lot, the latest over its batch's markets of India expiry +
--                                 3 months, US expiry + 1 year, EU expiry + 1 year (IN-32, PR-44); a starting material,
--                                 its expiry + 1 year (D-2b-5; the rule "one year after the last product lot containing
--                                 it" needs the trace of slice 7 and stays a residual).
--   site.lot_sample_disposal  the disposal of a sample with the person's reason: refused before its kept-until instant at
--                             database time (EBMR-SITE-433).
--   site.lot_sample_problem(lot)  why a finished lot has no reserve samples of at least the required quantity (pulled,
--                             not disposed), or NULL; for the packaging completion and release checks (slice 3).
-- Default D-2b-4: several pulls may make up the reserve; each pull records the required quantity at its time.
-- Messages: EBMR-SITE-430 to EBMR-SITE-434.

set local role ebmr_owner;

create table site.lot_sample (
  id                   uuid primary key default gen_random_uuid(),
  lot_id               uuid not null references site.material_lot (id),
  kind                 text not null check (kind in ('RESERVE', 'RETENTION')),
  quantity             numeric not null check (quantity > 0),
  unit                 text not null,
  required_quantity    numeric not null check (required_quantity > 0),
  container            text not null check (btrim(container) <> '' and length(container) <= 200),
  storage_location     text not null check (btrim(storage_location) <> '' and length(storage_location) <= 200),
  retain_until         timestamptz not null,
  pulled_by_person     uuid not null,
  pulled_by_account    uuid not null,
  pulled_at            timestamptz not null default clock_timestamp(),
  correlation_id       uuid not null
);
create index lot_sample_lot on site.lot_sample (lot_id);
revoke all on site.lot_sample from public;

create table site.lot_sample_disposal (
  sample_id            uuid primary key references site.lot_sample (id),
  reason               text not null check (btrim(reason) <> '' and length(reason) <= 2000),
  disposed_by_person   uuid not null,
  disposed_by_account  uuid not null,
  disposed_at          timestamptz not null default clock_timestamp()
);
revoke all on site.lot_sample_disposal from public;

select platform.enforce_db_time('site.lot_sample', array['pulled_at']);
select platform.enforce_db_time('site.lot_sample_disposal', array['disposed_at']);
select kernel.register_audited_table('site.lot_sample', 'material_lot', 'lot_id', true);
select kernel.register_audited_table('site.lot_sample_disposal', 'lot_sample', 'sample_id', true);

-- Twice the sample quantities of every test of the specification in effect for the lot, in the lot's unit; NULL when no
-- specification is in effect or a test's sample unit is not the lot's unit.
create function site.lot_sample_required(p_lot uuid) returns numeric
language sql stable security definer set search_path = pg_catalog, site, pg_temp as $$
  select case when count(t.id) = 0 or bool_or(t.sample_unit <> l.unit) then null else 2 * sum(t.sample_quantity) end
    from site.material_lot l
    left join site.specification_test t on t.specification_id = site.specification_in_effect(l.site_code, l.material_code)
   where l.id = p_lot
   group by l.id
$$;

-- The instant a sample of the lot is kept until (header).
create function site.lot_sample_retain_until(p_lot uuid) returns timestamptz
language sql stable security definer set search_path = pg_catalog, site, pg_temp as $$
  select case when l.material_kind = 'FINISHED'
              then (select max(case m when 'IN' then l.expires_at + interval '3 months' else l.expires_at + interval '1 year' end)
                      from site.finished_lot f, unnest(f.markets) m where f.lot_id = l.id)
              else l.expires_at + interval '1 year' end
    from site.material_lot l where l.id = p_lot
$$;

-- p: {kind, quantity (decimal text), container, storageLocation}. Returns the sample's id.
create function site.pull_lot_sample(p_lot uuid, p jsonb) returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, site, iam, pg_temp as $$
declare
  v_ctx  jsonb := site.require_actor();
  l      site.material_lot;
  v_req  numeric;
  v_kind text;
  v_id   uuid;
begin
  perform iam.assert_not_administrator();
  l := site.lock_lot(p_lot);
  perform iam.require_permission('SAMPLE.PULL', jsonb_build_object('site', l.site_code));
  if site.lot_state(l.id) in ('CONSUMED', 'DESTROYED') then
    raise exception using errcode = 'P0001', message = format('EBMR-SITE-430 lot %s is %s; no sample is pulled from it', l.lot_code, site.lot_state(l.id));
  end if;
  if p is null or jsonb_typeof(p) <> 'object' then
    raise exception using errcode = 'P0001', message = 'EBMR-SITE-430 the sample details are required';
  end if;
  v_kind := case when l.material_kind = 'FINISHED' then 'RESERVE'
                 when l.material_kind in ('API', 'EXCIPIENT', 'PRIMARY_PACKAGING', 'PRINTED_PACKAGING') then 'RETENTION' end;
  if v_kind is null or p ->> 'kind' is distinct from v_kind then
    raise exception using errcode = 'P0001',
      message = format('EBMR-SITE-430 lot %s is %s: %s (a finished lot keeps RESERVE samples in its final pack, a starting material RETENTION samples; PR-44, IN-32)',
                       l.lot_code, l.material_kind, coalesce('its samples are ' || v_kind, 'no reserve or retention sample is kept of it'));
  end if;
  if coalesce(p ->> 'quantity', '') !~ '^[0-9]+(\.[0-9]+)?$' or (p ->> 'quantity')::numeric <= 0 then
    raise exception using errcode = 'P0001', message = 'EBMR-SITE-431 the sample quantity is a positive decimal in the lot''s unit';
  end if;
  if coalesce(btrim(p ->> 'container'), '') = '' or coalesce(btrim(p ->> 'storageLocation'), '') = '' then
    raise exception using errcode = 'P0001', message = 'EBMR-SITE-431 a sample names its container and where it is stored (PR-44)';
  end if;
  v_req := site.lot_sample_required(l.id);
  if v_req is null then
    raise exception using errcode = 'P0001',
      message = format('EBMR-SITE-432 the quantity a sample of lot %s needs is twice the sample quantities of its specification''s tests in %s; no approved specification in effect gives them in that unit (PR-44, IN-32)',
                       l.lot_code, l.unit);
  end if;
  insert into site.lot_sample (lot_id, kind, quantity, unit, required_quantity, container, storage_location, retain_until, pulled_by_person, pulled_by_account, correlation_id)
  values (l.id, v_kind, (p ->> 'quantity')::numeric, l.unit, v_req, btrim(p ->> 'container'), btrim(p ->> 'storageLocation'), site.lot_sample_retain_until(l.id),
          (v_ctx ->> 'person_id')::uuid, (v_ctx ->> 'account_id')::uuid, (v_ctx ->> 'correlation_id')::uuid)
  returning id into v_id;
  return v_id;
end
$$;

create function site.dispose_lot_sample(p_sample uuid, p_reason text) returns void
language plpgsql volatile security definer set search_path = pg_catalog, site, iam, pg_temp as $$
declare
  v_ctx jsonb := site.require_actor();
  s     site.lot_sample;
  l     site.material_lot;
begin
  perform iam.assert_not_administrator();
  select * into s from site.lot_sample where id = p_sample for update;
  if not found then
    raise exception using errcode = 'P0001', message = format('EBMR-SITE-433 unknown sample %s', p_sample);
  end if;
  select * into l from site.material_lot where id = s.lot_id;
  perform iam.require_permission('SAMPLE.DISPOSE', jsonb_build_object('site', l.site_code));
  if exists (select 1 from site.lot_sample_disposal d where d.sample_id = s.id) then
    raise exception using errcode = 'P0001', message = 'EBMR-SITE-433 the sample is already disposed of';
  end if;
  if clock_timestamp() < s.retain_until then
    raise exception using errcode = 'P0001',
      message = format('EBMR-SITE-433 the sample of lot %s is kept until %s; it is not disposed of before (PR-44, IN-32)', l.lot_code, site.utc_text(s.retain_until));
  end if;
  if btrim(coalesce(p_reason, '')) = '' then
    raise exception using errcode = 'P0001', message = 'EBMR-SITE-434 a disposal states the person''s own reason (DI-22)';
  end if;
  insert into site.lot_sample_disposal (sample_id, reason, disposed_by_person, disposed_by_account)
  values (s.id, btrim(p_reason), (v_ctx ->> 'person_id')::uuid, (v_ctx ->> 'account_id')::uuid);
end
$$;

-- PR-44, IN-32 (header): why finished lot p_lot has no reserve samples of at least the required quantity, or NULL.
create function site.lot_sample_problem(p_lot uuid) returns text
language plpgsql stable security definer set search_path = pg_catalog, site, pg_temp as $$
declare
  l     site.material_lot;
  v_req numeric;
  v_got numeric;
begin
  select * into l from site.material_lot where id = p_lot;
  if not found then
    return 'the lot does not exist';
  end if;
  if l.material_kind <> 'FINISHED' then
    return null;
  end if;
  v_req := site.lot_sample_required(l.id);
  if v_req is null then
    return format('no approved specification of %s gives the sample quantities of its tests in %s; the reserve quantity cannot be computed (PR-44, IN-32)', l.material_code, l.unit);
  end if;
  select coalesce(sum(s.quantity), 0) into v_got from site.lot_sample s
   where s.lot_id = l.id and s.kind = 'RESERVE' and not exists (select 1 from site.lot_sample_disposal d where d.sample_id = s.id);
  if v_got < v_req then
    return format('finished lot %s keeps %s %s of reserve samples; at least %s %s (twice the full test plan) are required (PR-44, IN-32)', l.lot_code, v_got, l.unit, v_req, l.unit);
  end if;
  return null;
end
$$;

select kernel.set_actor_context(jsonb_build_object(
  'person_id', '00000000-0000-0000-0000-000000000000', 'account_id', '00000000-0000-0000-0000-000000000000',
  'role_code', 'SOFTWARE_RELEASE', 'session_id', '00000000-0000-0000-0000-000000000000', 'source', 'SYSTEM',
  'site_zone', 'UTC', 'correlation_id', gen_random_uuid(),
  'legal_name', 'Software release (site-services migration 0843_lot_samples)',
  'reason_code', 'SOFTWARE_RELEASE',
  'reason_text', 'reserve and retention samples (PR-44, IN-32)'));

insert into iam.permission (code, domain, effect, description) values
  ('SAMPLE.PULL', 'GMP', 'WRITE', 'Pull a reserve sample of a finished lot or a retention sample of a starting material (QC)'),
  ('SAMPLE.DISPOSE', 'GMP', 'WRITE', 'Dispose of a reserve or retention sample after its retention period (QA)');

insert into iam.role_permission (role_code, permission_code) values
  ('QC_ANALYST', 'SAMPLE.PULL'),
  ('HEAD_OF_QC', 'SAMPLE.PULL'),
  ('QA_REVIEWER', 'SAMPLE.DISPOSE');

select kernel.set_actor_context(null);

revoke all on site.lot_sample, site.lot_sample_disposal from ebmr_app;
grant select on site.lot_sample, site.lot_sample_disposal to ebmr_app;
revoke all on function site.lot_sample_required(uuid), site.lot_sample_retain_until(uuid) from public;
grant execute on function site.pull_lot_sample(uuid, jsonb), site.dispose_lot_sample(uuid, text), site.lot_sample_problem(uuid),
                          site.lot_sample_required(uuid) to ebmr_app;

reset role;
