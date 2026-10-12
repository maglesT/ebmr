-- Plant, output containers: a typed net quantity needs a second person before the container is used (Phase 4 slice 1b;
-- Phase 3 exit review backlog, medium; controls DI-30, L-30, INV-03).
--
-- plant.close_container (0422) took the net quantity as typed by one person: no weighing stood behind it and nobody
-- checked it, yet the container could be charged, merged or packed at once and its net carried on (charge_container
-- returns it). DI-30 asks for an additional accuracy check of a manually entered critical value: a second person, or a
-- validated electronic means (device capture). From this migration every close records its basis:
--
--   WEIGHED  the net comes from scale readings claimed for the close by the edition (tablets 1111,
--            tab.close_container_weighed: tare and gross from a balance of the session's room); `weighing` holds them;
--   TYPED    the net was keyed (plant.close_container, as before). The container is closed but not usable, and cannot
--            be released by QA, until a second person verifies the net: plant.verify_container_close, with their own
--            VERIFIED signature on the container (whose signed content shows the net and the closer), never the closer.
--
--   * plant.container_close: new columns basis and weighing; a NOT VALID check makes every new close name its basis (rows
--     recorded before keep a NULL basis: they were closed under the earlier rule and are read as before);
--   * plant.container_close_verification: insert-only, audited on the container, database time: the second person and
--     their signature, once per close. A row guard (owner-level writes included) refuses a verifier who closed the
--     container or opened it, a close that is not TYPED, and a signature that is not the verifier's own;
--   * plant.container_close_record (internal, granted to nobody): the body of close_container from 0422 after its
--     permission check, with the basis and the weighing; used by close_container (TYPED) and the edition's weighed close;
--   * plant.close_container: CREATE OR REPLACE from 0422 (its only definition): unchanged checks, basis TYPED;
--   * plant.verify_container_close(container, signature): STEP.VERIFY in the container's product scope; not an
--     administrator; the close is TYPED and not yet verified; the verifier is neither its closer nor its opener;
--     platform.verify_signature (VERIFIED, output_container) and the signer is the verifier;
--   * plant.container_usable_problem: CREATE OR REPLACE from 0420 (its only definition), with one addition: a TYPED close
--     not yet verified makes the container unusable (charge, merge, pack and the bulk issue all read this function);
--   * plant.output_container_content: CREATE OR REPLACE from 0420: for a close with a basis, the content also shows the
--     basis, the weighing and the verification (content_version counts the verification). Closes without a basis read
--     exactly as before, so signatures already made keep their content.
--
-- Messages: EBMR-CNT-046 to 049. Every function is owned by ebmr_owner with pg_temp last in its search_path (ADR 0016).
-- Applied as a new migration because applied migrations are checksummed and never edited.

set local role ebmr_owner;

alter table plant.container_close add column basis text check (basis in ('WEIGHED', 'TYPED'));
alter table plant.container_close add column weighing jsonb check (weighing is null or jsonb_typeof(weighing) = 'object');
alter table plant.container_close add constraint container_close_basis_given check (basis is not null) not valid;
alter table plant.container_close add constraint container_close_weighing_basis check ((basis = 'WEIGHED') = (weighing is not null)) not valid;

create table plant.container_close_verification (
  container_id       uuid primary key references plant.container_close (container_id),
  signature_id       uuid not null unique,
  person_id          uuid not null,
  account_id         uuid not null,
  recorded_at        timestamptz not null default clock_timestamp()
);
revoke all on plant.container_close_verification from public;
select platform.enforce_db_time('plant.container_close_verification', array['recorded_at']);

select kernel.set_actor_context(jsonb_build_object(
  'person_id', '00000000-0000-0000-0000-000000000000', 'account_id', '00000000-0000-0000-0000-000000000000',
  'role_code', 'SOFTWARE_RELEASE', 'session_id', '00000000-0000-0000-0000-000000000000', 'source', 'SYSTEM',
  'site_zone', 'UTC', 'correlation_id', gen_random_uuid(),
  'legal_name', 'Software release (recipe-core migration 0740_container_close_net_check)',
  'reason_code', 'SOFTWARE_RELEASE',
  'reason_text', 'a typed net quantity of an output container is verified by a second person before use (DI-30)'));
select kernel.register_audited_table('plant.container_close_verification', 'output_container', 'container_id', true);
select kernel.set_actor_context(null);
grant select on plant.container_close_verification to ebmr_app;

-- DI-30, INV-03: a verification row stands only for a TYPED close, by neither the closer nor the opener, under the
-- verifier's own signature (whoever writes the row, the owner included).
create function plant.guard_container_close_verification() returns trigger
language plpgsql security definer set search_path = pg_catalog, plant, esig, pg_temp as $$
declare
  x plant.container_close;
  c plant.output_container;
begin
  select * into x from plant.container_close where container_id = new.container_id;
  select * into c from plant.output_container where id = new.container_id;
  if x.basis is distinct from 'TYPED' then
    raise exception using errcode = 'P0001',
      message = format('Container %s was not closed with a typed net quantity; there is nothing to verify (DI-30; EBMR-CNT-047)', coalesce(c.label_code, new.container_id::text));
  end if;
  if new.person_id in (x.person_id, c.opened_by_person) then
    raise exception using errcode = 'P0001',
      message = format('The typed net quantity of container %s is verified by a second person, not by the person who closed or opened it (DI-30, INV-03; EBMR-CNT-048)', c.label_code);
  end if;
  if not exists (select 1 from esig.signature s where s.id = new.signature_id and s.signer_person = new.person_id) then
    raise exception using errcode = 'P0001',
      message = format('The verification of container %s carries the verifier''s own signature (DI-30; EBMR-CNT-049)', c.label_code);
  end if;
  return new;
end
$$;
create trigger aa_container_close_verification_guard before insert on plant.container_close_verification
  for each row execute function plant.guard_container_close_verification();

-- The close of container p_container with net p_net on basis p_basis (weighing p_weighing for WEIGHED), as v_actor (whose
-- permission the caller checked): 0422 close_container's body after its permission check. Granted to nobody.
create function plant.container_close_record(p_container uuid, p_net_quantity numeric, p_expected_version bigint, p_basis text, p_weighing jsonb, v_actor jsonb)
returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, plant, iam, kernel, platform, pg_temp as $$
declare
  c       plant.output_container;
  v_r     jsonb;
  v_state text;
begin
  select * into c from plant.output_container where id = p_container for update;
  if not found then
    raise exception using errcode = 'P0001', message = format('Unknown output container %s (EBMR-CNT-030)', p_container);
  end if;
  if p_net_quantity is null or p_net_quantity <= 0 then
    raise exception using errcode = 'P0001', message = format('Container %s is closed with its net quantity, above zero (L-30; EBMR-CNT-031)', c.label_code);
  end if;
  if exists (select 1 from plant.container_close where container_id = p_container) then
    raise exception using errcode = 'P0001', message = format('Container %s is closed already; it is closed once (L-30; EBMR-CNT-032)', c.label_code);
  end if;
  insert into plant.container_close (container_id, net_quantity, person_id, account_id, basis, weighing)
  values (p_container, p_net_quantity, (v_actor ->> 'person_id')::uuid, (v_actor ->> 'account_id')::uuid, p_basis, p_weighing);
  -- In any state but OPEN the engine refuses the event (EBMR-PLAT-066/067) and the close above rolls back with it.
  v_r := platform.transition('output_container', 'output_container', p_container, 'CLOSE', p_expected_version, '{}'::jsonb);
  v_state := v_r ->> 'to';
  if exists (select 1 from plant.container_hold h where h.container_id = p_container) then
    v_state := plant.apply_hold(p_container);
  end if;
  return jsonb_build_object('container_id', p_container, 'label_code', c.label_code, 'state', v_state, 'basis', p_basis,
                            'version', (select s.version from platform.aggregate_state s where s.aggregate_type = 'output_container' and s.aggregate_id = p_container));
end
$$;
revoke all on function plant.container_close_record(uuid, numeric, bigint, text, jsonb, jsonb) from public;

create or replace function plant.close_container(p_container uuid, p_net_quantity numeric, p_expected_version bigint) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, plant, iam, kernel, platform, pg_temp as $$
declare
  v_actor jsonb;
  c       plant.output_container;
begin
  perform iam.assert_not_administrator();
  select * into c from plant.output_container where id = p_container;
  if not found then
    raise exception using errcode = 'P0001', message = format('Unknown output container %s (EBMR-CNT-030)', p_container);
  end if;
  v_actor := iam.require_permission('STEP.EXECUTE', jsonb_build_object('product', c.product_code));
  return plant.container_close_record(p_container, p_net_quantity, p_expected_version, 'TYPED', null, v_actor);
end
$$;

-- DI-30: a second person verifies the typed net of container p_container with their VERIFIED signature on it.
create function plant.verify_container_close(p_container uuid, p_signature_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, plant, iam, kernel, platform, pg_temp as $$
declare
  v_actor jsonb;
  c       plant.output_container;
  x       plant.container_close;
begin
  perform iam.assert_not_administrator();
  select * into c from plant.output_container where id = p_container;
  if not found then
    raise exception using errcode = 'P0001', message = format('Unknown output container %s (EBMR-CNT-030)', p_container);
  end if;
  v_actor := iam.require_permission('STEP.VERIFY', jsonb_build_object('product', c.product_code));
  -- The state row is locked so a charge or a release waits for the verification, or is seen by it.
  perform 1 from platform.aggregate_state s where s.aggregate_type = 'output_container' and s.aggregate_id = c.id for update;
  select * into x from plant.container_close where container_id = p_container;
  if x.container_id is null then
    raise exception using errcode = 'P0001', message = format('Container %s is not closed; its net quantity is verified after the close (DI-30; EBMR-CNT-046)', c.label_code);
  end if;
  if exists (select 1 from plant.container_close_verification v where v.container_id = p_container) then
    raise exception using errcode = 'P0001', message = format('The typed net quantity of container %s is verified already; once is enough (DI-30; EBMR-CNT-046)', c.label_code);
  end if;
  if x.basis is distinct from 'TYPED' then
    raise exception using errcode = 'P0001',
      message = format('Container %s was not closed with a typed net quantity; there is nothing to verify (DI-30; EBMR-CNT-047)', c.label_code);
  end if;
  if (v_actor ->> 'person_id')::uuid in (x.person_id, c.opened_by_person) then
    raise exception using errcode = 'P0001',
      message = format('The typed net quantity of container %s is verified by a second person, not by the person who closed or opened it (DI-30, INV-03; EBMR-CNT-048)', c.label_code);
  end if;
  perform platform.verify_signature(p_signature_id, 'VERIFIED', 'output_container', p_container::text);
  insert into plant.container_close_verification (container_id, signature_id, person_id, account_id)
  values (p_container, p_signature_id, (v_actor ->> 'person_id')::uuid, (v_actor ->> 'account_id')::uuid);
  return jsonb_build_object('container_id', p_container, 'label_code', c.label_code, 'net_quantity', x.net_quantity::text, 'quantity_unit', c.quantity_unit,
                            'verified_by', v_actor ->> 'person_id');
end
$$;

-- Why the container cannot be merged, charged or packed now, or NULL when it can (L-30, TB-11; DI-30 from 0740).
create or replace function plant.container_usable_problem(p_container uuid) returns text
language plpgsql stable security definer set search_path = pg_catalog, plant, pg_temp as $$
declare
  c       plant.output_container;
  v_state text := plant.container_state(p_container);
begin
  select * into c from plant.output_container where id = p_container;
  if not found then
    return 'the container does not exist';
  end if;
  if v_state in ('HELD', 'SORTED') then
    return format('container %s is %s: held containers are never merged, charged or packed until QA releases them', c.label_code, v_state);
  end if;
  if v_state = 'REJECTED' then
    return format('container %s is REJECTED', c.label_code);
  end if;
  if exists (select 1 from plant.container_hold h where h.container_id = c.id) and v_state <> 'RELEASED_BY_QA' then
    return format('container %s is under a hold that applies when it is closed', c.label_code);
  end if;
  if v_state = 'OPEN' then
    return format('container %s is still open', c.label_code);
  end if;
  if plant.container_net_unverified(c.id) then
    return format('the typed net quantity of container %s has not been verified by a second person (DI-30)', c.label_code);
  end if;
  if exists (select 1 from plant.container_charge g where g.container_id = c.id) then
    return format('container %s was already charged or packed', c.label_code);
  end if;
  if exists (select 1 from plant.container_merge m where m.source_id = c.id) then
    return format('container %s was already merged into another container', c.label_code);
  end if;
  if v_state = 'CLOSED' then
    return plant.bracketing_problem(c, plant.container_closed_at(c.id));
  end if;
  if v_state = 'RELEASED_BY_QA' then
    return null;
  end if;
  return format('container %s is in state %s', c.label_code, coalesce(v_state, '(none)'));
end
$$;

-- DI-30: whether the container's close is TYPED and no second person has verified it yet.
create function plant.container_net_unverified(p_container uuid) returns boolean
language sql stable security definer set search_path = pg_catalog, plant, pg_temp as $$
  select exists (select 1 from plant.container_close x where x.container_id = p_container and x.basis = 'TYPED'
                   and not exists (select 1 from plant.container_close_verification v where v.container_id = x.container_id))
$$;

create or replace function plant.output_container_content(p_id text) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, plant, platform, pg_temp as $$
declare
  c       plant.output_container;
  x       plant.container_close;
  v       plant.container_close_verification;
  v_holds jsonb;
  v_by    jsonb;
  v_body  jsonb;
begin
  if coalesce(p_id, '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return '{"exists": false}'::jsonb;
  end if;
  select * into c from plant.output_container where id = p_id::uuid;
  if not found then
    return '{"exists": false}'::jsonb;
  end if;
  select * into x from plant.container_close where container_id = c.id;
  select * into v from plant.container_close_verification where container_id = c.id;
  select coalesce(jsonb_agg(jsonb_build_object('ipc_check_id', k.id, 'result', k.result, 'press', k.press_code, 'stream', k.stream,
                                               'reference', k.reference, 'recorded_at', k.recorded_at, 'via_container_id', h.via_container_id)
                            order by h.recorded_at, h.id), '[]'::jsonb)
    into v_holds
    from plant.container_hold h join plant.ipc_check k on k.id = h.ipc_check_id where h.container_id = c.id;
  select coalesce(jsonb_agg(distinct p), '[]'::jsonb) into v_by
    from (select c.opened_by_person as p union all select x.person_id
          union all select k.person_id from plant.container_hold h join plant.ipc_check k on k.id = h.ipc_check_id where h.container_id = c.id) x
   where p is not null;
  v_body := jsonb_build_object('label_code', c.label_code, 'batch_id', c.batch_id, 'batch_number', c.batch_number,
                               'product_code', c.product_code, 'strength', c.strength, 'stage', c.stage, 'press_code', c.press_code,
                               'stream', c.stream, 'net_quantity', x.net_quantity::text, 'quantity_unit', c.quantity_unit,
                               'opened_at', c.opened_at, 'closed_at', x.closed_at, 'holds', v_holds);
  -- 0740: a close with a basis shows it (closes before 0740 read as before, so their signatures keep their content).
  if x.basis is not null then
    v_body := v_body || jsonb_build_object('close_basis', x.basis, 'closed_by', x.person_id, 'weighing', x.weighing,
                                           'net_verified_by', v.person_id, 'net_verified_at', v.recorded_at);
  end if;
  return jsonb_build_object(
    'exists', true,
    'content_version', 1 + (case when x.container_id is null then 0 else 1 end) + jsonb_array_length(v_holds)
                         + (case when v.container_id is null then 0 else 1 end),
    'content', v_body,
    'state', plant.container_state(c.id),
    'scope', jsonb_build_object('product', c.product_code),
    'entered_by', v_by);
end
$$;

revoke all on function plant.verify_container_close(uuid, uuid), plant.container_net_unverified(uuid) from public;
grant execute on function plant.verify_container_close(uuid, uuid), plant.container_net_unverified(uuid) to ebmr_app;

reset role;
