-- Recipe core: the release gate G-REL and the manufacturer release, interfaces (Phase 4 slice 3-0; outline 5.2.6, 5.2.7,
-- 5.7; plan docs/build-plan/phase-4/phase-4-plan.md "Interfaces fixed up front"; D-P4-4; ADR 0012, ADR 0019).
--
-- Fixed here (changed only through the lead); slice 3a fills the bodies by new migrations from these definitions:
--
--   recipe.grel_evaluate(lot uuid, market text) returns jsonb   STABLE. The release gate of one finished lot for one market
--       (IN, US or EU), evaluated outside the signing transaction and again inside it (D-P4-4):
--         {"lot": uuid, "market": text, "epoch": text, "ready": boolean, "items": [item, ...]}
--       epoch  the evidence token of the evaluation (text; the signing act sends it back and is refused when it moved);
--       ready  true only when no item is RED.
--       item   {"id": text, "group": text, "title": text, "status": "GREEN" | "RED" | "NA", "problem": text | null,
--               "evidence": [{"kind": text, "ref": text, "label": text}], "since_review": boolean}
--         id            stable per check, e.g. "G1.REVIEW_PACKAGING" (core: "G<group>.<NAME>"; edition: "E.<NAME>");
--         group         the outline 5.2.7 group as text: "1" to "9" for the core items, "10" for the edition items, "11"
--                       for market items (slice 4); an edition may also answer for groups "4" and "9" (reconciliation and
--                       the finished-pack examination are the edition's blocks);
--         problem       why it is RED (the database's words), NULL otherwise;
--         evidence      what the item rests on, for the cockpit's links (kind: BATCH, LOT, DEVIATION, INCIDENT,
--                       LIMS_RESULT, SAMPLE, CHANGE_RECORD, SIGNATURE, CONTAINER, EXCEPTION, ...; ref: the id);
--         since_review  the evidence changed after the QA review of the lot's packaging record (the "since review" list
--                       the signer acknowledges item by item).
--   recipe.grel_edition_items(lot uuid, market text) returns jsonb   the edition's items (a JSON array of items, group
--       "10", or "4" and "9"): resolved through recipe.grel_edition_hook by the finished lot's edition, so recipe-core
--       never names an edition schema. No registered hook, or an answer that is not an array of well-formed items, gives
--       one RED item (fails closed).
--   recipe.register_grel_edition_hook(edition text, fn regprocedure)   owner only: an edition migration registers its
--       function `(uuid, text) returns jsonb` (Tablets: tab.grel_edition_items, tablets 1160).
--   recipe.manufacturer_release_state(lot uuid) returns text   NOT_READY, READY (computed: G-REL for IN ready), RELEASED
--       or REJECTED (slice 3a records the decisions; until then NOT_READY or READY).
--
-- Signature meanings (kernel 0210): MANUFACTURER_RELEASE (the AP or a named delegate, all components, excludes the
-- involved). The signed aggregate `manufacturer_release <lot>` and the acts arrive with slice 3a (recipe-core 0781 on).
-- Messages: EBMR-REL-001 to EBMR-REL-099 (slice 3a).

set local role ebmr_owner;

create table recipe.grel_edition_hook (
  edition        text primary key check (edition in ('TABLETS', 'INJECTABLES')),
  function_name  text not null check (function_name ~ '^[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*\(uuid, ?text\)$'),
  registered_at  timestamptz not null default clock_timestamp()
);
revoke all on recipe.grel_edition_hook from public;
grant select on recipe.grel_edition_hook to ebmr_app;
comment on table recipe.grel_edition_hook is 'G-REL edition items (slice 3-0): the function of each edition that answers its items; written by the edition''s migration through recipe.register_grel_edition_hook';
select platform.enforce_db_time('recipe.grel_edition_hook', array['registered_at']);
select kernel.register_audited_table('recipe.grel_edition_hook', 'grel_edition_hook', 'edition', true);

-- Owner only (no grant): an edition registers its items function once; the signature is checked (uuid, text) -> jsonb.
create function recipe.register_grel_edition_hook(p_edition text, p_function regprocedure) returns void
language plpgsql volatile security definer set search_path = pg_catalog, recipe, pg_temp as $$
begin
  if not exists (select 1 from pg_proc p where p.oid = p_function and oidvectortypes(p.proargtypes) = 'uuid, text' and p.prorettype = 'jsonb'::regtype) then
    raise exception using errcode = 'P0001', message = format('EBMR-REL-001 the G-REL edition hook %s must have the signature (uuid, text) returns jsonb', p_function);
  end if;
  insert into recipe.grel_edition_hook (edition, function_name) values (upper(p_edition), p_function::text);
end
$$;
revoke all on function recipe.register_grel_edition_hook(text, regprocedure) from public;

-- One RED item (the shape of every item).
create function recipe.grel_item(p_id text, p_group text, p_title text, p_problem text, p_evidence jsonb default '[]'::jsonb,
                                 p_since_review boolean default false, p_status text default null) returns jsonb
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select jsonb_build_object('id', p_id, 'group', p_group, 'title', p_title,
                            'status', coalesce(p_status, case when p_problem is null then 'GREEN' else 'RED' end),
                            'problem', p_problem, 'evidence', coalesce(p_evidence, '[]'::jsonb), 'since_review', coalesce(p_since_review, false))
$$;

-- Whether an edition's answer is an array of well-formed items.
create function recipe.grel_items_well_formed(p_items jsonb) returns boolean
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select jsonb_typeof(p_items) = 'array'
     and not exists (
       select 1 from jsonb_array_elements(p_items) i
        where jsonb_typeof(i) <> 'object'
           or coalesce(i ->> 'id', '') !~ '^E\.[A-Z0-9_]{1,64}$'
           or coalesce(i ->> 'group', '') not in ('4', '9', '10')
           or coalesce(btrim(i ->> 'title'), '') = ''
           or coalesce(i ->> 'status', '') not in ('GREEN', 'RED', 'NA')
           or (i ->> 'status' = 'RED') <> (coalesce(btrim(i ->> 'problem'), '') <> '')
           or jsonb_typeof(i -> 'evidence') is distinct from 'array'
           or jsonb_typeof(i -> 'since_review') is distinct from 'boolean')
     and (select count(distinct i ->> 'id') = count(*) from jsonb_array_elements(p_items) i)
$$;

create function recipe.grel_edition_items(p_lot uuid, p_market text) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, recipe, site, pg_temp as $$
declare
  v_edition text;
  v_fn      text;
  v_items   jsonb;
begin
  select f.edition into v_edition from site.finished_lot f where f.lot_id = p_lot;
  if v_edition is null then
    return jsonb_build_array(recipe.grel_item('E.EDITION', '10', 'Edition items', 'the lot is no finished lot of a packaging batch'));
  end if;
  select h.function_name into v_fn from recipe.grel_edition_hook h where h.edition = v_edition;
  if v_fn is null then
    return jsonb_build_array(recipe.grel_item('E.EDITION', '10', 'Edition items', format('the %s edition has registered no G-REL items; the release waits for them', v_edition)));
  end if;
  execute format('select %s($1, $2)', regexp_replace(v_fn, '\(.*$', '')) into v_items using p_lot, p_market;
  if v_items is null or not recipe.grel_items_well_formed(v_items) then
    return jsonb_build_array(recipe.grel_item('E.EDITION', '10', 'Edition items', format('the %s edition''s G-REL items are not well formed', v_edition)));
  end if;
  return v_items;
end
$$;

-- 3-0 placeholder (slice 3a replaces it): every core group RED until its check is built; the edition's items appended.
create function recipe.grel_evaluate(p_lot uuid, p_market text) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, recipe, site, pg_temp as $$
declare
  v_items jsonb := '[]'::jsonb;
  g       integer;
begin
  if p_market is null or p_market not in ('IN', 'US', 'EU') then
    raise exception using errcode = 'P0001', message = format('EBMR-REL-002 G-REL is evaluated for IN, US or EU, not %s', coalesce(p_market, 'NULL'));
  end if;
  for g in 1..9 loop
    v_items := v_items || jsonb_build_array(recipe.grel_item(format('G%s.PENDING', g), g::text, format('Group %s', g), 'not evaluated yet (slice 3a)'));
  end loop;
  v_items := v_items || recipe.grel_edition_items(p_lot, p_market);
  return jsonb_build_object('lot', p_lot, 'market', p_market, 'epoch', '0', 'ready', false, 'items', v_items);
end
$$;

create function recipe.manufacturer_release_state(p_lot uuid) returns text
language sql stable security definer set search_path = pg_catalog, recipe, pg_temp as $$
  select case when (recipe.grel_evaluate(p_lot, 'IN') ->> 'ready')::boolean then 'READY' else 'NOT_READY' end
$$;

revoke all on function recipe.grel_item(text, text, text, text, jsonb, boolean, text), recipe.grel_items_well_formed(jsonb),
                       recipe.grel_edition_items(uuid, text), recipe.grel_evaluate(uuid, text), recipe.manufacturer_release_state(uuid) from public;
grant execute on function recipe.grel_evaluate(uuid, text), recipe.grel_edition_items(uuid, text), recipe.manufacturer_release_state(uuid) to ebmr_app;

reset role;
