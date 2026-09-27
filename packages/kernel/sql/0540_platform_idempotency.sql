-- Platform services, part 5: idempotency keys (build outline 5.7; ADR 0006 decision 2).
--
-- Every mutating request carries an idempotency key, so double clicks and network retries are
-- harmless. The key is claimed inside the command's own transaction, before the work runs, and
-- the result is stored in the same transaction:
--   * first request: the key row is inserted, the work runs, the result is stored, all commit
--     together (a deferred check refuses a commit that claimed a key without storing a result);
--   * retry with the same key and request hash: the stored result is returned, nothing re-runs;
--   * the same key with a different request hash, or from another account: refused;
--   * a concurrent duplicate waits on the key row until the first commits, then replays its
--     result; if the first rolls back, the duplicate runs the work itself.

set local role ebmr_owner;

create table platform.idempotency_key (
  key             text primary key check (key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$'),
  request_hash    text not null check (request_hash ~ '^[0-9a-f]{64}$'),
  person_id       text not null,
  account_id      text not null,
  correlation_id  uuid not null,
  result_json     text,
  claimed_at      timestamptz not null default clock_timestamp(),
  completed_at    timestamptz,
  check ((result_json is null) = (completed_at is null))
);

create function platform.claim_idempotency_key(p_key text, p_request_hash text) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, platform, kernel, pg_temp as $$
declare
  v_ctx  jsonb := platform.require_actor();
  v_row  platform.idempotency_key%rowtype;
begin
  if p_key is null or p_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$' then
    raise exception using errcode = 'P0001', message = 'EBMR-PLAT-040 an idempotency key has 8-200 characters from A-Z a-z 0-9 . _ : -';
  end if;
  if p_request_hash is null or p_request_hash !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = 'P0001', message = 'EBMR-PLAT-043 the request hash must be a lower-case hex SHA-256';
  end if;
  insert into platform.idempotency_key (key, request_hash, person_id, account_id, correlation_id)
  values (p_key, p_request_hash, v_ctx ->> 'person_id', v_ctx ->> 'account_id', (v_ctx ->> 'correlation_id')::uuid)
  on conflict (key) do nothing;
  if found then
    return jsonb_build_object('status', 'NEW');
  end if;
  -- New statement, new snapshot: a concurrent claimer has committed by now (the insert waited).
  select * into v_row from platform.idempotency_key where key = p_key;
  if v_row.account_id <> v_ctx ->> 'account_id' or v_row.person_id <> v_ctx ->> 'person_id' then
    raise exception using errcode = 'P0001', message = format('EBMR-PLAT-042 idempotency key %s belongs to another account', p_key);
  end if;
  if v_row.request_hash <> p_request_hash then
    raise exception using errcode = 'P0001',
      message = format('EBMR-PLAT-041 idempotency key %s was already used for a different request', p_key);
  end if;
  if v_row.completed_at is null then
    raise exception using errcode = 'P0001', message = format('EBMR-PLAT-045 idempotency key %s is already claimed in this transaction', p_key);
  end if;
  return jsonb_build_object('status', 'REPLAY', 'result_json', v_row.result_json, 'correlation_id', v_row.correlation_id,
                            'completed_at', v_row.completed_at);
end
$$;

create function platform.complete_idempotency_key(p_key text, p_result_json text) returns void
language plpgsql volatile security definer set search_path = pg_catalog, platform, kernel, pg_temp as $$
declare
  v_ctx jsonb := platform.require_actor();
begin
  if p_result_json is null then
    raise exception using errcode = 'P0001', message = 'EBMR-PLAT-044 an idempotent command must store a JSON result';
  end if;
  perform p_result_json::jsonb;
  update platform.idempotency_key
     set result_json = p_result_json, completed_at = clock_timestamp()
   where key = p_key and completed_at is null
     and correlation_id = (v_ctx ->> 'correlation_id')::uuid
     and xmin = pg_current_xact_id()::xid;
  if not found then
    raise exception using errcode = 'P0001', message = format('EBMR-PLAT-044 idempotency key %s was not claimed by this command', p_key);
  end if;
end
$$;

-- At commit, every key claimed in the transaction must have its result stored.
create function platform.idempotency_completed_check() returns trigger
language plpgsql security definer set search_path = pg_catalog, platform, pg_temp as $$
begin
  if exists (select 1 from platform.idempotency_key where key = new.key and completed_at is null) then
    raise exception using errcode = 'P0001',
      message = format('EBMR-PLAT-045 idempotency key %s was claimed but no result was stored before commit', new.key);
  end if;
  return null;
end
$$;

create constraint trigger idempotency_completed after insert on platform.idempotency_key
  deferrable initially deferred for each row execute function platform.idempotency_completed_check();

select platform.enforce_db_time('platform.idempotency_key', array['claimed_at']);

-- No table privileges: keys and stored results are reached only through the two functions.
grant execute on function platform.claim_idempotency_key(text, text), platform.complete_idempotency_key(text, text) to ebmr_app;

reset role;
