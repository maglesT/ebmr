-- Tablets edition, module C3 (Phase 7 slice 7o, D-7o-1; found by the R4 browser run of a company's own product): a test
-- run's disposal or sample names the batch's own output container (DI-05, DI-30, PR-18).
--
-- Handbook: modules/tablets-server.md
-- Since D-7o-1 the sandbox opens output containers as GMP does (plant.open_container), labelled OC-<batch number>-<n>
-- from the test batch's own number (OC-TEST-B26-0001-0006). The identifier rule of 0370/0801 reads the container an
-- entry names as a lot number, which in a sandbox starts with TEST-: a test run's inspection could not record the
-- destruction of its own reject container (TB-20, DISPOSAL.container), nor a sample from one (SAMPLE.container).
--
-- What changes. A DISPOSAL or SAMPLE entry may name, as its container, the label of an output container of the same
-- batch (plant.output_container, label_code and batch_id): the label is built by the database from the batch's own
-- number, a bound source as recipe-core 0344 counts them, never a real GMP identifier. Every other container and every
-- other member keeps the rule unchanged; another batch's container, or a label no container of this batch carries, is
-- refused as before (EBMR-EXE-078), and GMP keeps its own rule (a TEST- identifier is refused there).
--   * tab.own_output_container(p_batch, p_label): whether p_label is an output container of batch p_batch;
--   * tab.entry_identifier_problem(p_batch, p_entry) (0801, CREATE OR REPLACE): the container check skips such a label;
--   * tab.state_entry_identifier_problem(p_entry, p_command, p_batch_number) (0380, CREATE OR REPLACE): the same for an
--     entry the state stores, the batch found by its own number.
--
-- The functions are SECURITY DEFINER, owned by ebmr_owner, private to the owner, and pin their search_path with pg_temp
-- last. Applied as a new migration because applied migrations are checksummed and never edited.

set local role ebmr_owner;

create function tab.own_output_container(p_batch uuid, p_label text) returns boolean
language sql stable security definer set search_path = pg_catalog, plant, pg_temp as $$
  select p_batch is not null and p_label is not null
     and exists (select 1 from plant.output_container c where c.batch_id = p_batch and c.label_code = p_label)
$$;

create or replace function tab.entry_identifier_problem(p_batch uuid, p_entry jsonb) returns text
language plpgsql stable security definer set search_path = pg_catalog, tab, platform, sandbox, kernel, pg_temp as $$
declare
  v_kind  text := p_entry ->> 'kind';
  v_check record;
  v_p     text;
  v_lot   jsonb;
  v_reg   jsonb;
  v_facts jsonb;
begin
  for v_check in
    select c.member, c.idkind
      from (values ('PREVIOUS_BATCH', 'batchNumber', 'BATCH_NUMBER'), ('CHARGE_CONTAINER', 'scannedBatch', 'BATCH_NUMBER'),
                   ('SOURCE_ADDITION', 'sourceBatch', 'BATCH_NUMBER'),
                   ('CONTAINER_WEIGHING', 'container', 'LOT_NUMBER'), ('CHARGE_CONTAINER', 'container', 'LOT_NUMBER'),
                   ('CHARGE_LOT', 'container', 'LOT_NUMBER'), ('OUTPUT_CONTAINER', 'container', 'LOT_NUMBER'),
                   ('SAMPLE', 'container', 'LOT_NUMBER'), ('DISPOSAL', 'container', 'LOT_NUMBER')) c (kind, member, idkind)
     where c.kind = v_kind and p_entry ? c.member and jsonb_typeof(p_entry -> c.member) is distinct from 'null'
  loop
    continue when v_kind = 'PREVIOUS_BATCH' and p_entry -> v_check.member = '"NONE"'::jsonb;
    -- This slice: the batch's own output container (its label built from the batch's own number).
    continue when v_kind in ('DISPOSAL', 'SAMPLE') and v_check.member = 'container'
              and tab.own_output_container(p_batch, p_entry ->> 'container');
    v_p := sandbox.identifier_problem(v_check.idkind, p_entry ->> v_check.member);
    if v_p is not null then
      return format('%s %s', v_check.member, regexp_replace(v_p, '\s*\[EBMR-[A-Z]+-[0-9]{3}\]$', ''));
    end if;
  end loop;
  if v_kind in ('CONTAINER_WEIGHING', 'CHARGE_LOT') then
    v_lot := p_entry -> 'lot';
    v_p := sandbox.identifier_problem('LOT_NUMBER', coalesce(v_lot ->> 'id', ''));
    if v_p is not null then
      return format('lot %s', regexp_replace(v_p, '\s*\[EBMR-[A-Z]+-[0-9]{3}\]$', ''));
    end if;
    v_facts := tab.lot_facts(v_lot ->> 'id', p_batch);
    if v_facts is null then
      return format('lot %s is not a registered %slot of this installation', left(v_lot ->> 'id', 64),
                    case when kernel.installation_kind() = 'SANDBOX' then 'test ' else 'material ' end);
    end if;
    v_reg := jsonb_strip_nulls(jsonb_build_object(
               'id', v_facts -> 'lotCode', 'material', v_facts -> 'materialCode', 'status', v_facts -> 'status',
               'expiresAtUs', v_facts -> 'expiresAtUs', 'retestAtUs', v_facts -> 'retestAtUs', 'identityTested', v_facts -> 'identityTested'));
    if v_lot is distinct from v_reg then
      return format('lot %s states other facts than the lot register holds (%s)', v_lot ->> 'id', v_reg::text);
    end if;
  end if;
  return null;
end
$$;

create or replace function tab.state_entry_identifier_problem(p_entry jsonb, p_command jsonb, p_batch_number text) returns text
language plpgsql stable security definer set search_path = pg_catalog, tab, pg_temp as $$
declare
  v_data jsonb := case when jsonb_typeof(p_entry -> 'data') = 'object' then p_entry -> 'data' else '{}'::jsonb end;
begin
  -- The container id the output weighing generates from the batch's own number when the command names none.
  if p_entry ->> 'kind' = 'OUTPUT_CONTAINER' and not coalesce((p_command -> 'entry') ? 'container', false) and v_data ? 'container' then
    if jsonb_typeof(v_data -> 'container') is distinct from 'string' or p_batch_number is null
       or not starts_with(v_data ->> 'container', p_batch_number || '/') then
      return format('container %s is neither one the command named nor the id the system builds from the batch number %s',
                    left(coalesce(v_data ->> 'container', 'null'), 64), coalesce(p_batch_number, '(none)'));
    end if;
    v_data := v_data - 'container';
  end if;
  -- This slice: a disposal or sample naming the batch's own output container.
  if p_entry ->> 'kind' in ('DISPOSAL', 'SAMPLE') and jsonb_typeof(v_data -> 'container') = 'string' and p_batch_number is not null
     and tab.own_output_container((select b.id from recipe.batch_execution b where b.batch_number = p_batch_number), v_data ->> 'container') then
    v_data := v_data - 'container';
  end if;
  return tab.entry_identifier_problem(v_data || jsonb_build_object('kind', p_entry ->> 'kind'));
end
$$;

revoke all on function tab.own_output_container(uuid, text) from public;

reset role;
