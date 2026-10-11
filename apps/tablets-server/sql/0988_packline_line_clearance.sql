-- Tablets server, Phase 3 slice 4b review (builder B): a bottle line (TB-23) or cartoning (TB-24) step records only on a
-- packaging line that runs this batch's packaging order now, on a passed and verified PACKAGING_ORDER clearance for that
-- order and the artwork set its printed materials carry, and a potent or beta-lactam product only on a line flagged
-- isolated (controls PR-34, PR-35, IN-38; L-29; ADR 0012: the rules hold when the application's own database credentials
-- are used directly).
--
-- A row trigger on recipe.execution_state (zzj_tab_packline_line, after update; every row of a batch whose MBR has a TB-23
-- or TB-24 step) refuses a row with a new entry of such a step unless (EBMR-TAB-384):
--   * the step's plant unit is on a LINE area occupied now by this batch's packaging order (its batch number), on a passed
--     and verified PACKAGING_ORDER clearance for that order whose artwork set is the occupancy's, and that artwork set is
--     the one the step's G-21 step names (labelStep of TB-23, printedStep of TB-24): its items in configuration order as
--     <item id>:<artwork version>, joined by ',' (default; the version the master names for every market of the batch,
--     G-21's own issue rule) (TB23-LINE, TB24-LINE; PR-34, PR-35). The check is tablets 0972's tab.blister_line_problem,
--     called, never copied;
--   * when the product is potent (plant.product.highly_potent of the batch's product, as TB-21 reads it) or the MBR's
--     header predicate betaLactam is true, the line is flagged isolated (tab.line_isolated, tablets 0970, through 0972's
--     tab.blister_isolation_problem) (TB23-ISOLATION, TB24-ISOLATION; IN-38). A bottle or carton step does not know
--     whether the tablets are coated, so it is held to the stricter rule.
--
-- New functions are owned by ebmr_owner, private to it, and pin their search_path with pg_temp last (ADR 0016). Applied
-- as a new migration because applied migrations are checksummed and never edited.

set local role ebmr_owner;

select kernel.set_actor_context(jsonb_build_object(
  'person_id', '00000000-0000-0000-0000-000000000000', 'account_id', '00000000-0000-0000-0000-000000000000',
  'role_code', 'SOFTWARE_RELEASE', 'session_id', '00000000-0000-0000-0000-000000000000', 'source', 'SYSTEM',
  'site_zone', 'UTC', 'correlation_id', gen_random_uuid(),
  'legal_name', 'Software release (tablets migration 0988_packline_line_clearance)',
  'reason_code', 'SOFTWARE_RELEASE',
  'reason_text', 'the line clearance and isolation rule codes of TB-23@1 and TB-24@1 (slice 4b review; PR-34, PR-35, IN-38)'));

insert into recipe.engine_name (name, kind) values
  ('TB23-LINE', 'RULE_CODE'), ('TB23-ISOLATION', 'RULE_CODE'), ('TB24-LINE', 'RULE_CODE'), ('TB24-ISOLATION', 'RULE_CODE');

select kernel.set_actor_context(null);

-- The artwork set G-21 step p_g21 names for a batch of markets p_markets: its items in order as <id>:<version>, joined by
-- ','; NULL when an item names different versions for the markets, or none for one.
create function tab.packline_artwork_set(p_g21 jsonb, p_markets jsonb) returns text
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select case when bool_and(v.ok) then string_agg((i.x ->> 'id') || ':' || v.art, ',' order by i.n) end
    from jsonb_array_elements(case when jsonb_typeof(p_g21 -> 'config' -> 'items') = 'array' then p_g21 -> 'config' -> 'items' else '[]'::jsonb end) with ordinality i (x, n)
   cross join lateral (
     select min(i.x -> 'artwork' ->> m) as art,
            count(distinct i.x -> 'artwork' ->> m) = 1 and bool_and(i.x -> 'artwork' ->> m is not null) as ok
       from jsonb_array_elements_text(case when jsonb_typeof(p_markets) = 'array' then p_markets else '[]'::jsonb end) m) v
$$;

-- PR-34, PR-35, IN-38 (header): why a new entry of a TB-23 or TB-24 step in row p_new is not made on a line cleared for
-- this batch's packaging order and its artwork set, or on an isolated line where the product needs one; NULL when none.
create function tab.packline_line_problem(p_batch uuid, p_content jsonb, p_old jsonb, p_new jsonb) returns text
language plpgsql stable security definer set search_path = pg_catalog, tab, recipe, plant, pg_temp as $$
declare
  e0       jsonb := case when jsonb_typeof(p_old -> 'entries') = 'object' then p_old -> 'entries' else '{}'::jsonb end;
  k        text;
  e        jsonb;
  v_node   jsonb;
  v_type   text;
  v_code   text;
  v_unit   text;
  v_set    text;
  v_p      text;
begin
  for k, e in select x.key, x.value from jsonb_each(case when jsonb_typeof(p_new -> 'entries') = 'object' then p_new -> 'entries' else '{}'::jsonb end) x
               where not (e0 ? x.key) order by (x.value ->> 'recordedSeq')::numeric, x.key loop
    v_node := recipe.step_node(p_content, p_new -> 'steps' -> (e ->> 'stepKey') ->> 'step');
    v_type := v_node -> 'block' ->> 'type';
    continue when v_type is null or v_type not in ('TB-23', 'TB-24');
    v_code := replace(v_type, '-', '');
    v_unit := v_node -> 'config' ->> 'unit';
    v_set := tab.packline_artwork_set(tab.packline_g21(p_content, v_node -> 'config' ->> case when v_type = 'TB-23' then 'labelStep' else 'printedStep' end),
                                      p_new -> 'header' -> 'marketSet');
    v_p := tab.blister_line_problem(p_batch, v_unit, coalesce(v_set, '(no single artwork set)'));
    if v_p is not null then
      return format('stores entry %s (%s) of step %s, but %s', k, e ->> 'kind', e ->> 'stepKey', replace(v_p, 'TB21-LINE', v_code || '-LINE'));
    end if;
    if tab.blister_isolation_problem(p_batch, jsonb_build_object('product', jsonb_build_object('uncoated', true,
                                       'betaLactam', coalesce((p_content -> 'header' -> 'predicates' -> 'betaLactam') = 'true'::jsonb, false))), v_unit) is not null then
      return format('stores entry %s (%s) of step %s, but the product is potent or beta-lactam and the line of unit %s is not flagged isolated (%s-ISOLATION; IN-38)',
                    k, e ->> 'kind', e ->> 'stepKey', left(coalesce(v_unit, '(none)'), 64), v_code);
    end if;
  end loop;
  return null;
end
$$;

-- The row trigger (header).
create function tab.packline_line_check() returns trigger
language plpgsql security definer set search_path = pg_catalog, tab, recipe, pg_temp as $$
declare
  r         recipe.execution_command;
  v_content jsonb;
  v_problem text;
begin
  v_content := recipe.batch_mbr_content(new.batch_id);
  if not exists (select 1 from tab.packline_nodes(v_content)) then
    return null;
  end if;
  v_problem := tab.packline_line_problem(new.batch_id, v_content, old.state, new.state);
  if v_problem is not null then
    select * into r from recipe.execution_command c where c.batch_id = new.batch_id and c.seq = new.last_seq;
    raise exception using errcode = 'P0001',
      message = format('This %s %s row %s: a bottle line or cartoning step runs only on a line cleared for its packaging order and artwork set and occupied by it now, isolated where the product needs it (PR-34, PR-35, IN-38). [EBMR-TAB-384]',
                       case when r.kind = 'COMMAND' and r.accepted then 'accepted' when r.kind = 'COMMAND' then 'refused' else lower(coalesce(r.kind, 'unknown')) end,
                       coalesce(r.command_type, r.kind, 'unknown'), v_problem);
  end if;
  return null;
end
$$;

create trigger zzj_tab_packline_line after update on recipe.execution_state
  for each row execute function tab.packline_line_check();

revoke all on function tab.packline_artwork_set(jsonb, jsonb), tab.packline_line_problem(uuid, jsonb, jsonb, jsonb), tab.packline_line_check() from public;

reset role;
