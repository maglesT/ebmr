-- Phase 6 slice 6b (builder B): the plant rules and the alarm log where a step starts and is signed, and in review
-- (DI-49, PR-15, PR-25, PR-27, PR-29; DI-26; ADR 0012: the rules hold for every writer of the execution store).
--
-- Handbook: modules/recipe-core.md
--
--   plant.step_rules_problem(row)   null, or why an accepted person's command of a step may not be written:
--       START_STEP      in the room of the terminal (the step's room, DI-20): a spill or a clean hold run out
--                       (plant.room_start_problem, PR-25, PR-27: EBMR-PLANT-150, EBMR-PLANT-151)
--       START_STEP, SIGN_PERFORMED, VERIFY   in a controlled area (plant.area_rule authorisation_required): the person
--                       holds a current area authorisation (kernel 1190; PR-15: EBMR-PLANT-180)
--       SIGN_PERFORMED  no GMP-critical alarm bound to the batch and the step awaits its acknowledgment
--                       (plant.alarm_problem, DI-49: EBMR-ALM-020)
--     trigger ad_plant_step_rules on recipe.execution_command (before insert; COMMAND rows that are accepted).
--   plant.reagent_use (insert-only, audited) and plant.record_reagent_use(batch, step, lot_code, purpose): the
--       reagent or buffer lot an in-process control of a step used (STEP.EXECUTE in the batch's scope, a person; the
--       step is a step of the batch's MBR); an expired, withdrawn or unknown lot is refused (site.reagent_lot_problem;
--       PR-29: EBMR-PLANT-190, EBMR-PLANT-191).
--   plant.batch_alarm_review_problems(batch): each alarm bound to the batch that has no disposition (acknowledgment)
--   recipe.review_gate_problems: CREATE OR REPLACE from 0721 with those problems added to the production approval and
--       the QA review (DI-49: the batch's alarm log is part of its review; DI-26).
--
-- Messages: EBMR-PLANT-180, EBMR-PLANT-190, EBMR-PLANT-191 (and EBMR-ALM-020, EBMR-PLANT-150, EBMR-PLANT-151 raised here).

set local role ebmr_owner;

-- ---------------------------------------------------------------------------------------------
-- Step start and signature
-- ---------------------------------------------------------------------------------------------

create function plant.step_rules_problem(p_batch uuid, p_type text, p_step text, p_room text, p_person uuid, p_at timestamptz) returns text
language plpgsql stable security definer set search_path = pg_catalog, plant, iam, pg_temp as $$
declare
  a       plant.area;
  r       plant.area_rule_current;
  v_prob  text;
begin
  if p_room is not null then
    select * into a from plant.area where code = p_room;
  end if;
  if a.id is not null then
    if p_type = 'START_STEP' then
      v_prob := plant.room_start_problem(a.id, p_batch, p_at);
      if v_prob is not null then
        return v_prob;
      end if;
    end if;
    select * into r from plant.area_rule_current where area_id = a.id;
    if p_type in ('START_STEP', 'SIGN_PERFORMED', 'VERIFY') and coalesce(r.authorisation_required, false) then
      v_prob := iam.area_authorisation_problem(p_person, a.code, p_at);
      if v_prob is not null then
        return format('EBMR-PLANT-180 %s is a controlled area: %s (PR-15)', a.code, v_prob);
      end if;
    end if;
  end if;
  if p_type = 'SIGN_PERFORMED' then
    return plant.alarm_problem(p_batch, p_step);
  end if;
  return null;
end
$$;

create function plant.step_rules_check() returns trigger
language plpgsql security definer set search_path = pg_catalog, plant, pg_temp as $$
declare
  v_problem text;
begin
  if new.kind <> 'COMMAND' or new.accepted is not true or new.command_type not in ('START_STEP', 'SIGN_PERFORMED', 'VERIFY') then
    return new;
  end if;
  v_problem := plant.step_rules_problem(new.batch_id, new.command_type, new.command ->> 'step', new.room_code, new.actor_person, clock_timestamp());
  if v_problem is not null then
    raise exception using errcode = 'P0001', message = v_problem;
  end if;
  return new;
end
$$;
create trigger ad_plant_step_rules before insert on recipe.execution_command for each row execute function plant.step_rules_check();

-- ---------------------------------------------------------------------------------------------
-- Reagents at an in-process control (PR-29)
-- ---------------------------------------------------------------------------------------------

create table plant.reagent_use (
  id              uuid primary key default gen_random_uuid(),
  batch_id        uuid not null references recipe.batch_execution (id),
  step            text not null check (btrim(step) <> '' and length(step) <= 200),
  reagent_lot_id  uuid not null references site.reagent_lot (id),
  purpose         text not null check (btrim(purpose) <> '' and length(purpose) <= 200),
  person_id       uuid not null,
  account_id      uuid not null,
  correlation_id  uuid not null,
  used_at         timestamptz not null default clock_timestamp()
);
create index reagent_use_by_batch on plant.reagent_use (batch_id, step);
revoke all on plant.reagent_use from public;
select platform.enforce_db_time('plant.reagent_use', array['used_at']);
select kernel.register_audited_table('plant.reagent_use', 'reagent_lot', 'reagent_lot_id', true);

create function plant.record_reagent_use(p_batch uuid, p_step text, p_lot_code text, p_purpose text) returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, plant, iam, site, recipe, pg_temp as $$
declare
  v_actor jsonb;
  v_prob  text;
  v_id    uuid;
begin
  perform iam.assert_not_administrator();
  v_actor := iam.require_permission('STEP.EXECUTE', plant.batch_scope(p_batch));
  if v_actor ->> 'source' not in ('UI', 'API') or coalesce(btrim(p_purpose), '') = ''
     or recipe.step_node(recipe.batch_mbr_content(p_batch), split_part(coalesce(p_step, ''), '@', 1)) is null then
    raise exception using errcode = 'P0001',
      message = format('EBMR-PLANT-190 a person records the reagent or buffer a step of the batch used, with its purpose; %s is no step of this batch (PR-29)', coalesce(p_step, 'NULL'));
  end if;
  v_prob := site.reagent_lot_problem(p_lot_code, clock_timestamp());
  if v_prob is not null then
    raise exception using errcode = 'P0001', message = format('EBMR-PLANT-191 the reagent is refused at step %s: %s', p_step, v_prob);
  end if;
  insert into plant.reagent_use (batch_id, step, reagent_lot_id, purpose, person_id, account_id, correlation_id)
  values (p_batch, p_step, (select id from site.reagent_lot where lot_code = p_lot_code), btrim(p_purpose),
          (v_actor ->> 'person_id')::uuid, (v_actor ->> 'account_id')::uuid, (v_actor ->> 'correlation_id')::uuid)
  returning id into v_id;
  return v_id;
end
$$;

-- ---------------------------------------------------------------------------------------------
-- The alarm log in review (DI-49, DI-26)
-- ---------------------------------------------------------------------------------------------

create function plant.batch_alarm_review_problems(p_batch uuid) returns text[]
language sql stable security definer set search_path = pg_catalog, plant, pg_temp as $$
  select coalesce(array_agg(format('alarm %s (%s, %s) of the batch''s alarm log has no disposition: it is acknowledged with the action taken first (DI-49, DI-26)',
                                   l.occurrence_id, l.alarm_code, case when l.gmp_critical then 'GMP-critical' else 'not GMP-critical' end)
                            order by l.raised_source_us, l.id), '{}')
  from plant.batch_alarm_log l where l.batch_id = p_batch and l.acked_at is null
$$;

create or replace function recipe.review_gate_problems(p_batch uuid, p_act text) returns text[]
language plpgsql stable security definer set search_path = pg_catalog, recipe, plant, site, pg_temp as $$
declare
  v_state text := recipe.batch_review_state(p_batch);
  v_out   text[] := '{}';
  r       recipe.exception_register;
  c       plant.output_container;
  v_st    text;
  l       recipe.batch_review_act;
begin
  perform recipe.review_batch(p_batch);
  case p_act
    when 'PRODUCTION_APPROVE' then
      if v_state is distinct from 'EXECUTION_COMPLETE' and v_state is distinct from 'ABORTED' then
        v_out := v_out || format('the record is %s; production approval follows EXECUTION_COMPLETE or ABORTED (PR-16, L-20)', coalesce(v_state, 'without a stored state'));
      end if;
      for r in select * from recipe.exception_register x where x.batch_id = p_batch order by x.exception_id loop
        if not exists (select 1 from recipe.exception_register_act a where a.batch_id = p_batch and a.exception_id = r.exception_id
                        and a.act in ('DISPOSITIONED', 'DEVIATION_LINKED')) then
          v_out := v_out || format('exception %s (%s) is neither dispositioned nor raised as a deviation (PR-52)', r.exception_id, r.title);
        end if;
      end loop;
      if v_state = 'ABORTED' then
        if not exists (select 1 from recipe.abort_checklist k where k.batch_id = p_batch) then
          v_out := v_out || 'the abort checklist is not recorded: materials, outputs, equipment, genealogy, contingency forms (L-20)'::text;
        end if;
        for c in select * from plant.output_container x where x.batch_id = p_batch order by x.label_code loop
          if plant.container_usable_problem(c.id) is null then
            v_out := v_out || format('output container %s of the aborted batch is still usable; QA holds or rejects it first (L-20)', c.label_code);
          end if;
        end loop;
      end if;
      v_out := v_out || recipe.free_text_problems(p_batch);
      v_out := v_out || plant.batch_alarm_review_problems(p_batch);
    when 'AUDIT_TRAIL_REVIEW' then
      if v_state is distinct from 'PRODUCTION_APPROVED' and v_state is distinct from 'QA_REVIEWED' then
        v_out := v_out || format('the record is %s; the audit-trail review follows the production approval (DI-25, S8)', coalesce(v_state, 'without a stored state'));
      elsif recipe.audit_review_covered(p_batch) then
        v_out := v_out || 'the audit trail is reviewed up to its last in-scope event; there is nothing to review (INV-48)'::text;
      end if;
    when 'QA_REVIEW' then
      if v_state is distinct from 'PRODUCTION_APPROVED' then
        v_out := v_out || format('the record is %s; QA review follows production approval and is given once per review cycle (INV-30, S8)', coalesce(v_state, 'without a stored state'));
      end if;
      for r in select * from recipe.exception_register x where x.batch_id = p_batch order by x.exception_id loop
        v_st := recipe.review_item_status(p_batch, r.exception_id);
        if v_st not in ('ACCEPTED', 'ESCALATED') then
          v_out := v_out || format('exception %s is not concluded in review (it is %s) (PR-52, DI-26)', r.exception_id, v_st);
        elsif v_st = 'ESCALATED' and site.deviation_ref_problem(
                (select a.deviation_ref from recipe.exception_register_act a where a.batch_id = p_batch and a.exception_id = r.exception_id
                    and a.act = 'ESCALATED' and a.recorded_at > recipe.review_cycle_start(p_batch) order by a.id desc limit 1), 'LINK', p_batch) is not null then
          v_out := v_out || format('exception %s is escalated to a deviation that is not linked to the batch (PR-49, PR-52)', r.exception_id);
        end if;
      end loop;
      v_out := v_out || plant.batch_alarm_review_problems(p_batch);
      l := recipe.audit_review_last(p_batch);
      if l.id is null then
        v_out := v_out || format('the audit-trail review of review cycle %s is not signed (DI-25)', recipe.batch_review_cycle(p_batch));
      elsif not recipe.audit_review_covered(p_batch) then
        v_out := v_out || 'audit events in scope were recorded after the review''s high-water mark; a delta review is due (INV-48)'::text;
      end if;
    when 'REOPEN' then
      if v_state is distinct from 'PRODUCTION_APPROVED' and v_state is distinct from 'QA_REVIEWED' then
        v_out := v_out || format('the record is %s; only a record in review (PRODUCTION_APPROVED or QA_REVIEWED) is reopened (L-09)', coalesce(v_state, 'without a stored state'));
      end if;
    else
      raise exception using errcode = 'P0001', message = format('EBMR-REV-001 %s is not a review act', coalesce(p_act, 'NULL'));
  end case;
  return v_out;
end
$$;

revoke all on function plant.step_rules_problem(uuid, text, text, text, uuid, timestamptz), plant.step_rules_check(),
  plant.record_reagent_use(uuid, text, text, text), plant.batch_alarm_review_problems(uuid) from public;
grant select on plant.reagent_use to ebmr_app;
grant execute on function plant.step_rules_problem(uuid, text, text, text, uuid, timestamptz), plant.record_reagent_use(uuid, text, text, text),
  plant.batch_alarm_review_problems(uuid) to ebmr_app;

reset role;
