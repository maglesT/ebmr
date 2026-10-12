-- Plant, output containers: QA releases a held container only once what held it is explained (Phase 4 slice 1b; Phase 3
-- exit review backlog, medium; controls L-30, TB-11, INV-41, PR-49; DI-30 for the typed net of 0740).
--
-- The RELEASE of a held or sorted container (machine output_container, OUTPUT_CONTAINER_RELEASED) was tied to nothing but
-- QA's signature: a container could be released while the exception its hold raised was still open, or while the
-- deviation linked to that exception was still under investigation. From this migration the database refuses the release
-- unless, for every hold of the container:
--   * the hold's exceptions are dispositioned (INV-41: only a disposition closes an exception). The hold's exceptions are
--     those of the batch's exception register raised at the step that recorded the hold's check (the step key is the second
--     part of the check's reference, `<block>:<step key>:...`, as every block writes it); when the reference names no step of
--     the batch's register (a print job, a tooling hold), every exception of the batch counts (stricter). Only exceptions
--     that need a deviation, block release or are above the ALERT severity count;
--   * every deviation linked to one of them (DEVIATION_LINKED, or ESCALATED in review) names a deviation-lite record whose
--     investigation is concluded: CONCLUDED (PENDING_CLOSURE once slice 2 renames it) or CLOSED. OPEN, UNDER_INVESTIGATION,
--     CANCELLED or a reference that names no record refuse (default D-1b-2, stricter);
--   * a MISSED hold the sweeper's alarm recorded (reference `...:OVERDUE:...`) has its missed-check exception on the step,
--     raised at or after the hold: until the step's next entry records it, the hold is not explained;
-- and the container's typed net, if any, is verified by a second person (0740).
--
--   * plant.container_release_problem(container): the reason the container cannot be released now, or NULL (readable by the
--     application role, so screens show it before QA signs);
--   * plant.guard_container_release (trigger zz_container_release on platform.state_history, before insert, for a RELEASE
--     of an output container): raises the problem. platform.transition writes the history row of every state change, so the
--     rule holds for plant.release_container and for platform.transition called directly alike (ADR 0012).
--
-- Messages: EBMR-CNT-050 to 053. Owned by ebmr_owner, pg_temp last (ADR 0016). Applied as a new migration because applied
-- migrations are checksummed and never edited.

set local role ebmr_owner;

create function plant.container_release_problem(p_container uuid) returns text
language plpgsql stable security definer set search_path = pg_catalog, plant, recipe, site, pg_temp as $$
declare
  c       plant.output_container;
  h       record;
  x       record;
  v_step  text;
  v_known boolean;
  v_dev   text;
  v_state text;
begin
  select * into c from plant.output_container where id = p_container;
  if not found then
    return 'the output container does not exist (EBMR-CNT-030)';
  end if;
  if plant.container_net_unverified(c.id) then
    return format('the typed net quantity of container %s has not been verified by a second person (DI-30; EBMR-CNT-050)', c.label_code);
  end if;
  for h in
    select k.id, k.result, k.reference, k.recorded_at from plant.container_hold ch join plant.ipc_check k on k.id = ch.ipc_check_id
     where ch.container_id = c.id order by ch.recorded_at, ch.id
  loop
    v_step := nullif(split_part(h.reference, ':', 2), '');
    v_known := v_step is not null and exists (select 1 from recipe.exception_register r where r.batch_id = c.batch_id and r.raising_step_key = v_step);
    if h.result = 'MISSED' and h.reference like '%:OVERDUE:%'
       and not exists (select 1 from recipe.exception_register r
                        where r.batch_id = c.batch_id and r.raising_step_key = v_step and r.exception_type like '%MISSED%' and r.raised_at >= h.recorded_at) then
      return format('container %s is held for a check the alarm found missed (%s); the step has not recorded the missed check yet, so the hold is not explained (L-30, TB-11; EBMR-CNT-051)',
                    c.label_code, h.reference);
    end if;
    for x in
      select r.exception_id, r.exception_type, r.raising_step_key from recipe.exception_register r
       where r.batch_id = c.batch_id and (not v_known or r.raising_step_key = v_step)
         and (r.deviation_required or r.release_blocking or r.severity <> 'ALERT')
       order by r.raised_at, r.exception_id
    loop
      if not exists (select 1 from recipe.exception_register_act a where a.batch_id = c.batch_id and a.exception_id = x.exception_id and a.act = 'DISPOSITIONED') then
        return format('container %s is held (%s) and exception %s (%s) of step %s is still open; it is released once the exception is dispositioned (INV-41, L-30; EBMR-CNT-052)',
                      c.label_code, h.reference, x.exception_id, x.exception_type, coalesce(x.raising_step_key, '(batch)'));
      end if;
      for v_dev in
        select distinct a.deviation_ref from recipe.exception_register_act a
         where a.batch_id = c.batch_id and a.exception_id = x.exception_id and a.act in ('DEVIATION_LINKED', 'ESCALATED') and a.deviation_ref is not null
         order by a.deviation_ref
      loop
        v_state := (select site.deviation_state(d.id) from site.deviation d where d.ref = v_dev);
        if v_state is null or v_state not in ('CONCLUDED', 'PENDING_CLOSURE', 'CLOSED') then
          return format('container %s is held (%s) and deviation %s linked to exception %s is %s; it is released once the investigation is concluded (PR-49, L-30; EBMR-CNT-053)',
                        c.label_code, h.reference, v_dev, x.exception_id, coalesce(v_state, 'not a deviation record'));
        end if;
      end loop;
    end loop;
  end loop;
  return null;
end
$$;

create function plant.guard_container_release() returns trigger
language plpgsql security definer set search_path = pg_catalog, plant, pg_temp as $$
declare
  v_problem text;
begin
  v_problem := plant.container_release_problem(new.aggregate_id);
  if v_problem is not null then
    raise exception using errcode = 'P0001', message = format('The container cannot be released: %s', v_problem);
  end if;
  return new;
end
$$;
create trigger zz_container_release before insert on platform.state_history
  for each row when (new.aggregate_type = 'output_container' and new.event = 'RELEASE')
  execute function plant.guard_container_release();

revoke all on function plant.container_release_problem(uuid), plant.guard_container_release() from public;
grant execute on function plant.container_release_problem(uuid) to ebmr_app;

reset role;
