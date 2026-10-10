-- Recipe core, execution store (module C3): the change paths a test run could not take until now (Phase 3 slice 2,
-- plan item 2; outline 5.2.2, 5.2.3; controls DI-24, DI-29, DI-35, PR-12, PR-13, IN-06; invariant INV-41). Part 1: the
-- catalogue and the record they are signed on.
--
-- Until this migration recipe.require_command_permission (0210) refused REQUEST_SKIP, VOID_ATTEMPT,
-- INVALIDATE_RESULT, ABORT_BATCH and CANCEL_BATCH as not available (EBMR-EXE-003): recipe.execution_command_permission
-- had no row for them. This migration adds:
--   * the permission each needs (any one of the list, in the declared role at the actor's location), and that each
--     is a signed command type:
--       REQUEST_SKIP       requested by a performer or a supervisor; approved (SKIP_APPROVED) by another person;
--       VOID_ATTEMPT       by a performer of the step; approved (VOID_AUTHORISED) by QA, always (S28; 0452);
--       INVALIDATE_RESULT  requested by a supervisor or QA; approved (INVALIDATION_APPROVED) by the quality unit;
--       ABORT_BATCH        recorded by a supervisor, the head of production or QA, with the two approvals
--                          (BATCH_ABORT_APPROVED) of the head of production and of QA;
--       CANCEL_BATCH       by a supervisor, who signs it (BATCH_CANCELLED).
--     The kernel's meaning catalogue (kernel 0210, 0930) already limits who may sign each meaning (VOID_AUTHORISED:
--     STEP.SUPERVISE or QA.FLOOR_APPROVE; INVALIDATION_APPROVED: RECORD.QA_REVIEW; BATCH_ABORT_APPROVED:
--     RECORD.PRODUCTION_APPROVE or RECORD.QA_REVIEW; BATCH_CANCELLED: STEP.SUPERVISE);
--   * the meanings each part of these commands may carry (recipe.execution_signature_meaning);
--   * the batch record as a signable aggregate (`batch_record`, aggregate id `<batch id>:record@<state version>`): the
--     approval of a skip or of a void, the two approvals of an abort and the signature of a cancellation are about the
--     batch as a whole, and the four aggregates of 0200 do not fit them (a void adds the voided attempt to its step's
--     content, so an approval signed on the step would be superseded by the act it approves; a phase about to be
--     skipped has no stored content yet). Its content is the batch's identity as issued (number, MBR content and
--     package, engine version, pinned policy, market set, size, site, time of issue) and the version of the stored
--     state it was signed on. Each state version is its own record, so its content never changes and a signature on
--     it is never superseded (recipe.batch_execution's identity columns are now frozen, trigger
--     ag_batch_record_identity), and recipe.check_signatures accepts only a signature on the state version the row
--     acts on: an approval binds the record exactly as it stood when it was given, and any row recorded since (a
--     sweep, another person's act) asks for it again. A person signs one approval of one meaning per state version
--     (esig, EBMR-ESIG-042), and every accepted act moves the version on. The record's state is the batch status the
--     projection holds (recipe.execution_state.status), stored with the signature (esig.signature_state_problem).
-- The guards of these commands are in 0451 (signatures) and 0452 (what an accepted row may store).
--
-- Message: EBMR-EXE-170 (a frozen identity column of a batch changed). New functions are owned by ebmr_owner, private
-- to the owner (no EXECUTE for PUBLIC); the provider is SECURITY DEFINER and pins its search_path with pg_temp last.

set local role ebmr_owner;

select kernel.set_actor_context(jsonb_build_object(
  'person_id', '00000000-0000-0000-0000-000000000000', 'account_id', '00000000-0000-0000-0000-000000000000',
  'role_code', 'SOFTWARE_RELEASE', 'session_id', '00000000-0000-0000-0000-000000000000', 'source', 'SYSTEM',
  'site_zone', 'UTC', 'correlation_id', gen_random_uuid(),
  'legal_name', 'Software release (recipe-core migration 0450_change_path_catalogue)',
  'reason_code', 'SOFTWARE_RELEASE',
  'reason_text', 'the change paths of a test run: skip, void, invalidation, abort and cancellation (DI-24, DI-29, DI-35)'));

insert into recipe.execution_command_permission (command_type, permissions, signed) values
  ('REQUEST_SKIP', array['STEP.EXECUTE', 'DISPENSE.EXECUTE', 'STEP.SUPERVISE'], true),
  ('VOID_ATTEMPT', array['STEP.EXECUTE', 'DISPENSE.EXECUTE'], true),
  ('INVALIDATE_RESULT', array['STEP.SUPERVISE', 'QA.FLOOR_APPROVE', 'RECORD.QA_REVIEW'], true),
  ('ABORT_BATCH', array['STEP.SUPERVISE', 'RECORD.PRODUCTION_APPROVE', 'QA.FLOOR_APPROVE', 'RECORD.QA_REVIEW'], true),
  ('CANCEL_BATCH', array['STEP.SUPERVISE'], true);

insert into recipe.execution_signature_meaning (command_type, part, meaning_code) values
  ('REQUEST_SKIP', 'approval', 'SKIP_APPROVED'),
  ('VOID_ATTEMPT', 'approval', 'VOID_AUTHORISED'),
  ('INVALIDATE_RESULT', 'approval', 'INVALIDATION_APPROVED'),
  ('ABORT_BATCH', 'approval', 'BATCH_ABORT_APPROVED'),
  ('CANCEL_BATCH', 'signature', 'BATCH_CANCELLED');

select kernel.set_actor_context(null);

do $$
begin
  if exists (select 1 from recipe.execution_signature_meaning m
             where not exists (select 1 from esig.meaning_type t where t.code = m.meaning_code and t.status = 'ACTIVE')) then
    raise exception using errcode = 'P0001', message = 'a signature meaning of recipe-core 0450 is not in the e-signature catalogue (DI-35)';
  end if;
  -- Every signed command type has a meaning for each part it carries: its own signature or an approval.
  if exists (select 1 from recipe.execution_command_permission c
             where c.signed and not exists (select 1 from recipe.execution_signature_meaning m where m.command_type = c.command_type)) then
    raise exception using errcode = 'P0001', message = 'a signed command type has no signature meaning in recipe.execution_signature_meaning (DI-35)';
  end if;
end
$$;

-- ---------------------------------------------------------------------------------------------
-- The batch record as a signable aggregate
-- ---------------------------------------------------------------------------------------------

-- DI-35, DI-37, INV-09: the content of the batch record p_id (`<batch id>:record@<state version>`): the batch's identity
-- as issued and the state version, one content version, and the batch status as the record's state. A state version the
-- batch has not reached (or a batch not yet issued) does not exist as a record.
create function recipe.batch_record_content(p_id text) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, recipe, pg_temp as $$
declare
  b         recipe.batch_execution;
  v_status  text;
  v_current integer;
  v_version integer;
begin
  if p_id !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:record@(0|[1-9][0-9]{0,8})$' then
    return jsonb_build_object('exists', false);
  end if;
  v_version := split_part(p_id, '@', 2)::integer;
  select * into b from recipe.batch_execution where id = split_part(p_id, ':', 1)::uuid;
  select s.status, s.state_version into v_status, v_current from recipe.execution_state s where s.batch_id = b.id;
  if b.id is null or v_status is null or v_version > v_current then
    return jsonb_build_object('exists', false);
  end if;
  return jsonb_build_object(
    'exists', true, 'content_version', 1, 'state', v_status, 'entered_by', '[]'::jsonb,
    'scope', jsonb_build_object('site', b.site_code),
    'content', jsonb_build_object(
      'batchId', b.id::text, 'batchNumber', b.batch_number, 'installation', b.installation, 'purpose', b.purpose,
      'packageHash', b.package_hash, 'mbrHash', b.content_hash, 'engineVersion', b.engine_version,
      'policyHash', b.policy_hash, 'marketSet', to_jsonb(b.market_set), 'batchSize', b.batch_size,
      'siteCode', b.site_code, 'issuedAtUs', b.issued_at_us::text, 'stateVersion', v_version));
end
$$;

select esig.register_content_provider('batch_record', 'recipe.batch_record_content(text)',
  'A batch record as a whole at one state version, by its identity as issued and its status: the approval of a skip or a void, the approvals of an abort and a cancellation (C3)');

-- INV-09: the identity of a batch, which its record's signed content holds, never changes once issued. EBMR-EXE-170.
create function recipe.batch_record_identity_guard() returns trigger
language plpgsql security definer set search_path = pg_catalog, recipe, pg_temp as $$
begin
  if (new.id, new.batch_number, new.installation, new.purpose, new.package_hash, new.content_hash, new.engine_version,
      new.policy_hash, new.market_set, new.batch_size, new.site_code, new.issued_at_us)
     is distinct from
     (old.id, old.batch_number, old.installation, old.purpose, old.package_hash, old.content_hash, old.engine_version,
      old.policy_hash, old.market_set, old.batch_size, old.site_code, old.issued_at_us) then
    raise exception using errcode = 'P0001',
      message = format('The identity of test batch %s is part of its signed record and never changes once issued (DI-37, INV-09). [EBMR-EXE-170]', old.batch_number);
  end if;
  return new;
end
$$;

create trigger ag_batch_record_identity before update on recipe.batch_execution
  for each row execute function recipe.batch_record_identity_guard();

revoke all on function recipe.batch_record_content(text), recipe.batch_record_identity_guard() from public;

reset role;
