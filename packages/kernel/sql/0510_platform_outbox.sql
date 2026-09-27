-- Platform services, part 2: transactional outbox (build outline 4.6, 5.5; ADR 0012).
--
-- A business change and the message announcing it commit together: platform.enqueue writes the
-- outbox row in the caller's transaction, so a rolled-back change leaves no message. Relays
-- claim pending messages with FOR UPDATE SKIP LOCKED, hand them to a handler, record every
-- delivery attempt and mark the message delivered. Delivery is at least once: a relay that dies
-- after the handler ran but before commit leaves the message pending, so consumers deduplicate
-- on the message_id (platform.consume_once for consumers inside this database).
-- Messages of one aggregate are delivered in order: a message is not claimed while an earlier
-- message of the same aggregate is still pending.

set local role ebmr_owner;

create table platform.outbox (
  id              bigint generated always as identity primary key,
  message_id      uuid not null unique default gen_random_uuid(),
  topic           text not null check (topic ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'),
  aggregate_type  text not null check (aggregate_type ~ '^[a-z][a-z0-9_]*$'),
  aggregate_id    text not null check (aggregate_id <> ''),
  payload         jsonb not null check (jsonb_typeof(payload) = 'object'),
  correlation_id  uuid not null,
  person_id       text not null,
  source          text not null,
  recorded_at     timestamptz not null default clock_timestamp()
);
create index outbox_aggregate on platform.outbox (aggregate_type, aggregate_id, id);

-- Delivery state, one row per message; changed only by the relay functions below.
create table platform.outbox_state (
  outbox_id        bigint primary key references platform.outbox (id),
  aggregate_type   text not null,
  aggregate_id     text not null,
  status           text not null default 'PENDING' check (status in ('PENDING', 'DELIVERED')),
  attempts         integer not null default 0 check (attempts >= 0),
  next_attempt_at  timestamptz not null default clock_timestamp(),
  claimed_by       text,
  claimed_xact     xid8,
  delivered_at     timestamptz,
  delivered_by     text,
  last_error       text,
  check ((status = 'DELIVERED') = (delivered_at is not null))
);
create index outbox_state_pending on platform.outbox_state (next_attempt_at, outbox_id) where status = 'PENDING';
create index outbox_state_pending_aggregate on platform.outbox_state (aggregate_type, aggregate_id, outbox_id) where status = 'PENDING';

create table platform.outbox_attempt (
  id           bigint generated always as identity primary key,
  outbox_id    bigint not null references platform.outbox (id),
  relay        text not null,
  attempt_no   integer not null check (attempt_no >= 1),
  outcome      text not null check (outcome in ('DELIVERED', 'FAILED')),
  error        text,
  recorded_at  timestamptz not null default clock_timestamp(),
  unique (outbox_id, attempt_no)
);

-- Consumer-side deduplication for consumers that run inside this database.
create table platform.consumed_message (
  consumer     text not null check (consumer ~ '^[a-z][a-z0-9_.-]*$'),
  message_id   uuid not null,
  recorded_at  timestamptz not null default clock_timestamp(),
  primary key (consumer, message_id)
);

create type platform.outbox_message as (
  outbox_id       bigint,
  message_id      uuid,
  topic           text,
  aggregate_type  text,
  aggregate_id    text,
  payload         jsonb,
  correlation_id  uuid,
  recorded_at     timestamptz,
  attempt_no      integer
);

-- Writes a message in the caller's transaction. p_aggregate is written type:id, e.g. batch:<uuid>.
-- Owner-only: kernel functions use it for every topic, including the reserved ones.
create function platform.enqueue_message(p_topic text, p_aggregate text, p_payload jsonb) returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, platform, kernel, pg_temp as $$
declare
  v_ctx   jsonb := platform.require_actor();
  v_type  text;
  v_id    text;
  v_row   platform.outbox%rowtype;
begin
  if p_topic is null or p_topic !~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$' then
    raise exception using errcode = 'P0001', message = format('EBMR-PLAT-050 invalid outbox topic %s (expected e.g. incident.requested)', coalesce(p_topic, 'NULL'));
  end if;
  if p_aggregate is null or p_aggregate !~ '^[a-z][a-z0-9_]*:.+$' then
    raise exception using errcode = 'P0001', message = format('EBMR-PLAT-051 invalid aggregate reference %s (expected type:id)', coalesce(p_aggregate, 'NULL'));
  end if;
  if p_payload is null or jsonb_typeof(p_payload) <> 'object' then
    raise exception using errcode = 'P0001', message = 'EBMR-PLAT-052 an outbox payload must be a JSON object';
  end if;
  v_type := split_part(p_aggregate, ':', 1);
  v_id := substr(p_aggregate, length(v_type) + 2);
  insert into platform.outbox (topic, aggregate_type, aggregate_id, payload, correlation_id, person_id, source)
  values (p_topic, v_type, v_id, p_payload, (v_ctx ->> 'correlation_id')::uuid, v_ctx ->> 'person_id', v_ctx ->> 'source')
  returning * into v_row;
  insert into platform.outbox_state (outbox_id, aggregate_type, aggregate_id) values (v_row.id, v_type, v_id);
  return v_row.message_id;
end
$$;

-- Application entry point. Topics under the kernel's reserved prefixes (state., incident.,
-- platform.) announce facts only kernel functions may state, so consumers can trust them; the
-- application cannot write them.
create function platform.enqueue(p_topic text, p_aggregate text, p_payload jsonb) returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, platform, kernel, pg_temp as $$
begin
  if p_topic ~ '^(state|incident|platform)\.' then
    raise exception using errcode = 'P0001',
      message = format('EBMR-PLAT-057 topic %s is reserved for kernel functions', p_topic);
  end if;
  return platform.enqueue_message(p_topic, p_aggregate, p_payload);
end
$$;

-- Claims up to p_limit deliverable messages for the calling transaction. Rows locked by another
-- relay are skipped; a message is not claimed while an earlier message of its aggregate is pending.
create function platform.outbox_claim(p_relay text, p_limit integer default 10) returns setof platform.outbox_message
language plpgsql volatile security definer set search_path = pg_catalog, platform, pg_temp as $$
begin
  if coalesce(trim(p_relay), '') = '' then
    raise exception using errcode = 'P0001', message = 'EBMR-PLAT-053 a relay name is required';
  end if;
  if p_limit is null or p_limit < 1 or p_limit > 1000 then
    raise exception using errcode = 'P0001', message = 'EBMR-PLAT-053 the claim limit must be between 1 and 1000';
  end if;
  return query
    with candidate as (
      select s.outbox_id
      from platform.outbox_state s
      where s.status = 'PENDING'
        and s.next_attempt_at <= clock_timestamp()
        and not exists (select 1 from platform.outbox_state e
                        where e.status = 'PENDING' and e.aggregate_type = s.aggregate_type
                          and e.aggregate_id = s.aggregate_id and e.outbox_id < s.outbox_id)
      order by s.outbox_id
      limit p_limit
      for update of s skip locked
    ), claimed as (
      update platform.outbox_state s
         set claimed_by = p_relay, claimed_xact = pg_current_xact_id()
        from candidate c
       where s.outbox_id = c.outbox_id
      returning s.outbox_id, s.attempts
    )
    select o.id, o.message_id, o.topic, o.aggregate_type, o.aggregate_id, o.payload, o.correlation_id, o.recorded_at, c.attempts + 1
    from claimed c join platform.outbox o on o.id = c.outbox_id
    order by o.id;
end
$$;

-- Locks and returns the state row of a message claimed by the current transaction.
create function platform.outbox_claimed_state(p_outbox_id bigint) returns platform.outbox_state
language plpgsql volatile security definer set search_path = pg_catalog, platform, pg_temp as $$
declare
  v platform.outbox_state%rowtype;
begin
  select * into v from platform.outbox_state where outbox_id = p_outbox_id for update;
  if not found then
    raise exception using errcode = 'P0001', message = format('EBMR-PLAT-054 unknown outbox message %s', p_outbox_id);
  end if;
  if v.status <> 'PENDING' or v.claimed_xact is distinct from pg_current_xact_id() then
    raise exception using errcode = 'P0001',
      message = format('EBMR-PLAT-055 outbox message %s was not claimed by this transaction (status %s)', p_outbox_id, v.status);
  end if;
  return v;
end
$$;

create function platform.outbox_mark_delivered(p_outbox_id bigint, p_relay text) returns void
language plpgsql volatile security definer set search_path = pg_catalog, platform, pg_temp as $$
declare
  v platform.outbox_state%rowtype := platform.outbox_claimed_state(p_outbox_id);
begin
  update platform.outbox_state
     set status = 'DELIVERED', attempts = v.attempts + 1, delivered_at = clock_timestamp(), delivered_by = p_relay, last_error = null
   where outbox_id = p_outbox_id;
  insert into platform.outbox_attempt (outbox_id, relay, attempt_no, outcome) values (p_outbox_id, p_relay, v.attempts + 1, 'DELIVERED');
end
$$;

-- Records a failed attempt; the message becomes deliverable again after an exponential back-off
-- (2 s, 4 s, 8 s, ... capped at one hour).
create function platform.outbox_mark_failed(p_outbox_id bigint, p_relay text, p_error text) returns void
language plpgsql volatile security definer set search_path = pg_catalog, platform, pg_temp as $$
declare
  v platform.outbox_state%rowtype := platform.outbox_claimed_state(p_outbox_id);
  v_error text := left(coalesce(p_error, 'unknown error'), 2000);
begin
  update platform.outbox_state
     set attempts = v.attempts + 1,
         next_attempt_at = clock_timestamp() + least(interval '1 second' * power(2, least(v.attempts + 1, 12)), interval '1 hour'),
         last_error = v_error
   where outbox_id = p_outbox_id;
  insert into platform.outbox_attempt (outbox_id, relay, attempt_no, outcome, error) values (p_outbox_id, p_relay, v.attempts + 1, 'FAILED', v_error);
end
$$;

-- Returns true the first time a consumer sees a message and false afterwards. Call it in the
-- consumer's own transaction, together with the effect, so both commit or neither does.
create function platform.consume_once(p_consumer text, p_message_id uuid) returns boolean
language plpgsql volatile security definer set search_path = pg_catalog, platform, pg_temp as $$
begin
  if p_message_id is null then
    raise exception using errcode = 'P0001', message = 'EBMR-PLAT-056 a message id is required';
  end if;
  insert into platform.consumed_message (consumer, message_id) values (p_consumer, p_message_id) on conflict do nothing;
  return found;
end
$$;

select platform.enforce_db_time('platform.outbox', array['recorded_at']);
select platform.enforce_db_time('platform.outbox_attempt', array['recorded_at']);
select platform.enforce_db_time('platform.consumed_message', array['recorded_at']);
select platform.make_insert_only('platform.outbox');
select platform.make_insert_only('platform.outbox_attempt');
select platform.make_insert_only('platform.consumed_message');

grant select on platform.outbox, platform.outbox_state, platform.outbox_attempt, platform.consumed_message to ebmr_app;
grant execute on function platform.enqueue(text, text, jsonb), platform.outbox_claim(text, integer),
                          platform.outbox_mark_delivered(bigint, text), platform.outbox_mark_failed(bigint, text, text),
                          platform.consume_once(text, uuid) to ebmr_app;

reset role;
