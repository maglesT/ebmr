-- Phase 6 slice 6g: training mode's attempts, kept in the sandbox only (DI-05, INV-18; D-P6g-2, D-P6g-0-9).
--
-- Handbook: modules/kernel.md
--
-- Training is the sandbox installation (kernel 0800) with a training seed: the same screens against the separate
-- sandbox database, the sandbox login role, the TEST, NOT GMP band and watermark. The exercises are scripted in the
-- server; what a trainee did is recorded here, and only in a sandbox:
--   sandbox.training_attempt   one attempt of one exercise version by the person of the session.
--   sandbox.training_step      a step of an attempt marked done (once; a second mark is the same row).
-- Both tables exist in every database the kernel migrates; in a GMP database every insert is refused by a guard
-- trigger, whoever writes (the table owner included), and both are insert-only everywhere. The commands:
--   sandbox.start_training(exercise text, version integer, steps integer) returns uuid
--   sandbox.complete_training_step(attempt uuid, step integer) returns boolean (true when newly marked)
-- refuse in a GMP database (EBMR-SBX-039), and refuse a step outside the attempt or an attempt of another person
-- (EBMR-SBX-040). Error codes: EBMR-SBX-039, EBMR-SBX-040.

set local role ebmr_owner;

create table sandbox.training_attempt (
  id              uuid primary key default gen_random_uuid(),
  exercise_code   text not null check (exercise_code ~ '^[A-Z][A-Z0-9_-]{1,39}$'),
  exercise_version integer not null check (exercise_version >= 1),
  step_count      integer not null check (step_count between 1 and 50),
  person_id       uuid not null,
  account_id      uuid not null,
  started_at      timestamptz not null default clock_timestamp()
);
create table sandbox.training_step (
  attempt_id      uuid not null references sandbox.training_attempt (id),
  step_no         integer not null check (step_no >= 1),
  person_id       uuid not null,
  done_at         timestamptz not null default clock_timestamp(),
  primary key (attempt_id, step_no)
);
revoke all on sandbox.training_attempt, sandbox.training_step from public;
grant select on sandbox.training_attempt, sandbox.training_step to ebmr_app;

-- DI-05: no training state in a GMP database, whoever writes.
create function sandbox.training_sandbox_only() returns trigger
language plpgsql set search_path = pg_catalog, pg_temp as $$
begin
  if kernel.installation_kind() is distinct from 'SANDBOX' then
    raise exception using errcode = 'P0001',
      message = 'Training records are kept only in the sandbox installation, never in a GMP database (DI-05, INV-18). [EBMR-SBX-039]';
  end if;
  return new;
end
$$;
revoke all on function sandbox.training_sandbox_only() from public;
create trigger a0_sandbox_only before insert on sandbox.training_attempt for each row execute function sandbox.training_sandbox_only();
create trigger a0_sandbox_only before insert on sandbox.training_step for each row execute function sandbox.training_sandbox_only();
create trigger aa_insert_only before update or delete on sandbox.training_attempt for each row execute function kernel.reject_mutation();
create trigger aa_insert_only before update or delete on sandbox.training_step for each row execute function kernel.reject_mutation();
create trigger aa_no_truncate before truncate on sandbox.training_attempt for each statement execute function kernel.reject_mutation();
create trigger aa_no_truncate before truncate on sandbox.training_step for each statement execute function kernel.reject_mutation();

create function sandbox.start_training(p_exercise text, p_version integer, p_steps integer) returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, sandbox, iam, pg_temp as $$
declare
  v_ctx jsonb;
  v_id  uuid;
begin
  if kernel.installation_kind() is distinct from 'SANDBOX' then
    raise exception using errcode = 'P0001',
      message = 'Training runs only on the sandbox installation, never against a GMP database (DI-05, INV-18). [EBMR-SBX-039]';
  end if;
  v_ctx := iam.assert_validated_actor();
  insert into sandbox.training_attempt (exercise_code, exercise_version, step_count, person_id, account_id)
  values (p_exercise, p_version, p_steps, (v_ctx ->> 'person_id')::uuid, (v_ctx ->> 'account_id')::uuid)
  returning id into v_id;
  return v_id;
end
$$;

create function sandbox.complete_training_step(p_attempt uuid, p_step integer) returns boolean
language plpgsql volatile security definer set search_path = pg_catalog, sandbox, iam, pg_temp as $$
declare
  v_ctx jsonb;
  a     sandbox.training_attempt;
begin
  if kernel.installation_kind() is distinct from 'SANDBOX' then
    raise exception using errcode = 'P0001',
      message = 'Training runs only on the sandbox installation, never against a GMP database (DI-05, INV-18). [EBMR-SBX-039]';
  end if;
  v_ctx := iam.assert_validated_actor();
  select * into a from sandbox.training_attempt where id = p_attempt;
  if a.id is null or a.person_id <> (v_ctx ->> 'person_id')::uuid or p_step is null or p_step < 1 or p_step > a.step_count then
    raise exception using errcode = 'P0001',
      message = format('There is no step %s in a training attempt of yours with that id (DI-05). [EBMR-SBX-040]', coalesce(p_step::text, 'NULL'));
  end if;
  insert into sandbox.training_step (attempt_id, step_no, person_id) values (p_attempt, p_step, a.person_id)
  on conflict (attempt_id, step_no) do nothing;
  return found;
end
$$;
revoke all on function sandbox.start_training(text, integer, integer), sandbox.complete_training_step(uuid, integer) from public;
grant execute on function sandbox.start_training(text, integer, integer), sandbox.complete_training_step(uuid, integer) to ebmr_app;

reset role;
