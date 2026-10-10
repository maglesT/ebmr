-- Tablets server, Phase 3 slice 3b (builder B): the rules of the granulation blocks TB-02, TB-03, TB-04, TB-05 and
-- TB-07 held by the database (tablets spec B.2; controls IN-36, IN-13, PR-08, PR-29, PR-30, DI-29, DI-31, INV-24,
-- INV-25; ADR 0012: the rules hold when the application's own database credentials are used directly).
--
-- recipe.entry_block_problem (recipe-core 0520) checks the entry kinds of the generic blocks, G-06's included (the
-- process values of TB-04, TB-05 and TB-07 are G-06 entries: their data there, their reading in tablets 0820), and lets
-- every other kind through; recipe-core 0332 holds each entry to its block's data schema (tablets 0850). This migration
-- adds a row trigger on recipe.execution_state (zt_tab_granulation, after update; every row) that refuses a row unless:
--
--   1. every new entry of a granulation step holds exactly what its block builds (src/blocks/tb-0x.ts) from what was
--      entered, the batch's MBR, the step's earlier entries, the person and the row's database time, and only what the
--      block accepts; and the exception the block raises with it is in the same row, as the engine raises it (severity
--      ACTION, a deviation required, the steps after it blocked until one is linked). In particular:
--        TB-02  a screen of the MBR with its approved aperture, checks alternating BEFORE and AFTER per screen, a screen
--               found damaged in any step of the batch never checked or used again (stricter than the engine, which sees
--               its own step), a material pass only through a screen in use, quantities consistent, the oversize where
--               the MBR examines it; an AFTER check that finds the screen damaged names in `held` exactly the passes
--               made through it since its last intact check (INV-24, IN-36 (b)) and comes with SCREEN_INTEGRITY_FAILED;
--        TB-03  one preparation, its use-by timer started at the row's time (preparedAtUs, useByUs from the MBR's use-by);
--               what is discarded and what the batch's binder additions used never more than was prepared;
--        TB-04  the end point on a usable collected value of the end-point tag of the same step (or the massing time
--               measured at the server's times, never below the minimum), a manual end point with a reason and a second
--               person; a binder addition only of a TB-03 preparation of this batch, refused once that solution's
--               use-by has passed at the row's database time (TB04-BINDER-EXPIRED) or when it would use more than was
--               prepared; extra fluid only where the MBR allows it and by a role it names;
--        TB-05  drying after an intact bag check (fluid bed), a bag of another product only with its wash record, a
--               product-dedicated bag where the MBR asks for one, the drying time measured;
--        TB-07  the main blend ended no earlier than its minimum, the lubricant only after it, the lubrication ended no
--               earlier than its minimum, times measured; blend-uniformity samples of the plan only, once each, after
--               blending, a sample outside 1 to 3 unit doses only with a justification;
--   2. a value of an item the block computes (TB-04's end-point item, TB-07's blend and lubrication time items) is the
--      block's own, from the entry it comes from, never typed (INV-25; it is then judged against the item's limit tiers
--      as every value is, recipe-core 0305: PR-08);
--   3. a granulation step closes (IN_PROGRESS to AWAITING_VERIFICATION or COMPLETED) only complete: TB-02 with every
--      screen checked after use (IN-36: the after-use check is mandatory) and something processed; TB-03 prepared;
--      TB-04 with its end point (and its extra fluid in the extra-fluid branch), a binder total outside the MBR's range
--      raised as BINDER_QUANTITY_OUT_OF_RANGE; TB-05 dried, sampled and (fluid bed) its bag checked after use; TB-07
--      blended (and lubricated), every planned BU sample taken or BU_LOCATION_MISSING raised;
--   4. a TB-05 step instance never runs beyond the maximum iterations of the loop it sits in (and never beyond 10, the
--      block's bound): the LOD loop is bounded (DI-34), not rework.
-- EBMR-EXE-250 (entries), EBMR-EXE-251 (computed items), EBMR-EXE-252 (closing a step), EBMR-EXE-253 (the loop bound).
--
-- New functions are owned by ebmr_owner and private to the owner; the trigger function is SECURITY DEFINER; every
-- function pins its search_path with pg_temp last (ADR 0016). Applied as a new migration because applied migrations are
-- checksummed and never edited.

set local role ebmr_owner;

-- Seconds between two instants in microseconds, exactly, written with six decimals (common.ts secondsText).
create function tab.gran_seconds(p_us numeric) returns text
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select ((p_us / 1000000)::numeric(40, 6))::text
$$;

-- A quantity as the blocks keep it: {value, unit} of the entered one.
create function tab.gran_qty(p jsonb) returns jsonb
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select case when jsonb_typeof(p) = 'object' then jsonb_build_object('value', p -> 'value', 'unit', p -> 'unit') end
$$;

-- The entries of step instance p_key in state p_state recorded before sequence p_before, of kind p_kind (any when NULL),
-- in the order recorded.
create function tab.gran_prior(p_state jsonb, p_key text, p_before numeric, p_kind text) returns jsonb
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select coalesce(jsonb_agg(x.value order by (x.value ->> 'recordedSeq')::numeric), '[]'::jsonb)
    from jsonb_each(case when jsonb_typeof(p_state -> 'entries') = 'object' then p_state -> 'entries' else '{}'::jsonb end) x
   where x.value ->> 'stepKey' = p_key and (x.value ->> 'recordedSeq')::numeric < p_before
     and (p_kind is null or x.value ->> 'kind' = p_kind)
$$;

-- Whether row p_new raised (newly against p_old) an exception of type p_type at step instance p_key that holds the
-- steps after it until a deviation is linked: severity ACTION, a deviation required (as blocks/tb-0x.ts raise them).
create function tab.gran_held(p_old jsonb, p_new jsonb, p_key text, p_type text) returns boolean
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select exists (
    select 1 from jsonb_each(case when jsonb_typeof(p_new -> 'exceptions') = 'object' then p_new -> 'exceptions' else '{}'::jsonb end) x
     where not coalesce((p_old -> 'exceptions') ? x.key, false) and x.value ->> 'type' = p_type and x.value -> 'source' ->> 'stepKey' = p_key
       and x.value ->> 'severity' = 'ACTION' and (x.value -> 'deviationRequired') = 'true'::jsonb
       and x.value -> 'block' ->> 'until' = 'DEVIATION' and jsonb_typeof(x.value -> 'block' -> 'downstream') = 'object')
$$;

-- Whether state p_new holds an exception of type p_type raised at step instance p_key.
create function tab.gran_raised(p_new jsonb, p_key text, p_type text) returns boolean
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select exists (
    select 1 from jsonb_each(case when jsonb_typeof(p_new -> 'exceptions') = 'object' then p_new -> 'exceptions' else '{}'::jsonb end) x
     where x.value ->> 'type' = p_type and x.value -> 'source' ->> 'stepKey' = p_key)
$$;

-- The sum of the quantities (member p_member of the data) of the entries in p_list, all in unit p_unit (NULL when a unit
-- differs).
create function tab.gran_sum(p_list jsonb, p_member text, p_unit text) returns numeric
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select case when bool_and(e -> 'data' -> p_member ->> 'unit' = p_unit) is false then null
              else coalesce(sum((e -> 'data' -> p_member ->> 'value')::numeric), 0) end
    from jsonb_array_elements(p_list) e
$$;

-- The block a step instance key p_key of state p_state runs (its MBR node), in MBR content p_content.
create function tab.gran_node(p_content jsonb, p_state jsonb, p_key text) returns jsonb
language sql immutable set search_path = pg_catalog, recipe, pg_temp as $$
  select recipe.step_node(p_content, p_state -> 'steps' -> p_key ->> 'step')
$$;

-- The entries of the whole batch (state p_state) of kind p_kind made at steps of block type p_type.
create function tab.gran_batch_entries(p_content jsonb, p_state jsonb, p_kind text, p_type text) returns jsonb
language sql immutable set search_path = pg_catalog, tab, recipe, pg_temp as $$
  select coalesce(jsonb_agg(x.value order by (x.value ->> 'recordedSeq')::numeric), '[]'::jsonb)
    from jsonb_each(case when jsonb_typeof(p_state -> 'entries') = 'object' then p_state -> 'entries' else '{}'::jsonb end) x
   where x.value ->> 'kind' = p_kind and tab.gran_node(p_content, p_state, x.value ->> 'stepKey') -> 'block' ->> 'type' = p_type
$$;

-- IN-36, INV-24, PR-29, PR-30, DI-29, DI-31: why a new entry of a granulation step in row p_new (after p_old, command
-- p_command, MBR p_content) is not what its block builds or accepts (header, item 1); NULL when every one is.
create function tab.granulation_entry_problem(p_content jsonb, p_old jsonb, p_new jsonb, p_command jsonb) returns text
language plpgsql immutable set search_path = pg_catalog, tab, recipe, pg_temp as $$
declare
  e0        jsonb := case when jsonb_typeof(p_old -> 'entries') = 'object' then p_old -> 'entries' else '{}'::jsonb end;
  e1        jsonb := case when jsonb_typeof(p_new -> 'entries') = 'object' then p_new -> 'entries' else '{}'::jsonb end;
  v_product jsonb := p_content -> 'header' -> 'product' -> 'code';
  k         text;
  e         jsonb;
  d         jsonb;
  c         jsonb;
  v_kind    text;
  v_key     text;
  v_inst    jsonb;
  v_node    jsonb;
  v_type    text;
  v_cfg     jsonb;
  v_by      jsonb;
  v_now     numeric;
  v_seq     numeric;
  v_what    text;
  v_want    jsonb;
  v_verify  boolean;
  v_raise   text;
  v_member  text;
  v_x       jsonb;
  v_y       jsonb;
  v_list    jsonb;
  v_state   text;
  v_n       numeric;
  v_m       numeric;
  v_ok      boolean;
begin
  for k, e in select x.key, x.value from jsonb_each(e1) x where not (e0 ? x.key) order by (x.value ->> 'recordedSeq')::numeric, x.key loop
    v_kind := e ->> 'kind';
    v_key := e ->> 'stepKey';
    v_inst := p_new -> 'steps' -> v_key;
    v_node := recipe.step_node(p_content, v_inst ->> 'step');
    v_type := v_node -> 'block' ->> 'type';
    if v_type is null or v_type not in ('TB-02', 'TB-03', 'TB-04', 'TB-05', 'TB-07')
       or v_kind in ('SETPOINT_READBACK', 'ACTUAL', 'ALARM', 'ALARM_ACK', 'INTERFACE_LOSS', 'RECIPE_CHECK', 'START_DATA') then
      continue;
    end if;
    v_what := format('entry %s (%s) of step %s', k, coalesce(v_kind, 'unnamed'), coalesce(v_key, '(none)'));
    v_cfg := case when jsonb_typeof(v_node -> 'config') = 'object' then v_node -> 'config' else '{}'::jsonb end;
    d := case when jsonb_typeof(e -> 'data') = 'object' then e -> 'data' else '{}'::jsonb end;
    c := case when jsonb_typeof(p_command -> 'entry') = 'object' then p_command -> 'entry' else '{}'::jsonb end;
    v_by := e -> 'enteredBy';
    v_now := recipe.micros_of(e -> 'recordedAt');
    v_seq := (e ->> 'recordedSeq')::numeric;
    v_want := null;
    v_verify := false;
    v_raise := null;
    case v_type || ' ' || v_kind
      -- ------------------------------------------------------------------------------------------- TB-02
      when 'TB-02 SCREEN_CHECK' then
        select s.v into v_x from jsonb_array_elements(case when jsonb_typeof(v_cfg -> 'screens') = 'array' then v_cfg -> 'screens' else '[]'::jsonb end) with ordinality s (v, i)
         where s.v ->> 'id' = c ->> 'screen' order by s.i limit 1;
        if v_x is null then
          return format('stores %s for screen %s, which its step''s MBR does not list (TB02-SCREEN)', v_what, coalesce(c ->> 'screen', '(none)'));
        end if;
        if (c -> 'aperture' ->> 'unit') is distinct from (v_x -> 'aperture' ->> 'unit')
           or (c -> 'aperture' ->> 'value')::numeric is distinct from (v_x -> 'aperture' ->> 'value')::numeric then
          return format('stores %s with aperture %s %s; the MBR approves %s %s for screen %s (TB02-APERTURE)', v_what, c -> 'aperture' ->> 'value', c -> 'aperture' ->> 'unit',
                        v_x -> 'aperture' ->> 'value', v_x -> 'aperture' ->> 'unit', c ->> 'screen');
        end if;
        if exists (select 1 from jsonb_array_elements(tab.gran_batch_entries(p_content, p_old, 'SCREEN_CHECK', 'TB-02')) s
                    where s -> 'data' ->> 'screen' = c ->> 'screen' and s -> 'data' ->> 'result' = 'DAMAGED') then
          return format('stores %s for screen %s, which was found damaged in this batch and is never used again (TB02-SCREEN-DAMAGED)', v_what, c ->> 'screen');
        end if;
        select case when s -> 'data' ->> 'when' = 'BEFORE' then 'IN_USE' else 'IDLE' end into v_state
          from jsonb_array_elements(tab.gran_prior(p_new, v_key, v_seq, 'SCREEN_CHECK')) s where s -> 'data' ->> 'screen' = c ->> 'screen'
         order by (s ->> 'recordedSeq')::numeric desc limit 1;
        v_state := coalesce(v_state, 'IDLE');
        if (c ->> 'when' = 'BEFORE' and v_state = 'IN_USE') or (c ->> 'when' = 'AFTER' and v_state <> 'IN_USE') then
          return format('stores %s, a %s check of screen %s, which is %s (TB02-CHECK-ORDER)', v_what, c ->> 'when', c ->> 'screen',
                        case v_state when 'IN_USE' then 'in use' else 'not checked before use' end);
        end if;
        v_want := jsonb_build_object('screen', c -> 'screen', 'aperture', tab.gran_qty(c -> 'aperture'), 'when', c -> 'when', 'result', c -> 'result', 'checkedBy', v_by);
        if c ->> 'when' = 'AFTER' and c ->> 'result' = 'DAMAGED' then
          select coalesce(max((s ->> 'recordedSeq')::numeric), -1) into v_n
            from jsonb_array_elements(tab.gran_prior(p_new, v_key, v_seq, 'SCREEN_CHECK')) s
           where s -> 'data' ->> 'screen' = c ->> 'screen' and s -> 'data' ->> 'result' = 'INTACT';
          v_want := v_want || jsonb_build_object('held', (select coalesce(jsonb_agg(s -> 'id' order by (s ->> 'recordedSeq')::numeric), '[]'::jsonb)
                                                            from jsonb_array_elements(tab.gran_prior(p_new, v_key, v_seq, 'MATERIAL_PASS')) s
                                                           where s -> 'data' ->> 'screen' = c ->> 'screen' and (s ->> 'recordedSeq')::numeric > v_n));
          v_raise := 'SCREEN_INTEGRITY_FAILED';
        end if;
        v_verify := true;
      when 'TB-02 MATERIAL_PASS' then
        select case when s -> 'data' ->> 'result' = 'DAMAGED' then 'DAMAGED' when s -> 'data' ->> 'when' = 'BEFORE' then 'IN_USE' else 'IDLE' end into v_state
          from jsonb_array_elements(tab.gran_prior(p_new, v_key, v_seq, 'SCREEN_CHECK')) s where s -> 'data' ->> 'screen' = c ->> 'screen'
         order by (s ->> 'recordedSeq')::numeric desc limit 1;
        if v_state is distinct from 'IN_USE' then
          return format('stores %s through screen %s, which has no intact check before this use (TB02-NO-PRE-CHECK)', v_what, coalesce(c ->> 'screen', '(none)'));
        end if;
        if (c -> 'quantityOut' ->> 'unit') is distinct from (c -> 'quantityIn' ->> 'unit')
           or (c -> 'quantityOut' ->> 'value')::numeric > (c -> 'quantityIn' ->> 'value')::numeric
           or (c ? 'oversize' and ((c -> 'oversize' ->> 'unit') is distinct from (c -> 'quantityIn' ->> 'unit')
                                   or (c -> 'oversize' ->> 'value')::numeric > (c -> 'quantityIn' ->> 'value')::numeric)) then
          return format('stores %s whose quantity out or oversize is in another unit or above the quantity in (TB02-QUANTITY)', v_what);
        end if;
        if (v_cfg -> 'oversizeExamination') is distinct from 'false'::jsonb and not (c ? 'oversize') then
          return format('stores %s without the oversize its MBR examines (TB02-OVERSIZE)', v_what);
        end if;
        if ((c -> 'foreignMatter') = 'true'::jsonb) is distinct from (c ? 'foreignMatterDescription') then
          return format('stores %s whose foreign matter and its description do not go together (TB02-FOREIGN-MATTER)', v_what);
        end if;
        v_want := jsonb_build_object('screen', c -> 'screen', 'material', c -> 'material', 'quantityIn', tab.gran_qty(c -> 'quantityIn'),
                                     'quantityOut', tab.gran_qty(c -> 'quantityOut'), 'foreignMatter', c -> 'foreignMatter', 'recordedBy', v_by)
                  || recipe.json_pick(c, array['lot', 'foreignMatterDescription'])
                  || case when c ? 'oversize' then jsonb_build_object('oversize', tab.gran_qty(c -> 'oversize')) else '{}'::jsonb end;
        if (c -> 'foreignMatter') = 'true'::jsonb then
          v_raise := 'FOREIGN_MATTER_FOUND';
        end if;
      -- ------------------------------------------------------------------------------------------- TB-03
      when 'TB-03 PREPARED' then
        if jsonb_array_length(tab.gran_prior(p_new, v_key, v_seq, 'PREPARED')) > 0 then
          return format('stores %s, a second preparation of its step (TB03-TWICE)', v_what);
        end if;
        if recipe.duration_us(v_cfg -> 'useBy') is null then
          return format('stores %s at a step whose MBR gives no use-by (TB03-NO-USE-BY)', v_what);
        end if;
        v_want := jsonb_build_object('quantity', tab.gran_qty(c -> 'quantity'), 'appearance', c -> 'appearance', 'preparedAtUs', v_now::text,
                                     'useByUs', (v_now + recipe.duration_us(v_cfg -> 'useBy'))::text, 'preparedBy', v_by);
        if c ->> 'appearance' = 'DOES_NOT_COMPLY' then
          v_raise := 'SOLUTION_APPEARANCE';
        end if;
      when 'TB-03 DISCARD' then
        v_x := tab.gran_prior(p_new, v_key, v_seq, 'PREPARED') -> 0;
        if v_x is null then
          return format('stores %s before its step''s preparation (TB03-NOT-PREPARED)', v_what);
        end if;
        v_n := tab.gran_sum(tab.gran_prior(p_new, v_key, v_seq, 'DISCARD'), 'quantity', v_x -> 'data' -> 'quantity' ->> 'unit');
        v_m := tab.gran_sum((select coalesce(jsonb_agg(b), '[]'::jsonb) from jsonb_array_elements(tab.gran_batch_entries(p_content, p_new, 'BINDER_ADDITION', 'TB-04')) b
                              where b -> 'data' ->> 'preparation' = v_x ->> 'id'), 'quantity', v_x -> 'data' -> 'quantity' ->> 'unit');
        if (c -> 'quantity' ->> 'unit') is distinct from (v_x -> 'data' -> 'quantity' ->> 'unit') or v_n is null or v_m is null
           or v_n + v_m + (c -> 'quantity' ->> 'value')::numeric > (v_x -> 'data' -> 'quantity' ->> 'value')::numeric then
          return format('stores %s, which with what was discarded and used before comes to more than the %s %s prepared (TB03-DISCARD)', v_what,
                        v_x -> 'data' -> 'quantity' ->> 'value', v_x -> 'data' -> 'quantity' ->> 'unit');
        end if;
        v_want := jsonb_build_object('quantity', tab.gran_qty(c -> 'quantity'), 'method', c -> 'method', 'discardedBy', v_by);
      -- ------------------------------------------------------------------------------------------- TB-04
      when 'TB-04 MASSING_START' then
        if jsonb_array_length(tab.gran_prior(p_new, v_key, v_seq, 'MASSING_START')) > 0 then
          return format('stores %s, a second start of the wet massing (TB04-MASSING-TWICE)', v_what);
        end if;
        v_want := jsonb_build_object('startedBy', v_by);
      when 'TB-04 END_POINT' then
        v_x := v_cfg -> 'endPoint';
        if jsonb_typeof(v_x) is distinct from 'object' then
          return format('stores %s at a step whose MBR names no end point (TB04-NO-ENDPOINT)', v_what);
        end if;
        if jsonb_array_length(tab.gran_prior(p_new, v_key, v_seq, 'END_POINT')) > 0 then
          return format('stores %s, a second end point of its step (TB04-ENDPOINT-TWICE)', v_what);
        end if;
        if v_x ->> 'criterion' = 'TIME' then
          v_y := tab.gran_prior(p_new, v_key, v_seq, 'MASSING_START') -> 0;
          if v_y is null then
            return format('stores %s before the wet massing started (TB04-NO-MASSING-START)', v_what);
          end if;
          if c ? 'actual' then
            return format('stores %s, a time end point naming a collected value (TB04-ENDPOINT-VALUE)', v_what);
          end if;
          v_n := v_now - recipe.micros_of(v_y -> 'recordedAt');
          if recipe.duration_us(v_x -> 'minTime') is not null and v_n < recipe.duration_us(v_x -> 'minTime') then
            return format('stores %s after %s s of massing, below the MBR''s minimum (TB04-ENDPOINT-EARLY)', v_what, tab.gran_seconds(v_n));
          end if;
          v_ok := recipe.duration_us(v_x -> 'maxTime') is null or v_n <= recipe.duration_us(v_x -> 'maxTime');
          v_want := jsonb_build_object('criterion', 'TIME', 'value', tab.gran_seconds(v_n), 'unit', 's', 'withinRange', v_ok, 'recordedBy', v_by)
                    || recipe.json_pick(c, array['reason']);
        else
          select a.v into v_y from jsonb_array_elements(tab.gran_prior(p_new, v_key, v_seq, 'ACTUAL')) a (v)
           where a.v ->> 'id' = c ->> 'actual' and (a.v -> 'data' -> 'usable') = 'true'::jsonb and a.v -> 'data' ->> 'tag' = v_x ->> 'tag';
          if v_y is null then
            return format('stores %s on %s, which is no usable collected value of %s of its step (TB04-ENDPOINT-VALUE)', v_what, coalesce(c ->> 'actual', '(none)'), coalesce(v_x ->> 'tag', '(no tag)'));
          end if;
          if v_y -> 'data' ->> 'source' = 'MANUAL' then
            if jsonb_typeof(c -> 'reason') is distinct from 'string' or (c ->> 'reason') ~ '^\s*$' then
              return format('stores %s, an end point called on a value keyed by hand without a reason (TB04-MANUAL-ENDPOINT)', v_what);
            end if;
            v_verify := true;
          end if;
          v_ok := (jsonb_typeof(v_x -> 'min') is distinct from 'string' or (v_y -> 'data' ->> 'value')::numeric >= (v_x ->> 'min')::numeric)
                  and (jsonb_typeof(v_x -> 'max') is distinct from 'string' or (v_y -> 'data' ->> 'value')::numeric <= (v_x ->> 'max')::numeric);
          v_want := jsonb_build_object('criterion', v_x -> 'criterion', 'actual', v_y -> 'id', 'value', v_y -> 'data' -> 'value', 'unit', v_y -> 'data' -> 'unit',
                                       'withinRange', v_ok, 'recordedBy', v_by)
                    || recipe.json_pick(c, array['reason']);
        end if;
        if not v_ok then
          v_raise := 'ENDPOINT_OUT_OF_RANGE';
        end if;
      when 'TB-04 BINDER_ADDITION' then
        if jsonb_typeof(v_cfg -> 'binder') = 'object' and (c -> 'quantity' ->> 'unit') is distinct from (v_cfg -> 'binder' ->> 'unit') then
          return format('stores %s in %s; the MBR''s binder range is in %s (TB04-BINDER-UNIT)', v_what, c -> 'quantity' ->> 'unit', v_cfg -> 'binder' ->> 'unit');
        end if;
        select p.v into v_x from jsonb_array_elements(tab.gran_batch_entries(p_content, p_new, 'PREPARED', 'TB-03')) p (v) where p.v ->> 'id' = c ->> 'preparation';
        if v_x is null then
          return format('stores %s naming %s, which is no solution prepared at a solution step (TB-03) of this batch (TB04-BINDER-PREPARATION)', v_what, coalesce(c ->> 'preparation', '(none)'));
        end if;
        if v_now > (v_x -> 'data' ->> 'useByUs')::numeric then
          return format('stores %s of solution %s at %s, after its use-by %s (database time; TB04-BINDER-EXPIRED)', v_what, v_x ->> 'id', v_now, v_x -> 'data' ->> 'useByUs');
        end if;
        v_n := tab.gran_sum((select coalesce(jsonb_agg(b), '[]'::jsonb) from jsonb_array_elements(tab.gran_batch_entries(p_content, p_new, 'BINDER_ADDITION', 'TB-04')) b
                              where b -> 'data' ->> 'preparation' = v_x ->> 'id' and b ->> 'id' <> k), 'quantity', v_x -> 'data' -> 'quantity' ->> 'unit');
        v_m := tab.gran_sum((select coalesce(jsonb_agg(b), '[]'::jsonb) from jsonb_array_elements(tab.gran_batch_entries(p_content, p_new, 'DISCARD', 'TB-03')) b
                              where b ->> 'stepKey' = v_x ->> 'stepKey'), 'quantity', v_x -> 'data' -> 'quantity' ->> 'unit');
        if (c -> 'quantity' ->> 'unit') is distinct from (v_x -> 'data' -> 'quantity' ->> 'unit') or v_n is null or v_m is null
           or v_n + v_m + (c -> 'quantity' ->> 'value')::numeric > (v_x -> 'data' -> 'quantity' ->> 'value')::numeric then
          return format('stores %s, which with what was used and discarded before comes to more than the %s %s of solution %s prepared (TB04-BINDER-OVERUSE)', v_what,
                        v_x -> 'data' -> 'quantity' ->> 'value', v_x -> 'data' -> 'quantity' ->> 'unit', v_x ->> 'id');
        end if;
        v_want := jsonb_build_object('preparation', c -> 'preparation', 'quantity', tab.gran_qty(c -> 'quantity'), 'addedBy', v_by);
      when 'TB-04 EXTRA_FLUID' then
        v_x := v_cfg -> 'extraFluid';
        if jsonb_typeof(v_x) is distinct from 'object' or jsonb_typeof(v_x -> 'max') is distinct from 'object' then
          return format('stores %s at a step where the MBR allows no extra granulating fluid (TB04-EXTRA-NOT-ALLOWED)', v_what);
        end if;
        if not exists (select 1 from jsonb_array_elements_text(case when jsonb_typeof(p_command -> 'actor' -> 'roles') = 'array' then p_command -> 'actor' -> 'roles' else '[]'::jsonb end) r
                        where jsonb_typeof(v_x -> 'roles') = 'array' and (v_x -> 'roles') ? r) then
          return format('stores %s by a person in none of the roles the MBR names (TB04-EXTRA-ROLE)', v_what);
        end if;
        if (c -> 'quantity' ->> 'unit') is distinct from (v_x -> 'max' ->> 'unit') then
          return format('stores %s in %s; the MBR''s maximum is in %s (TB04-EXTRA-UNIT)', v_what, c -> 'quantity' ->> 'unit', v_x -> 'max' ->> 'unit');
        end if;
        v_n := tab.gran_sum(tab.gran_prior(p_new, v_key, v_seq, 'EXTRA_FLUID'), 'quantity', v_x -> 'max' ->> 'unit');
        v_ok := coalesce(v_n, 0) + (c -> 'quantity' ->> 'value')::numeric <= (v_x -> 'max' ->> 'value')::numeric;
        v_want := jsonb_build_object('quantity', tab.gran_qty(c -> 'quantity'), 'reason', c -> 'reason', 'withinMaximum', v_ok, 'addedBy', v_by);
        if not v_ok then
          v_raise := 'EXTRA_FLUID_OVER_MAXIMUM';
        end if;
      -- ------------------------------------------------------------------------------------------- TB-05
      when 'TB-05 DRYING_START' then
        if jsonb_array_length(tab.gran_prior(p_new, v_key, v_seq, 'DRYING_START')) > 0 then
          return format('stores %s, a second start of drying (TB05-DRYING-TWICE)', v_what);
        end if;
        if v_cfg ->> 'dryer' = 'FBD' and not exists (select 1 from jsonb_array_elements(tab.gran_prior(p_new, v_key, v_seq, 'BAG_CHECK')) b where b -> 'data' ->> 'when' = 'BEFORE') then
          return format('stores %s before the filter bag was checked (TB05-BAG-UNCHECKED)', v_what);
        end if;
        v_want := jsonb_build_object('startedBy', v_by);
      when 'TB-05 DRYING_END' then
        v_y := tab.gran_prior(p_new, v_key, v_seq, 'DRYING_START') -> 0;
        if v_y is null then
          return format('stores %s before drying started (TB05-NOT-STARTED)', v_what);
        end if;
        if jsonb_array_length(tab.gran_prior(p_new, v_key, v_seq, 'DRYING_END')) > 0 then
          return format('stores %s, a second end of drying (TB05-DRYING-TWICE)', v_what);
        end if;
        v_want := jsonb_build_object('dryingSeconds', tab.gran_seconds(v_now - recipe.micros_of(v_y -> 'recordedAt')), 'endedBy', v_by);
      when 'TB-05 LOD_SAMPLE' then
        if jsonb_array_length(tab.gran_prior(p_new, v_key, v_seq, 'DRYING_END')) = 0 then
          return format('stores %s before drying ended (TB05-SAMPLE-EARLY)', v_what);
        end if;
        if jsonb_array_length(tab.gran_prior(p_new, v_key, v_seq, 'LOD_SAMPLE')) > 0 then
          return format('stores %s, a second LOD sample of the iteration (TB05-SAMPLE-TWICE)', v_what);
        end if;
        v_want := jsonb_build_object('analyser', c -> 'analyser', 'sampleMass', tab.gran_qty(c -> 'sampleMass'), 'sampledBy', v_by);
      when 'TB-05 BAG_CHECK' then
        if v_cfg ->> 'dryer' is distinct from 'FBD' then
          return format('stores %s at a drying step that is no fluid-bed drying (TB05-NO-BAG)', v_what);
        end if;
        v_x := (select b from jsonb_array_elements(tab.gran_prior(p_new, v_key, v_seq, 'BAG_CHECK')) b where b -> 'data' ->> 'when' = 'BEFORE' limit 1);
        v_y := (select b from jsonb_array_elements(tab.gran_prior(p_new, v_key, v_seq, 'BAG_CHECK')) b where b -> 'data' ->> 'when' = 'AFTER' limit 1);
        if c ->> 'when' = 'BEFORE' then
          if v_x is not null then
            return format('stores %s, a second check of the bag before use (TB05-BAG-TWICE)', v_what);
          end if;
          if c ? 'lastProduct' and (c -> 'lastProduct') is distinct from v_product and not (c ? 'washRecord') then
            return format('stores %s for bag %s last used for %s without its wash record (TB05-BAG-WASH)', v_what, c ->> 'bag', c ->> 'lastProduct');
          end if;
          if (v_cfg -> 'dedicatedBags') = 'true'::jsonb and (c -> 'dedicatedTo') is distinct from v_product then
            return format('stores %s for bag %s, which is not dedicated to the product as the MBR asks (TB05-BAG-DEDICATED)', v_what, c ->> 'bag');
          end if;
          if c ->> 'result' = 'DAMAGED' then
            return format('stores %s for a damaged bag (TB05-BAG-DAMAGED)', v_what);
          end if;
          v_want := jsonb_build_object('bag', c -> 'bag', 'when', 'BEFORE', 'result', 'INTACT', 'checkedBy', v_by)
                    || recipe.json_pick(c, array['lastProduct', 'washRecord', 'dedicatedTo']);
        else
          if v_x is null or v_y is not null or (v_x -> 'data' -> 'bag') is distinct from (c -> 'bag')
             or c ? 'lastProduct' or c ? 'washRecord' or c ? 'dedicatedTo' then
            return format('stores %s, which is not the one check after use of the bag checked before use, naming only the bag and the finding (TB05-BAG-ORDER)', v_what);
          end if;
          v_want := jsonb_build_object('bag', c -> 'bag', 'when', 'AFTER', 'result', c -> 'result', 'checkedBy', v_by);
          if c ->> 'result' = 'DAMAGED' then
            v_raise := 'FILTER_BAG_FAILED';
          end if;
        end if;
      -- ------------------------------------------------------------------------------------------- TB-07
      when 'TB-07 BLEND_START' then
        if jsonb_array_length(tab.gran_prior(p_new, v_key, v_seq, 'BLEND_START')) > 0 then
          return format('stores %s, a second start of the blend (TB07-TWICE)', v_what);
        end if;
        v_want := jsonb_build_object('startedBy', v_by);
      when 'TB-07 BLEND_END', 'TB-07 LUBRICATION_END' then
        v_x := v_cfg -> case when v_kind = 'BLEND_END' then 'blendTime' else 'lubrication' end;
        v_y := tab.gran_prior(p_new, v_key, v_seq, case when v_kind = 'BLEND_END' then 'BLEND_START' else 'LUBRICANT_ADDED' end) -> 0;
        if v_y is null then
          return format('stores %s before its start (%s)', v_what, case when v_kind = 'BLEND_END' then 'TB07-NOT-STARTED' else 'TB07-NO-LUBRICANT' end);
        end if;
        if jsonb_array_length(tab.gran_prior(p_new, v_key, v_seq, v_kind)) > 0 then
          return format('stores %s a second time (TB07-TWICE)', v_what);
        end if;
        v_n := v_now - recipe.micros_of(v_y -> 'recordedAt');
        if recipe.duration_us(v_x -> 'min') is not null and v_n < recipe.duration_us(v_x -> 'min') then
          return format('stores %s after %s s, below the MBR''s minimum (%s)', v_what, tab.gran_seconds(v_n),
                        case when v_kind = 'BLEND_END' then 'TB07-BLEND-SHORT' else 'TB07-LUBRICATION-SHORT' end);
        end if;
        v_ok := recipe.duration_us(v_x -> 'max') is null or v_n <= recipe.duration_us(v_x -> 'max');
        v_want := jsonb_build_object('seconds', tab.gran_seconds(v_n), 'withinLimits', v_ok, 'recordedBy', v_by);
        if not v_ok then
          v_raise := case when v_kind = 'BLEND_END' then 'BLEND_TIME_EXCEEDED' else 'LUBRICATION_TIME_EXCEEDED' end;
        end if;
      when 'TB-07 LUBRICANT_ADDED' then
        if jsonb_typeof(v_cfg -> 'lubrication') is distinct from 'object' then
          return format('stores %s at a step whose MBR has no lubrication (TB07-NO-LUBRICATION)', v_what);
        end if;
        if jsonb_array_length(tab.gran_prior(p_new, v_key, v_seq, 'BLEND_END')) = 0 then
          return format('stores %s before the main blend time ended (TB07-LUBRICANT-EARLY)', v_what);
        end if;
        if jsonb_array_length(tab.gran_prior(p_new, v_key, v_seq, 'LUBRICANT_ADDED')) > 0 then
          return format('stores %s a second time (TB07-TWICE)', v_what);
        end if;
        v_want := jsonb_build_object('quantity', tab.gran_qty(c -> 'quantity'), 'addedBy', v_by) || recipe.json_pick(c, array['lot']);
      when 'TB-07 BU_SAMPLE' then
        v_x := v_cfg -> 'bu';
        if jsonb_typeof(v_x) is distinct from 'object' or jsonb_typeof(v_x -> 'unitDose') is distinct from 'object' then
          return format('stores %s at a step whose MBR has no blend-uniformity plan (TB07-NO-BU-PLAN)', v_what);
        end if;
        if jsonb_array_length(tab.gran_prior(p_new, v_key, v_seq, case when jsonb_typeof(v_cfg -> 'lubrication') = 'object' then 'LUBRICATION_END' else 'BLEND_END' end)) = 0 then
          return format('stores %s before blending finished (TB07-BU-EARLY)', v_what);
        end if;
        if not (jsonb_typeof(v_x -> 'locations') = 'array' and (v_x -> 'locations') @> jsonb_build_array(c -> 'location'))
           or jsonb_typeof(c -> 'replicate') is distinct from 'number'
           or (c ->> 'replicate')::numeric > (case when jsonb_typeof(v_x -> 'replicates') = 'number' then (v_x ->> 'replicates')::numeric else 1 end) then
          return format('stores %s at location %s, replicate %s, which is not in its step''s sampling plan (TB07-NOT-PLANNED)', v_what, coalesce(c ->> 'location', '(none)'), coalesce(c ->> 'replicate', '(none)'));
        end if;
        if exists (select 1 from jsonb_array_elements(tab.gran_prior(p_new, v_key, v_seq, 'BU_SAMPLE')) s
                    where s -> 'data' -> 'location' = c -> 'location' and s -> 'data' -> 'replicate' = c -> 'replicate') then
          return format('stores %s, a second sample of location %s, replicate %s (TB07-SAMPLE-TWICE)', v_what, c ->> 'location', c ->> 'replicate');
        end if;
        if (c -> 'mass' ->> 'unit') is distinct from (v_x -> 'unitDose' ->> 'unit') then
          return format('stores %s in %s; the unit dose is in %s (TB07-SAMPLE-UNIT)', v_what, c -> 'mass' ->> 'unit', v_x -> 'unitDose' ->> 'unit');
        end if;
        v_ok := (c -> 'mass' ->> 'value')::numeric >= (v_x -> 'unitDose' ->> 'value')::numeric
                and (c -> 'mass' ->> 'value')::numeric <= 3 * (v_x -> 'unitDose' ->> 'value')::numeric;
        if not v_ok and (jsonb_typeof(c -> 'justification') is distinct from 'string' or (c ->> 'justification') ~ '^\s*$') then
          return format('stores %s of %s %s, outside 1 to 3 unit doses, without a justification (TB07-SAMPLE-SIZE)', v_what, c -> 'mass' ->> 'value', c -> 'mass' ->> 'unit');
        end if;
        v_want := jsonb_build_object('location', c -> 'location', 'replicate', c -> 'replicate', 'mass', tab.gran_qty(c -> 'mass'), 'withinDoseRange', v_ok, 'sampledBy', v_by)
                  || recipe.json_pick(c, array['justification']);
      else
        -- recipe-core 0332 refuses a kind the step's block does not record.
        null;
    end case;
    if v_want is not null and d is distinct from v_want then
      select m into v_member
        from (select jsonb_object_keys(d) m union select jsonb_object_keys(v_want)) u
       where (d -> m) is distinct from (v_want -> m)
       order by m limit 1;
      return format('stores %s with %s %s, where its block writes %s', v_what, v_member,
                    coalesce((d -> v_member)::text, '(no such member)'), coalesce((v_want -> v_member)::text, '(no such member)'));
    end if;
    if v_verify and (v_inst -> 'verificationRequired') is distinct from 'true'::jsonb then
      return format('stores %s, which needs a second person''s check of its step, and the step does not require it (PR-14)', v_what);
    end if;
    if v_raise is not null and not tab.gran_held(p_old, p_new, v_key, v_raise) then
      return format('stores %s without the %s exception its block raises with it, holding the steps after it until a deviation is linked', v_what, v_raise);
    end if;
  end loop;
  return null;
end
$$;

-- INV-25, PR-08, IN-36: why a new value in row p_new of an item a granulation block computes is not the block's own
-- (header, item 2); NULL when every one is.
create function tab.granulation_computed_problem(p_content jsonb, p_old jsonb, p_new jsonb) returns text
language plpgsql immutable set search_path = pg_catalog, tab, recipe, pg_temp as $$
declare
  k       text;
  p       jsonb;
  v_node  jsonb;
  v_type  text;
  v_cfg   jsonb;
  v_kind  text;
  v_entry jsonb;
  v_want  jsonb;
begin
  for k, p in select x.key, x.value from jsonb_each(case when jsonb_typeof(p_new -> 'points') = 'object' then p_new -> 'points' else '{}'::jsonb end) x
               where not coalesce((p_old -> 'points') ? x.key, false) order by x.key loop
    v_node := tab.gran_node(p_content, p_new, p ->> 'stepKey');
    v_type := v_node -> 'block' ->> 'type';
    v_cfg := case when jsonb_typeof(v_node -> 'config') = 'object' then v_node -> 'config' else '{}'::jsonb end;
    v_kind := case
      when v_type = 'TB-04' and v_cfg -> 'endPoint' ->> 'item' = p ->> 'item' then 'END_POINT'
      when v_type = 'TB-07' and v_cfg -> 'blendTime' ->> 'item' = p ->> 'item' then 'BLEND_END'
      when v_type = 'TB-07' and v_cfg -> 'lubrication' ->> 'item' = p ->> 'item' then 'LUBRICATION_END'
    end;
    if v_kind is null then
      continue;
    end if;
    v_entry := tab.gran_prior(p_new, p ->> 'stepKey', 'Infinity'::numeric, v_kind) -> 0;
    v_want := case when v_entry is null then null
                   else jsonb_build_object('kind', 'DECIMAL', 'value', v_entry -> 'data' -> case when v_kind = 'END_POINT' then 'value' else 'seconds' end,
                                           'unit', case when v_kind = 'END_POINT' then v_entry -> 'data' -> 'unit' else '"s"'::jsonb end) end;
    if p ->> 'kind' is distinct from 'VALUE' or (p -> 'source') is distinct from jsonb_build_object('mode', 'BLOCK', 'entries', jsonb_build_array(v_entry -> 'id'))
       or v_want is null or (p -> 'value') is distinct from v_want then
      return format('stores value %s of %s at step %s that is not the one its block computes from its %s entry (%s; %s)', k, p ->> 'item', p ->> 'stepKey', v_kind,
                    coalesce(v_want::text, 'none yet'), case when v_type = 'TB-04' then 'TB04-ENDPOINT-COMPUTED' else 'TB07-TIME-COMPUTED' end);
    end if;
  end loop;
  return null;
end
$$;

-- IN-36, INV-24, PR-29: why a granulation step that row p_new closes (IN_PROGRESS to AWAITING_VERIFICATION or
-- COMPLETED) is not complete (header, item 3); NULL when every one is.
create function tab.granulation_close_problem(p_content jsonb, p_old jsonb, p_new jsonb) returns text
language plpgsql immutable set search_path = pg_catalog, tab, recipe, pg_temp as $$
declare
  k       text;
  s       jsonb;
  v_node  jsonb;
  v_type  text;
  v_cfg   jsonb;
  v_all   jsonb;
  v_text  text;
  v_n     numeric;
begin
  for k, s in select x.key, x.value from jsonb_each(case when jsonb_typeof(p_new -> 'steps') = 'object' then p_new -> 'steps' else '{}'::jsonb end) x
               where x.value ->> 'status' in ('AWAITING_VERIFICATION', 'COMPLETED') and p_old -> 'steps' -> x.key ->> 'status' = 'IN_PROGRESS' order by x.key loop
    v_node := recipe.step_node(p_content, s ->> 'step');
    v_type := v_node -> 'block' ->> 'type';
    if v_type is null or v_type not in ('TB-02', 'TB-03', 'TB-04', 'TB-05', 'TB-07') then
      continue;
    end if;
    v_cfg := case when jsonb_typeof(v_node -> 'config') = 'object' then v_node -> 'config' else '{}'::jsonb end;
    v_all := tab.gran_prior(p_new, k, 'Infinity'::numeric, null);
    v_text := null;
    case v_type
      when 'TB-02' then
        select string_agg(x.screen, ', ' order by x.screen) into v_text
          from (select distinct on (e -> 'data' ->> 'screen') e -> 'data' ->> 'screen' as screen, e -> 'data' ->> 'when' as w, e -> 'data' ->> 'result' as r
                  from jsonb_array_elements(v_all) e where e ->> 'kind' = 'SCREEN_CHECK'
                 order by e -> 'data' ->> 'screen', (e ->> 'recordedSeq')::numeric desc) x
         where x.w = 'BEFORE' and x.r = 'INTACT';
        v_text := case when v_text is not null then format('screen %s has no check after use (TB02-AFTER-CHECK-MISSING)', v_text)
                       when not exists (select 1 from jsonb_array_elements(v_all) e where e ->> 'kind' = 'MATERIAL_PASS') then 'nothing was processed (TB02-NOTHING-PROCESSED)' end;
      when 'TB-03' then
        if not exists (select 1 from jsonb_array_elements(v_all) e where e ->> 'kind' = 'PREPARED') then
          v_text := 'the solution was not prepared (TB03-NOT-PREPARED)';
        end if;
      when 'TB-04' then
        if jsonb_typeof(v_cfg -> 'endPoint') = 'object' and not exists (select 1 from jsonb_array_elements(v_all) e where e ->> 'kind' = 'END_POINT') then
          v_text := 'it has no end point (TB04-NO-ENDPOINT)';
        elsif jsonb_typeof(v_cfg -> 'extraFluid') = 'object' and not exists (select 1 from jsonb_array_elements(v_all) e where e ->> 'kind' = 'EXTRA_FLUID') then
          v_text := 'the extra-fluid branch records no extra fluid (TB04-NO-EXTRA)';
        elsif jsonb_typeof(v_cfg -> 'binder') = 'object' then
          v_n := tab.gran_sum((select coalesce(jsonb_agg(e), '[]'::jsonb) from jsonb_array_elements(v_all) e where e ->> 'kind' = 'BINDER_ADDITION'), 'quantity', v_cfg -> 'binder' ->> 'unit');
          if (v_n is null or v_n < (v_cfg -> 'binder' ->> 'min')::numeric or v_n > (v_cfg -> 'binder' ->> 'max')::numeric)
             and not tab.gran_raised(p_new, k, 'BINDER_QUANTITY_OUT_OF_RANGE') then
            v_text := format('its binder total %s is outside the MBR''s range and BINDER_QUANTITY_OUT_OF_RANGE was not raised', coalesce(v_n::text, '(mixed units)'));
          end if;
        end if;
      when 'TB-05' then
        v_text := case
          when not exists (select 1 from jsonb_array_elements(v_all) e where e ->> 'kind' = 'DRYING_END') then 'drying has not ended (TB05-NOT-DRIED)'
          when not exists (select 1 from jsonb_array_elements(v_all) e where e ->> 'kind' = 'LOD_SAMPLE') then 'it has no LOD sample (TB05-NO-SAMPLE)'
          when v_cfg ->> 'dryer' = 'FBD' and not exists (select 1 from jsonb_array_elements(v_all) e where e ->> 'kind' = 'BAG_CHECK' and e -> 'data' ->> 'when' = 'AFTER')
            then 'its filter bag has no check after use (TB05-BAG-AFTER-MISSING)'
        end;
      when 'TB-07' then
        if not exists (select 1 from jsonb_array_elements(v_all) e where e ->> 'kind' = 'BLEND_END') then
          v_text := 'the main blend has not ended (TB07-NOT-BLENDED)';
        elsif jsonb_typeof(v_cfg -> 'lubrication') = 'object' and not exists (select 1 from jsonb_array_elements(v_all) e where e ->> 'kind' = 'LUBRICATION_END') then
          v_text := 'the lubrication has not ended (TB07-NOT-LUBRICATED)';
        elsif jsonb_typeof(v_cfg -> 'bu') = 'object'
              and exists (select 1 from jsonb_array_elements_text(case when jsonb_typeof(v_cfg -> 'bu' -> 'locations') = 'array' then v_cfg -> 'bu' -> 'locations' else '[]'::jsonb end) l,
                                        generate_series(1, case when jsonb_typeof(v_cfg -> 'bu' -> 'replicates') = 'number' then (v_cfg -> 'bu' ->> 'replicates')::integer else 1 end) r
                           where not exists (select 1 from jsonb_array_elements(v_all) e
                                              where e ->> 'kind' = 'BU_SAMPLE' and e -> 'data' ->> 'location' = l and (e -> 'data' ->> 'replicate')::integer = r))
              and not tab.gran_raised(p_new, k, 'BU_LOCATION_MISSING') then
          v_text := 'planned blend-uniformity samples are missing and BU_LOCATION_MISSING was not raised';
        end if;
    end case;
    if v_text is not null then
      return format('closes step %s, but %s', k, v_text);
    end if;
  end loop;
  return null;
end
$$;

-- DI-34, IN-36: why a TB-05 step instance of row p_new runs beyond the maximum iterations of a loop it sits in (or 10,
-- the block's bound; header, item 4); NULL when none does.
create function tab.granulation_loop_problem(p_content jsonb, p_new jsonb) returns text
language plpgsql immutable set search_path = pg_catalog, tab, recipe, pg_temp as $$
declare
  k      text;
  s      jsonb;
  f      jsonb;
  v_loop jsonb;
begin
  for k, s in select x.key, x.value from jsonb_each(case when jsonb_typeof(p_new -> 'steps') = 'object' then p_new -> 'steps' else '{}'::jsonb end) x order by x.key loop
    if recipe.step_node(p_content, s ->> 'step') -> 'block' ->> 'type' is distinct from 'TB-05' then
      continue;
    end if;
    for f in select x from jsonb_array_elements(case when jsonb_typeof(s -> 'frames') = 'array' then s -> 'frames' else '[]'::jsonb end) x loop
      select l into v_loop from jsonb_path_query(coalesce(p_content -> 'procedure', '{}'::jsonb), 'strict $.** ? (@.kind == "loop" && @.id == $id)',
                                                 jsonb_build_object('id', f -> 'construct')) l limit 1;
      if v_loop is not null and ((f ->> 'index')::numeric > (v_loop ->> 'maxIterations')::numeric or (f ->> 'index')::numeric > 10) then
        return format('runs drying step %s in iteration %s of loop %s, beyond its maximum of %s iterations (TB05-LOOP-BOUND)', k, f ->> 'index', f ->> 'construct',
                      least((v_loop ->> 'maxIterations')::numeric, 10));
      end if;
      v_loop := null;
    end loop;
  end loop;
  return null;
end
$$;

-- The row trigger (header).
create function tab.granulation_state_check() returns trigger
language plpgsql security definer set search_path = pg_catalog, tab, recipe, pg_temp as $$
declare
  r         recipe.execution_command;
  v_content jsonb;
  v_problem text;
  v_code    text;
begin
  v_content := recipe.batch_mbr_content(new.batch_id);
  if not exists (select 1 from jsonb_path_query(coalesce(v_content -> 'procedure', '{}'::jsonb), 'strict $.** ? (@.kind == "phase")') p
                  where p -> 'block' ->> 'type' in ('TB-02', 'TB-03', 'TB-04', 'TB-05', 'TB-07')) then
    return null;
  end if;
  select * into r from recipe.execution_command c where c.batch_id = new.batch_id and c.seq = new.last_seq;
  v_problem := tab.granulation_entry_problem(v_content, old.state, new.state, r.command);
  v_code := 'EBMR-EXE-250';
  if v_problem is null then
    v_problem := tab.granulation_computed_problem(v_content, old.state, new.state);
    v_code := 'EBMR-EXE-251';
  end if;
  if v_problem is null then
    v_problem := tab.granulation_close_problem(v_content, old.state, new.state);
    v_code := 'EBMR-EXE-252';
  end if;
  if v_problem is null then
    v_problem := tab.granulation_loop_problem(v_content, new.state);
    v_code := 'EBMR-EXE-253';
  end if;
  if v_problem is not null then
    raise exception using errcode = 'P0001',
      message = format('This %s %s row %s: a granulation step records what its block builds, closes only complete, and its loop stays bounded (IN-36, INV-24, INV-25, PR-29, PR-30, DI-34). [%s]',
                       case when r.kind = 'COMMAND' and r.accepted then 'accepted' when r.kind = 'COMMAND' then 'refused' else lower(coalesce(r.kind, 'unknown')) end,
                       coalesce(r.command_type, r.kind, 'unknown'), v_problem, v_code);
  end if;
  return null;
end
$$;

create trigger zt_tab_granulation after update on recipe.execution_state
  for each row execute function tab.granulation_state_check();

revoke all on function tab.gran_seconds(numeric), tab.gran_qty(jsonb), tab.gran_prior(jsonb, text, numeric, text), tab.gran_held(jsonb, jsonb, text, text),
  tab.gran_raised(jsonb, text, text), tab.gran_sum(jsonb, text, text), tab.gran_node(jsonb, jsonb, text), tab.gran_batch_entries(jsonb, jsonb, text, text),
  tab.granulation_entry_problem(jsonb, jsonb, jsonb, jsonb), tab.granulation_computed_problem(jsonb, jsonb, jsonb),
  tab.granulation_close_problem(jsonb, jsonb, jsonb), tab.granulation_loop_problem(jsonb, jsonb), tab.granulation_state_check() from public;

reset role;
