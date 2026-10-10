-- Recipe core, plant and output containers: a GMP batch has a product and a permission scope (Phase 3 slice 2b quick
-- review findings 1 and 2; DI-17, DI-05, IN-21, IN-26; ADR 0012: the rules hold when the application's own database
-- credentials are used directly).
--
-- What was wrong. plant.batch_scope (0422), plant.batch_facts (0403) and plant.open_container (0422) read a batch's
-- product from its test package (recipe.test_package.product). A GMP batch names no test package (0500), so:
--   * plant.batch_scope returned NULL, and iam.require_permission evaluates a NULL scope as the empty scope: an operator
--     whose STEP.EXECUTE grant is limited to product A or site X recorded an IPC check (plant.record_ipc_check), a
--     charge or a merge on a GMP batch of product B (finding 1, access);
--   * plant.batch_facts refused every equipment and area command on a GMP batch as an unknown batch, and
--     plant.open_container refused it as naming no product (finding 2).
--
-- What changed:
--   * recipe.batch_product(batch): the product of a batch, {code, name, strength, ...}: its test package's product for a
--     test batch (as before; 0318 holds it to the package content's header), the product of its control recipe's MBR
--     content header for a GMP batch (the content its pin and the issuer's ISSUED signature cover). NULL for no batch.
--   * plant.batch_scope(batch) is the batch's product and site ({product, site}, the site where the batch was issued)
--     and fails closed: a batch that does not exist, or whose product code is blank, is refused (EBMR-CNT-020) instead
--     of giving a scope; so no caller evaluates a permission with an empty scope.
--   * plant.batch_facts and plant.open_container, replaced from their latest definitions (0403, 0422), read the product
--     through recipe.batch_product; nothing else in them changes.
-- No other function of recipe-core or site-services reads recipe.test_package outside the sandbox-only writers
-- (import_test_package, issue_execution), the invariant query, the content helpers of 0500 and recipe.run_bound_words
-- (the sandbox's identifier rule; it returns before reading in a GMP database).
--
-- CREATE OR REPLACE keeps owners and privileges; batch_scope keeps its signature. Applied as a new migration because
-- applied migrations are checksummed and never edited.

set local role ebmr_owner;

-- DI-17, IN-21: the product of batch p_batch (see the header).
create function recipe.batch_product(p_batch uuid) returns jsonb
language sql stable security definer set search_path = pg_catalog, recipe, pg_temp as $$
  select case
           when b.package_hash is not null then (select pk.product from recipe.test_package pk where pk.package_hash = b.package_hash)
           when b.control_recipe_id is not null then (select cr.snapshot -> 'mbr' -> 'content' -> 'header' -> 'product' from recipe.control_recipe cr where cr.id = b.control_recipe_id)
         end
    from recipe.batch_execution b where b.id = p_batch
$$;

-- DI-17: the scope of a permission on batch p_batch: its product and site. Fails closed (see the header).
create or replace function plant.batch_scope(p_batch uuid) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, recipe, pg_temp as $$
declare
  b      recipe.batch_execution;
  v_code text;
begin
  select * into b from recipe.batch_execution where id = p_batch;
  if not found then
    raise exception using errcode = 'P0001', message = format('Unknown batch %s (EBMR-CNT-020)', coalesce(p_batch::text, 'NULL'));
  end if;
  v_code := recipe.batch_product(p_batch) ->> 'code';
  if coalesce(btrim(v_code), '') = '' or coalesce(btrim(b.site_code), '') = '' then
    raise exception using errcode = 'P0001',
      message = format('Batch %s names no product or site, so no permission on it can be scoped; nothing is recorded for it (DI-17; EBMR-CNT-020)', b.batch_number);
  end if;
  return jsonb_build_object('product', v_code, 'site', b.site_code);
end
$$;

-- As 0403; the product from recipe.batch_product.
create or replace function plant.batch_facts(p_batch uuid) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, plant, recipe, pg_temp as $$
declare
  v jsonb;
begin
  select jsonb_build_object('batch_id', b.id, 'batch_number', b.batch_number, 'product', recipe.batch_product(b.id) ->> 'code', 'market_set', to_jsonb(b.market_set))
    into v
  from recipe.batch_execution b where b.id = p_batch;
  if v is null then
    perform plant.fail(format('Unknown batch %s (EBMR-PLANT-014)', coalesce(p_batch::text, 'NULL')));
  end if;
  perform plant.require_product(v ->> 'product');
  return v;
end
$$;

-- As 0422; the product from recipe.batch_product.
create or replace function plant.open_container(p_batch uuid, p_stage text, p_unit text, p_press text default null, p_stream text default null)
returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, plant, recipe, iam, kernel, platform, pg_temp as $$
declare
  v_actor  jsonb;
  b        recipe.batch_execution;
  v_prod   jsonb;
  v_id     uuid := gen_random_uuid();
  v_label  text;
  v_n      integer;
  v_state  jsonb;
begin
  perform iam.assert_not_administrator();
  select * into b from recipe.batch_execution where id = p_batch;
  if not found then
    raise exception using errcode = 'P0001', message = format('Unknown batch %s (EBMR-CNT-020)', p_batch);
  end if;
  v_actor := iam.require_permission('STEP.EXECUTE', plant.batch_scope(p_batch));
  v_prod := recipe.batch_product(p_batch);
  if coalesce(btrim(v_prod ->> 'code'), '') = '' or coalesce(btrim(v_prod ->> 'strength'), '') = '' then
    raise exception using errcode = 'P0001',
      message = format('Batch %s names no product code and strength; a container carries both (IN-21; EBMR-CNT-021)', b.batch_number);
  end if;
  if p_stream is not null and p_press is null then
    raise exception using errcode = 'P0001', message = 'A stream belongs to a press: name the press (EBMR-CNT-022)';
  end if;
  perform pg_advisory_xact_lock(hashtext('plant.output_container:' || p_batch::text));
  v_n := (select count(*) from plant.output_container where batch_id = p_batch) + 1;
  v_label := format('OC-%s-%s', b.batch_number, lpad(v_n::text, 4, '0'));
  insert into plant.output_container (id, label_code, batch_id, batch_number, product_code, strength, stage, press_code, stream, quantity_unit,
                                      opened_by_person, opened_by_account)
  values (v_id, v_label, p_batch, b.batch_number, v_prod ->> 'code', v_prod ->> 'strength', p_stage, p_press, p_stream, p_unit,
          (v_actor ->> 'person_id')::uuid, (v_actor ->> 'account_id')::uuid);
  v_state := platform.create_aggregate_state('output_container', 'output_container', v_id);
  return jsonb_build_object('container_id', v_id, 'label_code', v_label, 'state', v_state ->> 'state', 'version', (v_state ->> 'version')::bigint);
end
$$;

revoke all on function recipe.batch_product(uuid) from public;

reset role;
