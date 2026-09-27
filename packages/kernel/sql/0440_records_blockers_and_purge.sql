-- Records module (B4), part 5: disposition blockers, controlled purge, purge-aware verification (INV-22).
--
-- records.open_blockers lists what blocks the disposition (release) of a record and what blocks its
-- disposal: unassessed or open incidents, open DI investigations (linked, or with the person's
-- activity on the record inside the window), and holds.
--
-- Purge (INV-22, DI-47, ADR 0007): only records.purge deletes GMP rows. It refuses while retention is
-- OPEN, on or before retain-until (including the latest retain-until over every record that depends
-- on this one), while anything blocks disposal of the record or of any record depending on it,
-- without a matching QA approval, or when the record's chain does not verify. It then deletes the
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
language plpgsql stable security definer set search_path = pg_catalog, records, kernel as $$
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
         or exists (select 1 from kernel.audit_event e
                    where e.chain_key = v_key and e.action in ('INSERT', 'UPDATE', 'DELETE')
                      and e.recorded_at >= d.window_from and e.recorded_at < d.window_to
                      and e.payload -> 'actor' ->> 'person_id' = d.subject_person_id::text))
  union all
  select 'HOLD'::text, h.id, h.kind || coalesce(' ' || h.reference, ''), 'ACTIVE'::text, null::text, h.reason, h.recorded_at,
         h.kind = 'DI_INVESTIGATION', true
  from records.active_hold h
  where h.record_key = v_key
  order by 7, 3;
end
$$;

create function records.has_disposition_blockers(p_aggregate_type text, p_aggregate_id text) returns boolean
language sql stable security definer set search_path = pg_catalog, records, kernel as $$
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
language plpgsql stable security definer set search_path = pg_catalog, records, kernel as $$
declare
  v_sched records.retention_schedule%rowtype;
  v_eff jsonb := records.compute_effective_retention(p_schedule_id);
  v_today date;
  n record;
begin
  select * into v_sched from records.retention_schedule where id = p_schedule_id;
  v_today := (clock_timestamp() at time zone v_sched.site_zone)::date;
  if exists (select 1 from records.tombstone where record_key = v_sched.record_key) then
    code := 'EBMR-REC-023'; detail := format('%s has already been purged', v_sched.record_key); return next;
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
language plpgsql stable security definer set search_path = pg_catalog, records, kernel as $$
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

create function records.register_true_copy(p_chain_key text, p_head_seq bigint, p_head_hash_hex text, p_manifest_sha256 text,
                                           p_bundle_format text, p_purpose text) returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, records, kernel as $$
declare
  v_id uuid;
begin
  if p_manifest_sha256 is null or p_manifest_sha256 !~ '^[0-9a-f]{64}$' or records.is_blank(p_bundle_format) or records.is_blank(p_purpose) then
    raise exception using errcode = 'P0001', message = 'EBMR-REC-070 a true copy needs its manifest SHA-256, bundle format and purpose';
  end if;
  if not exists (select 1 from kernel.audit_event e where e.chain_key = p_chain_key and e.seq = p_head_seq and encode(e.hash, 'hex') = p_head_hash_hex) then
    raise exception using errcode = 'P0001', message = format('EBMR-REC-070 %s has no event %s with that hash; the bundle does not match the record', p_chain_key, p_head_seq);
  end if;
  insert into records.true_copy (record_key, head_seq, head_hash, manifest_sha256, bundle_format, purpose, created_by_person)
  values (p_chain_key, p_head_seq, decode(p_head_hash_hex, 'hex'), p_manifest_sha256, p_bundle_format, p_purpose, records.actor_person())
  returning id into v_id;
  return v_id;
end
$$;

-- ---------------------------------------------------------------------------------------------
-- Purge approval and purge
-- ---------------------------------------------------------------------------------------------

create function records.approve_purge(p_record_key text, p_approval_signature_id uuid, p_reason text, p_true_copy_id uuid default null)
returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, records, kernel as $$
declare
  v_sched records.retention_schedule%rowtype := records.schedule_for(p_record_key);
  v_refusal record;
  v_eff jsonb;
  v_id uuid;
begin
  if records.actor_is_machine() or p_approval_signature_id is null then
    raise exception using errcode = 'P0001', message = 'EBMR-REC-035 disposal is approved by a person with an approval signature';
  end if;
  if records.is_blank(p_reason) then
    raise exception using errcode = 'P0001', message = 'EBMR-REC-035 a disposal approval needs a reason';
  end if;
  perform 1 from records.retention_schedule where id = v_sched.id for update;
  select * into v_refusal from records.disposal_refusals(v_sched.id) limit 1;
  if found then
    raise exception using errcode = 'P0001', message = format('%s %s', v_refusal.code, v_refusal.detail);
  end if;
  if p_true_copy_id is not null and not exists (select 1 from records.true_copy where id = p_true_copy_id and record_key = p_record_key) then
    raise exception using errcode = 'P0001', message = format('EBMR-REC-035 true copy %s is not a copy of %s', p_true_copy_id, p_record_key);
  end if;
  v_eff := records.compute_effective_retention(v_sched.id);
  insert into records.purge_approval (schedule_id, record_key, approved_by_person, approval_signature_id, reason, retain_until, true_copy_id)
  values (v_sched.id, v_sched.record_key, records.actor_person(), p_approval_signature_id, p_reason, (v_eff ->> 'retainUntil')::date, p_true_copy_id)
  returning id into v_id;
  return v_id;
end
$$;

-- Internal: the insert-only guard trigger of a registered table, if present.
create function records.insert_only_trigger(p_table regclass) returns text
language sql stable security definer set search_path = pg_catalog, records, kernel as $$
  select t.tgname::text from pg_trigger t
  where t.tgrelid = p_table and t.tgname = 'aa_insert_only_' || replace(replace(p_table::text, '.', '_'), '"', '')
$$;

create function records.purge(p_record_key text) returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, records, kernel as $$
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
  v_hashes bytea[];
  v_tombstone uuid;
begin
  if records.is_blank(v_ctx ->> 'reason_code') then
    raise exception using errcode = 'P0001', message = 'EBMR-REC-036 a purge needs a reason code in the command context';
  end if;
  -- Serialise with every change that could extend retention or add a blocker: the schedules of this
  -- record and of everything depending on it, and their blocker epochs (holds, incidents, investigations).
  with recursive closure(schedule_id) as (
    select v_sched.id
    union
    select d.dependant_schedule_id from records.retention_dependency d join closure c on d.supporting_schedule_id = c.schedule_id
  )
  select array_agg(schedule_id order by schedule_id) into v_ids from closure;
  perform 1 from records.retention_schedule where id = any(v_ids) order by id for update;
  perform records.lock_blocker_epoch(s.aggregate_type, s.aggregate_id)
  from records.retention_schedule s where s.id = any(v_ids) order by s.record_key;

  select * into v_refusal from records.disposal_refusals(v_sched.id) limit 1;
  if found then
    raise exception using errcode = 'P0001', message = format('%s %s', v_refusal.code, v_refusal.detail);
  end if;
  v_eff := records.compute_effective_retention(v_sched.id);
  v_today := (clock_timestamp() at time zone v_sched.site_zone)::date;

  select * into v_approval from records.purge_approval a
  where a.schedule_id = v_sched.id and a.retain_until = (v_eff ->> 'retainUntil')::date
  order by a.recorded_at desc limit 1;
  if not found then
    raise exception using errcode = 'P0001',
      message = format('EBMR-REC-033 no QA disposal approval for %s at its current retain-until %s', v_sched.record_key, v_eff ->> 'retainUntil');
  end if;
  if v_approval.true_copy_id is not null then
    select * into v_true_copy from records.true_copy where id = v_approval.true_copy_id;
  end if;

  if exists (select 1 from kernel.verify_chain(v_sched.record_key)) then
    raise exception using errcode = 'P0001', message = format('EBMR-REC-034 the audit chain of %s does not verify; it is not purged', v_sched.record_key);
  end if;

  -- What is purged: row counts and a digest of the row hashes (same row hash as the audit trigger uses).
  for t in
    select a.table_name, a.aggregate_column, a.insert_only from kernel.audited_table a
    where a.aggregate_type = v_sched.aggregate_type order by a.table_name::text collate "C"
  loop
    execute format(
      'select count(*), encode(sha256(convert_to(coalesce(string_agg(h, E''\n'' order by h), ''''), ''UTF8'')), ''hex'')
         from (select encode(sha256(convert_to(to_jsonb(x)::text, ''UTF8'')), ''hex'') as h from %s x where x.%I::text = $1) q',
      t.table_name, t.aggregate_column)
    into v_count, v_digest using v_sched.aggregate_id;
    if v_count > 0 then
      v_tables := v_tables || jsonb_build_array(jsonb_build_object('table', t.table_name::text, 'rowCount', v_count, 'rowsDigestSha256', v_digest));
      v_todo := v_todo || jsonb_build_array(jsonb_build_object('table', t.table_name::text, 'column', t.aggregate_column, 'insertOnly', t.insert_only));
    end if;
  end loop;

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
          execute format('alter table %s disable trigger %I', (x ->> 'table')::regclass, v_trigger);
        end if;
        execute format('delete from %s x where x.%I::text = $1', (x ->> 'table')::regclass, x ->> 'column') using v_sched.aggregate_id;
        if v_trigger is not null then
          execute format('alter table %s enable trigger %I', (x ->> 'table')::regclass, v_trigger);
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
                                 reason_code, reason_text, purged_tables, chain_key, chain_event_count, chain_head_hash, checkpoint_id,
                                 chain_event_hashes)
  values (v_sched.record_key, v_sched.aggregate_type, v_sched.aggregate_id, v_sched.id, v_sched.record_type_code, v_sched.retention_key,
          records.current_retention_rule_set(), (v_eff ->> 'retainUntil')::date, v_eff, v_today, v_sched.site_zone, v_approval.id,
          v_approval.approved_by_person, v_approval.approval_signature_id, v_approval.true_copy_id, v_true_copy.manifest_sha256,
          (v_ctx ->> 'person_id')::uuid, v_ctx ->> 'source', v_ctx ->> 'reason_code', v_ctx ->> 'reason_text', v_tables,
          v_sched.record_key, v_head.last_seq, v_head.last_hash, v_checkpoint, v_hashes)
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
language plpgsql stable security definer set search_path = pg_catalog, records, kernel as $$
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
create function records.verify_anchor(p_anchor_id bigint)
returns table (problem text)
language plpgsql stable security definer set search_path = pg_catalog, records, kernel as $$
declare
  a kernel.audit_anchor%rowtype;
  h jsonb;
  v_seq bigint;
  v_hash bytea;
  t records.tombstone%rowtype;
begin
  select * into a from kernel.audit_anchor where id = p_anchor_id;
  if not found then problem := 'anchor not found'; return next; return; end if;
  if kernel.merkle_root(a.heads) <> a.merkle_root then
    problem := 'anchor root does not match its heads'; return next;
  end if;
  for h in select * from jsonb_array_elements(a.heads) loop
    v_seq := (h ->> 'seq')::bigint;
    select * into t from records.tombstone where chain_key = h ->> 'chain_key';
    if found and v_seq <= t.chain_event_count then
      v_hash := t.chain_event_hashes[v_seq];
    else
      v_hash := null;
      select e.hash into v_hash from kernel.audit_event e where e.chain_key = h ->> 'chain_key' and e.seq = v_seq;
    end if;
    if v_hash is null or encode(v_hash, 'hex') <> h ->> 'hash_hex' then
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
language plpgsql stable security definer set search_path = pg_catalog, records, kernel as $$
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
                          records.register_true_copy(text, bigint, text, text, text, text),
                          records.approve_purge(text, uuid, text, uuid), records.purge(text),
                          records.verify_chain(text), records.verify_anchor(bigint), records.inv22_violations() to ebmr_app;
-- records.insert_only_trigger stays private.

reset role;
