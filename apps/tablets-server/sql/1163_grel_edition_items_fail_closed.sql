-- Tablets server, Phase 4 slice 3 quick review of the Tablets G-REL items (tablets 1162): what failed open now fails
-- closed (controls IN-37, IN-17, IN-34, INV-05, DI-37; recipe-core 0781 release_review_time).
--
--   1. since_review. Every Tablets item was false, so a change after QA reviewed the lot's packaging record never reached
--      the signer's "since review" list. tab.grel_changed_since(review time, batches, evidence) is true when, after QA's
--      latest review of the packaging record (recipe.release_review_time, 3a), any fact the item rests on moved: the
--      BATCH epoch, the stored execution state, an exception or its act of the packaging order or the processing batch
--      (and of any batch the item's evidence names); the epoch, state or hold of a container in its evidence; the epoch
--      or state of a lot in its evidence; the epoch of a deviation in its evidence; a verification, its signature or a
--      signature invalidation of a rule set in its evidence. With no QA review yet every item is false (nothing to
--      acknowledge against). tab.grel_edition_items (CREATE OR REPLACE from 1162) sets it on every item, each with the
--      batches whose records it reads (a container item only its containers; a whole-batch item its parents).
--   2. E.PRINTED_TABLETS_QC read the stored signatures[].valid flag of the hold point. It now asks the kernel: a HOLD_POINT
--      signature whose id names a signature that esig.signature_state reports valid now.
--   3. NA only when the item truly does not apply; what cannot be determined is RED:
--      * E.RULE_SETS_VERIFIED: an entry whose ruleSets is not an array of {code, version} with a positive whole version is
--        RED ("cannot determine"), never dropped;
--      * E.PRINTED_TABLETS_QC: TB-19 is found in the procedure and in the library elements its calls pin
--        (content.library); a library call whose element is not pinned is RED ("cannot determine"); the QC hold point of
--        a printing step inlined from a library call is found in that element's sequence (the step id <call>/<inner>);
--      * E.RECONCILIATION_PRINTED: when the packaging master prints (G-21 in its procedure or pinned library) but the
--        record holds no G-21 step instance, RED; an unpinned library call is RED too.
--
-- CREATE OR REPLACE keeps owners and grants. New functions are owned by ebmr_owner, SECURITY DEFINER where they read
-- private tables, and pin their search_path with pg_temp last (ADR 0016). Applied as a new migration because applied
-- migrations are checksummed and never edited.

set local role ebmr_owner;

-- The block types MBR content p_content runs (procedure and pinned library elements), and whether a library call names an
-- element that is not pinned: {types: [...], unresolved: boolean}.
create function tab.grel_master_blocks(p_content jsonb) returns jsonb
language sql immutable set search_path = pg_catalog, pg_temp as $$
  with lib as (select case when jsonb_typeof(p_content -> 'library') = 'array' then p_content -> 'library' else '[]'::jsonb end as l),
       scopes as (select coalesce(p_content -> 'procedure', '{}'::jsonb) as s
                  union all select e -> 'body' from lib, jsonb_array_elements(lib.l) e)
  select jsonb_build_object(
    'types', coalesce((select jsonb_agg(distinct t #>> '{}') from scopes, jsonb_path_query(scopes.s, 'strict $.** ? (@.kind == "phase").block.type') t), '[]'::jsonb),
    'unresolved', p_content is null or exists (
      select 1 from scopes, jsonb_path_query(scopes.s, 'strict $.** ? (@.kind == "libraryCall")') c, lib
       where (select count(*) from jsonb_array_elements(lib.l) e where e ->> 'ref' = c ->> 'element') <> 1))
$$;

-- The id of the step a hold point after step p_step must have (the next node of its sequence, a holdPoint), with the
-- step's library-call prefix; NULL when there is none or it cannot be resolved.
create function tab.grel_next_hold(p_content jsonb, p_step text) returns text
language plpgsql immutable set search_path = pg_catalog, pg_temp as $$
declare
  v_parts  text[] := string_to_array(p_step, '/');
  v_scope  jsonb := p_content -> 'procedure';
  v_els    jsonb := case when jsonb_typeof(p_content -> 'library') = 'array' then p_content -> 'library' else '[]'::jsonb end;
  v_call   jsonb;
  v_n      bigint;
  v_next   jsonb;
  v_prefix text := '';
begin
  if coalesce(array_length(v_parts, 1), 0) = 0 or jsonb_typeof(v_scope) is distinct from 'object' then
    return null;
  end if;
  for i in 1 .. array_length(v_parts, 1) - 1 loop
    select count(*), (array_agg(n))[1] into v_n, v_call
      from jsonb_path_query(v_scope, 'strict $.** ? (@.id == $id && @.kind == "libraryCall")', jsonb_build_object('id', v_parts[i])) n;
    if v_n is distinct from 1 then
      return null;
    end if;
    select count(*), (array_agg(e -> 'body'))[1] into v_n, v_scope from jsonb_array_elements(v_els) e where e ->> 'ref' = v_call ->> 'element';
    if v_n is distinct from 1 or jsonb_typeof(v_scope) is distinct from 'object' then
      return null;
    end if;
    v_prefix := v_prefix || v_parts[i] || '/';
  end loop;
  select count(*), (array_agg(q.v -> 'children' -> (ch.i::integer)))[1] into v_n, v_next
    from jsonb_path_query(v_scope, 'strict $.** ? (@.kind == "sequence")') q (v),
         jsonb_array_elements(q.v -> 'children') with ordinality ch (x, i)
   where ch.x ->> 'id' = v_parts[array_length(v_parts, 1)];
  if v_n is distinct from 1 or v_next ->> 'kind' is distinct from 'holdPoint' then
    return null;
  end if;
  return v_prefix || (v_next ->> 'id');
end
$$;

-- Item 1 (header): whether a fact item p_item rests on moved after p_rev.
create function tab.grel_changed_since(p_rev timestamptz, p_batches uuid[], p_evidence jsonb) returns boolean
language plpgsql stable security definer set search_path = pg_catalog, tab, recipe, plant, platform, site, esig, pg_temp as $$
declare
  v_ev  jsonb := case when jsonb_typeof(p_evidence) = 'array' then p_evidence else '[]'::jsonb end;
  v_b   uuid[];
  v_ref text[];
begin
  if p_rev is null then
    return false;
  end if;
  v_b := array(select distinct x from (select unnest(p_batches) x
                                       union all select (e ->> 'ref')::uuid from jsonb_array_elements(v_ev) e
                                                  where e ->> 'kind' = 'BATCH' and e ->> 'ref' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') y where x is not null);
  if exists (select 1 from recipe.evidence_epoch e where e.subject_kind = 'BATCH' and e.subject_id = any (v_b) and e.bumped_at > p_rev)
     or exists (select 1 from recipe.execution_state s where s.batch_id = any (v_b) and s.updated_at > p_rev)
     or exists (select 1 from recipe.exception_register r where r.batch_id = any (v_b) and r.recorded_at > p_rev)
     or exists (select 1 from recipe.exception_register_act a where a.batch_id = any (v_b) and a.recorded_at > p_rev) then
    return true;
  end if;
  for v_ref in select array[e ->> 'kind', e ->> 'ref'] from jsonb_array_elements(v_ev) e loop
    if v_ref[1] in ('CONTAINER', 'LOT', 'DEVIATION') and v_ref[2] !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      return true;
    end if;
    if (v_ref[1] = 'CONTAINER' and (exists (select 1 from recipe.evidence_epoch e where e.subject_kind = 'CONTAINER' and e.subject_id = v_ref[2]::uuid and e.bumped_at > p_rev)
                                    or exists (select 1 from platform.aggregate_state s where s.aggregate_type = 'output_container' and s.aggregate_id = v_ref[2]::uuid and s.updated_at > p_rev)
                                    or exists (select 1 from plant.container_hold h where h.container_id = v_ref[2]::uuid and h.recorded_at > p_rev)
                                    or exists (select 1 from plant.container_charge g where g.container_id = v_ref[2]::uuid and g.recorded_at > p_rev)
                                    or exists (select 1 from recipe.packaging_bulk_issue i where i.container_id = v_ref[2]::uuid and i.recorded_at > p_rev)))
       or (v_ref[1] = 'LOT' and (exists (select 1 from recipe.evidence_epoch e where e.subject_kind = 'LOT' and e.subject_id = v_ref[2]::uuid and e.bumped_at > p_rev)
                                 or exists (select 1 from platform.aggregate_state s where s.aggregate_type = 'material_lot' and s.aggregate_id = v_ref[2]::uuid and s.updated_at > p_rev)))
       or (v_ref[1] = 'DEVIATION' and exists (select 1 from recipe.evidence_epoch e where e.subject_kind = 'DEVIATION' and e.subject_id = v_ref[2]::uuid and e.bumped_at > p_rev))
       or (v_ref[1] = 'RULE_SET' and (exists (select 1 from tab.rule_set_verification v where v.code || ':' || v.version = v_ref[2] and v.recorded_at > p_rev)
                                      or exists (select 1 from tab.rule_set_verification v join tab.rule_set_verification_signature s on s.verification_id = v.id
                                                  where v.code || ':' || v.version = v_ref[2] and s.signed_at > p_rev)
                                      or exists (select 1 from tab.rule_set_verification v join tab.rule_set_verification_signature s on s.verification_id = v.id
                                                   join esig.signature_invalidation i on i.signature_id = s.signature_id
                                                  where v.code || ':' || v.version = v_ref[2] and i.recorded_at > p_rev))) then
      return true;
    end if;
  end loop;
  return false;
end
$$;

-- E.PRINTED_TABLETS_QC (CREATE OR REPLACE from 1162; header items 2 and 3).
create or replace function tab.grel_printed_tablets(p_parent uuid) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, tab, recipe, esig, pg_temp as $$
declare
  v_title   text := 'Printed tablets approved by QC (IN-37)';
  v_content jsonb := recipe.batch_mbr_content(p_parent);
  v_blocks  jsonb;
  v_state   jsonb;
  v_probs   jsonb := '[]'::jsonb;
  v_ran     integer := 0;
  k         text;
  s         jsonb;
  v_hold    text;
begin
  if p_parent is null or v_content is null then
    return tab.grel_item_of('E.PRINTED_TABLETS_QC', '10', v_title, jsonb_build_array(tab.grel_problem('the packaging order packs no processing batch of this installation')), null);
  end if;
  v_blocks := tab.grel_master_blocks(v_content);
  if (v_blocks -> 'unresolved') = 'true'::jsonb then
    return tab.grel_item_of('E.PRINTED_TABLETS_QC', '10', v_title, jsonb_build_array(tab.grel_problem(
      'cannot determine whether the processing batch prints its tablets: its master calls a library element it does not pin', tab.grel_batch_ev(p_parent))), null);
  end if;
  if not ((v_blocks -> 'types') ? 'TB-19') then
    return tab.grel_item_of('E.PRINTED_TABLETS_QC', '10', v_title, null, tab.grel_batch_ev(p_parent), true);
  end if;
  select st.state into v_state from recipe.execution_state st where st.batch_id = p_parent;
  for k, s in select g.step_key, g.step from tab.grel_steps(p_parent, 'TB-19') g loop
    continue when s ->> 'status' = 'NOT_APPLICABLE';
    v_ran := v_ran + 1;
    v_hold := tab.grel_next_hold(v_content, s ->> 'step');
    if v_hold is null then
      v_probs := v_probs || jsonb_build_array(tab.grel_problem(
        format('cannot determine the QC hold point after the printing step %s (IN-37)', k), tab.grel_batch_ev(p_parent)));
      continue;
    end if;
    if not exists (select 1 from jsonb_each(v_state -> 'steps') h
                    where h.value ->> 'step' = v_hold and h.value ->> 'status' = 'COMPLETED'
                      and (h.value -> 'disposition' -> 'positive') = 'true'::jsonb and (h.value -> 'frames') is not distinct from (s -> 'frames')
                      and exists (select 1 from jsonb_array_elements(case when jsonb_typeof(h.value -> 'signatures') = 'array' then h.value -> 'signatures' else '[]'::jsonb end) g
                                   where g ->> 'role' = 'HOLD_POINT'
                                     and g ->> 'id' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                                     and coalesce((esig.signature_state((g ->> 'id')::uuid) ->> 'valid')::boolean, false))) then
      v_probs := v_probs || jsonb_build_array(tab.grel_problem(
        format('the tablets printed at %s wait for the QC approval at hold point %s under a valid signature (IN-37)', k, v_hold), tab.grel_batch_ev(p_parent)));
    end if;
  end loop;
  if v_ran = 0 then
    v_probs := jsonb_build_array(tab.grel_problem('the processing batch''s master prints the tablets, but its record holds no printing step', tab.grel_batch_ev(p_parent)));
  end if;
  return tab.grel_item_of('E.PRINTED_TABLETS_QC', '10', v_title, v_probs, tab.grel_batch_ev(p_parent));
end
$$;

-- E.RULE_SETS_VERIFIED (CREATE OR REPLACE from 1162; header item 3).
create or replace function tab.grel_rule_sets(p_batches uuid[]) returns jsonb
language sql stable security definer set search_path = pg_catalog, tab, recipe, pg_temp as $$
  with ent as (
    select st.batch_id, e.key, e.value -> 'data' -> 'ruleSets' as rs
      from recipe.execution_state st,
           jsonb_each(case when jsonb_typeof(st.state -> 'entries') = 'object' then st.state -> 'entries' else '{}'::jsonb end) e
     where st.batch_id = any (p_batches) and e.value -> 'data' ? 'ruleSets'
  ),
  bad as (
    select ent.batch_id, ent.key from ent
     where jsonb_typeof(ent.rs) is distinct from 'array'
        or exists (select 1 from jsonb_array_elements(ent.rs) r
                    where jsonb_typeof(r) is distinct from 'object' or jsonb_typeof(r -> 'code') is distinct from 'string'
                       or coalesce(r ->> 'version', '') !~ '^[1-9][0-9]{0,8}$')
  ),
  cited as (
    select distinct r ->> 'code' as code, (r ->> 'version')::integer as version
      from ent, jsonb_array_elements(ent.rs) r
     where jsonb_typeof(ent.rs) = 'array' and jsonb_typeof(r) = 'object' and jsonb_typeof(r -> 'code') = 'string' and coalesce(r ->> 'version', '') ~ '^[1-9][0-9]{0,8}$'
  )
  select tab.grel_item_of('E.RULE_SETS_VERIFIED', '10', 'Compendial rule sets verified by QA (tablets spec E.1)',
    coalesce((select jsonb_agg(tab.grel_problem(format('cannot determine the rule sets entry %s of batch %s cites: its rule-set reference is malformed', b.key, b.batch_id),
                                                tab.grel_batch_ev(b.batch_id)) order by b.batch_id, b.key) from bad b), '[]'::jsonb)
    || coalesce((select jsonb_agg(tab.grel_problem(tab.rule_set_verification_problem(c.code, c.version),
                                                   jsonb_build_array(jsonb_build_object('kind', 'RULE_SET', 'ref', c.code || ':' || c.version, 'label', format('%s version %s', c.code, c.version))))
                                  order by c.code, c.version)
                   from cited c where tab.rule_set_verification_problem(c.code, c.version) is not null), '[]'::jsonb),
    coalesce((select jsonb_agg(jsonb_build_object('kind', 'RULE_SET', 'ref', c.code || ':' || c.version, 'label', format('%s version %s', c.code, c.version)) order by c.code, c.version) from cited c), '[]'::jsonb),
    not exists (select 1 from ent))
$$;

-- E.RECONCILIATION_PRINTED (CREATE OR REPLACE from 1162; header item 3).
create or replace function tab.grel_recon_printed(p_order uuid, p_parent uuid) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, tab, recipe, pg_temp as $$
declare
  v_title  text := 'Printed materials reconciled (G-21, IN-17)';
  v_blocks jsonb := tab.grel_master_blocks(recipe.batch_mbr_content(p_order));
  v_probs  jsonb := '[]'::jsonb;
  v_unres  jsonb := tab.grel_unresolved(array_remove(array[p_order, p_parent], null), array['PRINTED_RECONCILIATION']);
  v_any    boolean := false;
  k        text;
  s        jsonb;
begin
  if (v_blocks -> 'unresolved') = 'true'::jsonb then
    v_probs := jsonb_build_array(tab.grel_problem('cannot determine whether the packaging order prints: its master calls a library element it does not pin', tab.grel_batch_ev(p_order)));
  end if;
  for k, s in select g.step_key, g.step from tab.grel_steps(p_order, 'G-21') g loop
    continue when s ->> 'status' = 'NOT_APPLICABLE';
    v_any := true;
    if s ->> 'status' is distinct from 'COMPLETED' then
      v_probs := v_probs || jsonb_build_array(tab.grel_problem(format('the printed-materials step %s is %s: its reconciliation is not closed', k, coalesce(s ->> 'status', 'of no status')), tab.grel_batch_ev(p_order)));
    end if;
  end loop;
  if not v_any and (v_blocks -> 'types') ? 'G-21'
     and not exists (select 1 from tab.grel_steps(p_order, 'G-21') g where g.step ->> 'status' = 'NOT_APPLICABLE') then
    v_probs := v_probs || jsonb_build_array(tab.grel_problem('the packaging master prints, but the record holds no printed-materials step (G-21): nothing was reconciled', tab.grel_batch_ev(p_order)));
  end if;
  v_probs := v_probs || coalesce((select jsonb_agg(tab.grel_problem('printed materials reconciled outside their limits: ' || (u ->> 'problem'), u -> 'evidence')) from jsonb_array_elements(v_unres) u), '[]'::jsonb);
  return tab.grel_item_of('E.RECONCILIATION_PRINTED', '4', v_title, v_probs, tab.grel_batch_ev(p_order),
                          jsonb_array_length(v_probs) = 0 and not v_any and not ((v_blocks -> 'types') ? 'G-21')
                          and not exists (select 1 from recipe.exception_register r where r.batch_id in (p_order, p_parent) and r.exception_type = 'PRINTED_RECONCILIATION'));
end
$$;

-- The Tablets items (CREATE OR REPLACE from 1162): as before, with since_review on every item (header item 1).
create or replace function tab.grel_edition_items(p_lot uuid, p_market text) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, tab, recipe, site, pg_temp as $$
declare
  f        site.finished_lot;
  v_parent uuid;
  v_both   uuid[];
  v_rev    timestamptz;
  v_items  jsonb;
begin
  select * into f from site.finished_lot x where x.lot_id = p_lot;
  if f.lot_id is null or f.edition <> 'TABLETS' then
    return jsonb_build_array(recipe.grel_item('E.EDITION', '10', 'Edition items', 'the lot is no finished lot of a Tablets packaging order'));
  end if;
  v_parent := recipe.packaging_parent_of(f.batch_id);
  v_both := array_remove(array[f.batch_id, v_parent], null);
  v_rev := recipe.release_review_time(p_lot);
  v_items := jsonb_build_array(
    tab.grel_recon_printed(f.batch_id, v_parent),
    tab.grel_recon_packs(f.batch_id),
    tab.grel_recon_serial(f.batch_id),
    tab.grel_recon_yield(f.batch_id, v_parent),
    tab.grel_posted_quantity(p_lot, f.batch_id),
    tab.grel_pack_examination(f.batch_id),
    tab.grel_printed_tablets(v_parent),
    tab.grel_held_containers(v_both),
    tab.grel_container_release(f.batch_id),
    tab.grel_rule_sets(v_both),
    tab.grel_whole_batch_parents(v_both));
  -- The batches whose records each item reads (its evidence adds containers, lots, deviations, rule sets, parents).
  return (select jsonb_agg(i || jsonb_build_object('since_review', tab.grel_changed_since(v_rev,
            case i ->> 'id'
              when 'E.RECONCILIATION_PRINTED' then v_both when 'E.RECONCILIATION_YIELD' then v_both
              when 'E.RECONCILIATION_PACKS' then array[f.batch_id] when 'E.RECONCILIATION_SERIAL' then array[f.batch_id]
              when 'E.POSTED_QUANTITY' then array[f.batch_id] when 'E.FINISHED_PACK_EXAMINATION' then array[f.batch_id]
              when 'E.PRINTED_TABLETS_QC' then array_remove(array[v_parent], null) when 'E.RULE_SETS_VERIFIED' then v_both
              when 'E.CONTAINER_RELEASE' then '{}'::uuid[] when 'E.WHOLE_BATCH_PARENTS' then '{}'::uuid[]
              else v_both end,
            i -> 'evidence')) order by n)
            from jsonb_array_elements(v_items) with ordinality x (i, n));
end
$$;

revoke all on function tab.grel_master_blocks(jsonb), tab.grel_next_hold(jsonb, text), tab.grel_changed_since(timestamptz, uuid[], jsonb) from public;

reset role;
