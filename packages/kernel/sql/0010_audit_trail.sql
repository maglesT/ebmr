-- Audit trail (build outline 5.4; ADR 0007; controls DI-22, DI-23, DI-24; invariants INV-06, INV-07,
-- INV-08, INV-16).
--
-- Every change to a registered GMP table writes an audit event in the same transaction. Events form
-- per-aggregate hash chains: hash = sha256(prev_hash || canonical payload). The application must
-- declare who is acting (kernel.begin_command) before any GMP write; without that context the write
-- fails. Changes after first entry need a reason. Only kernel functions owned by ebmr_owner can write
-- audit rows; the application role cannot insert, update or delete them.

set local role ebmr_owner;

-- ---------------------------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------------------------

create table kernel.audited_table (
  table_name        regclass primary key,
  aggregate_type    text not null check (aggregate_type ~ '^[a-z][a-z0-9_]*$'),
  aggregate_column  text not null,
  insert_only       boolean not null,
  registered_at     timestamptz not null default clock_timestamp()
);

create table kernel.audit_chain_head (
  chain_key   text primary key,
  last_seq    bigint not null check (last_seq >= 1),
  last_hash   bytea not null,
  last_event  bigint not null
);

create table kernel.audit_event (
  id              bigint generated always as identity primary key,
  chain_key       text not null,
  seq             bigint not null check (seq >= 1),
  prev_hash       bytea not null,
  hash            bytea not null,
  recorded_at     timestamptz not null,
  correlation_id  uuid not null,
  action          text not null check (action in ('INSERT', 'UPDATE', 'DELETE', 'BUSINESS', 'CHECKPOINT')),
  table_name      text,
  record_id       text,
  payload         jsonb not null,
  unique (chain_key, seq)
);
create index audit_event_correlation on kernel.audit_event (correlation_id);
create index audit_event_record on kernel.audit_event (table_name, record_id);
create index audit_event_recorded on kernel.audit_event (recorded_at);

create table kernel.audit_checkpoint (
  id          bigint generated always as identity primary key,
  chain_key   text not null,
  seq         bigint not null,
  hash        bytea not null,
  event_count bigint not null,
  sealed_at   timestamptz not null default clock_timestamp(),
  reason      text not null,
  unique (chain_key, seq)
);

-- Anchors: periodic Merkle roots over all chain heads. A copy goes to write-once storage outside
-- the database, so rewriting rows inside the database cannot match both copies.
create table kernel.audit_anchor (
  id           bigint generated always as identity primary key,
  created_at   timestamptz not null default clock_timestamp(),
  heads        jsonb not null,          -- [{chain_key, seq, hash_hex}] sorted by chain_key
  merkle_root  bytea not null,
  head_count   integer not null
);

-- Record of DDL on the database, so a disabled trigger or altered table is visible afterwards.
create table kernel.ddl_log (
  id            bigint generated always as identity primary key,
  recorded_at   timestamptz not null default clock_timestamp(),
  session_user_name text not null,
  command_tag   text not null,
  object_identity text
);

-- ---------------------------------------------------------------------------------------------
-- Actor context
-- ---------------------------------------------------------------------------------------------

-- Hook the identity module replaces (CREATE OR REPLACE) to check that the account, session, device
-- and authentication event are real and active. The foundation checks shape only.
create function kernel.validate_actor_context(p_ctx jsonb) returns void
language plpgsql stable security definer set search_path = pg_catalog, kernel, pg_temp as $$
begin
  return;
end
$$;

create function kernel.begin_command(p_ctx jsonb) returns void
language plpgsql volatile security definer set search_path = pg_catalog, kernel, pg_temp as $$
declare
  k text;
begin
  if p_ctx is null or jsonb_typeof(p_ctx) <> 'object' then
    raise exception using errcode = 'P0001', message = 'EBMR-AUDIT-001 actor context is required';
  end if;
  foreach k in array array['person_id', 'account_id', 'role_code', 'session_id', 'correlation_id', 'source', 'site_zone'] loop
    if coalesce(p_ctx ->> k, '') = '' then
      raise exception using errcode = 'P0001', message = format('EBMR-AUDIT-001 actor context is missing %s', k);
    end if;
  end loop;
  if (p_ctx ->> 'source') not in ('UI', 'API', 'INTEGRATION', 'SYSTEM') then
    raise exception using errcode = 'P0001', message = 'EBMR-AUDIT-001 actor context source must be UI, API, INTEGRATION or SYSTEM';
  end if;
  perform (p_ctx ->> 'correlation_id')::uuid;
  perform kernel.validate_actor_context(p_ctx);
  if not kernel.audit_triggers_ok() then
    raise exception using errcode = 'P0001', message = 'EBMR-AUDIT-005 an audit trigger is missing or disabled; GMP writes are refused';
  end if;
  perform kernel.set_actor_context(p_ctx);
end
$$;

-- The actor context lives in the transaction-local setting ebmr.ctx, which any session can write
-- with set_config. It counts only if kernel code established it in this transaction: every context
-- that kernel.set_actor_context installs leaves a marker (transaction, backend, context hash) in a
-- table only ebmr_owner can write. current_actor() ignores a context without its marker, and the
-- audit writer refuses it, so set_config alone can never attribute a write to anyone.
create unlogged table kernel.command_marker (
  xact_id     xid8    not null,
  backend_pid integer not null,
  ctx_hash    bytea   not null,
  primary key (xact_id, backend_pid, ctx_hash)
);

create function kernel.context_hash(p_ctx jsonb) returns bytea
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select sha256(convert_to(p_ctx::text, 'UTF8'))
$$;

-- Owner-only: installs p_ctx as the validated actor context of this transaction (NULL clears it).
-- Module SECURITY DEFINER code that must switch context inside a command (an internal actor, an
-- added reason) calls this instead of set_config. Markers of this backend's finished transactions
-- are pruned on the way, so the table holds at most a few rows per connection.
create function kernel.set_actor_context(p_ctx jsonb) returns void
language plpgsql volatile security definer set search_path = pg_catalog, kernel, pg_temp as $$
begin
  if p_ctx is null then
    perform set_config('ebmr.ctx', '', true);
    return;
  end if;
  delete from kernel.command_marker m
  where m.backend_pid = pg_backend_pid() and m.xact_id <> pg_current_xact_id();
  insert into kernel.command_marker (xact_id, backend_pid, ctx_hash)
  values (pg_current_xact_id(), pg_backend_pid(), kernel.context_hash(p_ctx))
  on conflict do nothing;
  perform set_config('ebmr.ctx', p_ctx::text, true);
end
$$;

-- True when ebmr.ctx holds a context kernel code established in this transaction.
create function kernel.actor_context_validated() returns boolean
language plpgsql volatile security definer set search_path = pg_catalog, kernel, pg_temp as $$
declare
  v_raw  text := coalesce(current_setting('ebmr.ctx', true), '');
  v_xact xid8 := pg_current_xact_id_if_assigned();
  v_ctx  jsonb;
begin
  if v_raw = '' or v_xact is null then
    return false;
  end if;
  begin
    v_ctx := v_raw::jsonb;
  exception when others then
    return false;
  end;
  return exists (
    select 1 from kernel.command_marker m
    where m.xact_id = v_xact and m.backend_pid = pg_backend_pid() and m.ctx_hash = kernel.context_hash(v_ctx));
end
$$;

-- The validated actor context, or NULL when there is none or it was not established by kernel code.
create function kernel.current_actor() returns jsonb
language sql volatile security definer set search_path = pg_catalog, kernel, pg_temp as $$
  select case when kernel.actor_context_validated() then current_setting('ebmr.ctx', true)::jsonb end
$$;

-- ---------------------------------------------------------------------------------------------
-- Chain append (the only writer of audit_event)
-- ---------------------------------------------------------------------------------------------

create function kernel.append_audit_event(
  p_chain_key text, p_action text, p_table text, p_record text, p_body jsonb
) returns bigint
language plpgsql volatile security definer set search_path = pg_catalog, kernel, pg_temp as $$
declare
  v_ctx      jsonb := kernel.current_actor();
  v_head     kernel.audit_chain_head%rowtype;
  v_seq      bigint;
  v_prev     bytea;
  v_at       timestamptz := clock_timestamp();
  v_payload  jsonb;
  v_hash     bytea;
  v_id       bigint;
begin
  if v_ctx is null then
    if coalesce(current_setting('ebmr.ctx', true), '') <> '' then
      raise exception using errcode = 'P0001', message = 'EBMR-AUDIT-009 the actor context was not established by kernel.begin_command in this transaction';
    end if;
    raise exception using errcode = 'P0001', message = 'EBMR-AUDIT-001 no actor context: call kernel.begin_command first';
  end if;
  select * into v_head from kernel.audit_chain_head where chain_key = p_chain_key for update;
  if found then
    v_seq := v_head.last_seq + 1;
    v_prev := v_head.last_hash;
  else
    v_seq := 1;
    v_prev := sha256(convert_to('genesis:' || p_chain_key, 'UTF8'));
  end if;
  v_payload := jsonb_build_object(
    'chain_key', p_chain_key,
    'seq', v_seq,
    'recorded_at', to_char(v_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'site_zone', v_ctx ->> 'site_zone',
    'action', p_action,
    'table', p_table,
    'record_id', p_record,
    'actor', jsonb_build_object(
      'person_id', v_ctx ->> 'person_id', 'account_id', v_ctx ->> 'account_id', 'role_code', v_ctx ->> 'role_code',
      'session_id', v_ctx ->> 'session_id', 'device_id', v_ctx ->> 'device_id', 'auth_event_id', v_ctx ->> 'auth_event_id',
      'legal_name', v_ctx ->> 'legal_name'),
    'source', v_ctx ->> 'source',
    'correlation_id', v_ctx ->> 'correlation_id',
    'reason_code', v_ctx ->> 'reason_code',
    'reason_text', v_ctx ->> 'reason_text',
    'body', p_body);
  v_hash := sha256(v_prev || convert_to(v_payload::text, 'UTF8'));
  insert into kernel.audit_event (chain_key, seq, prev_hash, hash, recorded_at, correlation_id, action, table_name, record_id, payload)
  values (p_chain_key, v_seq, v_prev, v_hash, v_at, (v_ctx ->> 'correlation_id')::uuid, p_action, p_table, p_record, v_payload)
  returning id into v_id;
  insert into kernel.audit_chain_head (chain_key, last_seq, last_hash, last_event)
  values (p_chain_key, v_seq, v_hash, v_id)
  on conflict (chain_key) do update set last_seq = excluded.last_seq, last_hash = excluded.last_hash, last_event = excluded.last_event;
  return v_id;
end
$$;

-- Plain-language business entry with the same correlation ID as the row-level entries (5.4).
create function kernel.audit_business_event(p_chain_key text, p_message text, p_details jsonb default '{}'::jsonb)
returns bigint
language plpgsql volatile security definer set search_path = pg_catalog, kernel, pg_temp as $$
begin
  if coalesce(trim(p_message), '') = '' then
    raise exception using errcode = 'P0001', message = 'EBMR-AUDIT-006 a business audit entry needs a message';
  end if;
  return kernel.append_audit_event(p_chain_key, 'BUSINESS', null, null, jsonb_build_object('message', p_message, 'details', p_details));
end
$$;

-- ---------------------------------------------------------------------------------------------
-- Row triggers
-- ---------------------------------------------------------------------------------------------

create function kernel.audit_row_change() returns trigger
language plpgsql volatile security definer set search_path = pg_catalog, kernel, pg_temp as $$
declare
  v_reg    kernel.audited_table%rowtype;
  v_row    jsonb;
  v_old    jsonb;
  v_key    text;
  v_ctx    jsonb := kernel.current_actor();
  v_body   jsonb;
  v_record text;
begin
  select * into v_reg from kernel.audited_table where table_name = tg_relid;
  if not found then
    raise exception using errcode = 'P0001', message = format('EBMR-AUDIT-003 %s is not registered for audit', tg_relid::regclass);
  end if;
  if v_ctx is null then
    if coalesce(current_setting('ebmr.ctx', true), '') <> '' then
      raise exception using errcode = 'P0001', message = 'EBMR-AUDIT-009 the actor context was not established by kernel.begin_command in this transaction';
    end if;
    raise exception using errcode = 'P0001', message = 'EBMR-AUDIT-001 no actor context: call kernel.begin_command first';
  end if;
  if tg_op in ('UPDATE', 'DELETE') and coalesce(v_ctx ->> 'reason_code', '') = '' then
    raise exception using errcode = 'P0001', message = format('EBMR-AUDIT-002 a reason is required to %s %s', lower(tg_op), tg_relid::regclass);
  end if;
  v_row := case when tg_op = 'DELETE' then to_jsonb(old) else to_jsonb(new) end;
  v_old := case when tg_op = 'UPDATE' then to_jsonb(old) else null end;
  v_key := v_reg.aggregate_type || ':' || coalesce(v_row ->> v_reg.aggregate_column, '?');
  v_record := coalesce(v_row ->> 'id', v_row ->> v_reg.aggregate_column);
  if v_reg.insert_only then
    v_body := jsonb_build_object('row_hash', encode(sha256(convert_to(v_row::text, 'UTF8')), 'hex'));
  elsif tg_op = 'UPDATE' then
    v_body := jsonb_build_object('old', (select jsonb_object_agg(key, value) from jsonb_each(v_old) where v_row -> key is distinct from value),
                                 'new', (select jsonb_object_agg(key, value) from jsonb_each(v_row) where v_old -> key is distinct from value));
  else
    v_body := jsonb_build_object(case when tg_op = 'DELETE' then 'old' else 'new' end, v_row);
  end if;
  perform kernel.append_audit_event(v_key, tg_op, tg_relid::regclass::text, v_record, v_body);
  return null;
end
$$;

create function kernel.reject_mutation() returns trigger
language plpgsql security definer set search_path = pg_catalog, kernel, pg_temp as $$
begin
  raise exception using errcode = 'P0001',
    message = format('EBMR-AUDIT-004 %s is insert-only; record a correction instead of %s', tg_relid::regclass, lower(tg_op));
end
$$;

create function kernel.register_audited_table(p_table regclass, p_aggregate_type text, p_aggregate_column text, p_insert_only boolean)
returns void
language plpgsql volatile security definer set search_path = pg_catalog, kernel, pg_temp as $$
declare
  v_name text := p_table::text;
  v_trigger text := 'zz_audit_' || replace(replace(v_name, '.', '_'), '"', '');
begin
  insert into kernel.audited_table (table_name, aggregate_type, aggregate_column, insert_only)
  values (p_table, p_aggregate_type, p_aggregate_column, p_insert_only);
  execute format('create trigger %I after insert or update or delete on %s for each row execute function kernel.audit_row_change()', v_trigger, v_name);
  if p_insert_only then
    execute format('create trigger %I before update or delete on %s for each row execute function kernel.reject_mutation()',
                   'aa_insert_only_' || replace(replace(v_name, '.', '_'), '"', ''), v_name);
    execute format('create trigger %I before truncate on %s for each statement execute function kernel.reject_mutation()',
                   'aa_no_truncate_' || replace(replace(v_name, '.', '_'), '"', ''), v_name);
  end if;
end
$$;

-- DI-23: every registered table must have its audit trigger present and enabled.
create function kernel.audit_triggers_ok() returns boolean
language sql stable security definer set search_path = pg_catalog, kernel, pg_temp as $$
  select not exists (
    select 1
    from kernel.audited_table a
    where not exists (
      select 1 from pg_catalog.pg_trigger t
      where t.tgrelid = a.table_name
        and t.tgname = 'zz_audit_' || replace(replace(a.table_name::text, '.', '_'), '"', '')
        and t.tgenabled in ('O', 'A')
    )
  )
$$;

-- ---------------------------------------------------------------------------------------------
-- Verification, checkpoints and anchors
-- ---------------------------------------------------------------------------------------------

create function kernel.verify_chain(p_chain_key text, p_from_seq bigint default 1)
returns table (seq bigint, problem text)
language plpgsql stable security definer set search_path = pg_catalog, kernel, pg_temp as $$
declare
  r        kernel.audit_event%rowtype;
  v_prev   bytea;
  v_expect bigint := p_from_seq;
  v_head   kernel.audit_chain_head%rowtype;
begin
  if p_from_seq = 1 then
    v_prev := sha256(convert_to('genesis:' || p_chain_key, 'UTF8'));
  else
    select e.hash into v_prev from kernel.audit_event e where e.chain_key = p_chain_key and e.seq = p_from_seq - 1;
  end if;
  for r in select * from kernel.audit_event e where e.chain_key = p_chain_key and e.seq >= p_from_seq order by e.seq loop
    if r.seq <> v_expect then
      seq := v_expect; problem := format('gap: expected seq %s, found %s', v_expect, r.seq); return next;
    end if;
    if r.prev_hash is distinct from v_prev then
      seq := r.seq; problem := 'prev_hash does not match the previous event'; return next;
    end if;
    if r.hash <> sha256(r.prev_hash || convert_to(r.payload::text, 'UTF8')) then
      seq := r.seq; problem := 'hash does not match the payload (event altered)'; return next;
    end if;
    if (r.payload ->> 'seq')::bigint <> r.seq or r.payload ->> 'chain_key' <> r.chain_key
       or r.payload ->> 'action' <> r.action or (r.payload ->> 'correlation_id')::uuid <> r.correlation_id
       or r.payload ->> 'recorded_at' <> to_char(r.recorded_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') then
      seq := r.seq; problem := 'indexed columns differ from the hashed payload'; return next;
    end if;
    v_prev := r.hash;
    v_expect := r.seq + 1;
  end loop;
  select * into v_head from kernel.audit_chain_head h where h.chain_key = p_chain_key;
  if found and (v_head.last_seq <> v_expect - 1 or v_head.last_hash is distinct from v_prev) then
    seq := v_head.last_seq; problem := 'chain head does not match the last event (events removed or head altered)'; return next;
  end if;
  return;
end
$$;

create function kernel.checkpoint_chain(p_chain_key text, p_reason text) returns bigint
language plpgsql volatile security definer set search_path = pg_catalog, kernel, pg_temp as $$
declare
  v_head kernel.audit_chain_head%rowtype;
  v_id bigint;
begin
  if exists (select 1 from kernel.verify_chain(p_chain_key)) then
    raise exception using errcode = 'P0001', message = format('EBMR-AUDIT-007 chain %s does not verify; it cannot be checkpointed', p_chain_key);
  end if;
  select * into v_head from kernel.audit_chain_head where chain_key = p_chain_key for update;
  if not found then
    raise exception using errcode = 'P0001', message = format('EBMR-AUDIT-008 chain %s has no events', p_chain_key);
  end if;
  insert into kernel.audit_checkpoint (chain_key, seq, hash, event_count, reason)
  values (p_chain_key, v_head.last_seq, v_head.last_hash, v_head.last_seq, p_reason)
  on conflict (chain_key, seq) do nothing
  returning id into v_id;
  return v_id;
end
$$;

-- Merkle root over sorted chain heads: leaf = sha256(chain_key || ':' || seq || ':' || hash_hex);
-- pairs hashed upward; an odd node is carried up unchanged.
create function kernel.merkle_root(p_heads jsonb) returns bytea
language plpgsql immutable set search_path = pg_catalog, pg_temp as $$
declare
  level bytea[];
  nxt bytea[];
  i int;
begin
  select coalesce(array_agg(sha256(convert_to((h ->> 'chain_key') || ':' || (h ->> 'seq') || ':' || (h ->> 'hash_hex'), 'UTF8'))
                  order by h ->> 'chain_key'), '{}')
  into level
  from jsonb_array_elements(p_heads) h;
  if coalesce(array_length(level, 1), 0) = 0 then
    return sha256(''::bytea);
  end if;
  while array_length(level, 1) > 1 loop
    nxt := '{}';
    i := 1;
    while i <= array_length(level, 1) loop
      if i + 1 <= array_length(level, 1) then
        nxt := nxt || sha256(level[i] || level[i + 1]);
      else
        nxt := nxt || level[i];
      end if;
      i := i + 2;
    end loop;
    level := nxt;
  end loop;
  return level[1];
end
$$;

create function kernel.create_anchor() returns bigint
language plpgsql volatile security definer set search_path = pg_catalog, kernel, pg_temp as $$
declare
  v_heads jsonb;
  v_id bigint;
begin
  select coalesce(jsonb_agg(jsonb_build_object('chain_key', chain_key, 'seq', last_seq, 'hash_hex', encode(last_hash, 'hex')) order by chain_key), '[]'::jsonb)
  into v_heads from kernel.audit_chain_head;
  insert into kernel.audit_anchor (heads, merkle_root, head_count)
  values (v_heads, kernel.merkle_root(v_heads), jsonb_array_length(v_heads))
  returning id into v_id;
  return v_id;
end
$$;

-- An anchor verifies when its root matches its heads and every anchored head still has the same
-- hash at the same sequence number in the live chain.
create function kernel.verify_anchor(p_anchor_id bigint) returns table (problem text)
language plpgsql stable security definer set search_path = pg_catalog, kernel, pg_temp as $$
declare
  a kernel.audit_anchor%rowtype;
  h jsonb;
  v_hash bytea;
begin
  select * into a from kernel.audit_anchor where id = p_anchor_id;
  if not found then problem := 'anchor not found'; return next; return; end if;
  if kernel.merkle_root(a.heads) <> a.merkle_root then
    problem := 'anchor root does not match its heads'; return next;
  end if;
  for h in select * from jsonb_array_elements(a.heads) loop
    select e.hash into v_hash from kernel.audit_event e where e.chain_key = h ->> 'chain_key' and e.seq = (h ->> 'seq')::bigint;
    if v_hash is null or encode(v_hash, 'hex') <> h ->> 'hash_hex' then
      problem := format('chain %s at seq %s differs from the anchor', h ->> 'chain_key', h ->> 'seq'); return next;
    end if;
  end loop;
end
$$;

-- ---------------------------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------------------------

revoke all on all tables in schema kernel from ebmr_app;
grant select on kernel.audited_table, kernel.audit_chain_head, kernel.audit_event, kernel.audit_checkpoint,
                kernel.audit_anchor, kernel.ddl_log to ebmr_app;
grant execute on function kernel.begin_command(jsonb), kernel.current_actor(), kernel.audit_business_event(text, text, jsonb),
                          kernel.audit_triggers_ok(), kernel.verify_chain(text, bigint), kernel.checkpoint_chain(text, text),
                          kernel.create_anchor(), kernel.verify_anchor(bigint), kernel.merkle_root(jsonb) to ebmr_app;
-- register_audited_table, append_audit_event, audit_row_change and reject_mutation stay private to the owner.

reset role;

-- DDL log needs an event trigger, which only a superuser can create.
create function kernel.log_ddl() returns event_trigger
language plpgsql security definer set search_path = pg_catalog, kernel, pg_temp as $$
declare
  r record;
begin
  for r in select * from pg_event_trigger_ddl_commands() loop
    insert into kernel.ddl_log (session_user_name, command_tag, object_identity) values (session_user, r.command_tag, r.object_identity);
  end loop;
end
$$;
alter function kernel.log_ddl() owner to ebmr_owner;
create event trigger ebmr_log_ddl on ddl_command_end execute function kernel.log_ddl();
