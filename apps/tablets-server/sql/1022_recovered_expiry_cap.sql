-- Tablets server, Phase 3 slice 5b: the printed expiry of a batch that received recovered or reprocessed material is
-- never later than the earliest expiry among those inputs (outline 5.2.9 cases 2 and 3; IN-19 (b), default proposal;
-- D-S5-7; ADR 0012).
--
--   * tab.record_packaging_batch_data (CREATE OR REPLACE from tablets 0951, the latest): unchanged but for the expiry
--     month, now the earlier of the step's rule (manufacturing month plus shelf life, less one) and the month of
--     recipe.recovered_expiry_cap of the processing batch the order packs (the earliest source expiry recorded with its
--     additions: the source batch's manufacturing month plus the product master's shelf life, less one). The value is
--     computed by the database, never typed; the quality unit's confirmation is its per-use authorisation of each
--     addition, whose risk evaluation addresses shelf life (TB-08 class a) (default; for the owner and the expert).
--
-- CREATE OR REPLACE keeps the owner and the privileges. Applied as a new migration because applied migrations are
-- checksummed and never edited.

set local role ebmr_owner;

-- As tablets 0951, with the recovered-input expiry cap (header).
create or replace function tab.record_packaging_batch_data(p_batch uuid, p_key text, p_mrp text, p_reason text default null) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, tab, recipe, iam, kernel, plant, site, pg_temp as $$
declare
  v_actor  jsonb;
  v_step   jsonb;
  v_cfg    jsonb;
  v_market text;
  v_codes  jsonb;
  b        recipe.batch_execution;
  v_proc   recipe.batch_execution;
  v_mfg    date;
  v_exp    date;
  v_fields jsonb;
  v_cur    tab.packaging_batch_data;
  v_ver    integer;
  j        tab.print_job;
  v_held   boolean;
  v_voided jsonb := '[]'::jsonb;
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
  if jsonb_typeof(v_cfg -> 'shelfLifeMonths') is distinct from 'number' then
    raise exception using errcode = 'P0001', message = 'The step names no shelf life, so the record gives no expiry date (PR-36, IN-31). [EBMR-EXE-296]';
  end if;
  if coalesce((v_codes -> 'mrp') = 'true'::jsonb, false) <> (p_mrp is not null) then
    raise exception using errcode = 'P0001',
      message = format('An MRP is given exactly for a pack that shows it (%s: %s) (IN-31). [EBMR-EXE-296]', v_market, case when (v_codes -> 'mrp') = 'true'::jsonb then 'it does' else 'it does not' end);
  end if;
  if p_mrp is not null and (p_mrp !~ '^(0|[1-9][0-9]{0,8})(\.[0-9]{1,2})?$' or p_mrp::numeric <= 0) then
    raise exception using errcode = 'P0001', message = 'An MRP is a positive amount in rupees with at most 2 decimals (IN-31). [EBMR-EXE-296]';
  end if;
  select * into b from recipe.batch_execution where id = p_batch;
  -- The processing batch the order packs: the parent of a PACKAGING number, else the batch itself.
  select x.* into v_proc from site.batch_number_allocation a
    join recipe.batch_allocation_link l on l.allocation_id = a.parent_allocation_id
    join recipe.batch_execution x on x.id = l.batch_id
   where a.id = (select k.allocation_id from recipe.batch_allocation_link k where k.batch_id = p_batch);
  if v_proc.id is null then
    v_proc := b;
  end if;
  v_mfg := (v_proc.issued_at at time zone kernel.site_zone())::date;
  v_exp := (date_trunc('month', v_mfg) + make_interval(months => (v_cfg ->> 'shelfLifeMonths')::integer - 1))::date;
  -- IN-19 (b) (tablets 1022): never later than the earliest expiry among the recovered or reprocessed inputs added to the
  -- processing batch (recipe-core 0621, 0624; computed, never typed).
  v_exp := least(v_exp, (recipe.recovered_expiry_cap(v_proc.id) at time zone 'UTC')::date);
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

reset role;
