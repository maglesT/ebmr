-- Records module (B4), part 5: disposition blockers, controlled purge, purge-aware verification (INV-22).
--
-- records.open_blockers lists what blocks the disposition (release) of a record and what blocks its
-- disposal: unassessed or open incidents, open DI investigations (linked, or with the person's
-- activity on the record or on its signature, challenge, retention or state chain inside the window),
-- and holds.
--
-- Purge (INV-22, DI-47, ADR 0007): only records.purge deletes GMP rows. It refuses for an aggregate
-- type no module declares for retention (0420, records.retention_aggregate), while retention is
-- OPEN, on or before retain-until (including the latest retain-until over every record that depends
-- on this one), while anything blocks disposal of the record or of any record depending on it,
-- without a matching QA approval by a person who entered none of the retention inputs or dependency
-- links that decide the date, or when the record's chain does not verify. It seals a checkpoint of
-- the record as kept (and, when the approval cites an archived true copy, requires that copy to cover
-- exactly this head and every table it deletes rows from), then deletes the
-- record's rows from every registered table of its aggregate type (each deletion is audited into the
-- record's chain), appends a business entry, seals a chain checkpoint (kernel.checkpoint_chain),
-- writes a tombstone (row counts and content digests per table, every event hash of the chain, the
-- checkpoint, retain-until, approval and executor), and finally removes the chain's events and head.
-- Other chains are untouched and keep verifying; records.verify_chain and records.verify_anchor
-- accept a purged chain against its tombstone.
--
-- Insert-only tables refuse DELETE through kernel.reject_mutation. Purge disables that one guard
-- trigger of the affected table for the duration of its own transaction (ALTER TABLE takes an
-- exclusive lock, so no other session ever sees the table without its guard; kernel.ddl_log records
-- both statements). The audit trigger stays enabled throughout.

set local role ebmr_owner;

-- ---------------------------------------------------------------------------------------------
-- Blockers
-- ---------------------------------------------------------------------------------------------

create function records.open_blockers(p_aggregate_type text, p_aggregate_id text)
returns table (blocker_kind text, blocker_id uuid, reference text, status text, severity text, detail text, since timestamptz,
               blocks_disposition boolean, blocks_disposal boolean)
language plpgsql stable security definer set search_path = pg_catalog, records, kernel, pg_temp as $$
declare
  v_key text := records.record_key(p_aggregate_type, p_aggregate_id);
begin
  return query
  select 'INCIDENT'::text, i.id, i.reference, i.status, i.severity, i.title, i.recorded_at,
         not exists (select 1 from records.incident_assessment a
                     where a.incident_id = i.id and a.aggregate_type = p_aggregate_type and a.aggregate_id = p_aggregate_id),
         true
  from records.incident_current i
  where i.status <> 'CLOSED'
    and exists (select 1 from records.incident_link l where l.incident_id = i.id and l.aggregate_type = p_aggregate_type and l.aggregate_id = p_aggregate_id)
  union all
  select 'DI_INVESTIGATION'::text, d.id, d.reference, d.status, null::text, d.concern, d.recorded_at, true, true
  from records.di_investigation_current d
  where d.status = 'OPEN'
    and (exists (select 1 from records.di_investigation_link l where l.investigation_id = d.id and l.record_key = v_key)
         -- The person's act inside the window on the record or on a chain that belongs to it (its
         -- signatures, challenges, retention, state: F30), even before the scope links it.
         or d.id in (select i.id from records.implicit_investigations(p_aggregate_type, p_aggregate_id) i(id)))
  union all
  select 'HOLD'::text, h.id, h.kind || coalesce(' ' || h.reference, ''), 'ACTIVE'::text, null::text, h.reason, h.recorded_at,
         h.kind = 'DI_INVESTIGATION', true
  from records.active_hold h
  where h.record_key = v_key
  order by 7, 3;
end
$$;

create function records.has_disposition_blockers(p_aggregate_type text, p_aggregate_id text) returns boolean
language sql stable security definer set search_path = pg_catalog, records, kernel, pg_temp as $$
  select exists (select 1 from records.open_blockers(p_aggregate_type, p_aggregate_id) b where b.blocks_disposition)
$$;

-- ---------------------------------------------------------------------------------------------
-- Retention status and eligibility
-- ---------------------------------------------------------------------------------------------

create view records.retention_current as
select s.id as schedule_id, s.record_key, s.aggregate_type, s.aggregate_id, s.record_type_code, s.record_type_version, s.retention_key,
       s.site_zone, i.input_version, i.inputs, e.rule_set_version, e.own, e.effective, e.effective_status, e.effective_retain_until,
       e.recorded_at as evaluated_at,
       exists (select 1 from records.active_hold h where h.record_key = s.record_key) as on_hold,
       t.id as tombstone_id, t.recorded_at as purged_at
from records.retention_schedule s
left join lateral (select * from records.retention_input x where x.schedule_id = s.id order by x.input_version desc limit 1) i on true
left join lateral (select * from records.retention_evaluation x where x.schedule_id = s.id order by x.id desc limit 1) e on true
left join records.tombstone t on t.record_key = s.record_key;

-- Why a record may not be disposed of now (empty = eligible). Recomputed from inputs and rules; never
-- read from stored evaluations.
create function records.disposal_refusals(p_schedule_id uuid)
returns table (code text, detail text)
language plpgsql stable security definer set search_path = pg_catalog, records, kernel, pg_temp as $$
declare
  v_sched records.retention_schedule%rowtype;
  v_eff jsonb := records.compute_effective_retention(p_schedule_id);
  v_today date;
  v_problem text;
  n record;
begin
  select * into v_sched from records.retention_schedule where id = p_schedule_id;
  v_today := (clock_timestamp() at time zone v_sched.site_zone)::date;
  if exists (select 1 from records.tombstone where record_key = v_sched.record_key) then
    code := 'EBMR-REC-023'; detail := format('%s has already been purged', v_sched.record_key); return next;
  end if;
  -- Only aggregate types declared for retention, under a retention key their module names (F29, F75).
  v_problem := records.retention_aggregate_problem(v_sched.aggregate_type, v_sched.retention_key);
  if v_problem is not null then
    code := split_part(v_problem, ' ', 1); detail := substr(v_problem, strpos(v_problem, ' ') + 1); return next;
  end if;
  if v_eff ->> 'status' = 'OPEN' then
    code := 'EBMR-REC-030'; detail := format('retention of %s is open: %s', v_sched.record_key, v_eff -> 'openBecause'); return next;
  elsif v_today <= (v_eff ->> 'retainUntil')::date then
    code := 'EBMR-REC-031'; detail := format('%s must be kept until %s (site date %s), governed by %s', v_sched.record_key,
                                             v_eff ->> 'retainUntil', v_today, v_eff -> 'governedBy'); return next;
  end if;
  for n in
    with recursive closure(schedule_id) as (
      select p_schedule_id
      union
      select d.dependant_schedule_id from records.retention_dependency d join closure c on d.supporting_schedule_id = c.schedule_id
    )
    select s.record_key, b.blocker_kind, b.reference
    from closure c
    join records.retention_schedule s on s.id = c.schedule_id
    cross join lateral records.open_blockers(s.aggregate_type, s.aggregate_id) b
    where b.blocks_disposal
    order by s.record_key, b.reference
  loop
    code := 'EBMR-REC-032';
    detail := format('%s %s blocks disposal%s', n.blocker_kind, n.reference,
                     case when n.record_key = v_sched.record_key then '' else ' of dependant ' || n.record_key end);
    return next;
  end loop;
end
$$;

create function records.retention_of(p_aggregate_type text, p_aggregate_id text) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, records, kernel, pg_temp as $$
declare
  v_sched records.retention_schedule%rowtype := records.schedule_for(records.record_key(p_aggregate_type, p_aggregate_id));
begin
  return jsonb_build_object(
    'recordKey', v_sched.record_key,
    'retentionKey', v_sched.retention_key,
    'siteZone', v_sched.site_zone,
    'siteDate', to_char((clock_timestamp() at time zone v_sched.site_zone)::date, 'YYYY-MM-DD'),
    'inputs', (records.latest_inputs(v_sched.id)).inputs,
    'own', records.own_retention(v_sched.id),
    'effective', records.compute_effective_retention(v_sched.id),
    'onHold', exists (select 1 from records.active_hold h where h.record_key = v_sched.record_key),
    'purged', exists (select 1 from records.tombstone t where t.record_key = v_sched.record_key),
    'refusals', coalesce((select jsonb_agg(jsonb_build_object('code', r.code, 'detail', r.detail)) from records.disposal_refusals(v_sched.id) r), '[]'::jsonb));
end
$$;

-- ---------------------------------------------------------------------------------------------
-- True-copy register
-- ---------------------------------------------------------------------------------------------

-- Registers a bundle from its manifest text (exactly as its SHA-256 covers it): the database computes
-- the SHA-256 itself and reads the chain key, head and table list from the manifest, so the register
-- entry says which tables the archived copy holds (F34), and a bundle can only be matched to an entry
-- whose manifest it carries byte for byte.
create function records.register_true_copy(p_manifest text, p_manifest_sha256 text, p_purpose text) returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, records, kernel, pg_temp as $$
declare
  v_manifest jsonb;
  v_chain text;
  v_type text;
  v_seq bigint;
  v_hash text;
  v_tables text[] := '{}';
  v_name text;
  t text;
  v_id uuid;
begin
  -- DI-18, then DI-17 installation-wide.
  perform iam.assert_not_administrator();
  perform iam.require_permission('RECORD.TRUE_COPY_REGISTER', '{}'::jsonb);
  if p_manifest is null or records.is_blank(p_purpose) then
    raise exception using errcode = 'P0001', message = 'EBMR-REC-070 a true copy needs its manifest and purpose';
  end if;
  if p_manifest_sha256 is distinct from encode(sha256(convert_to(p_manifest, 'UTF8')), 'hex') then
    raise exception using errcode = 'P0001', message = 'EBMR-REC-070 the manifest SHA-256 does not match the manifest';
  end if;
  begin
    v_manifest := p_manifest::jsonb;
    v_seq := (v_manifest -> 'head' ->> 'seq')::bigint;
  exception when others then
    raise exception using errcode = 'P0001', message = 'EBMR-REC-070 the manifest is not a true-copy manifest';
  end;
  v_chain := v_manifest ->> 'chainKey';
  v_type := v_manifest ->> 'aggregateType';
  v_hash := v_manifest -> 'head' ->> 'hash';
  if jsonb_typeof(v_manifest) <> 'object' or records.is_blank(v_manifest ->> 'format') or v_chain is null or v_type is null
     or v_chain <> v_type || ':' || coalesce(v_manifest ->> 'aggregateId', '') or v_seq is null or v_hash is null
     or jsonb_typeof(v_manifest -> 'tables') is distinct from 'array' then
    raise exception using errcode = 'P0001', message = 'EBMR-REC-070 the manifest does not name its chain, head and tables';
  end if;
  if not exists (select 1 from kernel.audit_event e where e.chain_key = v_chain and e.seq = v_seq and encode(e.hash, 'hex') = v_hash) then
    raise exception using errcode = 'P0001', message = format('EBMR-REC-070 %s has no event %s with that hash; the bundle does not match the record', v_chain, v_seq);
  end if;
  for t in select jsonb_array_elements_text(v_manifest -> 'tables') loop
    select pg_catalog.quote_ident(n.nspname) || '.' || pg_catalog.quote_ident(c.relname) into v_name
    from kernel.audited_table a
    join pg_catalog.pg_class c on c.oid = a.table_name
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where a.aggregate_type = v_type and a.table_name = pg_catalog.to_regclass(t);
    if v_name is null then
      raise exception using errcode = 'P0001', message = format('EBMR-REC-070 %s is not a registered table of aggregate type %s', t, v_type);
    end if;
    v_tables := v_tables || v_name;
    v_name := null;
  end loop;
  insert into records.true_copy (record_key, head_seq, head_hash, manifest_sha256, bundle_format, tables, purpose, created_by_person)
  values (v_chain, v_seq, decode(v_hash, 'hex'), p_manifest_sha256, v_manifest ->> 'format', v_tables, p_purpose, records.actor_person())
  returning id into v_id;
  return v_id;
end
$$;

-- ---------------------------------------------------------------------------------------------
-- Purge approval and purge
-- ---------------------------------------------------------------------------------------------

-- The persons whose entries decide when a record may be disposed of: whoever entered a version of the
-- retention inputs (the first version comes with the schedule) of the record or of any record that
-- depends on it, and whoever linked a dependency in that closure (a link can give an OPEN supporting
-- record its date). The disposal approval is the check on their entries, so none of them gives it
-- (F33, DI-47: retention is never shortened by one person alone).
create function records.retention_authors(p_schedule_id uuid) returns setof uuid
language sql stable security definer set search_path = pg_catalog, records, kernel, pg_temp as $$
  with recursive closure(schedule_id) as (
    select p_schedule_id
    union
    select d.dependant_schedule_id from records.retention_dependency d join closure c on d.supporting_schedule_id = c.schedule_id
  )
  select s.created_by_person from records.retention_schedule s join closure c on c.schedule_id = s.id
  union
  select i.entered_by_person from records.retention_input i join closure c on c.schedule_id = i.schedule_id
  union
  select d.linked_by_person from records.retention_dependency d join closure c on c.schedule_id = d.supporting_schedule_id
$$;

create function records.approve_purge(p_record_key text, p_approval_signature_id uuid, p_reason text, p_true_copy_id uuid default null)
returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, records, kernel, pg_temp as $$
declare
  v_sched records.retention_schedule%rowtype := records.schedule_for(p_record_key);
  v_refusal record;
  v_eff jsonb;
  v_id uuid;
begin
  if records.actor_is_machine() or p_approval_signature_id is null then
    raise exception using errcode = 'P0001', message = 'EBMR-REC-035 disposal is approved by a person with an approval signature';
  end if;
  -- DI-18, then DI-17 installation-wide.
  perform iam.assert_not_administrator();
  perform iam.require_permission('RECORD.DISPOSAL_APPROVE', '{}'::jsonb);
  if records.is_blank(p_reason) then
    raise exception using errcode = 'P0001', message = 'EBMR-REC-035 a disposal approval needs a reason';
  end if;
  perform 1 from records.retention_schedule where id = v_sched.id for update;
  select * into v_refusal from records.disposal_refusals(v_sched.id) limit 1;
  if found then
    raise exception using errcode = 'P0001', message = format('%s %s', v_refusal.code, v_refusal.detail);
  end if;
  if records.actor_person() in (select records.retention_authors(v_sched.id)) then
    raise exception using errcode = 'P0001',
      message = format('EBMR-REC-035 the approver entered retention inputs or dependency links that decide when %s may be disposed of; another person approves its disposal',
                       v_sched.record_key);
  end if;
  if p_true_copy_id is not null and not exists (select 1 from records.true_copy where id = p_true_copy_id and record_key = p_record_key) then
    raise exception using errcode = 'P0001', message = format('EBMR-REC-035 true copy %s is not a copy of %s', p_true_copy_id, p_record_key);
  end if;
  v_eff := records.compute_effective_retention(v_sched.id);
  -- DI-37: a valid RECORD_DISPOSAL_APPROVED signature of this record at this retain-until, with the cited
  -- true copy (0720), made by the approver.
  if (esig.assert_signature(p_approval_signature_id, 'RECORD_DISPOSAL_APPROVED', 'record_disposal',
                            v_sched.record_key || '@' || (v_eff ->> 'retainUntil') || coalesce('@' || p_true_copy_id::text, ''))
        ->> 'signer_person')::uuid is distinct from records.actor_person() then
    raise exception using errcode = 'P0001',
      message = format('EBMR-REC-039 the disposal-approval signature of %s was made by another person', v_sched.record_key);
  end if;
  insert into records.purge_approval (schedule_id, record_key, approved_by_person, approval_signature_id, reason, retain_until, true_copy_id)
  values (v_sched.id, v_sched.record_key, records.actor_person(), p_approval_signature_id, p_reason, (v_eff ->> 'retainUntil')::date, p_true_copy_id)
  returning id into v_id;
  return v_id;
end
$$;

-- Internal: the insert-only guard trigger of a registered table, if present. The name comes from the
-- kernel's one naming rule (kernel.required_triggers), which renders the table under the kernel's own
-- search_path: rendered here under records' search_path, a records table would lose its schema and
-- the guard of records.incident would never be found (F36).
create function records.insert_only_trigger(p_table regclass) returns text
language sql stable security definer set search_path = pg_catalog, records, kernel, pg_temp as $$
  select t.tgname::text
  from kernel.required_triggers(p_table, true) r
  join pg_catalog.pg_trigger t on t.tgrelid = p_table and t.tgname = r.trigger_name
  where r.purpose = 'NO_UPDATE_OR_DELETE'
$$;

create function records.purge(p_record_key text) returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, records, kernel, pg_temp as $$
declare
  v_ctx jsonb := records.actor();
  v_sched records.retention_schedule%rowtype := records.schedule_for(p_record_key);
  v_refusal record;
  v_eff jsonb;
  v_today date;
  v_approval records.purge_approval%rowtype;
  v_true_copy records.true_copy%rowtype;
  v_ids uuid[];
  t record;
  v_count bigint;
  v_digest text;
  v_tables jsonb := '[]'::jsonb;
  v_todo jsonb := '[]'::jsonb;
  v_next jsonb;
  x jsonb;
  v_trigger text;
  v_pass integer := 0;
  v_checkpoint bigint;
  v_head kernel.audit_chain_head%rowtype;
  v_kept kernel.audit_chain_head%rowtype;
  v_kept_checkpoint bigint;
  v_hashes bytea[];
  v_tombstone uuid;
  v_missing text;
begin
  -- Outline 5.4: every removal carries a reason code and a reason text (the audit trigger refuses the
  -- deletions without them; this says so before anything is locked).
  if records.is_blank(v_ctx ->> 'reason_code') or records.is_blank(v_ctx ->> 'reason_text') then
    raise exception using errcode = 'P0001', message = 'EBMR-REC-036 a purge needs a reason code and a reason text in the command context';
  end if;
  -- DI-18, then DI-17 installation-wide.
  perform iam.assert_not_administrator();
  perform iam.require_permission('RECORD.PURGE', '{}'::jsonb);
  -- Serialise with every change that could extend retention or add a blocker: the schedules of this
  -- record and of everything depending on it, and their blocker epochs (holds, incidents, investigations).
  with recursive closure(schedule_id) as (
    select v_sched.id
    union
    select d.dependant_schedule_id from records.retention_dependency d join closure c on d.supporting_schedule_id = c.schedule_id
  )
  select array_agg(schedule_id order by schedule_id) into v_ids from closure;
  perform 1 from records.retention_schedule where id = any(v_ids) order by id for update;
  perform records.lock_blocker_epoch_row(s.aggregate_type, s.aggregate_id)
  from records.retention_schedule s where s.id = any(v_ids) order by s.record_key;

  select * into v_refusal from records.disposal_refusals(v_sched.id) limit 1;
  if found then
    raise exception using errcode = 'P0001', message = format('%s %s', v_refusal.code, v_refusal.detail);
  end if;
  v_eff := records.compute_effective_retention(v_sched.id);
  v_today := (clock_timestamp() at time zone v_sched.site_zone)::date;

  -- The approval must still come from a person who entered none of the entries that decide the date
  -- (an approver who changed the inputs afterwards no longer counts: F33).
  select * into v_approval from records.purge_approval a
  where a.schedule_id = v_sched.id and a.retain_until = (v_eff ->> 'retainUntil')::date
    and a.approved_by_person not in (select records.retention_authors(v_sched.id))
  order by a.recorded_at desc limit 1;
  if not found then
    raise exception using errcode = 'P0001',
      message = format('EBMR-REC-033 no QA disposal approval for %s at its current retain-until %s by a person who entered none of its retention inputs or dependency links',
                       v_sched.record_key, v_eff ->> 'retainUntil');
  end if;
  if v_approval.true_copy_id is not null then
    select * into v_true_copy from records.true_copy where id = v_approval.true_copy_id;
  end if;

  if exists (select 1 from kernel.verify_chain(v_sched.record_key)) then
    raise exception using errcode = 'P0001', message = format('EBMR-REC-034 the audit chain of %s does not verify; it is not purged', v_sched.record_key);
  end if;

  -- Seal the record as kept before anything is deleted. An archived true copy cited by the approval
  -- must cover exactly this head, so the archive is complete at the moment of purge.
  select * into v_kept from kernel.audit_chain_head where chain_key = v_sched.record_key;
  if found then
    v_kept_checkpoint := kernel.checkpoint_chain(v_sched.record_key, 'retention purge: record as kept');
  end if;
  if v_true_copy.id is not null and (v_kept.last_seq is null or v_true_copy.head_seq <> v_kept.last_seq or v_true_copy.head_hash <> v_kept.last_hash) then
    raise exception using errcode = 'P0001',
      message = format('EBMR-REC-038 true copy %s covers %s up to seq %s, but the record now ends at seq %s; archive it again before purging',
                       v_true_copy.id, v_sched.record_key, v_true_copy.head_seq, v_kept.last_seq);
  end if;

  -- What is purged: row counts and a digest of the row hashes (the audit trigger's row hash: the
  -- canonical kernel.row_json form, the same whatever the session's TimeZone or DateStyle).
  for t in
    select pg_catalog.quote_ident(n.nspname) || '.' || pg_catalog.quote_ident(c.relname) as qualified, a.aggregate_column, a.insert_only
    from kernel.audited_table a
    join pg_catalog.pg_class c on c.oid = a.table_name
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where a.aggregate_type = v_sched.aggregate_type
    order by n.nspname collate "C", c.relname collate "C"
  loop
    execute format(
      'select count(*), encode(sha256(convert_to(coalesce(string_agg(h, E''\n'' order by h), ''''), ''UTF8'')), ''hex'')
         from (select encode(sha256(convert_to(kernel.row_json(x)::text, ''UTF8'')), ''hex'') as h from %s x where x.%I::text = $1) q',
      t.qualified, t.aggregate_column)
    into v_count, v_digest using v_sched.aggregate_id;
    if v_count > 0 then
      v_tables := v_tables || jsonb_build_array(jsonb_build_object('table', t.qualified, 'rowCount', v_count, 'rowsDigestSha256', v_digest));
      v_todo := v_todo || jsonb_build_array(jsonb_build_object('table', t.qualified, 'column', t.aggregate_column, 'insertOnly', t.insert_only));
    end if;
  end loop;

  -- The archived copy must hold every table whose rows are deleted: rows of an insert-only table live
  -- in the chain only as hashes, so a table left out of the copy would be lost for good (F34).
  if v_true_copy.id is not null then
    select string_agg(pt.e ->> 'table', ', ' order by pt.e ->> 'table') into v_missing
    from jsonb_array_elements(v_tables) pt(e)
    where not (pt.e ->> 'table') = any(v_true_copy.tables);
    if v_missing is not null then
      raise exception using errcode = 'P0001',
        message = format('EBMR-REC-038 true copy %s of %s leaves out %s, which hold rows of the record; archive every table of the record before purging',
                         v_true_copy.id, v_sched.record_key, v_missing);
    end if;
  end if;

  -- Delete, children before parents: a table whose rows are still referenced is retried in a later pass.
  while jsonb_array_length(v_todo) > 0 loop
    v_pass := v_pass + 1;
    if v_pass > 1 + jsonb_array_length(v_tables) then
      raise exception using errcode = 'P0001',
        message = format('EBMR-REC-037 rows of %s are still referenced by other records (%s); purge refused', v_sched.record_key, v_todo);
    end if;
    v_next := '[]'::jsonb;
    for x in select * from jsonb_array_elements(v_todo) loop
      begin
        v_trigger := case when (x ->> 'insertOnly')::boolean then records.insert_only_trigger((x ->> 'table')::regclass) end;
        if v_trigger is not null then
          execute format('alter table %s disable trigger %I', x ->> 'table', v_trigger);
        end if;
        execute format('delete from %s x where x.%I::text = $1', x ->> 'table', x ->> 'column') using v_sched.aggregate_id;
        if v_trigger is not null then
          execute format('alter table %s enable trigger %I', x ->> 'table', v_trigger);
        end if;
      exception when foreign_key_violation then
        v_next := v_next || jsonb_build_array(x);
      end;
    end loop;
    v_todo := v_next;
  end loop;

  perform kernel.audit_business_event(v_sched.record_key,
    format('record purged after retention (kept until %s; approval %s)', v_eff ->> 'retainUntil', v_approval.id),
    jsonb_build_object('purged_tables', v_tables, 'approval_id', v_approval.id, 'rule_set_version', records.current_retention_rule_set()));
  v_checkpoint := kernel.checkpoint_chain(v_sched.record_key, 'retention purge');
  select * into v_head from kernel.audit_chain_head where chain_key = v_sched.record_key;
  select array_agg(e.hash order by e.seq) into v_hashes from kernel.audit_event e where e.chain_key = v_sched.record_key;
  if cardinality(v_hashes) <> v_head.last_seq then
    raise exception using errcode = 'P0001', message = format('EBMR-REC-034 the audit chain of %s is incomplete; it is not purged', v_sched.record_key);
  end if;

  insert into records.tombstone (record_key, aggregate_type, aggregate_id, schedule_id, record_type_code, retention_key, rule_set_version,
                                 retain_until, effective_retention, purged_on_site_date, site_zone, approval_id, approved_by_person,
                                 approval_signature_id, true_copy_id, true_copy_manifest_sha256, executed_by_person, executed_by_source,
                                 reason_code, reason_text, purged_tables, chain_key, kept_head_seq, kept_head_hash, kept_checkpoint_id,
                                 chain_event_count, chain_head_hash, checkpoint_id, chain_event_hashes)
  values (v_sched.record_key, v_sched.aggregate_type, v_sched.aggregate_id, v_sched.id, v_sched.record_type_code, v_sched.retention_key,
          records.current_retention_rule_set(), (v_eff ->> 'retainUntil')::date, v_eff, v_today, v_sched.site_zone, v_approval.id,
          v_approval.approved_by_person, v_approval.approval_signature_id, v_approval.true_copy_id, v_true_copy.manifest_sha256,
          (v_ctx ->> 'person_id')::uuid, v_ctx ->> 'source', v_ctx ->> 'reason_code', v_ctx ->> 'reason_text', v_tables,
          v_sched.record_key, v_kept.last_seq, v_kept.last_hash, v_kept_checkpoint, v_head.last_seq, v_head.last_hash, v_checkpoint, v_hashes)
  returning id into v_tombstone;

  -- The audit trail follows its record (DI-47): the chain's events go; checkpoint and tombstone stay.
  delete from kernel.audit_event where chain_key = v_sched.record_key;
  delete from kernel.audit_chain_head where chain_key = v_sched.record_key;
  return v_tombstone;
end
$$;

-- ---------------------------------------------------------------------------------------------
-- Purge-aware verification
-- ---------------------------------------------------------------------------------------------

-- Like kernel.verify_chain, but a purged chain is checked against its tombstone and checkpoint.
-- Events written after the purge (for example a business entry) form a new chain from genesis.
create function records.verify_chain(p_chain_key text)
returns table (seq bigint, problem text)
language plpgsql stable security definer set search_path = pg_catalog, records, kernel, pg_temp as $$
declare
  t records.tombstone%rowtype;
begin
  select * into t from records.tombstone where chain_key = p_chain_key;
  if found then
    if not exists (select 1 from kernel.audit_checkpoint c
                   where c.chain_key = p_chain_key and c.seq = t.chain_event_count and c.hash = t.chain_head_hash) then
      seq := t.chain_event_count; problem := 'purged chain: checkpoint missing or different from the tombstone'; return next;
    end if;
    if cardinality(t.chain_event_hashes) <> t.chain_event_count or t.chain_event_hashes[t.chain_event_count] <> t.chain_head_hash then
      seq := t.chain_event_count; problem := 'purged chain: tombstone hash list is inconsistent'; return next;
    end if;
  end if;
  return query select v.seq, v.problem from kernel.verify_chain(p_chain_key) v;
end
$$;

-- Like kernel.verify_anchor, but an anchored head of a purged chain is matched against the tombstone.
-- A chain written again after its purge (a business entry, an incident link) starts over from genesis
-- under the same key, so a head anchored before the purge belongs to the purged chain and one anchored
-- after it to the new chain: a head verifies when it matches either the tombstone's event hash at that
-- sequence number or the live event there (F37). A different hash at both is reported.
create function records.verify_anchor(p_anchor_id bigint)
returns table (problem text)
language plpgsql stable security definer set search_path = pg_catalog, records, kernel, pg_temp as $$
declare
  a kernel.audit_anchor%rowtype;
  h jsonb;
  v_seq bigint;
  v_ok boolean;
begin
  select * into a from kernel.audit_anchor where id = p_anchor_id;
  if not found then problem := 'anchor not found'; return next; return; end if;
  if kernel.merkle_root(a.heads) <> a.merkle_root then
    problem := 'anchor root does not match its heads'; return next;
  end if;
  for h in select * from jsonb_array_elements(a.heads) loop
    v_seq := (h ->> 'seq')::bigint;
    v_ok := exists (select 1 from records.tombstone t
                    where t.chain_key = h ->> 'chain_key' and v_seq <= t.chain_event_count
                      and encode(t.chain_event_hashes[v_seq], 'hex') = h ->> 'hash_hex')
         or exists (select 1 from kernel.audit_event e
                    where e.chain_key = h ->> 'chain_key' and e.seq = v_seq and encode(e.hash, 'hex') = h ->> 'hash_hex');
    if not v_ok then
      problem := format('chain %s at seq %s differs from the anchor', h ->> 'chain_key', h ->> 'seq'); return next;
    end if;
  end loop;
end
$$;

-- ---------------------------------------------------------------------------------------------
-- INV-22 invariant query: must return zero rows (production runs it on a schedule)
-- ---------------------------------------------------------------------------------------------

create function records.inv22_violations()
returns table (check_name text, detail text)
language plpgsql stable security definer set search_path = pg_catalog, records, kernel, pg_temp as $$
declare
  t record;
  a record;
  v_rows bigint;
begin
  -- The application role must not be able to delete or truncate any registered GMP table.
  return query
  select 'APP_CAN_DELETE_GMP_ROWS'::text, a2.table_name::text
  from kernel.audited_table a2
  where has_table_privilege('ebmr_app', a2.table_name, 'DELETE') or has_table_privilege('ebmr_app', a2.table_name, 'TRUNCATE')
  order by 2;

  return query
  select 'PURGED_ON_OR_BEFORE_RETAIN_UNTIL'::text, tb.record_key from records.tombstone tb where tb.purged_on_site_date <= tb.retain_until;

  -- Only declared aggregate types under an allowed retention key are ever purged, and never a PERMANENT record (F29, F32, F75).
  return query
  select 'PURGED_UNDECLARED_AGGREGATE'::text, tb.record_key from records.tombstone tb
  where records.retention_aggregate_problem(tb.aggregate_type, tb.retention_key) is not null;
  return query
  select 'PURGED_PERMANENT_RECORD'::text, tb.record_key from records.tombstone tb where tb.retention_key = 'PERMANENT';

  return query
  select 'PURGED_WHILE_ON_HOLD'::text, tb.record_key || ' hold ' || h.id
  from records.tombstone tb
  join records.retention_hold h on h.record_key = tb.record_key and h.recorded_at < tb.recorded_at
  left join records.retention_hold_release r on r.hold_id = h.id
  where r.hold_id is null or r.recorded_at > tb.recorded_at;

  return query
  select 'PURGE_WITHOUT_CHECKPOINT'::text, tb.record_key
  from records.tombstone tb
  where not exists (select 1 from kernel.audit_checkpoint c
                    where c.chain_key = tb.chain_key and c.seq = tb.chain_event_count and c.hash = tb.chain_head_hash);

  -- Rows written to a purged record after its purge.
  return query
  select 'WRITE_AFTER_PURGE'::text, tb.record_key || ' ' || e.action || ' ' || coalesce(e.table_name, '')
  from records.tombstone tb
  join kernel.audit_event e on e.chain_key = tb.chain_key and e.action in ('INSERT', 'UPDATE', 'DELETE');

  for t in select tb.record_key, tb.aggregate_type, tb.aggregate_id from records.tombstone tb loop
    for a in select x.table_name, x.aggregate_column from kernel.audited_table x where x.aggregate_type = t.aggregate_type loop
      execute format('select count(*) from %s x where x.%I::text = $1', a.table_name, a.aggregate_column) into v_rows using t.aggregate_id;
      if v_rows > 0 then
        check_name := 'ROWS_REMAIN_AFTER_PURGE'; detail := format('%s %s (%s rows)', t.record_key, a.table_name, v_rows); return next;
      end if;
    end loop;
  end loop;
end
$$;

grant select on records.retention_current to ebmr_app;
grant execute on function records.open_blockers(text, text), records.has_disposition_blockers(text, text),
                          records.disposal_refusals(uuid), records.retention_of(text, text),
                          records.register_true_copy(text, text, text),
                          records.approve_purge(text, uuid, text, uuid), records.purge(text),
                          records.verify_chain(text), records.verify_anchor(bigint), records.inv22_violations() to ebmr_app;
-- records.insert_only_trigger and records.retention_authors stay private.

reset role;
