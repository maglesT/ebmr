-- Records module (B4), part 4: data-integrity investigations (DI-50).
--
-- A DI concern about a person is opened as an investigation for that person and a time window. The
-- scoping report (records.investigation_scope) lists every record the person created or changed in
-- the window, read from the audit trail (kernel.audit_event), with aggregate ids, across every chain.
-- Opening links every record in scope and places a DI-investigation hold on it (no purge, no
-- disposal); linked batches are blocked for disposition until the investigation closes
-- (records.open_blockers, part 5, also catches records the person touches in the window after the
-- investigation was opened). Closing needs a conclusion, the remediation, and an approver who is
-- neither the investigator nor the person investigated. All tables are insert-only.
--
-- A person's act on a record is not always written to the record's own chain: a signature or a
-- challenge goes to 'esig_signature:<record key>' / 'esig_challenge:<record key>' (esig 0220), a
-- retention change to 'retention:<record key>', a state transition to 'state:<id>' (platform 0550).
-- Scoping, linking, holding and blocking therefore resolve such a chain to the record it belongs to
-- (records.subject_of_chain, records.chains_of_record), so a verifier, witness or approver whose only
-- act is a signature still has the signed record linked, held and blocked (F30).
--
-- Not in this module: revoking the person's GMP rights at once (identity module, B1) and the QMS
-- route for tips and suspected falsification (the investigation stores the QMS reference).

set local role ebmr_owner;

create table records.di_investigation (
  id                   uuid primary key default gen_random_uuid(),
  investigation_no     bigint generated always as identity unique,
  subject_person_id    uuid not null,
  window_from          timestamptz not null,
  window_to            timestamptz not null,
  concern              text not null check (length(btrim(concern)) > 0),
  investigator_person  uuid not null,
  opened_by_person     uuid not null,
  qms_reference        text,
  recorded_at          timestamptz not null default clock_timestamp(),
  check (window_from < window_to),
  check (investigator_person <> subject_person_id),
  check (opened_by_person <> subject_person_id)
);

create table records.di_investigation_link (
  id                uuid primary key default gen_random_uuid(),
  investigation_id  uuid not null references records.di_investigation (id),
  record_key        text not null,
  aggregate_type    text not null,
  aggregate_id      text not null,
  link_source       text not null check (link_source in ('SCOPE', 'MANUAL')),
  note              text,
  linked_by_person  uuid not null,
  recorded_at       timestamptz not null default clock_timestamp(),
  unique (investigation_id, record_key),
  check (record_key = aggregate_type || ':' || aggregate_id)
);
create index di_investigation_link_record on records.di_investigation_link (record_key);

create table records.di_investigation_closure (
  investigation_id       uuid primary key references records.di_investigation (id),
  conclusion             text not null check (length(btrim(conclusion)) > 0),
  remediation            text not null check (length(btrim(remediation)) > 0),
  approved_by_person     uuid not null,
  approval_signature_id  uuid not null,
  recorded_at            timestamptz not null default clock_timestamp()
);

create view records.di_investigation_current as
select d.id, d.investigation_no, 'DII-' || lpad(d.investigation_no::text, 6, '0') as reference, d.subject_person_id, d.window_from,
       d.window_to, d.concern, d.investigator_person, d.opened_by_person, d.qms_reference, d.recorded_at,
       case when c.investigation_id is null then 'OPEN' else 'CLOSED' end as status,
       c.conclusion, c.remediation, c.approved_by_person, c.approval_signature_id, c.recorded_at as closed_at
from records.di_investigation d
left join records.di_investigation_closure c on c.investigation_id = d.id;

-- ---------------------------------------------------------------------------------------------
-- Scoping
-- ---------------------------------------------------------------------------------------------

-- Every record (row-level audit event) a person created or changed in [p_from, p_to), grouped per record.
create function records.person_activity(p_person_id uuid, p_from timestamptz, p_to timestamptz)
returns table (chain_key text, aggregate_type text, aggregate_id text, table_name text, record_id text, actions text[],
               event_count bigint, first_recorded_at timestamptz, last_recorded_at timestamptz)
language sql stable security definer set search_path = pg_catalog, records, kernel, pg_temp as $$
  select e.chain_key,
         split_part(e.chain_key, ':', 1),
         substr(e.chain_key, strpos(e.chain_key, ':') + 1),
         e.table_name,
         e.record_id,
         array_agg(distinct e.action order by e.action),
         count(*),
         min(e.recorded_at),
         max(e.recorded_at)
  from kernel.audit_event e
  where e.recorded_at >= p_from and e.recorded_at < p_to
    and e.action in ('INSERT', 'UPDATE', 'DELETE')
    and e.payload -> 'actor' ->> 'person_id' = p_person_id::text
  group by e.chain_key, e.table_name, e.record_id
  order by e.chain_key collate "C", e.table_name collate "C", e.record_id collate "C"
$$;

-- Derived chains whose aggregate id is the record key of the record they belong to.
create function records.derived_chain_types() returns text[]
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select array['esig_signature', 'esig_challenge', 'retention']
$$;

-- The record a derived chain belongs to (see the header), or nulls for any other chain.
create function records.subject_of_chain(p_chain_key text, out aggregate_type text, out aggregate_id text)
language plpgsql stable security definer set search_path = pg_catalog, records, kernel, pg_temp as $$
declare
  v_prefix text := split_part(p_chain_key, ':', 1);
  v_rest text := substr(p_chain_key, strpos(p_chain_key, ':') + 1);
begin
  if v_prefix = any(records.derived_chain_types()) and v_rest ~ '^[a-z][a-z0-9_]*:.' then
    aggregate_type := split_part(v_rest, ':', 1);
    aggregate_id := substr(v_rest, strpos(v_rest, ':') + 1);
  elsif v_prefix = 'state' and pg_catalog.to_regclass('platform.aggregate_state') is not null then
    execute 'select s.aggregate_type, s.aggregate_id::text from platform.aggregate_state s where s.aggregate_id::text = $1
             order by s.aggregate_type limit 1'
      into aggregate_type, aggregate_id using v_rest;
  end if;
end
$$;

-- Every chain that records acts on one record: its own chain and the derived chains that belong to it.
create function records.chains_of_record(p_aggregate_type text, p_aggregate_id text) returns text[]
language plpgsql stable security definer set search_path = pg_catalog, records, kernel, pg_temp as $$
declare
  v_key text := records.record_key(p_aggregate_type, p_aggregate_id);
  v_chains text[] := array[v_key] || array(select t || ':' || v_key from unnest(records.derived_chain_types()) t);
  v_state boolean := false;
begin
  if pg_catalog.to_regclass('platform.aggregate_state') is not null then
    execute 'select exists (select 1 from platform.aggregate_state s where s.aggregate_type = $1 and s.aggregate_id::text = $2)'
      into v_state using p_aggregate_type, p_aggregate_id;
    if v_state then
      v_chains := v_chains || ('state:' || p_aggregate_id);
    end if;
  end if;
  return v_chains;
end
$$;

create function records.investigation_scope(p_investigation_id uuid)
returns table (chain_key text, aggregate_type text, aggregate_id text, table_name text, record_id text, actions text[],
               event_count bigint, first_recorded_at timestamptz, last_recorded_at timestamptz)
language plpgsql stable security definer set search_path = pg_catalog, records, kernel, pg_temp as $$
declare
  v records.di_investigation%rowtype;
begin
  select * into v from records.di_investigation where id = p_investigation_id;
  if not found then
    raise exception using errcode = 'P0001', message = format('EBMR-REC-061 DI investigation %s does not exist', p_investigation_id);
  end if;
  return query select * from records.person_activity(v.subject_person_id, v.window_from, v.window_to);
end
$$;

-- Internal: link one record to an investigation and hold it.
create function records.add_investigation_link(p_investigation records.di_investigation_current, p_aggregate_type text, p_aggregate_id text,
                                               p_source text, p_note text) returns boolean
language plpgsql volatile security definer set search_path = pg_catalog, records, kernel, pg_temp as $$
declare
  v_key text := records.record_key(p_aggregate_type, p_aggregate_id);
begin
  perform records.lock_blocker_epoch_row(p_aggregate_type, p_aggregate_id);
  insert into records.di_investigation_link (investigation_id, record_key, aggregate_type, aggregate_id, link_source, note, linked_by_person)
  values (p_investigation.id, v_key, p_aggregate_type, p_aggregate_id, p_source, p_note, records.actor_person())
  on conflict do nothing;
  if not found then
    return false;
  end if;
  -- A record already purged cannot be held; the link still documents that it was in scope.
  if not exists (select 1 from records.tombstone t where t.record_key = v_key) then
    perform records.add_hold('DI_INVESTIGATION', p_aggregate_type, p_aggregate_id,
                             format('data-integrity investigation %s', p_investigation.reference), p_investigation.reference, p_investigation.id);
  end if;
  perform records.bump_blocker_epoch(p_aggregate_type, p_aggregate_id);
  return true;
end
$$;

-- Internal: link every record in the current scope that is not yet linked; returns how many were added.
-- A derived chain in scope links both the chain and the record it belongs to (F30).
create function records.link_investigation_scope(p_investigation records.di_investigation_current) returns integer
language plpgsql volatile security definer set search_path = pg_catalog, records, kernel, pg_temp as $$
declare
  r record;
  v_added integer := 0;
begin
  for r in
    with activity as (
      select distinct a.chain_key, a.aggregate_type, a.aggregate_id
      from records.person_activity(p_investigation.subject_person_id, p_investigation.window_from, p_investigation.window_to) a
    ), touched as (
      select a.aggregate_type, a.aggregate_id from activity a
      union
      select subj.aggregate_type, subj.aggregate_id
      from activity a cross join lateral records.subject_of_chain(a.chain_key) subj
      where subj.aggregate_type is not null
    )
    select t.aggregate_type, t.aggregate_id from touched t
    -- The investigation's own records are not evidence about the person.
    where t.aggregate_type not in ('di_investigation', 'record_hold')
    order by t.aggregate_type collate "C", t.aggregate_id collate "C"
  loop
    if records.add_investigation_link(p_investigation, r.aggregate_type, r.aggregate_id, 'SCOPE', null) then
      v_added := v_added + 1;
    end if;
  end loop;
  return v_added;
end
$$;

create function records.lock_di_investigation(p_investigation_id uuid) returns records.di_investigation_current
language plpgsql volatile security definer set search_path = pg_catalog, records, kernel, pg_temp as $$
declare
  v records.di_investigation_current%rowtype;
begin
  perform 1 from records.di_investigation where id = p_investigation_id for update;
  if not found then
    raise exception using errcode = 'P0001', message = format('EBMR-REC-061 DI investigation %s does not exist', p_investigation_id);
  end if;
  select * into v from records.di_investigation_current where id = p_investigation_id;
  return v;
end
$$;

-- The OPEN investigations whose person acted on the record (its own or a derived chain) inside the
-- window: the DI_INVESTIGATION blocker records.open_blockers shows even before the record is linked.
create function records.implicit_investigations(p_aggregate_type text, p_aggregate_id text) returns setof uuid
language sql stable security definer set search_path = pg_catalog, records, kernel, pg_temp as $$
  select d.id
  from records.di_investigation_current d
  where d.status = 'OPEN'
    and exists (select 1 from kernel.audit_event e
                where e.chain_key = any(records.chains_of_record(p_aggregate_type, p_aggregate_id))
                  and e.action in ('INSERT', 'UPDATE', 'DELETE')
                  and e.recorded_at >= d.window_from and e.recorded_at < d.window_to
                  and e.payload -> 'actor' ->> 'person_id' = d.subject_person_id::text)
  order by d.id
$$;

-- The release module's lock (outline 5.7): locks the record's blocker epoch inside the disposition
-- transaction and returns it. First it links and holds the record for every OPEN investigation that
-- blocks it implicitly but has not linked it yet (the person investigated wrote to it inside the window
-- after the investigation was opened or last refreshed). That makes the blocker explicit and moves the
-- epoch, so an epoch seen when open_blockers was evaluated before such a write never equals the one
-- locked after it (F35). The link is what records.refresh_di_investigation_scope would add; it is
-- written by the caller's command, and an administrator never writes it (DI-18).
create function records.lock_blocker_epoch(p_aggregate_type text, p_aggregate_id text) returns bigint
language plpgsql volatile security definer set search_path = pg_catalog, records, kernel, pg_temp as $$
declare
  v_key text := records.record_key(p_aggregate_type, p_aggregate_id);
  v_ids uuid[];
  v_id uuid;
  v records.di_investigation_current%rowtype;
begin
  if p_aggregate_type not in ('di_investigation', 'record_hold') then
    select array_agg(i.id order by i.id) into v_ids
    from records.implicit_investigations(p_aggregate_type, p_aggregate_id) i(id)
    where not exists (select 1 from records.di_investigation_link l where l.investigation_id = i.id and l.record_key = v_key);
  end if;
  if v_ids is not null then
    perform iam.assert_not_administrator();
    -- Investigation first, then the record's epoch: the order closing and refreshing take them in.
    foreach v_id in array v_ids loop
      v := records.lock_di_investigation(v_id);
      if v.status = 'OPEN' then
        perform records.add_investigation_link(v, p_aggregate_type, p_aggregate_id, 'SCOPE', null);
      end if;
    end loop;
  end if;
  return records.lock_blocker_epoch_row(p_aggregate_type, p_aggregate_id);
end
$$;

-- ---------------------------------------------------------------------------------------------
-- Public functions
-- ---------------------------------------------------------------------------------------------

-- p_links: extra records to link now, [{"aggregateType": "batch", "aggregateId": "...", "note": "..."}].
create function records.open_di_investigation(p_subject_person_id uuid, p_window_from timestamptz, p_window_to timestamptz, p_concern text,
                                              p_investigator_person uuid default null, p_qms_reference text default null,
                                              p_links jsonb default '[]'::jsonb) returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, records, kernel, pg_temp as $$
declare
  v_person uuid := records.actor_person();
  v_investigator uuid := coalesce(p_investigator_person, v_person);
  v_id uuid;
  v records.di_investigation_current%rowtype;
  l jsonb;
begin
  if records.actor_is_machine() then
    raise exception using errcode = 'P0001', message = 'EBMR-REC-060 a DI investigation is opened by a person';
  end if;
  -- DI-18, then DI-17 installation-wide.
  perform iam.assert_not_administrator();
  perform iam.require_permission('VALIDATION.MANAGE', '{}'::jsonb);
  if p_subject_person_id is null or p_window_from is null or p_window_to is null or p_window_from >= p_window_to then
    raise exception using errcode = 'P0001', message = 'EBMR-REC-060 a DI investigation needs the person and a time window that ends after it starts';
  end if;
  if records.is_blank(p_concern) then
    raise exception using errcode = 'P0001', message = 'EBMR-REC-060 a DI investigation needs the concern it investigates';
  end if;
  if v_person = p_subject_person_id or v_investigator = p_subject_person_id then
    raise exception using errcode = 'P0001', message = 'EBMR-REC-064 the person investigated cannot open or lead the investigation';
  end if;
  if p_links is null or jsonb_typeof(p_links) <> 'array' then
    raise exception using errcode = 'P0001', message = 'EBMR-REC-060 investigation links must be a JSON array';
  end if;
  insert into records.di_investigation (subject_person_id, window_from, window_to, concern, investigator_person, opened_by_person, qms_reference)
  values (p_subject_person_id, p_window_from, p_window_to, p_concern, v_investigator, v_person, nullif(btrim(coalesce(p_qms_reference, '')), ''))
  returning id into v_id;
  select * into v from records.di_investigation_current where id = v_id;
  perform records.link_investigation_scope(v);
  for l in select * from jsonb_array_elements(p_links) loop
    perform records.add_investigation_link(v, l ->> 'aggregateType', l ->> 'aggregateId', 'MANUAL', l ->> 'note');
  end loop;
  return v_id;
end
$$;

create function records.link_di_investigation(p_investigation_id uuid, p_aggregate_type text, p_aggregate_id text, p_note text) returns void
language plpgsql volatile security definer set search_path = pg_catalog, records, kernel, pg_temp as $$
declare
  v records.di_investigation_current%rowtype := records.lock_di_investigation(p_investigation_id);
begin
  -- DI-18, then DI-17 installation-wide.
  perform iam.assert_not_administrator();
  perform iam.require_permission('VALIDATION.MANAGE', '{}'::jsonb);
  if v.status <> 'OPEN' then
    raise exception using errcode = 'P0001', message = format('EBMR-REC-061 DI investigation %s is closed', v.reference);
  end if;
  if records.is_blank(p_note) then
    raise exception using errcode = 'P0001', message = 'EBMR-REC-060 a manual link needs a note saying why the record is linked';
  end if;
  perform records.add_investigation_link(v, p_aggregate_type, p_aggregate_id, 'MANUAL', p_note);
end
$$;

-- Re-reads the scope (for example while the window is still running) and links any new records.
create function records.refresh_di_investigation_scope(p_investigation_id uuid) returns integer
language plpgsql volatile security definer set search_path = pg_catalog, records, kernel, pg_temp as $$
declare
  v records.di_investigation_current%rowtype := records.lock_di_investigation(p_investigation_id);
begin
  -- DI-18, then DI-17 installation-wide.
  perform iam.assert_not_administrator();
  perform iam.require_permission('VALIDATION.MANAGE', '{}'::jsonb);
  if v.status <> 'OPEN' then
    raise exception using errcode = 'P0001', message = format('EBMR-REC-061 DI investigation %s is closed', v.reference);
  end if;
  return records.link_investigation_scope(v);
end
$$;

create function records.close_di_investigation(p_investigation_id uuid, p_conclusion text, p_remediation text, p_approval_signature_id uuid)
returns void
language plpgsql volatile security definer set search_path = pg_catalog, records, kernel, pg_temp as $$
declare
  v records.di_investigation_current%rowtype := records.lock_di_investigation(p_investigation_id);
  v_person uuid := records.actor_person();
  h records.retention_hold%rowtype;
begin
  -- DI-18, then DI-17 installation-wide.
  perform iam.assert_not_administrator();
  perform iam.require_permission('DI_INVESTIGATION.APPROVE_CLOSURE', '{}'::jsonb);
  if v.status <> 'OPEN' then
    raise exception using errcode = 'P0001', message = format('EBMR-REC-061 DI investigation %s is already closed', v.reference);
  end if;
  if records.is_blank(p_conclusion) or records.is_blank(p_remediation) then
    raise exception using errcode = 'P0001', message = format('EBMR-REC-062 closing %s needs a conclusion and the remediation', v.reference);
  end if;
  if p_approval_signature_id is null or records.actor_is_machine() then
    raise exception using errcode = 'P0001', message = format('EBMR-REC-063 closing %s needs the approval signature of a person', v.reference);
  end if;
  if v_person = v.investigator_person then
    raise exception using errcode = 'P0001', message = format('EBMR-REC-063 the investigator cannot approve the closure of %s', v.reference);
  end if;
  if v_person = v.subject_person_id then
    raise exception using errcode = 'P0001', message = format('EBMR-REC-063 the person investigated cannot approve the closure of %s', v.reference);
  end if;
  -- DI-37: a valid DI_INVESTIGATION_CLOSED signature of this investigation (0720), made by the approver.
  if (esig.assert_signature(p_approval_signature_id, 'DI_INVESTIGATION_CLOSED', 'di_investigation', v.id::text) ->> 'signer_person')::uuid
     is distinct from v_person then
    raise exception using errcode = 'P0001', message = format('EBMR-REC-065 the closure signature of %s was made by another person', v.reference);
  end if;
  -- The closure covers the whole scope: link anything that entered the window since the last refresh.
  perform records.link_investigation_scope(v);
  insert into records.di_investigation_closure (investigation_id, conclusion, remediation, approved_by_person, approval_signature_id)
  values (v.id, p_conclusion, p_remediation, v_person, p_approval_signature_id);
  for h in
    select * from records.retention_hold x
    where x.investigation_id = v.id and not exists (select 1 from records.retention_hold_release r where r.hold_id = x.id)
    order by x.record_key
  loop
    perform records.end_hold(h, format('data-integrity investigation %s closed', v.reference));
  end loop;
end
$$;

select kernel.register_audited_table('records.di_investigation', 'di_investigation', 'id', true);
select kernel.register_audited_table('records.di_investigation_link', 'di_investigation', 'investigation_id', true);
select kernel.register_audited_table('records.di_investigation_closure', 'di_investigation', 'investigation_id', true);

revoke all on records.di_investigation, records.di_investigation_link, records.di_investigation_closure from ebmr_app;
grant select on records.di_investigation, records.di_investigation_link, records.di_investigation_closure,
                records.di_investigation_current to ebmr_app;
grant execute on function records.person_activity(uuid, timestamptz, timestamptz),
                          records.investigation_scope(uuid),
                          records.lock_blocker_epoch(text, text),
                          records.open_di_investigation(uuid, timestamptz, timestamptz, text, uuid, text, jsonb),
                          records.link_di_investigation(uuid, text, text, text),
                          records.refresh_di_investigation_scope(uuid),
                          records.close_di_investigation(uuid, text, text, uuid) to ebmr_app;

reset role;
