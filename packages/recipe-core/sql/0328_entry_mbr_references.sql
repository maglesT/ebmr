-- Recipe core, execution store (module C3): an entry names only what its step's node in the batch's MBR names, so a
-- container never holds an identifier the MBR does not give it (Phase 2 exit review F12, round-3 verification; DI-05,
-- DI-30, PR-18, PR-21, PR-23; ADR 0012: the rules hold when the application's own database credentials are used
-- directly).
--
-- 0317 registers a new container as holding what the entry that registers it names: a dispensing weighing's BOM line
-- (G-07) or an output weighing's intermediate (G-22). Neither was compared with the MBR: tablets 0370, 0380 and 0390 read
-- the identifiers of an entry and the id of a container, never its contents. The round-3 verification intercepted the
-- server's own OUTPUT_CONTAINER on p-blend-out and stored, through the application role, the intermediate L2409-0017 (a
-- real lot-number format) with a result the engine gives only for a definition in which p-blend-out produces it: the
-- database answered 'ok', the record's container held L2409-0017, and the invariant query reported nothing, while the
-- engine on the real definition refuses it (G22-NOT-PRODUCED). The same holds for a weighing of a BOM line the step
-- does not dispense (G07-BOM-LINE).
--
-- The engine's blocks (blocks generic/material.ts, status.ts) accept an entry only when what it names is what the step's
-- node names. Read for this migration, the members that name the MBR and that the database did not compare:
--   * CONTAINER_WEIGHING (G-07): its bomLine is a line of the MBR's bill of materials that the step consumes
--     (G07-BOM-LINE); the container it registers holds that line;
--   * CHARGE_LOT (G-08): its bomLine likewise (G08-UNPLANNED);
--   * OUTPUT_CONTAINER (G-22): its intermediate is one the step produces (G22-NOT-PRODUCED); the container holds it;
--   * CHARGE_CONTAINER (G-08): its container is one the batch holds in quarantine (ENG-CONTAINER-UNKNOWN,
--     G08-CONSUMED), the entry states what the container holds, the step charges that content (an intermediate it uses,
--     a BOM line it consumes; G08-UNPLANNED), the container comes from the step's own sub-lot (G08-OTHER-SUBLOT), the
--     label scanned shows this batch's number (G08-LABEL; tablets 0370 reads only that it is a test batch number), and
--     the row consumes exactly the containers its charges name (0303 let any accepted RECORD_ENTRY of the step mark any
--     container in quarantine consumed);
--   * EQUIPMENT_STATUS (G-09): its equipmentRef is equipment the step lists for a status check, when it lists any
--     (G09-EQUIPMENT).
-- A row trigger on recipe.execution_state (zzc_execution_entry_references, after update; every row that adds an entry
-- or marks a container consumed) now refuses a row that breaks one of these (recipe.entry_reference_problem,
-- EBMR-EXE-126, the code of 0300, 0313 and 0317 for what a row's state records). The MBR is the batch's own package
-- content, which nobody can change after import. What an identifier looks like stays the edition's rule (tablets 0390);
-- an MBR's own ids are not read as lot numbers.
--
-- Not decided here, stated so it is not over-read: whether a lot is usable and of the line's material (lot status,
-- expiry, retest, identity test, material; G07-LOT-*, G07-WRONG-MATERIAL, PR-18 lot usability), a sample's point and
-- purpose against the sampling plan (G12-NOT-PLANNED), and the answers of a checklist against its configuration; they
-- stay with the replay (decision REPLAY-GATE.1).
--
-- The check is a pure function compared with the engine's own runs (packages/recipe-core/test/execution
-- entry-data-sql.test.ts). New functions are owned by ebmr_owner and private to the owner; the trigger function is
-- SECURITY DEFINER; every function pins its search_path with pg_temp last. Applied as a new migration because applied
-- migrations are checksummed and never edited.

set local role ebmr_owner;

-- Whether list p_list of MBR node p_node (consumes, produces, uses) names p_id (a JSON string).
create function recipe.node_names(p_node jsonb, p_list text, p_id jsonb) returns boolean
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select coalesce(jsonb_typeof(p_id) = 'string' and jsonb_typeof(p_node -> p_list) = 'array' and (p_node -> p_list) ? (p_id #>> '{}'), false)
$$;

-- DI-05, DI-30, PR-18, PR-21, PR-23 (F12, round 4): why an entry that state p_new adds (not in p_old), or a container it
-- marks consumed, stored by a row with command p_command of a batch of MBR content p_content, names something its
-- step's MBR node does not name (header); NULL when every one is the engine's. The text completes "This <row> ...".
create function recipe.entry_reference_problem(p_content jsonb, p_old jsonb, p_new jsonb, p_command jsonb) returns text
language plpgsql immutable set search_path = pg_catalog, recipe, pg_temp as $$
declare
  e0        jsonb := case when jsonb_typeof(p_old -> 'entries') = 'object' then p_old -> 'entries' else '{}'::jsonb end;
  c0        jsonb := case when jsonb_typeof(p_old -> 'containers') = 'object' then p_old -> 'containers' else '{}'::jsonb end;
  v_charged text[] := '{}';
  v_used    text[];
  k         text;
  e         jsonb;
  d         jsonb;
  v_inst    jsonb;
  v_node    jsonb;
  v_step    text;
  v_what    text;
  c         jsonb;
  v_checked text[];
begin
  for k, e in select x.key, x.value
                from jsonb_each(case when jsonb_typeof(p_new -> 'entries') = 'object' then p_new -> 'entries' else '{}'::jsonb end) x
               where not (e0 ? x.key)
               order by x.key loop
    d := case when jsonb_typeof(e -> 'data') = 'object' then e -> 'data' else '{}'::jsonb end;
    v_inst := p_new -> 'steps' -> (e ->> 'stepKey');
    v_step := v_inst ->> 'step';
    v_node := recipe.step_node(p_content, v_step);
    v_what := format('entry %s (%s) of step %s', k, coalesce(e ->> 'kind', 'unnamed'), coalesce(e ->> 'stepKey', '(none)'));
    case e ->> 'kind'
      when 'CONTAINER_WEIGHING', 'CHARGE_LOT' then
        if not recipe.node_names(v_node, 'consumes', d -> 'bomLine')
           or not exists (select 1
                            from jsonb_array_elements(case when jsonb_typeof(p_content -> 'bom') = 'array' then p_content -> 'bom' else '[]'::jsonb end) b (v)
                           where b.v -> 'id' = d -> 'bomLine') then
          return format('stores %s with BOM line %s, which is not a line of the MBR''s bill of materials that step %s %s',
                        v_what, coalesce(d ->> 'bomLine', '(none)'), coalesce(v_step, '(none)'),
                        case e ->> 'kind' when 'CONTAINER_WEIGHING' then 'dispenses' else 'charges' end);
        end if;
      when 'OUTPUT_CONTAINER' then
        if not recipe.node_names(v_node, 'produces', d -> 'intermediate') then
          return format('stores %s holding intermediate %s, which step %s does not produce', v_what, coalesce(d ->> 'intermediate', '(none)'), coalesce(v_step, '(none)'));
        end if;
      when 'CHARGE_CONTAINER' then
        c := case when jsonb_typeof(d -> 'container') = 'string' then c0 -> (d ->> 'container') end;
        if jsonb_typeof(c) is distinct from 'object' or c ->> 'status' is distinct from 'QUARANTINE' then
          return format('stores %s charging container %s, which the batch did not hold in quarantine before the row', v_what, coalesce(d ->> 'container', '(none)'));
        end if;
        if (d -> 'holds') is distinct from (c -> 'holds') then
          return format('stores %s stating that container %s holds %s, where it holds %s', v_what, d ->> 'container', coalesce(d ->> 'holds', '(nothing)'), c ->> 'holds');
        end if;
        if not coalesce((c ->> 'holdsKind' = 'INTERMEDIATE' and recipe.node_names(v_node, 'uses', c -> 'holds'))
                        or (c ->> 'holdsKind' = 'BOM_LINE' and recipe.node_names(v_node, 'consumes', c -> 'holds')), false) then
          return format('stores %s charging container %s, which holds %s (%s), and step %s does not charge it', v_what, d ->> 'container', c ->> 'holds', coalesce(c ->> 'holdsKind', '?'), coalesce(v_step, '(none)'));
        end if;
        if exists (select 1
                     from jsonb_array_elements(case when jsonb_typeof(c -> 'producedIn') = 'array' then c -> 'producedIn' else '[]'::jsonb end) f (v)
                     join jsonb_array_elements(case when jsonb_typeof(v_inst -> 'frames') = 'array' then v_inst -> 'frames' else '[]'::jsonb end) g (v)
                       on g.v -> 'construct' = f.v -> 'construct'
                    where g.v -> 'index' is distinct from f.v -> 'index') then
          return format('stores %s charging container %s, which belongs to another instance of a construct around step %s', v_what, d ->> 'container', e ->> 'stepKey');
        end if;
        if (p_command -> 'entry' -> 'scannedBatch') is distinct from (p_new -> 'header' -> 'batchNumber') then
          return format('stores %s charging container %s whose scanned label shows batch %s, not this batch %s',
                        v_what, d ->> 'container', coalesce(p_command -> 'entry' ->> 'scannedBatch', '(none)'), coalesce(p_new -> 'header' ->> 'batchNumber', '(none)'));
        end if;
        v_charged := v_charged || (d ->> 'container');
      when 'EQUIPMENT_STATUS' then
        select coalesce(array_agg(q.v ->> 'ref' order by q.v ->> 'ref'), '{}') into v_checked
          from jsonb_array_elements(case when jsonb_typeof(v_node -> 'equipment') = 'array' then v_node -> 'equipment' else '[]'::jsonb end) q (v)
         where q.v ->> 'use' = 'STATUS_CHECK';
        if cardinality(v_checked) > 0 and not coalesce(d ->> 'equipmentRef' = any (v_checked), false) then
          return format('stores %s for equipment %s, which step %s does not check (%s)', v_what, coalesce(d ->> 'equipmentRef', '(none)'), coalesce(v_step, '(none)'), array_to_string(v_checked, ', '));
        end if;
      else
        null;
    end case;
  end loop;
  -- The containers the row marks consumed are exactly those its charges name.
  select coalesce(array_agg(x.key order by x.key), '{}') into v_used
    from jsonb_each(case when jsonb_typeof(p_new -> 'containers') = 'object' then p_new -> 'containers' else '{}'::jsonb end) x
   where x.value ->> 'status' = 'CONSUMED' and (c0 -> x.key ->> 'status') is distinct from 'CONSUMED';
  if v_used is distinct from (select coalesce(array_agg(distinct u order by u), '{}') from unnest(v_charged) u) then
    return format('marks container(s) %s consumed, where the charges it records name %s',
                  coalesce(nullif(array_to_string(v_used, ', '), ''), '(none)'), coalesce(nullif(array_to_string(v_charged, ', '), ''), '(none)'));
  end if;
  return null;
end
$$;

-- DI-05, DI-30, PR-18, PR-21, PR-23 (F12, round 4): an entry a row adds names only what its step's MBR node names, and
-- a container is consumed only by the charge that names it (header). EBMR-EXE-126. Raises; returns nothing.
create function recipe.execution_entry_references_check() returns trigger
language plpgsql security definer set search_path = pg_catalog, recipe, pg_temp as $$
declare
  r         recipe.execution_command;
  v_content jsonb;
  v_problem text;
begin
  if not exists (select 1
                   from jsonb_object_keys(case when jsonb_typeof(new.state -> 'entries') = 'object' then new.state -> 'entries' else '{}'::jsonb end) k
                  where not coalesce((old.state -> 'entries') ? k, false))
     and not exists (select 1
                       from jsonb_each(case when jsonb_typeof(new.state -> 'containers') = 'object' then new.state -> 'containers' else '{}'::jsonb end) x
                      where x.value ->> 'status' = 'CONSUMED' and (old.state -> 'containers' -> x.key ->> 'status') is distinct from 'CONSUMED') then
    return null;
  end if;
  select * into r from recipe.execution_command c where c.batch_id = new.batch_id and c.seq = new.last_seq;
  select pk.content into v_content from recipe.batch_execution b join recipe.test_package pk on pk.package_hash = b.package_hash where b.id = new.batch_id;
  v_problem := recipe.entry_reference_problem(v_content, old.state, new.state, r.command);
  if v_problem is not null then
    raise exception using errcode = 'P0001',
      message = format('This %s %s row %s: an entry names only what its step''s node in the batch''s MBR names (the BOM lines it dispenses or charges, the intermediates it produces or uses, the equipment it checks), so the record never holds what the MBR does not give it (DI-05, DI-30, PR-18, PR-21, PR-23). [EBMR-EXE-126]',
                       case when r.kind = 'PREPARE' then 'preparation' when r.kind = 'COMMAND' and r.accepted then 'accepted' when r.kind = 'COMMAND' then 'refused' else lower(coalesce(r.kind, 'unknown')) end,
                       coalesce(r.command_type, r.kind, 'unknown'), v_problem);
  end if;
  return null;
end
$$;

create trigger zzc_execution_entry_references after update on recipe.execution_state
  for each row execute function recipe.execution_entry_references_check();

revoke all on function recipe.node_names(jsonb, text, jsonb), recipe.entry_reference_problem(jsonb, jsonb, jsonb, jsonb),
                       recipe.execution_entry_references_check() from public;

reset role;
