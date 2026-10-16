-- Phase 6 slice 6b quick review (finding Q-6b-1): the acknowledgment of a plant alarm (DI-49) checked ALARM.ACKNOWLEDGE
-- only in the scope of the first batch the occurrence is bound to. A room alarm binds every batch in the room
-- (D-P6b-0-4), which may be batches of other products: a person scoped to one product could give the disposition that
-- stands in another product's record. The right is now required in the scope of every bound batch (and without a
-- batch, unscoped as before). Everything else of plant.acknowledge_alarm (recipe-core 0960) is unchanged.
--
-- Handbook: modules/recipe-core.md

set local role ebmr_owner;

create or replace function plant.acknowledge_alarm(p_alarm uuid, p_action_taken text, p_comment text, p_deviation_ref text) returns void
language plpgsql volatile security definer set search_path = pg_catalog, plant, iam, site, pg_temp as $$
declare
  v_actor jsonb;
  a       plant.alarm;
  v_batch uuid;
  b       record;
  v_why   text;
begin
  perform iam.assert_not_administrator();
  select * into a from plant.alarm where id = p_alarm for update;
  if a.id is null then
    raise exception using errcode = 'P0001', message = format('EBMR-ALM-011 there is no plant alarm %s', coalesce(p_alarm::text, 'NULL'));
  end if;
  -- ALARM.ACKNOWLEDGE in the scope of every batch the occurrence is bound to (a room alarm may bind batches of several
  -- products): the disposition stands in each batch's record, so the person must hold the right in each.
  v_actor := iam.require_permission('ALARM.ACKNOWLEDGE', '{}'::jsonb);
  for v_batch in select ab.batch_id from plant.alarm_batch ab where ab.alarm_id = a.id order by ab.batch_id loop
    v_actor := iam.require_permission('ALARM.ACKNOWLEDGE', plant.batch_scope(v_batch));
  end loop;
  if v_actor ->> 'source' not in ('UI', 'API') then
    raise exception using errcode = 'P0001', message = 'EBMR-ALM-010 DI-49: an alarm is acknowledged by a person';
  end if;
  if exists (select 1 from plant.alarm_ack where alarm_id = a.id) then
    raise exception using errcode = 'P0001', message = format('EBMR-ALM-016 DI-49: alarm %s is already acknowledged', a.id);
  end if;
  if coalesce(btrim(p_action_taken), '') = '' then
    raise exception using errcode = 'P0001', message = 'EBMR-ALM-012 DI-49: an alarm is acknowledged with the action taken';
  end if;
  if a.gmp_critical and coalesce(btrim(p_comment), '') = '' then
    raise exception using errcode = 'P0001', message = format('EBMR-ALM-013 DI-49: alarm %s is GMP-critical; it is acknowledged only with a comment', a.alarm_code);
  end if;
  if a.deviation_required then
    if coalesce(btrim(p_deviation_ref), '') = '' then
      raise exception using errcode = 'P0001', message = format('EBMR-ALM-014 DI-49: alarm %s needs a deviation; cite its reference', a.alarm_code);
    end if;
    for b in select ab.batch_id from plant.alarm_batch ab where ab.alarm_id = a.id loop
      v_why := site.deviation_ref_problem(p_deviation_ref, 'LINK', b.batch_id);
      if v_why is not null then
        raise exception using errcode = 'P0001', message = format('EBMR-ALM-015 DI-49: the deviation %s', v_why);
      end if;
    end loop;
    if not exists (select 1 from plant.alarm_batch where alarm_id = a.id) and not exists (select 1 from site.deviation where ref = btrim(p_deviation_ref)) then
      raise exception using errcode = 'P0001', message = format('EBMR-ALM-015 DI-49: %s is not a deviation record of this installation', btrim(p_deviation_ref));
    end if;
  end if;
  insert into plant.alarm_ack (alarm_id, action_taken, comment, deviation_ref, person_id, account_id, session_id, role_code, correlation_id)
  values (a.id, btrim(p_action_taken), nullif(btrim(coalesce(p_comment, '')), ''), nullif(btrim(coalesce(p_deviation_ref, '')), ''),
          (v_actor ->> 'person_id')::uuid, (v_actor ->> 'account_id')::uuid, (v_actor ->> 'session_id')::uuid, v_actor ->> 'role_code',
          (v_actor ->> 'correlation_id')::uuid);
end
$$;

reset role;
