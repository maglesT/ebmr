-- Recipe core, execution store (module C3): an approval names its approver by the id of a person of this installation
-- (Phase 2 exit review F12, round 9 self-review after 0340; DI-05, DI-30; ADR 0012: the rules hold when the
-- application's own database credentials are used directly).
--
-- What was wrong. 0340 holds the roles an approval names; the approver's id was held by 0335 only to a text, and to the
-- signer of the approval's signature (also a text). On an accepted row recipe.check_signatures (0297) binds the id to an
-- e-signature of that person, but a refused row is checked by neither: through the application role, on the honest
-- store and engine path, a refused CORRECT_ENTRY approved by {id: 'L2409-0017'} (its signature's signer the same) was
-- recorded, and so was one naming a person id the installation does not have. The command's own actor is bound to the
-- person signed in (EBMR-EXE-039) and each signature's signer to that actor or approver (0335), so the approver's id was
-- the one person reference of a command bound to nothing.
--
-- What changed (recipe.execution_command, constraint trigger zz_execution_row_shape_approver_person, after insert, not
-- deferred, after 0340's zz_execution_row_shape_approver; recipe.approval_person_problem; EBMR-EXE-126): on every
-- COMMAND row, accepted or refused, each approval (command.approval and each of command.approvals) names as its
-- approver the id of a person of this installation (iam.person). A refused row keeps what was sent otherwise (decision
-- F12.5): the person named need not hold a role or have signed.
--
-- New functions are owned by ebmr_owner and private to the owner; the trigger function is SECURITY DEFINER; every
-- function pins its search_path with pg_temp last. Applied as a new migration because applied migrations are checksummed
-- and never edited.

set local role ebmr_owner;

-- DI-05, DI-30: why an approval of command p_command names an approver that is not a person of this installation; NULL
-- when every approval names one. 0335 holds the approval's shape (the id is a text).
create function recipe.approval_person_problem(p_command jsonb) returns text
language plpgsql stable set search_path = pg_catalog, recipe, iam, pg_temp as $$
declare
  v_path text;
  v_id   text;
begin
  if jsonb_typeof(p_command) is distinct from 'object' then
    return null;
  end if;
  for v_path, v_id in
    select 'command.approval', p_command -> 'approval' -> 'approver' ->> 'id' where p_command ? 'approval'
    union all
    select 'command.approvals[' || (a.i - 1) || ']', a.v -> 'approver' ->> 'id'
      from jsonb_array_elements(case when jsonb_typeof(p_command -> 'approvals') = 'array' then p_command -> 'approvals' else '[]'::jsonb end) with ordinality a (v, i)
  loop
    if v_id is null or v_id !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       or not exists (select 1 from iam.person p where p.id = v_id::uuid) then
      return format('%s.approver.id "%s" is not the id of a person of this installation', v_path, left(coalesce(v_id, 'none'), 64));
    end if;
  end loop;
  return null;
end
$$;

-- DI-05, DI-30: an approval names a person of this installation (header). EBMR-EXE-126. Raises; returns nothing.
create function recipe.execution_approval_person_check() returns trigger
language plpgsql security definer set search_path = pg_catalog, recipe, pg_temp as $$
declare
  v_problem text;
begin
  if new.kind is distinct from 'COMMAND' then
    return null;
  end if;
  v_problem := recipe.approval_person_problem(new.command);
  if v_problem is not null then
    raise exception using errcode = 'P0001',
      message = format('This %s %s row cannot be recorded: %s. An approval names its approver by the id of a person of this installation, so nothing sits in the record unread (DI-05, DI-30). [EBMR-EXE-126]',
                       case when new.accepted then 'accepted' else 'refused' end, coalesce(new.command_type, 'unknown'), v_problem);
  end if;
  return null;
end
$$;

create constraint trigger zz_execution_row_shape_approver_person after insert on recipe.execution_command
  for each row execute function recipe.execution_approval_person_check();

revoke all on function recipe.approval_person_problem(jsonb), recipe.execution_approval_person_check() from public;

reset role;
