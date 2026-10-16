-- Phase 6 slice 6b (builder B): reagent and buffer lots with an expiry (PR-29; D-P6b-B-6). The lab's reagents,
-- buffers (pH calibration buffers), volumetric solutions and reference standards used at in-process controls are
-- lots of their own, apart from the material lots of the batch (they are never consumed into the product): each has
-- its expiry (a received reagent's expiry date, a prepared buffer's use-by), and a lot is withdrawn (discarded) early
-- with a reason. A use at a step of a batch is recorded by recipe-core 0973 (plant.record_reagent_use), which refuses
-- an expired, withdrawn or unknown lot (site.reagent_lot_problem) at database time.
--
-- Handbook: modules/site-services.md
--
--   site.reagent_lot             insert-only, audited: code, kind (REAGENT, BUFFER, VOLUMETRIC_SOLUTION, STANDARD), the
--                                reagent's name, the lot code (unique), the nominal value a buffer states (pH 4.01),
--                                when it was received or prepared and its expiry; QC.RESULT_RECORD
--   site.reagent_lot_withdrawal  insert-only, audited: a lot discarded before its expiry, with the reason; once
--   site.record_reagent_lot(p jsonb) returns uuid       {lotCode, kind, reagentCode, name, nominal?, preparedAt, expiresAt}
--   site.withdraw_reagent_lot(lot_code, reason)
--   site.reagent_lot_problem(lot_code, at) returns text null when the lot may be used at the instant, else why
--
-- Messages: EBMR-SITE-950 to EBMR-SITE-955.

set local role ebmr_owner;

create table site.reagent_lot (
  id                   uuid primary key default gen_random_uuid(),
  lot_code             text not null unique check (lot_code ~ '^[A-Z0-9][A-Z0-9/._-]{0,39}$'),
  kind                 text not null check (kind in ('REAGENT', 'BUFFER', 'VOLUMETRIC_SOLUTION', 'STANDARD')),
  reagent_code         text not null check (reagent_code ~ '^[A-Z0-9][A-Z0-9/._-]{0,39}$'),
  name                 text not null check (btrim(name) <> '' and length(name) <= 200),
  nominal              text check (nominal is null or (btrim(nominal) <> '' and length(nominal) <= 64)),
  prepared_at          timestamptz not null,
  expires_at           timestamptz not null,
  recorded_by_person   uuid not null,
  recorded_by_account  uuid not null,
  correlation_id       uuid not null,
  recorded_at          timestamptz not null default clock_timestamp(),
  check (expires_at > prepared_at)
);
revoke all on site.reagent_lot from public;
select platform.enforce_db_time('site.reagent_lot', array['recorded_at']);
select kernel.register_audited_table('site.reagent_lot', 'reagent_lot', 'id', true);

create table site.reagent_lot_withdrawal (
  reagent_lot_id       uuid primary key references site.reagent_lot (id),
  reason               text not null check (btrim(reason) <> '' and length(reason) <= 500),
  withdrawn_by_person  uuid not null,
  withdrawn_by_account uuid not null,
  correlation_id       uuid not null,
  withdrawn_at         timestamptz not null default clock_timestamp()
);
revoke all on site.reagent_lot_withdrawal from public;
select platform.enforce_db_time('site.reagent_lot_withdrawal', array['withdrawn_at']);
select kernel.register_audited_table('site.reagent_lot_withdrawal', 'reagent_lot', 'reagent_lot_id', true);

create function site.record_reagent_lot(p jsonb) returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, site, iam, pg_temp as $$
declare
  v_actor jsonb;
  v_id    uuid;
  k       text;
begin
  perform iam.assert_not_administrator();
  v_actor := iam.require_permission('QC.RESULT_RECORD', '{}'::jsonb);
  if jsonb_typeof(p) is distinct from 'object' then
    raise exception using errcode = 'P0001', message = 'EBMR-SITE-950 a reagent lot is an object';
  end if;
  for k in select jsonb_object_keys(p) loop
    if k not in ('lotCode', 'kind', 'reagentCode', 'name', 'nominal', 'preparedAt', 'expiresAt') then
      raise exception using errcode = 'P0001', message = format('EBMR-SITE-950 a reagent lot has no field %s', k);
    end if;
  end loop;
  if coalesce(p ->> 'lotCode', '') !~ '^[A-Z0-9][A-Z0-9/._-]{0,39}$' or coalesce(p ->> 'kind', '') not in ('REAGENT', 'BUFFER', 'VOLUMETRIC_SOLUTION', 'STANDARD')
     or coalesce(p ->> 'reagentCode', '') !~ '^[A-Z0-9][A-Z0-9/._-]{0,39}$' or coalesce(btrim(p ->> 'name'), '') = ''
     or (p ? 'nominal' and jsonb_typeof(p -> 'nominal') not in ('string', 'null'))
     or coalesce(p ->> 'preparedAt', '') = '' or coalesce(p ->> 'expiresAt', '') = '' then
    raise exception using errcode = 'P0001',
      message = 'EBMR-SITE-950 a reagent lot names its lot code, kind (REAGENT, BUFFER, VOLUMETRIC_SOLUTION, STANDARD), reagent code, name, when it was received or prepared and its expiry (PR-29)';
  end if;
  if (p ->> 'expiresAt')::timestamptz <= (p ->> 'preparedAt')::timestamptz or (p ->> 'preparedAt')::timestamptz > clock_timestamp() then
    raise exception using errcode = 'P0001', message = 'EBMR-SITE-951 a reagent lot is received or prepared by now and expires after that (PR-29)';
  end if;
  if exists (select 1 from site.reagent_lot where lot_code = p ->> 'lotCode') then
    raise exception using errcode = 'P0001', message = format('EBMR-SITE-952 reagent lot %s is recorded already', p ->> 'lotCode');
  end if;
  insert into site.reagent_lot (lot_code, kind, reagent_code, name, nominal, prepared_at, expires_at, recorded_by_person, recorded_by_account, correlation_id)
  values (p ->> 'lotCode', p ->> 'kind', p ->> 'reagentCode', btrim(p ->> 'name'), nullif(btrim(coalesce(p ->> 'nominal', '')), ''),
          (p ->> 'preparedAt')::timestamptz, (p ->> 'expiresAt')::timestamptz,
          (v_actor ->> 'person_id')::uuid, (v_actor ->> 'account_id')::uuid, (v_actor ->> 'correlation_id')::uuid)
  returning id into v_id;
  return v_id;
end
$$;

create function site.withdraw_reagent_lot(p_lot_code text, p_reason text) returns void
language plpgsql volatile security definer set search_path = pg_catalog, site, iam, pg_temp as $$
declare
  v_actor jsonb;
  r       site.reagent_lot;
begin
  perform iam.assert_not_administrator();
  v_actor := iam.require_permission('QC.RESULT_RECORD', '{}'::jsonb);
  select * into r from site.reagent_lot where lot_code = p_lot_code for update;
  if r.id is null then
    raise exception using errcode = 'P0001', message = format('EBMR-SITE-953 there is no reagent lot %s', coalesce(p_lot_code, 'NULL'));
  end if;
  if coalesce(btrim(p_reason), '') = '' then
    raise exception using errcode = 'P0001', message = 'EBMR-SITE-950 a reagent lot is withdrawn with the reason';
  end if;
  if exists (select 1 from site.reagent_lot_withdrawal where reagent_lot_id = r.id) then
    raise exception using errcode = 'P0001', message = format('EBMR-SITE-954 reagent lot %s is withdrawn already', r.lot_code);
  end if;
  insert into site.reagent_lot_withdrawal (reagent_lot_id, reason, withdrawn_by_person, withdrawn_by_account, correlation_id)
  values (r.id, btrim(p_reason), (v_actor ->> 'person_id')::uuid, (v_actor ->> 'account_id')::uuid, (v_actor ->> 'correlation_id')::uuid);
end
$$;

-- PR-29: null when reagent lot p_lot_code may be used at p_at; else why not (unknown, not yet recorded, expired, withdrawn).
create function site.reagent_lot_problem(p_lot_code text, p_at timestamptz) returns text
language sql stable security definer set search_path = pg_catalog, site, pg_temp as $$
  select case
           when r.id is null or r.recorded_at > p_at then format('EBMR-SITE-953 there is no reagent lot %s (PR-29)', coalesce(p_lot_code, 'NULL'))
           when r.expires_at <= p_at then format('EBMR-SITE-955 %s lot %s (%s) expired at %s; an expired reagent or buffer is not used (PR-29)',
                                                 lower(replace(r.kind, '_', ' ')), r.lot_code, r.name, to_char(r.expires_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'))
           when w.withdrawn_at is not null and w.withdrawn_at <= p_at then format('EBMR-SITE-954 reagent lot %s was withdrawn: %s (PR-29)', r.lot_code, w.reason)
         end
  from (select 1) one
  left join site.reagent_lot r on r.lot_code = p_lot_code
  left join site.reagent_lot_withdrawal w on w.reagent_lot_id = r.id
$$;

revoke all on function site.record_reagent_lot(jsonb), site.withdraw_reagent_lot(text, text), site.reagent_lot_problem(text, timestamptz) from public;
grant execute on function site.record_reagent_lot(jsonb), site.withdraw_reagent_lot(text, text), site.reagent_lot_problem(text, timestamptz) to ebmr_app;
grant select on site.reagent_lot, site.reagent_lot_withdrawal to ebmr_app;

reset role;
