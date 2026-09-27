-- Records module (B4), part 2: incident register (DI-12).
--
-- Incidents are raised automatically (interface failures, lost connections, crashes, repeated signature
-- failures, time-sync faults, print failures, integrity-check failures) or by a person. Each incident is
-- linked to the affected records (aggregate type and id, optionally a step) and carries a severity.
-- Life cycle: OPEN -> UNDER_INVESTIGATION -> CLOSED. All incident tables are insert-only: the current
-- state is derived from the base row plus its events (records.incident_current), so nothing is ever
-- overwritten. Closing an incident whose severity was ever MAJOR or CRITICAL needs a root cause and a
-- CAPA reference (DI-12 requires it for CRITICAL; MAJOR is included as a stricter design default, and
-- the highest severity ever held counts, so a downgrade cannot be used to avoid the requirement).
--
-- A linked record stays blocked for disposition until the incident is closed or assessed for that
-- record (records.open_blockers, part 5). Every raise and link also writes a plain-language business
-- entry into the linked record's own audit chain, so the batch audit-trail review sees it (DI-25).
--
-- CERT-In: cyber incidents are reportable to CERT-In within 6 hours according to secondary sources on
-- the CERT-In Directions of April 2022. The rule is NOT verified against the official text (outline
-- 4.7, "verify"); the window lives in one function, records.cert_in_reporting_window().

set local role ebmr_owner;

create function records.severity_rank(p_severity text) returns integer
language sql immutable set search_path = pg_catalog as $$
  select case p_severity when 'MINOR' then 1 when 'MAJOR' then 2 when 'CRITICAL' then 3 end
$$;

-- VERIFY: 6 hours from secondary sources on the CERT-In Directions (April 2022); not in the inputs.
create function records.cert_in_reporting_window() returns interval
language sql immutable set search_path = pg_catalog as $$
  select interval '6 hours'
$$;

create table records.incident (
  id                    uuid primary key default gen_random_uuid(),
  incident_no           bigint generated always as identity unique,
  source                text not null check (source in ('INTERFACE_FAILURE', 'CONNECTION_LOSS', 'CRASH', 'SIGNATURE_FAILURE', 'TIME_SYNC',
                                                        'PRINT_FAILURE', 'INTEGRITY_CHECK', 'SECURITY', 'DATA_INTEGRITY', 'OTHER')),
  incident_type         text not null check (incident_type ~ '^[A-Z][A-Z0-9_]{1,63}$'),
  initial_severity      text not null check (initial_severity in ('MINOR', 'MAJOR', 'CRITICAL')),
  title                 text not null check (length(btrim(title)) > 0),
  description           text not null,
  detected_by           text not null check (detected_by in ('SYSTEM', 'USER')),
  raised_by_person      uuid not null,
  raised_by_account     uuid not null,
  occurred_at           timestamptz,
  occurred_at_trust     text check (occurred_at_trust in ('DEVICE_SYNCED', 'DEVICE_UNSYNCED', 'USER_CLAIMED', 'PAPER')),
  cert_in_reportable    boolean not null,
  recorded_at           timestamptz not null default clock_timestamp(),
  check ((occurred_at is null) = (occurred_at_trust is null)),
  check (occurred_at is null or occurred_at <= recorded_at)
);

create table records.incident_link (
  id                uuid primary key default gen_random_uuid(),
  incident_id       uuid not null references records.incident (id),
  aggregate_type    text not null check (aggregate_type ~ '^[a-z][a-z0-9_]*$'),
  aggregate_id      text not null check (length(btrim(aggregate_id)) > 0),
  step_ref          text,
  linked_by_person  uuid not null,
  recorded_at       timestamptz not null default clock_timestamp()
);
create unique index incident_link_unique on records.incident_link (incident_id, aggregate_type, aggregate_id, coalesce(step_ref, ''));
create index incident_link_target on records.incident_link (aggregate_type, aggregate_id);

create table records.incident_event (
  id                    bigint generated always as identity primary key,
  incident_id           uuid not null references records.incident (id),
  event_type            text not null check (event_type in ('INVESTIGATION_STARTED', 'SEVERITY_CHANGED', 'CERT_IN_REPORTABLE', 'CERT_IN_REPORTED', 'CLOSED')),
  severity              text check (severity in ('MINOR', 'MAJOR', 'CRITICAL')),
  note                  text,
  root_cause            text,
  capa_ref              text,
  closure_summary       text,
  reported_occurred_at  timestamptz,
  reported_trust        text check (reported_trust in ('DEVICE_SYNCED', 'DEVICE_UNSYNCED', 'USER_CLAIMED', 'PAPER')),
  report_reference      text,
  actor_person          uuid not null,
  actor_account         uuid not null,
  recorded_at           timestamptz not null default clock_timestamp(),
  check (event_type <> 'SEVERITY_CHANGED' or (severity is not null and length(btrim(coalesce(note, ''))) > 0)),
  check (event_type <> 'CLOSED' or length(btrim(coalesce(closure_summary, ''))) > 0),
  check (event_type <> 'CERT_IN_REPORTED' or (reported_occurred_at is not null and reported_trust is not null
                                              and length(btrim(coalesce(report_reference, ''))) > 0 and reported_occurred_at <= recorded_at))
);
create unique index incident_event_single_close on records.incident_event (incident_id) where event_type = 'CLOSED';
create unique index incident_event_single_start on records.incident_event (incident_id) where event_type = 'INVESTIGATION_STARTED';
create unique index incident_event_single_report on records.incident_event (incident_id) where event_type = 'CERT_IN_REPORTED';
create index incident_event_incident on records.incident_event (incident_id, id);

-- Impact assessment of an incident for one linked record: lifts the disposition block for that record.
create table records.incident_assessment (
  id                  uuid primary key default gen_random_uuid(),
  incident_id         uuid not null references records.incident (id),
  aggregate_type      text not null,
  aggregate_id        text not null,
  outcome             text not null check (outcome in ('NO_IMPACT', 'IMPACT_DEVIATION_RAISED')),
  deviation_ref       text,
  rationale           text not null check (length(btrim(rationale)) > 0),
  assessed_by_person  uuid not null,
  recorded_at         timestamptz not null default clock_timestamp(),
  unique (incident_id, aggregate_type, aggregate_id),
  check (outcome <> 'IMPACT_DEVIATION_RAISED' or length(btrim(coalesce(deviation_ref, ''))) > 0)
);

create view records.incident_current as
select i.id, i.incident_no, 'INC-' || lpad(i.incident_no::text, 6, '0') as reference, i.source, i.incident_type, i.title, i.description,
       i.detected_by, i.raised_by_person, i.raised_by_account, i.occurred_at, i.occurred_at_trust, i.recorded_at,
       case when c.id is not null then 'CLOSED' when s.id is not null then 'UNDER_INVESTIGATION' else 'OPEN' end as status,
       i.initial_severity,
       coalesce(sev.severity, i.initial_severity) as severity,
       (select x.sev from (select i.initial_severity as sev union all
                           select e.severity from records.incident_event e where e.incident_id = i.id and e.event_type = 'SEVERITY_CHANGED') x
         order by records.severity_rank(x.sev) desc limit 1) as peak_severity,
       (i.cert_in_reportable or exists (select 1 from records.incident_event e where e.incident_id = i.id and e.event_type = 'CERT_IN_REPORTABLE')) as cert_in_reportable,
       case when i.cert_in_reportable or exists (select 1 from records.incident_event e where e.incident_id = i.id and e.event_type = 'CERT_IN_REPORTABLE')
            then i.recorded_at + records.cert_in_reporting_window() end as cert_in_deadline_at,
       r.reported_occurred_at as cert_in_reported_at, r.report_reference as cert_in_reference,
       s.recorded_at as investigation_started_at,
       c.root_cause, c.capa_ref, c.closure_summary, c.recorded_at as closed_at, c.actor_person as closed_by_person
from records.incident i
left join records.incident_event s on s.incident_id = i.id and s.event_type = 'INVESTIGATION_STARTED'
left join records.incident_event c on c.incident_id = i.id and c.event_type = 'CLOSED'
left join records.incident_event r on r.incident_id = i.id and r.event_type = 'CERT_IN_REPORTED'
left join lateral (select e.severity from records.incident_event e
                    where e.incident_id = i.id and e.event_type = 'SEVERITY_CHANGED' order by e.id desc limit 1) sev on true;

-- ---------------------------------------------------------------------------------------------
-- Functions
-- ---------------------------------------------------------------------------------------------

-- Lock the incident and return its current state (internal).
create function records.lock_incident(p_incident_id uuid) returns records.incident_current
language plpgsql volatile security definer set search_path = pg_catalog, records, kernel as $$
declare
  v records.incident_current%rowtype;
begin
  perform 1 from records.incident where id = p_incident_id for update;
  if not found then
    raise exception using errcode = 'P0001', message = format('EBMR-REC-051 incident %s does not exist', p_incident_id);
  end if;
  select * into v from records.incident_current where id = p_incident_id;
  return v;
end
$$;

-- Internal: link one record and write the business entry into that record's chain.
create function records.add_incident_link(p_incident records.incident_current, p_aggregate_type text, p_aggregate_id text, p_step_ref text)
returns void
language plpgsql volatile security definer set search_path = pg_catalog, records, kernel as $$
declare
  v_key text := records.record_key(p_aggregate_type, p_aggregate_id);
begin
  -- Take the record's blocker-epoch lock first so a concurrent purge or disposition serialises with this link.
  perform records.lock_blocker_epoch(p_aggregate_type, p_aggregate_id);
  insert into records.incident_link (incident_id, aggregate_type, aggregate_id, step_ref, linked_by_person)
  values (p_incident.id, p_aggregate_type, p_aggregate_id, nullif(btrim(coalesce(p_step_ref, '')), ''), records.actor_person())
  on conflict do nothing;
  if found then
    perform kernel.audit_business_event(v_key,
      format('incident %s (%s, %s) linked%s: %s', p_incident.reference, p_incident.source, p_incident.severity,
             case when p_step_ref is null then '' else ' to step ' || p_step_ref end, p_incident.title),
      jsonb_build_object('incident_id', p_incident.id, 'incident', p_incident.reference, 'step_ref', p_step_ref));
    perform records.bump_blocker_epoch(p_aggregate_type, p_aggregate_id);
  end if;
end
$$;

-- p_links: [{"aggregateType": "batch", "aggregateId": "...", "stepRef": "..."}]
create function records.raise_incident(
  p_source text, p_incident_type text, p_severity text, p_title text, p_description text,
  p_links jsonb default '[]'::jsonb, p_occurred_at timestamptz default null, p_occurred_at_trust text default null,
  p_cert_in_reportable boolean default false
) returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, records, kernel as $$
declare
  v_id uuid;
  v_inc records.incident_current%rowtype;
  l jsonb;
begin
  if p_source is null or p_source not in ('INTERFACE_FAILURE', 'CONNECTION_LOSS', 'CRASH', 'SIGNATURE_FAILURE', 'TIME_SYNC',
                                          'PRINT_FAILURE', 'INTEGRITY_CHECK', 'SECURITY', 'DATA_INTEGRITY', 'OTHER') then
    raise exception using errcode = 'P0001', message = format('EBMR-REC-050 incident source %L is not in the catalogue', p_source);
  end if;
  if p_incident_type is null or p_incident_type !~ '^[A-Z][A-Z0-9_]{1,63}$' then
    raise exception using errcode = 'P0001', message = format('EBMR-REC-050 incident type %L must be an upper-case code', p_incident_type);
  end if;
  if p_severity is null or records.severity_rank(p_severity) is null then
    raise exception using errcode = 'P0001', message = format('EBMR-REC-050 severity %L must be MINOR, MAJOR or CRITICAL', p_severity);
  end if;
  if records.is_blank(p_title) then
    raise exception using errcode = 'P0001', message = 'EBMR-REC-050 an incident needs a title';
  end if;
  if p_links is null or jsonb_typeof(p_links) <> 'array' then
    raise exception using errcode = 'P0001', message = 'EBMR-REC-050 incident links must be a JSON array';
  end if;
  if (p_occurred_at is null) <> (p_occurred_at_trust is null) then
    raise exception using errcode = 'P0001', message = 'EBMR-REC-050 a claimed occurrence time needs its trust level, and a trust level needs a time';
  end if;
  if p_occurred_at is not null and p_occurred_at > clock_timestamp() then
    raise exception using errcode = 'P0001', message = 'EBMR-REC-050 the claimed occurrence time lies in the future of the server clock';
  end if;
  insert into records.incident (source, incident_type, initial_severity, title, description, detected_by, raised_by_person,
                                raised_by_account, occurred_at, occurred_at_trust, cert_in_reportable)
  values (p_source, p_incident_type, p_severity, p_title, coalesce(p_description, ''),
          case when records.actor_is_machine() then 'SYSTEM' else 'USER' end, records.actor_person(), records.actor_account(),
          p_occurred_at, p_occurred_at_trust, coalesce(p_cert_in_reportable, false))
  returning id into v_id;
  select * into v_inc from records.incident_current where id = v_id;
  for l in select * from jsonb_array_elements(p_links) loop
    perform records.add_incident_link(v_inc, l ->> 'aggregateType', l ->> 'aggregateId', l ->> 'stepRef');
  end loop;
  return v_id;
end
$$;

create function records.link_incident(p_incident_id uuid, p_aggregate_type text, p_aggregate_id text, p_step_ref text default null)
returns void
language plpgsql volatile security definer set search_path = pg_catalog, records, kernel as $$
declare
  v records.incident_current%rowtype := records.lock_incident(p_incident_id);
begin
  if v.status = 'CLOSED' then
    raise exception using errcode = 'P0001', message = format('EBMR-REC-052 incident %s is closed; raise a new incident instead', v.reference);
  end if;
  perform records.add_incident_link(v, p_aggregate_type, p_aggregate_id, p_step_ref);
end
$$;

create function records.reclassify_incident(p_incident_id uuid, p_severity text, p_justification text) returns void
language plpgsql volatile security definer set search_path = pg_catalog, records, kernel as $$
declare
  v records.incident_current%rowtype := records.lock_incident(p_incident_id);
begin
  if v.status = 'CLOSED' then
    raise exception using errcode = 'P0001', message = format('EBMR-REC-052 incident %s is closed; its severity cannot change', v.reference);
  end if;
  if p_severity is null or records.severity_rank(p_severity) is null then
    raise exception using errcode = 'P0001', message = format('EBMR-REC-050 severity %L must be MINOR, MAJOR or CRITICAL', p_severity);
  end if;
  if p_severity = v.severity then
    raise exception using errcode = 'P0001', message = format('EBMR-REC-052 incident %s already has severity %s', v.reference, p_severity);
  end if;
  if records.is_blank(p_justification) then
    raise exception using errcode = 'P0001', message = 'EBMR-REC-050 changing the severity of an incident needs a justification';
  end if;
  insert into records.incident_event (incident_id, event_type, severity, note, actor_person, actor_account)
  values (v.id, 'SEVERITY_CHANGED', p_severity, p_justification, records.actor_person(), records.actor_account());
end
$$;

create function records.start_incident_investigation(p_incident_id uuid, p_note text default null) returns void
language plpgsql volatile security definer set search_path = pg_catalog, records, kernel as $$
declare
  v records.incident_current%rowtype := records.lock_incident(p_incident_id);
begin
  if v.status <> 'OPEN' then
    raise exception using errcode = 'P0001', message = format('EBMR-REC-052 incident %s is %s; only an OPEN incident moves to UNDER_INVESTIGATION', v.reference, v.status);
  end if;
  insert into records.incident_event (incident_id, event_type, note, actor_person, actor_account)
  values (v.id, 'INVESTIGATION_STARTED', p_note, records.actor_person(), records.actor_account());
end
$$;

create function records.mark_incident_cert_in_reportable(p_incident_id uuid, p_justification text) returns void
language plpgsql volatile security definer set search_path = pg_catalog, records, kernel as $$
declare
  v records.incident_current%rowtype := records.lock_incident(p_incident_id);
begin
  if v.status = 'CLOSED' or v.cert_in_reportable then
    raise exception using errcode = 'P0001', message = format('EBMR-REC-055 incident %s is closed or already CERT-In reportable', v.reference);
  end if;
  if records.is_blank(p_justification) then
    raise exception using errcode = 'P0001', message = 'EBMR-REC-055 marking an incident CERT-In reportable needs a justification';
  end if;
  insert into records.incident_event (incident_id, event_type, note, actor_person, actor_account)
  values (v.id, 'CERT_IN_REPORTABLE', p_justification, records.actor_person(), records.actor_account());
end
$$;

-- The report itself is made outside the system; the time it was made is a claimed time (USER_CLAIMED).
create function records.record_cert_in_report(p_incident_id uuid, p_reported_at timestamptz, p_reference text) returns void
language plpgsql volatile security definer set search_path = pg_catalog, records, kernel as $$
declare
  v records.incident_current%rowtype := records.lock_incident(p_incident_id);
begin
  if not v.cert_in_reportable then
    raise exception using errcode = 'P0001', message = format('EBMR-REC-055 incident %s is not marked CERT-In reportable', v.reference);
  end if;
  if v.cert_in_reported_at is not null then
    raise exception using errcode = 'P0001', message = format('EBMR-REC-055 the CERT-In report of incident %s is already recorded', v.reference);
  end if;
  if p_reported_at is null or records.is_blank(p_reference) then
    raise exception using errcode = 'P0001', message = 'EBMR-REC-055 a CERT-In report needs the time it was made and the acknowledgement reference';
  end if;
  if p_reported_at > clock_timestamp() or (v.occurred_at is not null and p_reported_at < v.occurred_at) then
    raise exception using errcode = 'P0001', message = 'EBMR-REC-055 the CERT-In report time must lie between the occurrence and now';
  end if;
  insert into records.incident_event (incident_id, event_type, reported_occurred_at, reported_trust, report_reference, actor_person, actor_account)
  values (v.id, 'CERT_IN_REPORTED', p_reported_at, 'USER_CLAIMED', p_reference, records.actor_person(), records.actor_account());
end
$$;

create function records.assess_incident_impact(p_incident_id uuid, p_aggregate_type text, p_aggregate_id text, p_outcome text,
                                               p_rationale text, p_deviation_ref text default null) returns void
language plpgsql volatile security definer set search_path = pg_catalog, records, kernel as $$
declare
  v records.incident_current%rowtype := records.lock_incident(p_incident_id);
begin
  if records.actor_is_machine() then
    raise exception using errcode = 'P0001', message = 'EBMR-REC-056 an incident impact assessment is made by a person';
  end if;
  if not exists (select 1 from records.incident_link where incident_id = v.id and aggregate_type = p_aggregate_type and aggregate_id = p_aggregate_id) then
    raise exception using errcode = 'P0001', message = format('EBMR-REC-056 incident %s is not linked to %s:%s', v.reference, p_aggregate_type, p_aggregate_id);
  end if;
  if p_outcome is null or p_outcome not in ('NO_IMPACT', 'IMPACT_DEVIATION_RAISED') then
    raise exception using errcode = 'P0001', message = 'EBMR-REC-056 the outcome must be NO_IMPACT or IMPACT_DEVIATION_RAISED';
  end if;
  if records.is_blank(p_rationale) or (p_outcome = 'IMPACT_DEVIATION_RAISED' and records.is_blank(p_deviation_ref)) then
    raise exception using errcode = 'P0001', message = 'EBMR-REC-056 an assessment needs a rationale, and an impact needs the deviation reference';
  end if;
  if exists (select 1 from records.incident_assessment where incident_id = v.id and aggregate_type = p_aggregate_type and aggregate_id = p_aggregate_id) then
    raise exception using errcode = 'P0001', message = format('EBMR-REC-056 incident %s is already assessed for %s:%s', v.reference, p_aggregate_type, p_aggregate_id);
  end if;
  insert into records.incident_assessment (incident_id, aggregate_type, aggregate_id, outcome, deviation_ref, rationale, assessed_by_person)
  values (v.id, p_aggregate_type, p_aggregate_id, p_outcome, nullif(btrim(coalesce(p_deviation_ref, '')), ''), p_rationale, records.actor_person());
  perform kernel.audit_business_event(records.record_key(p_aggregate_type, p_aggregate_id),
    format('incident %s assessed for this record: %s', v.reference, p_outcome),
    jsonb_build_object('incident_id', v.id, 'outcome', p_outcome, 'deviation_ref', p_deviation_ref));
  perform records.bump_blocker_epoch(p_aggregate_type, p_aggregate_id);
end
$$;

create function records.close_incident(p_incident_id uuid, p_closure_summary text, p_root_cause text default null, p_capa_ref text default null)
returns void
language plpgsql volatile security definer set search_path = pg_catalog, records, kernel as $$
declare
  v records.incident_current%rowtype := records.lock_incident(p_incident_id);
  l record;
begin
  if v.status <> 'UNDER_INVESTIGATION' then
    raise exception using errcode = 'P0001', message = format('EBMR-REC-052 incident %s is %s; only an incident UNDER_INVESTIGATION can be closed', v.reference, v.status);
  end if;
  if records.actor_is_machine() then
    raise exception using errcode = 'P0001', message = 'EBMR-REC-052 an incident is closed by a person, not by a system or integration account';
  end if;
  if records.severity_rank(v.peak_severity) >= records.severity_rank('MAJOR') and (records.is_blank(p_root_cause) or records.is_blank(p_capa_ref)) then
    raise exception using errcode = 'P0001',
      message = format('EBMR-REC-053 incident %s was %s: closing it needs a root cause and a CAPA reference', v.reference, v.peak_severity);
  end if;
  if records.is_blank(p_closure_summary) then
    raise exception using errcode = 'P0001', message = format('EBMR-REC-054 closing incident %s needs a closure summary', v.reference);
  end if;
  if v.cert_in_reportable and v.cert_in_reported_at is null then
    raise exception using errcode = 'P0001', message = format('EBMR-REC-055 incident %s is CERT-In reportable; record the report before closing', v.reference);
  end if;
  insert into records.incident_event (incident_id, event_type, root_cause, capa_ref, closure_summary, actor_person, actor_account)
  values (v.id, 'CLOSED', nullif(btrim(coalesce(p_root_cause, '')), ''), nullif(btrim(coalesce(p_capa_ref, '')), ''), p_closure_summary,
          records.actor_person(), records.actor_account());
  for l in select distinct aggregate_type, aggregate_id from records.incident_link where incident_id = v.id loop
    perform records.bump_blocker_epoch(l.aggregate_type, l.aggregate_id);
  end loop;
end
$$;

-- CERT-In reportable incidents whose report is not recorded, with the deadline and whether it has passed.
create function records.pending_cert_in_reports()
returns table (incident_id uuid, reference text, deadline_at timestamptz, overdue boolean)
language sql stable security definer set search_path = pg_catalog, records, kernel as $$
  select id, reference, cert_in_deadline_at, cert_in_deadline_at < clock_timestamp()
  from records.incident_current
  where cert_in_reportable and cert_in_reported_at is null
  order by cert_in_deadline_at
$$;

select kernel.register_audited_table('records.incident', 'incident', 'id', true);
select kernel.register_audited_table('records.incident_link', 'incident', 'incident_id', true);
select kernel.register_audited_table('records.incident_event', 'incident', 'incident_id', true);
select kernel.register_audited_table('records.incident_assessment', 'incident', 'incident_id', true);

revoke all on records.incident, records.incident_link, records.incident_event, records.incident_assessment from ebmr_app;
grant select on records.incident, records.incident_link, records.incident_event, records.incident_assessment, records.incident_current to ebmr_app;
grant execute on function records.raise_incident(text, text, text, text, text, jsonb, timestamptz, text, boolean),
                          records.link_incident(uuid, text, text, text),
                          records.reclassify_incident(uuid, text, text),
                          records.start_incident_investigation(uuid, text),
                          records.mark_incident_cert_in_reportable(uuid, text),
                          records.record_cert_in_report(uuid, timestamptz, text),
                          records.assess_incident_impact(uuid, text, text, text, text, text),
                          records.close_incident(uuid, text, text, text),
                          records.pending_cert_in_reports(),
                          records.severity_rank(text),
                          records.cert_in_reporting_window() to ebmr_app;

reset role;
