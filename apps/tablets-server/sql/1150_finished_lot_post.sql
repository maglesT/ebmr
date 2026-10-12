-- Tablets server, Phase 4 slice 2b: the finished lot of a packaging order, posted in quarantine (controls IN-05 (a),
-- PR-45; site-services 0842 site.create_finished_lot; plan interface site.finished_lot_of).
--
--   tab.post_finished_lot(batch, quantity, unit)  MATERIAL.HANDLE at the batch's site (site-services checks it again),
--       never an administrator. The batch is a GMP batch of a PACKAGING master whose execution is complete
--       (EXECUTION_COMPLETE); its finished lot is created once, in QUARANTINE, with lot code = batch number, material
--       code = product code, the product's name from the product master in effect, the batch's market set, and the
--       expiry of the processing batch it packs (recipe.source_batch_expiry of recipe.packaging_parent_of, capped by
--       recipe.recovered_expiry_cap when that batch contains recovered material: IN-19 (b)), at the end of that day in the
--       site's zone. The posted quantity is the count the warehouse receives (default D-2b-6: the packed count is not yet
--       reconciled against TB-24 here; the release model reads both).
-- It leaves quarantine only through the release model (slice 3): the material-lot route refuses finished product.
-- Messages: EBMR-TAB-850 to EBMR-TAB-852.

set local role ebmr_owner;

create function tab.post_finished_lot(p_batch uuid, p_quantity text, p_unit text) returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, tab, recipe, site, iam, kernel, pg_temp as $$
declare
  v_b       jsonb := site.subject_identity('BATCH', p_batch);
  v_parent  uuid;
  v_expiry  date;
  v_cap     timestamptz;
  v_name    text;
  v_markets text[];
  v_status  text;
begin
  perform site.require_actor();
  perform iam.assert_not_administrator();
  if v_b is null then
    raise exception using errcode = 'P0001', message = format('EBMR-TAB-850 batch %s is not a GMP batch of this installation', coalesce(p_batch::text, 'NULL'));
  end if;
  perform iam.require_permission('MATERIAL.HANDLE', jsonb_build_object('site', v_b ->> 'siteCode'));
  select s.status into v_status from recipe.execution_state s where s.batch_id = p_batch;
  if recipe.batch_record_kind(p_batch) is distinct from 'PACKAGING' or v_status is distinct from 'EXECUTION_COMPLETE' then
    raise exception using errcode = 'P0001',
      message = format('EBMR-TAB-850 batch %s is %s %s: a finished lot is posted from a packaging order whose execution is complete (PR-45, IN-05 (a))',
                       v_b ->> 'batchNumber', coalesce(recipe.batch_record_kind(p_batch), 'no'), coalesce(v_status, 'not started'));
  end if;
  if coalesce(p_unit, '') !~ '^[!-~]{1,32}$' then
    raise exception using errcode = 'P0001', message = 'EBMR-TAB-851 the unit of the posted quantity is a UCUM code';
  end if;
  v_parent := recipe.packaging_parent_of(p_batch);
  v_expiry := recipe.source_batch_expiry(coalesce(v_parent, p_batch));
  if v_expiry is null then
    raise exception using errcode = 'P0001',
      message = format('EBMR-TAB-852 the expiry of batch %s cannot be computed: the processing batch it packs and the product master''s shelf life are needed (IN-19)', v_b ->> 'batchNumber');
  end if;
  v_cap := case when v_parent is not null then recipe.recovered_expiry_cap(v_parent) end;
  select e.product_name into v_name from site.erp_product_effective(v_b ->> 'productCode', v_b ->> 'strength') e where e.id is not null;
  select b.markets into v_markets from recipe.stub_batch b where b.id = p_batch;
  return site.create_finished_lot(jsonb_build_object(
    'batchId', p_batch, 'batchNumber', v_b ->> 'batchNumber', 'edition', v_b ->> 'edition', 'siteCode', v_b ->> 'siteCode',
    'productCode', v_b ->> 'productCode', 'productName', coalesce(v_name, v_b ->> 'productCode'), 'strength', v_b ->> 'strength',
    'markets', to_jsonb(v_markets), 'quantity', p_quantity, 'unit', p_unit,
    'expiresAt', least(((v_expiry + 1)::timestamp at time zone kernel.site_zone()) - interval '1 microsecond', coalesce(v_cap, 'infinity'::timestamptz))));
end
$$;

revoke all on function tab.post_finished_lot(uuid, text, text) from public;
grant execute on function tab.post_finished_lot(uuid, text, text) to ebmr_app;

reset role;
