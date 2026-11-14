-- Injectables I-6, INV-23 (b) (lead rulings, 14 November 2026): on every market, a master with a filling step and no
-- terminal sterilisation step fills aseptically, so it monitors the environment during the operation and enters the
-- counts after the filling. Binding clause: 21 CFR 211.42(c)(10)(iv) (an aseptic processing area has a system for
-- monitoring its environmental conditions). A terminally sterilised master is not refused: the clause binds aseptic
-- processing only, and Schedule M 4.8's facility monitoring is the room logbook the owner deferred.
-- The validator's rule INJ-ASEPTIC-EM (recipe-core validator/rules-content.ts) refuses such a master on screen; this
-- migration re-checks it in the database when QA approves the master, so a master that reached approval past the
-- validator is refused too. Both read the roles of the master's block snapshots (recipe.library_definition, 1810),
-- never block codes, so a firm's own QA-approved blocks count (decision 0026):
--   FILLING (INJ-FILL), TERMINAL_STERILISATION (INJ-TERMINAL-STERILISE), EM_IN_OPERATION (INJ-EM), EM_COUNTS
--   (INJ-EM-COUNTS), set on the catalogue blocks by their v1 edit in place (lead ruling).
--
-- Handbook: modules/injectables.md
--
--   injectables.aseptic_em_problem(content)   NULL (also when no block snapshot has the role FILLING), or why the master's aseptic fill lacks its environmental monitoring:
--       no step with the role EM_IN_OPERATION, or a filling step that reaches no EM_COUNTS step after it
--       (recipe.flow_reaches, 0308). A procedure the database cannot read (recipe.flow_tree's 'bad') is refused: when
--       it cannot tell, it requires the monitoring (lead ruling). The validator asks the counts after the fill on every
--       path; the database asks that they follow it (reachable), the backstop for a master that bypassed the validator.
--   trigger a4c_aseptic_em_at_approval        QA's approval of a master (platform.state_history, mbr_version APPROVE)
--       is refused while the problem stands (EBMR-RCP-439).
--
-- PL/pgSQL, SECURITY DEFINER, search_path pinned with pg_temp last (ADR 0016).

set local role ebmr_owner;

create function injectables.aseptic_em_problem(p_content jsonb) returns text
language plpgsql stable security definer set search_path = pg_catalog, injectables, recipe, pg_temp as $$
declare
  v_tree   jsonb := recipe.flow_tree(p_content);
  v_fills  text[] := '{}';
  v_counts text[] := '{}';
  v_em     boolean := false;
  v_term   boolean := false;
  v_roles  jsonb;
  id       text;
  f        text;
begin
  -- No block snapshot with the role FILLING: not concerned (every tablets master, for one), whatever its procedure. A
  -- coarse filter: the loop below decides by each step's own snapshot, roles read only from an array.
  if not exists (select 1 from jsonb_array_elements(case when jsonb_typeof(p_content -> 'blockDefinitions') = 'array' then p_content -> 'blockDefinitions' else '[]'::jsonb end) d
                  where d -> 'roles' ? 'FILLING') then
    return null;
  end if;
  if v_tree ? 'bad' then
    return format('its procedure cannot be read (%s), so the database cannot tell whether it fills aseptically', v_tree ->> 'bad');
  end if;
  for id in select x.key from jsonb_each(v_tree -> 'ids') x where x.value ->> 'kind' = 'phase' order by (x.value ->> 'n')::integer loop
    v_roles := recipe.library_definition(p_content, recipe.step_node(p_content, id) -> 'block') -> 'roles';
    if jsonb_typeof(v_roles) is distinct from 'array' then
      continue;
    end if;
    if v_roles ? 'FILLING' then
      v_fills := v_fills || id;
    end if;
    if v_roles ? 'TERMINAL_STERILISATION' then
      v_term := true;
    end if;
    if v_roles ? 'EM_IN_OPERATION' then
      v_em := true;
    end if;
    if v_roles ? 'EM_COUNTS' then
      v_counts := v_counts || id;
    end if;
  end loop;
  if cardinality(v_fills) = 0 or v_term then
    return null;
  end if;
  if not v_em then
    return format('the filling step %s fills aseptically (the master has no terminal sterilisation step) and the master has no step that monitors the environment during the operation (a block with the role EM_IN_OPERATION)', v_fills[1]);
  end if;
  foreach f in array v_fills loop
    if not exists (select 1 from unnest(v_counts) c where recipe.flow_reaches(v_tree, f, false, c)) then
      return format('the filling step %s fills aseptically and no step after it enters the environmental monitoring counts (a block with the role EM_COUNTS)', f);
    end if;
  end loop;
  return null;
end
$$;

create function injectables.aseptic_em_at_approval_check() returns trigger
language plpgsql security definer set search_path = pg_catalog, injectables, recipe, pg_temp as $$
declare
  v_prob text;
begin
  if new.aggregate_type = 'mbr_version' and new.event = 'APPROVE' then
    v_prob := injectables.aseptic_em_problem((recipe.current_content(new.aggregate_id)).content);
    if v_prob is not null then
      raise exception using errcode = 'P0001',
        message = format('EBMR-RCP-439 this master cannot be approved: %s (INV-23; an aseptic processing area monitors its environment, 21 CFR 211.42(c)(10)(iv))', v_prob);
    end if;
  end if;
  return new;
end
$$;

create trigger a4c_aseptic_em_at_approval before insert on platform.state_history for each row execute function injectables.aseptic_em_at_approval_check();

revoke all on function injectables.aseptic_em_problem(jsonb), injectables.aseptic_em_at_approval_check() from public;

reset role;
