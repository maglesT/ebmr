-- Recipe core, MBR life cycle and execution store (modules A3, C3): every role an MBR names is an engine role a session
-- can carry, and a QA hold point is released only by a role that can release one (Phase 2 exit review F48, F49; PR-45,
-- INV-26, PR-14; ADR 0012: the rules hold when the application's own database credentials are used directly).
--
-- What was wrong: MBR roles were free text from the parser to the engine. A master whose hold point named
-- PRODUCTION_OPERATOR as its releaser, or the kernel role QA_SHOP_FLOOR (shown in the designer exactly like the engine
-- role QA), or a step whose performer or checker named a role no session carries, was saved, passed the validation
-- gate (which DI-04 records as evidence) and reached the sandbox. The engine releases a hold point only with the role
-- the master names, so such a master either named a non-QA releaser of in-process material at a "QA hold point" or, for
-- a role outside the vocabulary, left the batch stuck at that step. Signing was already bound to QA.FLOOR_APPROVE at run
-- time (recipe.execution_command_permission, esig meanings); the master itself was never checked.
--
-- This migration adds:
--  - recipe.content_nodes(content): every flow node of the content (the procedure body and the body of each embedded
--    library element), walked through the members that hold child nodes only (a step's configuration is never read
--    as a node);
--  - recipe.hold_point_release_roles(): the engine roles that can release a hold point: an engine role reached
--    (recipe.engine_role_map) from a kernel role that holds, live, a permission DISPOSITION_HOLD_POINT needs
--    (recipe.execution_command_permission, iam.role_permission). With the seeded grants this is QA alone;
--  - recipe.content_role_problem(content): NULL unless a performer, checker, hold-point releaser, stage responsible
--    or role allowed to choose a branch (OPERATOR_CHOICE) is not an engine role (recipe.engine_role_permission), or is
--    not text, or a hold point's releaser is not one of the hold-point release roles;
--  - row triggers a3_content_roles before insert on recipe.mbr_content (a content revision of a master, EBMR-RCP-123)
--    and on recipe.test_package (the content of a sandbox test run, EBMR-RCP-123), whoever inserts.
-- The same rules run in TypeScript first: the validator (FLOW-ROLES, the engine roles read from this database) and the
-- engine's definition (ENG-DEF-HOLD-ROLE, policy qaRoles); the designer offers only these roles. Rows stored before
-- this migration are left as they were.
--
-- New functions are owned by ebmr_owner and private to the owner; the trigger function is SECURITY DEFINER; every
-- function pins its search_path with pg_temp last. Applied as a new migration because applied migrations are
-- checksummed and never edited.

set local role ebmr_owner;

-- Every flow node of MBR content p_content: the procedure body and each library element body, down through stage,
-- operation, loop and replicate bodies, sequence children and branch bodies.
create function recipe.content_nodes(p_content jsonb) returns setof jsonb
language sql immutable set search_path = pg_catalog, recipe, pg_temp as $$
  with recursive n(node) as (
    select p_content -> 'procedure' -> 'body' where jsonb_typeof(p_content -> 'procedure' -> 'body') = 'object'
    union all
    select e -> 'body' from jsonb_array_elements(case when jsonb_typeof(p_content -> 'library') = 'array' then p_content -> 'library' else '[]'::jsonb end) e
     where jsonb_typeof(e -> 'body') = 'object'
    union all
    select k.child
      from n,
           lateral (select n.node -> 'body' as child
                     where n.node ->> 'kind' in ('stage', 'operation', 'loop', 'replicate')
                    union all
                    select x from jsonb_array_elements(case when n.node ->> 'kind' = 'sequence' and jsonb_typeof(n.node -> 'children') = 'array' then n.node -> 'children' else '[]'::jsonb end) x
                    union all
                    select b -> 'body' from jsonb_array_elements(case when n.node ->> 'kind' in ('parallel', 'alternative') and jsonb_typeof(n.node -> 'branches') = 'array' then n.node -> 'branches' else '[]'::jsonb end) b) k
     where jsonb_typeof(k.child) = 'object'
  )
  select node from n
$$;

-- PR-45: the engine roles that can release a hold point (reached from a kernel role holding a permission the command
-- DISPOSITION_HOLD_POINT needs).
create function recipe.hold_point_release_roles() returns setof text
language sql stable set search_path = pg_catalog, recipe, iam, pg_temp as $$
  select distinct m.engine_role
    from recipe.engine_role_map m
    join iam.role_permission rp on rp.role_code = m.kernel_role and rp.removed_at is null
    join recipe.execution_command_permission c on c.command_type = 'DISPOSITION_HOLD_POINT' and rp.permission_code = any (c.permissions)
$$;

-- PR-45, INV-26, PR-14 (F48, F49): why the roles MBR content p_content names cannot all act; NULL when they can.
create function recipe.content_role_problem(p_content jsonb) returns text
language sql stable set search_path = pg_catalog, recipe, pg_temp as $$
  with nodes as (select node from recipe.content_nodes(p_content) node),
  named as (
    select node ->> 'id' as id, 'the performer of' as what, node -> 'signatures' -> 'perform' -> 'role' as role
      from nodes where node ->> 'kind' = 'phase' and jsonb_typeof(node -> 'signatures' -> 'perform') = 'object'
    union all
    select node ->> 'id', 'the checker of', node -> 'signatures' -> 'check' -> 'role'
      from nodes where node ->> 'kind' = 'phase' and jsonb_typeof(node -> 'signatures' -> 'check') = 'object'
    union all
    select node ->> 'id', 'the releaser of', node -> 'role' from nodes where node ->> 'kind' = 'holdPoint'
    union all
    select node ->> 'id', 'the person responsible for', node -> 'responsibleRole' from nodes where node ->> 'kind' = 'stage'
    union all
    select node ->> 'id', 'a role allowed to choose a branch of', r
      from nodes, jsonb_array_elements(case when jsonb_typeof(node -> 'decision' -> 'roles') = 'array' then node -> 'decision' -> 'roles' else '[]'::jsonb end) r
     where node ->> 'kind' = 'alternative' and node -> 'decision' ->> 'mode' = 'OPERATOR_CHOICE'
  ),
  problems as (
    select 1 as rank, format('%s %s is %s, which is not an engine role a session can carry (%s)', what, coalesce(id, '(no id)'), coalesce(role::text, 'missing'),
                             (select string_agg(distinct p.engine_role, ', ' order by p.engine_role) from recipe.engine_role_permission p)) as problem, id
      from named
     where jsonb_typeof(role) is distinct from 'string'
        or not exists (select 1 from recipe.engine_role_permission p where p.engine_role = named.role #>> '{}')
    union all
    select 2, format('hold point %s is released by %s; a QA hold point is released only by %s (PR-45)', coalesce(node ->> 'id', '(no id)'), node ->> 'role',
                     coalesce((select string_agg(r, ' or ' order by r) from recipe.hold_point_release_roles() r), 'no role of this installation')), node ->> 'id'
      from nodes
     where node ->> 'kind' = 'holdPoint' and jsonb_typeof(node -> 'role') = 'string'
       and exists (select 1 from recipe.engine_role_permission p where p.engine_role = node ->> 'role')
       and not exists (select 1 from recipe.hold_point_release_roles() r where r = node ->> 'role')
  )
  select problem from problems order by rank, id, problem limit 1
$$;

-- F48, F49: a content revision of a master and the content of a test package name only roles that can act.
create function recipe.content_roles_check() returns trigger
language plpgsql security definer set search_path = pg_catalog, recipe, pg_temp as $$
declare
  v_problem text := recipe.content_role_problem(new.content);
begin
  if v_problem is not null then
    raise exception using errcode = 'P0001',
      message = format('This MBR content is not stored: %s. Every role a master names must be one a person can carry, and a QA hold point is released by the quality unit (PR-45, INV-26). [EBMR-RCP-123]', v_problem);
  end if;
  return new;
end
$$;

create trigger a3_content_roles before insert on recipe.mbr_content for each row execute function recipe.content_roles_check();
create trigger a3_content_roles before insert on recipe.test_package for each row execute function recipe.content_roles_check();

revoke all on function recipe.content_nodes(jsonb), recipe.hold_point_release_roles(), recipe.content_role_problem(jsonb), recipe.content_roles_check() from public;

reset role;
