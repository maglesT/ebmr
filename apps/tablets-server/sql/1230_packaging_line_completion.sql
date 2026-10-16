-- Tablets, Phase 6 slice 6c: coding and label specimens, post-use inspection, vision line stops, reconciliation waiver
-- (IN-16, IN-31, PR-16, PR-34, PR-36, PR-39; defaults D-P6c-3 to D-P6c-9, D-P6c-16; ADR 0012: the rules hold when the
-- application's own database credentials are used directly).
--
-- Handbook: modules/tablets-server.md
--
--   tab.packaging_specimen        insert-only, audited: a CODING specimen (START, MIDDLE or END, with the coding read from
--                                 it) or a LABEL specimen (of one printed item) of a G-21 step of a packaging order,
--                                 recorded while the step is in progress (D-P6c-3: the step's performer and checker
--                                 signatures follow them, so the checker's signature is the check of the specimens).
--   tab.packaging_specimen_void   a specimen withdrawn with its reason, while its step is in progress (never deleted).
--   tab.g21_coding_applies(cfg)   the step codes on the line: a PRINTER device or an item flagged coded (D-P6c-4).
--   tab.g21_expected_coding(batch, key)   the coding a specimen must show: the step's current batch data (0951) when
--                                 there is one, else the batch number and recipe.batch_expiry's manufacture date and expiry
--                                 month; NULL when the record gives none yet (IN-31: the record's, never typed).
--   tab.record_coding_specimen(batch, key, position, coded)   STEP.EXECUTE. Refusals: EBMR-LBL-030 not a G-21 step in
--                                 progress; -031 the step does not code; -032 the position is out of order (START, then
--                                 MIDDLE, then END, once each) ; -033 the coding differs from the record's (named field);
--                                 -034 the record gives no coding yet; -035 the form.
--   tab.record_label_specimen(batch, key, item, note)   STEP.EXECUTE: one specimen per printed item of the step (-036).
--   tab.void_packaging_specimen(id, reason)   STEP.EXECUTE, step in progress, with a reason (-037).
--   tab.g21_specimen_problem(batch, key)   IN-16, PR-16: the first missing specimen of the step; NULL when complete.
--   tab.post_use_inspection, tab.post_use_inspection_verify   insert-only, audited (PR-34, D-P6c-6).
--   tab.record_post_use_inspection(batch, checks, note)   STEP.EXECUTE; only when every G-21 step of the order is
--                                 performed (printing ended, no step in progress) (-040 to -042).
--   tab.verify_post_use_inspection(id)   STEP.VERIFY, never the inspector (-043, -044); D-P6c-10: an attributed act.
--   tab.line_stop, tab.line_stop_resolution   insert-only, audited (PR-36, D-P6c-7). Trigger a6_tab_vision_line_stop on
--                                 tab.print_event (after insert): a FAULT EXPIRY_REJECTED or LINE_STOPPED on a job opens a
--                                 line stop for the job's step (one open stop per job).
--   tab.resolve_line_stop(id, reason)   QA.FLOOR_APPROVE, with a reason (-045, -046).
--   tab.reconciliation_waiver     insert-only, audited (PR-39, D-P6c-9): never switches the reconciliation off.
--   tab.enable_reconciliation_waiver(batch, key, item, device)   QA.FLOOR_APPROVE. Refusals -047 to -050: no
--                                 qualifying device (a VISION or READER device of the step, bound to the gateway of a job
--                                 of the step, with a passing challenge on such a job), an item not declared ROLL_LABEL or
--                                 CUT_LABEL with ELECTRONIC_100.
--   tab.packaging_completion_problem(batch)   PR-16, PR-34, PR-36: the first gap that blocks the order's completion: a G-21
--                                 step not performed or awaiting its checker's signature, a missing specimen, an open line
--                                 stop, no passing verified post-use inspection.
--   tab.packaging_completion_view(batch)   the labels.packaging view (contract ns/labels.ts).
--   Triggers on recipe.execution_state: zv_tab_g21_specimens (after update): a row that closes a G-21 step (to
--                                 AWAITING_VERIFICATION or COMPLETED) is refused while a specimen is missing or a line stop
--                                 is open (EBMR-LBL-060); a2_packaging_completion (before insert or update of status): EXECUTION_COMPLETE
--                                 of a batch with a G-21 step is refused while the completion problem stands (EBMR-LBL-061).
--   Trigger a6_tab_print_job_rules on tab.print_job (before insert): no job while a line stop of the step is open
--                                 (EBMR-LBL-062); when the master declares templates for the step, the job's layout is one of
--                                 them, APPROVED, and its fields carry every print field the template binds (EBMR-LBL-063,
--                                 D-P6c-16).
-- Messages EBMR-LBL-030 to EBMR-LBL-069.

set local role ebmr_owner;

-- ---------------------------------------------------------------------------------------------
-- Specimens

create table tab.packaging_specimen (
  id                  uuid primary key default gen_random_uuid(),
  batch_id            uuid not null references recipe.batch_execution (id),
  step_key            text not null check (btrim(step_key) <> ''),
  kind                text not null check (kind in ('CODING', 'LABEL')),
  position            text check (position in ('START', 'MIDDLE', 'END')),
  item                text check (item ~ '^[!-~]{1,64}$'),
  coded               jsonb check (coded is null or jsonb_typeof(coded) = 'object'),
  note                text check (note is null or btrim(note) <> ''),
  recorded_by_person  uuid not null,
  recorded_by_account uuid not null,
  recorded_at         timestamptz not null default clock_timestamp(),
  correlation_id      uuid not null,
  check ((kind = 'CODING') = (position is not null and coded is not null and item is null)),
  check ((kind = 'LABEL') = (item is not null and position is null and coded is null))
);
create index packaging_specimen_by_step on tab.packaging_specimen (batch_id, step_key, recorded_at);
revoke all on tab.packaging_specimen from public;
create trigger aa_packaging_specimen_insert_only before update or delete on tab.packaging_specimen for each row execute function kernel.reject_mutation();
create trigger aa_packaging_specimen_no_truncate before truncate on tab.packaging_specimen for each statement execute function kernel.reject_mutation();
create trigger a0_record_lock before insert or update or delete on tab.packaging_specimen for each row execute function recipe.refuse_locked_write('batch_id');
select platform.enforce_db_time('tab.packaging_specimen', array['recorded_at']);
select kernel.register_audited_table('tab.packaging_specimen', 'batch', 'batch_id', true);

create table tab.packaging_specimen_void (
  specimen_id       uuid primary key references tab.packaging_specimen (id),
  batch_id          uuid not null references recipe.batch_execution (id),
  reason            text not null check (btrim(reason) <> ''),
  voided_by_person  uuid not null,
  voided_by_account uuid not null,
  voided_at         timestamptz not null default clock_timestamp(),
  correlation_id    uuid not null
);
revoke all on tab.packaging_specimen_void from public;
create trigger aa_packaging_specimen_void_insert_only before update or delete on tab.packaging_specimen_void for each row execute function kernel.reject_mutation();
create trigger aa_packaging_specimen_void_no_truncate before truncate on tab.packaging_specimen_void for each statement execute function kernel.reject_mutation();
create trigger a0_record_lock before insert or update or delete on tab.packaging_specimen_void for each row execute function recipe.refuse_locked_write('batch_id');
select platform.enforce_db_time('tab.packaging_specimen_void', array['voided_at']);
select kernel.register_audited_table('tab.packaging_specimen_void', 'batch', 'batch_id', true);

-- The specimens of step p_key of batch p_batch that stand (not withdrawn).
create function tab.live_specimens(p_batch uuid, p_key text) returns setof tab.packaging_specimen
language sql stable security definer set search_path = pg_catalog, tab, pg_temp as $$
  select s.* from tab.packaging_specimen s
   where s.batch_id = p_batch and s.step_key = p_key and not exists (select 1 from tab.packaging_specimen_void v where v.specimen_id = s.id)
   order by s.recorded_at, s.id
$$;

-- D-P6c-4 (header).
create function tab.g21_coding_applies(p_cfg jsonb) returns boolean
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select exists (select 1 from jsonb_array_elements(case when jsonb_typeof(p_cfg -> 'devices') = 'array' then p_cfg -> 'devices' else '[]'::jsonb end) d where d ->> 'kind' = 'PRINTER')
      or exists (select 1 from jsonb_array_elements(case when jsonb_typeof(p_cfg -> 'items') = 'array' then p_cfg -> 'items' else '[]'::jsonb end) i where i -> 'coded' = 'true'::jsonb)
$$;

-- The ids of the printed items of step configuration p_cfg, in configuration order.
create function tab.g21_item_ids(p_cfg jsonb) returns text[]
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select coalesce(array_agg(i ->> 'id' order by n), '{}') from jsonb_array_elements(case when jsonb_typeof(p_cfg -> 'items') = 'array' then p_cfg -> 'items' else '[]'::jsonb end) with ordinality x (i, n)
   where jsonb_typeof(i -> 'id') = 'string'
$$;

-- IN-31, D-P6c-4 (header).
create function tab.g21_expected_coding(p_batch uuid, p_key text) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, tab, recipe, pg_temp as $$
declare
  v_data tab.packaging_batch_data := tab.current_batch_data(p_batch, p_key);
  v_exp  jsonb;
  v_num  text;
begin
  if v_data.id is not null then
    return jsonb_strip_nulls(jsonb_build_object('batch', v_data.fields -> 'batch', 'mfgDate', v_data.fields -> 'mfgDate', 'expiryDate', v_data.fields -> 'expiryDate', 'mrp', v_data.fields -> 'mrp'));
  end if;
  v_exp := recipe.batch_expiry(p_batch);
  select b.batch_number into v_num from recipe.batch_execution b where b.id = p_batch;
  if v_exp is null or v_num is null then
    return null;
  end if;
  return jsonb_build_object('batch', v_num, 'mfgDate', v_exp ->> 'manufactureDate', 'expiryDate', v_exp ->> 'expiryMonth');
end
$$;

-- The G-21 step instance p_key of batch p_batch with its node and configuration, in progress; refuses anything else.
create function tab.g21_specimen_step(p_batch uuid, p_key text) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, tab, recipe, pg_temp as $$
declare
  v_inst jsonb;
  v_node jsonb;
begin
  select st.state -> 'steps' -> p_key into v_inst from recipe.execution_state st where st.batch_id = p_batch;
  v_node := recipe.step_node(recipe.batch_mbr_content(p_batch), v_inst ->> 'step');
  if v_node is null or v_node -> 'block' ->> 'type' is distinct from 'G-21' or v_inst ->> 'status' is distinct from 'IN_PROGRESS' then
    raise exception using errcode = 'P0001',
      message = format('EBMR-LBL-030 %s is no printed-materials step (G-21) of this batch in progress: specimens are recorded while the step runs (D-P6c-3)', left(coalesce(p_key, 'NULL'), 120));
  end if;
  return jsonb_build_object('inst', v_inst, 'cfg', recipe.g21_cfg(v_node));
end
$$;

-- IN-16, IN-31 (header).
create function tab.record_coding_specimen(p_batch uuid, p_key text, p_position text, p_coded jsonb) returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, tab, recipe, iam, plant, pg_temp as $$
declare
  v_actor jsonb;
  v_step  jsonb;
  v_want  jsonb;
  v_have  text[];
  v_next  text;
  k       text;
  v_id    uuid;
begin
  perform iam.assert_not_administrator();
  v_actor := iam.require_permission('STEP.EXECUTE', plant.batch_scope(p_batch));
  v_step := tab.g21_specimen_step(p_batch, p_key);
  if not tab.g21_coding_applies(v_step -> 'cfg') then
    raise exception using errcode = 'P0001', message = format('EBMR-LBL-031 step %s does not code on the line (no printer, no coded item): it takes label specimens only (D-P6c-4)', p_key);
  end if;
  if p_position is null or p_position not in ('START', 'MIDDLE', 'END') or jsonb_typeof(p_coded) is distinct from 'object'
     or exists (select 1 from jsonb_object_keys(p_coded) x where x not in ('batch', 'mfgDate', 'expiryDate', 'mrp'))
     or exists (select 1 from jsonb_each(p_coded) x where jsonb_typeof(x.value) <> 'string' or length(x.value #>> '{}') not between 1 and 64) then
    raise exception using errcode = 'P0001', message = 'EBMR-LBL-035 a coding specimen is {position START, MIDDLE or END, coded {batch, mfgDate, expiryDate, mrp?} as read from the specimen}';
  end if;
  perform pg_advisory_xact_lock(hashtext('tab.packaging_specimen:' || p_batch || ':' || p_key));
  v_have := array(select s.position from tab.live_specimens(p_batch, p_key) s where s.kind = 'CODING');
  v_next := case when not ('START' = any (v_have)) then 'START' when not ('MIDDLE' = any (v_have)) then 'MIDDLE' when not ('END' = any (v_have)) then 'END' end;
  if v_next is distinct from p_position then
    raise exception using errcode = 'P0001',
      message = format('EBMR-LBL-032 the %s coding specimen is out of order: specimens are taken at the start, the middle and the end of the run, once each, and the next one is %s (IN-16)', p_position, coalesce(v_next, 'none (all three are recorded)'));
  end if;
  v_want := tab.g21_expected_coding(p_batch, p_key);
  if v_want is null then
    raise exception using errcode = 'P0001', message = 'EBMR-LBL-034 the record gives no coding for this step yet (no batch data and no expiry from the product master): record the batch data first (IN-31)';
  end if;
  for k in select x from unnest(array['batch', 'mfgDate', 'expiryDate', 'mrp']) x loop
    if (v_want -> k) is distinct from (p_coded -> k) then
      raise exception using errcode = 'P0001',
        message = format('EBMR-LBL-033 the specimen shows %s %s, the record %s: the coding on the line is not the record''s; stop and correct the coder (IN-16, IN-31)',
                         k, coalesce(left(p_coded ->> k, 64), 'nothing'), coalesce(v_want ->> k, 'nothing'));
    end if;
  end loop;
  insert into tab.packaging_specimen (batch_id, step_key, kind, position, coded, recorded_by_person, recorded_by_account, correlation_id)
  values (p_batch, p_key, 'CODING', p_position, p_coded, (v_actor ->> 'person_id')::uuid, (v_actor ->> 'account_id')::uuid, (v_actor ->> 'correlation_id')::uuid)
  returning id into v_id;
  return v_id;
end
$$;

-- PR-16 (header).
create function tab.record_label_specimen(p_batch uuid, p_key text, p_item text, p_note text) returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, tab, recipe, iam, plant, pg_temp as $$
declare
  v_actor jsonb;
  v_step  jsonb;
  v_id    uuid;
begin
  perform iam.assert_not_administrator();
  v_actor := iam.require_permission('STEP.EXECUTE', plant.batch_scope(p_batch));
  v_step := tab.g21_specimen_step(p_batch, p_key);
  if p_item is null or not (p_item = any (tab.g21_item_ids(v_step -> 'cfg'))) then
    raise exception using errcode = 'P0001', message = format('EBMR-LBL-036 %s is no printed item of step %s', left(coalesce(p_item, 'NULL'), 64), p_key);
  end if;
  if p_note is not null and (btrim(p_note) = '' or length(p_note) > 500) then
    raise exception using errcode = 'P0001', message = 'EBMR-LBL-035 a specimen note is 1 to 500 characters';
  end if;
  perform pg_advisory_xact_lock(hashtext('tab.packaging_specimen:' || p_batch || ':' || p_key));
  if exists (select 1 from tab.live_specimens(p_batch, p_key) s where s.kind = 'LABEL' and s.item = p_item) then
    raise exception using errcode = 'P0001', message = format('EBMR-LBL-036 item %s of step %s has its label specimen already; withdraw it first to replace it', p_item, p_key);
  end if;
  insert into tab.packaging_specimen (batch_id, step_key, kind, item, note, recorded_by_person, recorded_by_account, correlation_id)
  values (p_batch, p_key, 'LABEL', p_item, p_note, (v_actor ->> 'person_id')::uuid, (v_actor ->> 'account_id')::uuid, (v_actor ->> 'correlation_id')::uuid)
  returning id into v_id;
  return v_id;
end
$$;

-- (header)
create function tab.void_packaging_specimen(p_id uuid, p_reason text) returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, tab, recipe, iam, plant, pg_temp as $$
declare
  v_actor jsonb;
  s       tab.packaging_specimen;
begin
  perform iam.assert_not_administrator();
  select * into s from tab.packaging_specimen where id = p_id;
  if s.id is null then
    raise exception using errcode = 'P0001', message = format('EBMR-LBL-037 %s is no packaging specimen', coalesce(p_id::text, 'NULL'));
  end if;
  v_actor := iam.require_permission('STEP.EXECUTE', plant.batch_scope(s.batch_id));
  perform tab.g21_specimen_step(s.batch_id, s.step_key);
  if p_reason is null or btrim(p_reason) = '' or length(p_reason) > 2000 then
    raise exception using errcode = 'P0001', message = 'EBMR-LBL-037 a specimen is withdrawn with its reason';
  end if;
  if exists (select 1 from tab.packaging_specimen_void v where v.specimen_id = p_id) then
    raise exception using errcode = 'P0001', message = 'EBMR-LBL-037 the specimen is withdrawn already';
  end if;
  insert into tab.packaging_specimen_void (specimen_id, batch_id, reason, voided_by_person, voided_by_account, correlation_id)
  values (p_id, s.batch_id, btrim(p_reason), (v_actor ->> 'person_id')::uuid, (v_actor ->> 'account_id')::uuid, (v_actor ->> 'correlation_id')::uuid);
  return s.batch_id;
end
$$;

-- IN-16, PR-16 (header).
create function tab.g21_specimen_problem(p_batch uuid, p_key text) returns text
language plpgsql stable security definer set search_path = pg_catalog, tab, recipe, pg_temp as $$
declare
  v_inst jsonb;
  v_cfg  jsonb;
  p      text;
  i      text;
begin
  select st.state -> 'steps' -> p_key into v_inst from recipe.execution_state st where st.batch_id = p_batch;
  v_cfg := recipe.g21_cfg(recipe.step_node(recipe.batch_mbr_content(p_batch), v_inst ->> 'step'));
  if tab.g21_coding_applies(v_cfg) then
    foreach p in array array['START', 'MIDDLE', 'END'] loop
      if not exists (select 1 from tab.live_specimens(p_batch, p_key) s where s.kind = 'CODING' and s.position = p) then
        return format('step %s has no %s coding specimen (IN-16: start, middle and end)', p_key, p);
      end if;
    end loop;
  end if;
  foreach i in array tab.g21_item_ids(v_cfg) loop
    if not exists (select 1 from tab.live_specimens(p_batch, p_key) s where s.kind = 'LABEL' and s.item = i) then
      return format('step %s has no label specimen of item %s (PR-16)', p_key, i);
    end if;
  end loop;
  return null;
end
$$;

-- ---------------------------------------------------------------------------------------------
-- Post-use inspection (PR-34)

create table tab.post_use_inspection (
  id                  uuid primary key default gen_random_uuid(),
  batch_id            uuid not null references recipe.batch_execution (id),
  checks              jsonb not null check (jsonb_typeof(checks) = 'object'),
  passed              boolean not null,
  note                text check (note is null or btrim(note) <> ''),
  recorded_by_person  uuid not null,
  recorded_by_account uuid not null,
  recorded_at         timestamptz not null default clock_timestamp(),
  correlation_id      uuid not null
);
create index post_use_inspection_by_batch on tab.post_use_inspection (batch_id, recorded_at);
revoke all on tab.post_use_inspection from public;
create trigger aa_post_use_inspection_insert_only before update or delete on tab.post_use_inspection for each row execute function kernel.reject_mutation();
create trigger aa_post_use_inspection_no_truncate before truncate on tab.post_use_inspection for each statement execute function kernel.reject_mutation();
create trigger a0_record_lock before insert or update or delete on tab.post_use_inspection for each row execute function recipe.refuse_locked_write('batch_id');
select platform.enforce_db_time('tab.post_use_inspection', array['recorded_at']);
select kernel.register_audited_table('tab.post_use_inspection', 'batch', 'batch_id', true);

create table tab.post_use_inspection_verify (
  inspection_id       uuid primary key references tab.post_use_inspection (id),
  batch_id            uuid not null references recipe.batch_execution (id),
  verified_by_person  uuid not null,
  verified_by_account uuid not null,
  verified_at         timestamptz not null default clock_timestamp(),
  correlation_id      uuid not null
);
revoke all on tab.post_use_inspection_verify from public;
create trigger aa_post_use_inspection_verify_insert_only before update or delete on tab.post_use_inspection_verify for each row execute function kernel.reject_mutation();
create trigger aa_post_use_inspection_verify_no_truncate before truncate on tab.post_use_inspection_verify for each statement execute function kernel.reject_mutation();
create trigger a0_record_lock before insert or update or delete on tab.post_use_inspection_verify for each row execute function recipe.refuse_locked_write('batch_id');
select platform.enforce_db_time('tab.post_use_inspection_verify', array['verified_at']);
select kernel.register_audited_table('tab.post_use_inspection_verify', 'batch', 'batch_id', true);

-- The G-21 step instances of batch p_batch (key, instance), in key order.
create function tab.g21_steps_of(p_batch uuid) returns table (step_key text, inst jsonb, cfg jsonb)
language sql stable security definer set search_path = pg_catalog, tab, recipe, pg_temp as $$
  select x.key, x.value, recipe.g21_cfg(n.node)
    from recipe.execution_state st,
         lateral (select recipe.batch_mbr_content(st.batch_id) as c) m,
         jsonb_each(case when jsonb_typeof(st.state -> 'steps') = 'object' then st.state -> 'steps' else '{}'::jsonb end) x,
         lateral (select recipe.step_node(m.c, x.value ->> 'step') as node) n
   where st.batch_id = p_batch and n.node -> 'block' ->> 'type' = 'G-21'
   order by x.key
$$;

-- PR-34 (header).
create function tab.record_post_use_inspection(p_batch uuid, p_checks jsonb, p_note text) returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, tab, recipe, iam, plant, pg_temp as $$
declare
  v_actor jsonb;
  v_open  text;
  v_id    uuid;
begin
  perform iam.assert_not_administrator();
  v_actor := iam.require_permission('STEP.EXECUTE', plant.batch_scope(p_batch));
  if not exists (select 1 from tab.g21_steps_of(p_batch)) then
    raise exception using errcode = 'P0001', message = 'EBMR-LBL-040 this batch has no printed-materials step (G-21): the post-use inspection is of a packaging order''s line (PR-34)';
  end if;
  select g.step_key into v_open from tab.g21_steps_of(p_batch) g where g.inst ->> 'status' not in ('AWAITING_VERIFICATION', 'COMPLETED', 'NOT_APPLICABLE', 'SKIPPED') limit 1;
  if v_open is not null then
    raise exception using errcode = 'P0001',
      message = format('EBMR-LBL-041 step %s is not performed yet: the line is inspected after use, when printing and packing have ended (PR-34)', v_open);
  end if;
  if jsonb_typeof(p_checks) is distinct from 'object' or (select count(*) from jsonb_object_keys(p_checks)) <> 4
     or exists (select 1 from unnest(array['noPrintedMaterial', 'noProduct', 'noDocuments', 'lineClean']) k where jsonb_typeof(p_checks -> k) is distinct from 'boolean')
     or (p_note is not null and (btrim(p_note) = '' or length(p_note) > 1000)) then
    raise exception using errcode = 'P0001', message = 'EBMR-LBL-042 the post-use inspection answers noPrintedMaterial, noProduct, noDocuments and lineClean (true or false), with an optional note';
  end if;
  insert into tab.post_use_inspection (batch_id, checks, passed, note, recorded_by_person, recorded_by_account, correlation_id)
  values (p_batch, p_checks, not exists (select 1 from jsonb_each(p_checks) x where x.value = 'false'::jsonb), nullif(btrim(p_note), ''),
          (v_actor ->> 'person_id')::uuid, (v_actor ->> 'account_id')::uuid, (v_actor ->> 'correlation_id')::uuid)
  returning id into v_id;
  return v_id;
end
$$;

-- PR-34, D-P6c-10 (header).
create function tab.verify_post_use_inspection(p_id uuid) returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, tab, recipe, iam, plant, pg_temp as $$
declare
  v_actor jsonb;
  i       tab.post_use_inspection;
begin
  perform iam.assert_not_administrator();
  select * into i from tab.post_use_inspection where id = p_id for update;
  if i.id is null then
    raise exception using errcode = 'P0001', message = format('EBMR-LBL-043 %s is no post-use inspection', coalesce(p_id::text, 'NULL'));
  end if;
  v_actor := iam.require_permission('STEP.VERIFY', plant.batch_scope(i.batch_id));
  if i.recorded_by_person = (v_actor ->> 'person_id')::uuid then
    raise exception using errcode = 'P0001', message = 'EBMR-LBL-044 the post-use inspection is verified by another person than the one who inspected (PR-34)';
  end if;
  if exists (select 1 from tab.post_use_inspection_verify v where v.inspection_id = p_id) then
    raise exception using errcode = 'P0001', message = 'EBMR-LBL-043 the post-use inspection is verified already';
  end if;
  if exists (select 1 from tab.post_use_inspection n where n.batch_id = i.batch_id and (n.recorded_at, n.id) > (i.recorded_at, i.id)) then
    raise exception using errcode = 'P0001', message = 'EBMR-LBL-043 a later post-use inspection of the order stands: verify that one';
  end if;
  insert into tab.post_use_inspection_verify (inspection_id, batch_id, verified_by_person, verified_by_account, correlation_id)
  values (p_id, i.batch_id, (v_actor ->> 'person_id')::uuid, (v_actor ->> 'account_id')::uuid, (v_actor ->> 'correlation_id')::uuid);
  return i.batch_id;
end
$$;

-- ---------------------------------------------------------------------------------------------
-- Line stops (PR-36, D-P6c-7)

create table tab.line_stop (
  id              uuid primary key default gen_random_uuid(),
  batch_id        uuid not null references recipe.batch_execution (id),
  step_key        text not null,
  job_id          text not null references tab.print_job (id),
  event_id        uuid not null unique references tab.print_event (id),
  cause           text not null check (cause in ('EXPIRY_REJECTED', 'LINE_STOPPED')),
  opened_at       timestamptz not null default clock_timestamp(),
  correlation_id  uuid not null
);
create index line_stop_by_step on tab.line_stop (batch_id, step_key);
revoke all on tab.line_stop from public;
create trigger aa_line_stop_insert_only before update or delete on tab.line_stop for each row execute function kernel.reject_mutation();
create trigger aa_line_stop_no_truncate before truncate on tab.line_stop for each statement execute function kernel.reject_mutation();
select platform.enforce_db_time('tab.line_stop', array['opened_at']);
select kernel.register_audited_table('tab.line_stop', 'batch', 'batch_id', true);

create table tab.line_stop_resolution (
  stop_id             uuid primary key references tab.line_stop (id),
  batch_id            uuid not null references recipe.batch_execution (id),
  reason              text not null check (btrim(reason) <> ''),
  resolved_by_person  uuid not null,
  resolved_by_account uuid not null,
  resolved_at         timestamptz not null default clock_timestamp(),
  correlation_id      uuid not null
);
revoke all on tab.line_stop_resolution from public;
create trigger aa_line_stop_resolution_insert_only before update or delete on tab.line_stop_resolution for each row execute function kernel.reject_mutation();
create trigger aa_line_stop_resolution_no_truncate before truncate on tab.line_stop_resolution for each statement execute function kernel.reject_mutation();
create trigger a0_record_lock before insert or update or delete on tab.line_stop_resolution for each row execute function recipe.refuse_locked_write('batch_id');
select platform.enforce_db_time('tab.line_stop_resolution', array['resolved_at']);
select kernel.register_audited_table('tab.line_stop_resolution', 'batch', 'batch_id', true);

-- The open line stop of step p_key of batch p_batch (the earliest), or NULL.
create function tab.open_line_stop(p_batch uuid, p_key text) returns tab.line_stop
language sql stable security definer set search_path = pg_catalog, tab, pg_temp as $$
  select s from tab.line_stop s where s.batch_id = p_batch and s.step_key = p_key and not exists (select 1 from tab.line_stop_resolution r where r.stop_id = s.id)
   order by s.opened_at, s.id limit 1
$$;

-- D-P6c-7 (header): the print event row opens a line stop.
create function tab.vision_line_stop() returns trigger
language plpgsql security definer set search_path = pg_catalog, tab, kernel, pg_temp as $$
declare
  j tab.print_job;
begin
  if new.kind <> 'FAULT' or new.value not in ('EXPIRY_REJECTED', 'LINE_STOPPED') or new.job_id is null then
    return null;
  end if;
  select * into j from tab.print_job where id = new.job_id;
  if exists (select 1 from tab.line_stop s where s.job_id = j.id and not exists (select 1 from tab.line_stop_resolution r where r.stop_id = s.id)) then
    return null;
  end if;
  insert into tab.line_stop (batch_id, step_key, job_id, event_id, cause, correlation_id)
  values (j.batch_id, j.step_key, j.id, new.id, new.value, new.correlation_id);
  return null;
end
$$;
create trigger a6_tab_vision_line_stop after insert on tab.print_event for each row execute function tab.vision_line_stop();

-- PR-36 (header).
create function tab.resolve_line_stop(p_id uuid, p_reason text) returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, tab, iam, plant, pg_temp as $$
declare
  v_actor jsonb;
  s       tab.line_stop;
begin
  perform iam.assert_not_administrator();
  select * into s from tab.line_stop where id = p_id for update;
  if s.id is null then
    raise exception using errcode = 'P0001', message = format('EBMR-LBL-045 %s is no line stop', coalesce(p_id::text, 'NULL'));
  end if;
  v_actor := iam.require_permission('QA.FLOOR_APPROVE', plant.batch_scope(s.batch_id));
  if p_reason is null or btrim(p_reason) = '' or length(p_reason) > 2000 then
    raise exception using errcode = 'P0001', message = 'EBMR-LBL-046 QA resolves a line stop with its reason (what was found and corrected; PR-36)';
  end if;
  if exists (select 1 from tab.line_stop_resolution r where r.stop_id = p_id) then
    raise exception using errcode = 'P0001', message = 'EBMR-LBL-045 the line stop is resolved already';
  end if;
  insert into tab.line_stop_resolution (stop_id, batch_id, reason, resolved_by_person, resolved_by_account, correlation_id)
  values (p_id, s.batch_id, btrim(p_reason), (v_actor ->> 'person_id')::uuid, (v_actor ->> 'account_id')::uuid, (v_actor ->> 'correlation_id')::uuid);
  return s.batch_id;
end
$$;

-- ---------------------------------------------------------------------------------------------
-- The reconciliation waiver (PR-39, D-P6c-9)

create table tab.reconciliation_waiver (
  id                  uuid primary key default gen_random_uuid(),
  batch_id            uuid not null references recipe.batch_execution (id),
  step_key            text not null,
  item                text not null,
  device              text not null,
  device_serial       text not null,
  challenge_event_id  uuid not null references tab.print_event (id),
  form                text not null,
  option_211122g      text,
  recorded_by_person  uuid not null,
  recorded_by_account uuid not null,
  recorded_at         timestamptz not null default clock_timestamp(),
  correlation_id      uuid not null,
  unique (batch_id, step_key, item)
);
revoke all on tab.reconciliation_waiver from public;
create trigger aa_reconciliation_waiver_insert_only before update or delete on tab.reconciliation_waiver for each row execute function kernel.reject_mutation();
create trigger aa_reconciliation_waiver_no_truncate before truncate on tab.reconciliation_waiver for each statement execute function kernel.reject_mutation();
create trigger a0_record_lock before insert or update or delete on tab.reconciliation_waiver for each row execute function recipe.refuse_locked_write('batch_id');
select platform.enforce_db_time('tab.reconciliation_waiver', array['recorded_at']);
select kernel.register_audited_table('tab.reconciliation_waiver', 'batch', 'batch_id', true);

-- PR-39 (header).
create function tab.enable_reconciliation_waiver(p_batch uuid, p_key text, p_item text, p_device text) returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, tab, recipe, iam, plant, pg_temp as $$
declare
  v_actor jsonb;
  v_step  jsonb;
  v_dev   jsonb;
  l       recipe.packaging_labelling;
  ev      tab.print_event;
  v_id    uuid;
begin
  perform iam.assert_not_administrator();
  v_actor := iam.require_permission('QA.FLOOR_APPROVE', plant.batch_scope(p_batch));
  v_step := tab.g21_specimen_step(p_batch, p_key);
  if p_item is null or not (p_item = any (tab.g21_item_ids(v_step -> 'cfg'))) then
    raise exception using errcode = 'P0001', message = format('EBMR-LBL-047 %s is no printed item of step %s', left(coalesce(p_item, 'NULL'), 64), p_key);
  end if;
  v_dev := recipe.g21_cfg_member(v_step -> 'cfg', 'devices', to_jsonb(p_device));
  if v_dev is null or v_dev ->> 'kind' not in ('VISION', 'READER') or jsonb_typeof(v_dev -> 'serial') is distinct from 'string' then
    raise exception using errcode = 'P0001',
      message = format('EBMR-LBL-049 %s is no qualifying device: the waiver needs a vision system or code reader of the step with a gateway serial (PR-39)', left(coalesce(p_device, 'NULL'), 32));
  end if;
  -- A passing challenge of the device (by its serial) on a job of this step, from the gateway the device is bound to now.
  select e.* into ev from tab.print_event e
    join tab.print_job j on j.id = e.job_id
    join tab.print_device d on d.gateway_key_id = e.gateway_key_id and d.serial = e.serial and d.ended_at is null
   where j.batch_id = p_batch and j.step_key = p_key and e.serial = v_dev ->> 'serial' and e.kind = 'CHALLENGE_RESULT' and e.value = 'PASS'
   order by e.received_at desc, e.seq desc limit 1;
  if ev.id is null then
    raise exception using errcode = 'P0001',
      message = format('EBMR-LBL-050 device %s (%s) has no passing challenge on a print job of this step through its gateway: it does not qualify yet (PR-39)', p_device, v_dev ->> 'serial');
  end if;
  select * into l from recipe.batch_labelling(p_batch) x where x.step = v_step -> 'inst' ->> 'step' and x.item = p_item;
  if l.id is null or not (l.form = 'ROLL_LABEL' or (l.form = 'CUT_LABEL' and l.option_211122g = 'ELECTRONIC_100')) then
    raise exception using errcode = 'P0001',
      message = format('EBMR-LBL-048 item %s is not declared ROLL_LABEL, or CUT_LABEL with the 100 %% electronic inspection option, on the packaging master: the waiver is for those only (PR-39)', p_item);
  end if;
  insert into tab.reconciliation_waiver (batch_id, step_key, item, device, device_serial, challenge_event_id, form, option_211122g, recorded_by_person, recorded_by_account, correlation_id)
  values (p_batch, p_key, p_item, p_device, v_dev ->> 'serial', ev.id, l.form, l.option_211122g, (v_actor ->> 'person_id')::uuid, (v_actor ->> 'account_id')::uuid, (v_actor ->> 'correlation_id')::uuid)
  returning id into v_id;
  return v_id;
end
$$;

-- ---------------------------------------------------------------------------------------------
-- Completion (PR-16, PR-34, PR-36)

-- (header)
create function tab.packaging_completion_problem(p_batch uuid) returns text
language plpgsql stable security definer set search_path = pg_catalog, tab, recipe, pg_temp as $$
declare
  g    record;
  v_p  text;
  s    tab.line_stop;
  i    tab.post_use_inspection;
begin
  if not exists (select 1 from tab.g21_steps_of(p_batch)) then
    return null;
  end if;
  for g in select * from tab.g21_steps_of(p_batch) loop
    continue when g.inst ->> 'status' in ('NOT_APPLICABLE', 'SKIPPED');
    if g.inst ->> 'status' = 'AWAITING_VERIFICATION' then
      return format('step %s awaits its checker''s signature, which is the check of its specimens (PR-16)', g.step_key);
    end if;
    if g.inst ->> 'status' is distinct from 'COMPLETED' then
      return format('step %s is not performed', g.step_key);
    end if;
    v_p := tab.g21_specimen_problem(p_batch, g.step_key);
    if v_p is not null then
      return v_p;
    end if;
    s := tab.open_line_stop(p_batch, g.step_key);
    if s.id is not null then
      return format('step %s has an open line stop (%s on job %s) that QA has not resolved (PR-36)', g.step_key, s.cause, s.job_id);
    end if;
  end loop;
  select * into i from tab.post_use_inspection p where p.batch_id = p_batch order by p.recorded_at desc, p.id desc limit 1;
  if i.id is null then
    return 'the line has no post-use inspection (PR-34)';
  end if;
  if not i.passed then
    return 'the latest post-use inspection of the line did not pass: clear the line and inspect again (PR-34)';
  end if;
  if not exists (select 1 from tab.post_use_inspection_verify v where v.inspection_id = i.id) then
    return 'the post-use inspection is not verified by a second person (PR-34)';
  end if;
  return null;
end
$$;

-- D-P6c-5, D-P6c-7 (header): a row that closes a G-21 step.
create function tab.g21_specimen_close_check() returns trigger
language plpgsql security definer set search_path = pg_catalog, tab, recipe, pg_temp as $$
declare
  k    text;
  v_p  text;
  s    tab.line_stop;
begin
  for k in select x.key from jsonb_each(case when jsonb_typeof(new.state -> 'steps') = 'object' then new.state -> 'steps' else '{}'::jsonb end) x
            where x.value ->> 'status' in ('AWAITING_VERIFICATION', 'COMPLETED')
              and old.state -> 'steps' -> x.key ->> 'status' is distinct from 'AWAITING_VERIFICATION'
              and old.state -> 'steps' -> x.key ->> 'status' is distinct from 'COMPLETED'
            order by x.key loop
    continue when not exists (select 1 from tab.g21_steps_of(new.batch_id) g where g.step_key = k);
    v_p := tab.g21_specimen_problem(new.batch_id, k);
    if v_p is null then
      s := tab.open_line_stop(new.batch_id, k);
      if s.id is not null then
        v_p := format('step %s has an open line stop (%s on job %s) that QA has not resolved (PR-36)', k, s.cause, s.job_id);
      end if;
    end if;
    if v_p is not null then
      raise exception using errcode = 'P0001', message = format('EBMR-LBL-060 this row closes step %s, but %s', k, v_p);
    end if;
  end loop;
  return null;
end
$$;
create trigger zv_tab_g21_specimens after update on recipe.execution_state for each row execute function tab.g21_specimen_close_check();

-- PR-16, PR-34 (header).
create function tab.refuse_incomplete_packaging() returns trigger
language plpgsql security definer set search_path = pg_catalog, tab, pg_temp as $$
declare
  v_p text;
begin
  if new.status = 'EXECUTION_COMPLETE' and (tg_op = 'INSERT' or old.status is distinct from 'EXECUTION_COMPLETE') then
    v_p := tab.packaging_completion_problem(new.batch_id);
    if v_p is not null then
      raise exception using errcode = 'P0001', message = format('EBMR-LBL-061 the packaging order cannot complete: %s', v_p);
    end if;
  end if;
  return new;
end
$$;
create trigger a2_packaging_completion before insert or update of status on recipe.execution_state for each row execute function tab.refuse_incomplete_packaging();

-- PR-36, D-P6c-7, D-P6c-16 (header).
create function tab.print_job_rules() returns trigger
language plpgsql security definer set search_path = pg_catalog, tab, recipe, pg_temp as $$
declare
  s       tab.line_stop := tab.open_line_stop(new.batch_id, new.step_key);
  v_refs  text[];
  t       recipe.label_template;
  v_field text;
begin
  if s.id is not null then
    raise exception using errcode = 'P0001',
      message = format('EBMR-LBL-062 step %s has an open line stop (%s on job %s): no print job is released until QA resolves it (PR-36)', new.step_key, s.cause, s.job_id);
  end if;
  v_refs := array(select recipe.label_template_ref(l.template_id) from recipe.batch_labelling(new.batch_id) l where l.step = new.step and l.template_id is not null);
  if cardinality(v_refs) > 0 then
    select x.* into t from recipe.batch_labelling(new.batch_id) l join recipe.label_template x on x.id = l.template_id
     where l.step = new.step and recipe.label_template_ref(x.id) = new.layout_ref limit 1;
    if t.id is null or recipe.label_template_status(t.id) <> 'APPROVED' then
      raise exception using errcode = 'P0001',
        message = format('EBMR-LBL-063 layout %s is not an approved label template the packaging master names for step %s (%s) (D-P6c-16)', new.layout_ref, new.step, array_to_string(v_refs, ', '));
    end if;
    for v_field in select b.print_field from recipe.label_field_binding b
                    where b.code = any (t.fields) and b.print_field is not null loop
      if not (new.fields ? v_field) then
        raise exception using errcode = 'P0001',
          message = format('EBMR-LBL-063 template %s binds %s, which the job does not carry: the record holds no value for it on this step (D-P6c-16)', new.layout_ref, v_field);
      end if;
    end loop;
  end if;
  return new;
end
$$;
create trigger a6_tab_print_job_rules before insert on tab.print_job for each row execute function tab.print_job_rules();

-- The labels.packaging view (contract ns/labels.ts PackagingCompletionView).
create function tab.packaging_completion_view(p_batch uuid) returns jsonb
language sql stable security definer set search_path = pg_catalog, tab, recipe, iam, pg_temp as $$
  select jsonb_build_object(
    'batchId', b.id,
    'batchNumber', b.batch_number,
    'steps', coalesce((select jsonb_agg(jsonb_build_object(
        'stepKey', g.step_key,
        'status', g.inst ->> 'status',
        'coding', tab.g21_coding_applies(g.cfg),
        'expectedCoding', tab.g21_expected_coding(b.id, g.step_key),
        'codingSpecimens', coalesce((select jsonb_agg(jsonb_build_object('specimenId', s.id, 'position', s.position, 'coded', s.coded,
                                        'by', coalesce(iam.person_name_at(s.recorded_by_person, s.recorded_at), 'unknown person'), 'at', s.recorded_at) order by s.recorded_at)
                                      from tab.live_specimens(b.id, g.step_key) s where s.kind = 'CODING'), '[]'::jsonb),
        'labelSpecimens', coalesce((select jsonb_agg(jsonb_build_object('specimenId', s.id, 'item', s.item, 'note', s.note,
                                        'by', coalesce(iam.person_name_at(s.recorded_by_person, s.recorded_at), 'unknown person'), 'at', s.recorded_at) order by s.recorded_at)
                                      from tab.live_specimens(b.id, g.step_key) s where s.kind = 'LABEL'), '[]'::jsonb),
        'items', to_jsonb(tab.g21_item_ids(g.cfg)),
        'waivers', coalesce((select jsonb_agg(jsonb_build_object('waiverId', w.id, 'item', w.item, 'device', w.device,
                                        'by', coalesce(iam.person_name_at(w.recorded_by_person, w.recorded_at), 'unknown person'), 'at', w.recorded_at) order by w.recorded_at)
                               from tab.reconciliation_waiver w where w.batch_id = b.id and w.step_key = g.step_key), '[]'::jsonb),
        'problem', coalesce(tab.g21_specimen_problem(b.id, g.step_key),
                            (select format('step %s has an open line stop (%s on job %s) that QA has not resolved (PR-36)', g.step_key, s.cause, s.job_id)
                               from tab.line_stop s where s.batch_id = b.id and s.step_key = g.step_key
                                and not exists (select 1 from tab.line_stop_resolution r where r.stop_id = s.id) order by s.opened_at limit 1))
      ) order by g.step_key) from tab.g21_steps_of(b.id) g), '[]'::jsonb),
    'inspections', coalesce((select jsonb_agg(jsonb_build_object(
        'inspectionId', i.id, 'result', case when i.passed then 'PASS' else 'FAIL' end, 'checks', i.checks, 'note', i.note,
        'by', coalesce(iam.person_name_at(i.recorded_by_person, i.recorded_at), 'unknown person'),
        'verifiedBy', (select coalesce(iam.person_name_at(v.verified_by_person, v.verified_at), 'unknown person') from tab.post_use_inspection_verify v where v.inspection_id = i.id),
        'at', i.recorded_at) order by i.recorded_at) from tab.post_use_inspection i where i.batch_id = b.id), '[]'::jsonb),
    'lineStops', coalesce((select jsonb_agg(jsonb_build_object(
        'stopId', s.id, 'stepKey', s.step_key, 'jobId', s.job_id, 'cause', s.cause, 'openedAt', s.opened_at,
        'resolvedBy', (select coalesce(iam.person_name_at(r.resolved_by_person, r.resolved_at), 'unknown person') from tab.line_stop_resolution r where r.stop_id = s.id),
        'resolution', (select r.reason from tab.line_stop_resolution r where r.stop_id = s.id)) order by s.opened_at) from tab.line_stop s where s.batch_id = b.id), '[]'::jsonb),
    'completionProblem', tab.packaging_completion_problem(b.id))
  from recipe.batch_execution b where b.id = p_batch
$$;

revoke all on function tab.live_specimens(uuid, text), tab.g21_coding_applies(jsonb), tab.g21_item_ids(jsonb), tab.g21_expected_coding(uuid, text), tab.g21_specimen_step(uuid, text),
  tab.record_coding_specimen(uuid, text, text, jsonb), tab.record_label_specimen(uuid, text, text, text), tab.void_packaging_specimen(uuid, text), tab.g21_specimen_problem(uuid, text),
  tab.g21_steps_of(uuid), tab.record_post_use_inspection(uuid, jsonb, text), tab.verify_post_use_inspection(uuid), tab.open_line_stop(uuid, text), tab.vision_line_stop(),
  tab.resolve_line_stop(uuid, text), tab.enable_reconciliation_waiver(uuid, text, text, text), tab.packaging_completion_problem(uuid), tab.g21_specimen_close_check(),
  tab.refuse_incomplete_packaging(), tab.print_job_rules(), tab.packaging_completion_view(uuid) from public;
grant execute on function tab.g21_coding_applies(jsonb), tab.g21_expected_coding(uuid, text), tab.record_coding_specimen(uuid, text, text, jsonb), tab.record_label_specimen(uuid, text, text, text),
  tab.void_packaging_specimen(uuid, text), tab.g21_specimen_problem(uuid, text), tab.record_post_use_inspection(uuid, jsonb, text), tab.verify_post_use_inspection(uuid),
  tab.resolve_line_stop(uuid, text), tab.enable_reconciliation_waiver(uuid, text, text, text), tab.packaging_completion_problem(uuid), tab.packaging_completion_view(uuid) to ebmr_app;
grant select on tab.packaging_specimen, tab.packaging_specimen_void, tab.post_use_inspection, tab.post_use_inspection_verify, tab.line_stop, tab.line_stop_resolution,
  tab.reconciliation_waiver to ebmr_app;

reset role;
