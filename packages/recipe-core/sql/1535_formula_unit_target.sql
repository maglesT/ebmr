-- Recipe core: a formula version's target unit mass and its further approved batch sizes (Phase 7 slice 7j, requirement
-- R4; decision D-7j-3; decision 0006 part 1; controls PR-01, INV-25).
--
-- Handbook: modules/recipe-core.md
--
-- A company that makes its own product writes, with the composition, the target mass of one unit (the tablet's target
-- weight, mg) and the batch sizes it will make besides the formula's reference size (in units). A new master taken
-- from the formula (slice 7j) lists these sizes as its discrete batch sizes (PR-01), each a mass computed from the
-- formula's batch mass, never typed (INV-25).
--   * formulary.formula_version_target   insert-only, audited (aggregate formula_version): one row per version at most.
--   * recipe.formula_set_target(version, p)  FORMULA.MANAGE in the product's scope; the version is a DRAFT (the
--       approver signs the target with the composition); p: {targetUnitMassMg (decimal text > 0), otherBatchSizesUnits
--       (whole numbers as text, each once, none the reference size, at most 9)}.
--   * recipe.formula_version_content (CREATE OR REPLACE from 0640): the signed content carries the target when set.
--   * recipe.formula_target_of(version) jsonb: {targetUnitMassMg, batchSizesUnits (reference first)} or NULL.
--
-- Messages: EBMR-FRM-050 to 052.

set local role ebmr_owner;

create table formulary.formula_version_target (
  version_id            uuid primary key references formulary.formula_version (id),
  target_unit_mass_mg   numeric not null check (target_unit_mass_mg > 0 and target_unit_mass_mg < 100000),
  other_batch_sizes     numeric[] not null default '{}' check (cardinality(other_batch_sizes) <= 9),
  set_by_person         uuid not null,
  set_by_account        uuid not null,
  set_at                timestamptz not null default clock_timestamp(),
  correlation_id        uuid not null
);
revoke all on formulary.formula_version_target from public;
create trigger aa_insert_only before update or delete on formulary.formula_version_target for each row execute function kernel.reject_mutation();
create trigger aa_no_truncate before truncate on formulary.formula_version_target for each statement execute function kernel.reject_mutation();
select platform.enforce_db_time('formulary.formula_version_target', array['set_at']);
select kernel.register_audited_table('formulary.formula_version_target', 'formula_version', 'version_id', true);

create function recipe.formula_set_target(p_version uuid, p jsonb) returns void
language plpgsql volatile security definer set search_path = pg_catalog, recipe, iam, pg_temp as $$
declare
  v_actor jsonb := iam.assert_validated_actor();
  v       formulary.formula_version;
  f       formulary.formula;
  v_sizes numeric[] := '{}';
  x       jsonb;
begin
  perform iam.assert_not_administrator();
  select * into v from formulary.formula_version where id = p_version;
  if v.id is null then
    perform recipe.formula_fail('EBMR-FRM-050', format('There is no formula version %s', p_version));
  end if;
  select * into f from formulary.formula where id = v.formula_id for update;
  perform iam.require_permission('FORMULA.MANAGE', jsonb_build_object('product', f.product_code));
  if recipe.formula_version_state(v.id) <> 'DRAFT' or exists (select 1 from formulary.formula_version_target t where t.version_id = v.id) then
    perform recipe.formula_fail('EBMR-FRM-051', format('Version %s is not a draft without a target: the target is written once, with the composition, before the approval', v.version_number));
  end if;
  if p is null or coalesce(p ->> 'targetUnitMassMg', '') !~ '^(0|[1-9][0-9]{0,4})(\.[0-9]{1,6})?$' or (p ->> 'targetUnitMassMg')::numeric <= 0
     or (p ? 'otherBatchSizesUnits' and jsonb_typeof(p -> 'otherBatchSizesUnits') <> 'array') then
    perform recipe.formula_fail('EBMR-FRM-052', 'The target unit mass is a positive decimal in mg, and the further batch sizes a list of whole numbers of units (PR-01)');
  end if;
  for x in select * from jsonb_array_elements(coalesce(p -> 'otherBatchSizesUnits', '[]'::jsonb)) loop
    if jsonb_typeof(x) <> 'string' or x #>> '{}' !~ '^[1-9][0-9]{0,11}$' or (x #>> '{}')::numeric = f.batch_size_units or (x #>> '{}')::numeric = any (v_sizes) then
      perform recipe.formula_fail('EBMR-FRM-052', format('Batch size %s: each further size is a whole number of units, listed once, other than the formula''s %s (PR-01)', x, f.batch_size_units));
    end if;
    v_sizes := v_sizes || (x #>> '{}')::numeric;
  end loop;
  if cardinality(v_sizes) > 9 then
    perform recipe.formula_fail('EBMR-FRM-052', 'At most nine further batch sizes (PR-01)');
  end if;
  insert into formulary.formula_version_target (version_id, target_unit_mass_mg, other_batch_sizes, set_by_person, set_by_account, correlation_id)
  values (v.id, (p ->> 'targetUnitMassMg')::numeric, v_sizes, (v_actor ->> 'person_id')::uuid, (v_actor ->> 'account_id')::uuid, (v_actor ->> 'correlation_id')::uuid);
end
$$;

create function recipe.formula_target_of(p_version uuid) returns jsonb
language sql stable security definer set search_path = pg_catalog, recipe, pg_temp as $$
  select jsonb_build_object('targetUnitMassMg', trim_scale(t.target_unit_mass_mg)::text,
                            'batchSizesUnits', (select jsonb_agg(s::text order by o) from unnest(f.batch_size_units || t.other_batch_sizes) with ordinality u(s, o)))
    from formulary.formula_version_target t join formulary.formula_version v on v.id = t.version_id join formulary.formula f on f.id = v.formula_id
   where t.version_id = p_version
$$;

-- As 0640, with the target when set (header).
create or replace function recipe.formula_version_content(p_id text) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, recipe, pg_temp as $$
declare
  v formulary.formula_version;
  f formulary.formula;
  t jsonb;
begin
  if p_id !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return jsonb_build_object('exists', false);
  end if;
  select * into v from formulary.formula_version where id = p_id::uuid;
  if v.id is null then
    return jsonb_build_object('exists', false);
  end if;
  select * into f from formulary.formula where id = v.formula_id;
  t := recipe.formula_target_of(v.id);
  return jsonb_build_object(
    'exists', true, 'content_version', 1, 'state', recipe.formula_version_state(v.id), 'entered_by', jsonb_build_array(v.authored_by_person),
    'scope', jsonb_build_object('product', f.product_code),
    'content', jsonb_build_object('title', format('Formula %s %s, %s units, version %s', f.product_code, f.strength, f.batch_size_units, v.version_number),
                                  'productCode', f.product_code, 'strength', f.strength, 'batchSizeUnits', f.batch_size_units::text,
                                  'versionNumber', v.version_number, 'changeReason', v.change_reason, 'lines', recipe.formula_lines_json(v.id))
               || case when t is null then '{}'::jsonb else jsonb_build_object('target', t) end);
end
$$;

revoke all on function recipe.formula_set_target(uuid, jsonb), recipe.formula_target_of(uuid) from public;
grant execute on function recipe.formula_set_target(uuid, jsonb), recipe.formula_target_of(uuid) to ebmr_app;

reset role;
