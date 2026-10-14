-- Phase 6 slice 6a (builder B): the CAPA register (stand-in) and the QMS mirror (IN-01 (d), PR-51, DI-31; D-P6a-3,
-- D-P6a-5, D-P6a-6; plan docs/build-plan/phase-6/phase-6-plan.md "Slice 6a").
--
-- Handbook: modules/site-services.md
--
-- The CAPA stand-in (QMS_STATUS in STAND_IN, decision 0001 item 11: the built-in register is authoritative):
--   capa                       one CAPA (insert-only): reference CAPA-<site>-<yyyy>-<nnnnn> (TEST-... in a sandbox, DI-05)
--                              generated, never typed; title, description, its source (DEVIATION, OOS, COMPLAINT, PQR,
--                              SELF_INSPECTION, MANAGEMENT_REVIEW) with the source's reference, its owner (a person),
--                              its due date, and whether it needs a master change. Origin STAND_IN or QMS (a mirror row).
--   capa_deviation             a deviation-lite record the CAPA is linked to (both directions: a deviation lists its
--                              CAPAs, a CAPA its deviations and through them the batches; PR-51).
--   capa_master_version        the MBR version a CAPA that needs a master change waits for (the version id; recipe-core
--                              resolves it through the registered hook, site services never reads recipe tables).
--   capa_effectiveness_check   an effectiveness check: what is measured and after how many days; the due date is
--                              computed in the database (the site's date of scheduling plus the period, a generated
--                              column), never typed (IN-01 (d)).
--   capa_effectiveness_result  the check's result (effective or not, with the evidence), by a person.
--   capa_event                 IMPLEMENTED (with what was done), CLOSED (QA signature CAPA_CLOSED, never by the person who
--                              raised it), CANCELLED (QA, the person's own reason): one row each, insert-only.
--   site.capa_state(id)        OPEN -> IMPLEMENTED -> CLOSED; OPEN or IMPLEMENTED -> CANCELLED (derived; a QMS mirror row
--                              has the QMS's latest status).
--   site.capa_check_status(check, on)  DONE, OPEN or OVERDUE on a date (default the site's date today): a 90-day check
--                              scheduled on day 0 is due on day 90 and OVERDUE from day 91.
--   site.close_capa(capa, signature)  refused while: not IMPLEMENTED; an effectiveness check has no result or was not
--                              effective; it needs a master change and names no master version, or a named version is
--                              not effective yet (recipe-core 0952 registers the resolver; without one it fails closed).
--
-- The QMS mirror (QMS_STATUS in MIRROR; D-P6a-6: with a QMS integrated the CAPA rows are mirrors with a version token):
--   site.receive_qms_capa(envelope), site.receive_qms_deviation_status(envelope), site.receive_qms_change_control(envelope)
--                              the QMS adapter's receiving commands: platform.accept_inbound_detail (kernel 1180) and, when
--                              ACCEPTED, the payload applied in the same transaction (whole or not at all). A late state
--                              (older QMS timestamp than one already applied for the same record) is refused STALE; a
--                              deviation naming a lot this installation does not hold is refused WRONG_IDENTITY.
--   qms_capa_state, qms_deviation_status, qms_change_control  insert-only histories, each row with its version token and
--                              its message (source system, record id, timestamp: DI-31).
--   The stand-in commands are refused in MIRROR (the modes never mix, D-P6a-5), and the QMS commands in STAND_IN.
--
-- The QMS status at release (D-P6a-3, D-P6a-0-11): in MIRROR the release act fetches the lot's QMS status live with its
-- version tokens inside the signing transaction (the server's QMS client) and records the answer here:
--   site.record_qms_release_fetch(lot, deviations jsonb)  the answer of the live fetch; refused (EBMR-QMS-011) when it
--                              differs from the mirror the signer evaluated (a changed or stale version token): the signer
--                              evaluates again.
--   site.qms_release_problem(lot)  NULL in STAND_IN; in MIRROR why the lot cannot be released now: no live fetch in this
--                              transaction, a fetch older than the QMS_STATUS bound (60 s, a backstop), or an open QMS
--                              deviation naming the lot. Recipe-core 0951 calls it from the release decisions.
--
-- Privileges: ebmr_app reads; every write is a SECURITY DEFINER command. Permissions CAPA.RECORD (WRITE) and
-- CAPA.QA_APPROVE (SIGN); meaning CAPA_CLOSED. Messages: EBMR-CAPA-001 to 019, EBMR-QMS-001 to 019.

set local role ebmr_owner;

-- ---------------------------------------------------------------------------------------------
-- The master-version resolver (extension point; recipe-core registers it)
-- ---------------------------------------------------------------------------------------------

create table site.capa_master_resolver (
  singleton      boolean primary key default true check (singleton),
  function_name  text not null check (function_name ~ '^[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*\(uuid\)$'),
  registered_at  timestamptz not null default clock_timestamp()
);
revoke all on site.capa_master_resolver from public;

-- Owner only: fn(version uuid) returns jsonb {exists, effective, label, problem}.
create function site.register_capa_master_resolver(p_function regprocedure) returns void
language plpgsql volatile security definer set search_path = pg_catalog, site, pg_temp as $$
begin
  if not exists (select 1 from pg_proc p where p.oid = p_function and oidvectortypes(p.proargtypes) = 'uuid' and p.prorettype = 'jsonb'::regtype) then
    raise exception using errcode = 'P0001', message = format('EBMR-CAPA-001 the CAPA master resolver %s must have the signature (uuid) returns jsonb', p_function);
  end if;
  insert into site.capa_master_resolver (function_name) values (p_function::text)
  on conflict (singleton) do update set function_name = excluded.function_name, registered_at = clock_timestamp();
end
$$;
revoke all on function site.register_capa_master_resolver(regprocedure) from public;

-- {exists, effective, label, problem} of an MBR version; fails closed without a resolver.
create function site.capa_master_version_facts(p_version uuid) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, site, pg_temp as $$
declare
  v_fn  text;
  v_out jsonb;
begin
  select function_name into v_fn from site.capa_master_resolver;
  if v_fn is null then
    return jsonb_build_object('exists', false, 'effective', false, 'label', null,
                              'problem', 'no master-version resolver is registered, so no master version can be checked (fails closed)');
  end if;
  execute format('select %s($1)', regexp_replace(v_fn, '\(uuid\)$', '')) into v_out using p_version;
  return coalesce(v_out, jsonb_build_object('exists', false, 'effective', false, 'label', null, 'problem', 'the resolver gave no answer'));
end
$$;

-- ---------------------------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------------------------

create table site.capa (
  id                   uuid primary key,
  ref                  text not null unique check (ref ~ '^((TEST-)?CAPA-[A-Z0-9][A-Z0-9-]{0,15}-[0-9]{4}-[0-9]{5,}|QMS:[\x21-\x7E]{1,64})$'),
  origin               text not null check (origin in ('STAND_IN', 'QMS')),
  site_code            text not null check (site_code ~ '^[A-Z0-9][A-Z0-9-]{0,15}$'),
  ref_year             integer check (ref_year between 2000 and 9999),
  ref_serial           integer check (ref_serial >= 1),
  qms_ref              text unique check (qms_ref is null or qms_ref ~ '^[\x21-\x7E]{1,64}$'),
  title                text not null check (btrim(title) <> '' and length(title) <= 500),
  description          text check (description is null or btrim(description) <> ''),
  source_kind          text check (source_kind in ('DEVIATION', 'OOS', 'COMPLAINT', 'PQR', 'SELF_INSPECTION', 'MANAGEMENT_REVIEW')),
  source_ref           text check (source_ref is null or (btrim(source_ref) <> '' and length(source_ref) <= 128)),
  owner_person         uuid,
  due_on               date,
  needs_master_change  boolean not null,
  raised_by_person     uuid not null,
  raised_by_account    uuid not null,
  raised_at            timestamptz not null default clock_timestamp(),
  correlation_id       uuid not null,
  unique (site_code, ref_year, ref_serial),
  -- A stand-in CAPA has its source, owner and due date (IN-01 (d)); a mirror row carries the QMS's reference.
  check ((origin = 'STAND_IN') = (ref_year is not null and ref_serial is not null and source_kind is not null and source_ref is not null
                                  and owner_person is not null and due_on is not null and qms_ref is null)),
  check ((origin = 'QMS') = (qms_ref is not null))
);
revoke all on site.capa from public;

create table site.capa_deviation (
  capa_id            uuid not null references site.capa (id),
  deviation_id       uuid not null references site.deviation (id),
  linked_by_person   uuid not null,
  linked_by_account  uuid not null,
  linked_at          timestamptz not null default clock_timestamp(),
  primary key (capa_id, deviation_id)
);
create index capa_deviation_by_deviation on site.capa_deviation (deviation_id);
revoke all on site.capa_deviation from public;

create table site.capa_master_version (
  capa_id            uuid not null references site.capa (id),
  version_id         uuid not null,
  version_label      text not null check (btrim(version_label) <> ''),
  linked_by_person   uuid not null,
  linked_by_account  uuid not null,
  linked_at          timestamptz not null default clock_timestamp(),
  primary key (capa_id, version_id)
);
revoke all on site.capa_master_version from public;

create table site.capa_effectiveness_check (
  id                    uuid primary key default gen_random_uuid(),
  capa_id               uuid not null references site.capa (id),
  criteria              text not null check (btrim(criteria) <> '' and length(criteria) <= 2000),
  period_days           integer not null check (period_days between 1 and 1095),
  scheduled_on          date not null,
  due_on                date not null generated always as (scheduled_on + period_days) stored,
  scheduled_by_person   uuid not null,
  scheduled_by_account  uuid not null,
  scheduled_at          timestamptz not null default clock_timestamp()
);
create index capa_effectiveness_check_by_capa on site.capa_effectiveness_check (capa_id);
revoke all on site.capa_effectiveness_check from public;

create table site.capa_effectiveness_result (
  check_id             uuid primary key references site.capa_effectiveness_check (id),
  capa_id              uuid not null references site.capa (id),
  effective            boolean not null,
  evidence             text not null check (btrim(evidence) <> '' and length(evidence) <= 4000),
  recorded_by_person   uuid not null,
  recorded_by_account  uuid not null,
  recorded_at          timestamptz not null default clock_timestamp()
);
revoke all on site.capa_effectiveness_result from public;

create table site.capa_event (
  id            uuid primary key default gen_random_uuid(),
  capa_id       uuid not null references site.capa (id),
  event         text not null check (event in ('IMPLEMENTED', 'CLOSED', 'CANCELLED')),
  note          text check (note is null or (btrim(note) <> '' and length(note) <= 4000)),
  signature_id  uuid unique,
  person_id     uuid not null,
  account_id    uuid not null,
  recorded_at   timestamptz not null default clock_timestamp(),
  unique (capa_id, event),
  check ((event = 'CLOSED') = (signature_id is not null)),
  check (event = 'CLOSED' or note is not null)
);
revoke all on site.capa_event from public;

-- The QMS histories (mirror rows). The message id ties each row to its received envelope (DI-31).
create table site.qms_capa_state (
  id                    uuid primary key default gen_random_uuid(),
  capa_id               uuid not null references site.capa (id),
  message_id            uuid not null unique references platform.inbound_message (id),
  source_timestamp      timestamptz not null,
  status                text not null check (status in ('OPEN', 'IMPLEMENTED', 'EFFECTIVENESS_CHECK', 'CLOSED', 'CANCELLED')),
  title                 text not null,
  needs_master_change   boolean not null,
  effectiveness_due_on  date,
  version_token         text not null check (version_token ~ '^[\x21-\x7E]{1,64}$'),
  received_at           timestamptz not null default clock_timestamp()
);
create index qms_capa_state_by_capa on site.qms_capa_state (capa_id, source_timestamp);
revoke all on site.qms_capa_state from public;

create table site.qms_deviation_status (
  id                uuid primary key default gen_random_uuid(),
  deviation_ref     text not null check (deviation_ref ~ '^[\x21-\x7E]{1,64}$'),
  message_id        uuid not null unique references platform.inbound_message (id),
  source_timestamp  timestamptz not null,
  status            text not null check (status in ('OPEN', 'UNDER_INVESTIGATION', 'CLOSED', 'CANCELLED')),
  lot_codes         text[] not null,
  lot_ids           uuid[] not null,
  version_token     text not null check (version_token ~ '^[\x21-\x7E]{1,64}$'),
  received_at       timestamptz not null default clock_timestamp()
);
create index qms_deviation_status_by_ref on site.qms_deviation_status (deviation_ref, source_timestamp);
create index qms_deviation_status_by_lot on site.qms_deviation_status using gin (lot_ids);
revoke all on site.qms_deviation_status from public;

create table site.qms_change_control (
  id                uuid primary key default gen_random_uuid(),
  change_ref        text not null check (change_ref ~ '^[\x21-\x7E]{1,64}$'),
  message_id        uuid not null unique references platform.inbound_message (id),
  source_timestamp  timestamptz not null,
  status            text not null check (status in ('OPEN', 'APPROVED', 'IMPLEMENTED', 'CLOSED', 'REJECTED')),
  version_token     text not null check (version_token ~ '^[\x21-\x7E]{1,64}$'),
  received_at       timestamptz not null default clock_timestamp()
);
create index qms_change_control_by_ref on site.qms_change_control (change_ref, source_timestamp);
revoke all on site.qms_change_control from public;

-- The live QMS answers fetched inside release signing transactions (D-P6a-3).
create table site.qms_release_fetch (
  id           uuid primary key default gen_random_uuid(),
  lot_id       uuid not null references site.material_lot (id),
  deviations   jsonb not null check (jsonb_typeof(deviations) = 'array'),
  open_count   integer not null check (open_count >= 0),
  xact_id      xid8 not null default pg_current_xact_id(),
  person_id    uuid not null,
  account_id   uuid not null,
  fetched_at   timestamptz not null default clock_timestamp()
);
create index qms_release_fetch_by_lot on site.qms_release_fetch (lot_id, fetched_at);
revoke all on site.qms_release_fetch from public;

select platform.enforce_db_time('site.capa_master_resolver', array['registered_at']);
select platform.enforce_db_time('site.capa', array['raised_at']);
select platform.enforce_db_time('site.capa_deviation', array['linked_at']);
select platform.enforce_db_time('site.capa_master_version', array['linked_at']);
select platform.enforce_db_time('site.capa_effectiveness_check', array['scheduled_at']);
select platform.enforce_db_time('site.capa_effectiveness_result', array['recorded_at']);
select platform.enforce_db_time('site.capa_event', array['recorded_at']);
select platform.enforce_db_time('site.qms_capa_state', array['received_at']);
select platform.enforce_db_time('site.qms_deviation_status', array['received_at']);
select platform.enforce_db_time('site.qms_change_control', array['received_at']);
select platform.enforce_db_time('site.qms_release_fetch', array['fetched_at']);
select kernel.register_audited_table('site.capa_master_resolver', 'capa_master_resolver', 'function_name', false);
select kernel.register_audited_table('site.capa', 'capa', 'id', true);
select kernel.register_audited_table('site.capa_deviation', 'capa', 'capa_id', true);
select kernel.register_audited_table('site.capa_master_version', 'capa', 'capa_id', true);
select kernel.register_audited_table('site.capa_effectiveness_check', 'capa', 'capa_id', true);
select kernel.register_audited_table('site.capa_effectiveness_result', 'capa_effectiveness_check', 'check_id', true);
select kernel.register_audited_table('site.capa_event', 'capa', 'capa_id', true);
select kernel.register_audited_table('site.qms_capa_state', 'capa', 'capa_id', true);
select kernel.register_audited_table('site.qms_deviation_status', 'qms_deviation', 'deviation_ref', true);
select kernel.register_audited_table('site.qms_change_control', 'qms_change_control', 'change_ref', true);
select kernel.register_audited_table('site.qms_release_fetch', 'material_lot', 'lot_id', true);

-- ---------------------------------------------------------------------------------------------
-- Readers
-- ---------------------------------------------------------------------------------------------

-- The site's calendar date now (the site policy's zone, DI-27).
create function site.site_today() returns date
language sql stable security definer set search_path = pg_catalog, site, iam, pg_temp as $$
  select (clock_timestamp() at time zone iam.policy_text('site.zone'))::date
$$;

create function site.qms_mode() returns text
language sql stable security definer set search_path = pg_catalog, platform, pg_temp as $$
  select platform.setting_text('integration.mode.qms_status')
$$;

create function site.capa_latest_qms_state(p_capa uuid) returns site.qms_capa_state
language sql stable security definer set search_path = pg_catalog, site, pg_temp as $$
  select * from site.qms_capa_state where capa_id = p_capa order by source_timestamp desc, received_at desc limit 1
$$;

create function site.capa_state(p_capa uuid) returns text
language plpgsql stable security definer set search_path = pg_catalog, site, pg_temp as $$
declare
  c site.capa;
begin
  select * into c from site.capa where id = p_capa;
  if not found then
    return null;
  end if;
  if c.origin = 'QMS' then
    return (site.capa_latest_qms_state(c.id)).status;
  end if;
  return case
    when exists (select 1 from site.capa_event e where e.capa_id = c.id and e.event = 'CANCELLED') then 'CANCELLED'
    when exists (select 1 from site.capa_event e where e.capa_id = c.id and e.event = 'CLOSED') then 'CLOSED'
    when exists (select 1 from site.capa_event e where e.capa_id = c.id and e.event = 'IMPLEMENTED') then 'IMPLEMENTED'
    else 'OPEN' end;
end
$$;

-- DONE (a result is recorded), OVERDUE (no result and the date is after the due date) or OPEN, on p_on (default: the
-- site's date today). The due date is the scheduling date plus the period (a generated column).
create function site.capa_check_status(p_check uuid, p_on date default null) returns text
language sql stable security definer set search_path = pg_catalog, site, pg_temp as $$
  select case when exists (select 1 from site.capa_effectiveness_result r where r.check_id = k.id) then 'DONE'
              when coalesce(p_on, site.site_today()) > k.due_on then 'OVERDUE'
              else 'OPEN' end
  from site.capa_effectiveness_check k where k.id = p_check
$$;

-- One CAPA as the register and the detail screen show it (also the signed content of CAPA_CLOSED).
create function site.capa_view(p_capa uuid, p_on date default null) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, site, pg_temp as $$
declare
  c     site.capa;
  q     site.qms_capa_state;
  v_on  date := coalesce(p_on, site.site_today());
begin
  select * into c from site.capa where id = p_capa;
  if not found then
    return null;
  end if;
  q := site.capa_latest_qms_state(c.id);
  return jsonb_build_object(
    'capaId', c.id, 'ref', c.ref, 'origin', c.origin, 'qmsRef', c.qms_ref, 'siteCode', c.site_code, 'title', c.title,
    'description', c.description, 'sourceKind', c.source_kind, 'sourceRef', c.source_ref, 'ownerPersonId', c.owner_person,
    'dueOn', c.due_on, 'needsMasterChange', c.needs_master_change, 'raisedBy', c.raised_by_person, 'raisedAt', site.utc_text(c.raised_at),
    'state', site.capa_state(c.id),
    'overdue', c.due_on is not null and v_on > c.due_on and site.capa_state(c.id) in ('OPEN', 'IMPLEMENTED'),
    'versionToken', q.version_token,
    'qmsEffectivenessDueOn', q.effectiveness_due_on,
    'deviations', (select coalesce(jsonb_agg(jsonb_build_object('deviationId', d.id, 'ref', d.ref, 'state', site.deviation_state(d.id),
                                                                'batches', (select coalesce(jsonb_agg(distinct l.batch_number), '[]'::jsonb)
                                                                            from site.deviation_link l where l.deviation_id = d.id and l.batch_number is not null))
                                              order by d.ref), '[]'::jsonb)
                   from site.capa_deviation x join site.deviation d on d.id = x.deviation_id where x.capa_id = c.id),
    'masterVersions', (select coalesce(jsonb_agg(jsonb_build_object('versionId', m.version_id, 'label', m.version_label,
                                                                    'effective', coalesce((site.capa_master_version_facts(m.version_id) ->> 'effective')::boolean, false))
                                                  order by m.linked_at), '[]'::jsonb)
                       from site.capa_master_version m where m.capa_id = c.id),
    'checks', (select coalesce(jsonb_agg(jsonb_build_object('checkId', k.id, 'criteria', k.criteria, 'periodDays', k.period_days,
                                                            'scheduledOn', k.scheduled_on, 'dueOn', k.due_on, 'status', site.capa_check_status(k.id, v_on),
                                                            'effective', r.effective, 'evidence', r.evidence)
                                          order by k.scheduled_at, k.id), '[]'::jsonb)
               from site.capa_effectiveness_check k left join site.capa_effectiveness_result r on r.check_id = k.id where k.capa_id = c.id),
    'events', (select coalesce(jsonb_agg(jsonb_build_object('event', e.event, 'note', e.note, 'by', e.person_id, 'at', site.utc_text(e.recorded_at))
                                          order by e.recorded_at, e.id), '[]'::jsonb)
               from site.capa_event e where e.capa_id = c.id),
    'qmsHistory', (select coalesce(jsonb_agg(jsonb_build_object('status', s.status, 'versionToken', s.version_token, 'messageId', s.message_id,
                                                                'sourceTimestamp', site.utc_text(s.source_timestamp))
                                              order by s.source_timestamp, s.received_at), '[]'::jsonb)
                   from site.qms_capa_state s where s.capa_id = c.id));
end
$$;

create function site.capa_content(p_id text) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, site, pg_temp as $$
declare
  c site.capa;
  v jsonb;
begin
  if coalesce(p_id, '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return '{"exists": false}'::jsonb;
  end if;
  select * into c from site.capa where id = p_id::uuid;
  if not found then
    return '{"exists": false}'::jsonb;
  end if;
  -- The signed content is fixed by the record's rows, never by today's date.
  v := site.capa_view(c.id, date '2000-01-01') - 'overdue';
  v := jsonb_set(v, '{checks}', (select coalesce(jsonb_agg(x - 'status'), '[]'::jsonb) from jsonb_array_elements(v -> 'checks') x));
  v := jsonb_set(v, '{masterVersions}', (select coalesce(jsonb_agg(x - 'effective'), '[]'::jsonb) from jsonb_array_elements(v -> 'masterVersions') x));
  return jsonb_build_object(
    'exists', true,
    'content_version', 1 + (select count(*) from site.capa_deviation x where x.capa_id = c.id)
                         + (select count(*) from site.capa_master_version x where x.capa_id = c.id)
                         + (select count(*) from site.capa_effectiveness_check x where x.capa_id = c.id)
                         + (select count(*) from site.capa_effectiveness_result r join site.capa_effectiveness_check k on k.id = r.check_id where k.capa_id = c.id)
                         + (select count(*) from site.capa_event e where e.capa_id = c.id),
    'content', v,
    'state', site.capa_state(c.id),
    'scope', jsonb_build_object('site', c.site_code),
    'entered_by', to_jsonb(array[c.raised_by_person]));
end
$$;

-- ---------------------------------------------------------------------------------------------
-- Permissions and the signature meaning
-- ---------------------------------------------------------------------------------------------

select kernel.set_actor_context(jsonb_build_object(
  'person_id', '00000000-0000-0000-0000-000000000000', 'account_id', '00000000-0000-0000-0000-000000000000',
  'role_code', 'SOFTWARE_RELEASE', 'session_id', '00000000-0000-0000-0000-000000000000', 'source', 'SYSTEM',
  'site_zone', 'UTC', 'correlation_id', gen_random_uuid(),
  'legal_name', 'Software release (site-services migration 0925_capa_and_qms_mirror)',
  'reason_code', 'SOFTWARE_RELEASE',
  'reason_text', 'CAPA register permissions, the CAPA_CLOSED meaning and the CAPA master resolver (IN-01, PR-51; Phase 6 slice 6a)'));

insert into iam.permission (code, domain, effect, description) values
  ('CAPA.RECORD', 'GMP', 'WRITE', 'Raise a CAPA, link it to deviations and to the master version it waits for, record its implementation, schedule and record effectiveness checks'),
  ('CAPA.QA_APPROVE', 'GMP', 'SIGN', 'QA closure and cancellation of a CAPA (never by the person who raised it)');

insert into iam.role_permission (role_code, permission_code) values
  ('QA_SHOP_FLOOR', 'CAPA.RECORD'),
  ('QA_REVIEWER', 'CAPA.RECORD'),
  ('HEAD_OF_QC', 'CAPA.RECORD'),
  ('HEAD_OF_PRODUCTION', 'CAPA.RECORD'),
  ('AUTHORISED_PERSON', 'CAPA.RECORD'),
  ('QA_REVIEWER', 'CAPA.QA_APPROVE'),
  ('AUTHORISED_PERSON', 'CAPA.QA_APPROVE');

insert into esig.meaning_type (code, version, origin, is_minimum, status, category, role_class, title, meaning_text, permissions,
                               independent_of, excludes_performers, excludes_involved, witness, reauth, delegable, sources)
values
  ('CAPA_CLOSED', 1, 'VENDOR', true, 'ACTIVE', 'EXCEPTION', 'APPROVER', 'CAPA closed by QA',
   'Quality-unit closure: the actions of this CAPA are implemented, their effectiveness is shown, and any master change it needed is effective.',
   array['CAPA.QA_APPROVE'], '{}', true, false, false, 'ALL_COMPONENTS', false, 'Schedule M Part I (CAPA management); ICH Q10 3.2.2; IN-01 (d), PR-51');

select kernel.set_actor_context(null);

select esig.register_content_provider('capa', 'site.capa_content(text)',
  'A CAPA: reference, source, owner, due date, linked deviations, the master version it waits for, effectiveness checks and results, life-cycle events');
-- A row added to the CAPA after a signature supersedes it (INV-09): a closure is signed over the CAPA as it stands.
select esig.register_signed_table('site.capa_deviation', 'capa', 'capa_id');
select esig.register_signed_table('site.capa_master_version', 'capa', 'capa_id');
select esig.register_signed_table('site.capa_effectiveness_check', 'capa', 'capa_id');
select esig.register_signed_table('site.capa_effectiveness_result', 'capa', 'capa_id');

-- ---------------------------------------------------------------------------------------------
-- Stand-in commands
-- ---------------------------------------------------------------------------------------------

create function site.require_capa_stand_in() returns void
language plpgsql stable security definer set search_path = pg_catalog, site, pg_temp as $$
begin
  if site.qms_mode() <> 'STAND_IN' then
    raise exception using errcode = 'P0001',
      message = 'EBMR-CAPA-002 this site holds CAPAs in its QMS (QMS_STATUS is MIRROR): the CAPA is changed in the QMS and mirrored here (D-P6a-5, D-P6a-6)';
  end if;
end
$$;

create function site.lock_capa(p_capa uuid) returns site.capa
language plpgsql volatile security definer set search_path = pg_catalog, site, pg_temp as $$
declare
  c site.capa;
begin
  select * into c from site.capa where id = p_capa for update;
  if not found then
    raise exception using errcode = 'P0001', message = format('EBMR-CAPA-003 unknown CAPA %s', p_capa);
  end if;
  if c.origin <> 'STAND_IN' then
    raise exception using errcode = 'P0001', message = format('EBMR-CAPA-002 %s is a mirror of the QMS; it is changed in the QMS (D-P6a-6)', c.ref);
  end if;
  return c;
end
$$;

-- p: {title, description?, sourceKind, sourceRef, deviationId?, ownerPersonId, dueOn (YYYY-MM-DD), needsMasterChange,
--     effectivenessCheck: {criteria, periodDays}}. A DEVIATION or OOS source names the deviation-lite record, which is
-- linked at once. The effectiveness check is scheduled today (the site's date).
create function site.raise_capa(p jsonb) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, site, iam, kernel, pg_temp as $$
declare
  v_ctx    jsonb := site.require_actor();
  v_site   text;
  v_year   integer;
  v_serial integer;
  v_id     uuid := gen_random_uuid();
  v_ref    text;
  v_due    date;
  v_days   integer;
  v_dev    site.deviation;
  v_src    text;
  v_check  uuid;
begin
  perform iam.assert_not_administrator();
  perform site.require_capa_stand_in();
  if p is null or jsonb_typeof(p) <> 'object' then
    raise exception using errcode = 'P0001', message = 'EBMR-CAPA-004 the CAPA details are required';
  end if;
  v_site := site.actor_site();
  perform iam.require_permission('CAPA.RECORD', jsonb_build_object('site', v_site));
  if btrim(coalesce(p ->> 'title', '')) = '' then
    raise exception using errcode = 'P0001', message = 'EBMR-CAPA-004 a CAPA has a title';
  end if;
  if coalesce(p ->> 'sourceKind', '') not in ('DEVIATION', 'OOS', 'COMPLAINT', 'PQR', 'SELF_INSPECTION', 'MANAGEMENT_REVIEW') then
    raise exception using errcode = 'P0001',
      message = 'EBMR-CAPA-004 a CAPA names its source: DEVIATION, OOS, COMPLAINT, PQR, SELF_INSPECTION or MANAGEMENT_REVIEW (IN-01 (d))';
  end if;
  if p ->> 'sourceKind' in ('DEVIATION', 'OOS') then
    if coalesce(p ->> 'deviationId', '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      raise exception using errcode = 'P0001', message = 'EBMR-CAPA-004 a CAPA from a deviation or OOS names the deviation record (deviationId) (PR-51)';
    end if;
    select * into v_dev from site.deviation where id = (p ->> 'deviationId')::uuid;
    if v_dev.id is null or v_dev.site_code <> v_site then
      raise exception using errcode = 'P0001', message = format('EBMR-CAPA-005 deviation %s is not a record of site %s', p ->> 'deviationId', v_site);
    end if;
    if (p ->> 'sourceKind' = 'OOS') <> (v_dev.kind = 'OOS') then
      raise exception using errcode = 'P0001', message = format('EBMR-CAPA-005 %s is a %s record, not a %s', v_dev.ref, v_dev.kind, p ->> 'sourceKind');
    end if;
    v_src := v_dev.ref;
  else
    if p ? 'deviationId' then
      raise exception using errcode = 'P0001', message = 'EBMR-CAPA-004 only a DEVIATION or OOS source names a deviation record';
    end if;
    v_src := btrim(coalesce(p ->> 'sourceRef', ''));
    if v_src = '' or length(v_src) > 128 then
      raise exception using errcode = 'P0001', message = 'EBMR-CAPA-004 a CAPA names its source''s reference (the complaint, PQR, self-inspection or review) (IN-01 (d))';
    end if;
  end if;
  if coalesce(p ->> 'ownerPersonId', '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     or not exists (select 1 from iam.person x where x.id = (p ->> 'ownerPersonId')::uuid and x.kind = 'NATURAL' and x.status = 'ACTIVE') then
    raise exception using errcode = 'P0001', message = 'EBMR-CAPA-004 a CAPA has an owner: an active person (IN-01 (d))';
  end if;
  if coalesce(p ->> 'dueOn', '') !~ '^\d{4}-\d{2}-\d{2}$' then
    raise exception using errcode = 'P0001', message = 'EBMR-CAPA-004 a CAPA has a due date (YYYY-MM-DD) (IN-01 (d))';
  end if;
  begin
    v_due := (p ->> 'dueOn')::date;
  exception when others then
    raise exception using errcode = 'P0001', message = format('EBMR-CAPA-004 %s is not a date', p ->> 'dueOn');
  end;
  if v_due < site.site_today() then
    raise exception using errcode = 'P0001', message = format('EBMR-CAPA-004 the due date %s is in the past', v_due);
  end if;
  if jsonb_typeof(p -> 'needsMasterChange') is distinct from 'boolean' then
    raise exception using errcode = 'P0001', message = 'EBMR-CAPA-004 a CAPA states whether it needs a master change (needsMasterChange) (PR-51)';
  end if;
  if jsonb_typeof(p -> 'effectivenessCheck') is distinct from 'object' or btrim(coalesce(p -> 'effectivenessCheck' ->> 'criteria', '')) = ''
     or coalesce(p -> 'effectivenessCheck' ->> 'periodDays', '') !~ '^[1-9][0-9]{0,3}$'
     or (p -> 'effectivenessCheck' ->> 'periodDays')::integer > 1095 then
    raise exception using errcode = 'P0001',
      message = 'EBMR-CAPA-004 a CAPA schedules an effectiveness check: what is measured (criteria) and after how many days (periodDays, 1 to 1095) (IN-01 (d), PR-51)';
  end if;
  v_days := (p -> 'effectivenessCheck' ->> 'periodDays')::integer;
  v_year := extract(year from site.site_today())::integer;
  perform pg_advisory_xact_lock(hashtext('site.capa_ref'), hashtext(v_site || '/' || v_year::text));
  select coalesce(max(c.ref_serial), 0) + 1 into v_serial from site.capa c where c.site_code = v_site and c.ref_year = v_year;
  v_ref := format('%sCAPA-%s-%s-%s', case when kernel.installation_kind() = 'SANDBOX' then 'TEST-' else '' end, v_site, v_year, lpad(v_serial::text, 5, '0'));
  insert into site.capa (id, ref, origin, site_code, ref_year, ref_serial, title, description, source_kind, source_ref, owner_person, due_on,
                         needs_master_change, raised_by_person, raised_by_account, correlation_id)
  values (v_id, v_ref, 'STAND_IN', v_site, v_year, v_serial, btrim(p ->> 'title'), nullif(btrim(coalesce(p ->> 'description', '')), ''),
          p ->> 'sourceKind', v_src, (p ->> 'ownerPersonId')::uuid, v_due, (p ->> 'needsMasterChange')::boolean,
          (v_ctx ->> 'person_id')::uuid, (v_ctx ->> 'account_id')::uuid, (v_ctx ->> 'correlation_id')::uuid);
  if v_dev.id is not null then
    insert into site.capa_deviation (capa_id, deviation_id, linked_by_person, linked_by_account)
    values (v_id, v_dev.id, (v_ctx ->> 'person_id')::uuid, (v_ctx ->> 'account_id')::uuid);
  end if;
  insert into site.capa_effectiveness_check (capa_id, criteria, period_days, scheduled_on, scheduled_by_person, scheduled_by_account)
  values (v_id, btrim(p -> 'effectivenessCheck' ->> 'criteria'), v_days, site.site_today(), (v_ctx ->> 'person_id')::uuid, (v_ctx ->> 'account_id')::uuid)
  returning id into v_check;
  return jsonb_build_object('capaId', v_id, 'ref', v_ref, 'state', 'OPEN', 'checkId', v_check);
end
$$;

create function site.link_capa_deviation(p_capa uuid, p_deviation uuid) returns void
language plpgsql volatile security definer set search_path = pg_catalog, site, iam, pg_temp as $$
declare
  v_ctx jsonb := site.require_actor();
  c     site.capa;
  d     site.deviation;
begin
  perform iam.assert_not_administrator();
  perform site.require_capa_stand_in();
  c := site.lock_capa(p_capa);
  perform iam.require_permission('CAPA.RECORD', jsonb_build_object('site', c.site_code));
  if site.capa_state(c.id) not in ('OPEN', 'IMPLEMENTED') then
    raise exception using errcode = 'P0001', message = format('EBMR-CAPA-006 %s is %s; nothing is linked to it', c.ref, site.capa_state(c.id));
  end if;
  select * into d from site.deviation where id = p_deviation;
  if d.id is null or d.site_code <> c.site_code then
    raise exception using errcode = 'P0001', message = format('EBMR-CAPA-005 deviation %s is not a record of site %s', p_deviation, c.site_code);
  end if;
  insert into site.capa_deviation (capa_id, deviation_id, linked_by_person, linked_by_account)
  values (c.id, d.id, (v_ctx ->> 'person_id')::uuid, (v_ctx ->> 'account_id')::uuid)
  on conflict do nothing;
end
$$;

-- The MBR version a CAPA that needs a master change waits for (PR-51).
create function site.link_capa_master_version(p_capa uuid, p_version uuid) returns void
language plpgsql volatile security definer set search_path = pg_catalog, site, iam, pg_temp as $$
declare
  v_ctx jsonb := site.require_actor();
  c     site.capa;
  f     jsonb;
begin
  perform iam.assert_not_administrator();
  perform site.require_capa_stand_in();
  c := site.lock_capa(p_capa);
  perform iam.require_permission('CAPA.RECORD', jsonb_build_object('site', c.site_code));
  if not c.needs_master_change then
    raise exception using errcode = 'P0001', message = format('EBMR-CAPA-007 %s needs no master change; no master version is linked to it', c.ref);
  end if;
  if site.capa_state(c.id) not in ('OPEN', 'IMPLEMENTED') then
    raise exception using errcode = 'P0001', message = format('EBMR-CAPA-006 %s is %s; nothing is linked to it', c.ref, site.capa_state(c.id));
  end if;
  f := site.capa_master_version_facts(p_version);
  if not coalesce((f ->> 'exists')::boolean, false) then
    raise exception using errcode = 'P0001', message = format('EBMR-CAPA-007 %s is no master version: %s', p_version, coalesce(f ->> 'problem', 'unknown'));
  end if;
  insert into site.capa_master_version (capa_id, version_id, version_label, linked_by_person, linked_by_account)
  values (c.id, p_version, f ->> 'label', (v_ctx ->> 'person_id')::uuid, (v_ctx ->> 'account_id')::uuid)
  on conflict do nothing;
end
$$;

create function site.record_capa_implemented(p_capa uuid, p_note text) returns void
language plpgsql volatile security definer set search_path = pg_catalog, site, iam, pg_temp as $$
declare
  v_ctx jsonb := site.require_actor();
  c     site.capa;
begin
  perform iam.assert_not_administrator();
  perform site.require_capa_stand_in();
  c := site.lock_capa(p_capa);
  perform iam.require_permission('CAPA.RECORD', jsonb_build_object('site', c.site_code));
  if site.capa_state(c.id) <> 'OPEN' then
    raise exception using errcode = 'P0001', message = format('EBMR-CAPA-008 %s is %s; only an OPEN CAPA is recorded as implemented', c.ref, site.capa_state(c.id));
  end if;
  if btrim(coalesce(p_note, '')) = '' then
    raise exception using errcode = 'P0001', message = 'EBMR-CAPA-008 the implementation states what was done';
  end if;
  insert into site.capa_event (capa_id, event, note, person_id, account_id)
  values (c.id, 'IMPLEMENTED', btrim(p_note), (v_ctx ->> 'person_id')::uuid, (v_ctx ->> 'account_id')::uuid);
end
$$;

-- Another effectiveness check (the one scheduled at raising is the first).
create function site.schedule_capa_effectiveness_check(p_capa uuid, p_criteria text, p_period_days integer) returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, site, iam, pg_temp as $$
declare
  v_ctx jsonb := site.require_actor();
  c     site.capa;
  v_id  uuid;
begin
  perform iam.assert_not_administrator();
  perform site.require_capa_stand_in();
  c := site.lock_capa(p_capa);
  perform iam.require_permission('CAPA.RECORD', jsonb_build_object('site', c.site_code));
  if site.capa_state(c.id) not in ('OPEN', 'IMPLEMENTED') then
    raise exception using errcode = 'P0001', message = format('EBMR-CAPA-006 %s is %s; no check is scheduled for it', c.ref, site.capa_state(c.id));
  end if;
  if btrim(coalesce(p_criteria, '')) = '' or p_period_days is null or p_period_days not between 1 and 1095 then
    raise exception using errcode = 'P0001', message = 'EBMR-CAPA-004 an effectiveness check states what is measured and after how many days (1 to 1095)';
  end if;
  insert into site.capa_effectiveness_check (capa_id, criteria, period_days, scheduled_on, scheduled_by_person, scheduled_by_account)
  values (c.id, btrim(p_criteria), p_period_days, site.site_today(), (v_ctx ->> 'person_id')::uuid, (v_ctx ->> 'account_id')::uuid)
  returning id into v_id;
  return v_id;
end
$$;

create function site.record_capa_effectiveness(p_check uuid, p_effective boolean, p_evidence text) returns void
language plpgsql volatile security definer set search_path = pg_catalog, site, iam, pg_temp as $$
declare
  v_ctx jsonb := site.require_actor();
  k     site.capa_effectiveness_check;
  c     site.capa;
begin
  perform iam.assert_not_administrator();
  perform site.require_capa_stand_in();
  select * into k from site.capa_effectiveness_check where id = p_check;
  if not found then
    raise exception using errcode = 'P0001', message = format('EBMR-CAPA-009 unknown effectiveness check %s', p_check);
  end if;
  c := site.lock_capa(k.capa_id);
  perform iam.require_permission('CAPA.RECORD', jsonb_build_object('site', c.site_code));
  if site.capa_state(c.id) <> 'IMPLEMENTED' then
    raise exception using errcode = 'P0001',
      message = format('EBMR-CAPA-009 %s is %s; effectiveness is checked after the actions are implemented', c.ref, site.capa_state(c.id));
  end if;
  if p_effective is null or btrim(coalesce(p_evidence, '')) = '' then
    raise exception using errcode = 'P0001', message = 'EBMR-CAPA-009 an effectiveness result states effective or not and the evidence it rests on';
  end if;
  if exists (select 1 from site.capa_effectiveness_result r where r.check_id = k.id) then
    raise exception using errcode = 'P0001', message = 'EBMR-CAPA-009 this effectiveness check already has its result';
  end if;
  insert into site.capa_effectiveness_result (check_id, capa_id, effective, evidence, recorded_by_person, recorded_by_account)
  values (k.id, k.capa_id, p_effective, btrim(p_evidence), (v_ctx ->> 'person_id')::uuid, (v_ctx ->> 'account_id')::uuid);
end
$$;

-- NULL when the CAPA may close now, else why not (the screens show it; site.close_capa raises it).
create function site.capa_close_problem(p_capa uuid) returns text
language plpgsql stable security definer set search_path = pg_catalog, site, pg_temp as $$
declare
  c      site.capa;
  m      site.capa_master_version;
  f      jsonb;
  v_open integer;
  v_not  integer;
begin
  select * into c from site.capa where id = p_capa;
  if not found then
    return format('unknown CAPA %s', p_capa);
  end if;
  if c.origin <> 'STAND_IN' then
    return format('%s is a mirror of the QMS; it is closed in the QMS', c.ref);
  end if;
  if site.capa_state(c.id) <> 'IMPLEMENTED' then
    return format('%s is %s; a CAPA closes once its actions are implemented', c.ref, site.capa_state(c.id));
  end if;
  select count(*) filter (where r.check_id is null), count(*) filter (where r.effective = false) into v_open, v_not
  from site.capa_effectiveness_check k left join site.capa_effectiveness_result r on r.check_id = k.id where k.capa_id = c.id;
  if v_open > 0 then
    return format('%s has %s effectiveness check(s) without a result (IN-01 (d))', c.ref, v_open);
  end if;
  if v_not > 0 then
    return format('%s was found not effective; it stays open with a new action and check (PR-51)', c.ref);
  end if;
  if c.needs_master_change then
    if not exists (select 1 from site.capa_master_version x where x.capa_id = c.id) then
      return format('%s needs a master change and names no master version yet (PR-51)', c.ref);
    end if;
    for m in select * from site.capa_master_version x where x.capa_id = c.id order by x.linked_at loop
      f := site.capa_master_version_facts(m.version_id);
      if not coalesce((f ->> 'effective')::boolean, false) then
        return format('%s needs a master change and master version %s is not effective yet: %s (PR-51)', c.ref, m.version_label,
                      coalesce(f ->> 'problem', 'not effective'));
      end if;
    end loop;
  end if;
  return null;
end
$$;

create function site.close_capa(p_capa uuid, p_signature uuid) returns void
language plpgsql volatile security definer set search_path = pg_catalog, site, iam, esig, pg_temp as $$
declare
  v_ctx  jsonb := site.require_actor();
  c      site.capa;
  v_prob text;
begin
  perform iam.assert_not_administrator();
  perform site.require_capa_stand_in();
  c := site.lock_capa(p_capa);
  perform iam.require_permission('CAPA.QA_APPROVE', jsonb_build_object('site', c.site_code));
  v_prob := site.capa_close_problem(c.id);
  if v_prob is not null then
    raise exception using errcode = 'P0001', message = 'EBMR-CAPA-010 ' || v_prob;
  end if;
  perform esig.assert_signature(p_signature, 'CAPA_CLOSED', 'capa', c.id::text);
  v_prob := esig.signature_state_problem(p_signature);
  if v_prob is not null then
    raise exception using errcode = 'P0001', message = 'EBMR-CAPA-011 ' || v_prob;
  end if;
  if (select s.signer_person from esig.signature s where s.id = p_signature)::text is distinct from v_ctx ->> 'person_id' then
    raise exception using errcode = 'P0001', message = 'EBMR-CAPA-011 CAPA_CLOSED is recorded by the QA person who signed it';
  end if;
  if c.raised_by_person::text = v_ctx ->> 'person_id' then
    raise exception using errcode = 'P0001', message = format('EBMR-CAPA-012 %s was raised by this person; QA other than the initiator closes it', c.ref);
  end if;
  insert into site.capa_event (capa_id, event, signature_id, person_id, account_id)
  values (c.id, 'CLOSED', p_signature, (v_ctx ->> 'person_id')::uuid, (v_ctx ->> 'account_id')::uuid);
end
$$;

create function site.cancel_capa(p_capa uuid, p_reason text) returns void
language plpgsql volatile security definer set search_path = pg_catalog, site, iam, pg_temp as $$
declare
  v_ctx jsonb := site.require_actor();
  c     site.capa;
begin
  perform iam.assert_not_administrator();
  perform site.require_capa_stand_in();
  c := site.lock_capa(p_capa);
  perform iam.require_permission('CAPA.QA_APPROVE', jsonb_build_object('site', c.site_code));
  if site.capa_state(c.id) not in ('OPEN', 'IMPLEMENTED') then
    raise exception using errcode = 'P0001', message = format('EBMR-CAPA-013 %s is %s; it cannot be cancelled', c.ref, site.capa_state(c.id));
  end if;
  if btrim(coalesce(p_reason, '')) = '' then
    raise exception using errcode = 'P0001', message = 'EBMR-CAPA-013 a cancellation states the person''s own reason (DI-22)';
  end if;
  if c.raised_by_person::text = v_ctx ->> 'person_id' then
    raise exception using errcode = 'P0001', message = format('EBMR-CAPA-012 %s was raised by this person; QA other than the initiator cancels it', c.ref);
  end if;
  insert into site.capa_event (capa_id, event, note, person_id, account_id)
  values (c.id, 'CANCELLED', btrim(p_reason), (v_ctx ->> 'person_id')::uuid, (v_ctx ->> 'account_id')::uuid);
end
$$;

-- ---------------------------------------------------------------------------------------------
-- The QMS adapter's receiving commands (DI-31)
-- ---------------------------------------------------------------------------------------------

-- Accepts the envelope (kernel 1180) and returns the stored message when it is to be applied, NULL for a duplicate.
create function site.qms_accept(p_envelope jsonb, p_type text) returns platform.inbound_message
language plpgsql volatile security definer set search_path = pg_catalog, site, platform, pg_temp as $$
declare
  v_out jsonb;
  m     platform.inbound_message;
begin
  if p_envelope ->> 'messageType' is distinct from p_type then
    raise exception using errcode = 'P0001',
      message = format('EBMR-QMS-001 this command receives %s messages, not %s', p_type, coalesce(p_envelope ->> 'messageType', 'none'));
  end if;
  v_out := platform.accept_inbound_detail(p_envelope);
  if v_out ->> 'outcome' <> 'ACCEPTED' then
    return null;
  end if;
  if site.qms_mode() <> 'MIRROR' then
    raise exception using errcode = 'P0001',
      message = 'EBMR-QMS-002 this site holds deviations and CAPAs in the built-in register (QMS_STATUS is STAND_IN); a QMS message is not applied (D-P6a-5)';
  end if;
  select * into m from platform.inbound_message where id = (v_out ->> 'messageId')::uuid;
  return m;
end
$$;

create function site.qms_payload_problem(p jsonb, p_fields text[], p_codes text[]) returns text
language plpgsql immutable set search_path = pg_catalog, pg_temp as $$
declare
  k text;
begin
  if p is null or jsonb_typeof(p) <> 'object' then
    return 'the payload is not an object';
  end if;
  for k in select jsonb_object_keys(p) loop
    if not k = any (p_fields) then
      return format('unknown field %s', k);
    end if;
  end loop;
  foreach k in array p_fields loop
    if not p ? k then
      return format('%s is missing', k);
    end if;
  end loop;
  foreach k in array p_codes loop
    if jsonb_typeof(p -> k) is distinct from 'string' or (p ->> k) !~ '^[\x21-\x7E]{1,64}$' then
      return format('%s is a code of 1 to 64 printable characters', k);
    end if;
  end loop;
  return null;
end
$$;

-- STALE when the QMS already sent a newer (or as new) state of the same record (by the QMS's timestamp).
create function site.qms_assert_newest(m platform.inbound_message, p_key_field text) returns void
language plpgsql volatile security definer set search_path = pg_catalog, site, platform, pg_temp as $$
declare
  v_newer timestamptz;
begin
  perform pg_advisory_xact_lock(hashtextextended('qms:' || m.message_type || ':' || (m.payload ->> p_key_field), 0));
  select max(x.source_timestamp) into v_newer from platform.inbound_message x
  where x.source_system = 'QMS' and x.message_type = m.message_type and x.id <> m.id and x.payload ->> p_key_field = m.payload ->> p_key_field;
  if v_newer is not null and v_newer >= m.source_timestamp then
    raise exception using errcode = 'P0001',
      message = format('EBMR-QMS-004 the QMS state of %s at %s is older than the one already applied (%s); it is not applied',
                       m.payload ->> p_key_field, m.source_timestamp, v_newer);
  end if;
end
$$;

create function site.receive_qms_deviation_status(p_envelope jsonb) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, site, platform, pg_temp as $$
declare
  m       platform.inbound_message;
  p       jsonb;
  v_prob  text;
  v_codes text[];
  v_ids   uuid[];
  v_code  text;
  v_lot   uuid;
begin
  m := site.qms_accept(p_envelope, 'qms.deviation_status');
  if m.id is null then
    return jsonb_build_object('outcome', 'DUPLICATE', 'applied', 'NOTHING (duplicate)');
  end if;
  p := m.payload;
  v_prob := site.qms_payload_problem(p, array['deviationRef', 'status', 'lotNumbers', 'versionToken'], array['deviationRef', 'versionToken']);
  if v_prob is null and coalesce(p ->> 'status', '') not in ('OPEN', 'UNDER_INVESTIGATION', 'CLOSED', 'CANCELLED') then
    v_prob := 'status is OPEN, UNDER_INVESTIGATION, CLOSED or CANCELLED';
  end if;
  if v_prob is null and (jsonb_typeof(p -> 'lotNumbers') <> 'array' or jsonb_array_length(p -> 'lotNumbers') > 200
                         or exists (select 1 from jsonb_array_elements(p -> 'lotNumbers') e where jsonb_typeof(e) <> 'string' or e #>> '{}' !~ '^[\x21-\x7E]{1,64}$')) then
    v_prob := 'lotNumbers is a list of at most 200 lot codes';
  end if;
  if v_prob is not null then
    raise exception using errcode = 'P0001', message = format('EBMR-QMS-003 malformed qms.deviation_status payload: %s', v_prob);
  end if;
  perform site.qms_assert_newest(m, 'deviationRef');
  v_codes := array(select distinct e #>> '{}' from jsonb_array_elements(p -> 'lotNumbers') e order by 1);
  v_ids := '{}';
  foreach v_code in array v_codes loop
    select l.id into v_lot from site.material_lot l where l.lot_code = v_code;
    if v_lot is null then
      raise exception using errcode = 'P0001',
        message = format('EBMR-QMS-005 QMS deviation %s names lot %s, which this installation does not hold (wrong lot)', p ->> 'deviationRef', v_code);
    end if;
    v_ids := v_ids || v_lot;
  end loop;
  insert into site.qms_deviation_status (deviation_ref, message_id, source_timestamp, status, lot_codes, lot_ids, version_token)
  values (p ->> 'deviationRef', m.id, m.source_timestamp, p ->> 'status', v_codes, v_ids, p ->> 'versionToken');
  return jsonb_build_object('outcome', 'ACCEPTED', 'messageId', m.id, 'sequenceStatus', m.sequence_status, 'applied', 'RECORDED');
end
$$;

create function site.receive_qms_capa(p_envelope jsonb) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, site, platform, pg_temp as $$
declare
  v_ctx  jsonb := site.require_actor();
  m      platform.inbound_message;
  p      jsonb;
  v_prob text;
  v_capa uuid;
  v_due  date;
begin
  m := site.qms_accept(p_envelope, 'qms.capa');
  if m.id is null then
    return jsonb_build_object('outcome', 'DUPLICATE', 'applied', 'NOTHING (duplicate)');
  end if;
  p := m.payload;
  v_prob := site.qms_payload_problem(p, array['capaRef', 'title', 'status', 'needsMasterChange', 'effectivenessDueDate', 'versionToken'], array['capaRef', 'versionToken']);
  if v_prob is null and (jsonb_typeof(p -> 'title') <> 'string' or btrim(p ->> 'title') = '' or length(p ->> 'title') > 500) then
    v_prob := 'title is a text of 1 to 500 characters';
  end if;
  if v_prob is null and coalesce(p ->> 'status', '') not in ('OPEN', 'IMPLEMENTED', 'EFFECTIVENESS_CHECK', 'CLOSED', 'CANCELLED') then
    v_prob := 'status is OPEN, IMPLEMENTED, EFFECTIVENESS_CHECK, CLOSED or CANCELLED';
  end if;
  if v_prob is null and jsonb_typeof(p -> 'needsMasterChange') <> 'boolean' then
    v_prob := 'needsMasterChange is true or false';
  end if;
  if v_prob is null and jsonb_typeof(p -> 'effectivenessDueDate') <> 'null' then
    begin
      if (p ->> 'effectivenessDueDate') !~ '^\d{4}-\d{2}-\d{2}$' then
        raise exception 'not a date';
      end if;
      v_due := (p ->> 'effectivenessDueDate')::date;
    exception when others then
      v_prob := 'effectivenessDueDate is a date YYYY-MM-DD or null';
    end;
  end if;
  if v_prob is not null then
    raise exception using errcode = 'P0001', message = format('EBMR-QMS-003 malformed qms.capa payload: %s', v_prob);
  end if;
  perform site.qms_assert_newest(m, 'capaRef');
  select id into v_capa from site.capa where qms_ref = p ->> 'capaRef';
  if v_capa is null then
    v_capa := gen_random_uuid();
    insert into site.capa (id, ref, origin, site_code, qms_ref, title, needs_master_change, raised_by_person, raised_by_account, correlation_id)
    values (v_capa, 'QMS:' || (p ->> 'capaRef'), 'QMS', site.actor_site(), p ->> 'capaRef', btrim(p ->> 'title'), (p ->> 'needsMasterChange')::boolean,
            (v_ctx ->> 'person_id')::uuid, (v_ctx ->> 'account_id')::uuid, (v_ctx ->> 'correlation_id')::uuid);
  end if;
  insert into site.qms_capa_state (capa_id, message_id, source_timestamp, status, title, needs_master_change, effectiveness_due_on, version_token)
  values (v_capa, m.id, m.source_timestamp, p ->> 'status', btrim(p ->> 'title'), (p ->> 'needsMasterChange')::boolean, v_due, p ->> 'versionToken');
  return jsonb_build_object('outcome', 'ACCEPTED', 'messageId', m.id, 'sequenceStatus', m.sequence_status, 'applied', 'RECORDED', 'capaId', v_capa);
end
$$;

create function site.receive_qms_change_control(p_envelope jsonb) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, site, platform, pg_temp as $$
declare
  m      platform.inbound_message;
  p      jsonb;
  v_prob text;
begin
  m := site.qms_accept(p_envelope, 'qms.change_control');
  if m.id is null then
    return jsonb_build_object('outcome', 'DUPLICATE', 'applied', 'NOTHING (duplicate)');
  end if;
  p := m.payload;
  v_prob := site.qms_payload_problem(p, array['changeRef', 'status', 'versionToken'], array['changeRef', 'versionToken']);
  if v_prob is null and coalesce(p ->> 'status', '') not in ('OPEN', 'APPROVED', 'IMPLEMENTED', 'CLOSED', 'REJECTED') then
    v_prob := 'status is OPEN, APPROVED, IMPLEMENTED, CLOSED or REJECTED';
  end if;
  if v_prob is not null then
    raise exception using errcode = 'P0001', message = format('EBMR-QMS-003 malformed qms.change_control payload: %s', v_prob);
  end if;
  perform site.qms_assert_newest(m, 'changeRef');
  insert into site.qms_change_control (change_ref, message_id, source_timestamp, status, version_token)
  values (p ->> 'changeRef', m.id, m.source_timestamp, p ->> 'status', p ->> 'versionToken');
  return jsonb_build_object('outcome', 'ACCEPTED', 'messageId', m.id, 'sequenceStatus', m.sequence_status, 'applied', 'RECORDED');
end
$$;

-- ---------------------------------------------------------------------------------------------
-- The QMS status at release (D-P6a-3)
-- ---------------------------------------------------------------------------------------------

-- The mirror's current view of the QMS deviations naming the lot: [{deviationRef, status, versionToken}] by reference.
create function site.qms_lot_deviations(p_lot uuid) returns jsonb
language sql stable security definer set search_path = pg_catalog, site, pg_temp as $$
  select coalesce(jsonb_agg(jsonb_build_object('deviationRef', s.deviation_ref, 'status', s.status, 'versionToken', s.version_token)
                            order by s.deviation_ref collate "C"), '[]'::jsonb)
  from (select distinct on (q.deviation_ref) q.* from site.qms_deviation_status q
        where q.deviation_ref in (select x.deviation_ref from site.qms_deviation_status x where p_lot = any (x.lot_ids))
        order by q.deviation_ref, q.source_timestamp desc, q.received_at desc) s
  where p_lot = any (s.lot_ids)
$$;

-- The live answer of the QMS for the lot, fetched by the server inside the release signing transaction:
-- p_deviations [{deviationRef, status, versionToken}]. Refused when it differs from the mirror the signer evaluated
-- (a changed or a stale version token): the release is evaluated again.
create function site.record_qms_release_fetch(p_lot uuid, p_deviations jsonb) returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, site, iam, pg_temp as $$
declare
  v_ctx    jsonb := site.require_actor();
  l        site.material_lot;
  v_norm   jsonb;
  v_mirror jsonb;
  v_ok     boolean := false;
  v_perm   text;
  v_id     uuid;
begin
  perform iam.assert_not_administrator();
  select * into l from site.material_lot where id = p_lot;
  if not found then
    raise exception using errcode = 'P0001', message = format('EBMR-QMS-010 unknown lot %s', p_lot);
  end if;
  foreach v_perm in array array['RELEASE.MANUFACTURER', 'RELEASE.US_DISPOSITION', 'RELEASE.EU_QP_CERTIFY'] loop
    begin
      perform iam.require_permission(v_perm, jsonb_build_object('site', l.site_code));
      v_ok := true;
      exit;
    exception when others then
      null;
    end;
  end loop;
  if not v_ok then
    raise exception using errcode = 'P0001', message = 'EBMR-QMS-010 the QMS status at release is fetched by the person releasing the lot';
  end if;
  if site.qms_mode() <> 'MIRROR' then
    raise exception using errcode = 'P0001', message = 'EBMR-QMS-010 this site runs no QMS (QMS_STATUS is STAND_IN); nothing is fetched at release';
  end if;
  if p_deviations is null or jsonb_typeof(p_deviations) <> 'array'
     or exists (select 1 from jsonb_array_elements(p_deviations) e
                where jsonb_typeof(e) <> 'object' or (select count(*) from jsonb_object_keys(e)) <> 3
                   or coalesce(e ->> 'deviationRef', '') !~ '^[\x21-\x7E]{1,64}$' or coalesce(e ->> 'versionToken', '') !~ '^[\x21-\x7E]{1,64}$'
                   or coalesce(e ->> 'status', '') not in ('OPEN', 'UNDER_INVESTIGATION', 'CLOSED', 'CANCELLED')) then
    raise exception using errcode = 'P0001', message = 'EBMR-QMS-012 the QMS answer is not a list of {deviationRef, status, versionToken}; the release is refused';
  end if;
  v_norm := (select coalesce(jsonb_agg(jsonb_build_object('deviationRef', e ->> 'deviationRef', 'status', e ->> 'status', 'versionToken', e ->> 'versionToken')
                                       order by e ->> 'deviationRef' collate "C"), '[]'::jsonb)
             from jsonb_array_elements(p_deviations) e);
  v_mirror := site.qms_lot_deviations(l.id);
  if v_norm <> v_mirror then
    raise exception using errcode = 'P0001',
      message = format('EBMR-QMS-011 the QMS status of lot %s changed since it was shown (version tokens differ: shown %s, QMS now %s); evaluate the release again when the QMS mirror has caught up',
                       l.lot_code, v_mirror::text, v_norm::text);
  end if;
  insert into site.qms_release_fetch (lot_id, deviations, open_count, person_id, account_id)
  values (l.id, v_norm, (select count(*) from jsonb_array_elements(v_norm) e where e ->> 'status' in ('OPEN', 'UNDER_INVESTIGATION')),
          (v_ctx ->> 'person_id')::uuid, (v_ctx ->> 'account_id')::uuid)
  returning id into v_id;
  return v_id;
end
$$;

-- NULL in STAND_IN. In MIRROR why the lot cannot be released in this transaction (names the QMS).
create function site.qms_release_problem(p_lot uuid) returns text
language plpgsql stable security definer set search_path = pg_catalog, site, platform, pg_temp as $$
declare
  f       site.qms_release_fetch;
  v_bound bigint;
  v_code  text;
begin
  if site.qms_mode() = 'STAND_IN' then
    return null;
  end if;
  select lot_code into v_code from site.material_lot where id = p_lot;
  select * into f from site.qms_release_fetch where lot_id = p_lot and xact_id = pg_current_xact_id() order by fetched_at desc limit 1;
  if f.id is null then
    return format('EBMR-QMS-013 the QMS status of lot %s was not fetched from the QMS in this release; the release is refused (call the QMS system owner if the QMS cannot be reached) (D-P6a-3)', coalesce(v_code, p_lot::text));
  end if;
  v_bound := platform.setting_numeric('integration.mirror_max_age_s.qms_status')::bigint;
  if clock_timestamp() - f.fetched_at > make_interval(secs => v_bound) then
    return format('EBMR-QMS-014 the QMS status of lot %s was fetched %s s ago, more than the QMS_STATUS bound of %s s; sign again (D-P6a-0-11)',
                  v_code, floor(extract(epoch from clock_timestamp() - f.fetched_at))::bigint, v_bound);
  end if;
  if f.open_count > 0 then
    return format('EBMR-QMS-015 the QMS holds %s open deviation(s) naming lot %s (%s); the lot is not released while they are open',
                  f.open_count, v_code,
                  (select string_agg(e ->> 'deviationRef' || ' ' || (e ->> 'status'), ', ') from jsonb_array_elements(f.deviations) e
                   where e ->> 'status' in ('OPEN', 'UNDER_INVESTIGATION')));
  end if;
  return null;
end
$$;

revoke all on function site.capa_master_version_facts(uuid), site.site_today(), site.qms_mode(), site.capa_latest_qms_state(uuid),
  site.capa_state(uuid), site.capa_check_status(uuid, date), site.capa_view(uuid, date), site.capa_content(text),
  site.require_capa_stand_in(), site.lock_capa(uuid), site.raise_capa(jsonb), site.link_capa_deviation(uuid, uuid),
  site.link_capa_master_version(uuid, uuid), site.record_capa_implemented(uuid, text), site.schedule_capa_effectiveness_check(uuid, text, integer),
  site.record_capa_effectiveness(uuid, boolean, text), site.capa_close_problem(uuid), site.close_capa(uuid, uuid), site.cancel_capa(uuid, text),
  site.qms_accept(jsonb, text), site.qms_payload_problem(jsonb, text[], text[]), site.qms_assert_newest(platform.inbound_message, text),
  site.receive_qms_deviation_status(jsonb), site.receive_qms_capa(jsonb), site.receive_qms_change_control(jsonb),
  site.qms_lot_deviations(uuid), site.record_qms_release_fetch(uuid, jsonb), site.qms_release_problem(uuid) from public;

grant select on site.capa_master_resolver, site.capa, site.capa_deviation, site.capa_master_version, site.capa_effectiveness_check,
  site.capa_effectiveness_result, site.capa_event, site.qms_capa_state, site.qms_deviation_status, site.qms_change_control,
  site.qms_release_fetch to ebmr_app;
grant execute on function site.capa_master_version_facts(uuid), site.site_today(), site.qms_mode(), site.capa_state(uuid),
  site.capa_check_status(uuid, date), site.capa_view(uuid, date), site.capa_content(text), site.raise_capa(jsonb),
  site.link_capa_deviation(uuid, uuid), site.link_capa_master_version(uuid, uuid), site.record_capa_implemented(uuid, text),
  site.schedule_capa_effectiveness_check(uuid, text, integer), site.record_capa_effectiveness(uuid, boolean, text),
  site.capa_close_problem(uuid), site.close_capa(uuid, uuid), site.cancel_capa(uuid, text),
  site.receive_qms_deviation_status(jsonb), site.receive_qms_capa(jsonb), site.receive_qms_change_control(jsonb),
  site.qms_lot_deviations(uuid), site.record_qms_release_fetch(uuid, jsonb), site.qms_release_problem(uuid) to ebmr_app;

reset role;
