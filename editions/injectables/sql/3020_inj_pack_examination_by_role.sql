-- Injectables lean review, item 6 (lead, 10 November 2026; decision 0026): the release item E.PACK_EXAMINATION takes any
-- finished-pack examination step that completes the packaging record, not only steps of the catalogue block INJ-PACK-EXAM,
-- so a firm's own QA-approved examination block counts without software.
--
-- Handbook: modules/injectables.md
--
--   injectables.grel_pack_examination(order) (CREATE OR REPLACE from 3000): the steps of P whose block type completes a
--       packaging record of the edition in P's master (recipe.packaging_completion_types, recipe-core 1892: the edition's
--       rows of recipe.packaging_completion_block and every approved library block with the role PACK_EXAMINATION).
--       21 CFR 211.134(b), (c): a representative sample of the finished packs is examined at the completion of finishing
--       and the result recorded. As in 3000: no examination ran is RED; an examination that ran and is not COMPLETED is
--       RED. A failed examination is judged by the block-neutral record of the failure, not by a field id of one block:
--       the step's critical limit breaches and unexpected answers (LIB_LIMIT_BREACH, LIB_UNEXPECTED_ANSWER) keep the item
--       RED until each is dispositioned and the deviation linked to it is CLOSED (tab.grel_unresolved; lead ruling,
--       9 November 2026).
--
-- PL/pgSQL, SECURITY DEFINER, search_path pinned with pg_temp last (ADR 0016).

set local role ebmr_owner;

create or replace function injectables.grel_pack_examination(p_order uuid) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, injectables, tab, recipe, pg_temp as $$
declare
  v_probs jsonb := '[]'::jsonb;
  v_any   boolean := false;
  v_types text[] := recipe.packaging_completion_types('injectables', recipe.batch_mbr_content(p_order));
  v_unres jsonb;
  t       text;
  k       text;
  s       jsonb;
begin
  foreach t in array v_types loop
    for k, s in select g.step_key, g.step from tab.grel_steps(p_order, t) g where g.step ->> 'status' is distinct from 'NOT_APPLICABLE' loop
      v_any := true;
      if s ->> 'status' is distinct from 'COMPLETED' then
        v_probs := v_probs || jsonb_build_array(tab.grel_problem(format('the finished-pack examination %s is %s, not COMPLETED', k, coalesce(s ->> 'status', 'of no status')), tab.grel_batch_ev(p_order)));
        continue;
      end if;
      v_unres := tab.grel_unresolved(array[p_order], array['LIB_LIMIT_BREACH', 'LIB_UNEXPECTED_ANSWER'], k);
      if jsonb_array_length(v_unres) > 0 then
        v_probs := v_probs || jsonb_build_array(tab.grel_problem(format('the finished-pack examination %s found a failure, not resolved: %s', k, v_unres -> 0 ->> 'problem'), v_unres -> 0 -> 'evidence'));
      end if;
    end loop;
  end loop;
  if not v_any then
    v_probs := jsonb_build_array(tab.grel_problem('the packaging order ran no finished-pack examination: no sample of the finished packs was examined', tab.grel_batch_ev(p_order)));
  end if;
  return tab.grel_item_of('E.PACK_EXAMINATION', '9', 'Finished packs examined', v_probs, tab.grel_batch_ev(p_order));
end
$$;

reset role;
