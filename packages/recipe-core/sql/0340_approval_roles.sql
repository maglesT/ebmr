-- Recipe core, execution store (module C3): an approval names only the engine roles its approver holds (Phase 2 exit
-- review F12, the lane's round-2 verification; DI-05, DI-30, INV-26; ADR 0012: the rules hold when the application's own
-- database credentials are used directly).
--
-- What was wrong. recipe-core 0335 holds an approval ({approver, signature}: of CORRECT_ENTRY, REQUEST_SKIP, VOID_ATTEMPT,
-- INVALIDATE_RESULT, and each of ABORT_BATCH's approvals) to its members, the approver's roles to a list of texts.
-- recipe.check_signatures (0297) reads the approver's kind, id and signature only, and recipe.check_engine_roles (0270)
-- binds the roles of the command's actor only: it reads p_command -> 'actor', never an approval. The engine asks of an
-- approver one supervisor or QA role (engine corrections.ts requireRole) and reads no other, so the release gate's replay
-- reproduces such a row exactly. Through the application role, on the honest store and engine path, the round-2
-- verification recorded an accepted CORRECT_ENTRY whose approval named qa1 as {roles: ['QA', 'L2409-0017']}: the
-- real-format lot number sat in the command, 'ok', with an identical replay and no violation. An approver could also be
-- named in an engine role they do not hold (qa1, who signs as QA_SHOP_FLOOR, as PRODUCTION_SUPERVISOR), which the engine
-- accepts for a supervisor's approval.
--
-- Correction of the inventory of the lane's round 2 (its report said the roles of a command are normalised by
-- recipe.check_engine_roles), stated here because applied migrations are never edited: check_engine_roles covers the
-- roles of the command's actor (every COMMAND and PREPARE row) and recipe.issue_execution those of the issuer named in an
-- issue request; nothing bound the roles an approval names until this migration.
--
-- What changed (recipe.execution_command, constraint trigger zz_execution_row_shape_approver, after insert, not
-- deferred, after zz_execution_row_shape of 0335, which holds the approval's shape; EBMR-EXE-126):
--   * recipe.approval_roles_problem: on an accepted COMMAND row, every role an approval names is an engine role its
--     approver holds through the authority behind the approver's own signature: the approval's signature is an
--     e-signature of that approver (recipe.check_signatures has already checked it for CORRECT_ENTRY, the one approved
--     command an accepted row may carry in this release), and each role is one the role map of decision D4
--     (recipe.engine_role_map) gives the signer's declared kernel role (esig.signature.signer_role_code) through the
--     permission the kernel evaluated, and allowed, for that person when they signed (the signature's
--     authority_evaluation_id), as recipe.check_engine_roles holds the actor's roles to an allowed evaluation of the
--     role's permission in the declared kernel role. On a refused row (what was sent, decision F12.5) every role an
--     approval names is an engine role (recipe.engine_role_permission).
--   An approval naming no role passes: the engine then refuses the approval of critical data itself (requireRole), and
--   the row records that refusal.
--
-- New functions are owned by ebmr_owner and private to the owner; the trigger function is SECURITY DEFINER; every
-- function pins its search_path with pg_temp last. Applied as a new migration because applied migrations are checksummed
-- and never edited.

set local role ebmr_owner;

-- DI-05, DI-30, INV-26 (F12, lane round 2): why an approval of command p_command (an accepted row: p_accepted) names a
-- role its approver may not be recorded in; NULL when every role is one it may. Reads command.approval and each of
-- command.approvals; 0335 holds their shape (a role is a text).
create function recipe.approval_roles_problem(p_command jsonb, p_accepted boolean) returns text
language plpgsql stable set search_path = pg_catalog, recipe, esig, iam, pg_temp as $$
declare
  v_path text;
  v_ap   jsonb;
  v_id   uuid;
  s      esig.signature;
  e      iam.authority_evaluation;
  v_held text[];
  v_role text;
  n      bigint;
begin
  if jsonb_typeof(p_command) is distinct from 'object' then
    return null;
  end if;
  for v_path, v_ap in
    select 'command.approval', p_command -> 'approval' where p_command ? 'approval'
    union all
    select 'command.approvals[' || (a.i - 1) || ']', a.v
      from jsonb_array_elements(case when jsonb_typeof(p_command -> 'approvals') = 'array' then p_command -> 'approvals' else '[]'::jsonb end) with ordinality a (v, i)
  loop
    if jsonb_typeof(v_ap -> 'approver' -> 'roles') is distinct from 'array' then
      return v_path || '.approver.roles must be a list of engine roles';
    end if;
    if p_accepted then
      begin
        v_id := (v_ap -> 'signature' ->> 'id')::uuid;
      exception when invalid_text_representation then
        v_id := null;
      end;
      select * into s from esig.signature g where g.id = v_id;
      if not found or s.signer_person::text is distinct from v_ap -> 'approver' ->> 'id' then
        return v_path || ' names no e-signature of its approver, so no role it names is backed by an authority';
      end if;
      select * into e from iam.authority_evaluation x where x.id = s.authority_evaluation_id;
      v_held := array(select m.engine_role from recipe.engine_role_map m
                       where e.allowed and e.person_id = s.signer_person and m.kernel_role = s.signer_role_code and m.via_permission = e.permission_code
                       order by m.engine_role collate "C");
    end if;
    for v_role, n in select x.v, x.i from jsonb_array_elements_text(v_ap -> 'approver' -> 'roles') with ordinality x (v, i) order by x.i loop
      if p_accepted and not (v_role = any (v_held)) then
        return format('%s.approver.roles[%s] "%s" is not an engine role its approver holds: the authority behind the approval''s signature (%s, through %s) carries %s',
                      v_path, n - 1, left(v_role, 64), s.signer_role_code, coalesce(e.permission_code, 'no evaluation'),
                      coalesce(nullif(array_to_string(v_held, ', '), ''), 'no engine role'));
      end if;
      if not exists (select 1 from recipe.engine_role_permission rp where rp.engine_role = v_role) then
        return format('%s.approver.roles[%s] "%s" is not an engine role', v_path, n - 1, left(v_role, 64));
      end if;
    end loop;
  end loop;
  return null;
end
$$;

-- DI-05, DI-30, INV-26: an approval names only roles its approver may be recorded in (header). EBMR-EXE-126. Raises;
-- returns nothing.
create function recipe.execution_approval_roles_check() returns trigger
language plpgsql security definer set search_path = pg_catalog, recipe, pg_temp as $$
declare
  v_problem text;
begin
  if new.kind is distinct from 'COMMAND' then
    return null;
  end if;
  v_problem := recipe.approval_roles_problem(new.command, new.accepted is true);
  if v_problem is not null then
    raise exception using errcode = 'P0001',
      message = format('This %s %s row cannot be recorded: %s. An approval names only the engine roles its approver holds, read from the authority behind the approver''s own signature, and a refused row''s approval only engine roles, so nothing sits in the record unread (DI-05, DI-30, INV-26). [EBMR-EXE-126]',
                       case when new.accepted then 'accepted' else 'refused' end, coalesce(new.command_type, 'unknown'), v_problem);
  end if;
  return null;
end
$$;

create constraint trigger zz_execution_row_shape_approver after insert on recipe.execution_command
  for each row execute function recipe.execution_approval_roles_check();

revoke all on function recipe.approval_roles_problem(jsonb, boolean), recipe.execution_approval_roles_check() from public;

reset role;
