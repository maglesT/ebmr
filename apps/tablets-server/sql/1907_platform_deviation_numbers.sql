-- Platform slice 2, deviations through the Deviations product (owner ruling, 9 November 2026; replaces declutter residual
-- D4-R5).
--
-- Handbook: modules/site-services.md
--
-- A batch record system records exceptions and links deviations; the deviation itself (investigation,
-- classification, closure, CAPA) is managed in the Deviations product, which publishes report.deviation_v1 (one row per
-- linked batch: number, status, classification, ...). Where the server has a Deviations link (DEVIATIONS_DATABASE_URL),
-- a batch's deviation is stored here only as its Deviations number; the exception stays in this record system and Deviations
-- reads it through exception_v1. Release stays blocked until every linked number is closed or rejected in Deviations
-- (21 CFR 211.192: the quality unit reviews the records before release and any unexplained discrepancy is thoroughly
-- investigated; 211.100(b): a departure is recorded and justified; Revised Schedule M 18.2.2 and 18.5.12, as control
-- IN-05 cites them: records reviewed and discrepancies investigated before the authorised person certifies). The rule is the
-- database's, through the same guard-fact pattern as master data (1900): the server reads the view on its own login, in
-- the transaction that releases, and records what it read here. A standalone server writes no row here, so nothing
-- below changes its behaviour.
--
--   dv.batch_number_link   insert-only: a GMP batch ↔ a Deviations number, by whom and when (dv.link_number).
--   dv.status_fact         insert-only evidence of each release-time read of deviation_v1: the number's status as the view
--                          gave it (null: the view has no row for it), in which transaction, by whom.
--   dv.link_number(batch, number)
--                          the person's command (DEVIATION.RAISE at the batch's site): links the number to the batch.
--   dv.record_status(number, status, classification, data_as_of)
--                          ebmr_app only: records the server's read in the releasing transaction.
--   dv.subject_batches(kind, id)
--                          the batches a release subject rests on (BATCH, LOT, CONTAINER).
--   dv.release_problem(batches)
--                          the first number linked to one of the batches that is not resolved (closed or rejected) by a
--                          fact of this transaction; without a fact it raises SQLSTATE EBM01 with the number as detail (the
--                          server reads it and runs the release again).
--   Release paths: the same state_history events as site-services 0822 (a material lot's RELEASE, RELEASE_FOR_FURTHER_
--   PROCESSING and UNHOLD; an output container's RELEASE), for the lot's batches (recipe.release_batches, its
--   intermediate lot's batch) and the container's batch.
--   site.deviation_ref_problem: a number linked to the batch is accepted where an exception or a review disposition
--   names a deviation (LINK, DISPOSITION). Invalidation and reprocessing name a local OOS or investigation record, which stays
--   local and fully working with the link (lead ruling, 9 November 2026).

create schema dv authorization ebmr_owner;
revoke all on schema dv from public;

set local role ebmr_owner;

grant usage on schema dv to ebmr_app;

create table dv.batch_number_link (
  id                 uuid primary key default gen_random_uuid(),
  batch_id           uuid not null,
  batch_number       text not null,
  number             text not null check (number ~ '^[A-Za-z0-9][A-Za-z0-9/._-]{0,63}$'),
  linked_by_person   uuid not null,
  linked_by_account  uuid not null,
  linked_at          timestamptz not null default clock_timestamp(),
  unique (batch_id, number)
);
select iam.protect_log('dv.batch_number_link');

create table dv.status_fact (
  id              uuid primary key default gen_random_uuid(),
  xact_id         xid8 not null default pg_current_xact_id(),
  number          text not null,
  status          text check (status in ('classification', 'approval', 'investigation', 'closure', 'closed', 'rejected')),
  classification  text,
  data_as_of      timestamptz,
  person_id       uuid,
  read_at         timestamptz not null default clock_timestamp()
);
select iam.protect_log('dv.status_fact');
create index status_fact_by_xact on dv.status_fact (xact_id, number);

create function dv.link_number(p_batch uuid, p_number text) returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, dv, site, iam, pg_temp as $$
declare
  v_ctx jsonb := site.require_actor();
  v_b   jsonb;
  v_n   text := btrim(coalesce(p_number, ''));
  v_id  uuid;
begin
  perform iam.assert_not_administrator();
  v_b := site.subject_identity('BATCH', p_batch);
  if v_b is null then
    raise exception using errcode = 'P0001', message = format('Batch %s is not a GMP batch of this installation. [EBMR-DV-003]', coalesce(p_batch::text, 'NULL'));
  end if;
  perform iam.require_permission('DEVIATION.RAISE', jsonb_build_object('site', v_b ->> 'siteCode'));
  if v_n !~ '^[A-Za-z0-9][A-Za-z0-9/._-]{0,63}$' then
    raise exception using errcode = 'P0001', message = format('%s is not a Deviations number (letters, digits and / . _ -, at most 64). [EBMR-DV-003]', coalesce(nullif(v_n, ''), 'An empty value'));
  end if;
  if exists (select 1 from dv.batch_number_link l where l.batch_id = p_batch and l.number = v_n) then
    raise exception using errcode = 'P0001', message = format('Deviation %s is already linked to batch %s. [EBMR-DV-003]', v_n, v_b ->> 'batchNumber');
  end if;
  insert into dv.batch_number_link (batch_id, batch_number, number, linked_by_person, linked_by_account)
  values (p_batch, v_b ->> 'batchNumber', v_n, (v_ctx ->> 'person_id')::uuid, (v_ctx ->> 'account_id')::uuid)
  returning id into v_id;
  return v_id;
end
$$;

create function dv.record_status(p_number text, p_status text, p_classification text, p_data_as_of timestamptz) returns void
language sql volatile security definer set search_path = pg_catalog, dv, kernel, pg_temp as $$
  insert into dv.status_fact (number, status, classification, data_as_of, person_id)
  values (p_number, p_status, p_classification, p_data_as_of, nullif(kernel.current_actor() ->> 'person_id', '')::uuid)
$$;

create function dv.release_problem(p_batches uuid[]) returns text
language plpgsql stable security definer set search_path = pg_catalog, dv, pg_temp as $$
declare
  l dv.batch_number_link;
  f dv.status_fact;
begin
  for l in select * from dv.batch_number_link x where x.batch_id = any (p_batches) order by x.linked_at, x.id loop
    select * into f from dv.status_fact s
     where s.xact_id = pg_current_xact_id_if_assigned() and s.number = l.number order by s.read_at desc limit 1;
    if f.id is null then
      raise exception using errcode = 'EBM01',
        message = format('The release needs the status of deviation %s from the Deviations product. [EBMR-DV-000]', l.number),
        detail = jsonb_build_object('kind', 'deviation', 'code', l.number)::text;
    end if;
    if f.status is null then
      return format('deviation %s linked to batch %s is not in the Deviations product', l.number, l.batch_number);
    end if;
    if f.status not in ('closed', 'rejected') then
      return format('deviation %s linked to batch %s is %s in the Deviations product; release waits until it is closed or rejected', l.number, l.batch_number, f.status);
    end if;
  end loop;
  return null;
end
$$;

-- The batches a release subject rests on: a BATCH itself; a LOT's batches (recipe.release_batches: its packaging batch and
-- the processing batch it packs; an intermediate lot's batch); a CONTAINER's batch.
create function dv.subject_batches(p_kind text, p_id uuid) returns uuid[]
language sql stable security definer set search_path = pg_catalog, dv, recipe, site, plant, pg_temp as $$
  select case p_kind
    when 'BATCH' then array[p_id]
    when 'LOT' then recipe.release_batches(p_id) || coalesce((select array_agg(i.batch_id) from site.intermediate_lot i where i.lot_id = p_id), '{}')
    when 'CONTAINER' then coalesce((select array[c.batch_id] from plant.output_container c where c.id = p_id), '{}')
    else '{}'::uuid[] end
$$;

create function dv.guard_release() returns trigger
language plpgsql security definer set search_path = pg_catalog, dv, pg_temp as $$
declare
  v_batches uuid[] := dv.subject_batches(case new.aggregate_type when 'material_lot' then 'LOT' else 'CONTAINER' end, new.aggregate_id::uuid);
  v_problem text;
begin
  if not exists (select 1 from dv.batch_number_link l where l.batch_id = any (v_batches)) then
    return new;
  end if;
  v_problem := dv.release_problem(v_batches);
  if v_problem is not null then
    raise exception using errcode = 'P0001',
      message = format('The %s cannot be released: %s. [EBMR-DV-001]', replace(new.aggregate_type, '_', ' '), v_problem);
  end if;
  return new;
end
$$;

create trigger zz_release_dv_lot before insert on platform.state_history
  for each row when (new.aggregate_type = 'material_lot' and new.event in ('RELEASE', 'RELEASE_FOR_FURTHER_PROCESSING', 'UNHOLD'))
  execute function dv.guard_release();
create trigger zz_release_dv_container before insert on platform.state_history
  for each row when (new.aggregate_type = 'output_container' and new.event = 'RELEASE')
  execute function dv.guard_release();

-- As site-services 0753, with one branch added: a Deviations number linked to the batch (dv.batch_number_link).
create or replace function site.deviation_ref_problem(p_ref text, p_use text, p_batch uuid) returns text
language plpgsql stable security definer set search_path = pg_catalog, site, pg_temp as $$
declare
  d      site.deviation;
  v_b    jsonb;
  v_st   text;
  c      site.deviation_conclusion;
begin
  if p_use is null or p_use not in ('LINK', 'DISPOSITION', 'INVALIDATION', 'REPROCESSING') then
    return format('%s is not a use of a deviation reference (LINK, DISPOSITION, INVALIDATION, REPROCESSING)', coalesce(p_use, 'NULL'));
  end if;
  if btrim(coalesce(p_ref, '')) = '' then
    return 'names no deviation-lite reference (D-S2-2)';
  end if;
  v_b := site.subject_identity('BATCH', p_batch);
  if v_b is null then
    return format('batch %s is not a GMP batch of this installation; a deviation reference is checked for GMP batches (D-S5-2)', coalesce(p_batch::text, 'NULL'));
  end if;
  select * into d from site.deviation where ref = btrim(p_ref);
  if not found then
    if exists (select 1 from dv.batch_number_link l where l.batch_id = p_batch and l.number = btrim(p_ref)) then
      if p_use in ('INVALIDATION', 'REPROCESSING') then
        return format('%s is a Deviations number of a batch deviation; invalidating a result and reprocessing name the OOS or investigation record of this installation that concluded it (IN-20)', btrim(p_ref));
      end if;
      return null;
    end if;
    return format('%s is not a deviation-lite record of this installation (D-S2-2; PR-49)', btrim(p_ref));
  end if;
  if d.site_code <> v_b ->> 'siteCode' then
    return format('%s was raised at site %s, not at the batch''s site %s (PR-49)', d.ref, d.site_code, v_b ->> 'siteCode');
  end if;
  v_st := site.deviation_state(d.id);
  if v_st = 'CANCELLED' then
    return format('%s was cancelled (D-S5-1)', d.ref);
  end if;
  if not exists (select 1 from site.deviation_link l where l.deviation_id = d.id and l.subject_kind = 'BATCH' and l.subject_id = p_batch) then
    return format('%s is not linked to batch %s; link the batch to the record first (PR-49)', d.ref, v_b ->> 'batchNumber');
  end if;
  if p_use in ('INVALIDATION', 'REPROCESSING') then
    if p_use = 'INVALIDATION' and d.kind not in ('OOS', 'INVESTIGATION') then
      return format('%s is a %s record; a result is invalidated only on an OOS or investigation record (IN-20; DI-24)', d.ref, d.kind);
    end if;
    select * into c from site.deviation_conclusion x where x.deviation_id = d.id;
    if not found then
      return format('%s is %s: it has no QA-signed conclusion yet (IN-20)', d.ref, v_st);
    end if;
    if p_use = 'INVALIDATION' and not (c.assignable_cause and c.root_cause_category = 'LABORATORY_ERROR') then
      return format('%s was concluded %s; a result is invalidated only on a concluded, confirmed laboratory error (assignable cause in the category LABORATORY_ERROR) (IN-20; DI-24)',
                    d.ref, case when c.assignable_cause then format('with an assignable cause of category %s', c.root_cause_category) else 'without an assignable cause' end);
    end if;
  end if;
  return null;
end
$$;

revoke all on function dv.link_number(uuid, text), dv.record_status(text, text, text, timestamptz), dv.release_problem(uuid[]), dv.subject_batches(text, uuid),
  dv.guard_release() from public;
grant execute on function dv.link_number(uuid, text), dv.record_status(text, text, text, timestamptz), dv.subject_batches(text, uuid) to ebmr_app;
grant select on dv.batch_number_link to ebmr_app;

reset role;
