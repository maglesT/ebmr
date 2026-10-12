-- Recipe core: three deviations on a step open a re-review task and pause review by exception for it (Phase 4 slice 1a;
-- PR-07 clause 2; outline 3.5 RBE, 7.3; plan default D-1a-5).
--
-- A deviation counts for a step when an exception the step raised in a GMP batch of the same master family was linked to
-- it (DEVIATION_LINKED) or escalated to it in review (ESCALATED). At the third distinct deviation the database opens one
-- re-review task for (family, step) and, from then on, the step's items are reviewed one by one: grouped acceptance of
-- one of them is refused (recipe.dispose_review_items, EBMR-REV-056) and the screens show the step as paused. Default
-- D-1a-5: the masters carry no per-step risk class yet, so every step is treated as low-risk (the stricter reading: the
-- pause can only take review by exception away). Closing a task (after the re-review) is not built: residual.

set local role ebmr_owner;

create table recipe.rbe_rereview_task (
  id              uuid primary key default gen_random_uuid(),
  family_id       uuid not null references recipe.mbr_family (id),
  step_id         text not null check (btrim(step_id) <> ''),
  deviation_refs  text[] not null check (cardinality(deviation_refs) >= 3),
  batch_id        uuid not null references recipe.batch_execution (id),
  opened_at       timestamptz not null default clock_timestamp(),
  unique (family_id, step_id)
);
revoke all on recipe.rbe_rereview_task from public;
select platform.enforce_db_time('recipe.rbe_rereview_task', array['opened_at']);
select kernel.register_audited_table('recipe.rbe_rereview_task', 'mbr_family', 'family_id', true);

create function recipe.rbe_step_deviations(p_family uuid, p_step text) returns text[]
language sql stable security definer set search_path = pg_catalog, recipe, pg_temp as $$
  select coalesce(array_agg(distinct a.deviation_ref order by a.deviation_ref), '{}')
    from recipe.exception_register r
    join recipe.stub_batch sb on sb.id = r.batch_id and sb.family_id = p_family
    join recipe.exception_register_act a on a.batch_id = r.batch_id and a.exception_id = r.exception_id and a.act in ('DEVIATION_LINKED', 'ESCALATED')
   where r.raising_step = p_step
$$;

create function recipe.rbe_paused_step(p_batch uuid) returns setof text
language sql stable security definer set search_path = pg_catalog, recipe, pg_temp as $$
  select t.step_id from recipe.rbe_rereview_task t join recipe.stub_batch sb on sb.family_id = t.family_id where sb.id = p_batch
$$;

create function recipe.rbe_deviation_counted() returns trigger
language plpgsql security definer set search_path = pg_catalog, recipe, pg_temp as $$
declare
  v_family uuid;
  v_step   text;
  v_refs   text[];
begin
  if new.act not in ('DEVIATION_LINKED', 'ESCALATED') then
    return null;
  end if;
  select sb.family_id, r.raising_step into v_family, v_step
    from recipe.exception_register r join recipe.stub_batch sb on sb.id = r.batch_id
   where r.batch_id = new.batch_id and r.exception_id = new.exception_id;
  if v_family is null or v_step is null then
    return null;
  end if;
  v_refs := recipe.rbe_step_deviations(v_family, v_step);
  if cardinality(v_refs) >= 3 then
    insert into recipe.rbe_rereview_task (family_id, step_id, deviation_refs, batch_id) values (v_family, v_step, v_refs, new.batch_id)
    on conflict (family_id, step_id) do nothing;
  end if;
  return null;
end
$$;

create trigger zzzp_rbe_deviation_counted after insert on recipe.exception_register_act for each row execute function recipe.rbe_deviation_counted();

revoke all on recipe.rbe_rereview_task from ebmr_app;
grant select on recipe.rbe_rereview_task to ebmr_app;
revoke all on function recipe.rbe_step_deviations(uuid, text), recipe.rbe_paused_step(uuid), recipe.rbe_deviation_counted() from public;
grant execute on function recipe.rbe_paused_step(uuid), recipe.rbe_step_deviations(uuid, text) to ebmr_app;

reset role;
