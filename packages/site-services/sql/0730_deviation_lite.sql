-- Deviation-lite, the core (Phase 3 slice 5a-0; docs/build-plan/phase-3/slice-5-plan.md "Interfaces fixed before
-- building", defaults D-S5-1 and D-S5-2; outline 5.2.5, the lite part only). Controls PR-49, PR-50 and IN-20 (lite):
-- a deviation, OOS or investigation record with a generated reference, linked to the batches, lots and containers it
-- concerns, concluded and closed by QA other than its initiator. The full deviation stand-in or QMS adapter, the
-- per-lot-and-market impact, CAPA, regulatory notification, other-batch scope (ST-71), release blocking and suspension
-- are Phase 4.
--
--   subject_resolver      the extension point through which the batch side names a batch or an output container to
--                         site services (site services is applied before recipe-core and never reads its tables):
--                         one registered function fn(kind text, id uuid) returns jsonb {batchId, batchNumber, edition,
--                         siteCode, productCode, strength, ref}, or NULL when the subject is not a GMP record of this
--                         installation. Registered by recipe-core 0600. Without one, every BATCH or CONTAINER subject is
--                         unknown (fails closed).
--   deviation             one record (insert-only): ref generated DEV-<site>-<yyyy>-<nnnnn> (TEST-DEV-... in a
--                         sandbox, DI-05), never typed; kind DEVIATION | OOS | INVESTIGATION; title, description,
--                         classification MINOR | MAJOR | CRITICAL with the person's risk rationale; the initiator.
--   deviation_link        a subject the record concerns (insert-only): BATCH | LOT | CONTAINER, by id, with the batch
--                         number and edition (as reservations name a batch) and the subject's own reference.
--   deviation_event       INVESTIGATION_STARTED, CLOSED (QA signature DEVIATION_CLOSED), CANCELLED (the person's own
--                         reason): one row each, insert-only.
--   deviation_finding     the investigator's finding (assignable cause yes or no, cause, root-cause category); a new
--                         finding supersedes the earlier one and every signature given before it (registered signed
--                         table, INV-09).
--   deviation_conclusion  QA's signed conclusion (DEVIATION_CONCLUDED): the finding it concludes, copied, with the
--                         signature. One per record.
--   site.deviation_state(id)      OPEN -> UNDER_INVESTIGATION -> CONCLUDED -> CLOSED; OPEN or UNDER_INVESTIGATION ->
--                                 CANCELLED. Derived from the rows, never stored.
--   site.deviation_ref_problem(ref, use, batch)  NULL when a GMP batch may cite the reference for the use (LINK,
--                                 DISPOSITION, INVALIDATION, REPROCESSING), else why not (D-S2-2, backlog slice 2 #1b).
--
-- S7 (outline 7.2): the conclusion, the closure and a cancellation are by a QA person other than the initiator; the
-- conclusion also by another person than the investigator who recorded the finding (excludes_performers).
-- Privileges: ebmr_app reads; every write is a SECURITY DEFINER command (DI-17, DI-18; ADR 0012, 0016).
-- Messages: EBMR-SITE-300 to 329.

set local role ebmr_owner;

-- ---------------------------------------------------------------------------------------------
-- The subject resolver (extension point)
-- ---------------------------------------------------------------------------------------------

create table site.subject_resolver (
  singleton      boolean primary key default true check (singleton),
  function_oid   regprocedure not null,
  registered_at  timestamptz not null default clock_timestamp()
);
revoke all on site.subject_resolver from public;

-- Owner-level only (migrations of the batch side). The function takes (text, uuid) and returns jsonb.
create function site.register_subject_resolver(p_function regprocedure) returns void
language plpgsql volatile security definer set search_path = pg_catalog, site, pg_temp as $$
begin
  if not exists (select 1 from pg_proc p where p.oid = p_function and oidvectortypes(p.proargtypes) = 'text, uuid' and p.prorettype = 'jsonb'::regtype) then
    raise exception using errcode = 'P0001', message = format('EBMR-SITE-300 %s is not a subject resolver fn(text, uuid) returns jsonb', p_function);
  end if;
  insert into site.subject_resolver (singleton, function_oid) values (true, p_function)
  on conflict (singleton) do update set function_oid = excluded.function_oid, registered_at = clock_timestamp();
end
$$;

-- The identity of a BATCH or CONTAINER subject from the batch side: {batchId, batchNumber, edition, siteCode,
-- productCode, strength, ref}; NULL when no resolver is registered or the subject is not a GMP record it knows.
create function site.subject_identity(p_kind text, p_id uuid) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, site, platform, pg_temp as $$
declare
  v_fn regprocedure;
  v    jsonb;
begin
  if p_kind is null or p_kind not in ('BATCH', 'CONTAINER') or p_id is null then
    return null;
  end if;
  select r.function_oid into v_fn from site.subject_resolver r;
  if v_fn is null then
    return null;
  end if;
  execute format('select %s($1, $2)', platform.function_call_name(v_fn)) into v using p_kind, p_id;
  if jsonb_typeof(v) is distinct from 'object' or coalesce(v ->> 'batchId', '') = '' or coalesce(v ->> 'siteCode', '') = '' then
    return null;
  end if;
  return v;
end
$$;

-- ---------------------------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------------------------

create table site.deviation (
  id                 uuid primary key,
  ref                text not null unique check (ref ~ '^(TEST-)?DEV-[A-Z0-9][A-Z0-9-]{0,15}-[0-9]{4}-[0-9]{5,}$'),
  site_code          text not null check (site_code ~ '^[A-Z0-9][A-Z0-9-]{0,15}$'),
  ref_year           integer not null check (ref_year between 2000 and 9999),
  ref_serial         integer not null check (ref_serial >= 1),
  kind               text not null check (kind in ('DEVIATION', 'OOS', 'INVESTIGATION')),
  title              text not null check (btrim(title) <> '' and length(title) <= 200),
  description        text check (description is null or btrim(description) <> ''),
  classification     text not null check (classification in ('MINOR', 'MAJOR', 'CRITICAL')),
  risk_rationale     text not null check (length(btrim(risk_rationale)) >= 10),
  raised_by_person   uuid not null,
  raised_by_account  uuid not null,
  raised_at          timestamptz not null default clock_timestamp(),
  correlation_id     uuid not null,
  unique (site_code, ref_year, ref_serial)
);
revoke all on site.deviation from public;

create table site.deviation_link (
  id                 uuid primary key default gen_random_uuid(),
  deviation_id       uuid not null references site.deviation (id),
  subject_kind       text not null check (subject_kind in ('BATCH', 'LOT', 'CONTAINER')),
  subject_id         uuid not null,
  subject_ref        text not null check (btrim(subject_ref) <> ''),
  batch_id           uuid,
  batch_number       text check (batch_number ~ '^[A-Z0-9][A-Z0-9/.-]{0,31}$'),
  edition            text check (edition in ('TABLETS', 'INJECTABLES')),
  linked_by_person   uuid not null,
  linked_by_account  uuid not null,
  linked_at          timestamptz not null default clock_timestamp(),
  unique (deviation_id, subject_kind, subject_id),
  check (subject_kind = 'LOT' or (batch_id is not null and batch_number is not null and edition is not null)),
  check (subject_kind <> 'BATCH' or batch_id = subject_id),
  check (subject_kind <> 'LOT' or (batch_id is null and batch_number is null and edition is null))
);
create index deviation_link_subject on site.deviation_link (subject_kind, subject_id);
create index deviation_link_batch on site.deviation_link (batch_id);
revoke all on site.deviation_link from public;

create table site.deviation_event (
  id                 uuid primary key default gen_random_uuid(),
  deviation_id       uuid not null references site.deviation (id),
  event              text not null check (event in ('INVESTIGATION_STARTED', 'CLOSED', 'CANCELLED')),
  reason             text,
  signature_id       uuid unique,
  person_id          uuid not null,
  account_id         uuid not null,
  recorded_at        timestamptz not null default clock_timestamp(),
  unique (deviation_id, event),
  check (event <> 'CANCELLED' or btrim(coalesce(reason, '')) <> ''),
  check ((event = 'CLOSED') = (signature_id is not null))
);
revoke all on site.deviation_event from public;

create table site.deviation_finding (
  id                    uuid primary key default gen_random_uuid(),
  deviation_id          uuid not null references site.deviation (id),
  assignable_cause      boolean not null,
  cause                 text not null check (length(btrim(cause)) >= 10),
  root_cause_category   text not null check (root_cause_category in ('HUMAN_ERROR', 'EQUIPMENT', 'MATERIAL', 'METHOD', 'ENVIRONMENT', 'PROCESS',
                                                                      'LABORATORY_ERROR', 'NOT_DETERMINED')),
  recorded_by_person    uuid not null,
  recorded_by_account   uuid not null,
  recorded_at           timestamptz not null default clock_timestamp(),
  check (not assignable_cause or root_cause_category <> 'NOT_DETERMINED')
);
create index deviation_finding_deviation on site.deviation_finding (deviation_id, recorded_at);
revoke all on site.deviation_finding from public;

create table site.deviation_conclusion (
  deviation_id          uuid primary key references site.deviation (id),
  finding_id            uuid not null unique references site.deviation_finding (id),
  assignable_cause      boolean not null,
  cause                 text not null,
  root_cause_category   text not null,
  signature_id          uuid not null unique,
  concluded_by_person   uuid not null,
  concluded_by_account  uuid not null,
  concluded_at          timestamptz not null default clock_timestamp()
);
revoke all on site.deviation_conclusion from public;

select platform.enforce_db_time('site.deviation', array['raised_at']);
select platform.enforce_db_time('site.deviation_link', array['linked_at']);
select platform.enforce_db_time('site.deviation_event', array['recorded_at']);
select platform.enforce_db_time('site.deviation_finding', array['recorded_at']);
select platform.enforce_db_time('site.deviation_conclusion', array['concluded_at']);

select kernel.register_audited_table('site.deviation', 'deviation', 'id', true);
select kernel.register_audited_table('site.deviation_link', 'deviation', 'deviation_id', true);
select kernel.register_audited_table('site.deviation_event', 'deviation', 'deviation_id', true);
select kernel.register_audited_table('site.deviation_finding', 'deviation', 'deviation_id', true);
select kernel.register_audited_table('site.deviation_conclusion', 'deviation', 'deviation_id', true);

-- ---------------------------------------------------------------------------------------------
-- Reading a record
-- ---------------------------------------------------------------------------------------------

create function site.deviation_state(p_id uuid) returns text
language sql stable security definer set search_path = pg_catalog, site, pg_temp as $$
  select case
    when exists (select 1 from site.deviation_event e where e.deviation_id = d.id and e.event = 'CANCELLED') then 'CANCELLED'
    when exists (select 1 from site.deviation_event e where e.deviation_id = d.id and e.event = 'CLOSED') then 'CLOSED'
    when exists (select 1 from site.deviation_conclusion c where c.deviation_id = d.id) then 'CONCLUDED'
    when exists (select 1 from site.deviation_event e where e.deviation_id = d.id and e.event = 'INVESTIGATION_STARTED') then 'UNDER_INVESTIGATION'
    else 'OPEN' end
  from site.deviation d where d.id = p_id
$$;

create function site.deviation_latest_finding(p_id uuid) returns site.deviation_finding
language sql stable security definer set search_path = pg_catalog, site, pg_temp as $$
  select f.* from site.deviation_finding f where f.deviation_id = p_id order by f.recorded_at desc, f.id desc limit 1
$$;

-- The record's signatures cover its data, its links, its life-cycle events, the latest finding and the conclusion.
create function site.deviation_content(p_id text) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, site, pg_temp as $$
declare
  d site.deviation;
  f site.deviation_finding;
begin
  if coalesce(p_id, '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return '{"exists": false}'::jsonb;
  end if;
  select * into d from site.deviation where id = p_id::uuid;
  if not found then
    return '{"exists": false}'::jsonb;
  end if;
  f := site.deviation_latest_finding(d.id);
  return jsonb_build_object(
    'exists', true,
    'content_version', 1 + (select count(*) from site.deviation_link l where l.deviation_id = d.id)
                         + (select count(*) from site.deviation_event e where e.deviation_id = d.id)
                         + (select count(*) from site.deviation_finding x where x.deviation_id = d.id)
                         + (select count(*) from site.deviation_conclusion c where c.deviation_id = d.id),
    'content', jsonb_build_object(
      'ref', d.ref, 'site_code', d.site_code, 'kind', d.kind, 'title', d.title, 'description', d.description,
      'classification', d.classification, 'risk_rationale', d.risk_rationale, 'raised_by', d.raised_by_person,
      'raised_at', site.utc_text(d.raised_at),
      'links', (select coalesce(jsonb_agg(jsonb_build_object('subject_kind', l.subject_kind, 'subject_id', l.subject_id, 'subject_ref', l.subject_ref,
                                                             'batch_number', l.batch_number, 'edition', l.edition)
                                          order by l.linked_at, l.id), '[]'::jsonb)
                from site.deviation_link l where l.deviation_id = d.id),
      'events', (select coalesce(jsonb_agg(jsonb_build_object('event', e.event, 'reason', e.reason, 'by', e.person_id) order by e.recorded_at, e.id), '[]'::jsonb)
                 from site.deviation_event e where e.deviation_id = d.id),
      'finding', case when f.id is null then null
                      else jsonb_build_object('id', f.id, 'assignable_cause', f.assignable_cause, 'cause', f.cause,
                                              'root_cause_category', f.root_cause_category, 'recorded_by', f.recorded_by_person) end,
      'conclusion', (select jsonb_build_object('finding_id', c.finding_id, 'assignable_cause', c.assignable_cause, 'cause', c.cause,
                                               'root_cause_category', c.root_cause_category, 'concluded_by', c.concluded_by_person)
                     from site.deviation_conclusion c where c.deviation_id = d.id)),
    'state', site.deviation_state(d.id),
    'scope', jsonb_build_object('site', d.site_code),
    'entered_by', (select to_jsonb(array_agg(distinct p)) from (
                     select d.raised_by_person as p
                     union all select x.recorded_by_person from site.deviation_finding x where x.deviation_id = d.id) y));
end
$$;

select esig.register_content_provider('deviation', 'site.deviation_content(text)',
  'Deviation-lite record: reference, kind, classification and risk rationale, links, life-cycle events, the finding and the conclusion');
select esig.register_signed_table('site.deviation_finding', 'deviation', 'deviation_id');

-- ---------------------------------------------------------------------------------------------
-- Permissions and signature meanings (DI-17, DI-35)
-- ---------------------------------------------------------------------------------------------

select kernel.set_actor_context(jsonb_build_object(
  'person_id', '00000000-0000-0000-0000-000000000000', 'account_id', '00000000-0000-0000-0000-000000000000',
  'role_code', 'SOFTWARE_RELEASE', 'session_id', '00000000-0000-0000-0000-000000000000', 'source', 'SYSTEM',
  'site_zone', 'UTC', 'correlation_id', gen_random_uuid(),
  'legal_name', 'Software release (site-services migration 0730_deviation_lite)',
  'reason_code', 'SOFTWARE_RELEASE',
  'reason_text', 'deviation-lite permissions and signature meanings (PR-49, PR-50, IN-20; slice 5a D-S5-1)'));

insert into iam.permission (code, domain, effect, description) values
  ('DEVIATION.RAISE', 'GMP', 'WRITE', 'Raise a deviation, OOS or investigation record and link it to the batches, lots and containers it concerns'),
  ('DEVIATION.INVESTIGATE', 'GMP', 'WRITE', 'Start the investigation of a deviation-lite record and record its finding (assignable cause, cause, root-cause category)'),
  ('DEVIATION.QA_APPROVE', 'GMP', 'SIGN', 'QA conclusion, closure and cancellation of a deviation-lite record (never by its initiator)');

insert into iam.role_permission (role_code, permission_code) values
  ('OPERATOR', 'DEVIATION.RAISE'),
  ('VERIFIER', 'DEVIATION.RAISE'),
  ('DISPENSER', 'DEVIATION.RAISE'),
  ('SHIFT_SUPERVISOR', 'DEVIATION.RAISE'),
  ('STAGE_RESPONSIBLE', 'DEVIATION.RAISE'),
  ('HEAD_OF_PRODUCTION', 'DEVIATION.RAISE'),
  ('WAREHOUSE_LABELLING', 'DEVIATION.RAISE'),
  ('QA_SHOP_FLOOR', 'DEVIATION.RAISE'),
  ('QA_REVIEWER', 'DEVIATION.RAISE'),
  ('QC_ANALYST', 'DEVIATION.RAISE'),
  ('HEAD_OF_QC', 'DEVIATION.RAISE'),
  ('QA_SHOP_FLOOR', 'DEVIATION.INVESTIGATE'),
  ('QA_REVIEWER', 'DEVIATION.INVESTIGATE'),
  ('HEAD_OF_QC', 'DEVIATION.INVESTIGATE'),
  ('QA_REVIEWER', 'DEVIATION.QA_APPROVE'),
  ('AUTHORISED_PERSON', 'DEVIATION.QA_APPROVE');

insert into esig.meaning_type (code, version, origin, is_minimum, status, category, role_class, title, meaning_text, permissions,
                               independent_of, excludes_performers, excludes_involved, witness, reauth, delegable, sources)
values
  ('DEVIATION_CONCLUDED', 1, 'VENDOR', true, 'ACTIVE', 'EXCEPTION', 'APPROVER', 'Deviation investigation concluded by QA',
   'Quality-unit conclusion: I approve the finding of this investigation (assignable cause, cause and root-cause category) as recorded.',
   array['DEVIATION.QA_APPROVE'], '{}', true, false, false, 'ALL_COMPONENTS', false, 'Outline 5.2.5 (lite); PR-49, PR-50, IN-20; outline 7.2 S7'),
  ('DEVIATION_CLOSED', 1, 'VENDOR', true, 'ACTIVE', 'EXCEPTION', 'APPROVER', 'Deviation closed by QA',
   'Quality-unit closure: this deviation record is complete and closed on the conclusion recorded.',
   array['DEVIATION.QA_APPROVE'], '{}', true, false, false, 'ALL_COMPONENTS', false, 'Outline 5.2.5 (lite); PR-50, IN-20; outline 7.2 S7');

select kernel.set_actor_context(null);

-- ---------------------------------------------------------------------------------------------
-- Commands
-- ---------------------------------------------------------------------------------------------

create function site.lock_deviation(p_id uuid) returns site.deviation
language plpgsql volatile security definer set search_path = pg_catalog, site, pg_temp as $$
declare
  d site.deviation;
begin
  select * into d from site.deviation where id = p_id for update;
  if not found then
    raise exception using errcode = 'P0001', message = format('EBMR-SITE-302 unknown deviation-lite record %s', p_id);
  end if;
  return d;
end
$$;

-- p: {kind, title, description?, classification, riskRationale}. The reference is generated here, never typed: per
-- site and year (in the site's zone), serial under a transaction lock.
create function site.raise_deviation(p jsonb) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, site, iam, kernel, pg_temp as $$
declare
  v_ctx    jsonb := site.require_actor();
  v_site   text;
  v_year   integer;
  v_serial integer;
  v_id     uuid := gen_random_uuid();
  v_ref    text;
begin
  perform iam.assert_not_administrator();
  if p is null or jsonb_typeof(p) <> 'object' then
    raise exception using errcode = 'P0001', message = 'EBMR-SITE-301 the deviation details are required';
  end if;
  v_site := site.actor_site();
  perform iam.require_permission('DEVIATION.RAISE', jsonb_build_object('site', v_site));
  if coalesce(p ->> 'kind', '') not in ('DEVIATION', 'OOS', 'INVESTIGATION') then
    raise exception using errcode = 'P0001', message = 'EBMR-SITE-301 the kind is DEVIATION, OOS or INVESTIGATION (PR-49)';
  end if;
  if coalesce(p ->> 'classification', '') not in ('MINOR', 'MAJOR', 'CRITICAL') or length(btrim(coalesce(p ->> 'riskRationale', ''))) < 10 then
    raise exception using errcode = 'P0001',
      message = 'EBMR-SITE-301 a deviation is classified MINOR, MAJOR or CRITICAL with the person''s risk rationale (at least 10 characters) (PR-49)';
  end if;
  if btrim(coalesce(p ->> 'title', '')) = '' then
    raise exception using errcode = 'P0001', message = 'EBMR-SITE-301 a deviation has a title (PR-49)';
  end if;
  v_year := to_char(clock_timestamp() at time zone coalesce(nullif(v_ctx ->> 'site_zone', ''), 'UTC'), 'YYYY')::integer;
  perform pg_advisory_xact_lock(hashtext('site.deviation_ref'), hashtext(v_site || '/' || v_year::text));
  select coalesce(max(d.ref_serial), 0) + 1 into v_serial from site.deviation d where d.site_code = v_site and d.ref_year = v_year;
  v_ref := format('%sDEV-%s-%s-%s', case when kernel.installation_kind() = 'SANDBOX' then 'TEST-' else '' end, v_site, v_year, lpad(v_serial::text, 5, '0'));
  insert into site.deviation (id, ref, site_code, ref_year, ref_serial, kind, title, description, classification, risk_rationale,
                              raised_by_person, raised_by_account, correlation_id)
  values (v_id, v_ref, v_site, v_year, v_serial, p ->> 'kind', btrim(p ->> 'title'), nullif(btrim(coalesce(p ->> 'description', '')), ''),
          p ->> 'classification', btrim(p ->> 'riskRationale'), (v_ctx ->> 'person_id')::uuid, (v_ctx ->> 'account_id')::uuid,
          (v_ctx ->> 'correlation_id')::uuid);
  return jsonb_build_object('deviationId', v_id, 'ref', v_ref, 'state', 'OPEN');
end
$$;

-- Links a subject: a LOT of the record's site, or a GMP BATCH or output CONTAINER the batch side names at that site.
create function site.link_deviation(p_deviation uuid, p_subject_kind text, p_subject_id uuid) returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, site, iam, pg_temp as $$
declare
  v_ctx  jsonb := site.require_actor();
  d      site.deviation;
  l      site.material_lot;
  v_subj jsonb;
  v_id   uuid;
begin
  perform iam.assert_not_administrator();
  d := site.lock_deviation(p_deviation);
  perform iam.require_permission('DEVIATION.RAISE', jsonb_build_object('site', d.site_code));
  if site.deviation_state(d.id) in ('CLOSED', 'CANCELLED') then
    raise exception using errcode = 'P0001', message = format('EBMR-SITE-303 %s is %s; nothing more is linked to it (PR-49)', d.ref, site.deviation_state(d.id));
  end if;
  if p_subject_kind = 'LOT' then
    select * into l from site.material_lot where id = p_subject_id;
    if not found or l.site_code <> d.site_code then
      raise exception using errcode = 'P0001', message = format('EBMR-SITE-304 no material lot %s at site %s (PR-49)', p_subject_id, d.site_code);
    end if;
    v_subj := jsonb_build_object('ref', l.lot_code);
  elsif p_subject_kind in ('BATCH', 'CONTAINER') then
    v_subj := site.subject_identity(p_subject_kind, p_subject_id);
    if v_subj is null or v_subj ->> 'siteCode' is distinct from d.site_code then
      raise exception using errcode = 'P0001',
        message = format('EBMR-SITE-304 %s %s is not a GMP %s of site %s (PR-49; D-S5-2)', lower(p_subject_kind), p_subject_id, lower(p_subject_kind), d.site_code);
    end if;
  else
    raise exception using errcode = 'P0001', message = format('EBMR-SITE-304 %s is not a subject kind: BATCH, LOT or CONTAINER', coalesce(p_subject_kind, 'NULL'));
  end if;
  if exists (select 1 from site.deviation_link x where x.deviation_id = d.id and x.subject_kind = p_subject_kind and x.subject_id = p_subject_id) then
    raise exception using errcode = 'P0001', message = format('EBMR-SITE-303 %s is already linked to that %s', d.ref, lower(p_subject_kind));
  end if;
  insert into site.deviation_link (deviation_id, subject_kind, subject_id, subject_ref, batch_id, batch_number, edition, linked_by_person, linked_by_account)
  values (d.id, p_subject_kind, p_subject_id, coalesce(v_subj ->> 'ref', v_subj ->> 'batchNumber'),
          (v_subj ->> 'batchId')::uuid, v_subj ->> 'batchNumber', v_subj ->> 'edition',
          (v_ctx ->> 'person_id')::uuid, (v_ctx ->> 'account_id')::uuid)
  returning id into v_id;
  return v_id;
end
$$;

create function site.start_deviation_investigation(p_deviation uuid) returns void
language plpgsql volatile security definer set search_path = pg_catalog, site, iam, pg_temp as $$
declare
  v_ctx jsonb := site.require_actor();
  d     site.deviation;
begin
  perform iam.assert_not_administrator();
  d := site.lock_deviation(p_deviation);
  perform iam.require_permission('DEVIATION.INVESTIGATE', jsonb_build_object('site', d.site_code));
  if site.deviation_state(d.id) <> 'OPEN' then
    raise exception using errcode = 'P0001',
      message = format('EBMR-SITE-305 %s is %s; only an OPEN record moves to UNDER_INVESTIGATION (IN-20)', d.ref, site.deviation_state(d.id));
  end if;
  insert into site.deviation_event (deviation_id, event, person_id, account_id)
  values (d.id, 'INVESTIGATION_STARTED', (v_ctx ->> 'person_id')::uuid, (v_ctx ->> 'account_id')::uuid);
end
$$;

-- p: {assignableCause (boolean), cause, rootCauseCategory}. A new finding supersedes the earlier one and every
-- signature given before it.
create function site.record_deviation_finding(p_deviation uuid, p jsonb) returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, site, iam, pg_temp as $$
declare
  v_ctx jsonb := site.require_actor();
  d     site.deviation;
  v_id  uuid;
begin
  perform iam.assert_not_administrator();
  d := site.lock_deviation(p_deviation);
  perform iam.require_permission('DEVIATION.INVESTIGATE', jsonb_build_object('site', d.site_code));
  if site.deviation_state(d.id) <> 'UNDER_INVESTIGATION' then
    raise exception using errcode = 'P0001',
      message = format('EBMR-SITE-306 %s is %s; a finding is recorded while it is UNDER_INVESTIGATION (IN-20)', d.ref, site.deviation_state(d.id));
  end if;
  if p is null or jsonb_typeof(p -> 'assignableCause') is distinct from 'boolean' or length(btrim(coalesce(p ->> 'cause', ''))) < 10
     or coalesce(p ->> 'rootCauseCategory', '') not in ('HUMAN_ERROR', 'EQUIPMENT', 'MATERIAL', 'METHOD', 'ENVIRONMENT', 'PROCESS', 'LABORATORY_ERROR', 'NOT_DETERMINED')
     or ((p -> 'assignableCause') = 'true'::jsonb and p ->> 'rootCauseCategory' = 'NOT_DETERMINED') then
    raise exception using errcode = 'P0001',
      message = 'EBMR-SITE-306 a finding states whether a cause was assigned, the cause (at least 10 characters) and its root-cause category (NOT_DETERMINED only without an assignable cause) (IN-20)';
  end if;
  insert into site.deviation_finding (deviation_id, assignable_cause, cause, root_cause_category, recorded_by_person, recorded_by_account)
  values (d.id, (p ->> 'assignableCause')::boolean, btrim(p ->> 'cause'), p ->> 'rootCauseCategory', (v_ctx ->> 'person_id')::uuid, (v_ctx ->> 'account_id')::uuid)
  returning id into v_id;
  return v_id;
end
$$;

-- The QA signer of a record decision: the actor, holding a valid signature of p_meaning on the record in its current
-- state, and not the initiator (S7).
create function site.assert_deviation_qa_signature(d site.deviation, p_signature uuid, p_meaning text) returns void
language plpgsql volatile security definer set search_path = pg_catalog, site, esig, pg_temp as $$
declare
  v_ctx  jsonb := site.require_actor();
  v_prob text;
begin
  perform esig.assert_signature(p_signature, p_meaning, 'deviation', d.id::text);
  v_prob := esig.signature_state_problem(p_signature);
  if v_prob is not null then
    raise exception using errcode = 'P0001', message = 'EBMR-SITE-308 ' || v_prob;
  end if;
  if (select s.signer_person from esig.signature s where s.id = p_signature)::text is distinct from v_ctx ->> 'person_id' then
    raise exception using errcode = 'P0001', message = format('EBMR-SITE-308 %s is recorded by the QA person who signed it', p_meaning);
  end if;
  if d.raised_by_person::text = v_ctx ->> 'person_id' then
    raise exception using errcode = 'P0001',
      message = format('EBMR-SITE-307 %s was raised by this person; its conclusion, closure and cancellation are by QA other than the initiator (PR-50; outline 7.2 S7)', d.ref);
  end if;
end
$$;

create function site.conclude_deviation(p_deviation uuid, p_signature uuid) returns void
language plpgsql volatile security definer set search_path = pg_catalog, site, iam, pg_temp as $$
declare
  v_ctx jsonb := site.require_actor();
  d     site.deviation;
  f     site.deviation_finding;
begin
  perform iam.assert_not_administrator();
  d := site.lock_deviation(p_deviation);
  perform iam.require_permission('DEVIATION.QA_APPROVE', jsonb_build_object('site', d.site_code));
  if site.deviation_state(d.id) <> 'UNDER_INVESTIGATION' then
    raise exception using errcode = 'P0001',
      message = format('EBMR-SITE-309 %s is %s; QA concludes a record UNDER_INVESTIGATION (IN-20)', d.ref, site.deviation_state(d.id));
  end if;
  f := site.deviation_latest_finding(d.id);
  if f.id is null then
    raise exception using errcode = 'P0001', message = format('EBMR-SITE-309 %s has no finding to conclude (IN-20)', d.ref);
  end if;
  perform site.assert_deviation_qa_signature(d, p_signature, 'DEVIATION_CONCLUDED');
  insert into site.deviation_conclusion (deviation_id, finding_id, assignable_cause, cause, root_cause_category, signature_id, concluded_by_person, concluded_by_account)
  values (d.id, f.id, f.assignable_cause, f.cause, f.root_cause_category, p_signature, (v_ctx ->> 'person_id')::uuid, (v_ctx ->> 'account_id')::uuid);
end
$$;

create function site.close_deviation(p_deviation uuid, p_signature uuid) returns void
language plpgsql volatile security definer set search_path = pg_catalog, site, iam, pg_temp as $$
declare
  v_ctx jsonb := site.require_actor();
  d     site.deviation;
begin
  perform iam.assert_not_administrator();
  d := site.lock_deviation(p_deviation);
  perform iam.require_permission('DEVIATION.QA_APPROVE', jsonb_build_object('site', d.site_code));
  if site.deviation_state(d.id) <> 'CONCLUDED' then
    raise exception using errcode = 'P0001',
      message = format('EBMR-SITE-310 %s is %s; QA closes a CONCLUDED record (IN-20)', d.ref, site.deviation_state(d.id));
  end if;
  perform site.assert_deviation_qa_signature(d, p_signature, 'DEVIATION_CLOSED');
  insert into site.deviation_event (deviation_id, event, signature_id, person_id, account_id)
  values (d.id, 'CLOSED', p_signature, (v_ctx ->> 'person_id')::uuid, (v_ctx ->> 'account_id')::uuid);
end
$$;

create function site.cancel_deviation(p_deviation uuid, p_reason text) returns void
language plpgsql volatile security definer set search_path = pg_catalog, site, iam, pg_temp as $$
declare
  v_ctx jsonb := site.require_actor();
  d     site.deviation;
begin
  perform iam.assert_not_administrator();
  d := site.lock_deviation(p_deviation);
  perform iam.require_permission('DEVIATION.QA_APPROVE', jsonb_build_object('site', d.site_code));
  if site.deviation_state(d.id) not in ('OPEN', 'UNDER_INVESTIGATION') then
    raise exception using errcode = 'P0001',
      message = format('EBMR-SITE-311 %s is %s; only an OPEN record or one UNDER_INVESTIGATION is cancelled (D-S5-1)', d.ref, site.deviation_state(d.id));
  end if;
  if d.raised_by_person::text = v_ctx ->> 'person_id' then
    raise exception using errcode = 'P0001',
      message = format('EBMR-SITE-307 %s was raised by this person; its conclusion, closure and cancellation are by QA other than the initiator (PR-50; outline 7.2 S7)', d.ref);
  end if;
  if btrim(coalesce(p_reason, '')) = '' then
    raise exception using errcode = 'P0001', message = 'EBMR-SITE-311 cancelling a deviation-lite record states the person''s own reason (DI-22)';
  end if;
  insert into site.deviation_event (deviation_id, event, reason, person_id, account_id)
  values (d.id, 'CANCELLED', btrim(p_reason), (v_ctx ->> 'person_id')::uuid, (v_ctx ->> 'account_id')::uuid);
end
$$;

-- ---------------------------------------------------------------------------------------------
-- The reference check (D-S2-2; backlog slice 2 #1b): NULL = the GMP batch p_batch may cite p_ref for p_use
-- ---------------------------------------------------------------------------------------------

create function site.deviation_ref_problem(p_ref text, p_use text, p_batch uuid) returns text
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
    if p_use = 'INVALIDATION' and not c.assignable_cause then
      return format('%s was concluded without an assignable cause; a result is invalidated only on a concluded assignable cause (IN-20; DI-24)', d.ref);
    end if;
  end if;
  return null;
end
$$;

-- ---------------------------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------------------------

revoke all on site.deviation, site.deviation_link, site.deviation_event, site.deviation_finding, site.deviation_conclusion, site.subject_resolver from ebmr_app;
grant select on site.deviation, site.deviation_link, site.deviation_event, site.deviation_finding, site.deviation_conclusion to ebmr_app;
grant execute on function site.raise_deviation(jsonb), site.link_deviation(uuid, text, uuid), site.start_deviation_investigation(uuid),
                          site.record_deviation_finding(uuid, jsonb), site.conclude_deviation(uuid, uuid), site.close_deviation(uuid, uuid),
                          site.cancel_deviation(uuid, text), site.deviation_state(uuid), site.deviation_ref_problem(text, text, uuid) to ebmr_app;
-- site.register_subject_resolver, site.subject_identity, the locks, the content provider and the signature check stay
-- private to the owner.

reset role;
