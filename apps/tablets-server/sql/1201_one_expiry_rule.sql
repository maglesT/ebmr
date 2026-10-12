-- Tablets server, Phase 4 slice 6a follow-up: one expiry rule (PR-43, D-6-3, D-6a-3; IN-19 (b); ADR 0012).
--
-- recipe.batch_expiry (recipe-core 0893) computes a batch's expiry in the database: the processing batch's manufacture date
-- plus the shelf life of the product master in effect then, rounded down to a month end, capped by the recovered or
-- reprocessed inputs. Both tablets readers of an expiry now take it, so the printed expiry and the finished lot's agree:
--   * tab.record_packaging_batch_data (CREATE OR REPLACE from tablets 1022, the latest): mfgDate and expiryDate (month and
--     year) from recipe.batch_expiry; a step that names a shelf life other than the product master's is refused; a step
--     that names none no longer needs to. Nothing else changes.
--   * tab.post_finished_lot (CREATE OR REPLACE from tablets 1150, the latest): the lot expires at the end of
--     recipe.batch_expiry's date in the site's zone (before: the end of the expiry month's first day). Nothing else changes.
--   * tab.batch_data_expiry_check: every writer of tab.packaging_batch_data writes the database's months (EBMR-EXE-296).
-- CREATE OR REPLACE keeps the owners and privileges. Applied as a new migration (applied migrations are never edited).

set local role ebmr_owner;

-- As tablets 1022, with the expiry from recipe.batch_expiry (header).
create or replace function tab.record_packaging_batch_data(p_batch uuid, p_key text, p_mrp text, p_reason text default null) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, tab, recipe, iam, kernel, plant, site, pg_temp as $$
declare
  v_actor  jsonb;
  v_step   jsonb;
  v_cfg    jsonb;
  v_market text;
  v_codes  jsonb;
  b        recipe.batch_execution;
  v_mfg    date;
  v_exp    date;
  v_fields jsonb;
  v_cur    tab.packaging_batch_data;
  v_ver    integer;
  j        tab.print_job;
  v_held   boolean;
  v_voided jsonb := '[]'::jsonb;
  v_be     jsonb;
begin
  perform iam.assert_not_administrator();
  v_actor := iam.require_permission('STEP.EXECUTE', plant.batch_scope(p_batch));
  perform pg_advisory_xact_lock(hashtext('tab.packaging_batch_data:' || p_batch::text || ':' || coalesce(p_key, '')));
  v_step := tab.g21_open_step(p_batch, p_key);
  v_cfg := v_step -> 'cfg';
  v_market := tab.g21_job_market(v_cfg, v_step -> 'header');
  if v_market is null then
    raise exception using errcode = 'P0001',
      message = 'The step names variable data for none or several of the batch''s markets: a packaging order prints for one market (PR-36). [EBMR-EXE-296]';
  end if;
  v_codes := v_cfg -> 'markets' -> v_market;
  if coalesce((v_codes -> 'mrp') = 'true'::jsonb, false) <> (p_mrp is not null) then
    raise exception using errcode = 'P0001',
      message = format('An MRP is given exactly for a pack that shows it (%s: %s) (IN-31). [EBMR-EXE-296]', v_market, case when (v_codes -> 'mrp') = 'true'::jsonb then 'it does' else 'it does not' end);
  end if;
  if p_mrp is not null and (p_mrp !~ '^(0|[1-9][0-9]{0,8})(\.[0-9]{1,2})?$' or p_mrp::numeric <= 0) then
    raise exception using errcode = 'P0001', message = 'An MRP is a positive amount in rupees with at most 2 decimals (IN-31). [EBMR-EXE-296]';
  end if;
  select * into b from recipe.batch_execution where id = p_batch;
  -- PR-43, D-6-3 (tablets 1201): the expiry is the database's one rule, recipe.batch_expiry (the processing batch's
  -- manufacture date plus the product master's shelf life in effect then, rounded down to a month end, capped by the
  -- recovered inputs, IN-19 (b)); a step naming another shelf life is refused, never used.
  v_be := recipe.batch_expiry(p_batch);
  if v_be is null then
    raise exception using errcode = 'P0001', message = 'The product master gives no shelf life for this batch, so the record gives no expiry date (PR-43, IN-31). [EBMR-EXE-296]';
  end if;
  if jsonb_typeof(v_cfg -> 'shelfLifeMonths') = 'number' and (v_cfg ->> 'shelfLifeMonths')::integer <> (v_be ->> 'shelfLifeMonths')::integer then
    raise exception using errcode = 'P0001',
      message = format('The step names a shelf life of %s months; the product master in effect when the batch was made gives %s: the printed expiry is the database''s (PR-43). [EBMR-EXE-296]',
                       v_cfg ->> 'shelfLifeMonths', v_be ->> 'shelfLifeMonths');
  end if;
  v_mfg := (v_be ->> 'manufactureDate')::date;
  v_exp := (v_be ->> 'expiryDate')::date;
  v_fields := jsonb_strip_nulls(jsonb_build_object('batch', b.batch_number, 'mfgDate', to_char(v_mfg, 'YYYY-MM-DD'), 'expiryDate', to_char(v_exp, 'YYYY-MM'), 'mrp', p_mrp));
  v_cur := tab.current_batch_data(p_batch, p_key);
  if (v_cur.id is null) <> (p_reason is null) or (p_reason is not null and btrim(p_reason) = '') then
    raise exception using errcode = 'P0001', message = case when v_cur.id is null
      then 'The step has no batch data yet: the first version is recorded without a reason (DI-22). [EBMR-EXE-296]'
      else 'A change of the batch data after set-up is recorded with your own reason; the jobs released on the earlier data are voided (L-29, DI-22). [EBMR-EXE-296]' end;
  end if;
  v_ver := coalesce(v_cur.version, 0) + 1;
  insert into tab.packaging_batch_data (batch_id, step_key, version, fields, reason, recorded_by_person, recorded_by_account, correlation_id)
  values (p_batch, p_key, v_ver, v_fields, p_reason, (v_actor ->> 'person_id')::uuid, (v_actor ->> 'account_id')::uuid, (v_actor ->> 'correlation_id')::uuid);
  -- L-29: the jobs released on earlier data are void; what a loaded (set-up) job printed since the last good check is held.
  for j in select x.* from tab.print_job x where x.batch_id = p_batch and x.step_key = p_key and x.data_version < v_ver
              and tab.print_job_state(x.id) in ('RELEASED', 'LOADED') order by x.released_at, x.id loop
    v_held := exists (select 1 from tab.print_job_ack a where a.job_id = j.id and a.result = 'LOADED') and jsonb_typeof(v_cfg -> 'unit') = 'string';
    insert into tab.print_job_void (job_id, data_version, held, voided_by) values (j.id, v_ver, v_held, (v_actor ->> 'person_id')::uuid);
    if v_held then
      perform plant.ipc_check_record(p_batch, v_cfg ->> 'unit', null, 'FAIL', format('L-29: batch data changed after set-up of print job %s', j.id), v_actor, false);
    end if;
    v_voided := v_voided || jsonb_build_object('jobId', j.id, 'held', v_held);
  end loop;
  return jsonb_build_object('version', v_ver, 'fields', v_fields, 'voided', v_voided);
end
$$;


-- As tablets 1150, with the expiry from recipe.batch_expiry (header).
create or replace function tab.post_finished_lot(p_batch uuid, p_quantity text, p_unit text) returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, tab, recipe, site, iam, kernel, pg_temp as $$
declare
  v_b       jsonb := site.subject_identity('BATCH', p_batch);
  v_expiry  date;
  v_be      jsonb;
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
  -- PR-43, D-6-3 (tablets 1201): the lot expires at the end of recipe.batch_expiry's date in the site's zone (the month end,
  -- or the earlier recovered-input cap, IN-19 (b)); the same rule as the printed expiry.
  v_be := recipe.batch_expiry(p_batch);
  v_expiry := (v_be ->> 'expiryDate')::date;
  if v_expiry is null then
    raise exception using errcode = 'P0001',
      message = format('EBMR-TAB-852 the expiry of batch %s cannot be computed: the processing batch it packs and the product master''s shelf life are needed (PR-43, IN-19)', v_b ->> 'batchNumber');
  end if;
  select e.product_name into v_name from site.erp_product_effective(v_b ->> 'productCode', v_b ->> 'strength') e where e.id is not null;
  select b.markets into v_markets from recipe.stub_batch b where b.id = p_batch;
  return site.create_finished_lot(jsonb_build_object(
    'batchId', p_batch, 'batchNumber', v_b ->> 'batchNumber', 'edition', v_b ->> 'edition', 'siteCode', v_b ->> 'siteCode',
    'productCode', v_b ->> 'productCode', 'productName', coalesce(v_name, v_b ->> 'productCode'), 'strength', v_b ->> 'strength',
    'markets', to_jsonb(v_markets), 'quantity', p_quantity, 'unit', p_unit,
    'expiresAt', ((v_expiry + 1)::timestamp at time zone kernel.site_zone()) - interval '1 microsecond'));
end
$$;


-- Every writer of the G-21 batch data writes the database's manufacture and expiry months (header).
create function tab.batch_data_expiry_check() returns trigger
language plpgsql security definer set search_path = pg_catalog, tab, recipe, pg_temp as $$
declare
  v_be jsonb := recipe.batch_expiry(new.batch_id);
begin
  if v_be is null or new.fields ->> 'expiryDate' is distinct from left(v_be ->> 'expiryDate', 7)
     or new.fields ->> 'mfgDate' is distinct from v_be ->> 'manufactureDate' then
    raise exception using errcode = 'P0001',
      message = format('The batch data names manufacture %s and expiry %s; the record gives %s and %s: an expiry is computed by the database, never typed (PR-43). [EBMR-EXE-296]',
                       coalesce(new.fields ->> 'mfgDate', 'none'), coalesce(new.fields ->> 'expiryDate', 'none'),
                       coalesce(v_be ->> 'manufactureDate', 'none'), coalesce(left(v_be ->> 'expiryDate', 7), 'none'));
  end if;
  return new;
end
$$;
create trigger batch_data_expiry_check before insert on tab.packaging_batch_data for each row execute function tab.batch_data_expiry_check();
revoke all on function tab.batch_data_expiry_check() from public;

reset role;
