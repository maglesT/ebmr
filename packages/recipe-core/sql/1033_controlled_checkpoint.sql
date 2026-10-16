-- Recipe core: the controlled-API account of a batch and its yield checkpoints (Phase 6 slice 6e; draft control IN-53;
-- defaults D-P6e-1, D-P6e-4, D-P6e-5; docs/build-plan/phase-6/slice-6e-0-interfaces.md).
--
-- Handbook: modules/recipe-core.md
--
-- The account of one controlled material in one batch (D-P6e-5):
--   dispensed (the consumptions, each under dual custody, 1032) = consumed into the product + in process (declared at the
--   checkpoint) + returned + destroyed (CONFIRMED RETURN and DESTRUCTION custody records) + difference.
-- Zero difference is exact decimal equality in the lot's unit, no tolerance (D-P6e-1).
--
--   recipe.controlled_balance(batch, material)       {materialCode, unit, dispensed, returned, destroyed}, decimal text.
--   recipe.controlled_checkpoint                     one account at one stage of the batch (the stage frame key, as a
--                                                    SIGN_OFF_STAGE names it): the figures, the difference and, for a
--                                                    difference other than zero, the explanation and the deviation linked
--                                                    to the batch. Insert-only, audited on the batch.
--   recipe.controlled_checkpoint_signature           CONTROLLED_BALANCE_SIGNED over one checkpoint, the latest of its stage
--                                                    and material, while the account has not moved since.
--   recipe.controlled_checkpoint_problem(batch, key) NULL when every controlled material with a movement into the batch has
--                                                    a signed checkpoint for the stage that is still current; else why not.
-- The guard (trigger a1_controlled_checkpoint, before insert on recipe.execution_command): an accepted SIGN_OFF_STAGE of a
-- batch is refused while that problem is not NULL (D-P6e-4: each stage sign-off is a yield checkpoint of the controlled
-- account). A batch with no controlled movement (an unflagged product, a test run) is unaffected.
-- Commands: recipe.record_controlled_checkpoint(p), recipe.sign_controlled_checkpoint(checkpoint, signature),
-- CONTROLLED.BALANCE, never an administrator. Signed aggregate: controlled_checkpoint <id>. Messages EBMR-CSM-030 to 049.

set local role ebmr_owner;

create table recipe.controlled_checkpoint (
  id                   uuid primary key default gen_random_uuid(),
  batch_id             uuid not null references recipe.batch_execution (id),
  stage_key            text not null check (stage_key ~ '^[!-~]{1,200}$'),
  material_code        text not null,
  unit                 text not null,
  dispensed            numeric not null check (dispensed >= 0),
  consumed             numeric not null check (consumed >= 0),
  in_process           numeric not null check (in_process >= 0),
  returned             numeric not null check (returned >= 0),
  destroyed            numeric not null check (destroyed >= 0),
  difference           numeric not null,
  explanation          text check (explanation is null or (btrim(explanation) <> '' and length(explanation) <= 4000)),
  deviation_id         uuid references site.deviation (id),
  recorded_by_person   uuid not null,
  recorded_by_account  uuid not null,
  recorded_at          timestamptz not null default clock_timestamp(),
  correlation_id       uuid not null,
  check (difference = dispensed - consumed - in_process - returned - destroyed),
  check (difference = 0 or (explanation is not null and deviation_id is not null))
);
create index controlled_checkpoint_key on recipe.controlled_checkpoint (batch_id, stage_key, material_code, recorded_at desc);

create table recipe.controlled_checkpoint_signature (
  checkpoint_id  uuid primary key references recipe.controlled_checkpoint (id),
  signature_id   uuid not null unique,
  person_id      uuid not null,
  account_id     uuid not null,
  recorded_at    timestamptz not null default clock_timestamp()
);

do $$
declare
  t text;
begin
  foreach t in array array['controlled_checkpoint', 'controlled_checkpoint_signature'] loop
    execute format('revoke all on recipe.%I from public', t);
    execute format('grant select on recipe.%I to ebmr_app', t);
  end loop;
end
$$;
select platform.enforce_db_time('recipe.controlled_checkpoint', array['recorded_at']);
select platform.enforce_db_time('recipe.controlled_checkpoint_signature', array['recorded_at']);
select kernel.register_audited_table('recipe.controlled_checkpoint', 'batch', 'batch_id', true);
select kernel.register_audited_table('recipe.controlled_checkpoint_signature', 'controlled_checkpoint', 'checkpoint_id', true);
create trigger zz_immutable before update or delete on recipe.controlled_checkpoint for each row execute function site.india_record_immutable();
create trigger zz_immutable before update or delete on recipe.controlled_checkpoint_signature for each row execute function site.india_record_immutable();

-- ---------------------------------------------------------------------------------------------
-- Reads
-- ---------------------------------------------------------------------------------------------

create function recipe.controlled_balance(p_batch uuid, p_material text) returns jsonb
language sql stable security definer set search_path = pg_catalog, recipe, site, pg_temp as $$
  with x as (select x.quantity, x.unit from site.lot_consumption x where x.batch_id = p_batch and x.material_code = p_material),
       c as (select c.kind, c.quantity, c.unit from recipe.controlled_custody c
              where c.batch_id = p_batch and c.material_code = p_material and c.kind in ('RETURN', 'DESTRUCTION')
                and recipe.controlled_custody_state(c.id) = 'CONFIRMED'),
       u as (select distinct unit from (select unit from x union all select unit from c) a)
  select jsonb_build_object('materialCode', p_material,
    'unit', case when (select count(*) from u) = 1 then (select unit from u) end,
    'units', coalesce((select jsonb_agg(unit order by unit) from u), '[]'::jsonb),
    'dispensed', coalesce((select sum(quantity) from x), 0)::text,
    'returned', coalesce((select sum(quantity) from c where kind = 'RETURN'), 0)::text,
    'destroyed', coalesce((select sum(quantity) from c where kind = 'DESTRUCTION'), 0)::text)
$$;

-- The controlled materials of the batch's product that have moved into the batch (a consumption or a custody record).
create function recipe.controlled_moved_materials(p_batch uuid) returns text[]
language sql stable security definer set search_path = pg_catalog, recipe, site, pg_temp as $$
  select coalesce(array_agg(m order by m), '{}') from unnest(recipe.batch_controlled_materials(p_batch)) m
   where exists (select 1 from site.lot_consumption x where x.batch_id = p_batch and x.material_code = m)
      or exists (select 1 from recipe.controlled_custody c where c.batch_id = p_batch and c.material_code = m)
$$;

create function recipe.controlled_checkpoint_state(p_checkpoint uuid) returns text
language sql stable security definer set search_path = pg_catalog, recipe, pg_temp as $$
  select case when exists (select 1 from recipe.controlled_checkpoint_signature s where s.checkpoint_id = k.id) then 'SIGNED'
              when exists (select 1 from recipe.controlled_checkpoint l where l.batch_id = k.batch_id and l.stage_key = k.stage_key
                                                                         and l.material_code = k.material_code and (l.recorded_at, l.id) > (k.recorded_at, k.id)) then 'SUPERSEDED'
              else 'RECORDED' end
    from recipe.controlled_checkpoint k where k.id = p_checkpoint
$$;

-- The checkpoint's figures from the records still the ones it recorded (the account has not moved since).
create function recipe.controlled_checkpoint_current(p_checkpoint uuid) returns boolean
language sql stable security definer set search_path = pg_catalog, recipe, pg_temp as $$
  select coalesce((select b ->> 'unit' = k.unit and (b ->> 'dispensed')::numeric = k.dispensed and (b ->> 'returned')::numeric = k.returned
                          and (b ->> 'destroyed')::numeric = k.destroyed
                     from recipe.controlled_checkpoint k, recipe.controlled_balance(k.batch_id, k.material_code) b where k.id = p_checkpoint), false)
$$;

create function recipe.controlled_checkpoint_problem(p_batch uuid, p_stage_key text) returns text
language plpgsql stable security definer set search_path = pg_catalog, recipe, pg_temp as $$
declare
  m text;
  k recipe.controlled_checkpoint;
begin
  foreach m in array recipe.controlled_moved_materials(p_batch) loop
    select * into k from recipe.controlled_checkpoint x where x.batch_id = p_batch and x.stage_key = p_stage_key and x.material_code = m
     order by x.recorded_at desc, x.id desc limit 1;
    if k.id is null then
      return format('the account of controlled API %s has no checkpoint at stage %s', m, p_stage_key);
    end if;
    if recipe.controlled_checkpoint_state(k.id) <> 'SIGNED' then
      return format('the account of controlled API %s at stage %s is recorded but not signed', m, p_stage_key);
    end if;
    if not recipe.controlled_checkpoint_current(k.id) then
      return format('the account of controlled API %s has moved since its checkpoint at stage %s was signed; record and sign it again', m, p_stage_key);
    end if;
  end loop;
  return null;
end
$$;

-- ---------------------------------------------------------------------------------------------
-- Signed content
-- ---------------------------------------------------------------------------------------------

create function recipe.controlled_checkpoint_content(p_id text) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, recipe, site, pg_temp as $$
declare
  k recipe.controlled_checkpoint;
  b recipe.batch_execution;
begin
  if coalesce(p_id, '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return '{"exists": false}'::jsonb;
  end if;
  select * into k from recipe.controlled_checkpoint where id = p_id::uuid;
  if k.id is null then
    return '{"exists": false}'::jsonb;
  end if;
  select * into b from recipe.batch_execution where id = k.batch_id;
  return jsonb_build_object('exists', true, 'content_version', 1,
    'content', jsonb_build_object('title', format('Controlled API %s of batch %s at %s', k.material_code, b.batch_number, k.stage_key),
                                  'batch_id', k.batch_id, 'batch_number', b.batch_number, 'stage_key', k.stage_key, 'material_code', k.material_code,
                                  'unit', k.unit, 'dispensed', k.dispensed::text, 'consumed', k.consumed::text, 'in_process', k.in_process::text,
                                  'returned', k.returned::text, 'destroyed', k.destroyed::text, 'difference', k.difference::text,
                                  'explanation', k.explanation, 'deviation_id', k.deviation_id,
                                  'deviation_ref', (select d.ref from site.deviation d where d.id = k.deviation_id),
                                  'recorded_by', k.recorded_by_person, 'recorded_at', site.utc_text(k.recorded_at),
                                  'status_note', 'Draft control IN-53: NDPS Act and Rules not verified'),
    'state', recipe.controlled_checkpoint_state(k.id),
    'scope', jsonb_build_object('product', recipe.batch_product(k.batch_id) ->> 'code', 'site', b.site_code),
    'entered_by', jsonb_build_array(k.recorded_by_person));
end
$$;

select esig.register_content_provider('controlled_checkpoint', 'recipe.controlled_checkpoint_content(text)',
  'The controlled-API account of a batch at a yield checkpoint, with the explanation and deviation of any difference (IN-53, draft)');

-- ---------------------------------------------------------------------------------------------
-- Commands
-- ---------------------------------------------------------------------------------------------

-- p: {batchId, stageKey, materialCode, consumed, inProcess (decimal text), explanation?, deviationId?}.
create function recipe.record_controlled_checkpoint(p jsonb) returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, recipe, site, iam, pg_temp as $$
declare
  v_ctx   jsonb;
  b       recipe.batch_execution;
  v_bal   jsonb;
  v_dec   text := '^(0|[1-9][0-9]{0,11})(\.[0-9]{1,6})?$';
  v_cons  numeric;
  v_inp   numeric;
  v_diff  numeric;
  v_dev   uuid;
  v_id    uuid;
begin
  perform iam.assert_not_administrator();
  if p is null or coalesce(p ->> 'batchId', '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    raise exception using errcode = 'P0001', message = 'EBMR-CSM-030 a checkpoint names its batch';
  end if;
  select * into b from recipe.batch_execution where id = (p ->> 'batchId')::uuid;
  if b.id is null then
    raise exception using errcode = 'P0001', message = format('EBMR-CSM-030 unknown batch %s', p ->> 'batchId');
  end if;
  v_ctx := iam.require_permission('CONTROLLED.BALANCE', jsonb_build_object('site', b.site_code, 'product', recipe.batch_product(b.id) ->> 'code'));
  if coalesce(p ->> 'stageKey', '') !~ '^[!-~]{1,200}$' then
    raise exception using errcode = 'P0001', message = 'EBMR-CSM-031 a checkpoint names the stage (its frame key, as the stage sign-off names it)';
  end if;
  if not (coalesce(p ->> 'materialCode', '') = any (recipe.batch_controlled_materials(b.id))) then
    raise exception using errcode = 'P0001',
      message = format('EBMR-CSM-032 %s is not a controlled material of the product of batch %s (IN-53)', coalesce(p ->> 'materialCode', 'NULL'), b.batch_number);
  end if;
  if coalesce(p ->> 'consumed', '') !~ v_dec or coalesce(p ->> 'inProcess', '') !~ v_dec then
    raise exception using errcode = 'P0001', message = 'EBMR-CSM-033 the quantity consumed into the product and the quantity in process are decimals of zero or more';
  end if;
  perform pg_advisory_xact_lock(hashtext('recipe.controlled_checkpoint'), hashtext(b.id::text || '/' || (p ->> 'materialCode')));
  v_bal := recipe.controlled_balance(b.id, p ->> 'materialCode');
  if v_bal ->> 'unit' is null then
    raise exception using errcode = 'P0001',
      message = format('EBMR-CSM-034 the account of %s in batch %s is kept in one unit; it holds %s (IN-53)', p ->> 'materialCode', b.batch_number,
                       case when jsonb_array_length(v_bal -> 'units') = 0 then 'no movement' else (v_bal -> 'units')::text end);
  end if;
  v_cons := (p ->> 'consumed')::numeric;
  v_inp := (p ->> 'inProcess')::numeric;
  v_diff := (v_bal ->> 'dispensed')::numeric - v_cons - v_inp - (v_bal ->> 'returned')::numeric - (v_bal ->> 'destroyed')::numeric;
  if v_diff <> 0 then
    if coalesce(btrim(p ->> 'explanation'), '') = '' or coalesce(p ->> 'deviationId', '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      raise exception using errcode = 'P0001',
        message = format('EBMR-CSM-035 the account of controlled API %s in batch %s does not close: dispensed %s, consumed %s, in process %s, returned %s, destroyed %s leave a difference of %s %s. A yield checkpoint with an unexplained difference is refused: explain it and link the deviation raised for it (IN-53, D-P6e-1)',
                         p ->> 'materialCode', b.batch_number, v_bal ->> 'dispensed', v_cons, v_inp, v_bal ->> 'returned', v_bal ->> 'destroyed', v_diff, v_bal ->> 'unit');
    end if;
    v_dev := (p ->> 'deviationId')::uuid;
    if not exists (select 1 from site.deviation_link k where k.deviation_id = v_dev and k.batch_id = b.id) then
      raise exception using errcode = 'P0001',
        message = format('EBMR-CSM-036 the deviation named is not linked to batch %s; a difference is explained with a deviation of the batch (IN-53)', b.batch_number);
    end if;
  elsif p ? 'deviationId' or p ? 'explanation' then
    if coalesce(btrim(p ->> 'explanation'), '') = '' and p ? 'explanation' then
      raise exception using errcode = 'P0001', message = 'EBMR-CSM-037 an explanation, when given, is not blank';
    end if;
    if p ? 'deviationId' then
      raise exception using errcode = 'P0001', message = 'EBMR-CSM-037 the account closes with no difference: it names no deviation';
    end if;
  end if;
  insert into recipe.controlled_checkpoint (batch_id, stage_key, material_code, unit, dispensed, consumed, in_process, returned, destroyed, difference,
                                            explanation, deviation_id, recorded_by_person, recorded_by_account, correlation_id)
  values (b.id, p ->> 'stageKey', p ->> 'materialCode', v_bal ->> 'unit', (v_bal ->> 'dispensed')::numeric, v_cons, v_inp, (v_bal ->> 'returned')::numeric,
          (v_bal ->> 'destroyed')::numeric, v_diff, nullif(btrim(coalesce(p ->> 'explanation', '')), ''), v_dev,
          (v_ctx ->> 'person_id')::uuid, (v_ctx ->> 'account_id')::uuid, (v_ctx ->> 'correlation_id')::uuid)
  returning id into v_id;
  perform recipe.bump_epoch('BATCH', b.id);
  return v_id;
end
$$;

create function recipe.sign_controlled_checkpoint(p_checkpoint uuid, p_signature uuid) returns void
language plpgsql volatile security definer set search_path = pg_catalog, recipe, esig, iam, pg_temp as $$
declare
  v_ctx  jsonb;
  k      recipe.controlled_checkpoint;
  v_prob text;
begin
  perform iam.assert_not_administrator();
  select * into k from recipe.controlled_checkpoint where id = p_checkpoint;
  if k.id is null then
    raise exception using errcode = 'P0001', message = format('EBMR-CSM-038 unknown checkpoint %s', coalesce(p_checkpoint::text, 'NULL'));
  end if;
  v_ctx := iam.require_permission('CONTROLLED.BALANCE', jsonb_build_object('site', (select b.site_code from recipe.batch_execution b where b.id = k.batch_id),
                                                                           'product', recipe.batch_product(k.batch_id) ->> 'code'));
  perform pg_advisory_xact_lock(hashtext('recipe.controlled_checkpoint'), hashtext(k.batch_id::text || '/' || k.material_code));
  if recipe.controlled_checkpoint_state(k.id) <> 'RECORDED' then
    raise exception using errcode = 'P0001', message = format('EBMR-CSM-039 this checkpoint is %s; only the latest of its stage and material is signed, once', recipe.controlled_checkpoint_state(k.id));
  end if;
  if not recipe.controlled_checkpoint_current(k.id) then
    raise exception using errcode = 'P0001', message = 'EBMR-CSM-040 the account has moved since this checkpoint was recorded; record it again (IN-53)';
  end if;
  perform esig.assert_signature(p_signature, 'CONTROLLED_BALANCE_SIGNED', 'controlled_checkpoint', k.id::text);
  v_prob := esig.signature_state_problem(p_signature);
  if v_prob is not null then
    raise exception using errcode = 'P0001', message = 'EBMR-CSM-041 ' || v_prob;
  end if;
  if (select g.signer_person from esig.signature g where g.id = p_signature)::text is distinct from v_ctx ->> 'person_id' then
    raise exception using errcode = 'P0001', message = 'EBMR-CSM-041 the checkpoint is signed by the person recording the signature';
  end if;
  insert into recipe.controlled_checkpoint_signature (checkpoint_id, signature_id, person_id, account_id)
  values (k.id, p_signature, (v_ctx ->> 'person_id')::uuid, (v_ctx ->> 'account_id')::uuid);
  perform recipe.bump_epoch('BATCH', k.batch_id);
end
$$;

-- ---------------------------------------------------------------------------------------------
-- The stage sign-off guard
-- ---------------------------------------------------------------------------------------------

create function recipe.controlled_sign_off_guard() returns trigger
language plpgsql security definer set search_path = pg_catalog, recipe, pg_temp as $$
declare
  v_key  text;
  v_prob text;
begin
  if new.kind is distinct from 'COMMAND' or new.accepted is not true or new.command_type is distinct from 'SIGN_OFF_STAGE' then
    return new;
  end if;
  if cardinality(recipe.controlled_moved_materials(new.batch_id)) = 0 then
    return new;
  end if;
  v_key := (new.command ->> 'stage') || '@' || recipe.ctx_key(coalesce(new.command -> 'context', '[]'::jsonb));
  v_prob := recipe.controlled_checkpoint_problem(new.batch_id, v_key);
  if v_prob is not null then
    raise exception using errcode = 'P0001',
      message = format('EBMR-CSM-042 stage %s is a yield checkpoint of the controlled API account and is not signed off: %s (IN-53, D-P6e-4)', v_key, v_prob);
  end if;
  return new;
end
$$;
create trigger a1_controlled_checkpoint before insert on recipe.execution_command for each row execute function recipe.controlled_sign_off_guard();

revoke all on function recipe.controlled_balance(uuid, text), recipe.controlled_moved_materials(uuid), recipe.controlled_checkpoint_state(uuid),
  recipe.controlled_checkpoint_current(uuid), recipe.controlled_checkpoint_problem(uuid, text), recipe.controlled_checkpoint_content(text),
  recipe.record_controlled_checkpoint(jsonb), recipe.sign_controlled_checkpoint(uuid, uuid), recipe.controlled_sign_off_guard() from public;
grant execute on function recipe.controlled_balance(uuid, text), recipe.controlled_moved_materials(uuid), recipe.controlled_checkpoint_state(uuid),
  recipe.controlled_checkpoint_current(uuid), recipe.controlled_checkpoint_problem(uuid, text), recipe.record_controlled_checkpoint(jsonb),
  recipe.sign_controlled_checkpoint(uuid, uuid) to ebmr_app;

reset role;
