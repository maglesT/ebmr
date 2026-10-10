-- Recipe core, execution store (module C3): an approval binds the very act it approves (Phase 3 slice 2 quick review,
-- finding 1; outline 5.2.3; DI-24, DI-29, DI-35, DI-37, PR-13, PR-14, INV-41; ADR 0012). Part 1: the approved act.
--
-- What was wrong. The approval of a skip or a void (SKIP_APPROVED, VOID_AUTHORISED), the two approvals of an abort and
-- the two signatures of a hand-over (HANDOVER_APPROVED) signed the batch record at a state version (0450, 0461), whose
-- content names no step, item, reason or performer: one approval given for one skip could be used for any skippable
-- step with any reason at that version. The approval of an invalidation (INVALIDATION_APPROVED) signed the data point,
-- but not the investigation, the assignable cause or the reason.
--
-- What changed. A new signable aggregate, the approved act (`batch_act`, aggregate id
-- `<batch id>:act@<state version>:<hash of the act>`): the act is the command as it will be recorded without its id,
-- actor, signatures and expected version, plus `requestedBy`, the requester (engine signing-content.ts approvedAct;
-- recipe.approved_act here). The requester records the act first (recipe.propose_act, in their own command, with the
-- command type's permission), and the approver signs it: its content is the batch's identity, the state version and the
-- act itself (step and context, item, point, reason, investigation and cause, checklist, outgoing and incoming
-- performer, requester). recipe.check_signatures (0471) accepts such an approval only on the aggregate it computes from
-- the row's own command at the state version the row acts on, so an approval approves that act only, and any row
-- recorded since asks for it again. The act is insert-only; its content never changes, so a signature on it is never
-- superseded.
--
-- New objects are owned by ebmr_owner, private to the owner except what the application uses: it reads the table and
-- runs recipe.propose_act. Definers pin their search_path with pg_temp last. Messages: EBMR-EXE-179.

set local role ebmr_owner;

create table recipe.execution_act_proposal (
  aggregate_id         text primary key,
  batch_id             uuid not null references recipe.batch_execution (id),
  state_version        integer not null check (state_version >= 0),
  act                  jsonb not null check (jsonb_typeof(act) = 'object'),
  act_hash             text not null check (act_hash ~ '^[0-9a-f]{64}$'),
  proposed_by_person   uuid not null,
  proposed_by_account  uuid not null,
  correlation_id       uuid not null,
  proposed_at          timestamptz not null default clock_timestamp(),
  check (aggregate_id = batch_id::text || ':act@' || state_version::text || ':' || act_hash)
);
revoke all on recipe.execution_act_proposal from public;
create trigger aa_insert_only before update or delete on recipe.execution_act_proposal for each row execute function kernel.reject_mutation();
create trigger aa_no_truncate before truncate on recipe.execution_act_proposal for each statement execute function kernel.reject_mutation();
select kernel.register_audited_table('recipe.execution_act_proposal', 'batch', 'batch_id', true);

-- DI-35: the act command p_cmd asks to approve (header): the command without its id, actor, signatures and expected
-- version, with its requester (the command's actor). Engine signing-content.ts approvedAct.
create function recipe.approved_act(p_cmd jsonb) returns jsonb
language sql immutable set search_path = pg_catalog, recipe, pg_temp as $$
  select (p_cmd - array['commandId', 'actor', 'approval', 'approvals', 'signature', 'expectedVersion'])
         || jsonb_build_object('requestedBy', p_cmd -> 'actor' -> 'id')
$$;

-- The aggregate id of the act command p_cmd asks to approve on batch p_batch at state version p_version.
create function recipe.approved_act_aggregate(p_batch uuid, p_version text, p_cmd jsonb) returns text
language sql immutable set search_path = pg_catalog, recipe, pg_temp as $$
  select p_batch::text || ':act@' || coalesce(p_version, '?') || ':' || recipe.canonical_hash(recipe.approved_act(p_cmd))
$$;

-- DI-24, DI-35: the requester records the act they ask another person to approve, on the batch's current state version
-- (sandbox only; the permission of the act's command type, in the declared role at the actor's location). Returns
-- {aggregate_id, state_version}. Recording the same act twice at one version returns the same aggregate. EBMR-EXE-179.
create function recipe.propose_act(p_batch uuid, p_act jsonb) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, recipe, iam, kernel, pg_temp as $$
declare
  v_actor   jsonb := recipe.execution_actor('Asking for the approval of an act');
  v_version integer;
  v_hash    text;
  v_agg     text;
begin
  if jsonb_typeof(p_act) is distinct from 'object' or p_act ->> 'type' is null
     or p_act ->> 'type' not in ('REQUEST_SKIP', 'VOID_ATTEMPT', 'INVALIDATE_RESULT', 'ABORT_BATCH', 'HAND_OVER_STEP')
     or p_act ?| array['commandId', 'actor', 'approval', 'approvals', 'signature', 'expectedVersion']
     or p_act ->> 'requestedBy' is distinct from v_actor ->> 'person_id' or jsonb_typeof(p_act -> 'requestedBy') is distinct from 'string'
     or length(p_act::text) > 16384 then
    raise exception using errcode = 'P0001',
      message = 'An act asked for approval is a skip, a void, an invalidation, an abort or a hand-over, as its command will record it without id, actor or signatures, requested by the person who asks (DI-24, DI-35). [EBMR-EXE-179]';
  end if;
  perform recipe.require_command_permission(p_act ->> 'type', null);
  select s.state_version into v_version from recipe.execution_state s where s.batch_id = p_batch;
  if v_version is null then
    raise exception using errcode = 'P0001', message = 'There is no test batch with this id (DI-34). [EBMR-EXE-010]';
  end if;
  v_hash := recipe.canonical_hash(p_act);
  v_agg := p_batch::text || ':act@' || v_version::text || ':' || v_hash;
  insert into recipe.execution_act_proposal (aggregate_id, batch_id, state_version, act, act_hash, proposed_by_person, proposed_by_account, correlation_id)
  values (v_agg, p_batch, v_version, p_act, v_hash, (v_actor ->> 'person_id')::uuid, (v_actor ->> 'account_id')::uuid, (v_actor ->> 'correlation_id')::uuid)
  on conflict (aggregate_id) do nothing;
  return jsonb_build_object('aggregate_id', v_agg, 'state_version', v_version);
end
$$;

-- DI-35, DI-37, INV-09: the content of approved act p_id: the batch's identity as issued, the state version and the act;
-- the batch status is the record's state (esig.signature_state_problem holds an approval to it).
create function recipe.batch_act_content(p_id text) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, recipe, pg_temp as $$
declare
  a        recipe.execution_act_proposal;
  b        recipe.batch_execution;
  v_status text;
begin
  select * into a from recipe.execution_act_proposal where aggregate_id = p_id;
  if a.aggregate_id is null then
    return jsonb_build_object('exists', false);
  end if;
  select * into b from recipe.batch_execution where id = a.batch_id;
  select s.status into v_status from recipe.execution_state s where s.batch_id = a.batch_id;
  return jsonb_build_object(
    'exists', true, 'content_version', 1, 'state', v_status, 'entered_by', '[]'::jsonb,
    'scope', jsonb_build_object('site', b.site_code),
    'content', jsonb_build_object(
      'batchId', b.id::text, 'batchNumber', b.batch_number, 'mbrHash', b.content_hash, 'engineVersion', b.engine_version,
      'stateVersion', a.state_version, 'act', a.act));
end
$$;

select esig.register_content_provider('batch_act', 'recipe.batch_act_content(text)',
  'An act a person asks another to approve (skip, void, invalidation, abort, hand-over), as its command will record it, at one state version of a batch (C3)');

revoke all on function recipe.approved_act(jsonb), recipe.approved_act_aggregate(uuid, text, jsonb), recipe.propose_act(uuid, jsonb),
                       recipe.batch_act_content(text) from public;
grant execute on function recipe.propose_act(uuid, jsonb) to ebmr_app;
grant select on recipe.execution_act_proposal to ebmr_app;

reset role;
