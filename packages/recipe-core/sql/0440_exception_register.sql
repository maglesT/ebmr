-- Recipe core, execution store (module C3): the exception register in the database (Phase 3 slice 2, plan item 1;
-- outline 5.2.4; PR-08, PR-13, DI-26 register part, INV-41, INV-03; ADR 0012: the rules hold when the application's own
-- database credentials are used directly).
--
-- Until now an exception lived only in the engine state JSON (recipe.execution_state.state -> 'exceptions'), checked row
-- by row against the state before it (0270 check_exception_changes, 0298, 0305, 0306, 0308, 0315, 0327). This migration
-- gives every exception an insert-only register row, written in the same transaction as the engine row that raises it,
-- and every later act on it (deviation link, disposition, QA review) a new insert-only act row:
--
--   1. recipe.exception_review_category: the review-by-exception categories (engine ReviewCategory). Every category the
--      engine and the blocks raise is in it and is mandatory (DI-26: a mandatory type cannot be switched off; the
--      rows are insert-only, so no later change can switch one off). A category the catalogue does not hold is refused.
--      Default taken (stricter): TIME_LIMIT and FLOW are mandatory too, although DI-26's list names them only as
--      alarm and time-sync events.
--   2. recipe.exception_register: one row per exception (batch, the engine's exception id, type, category, severity,
--      limit tier or none, raising step, the DB time and engine time of the row that raised it, the engine's raiser
--      and the person who gave that command, the mandatory, QA-only, deviation-required, registration-relevant and
--      release-blocking flags, what lifts its block, and the record exactly as raised).
--   3. recipe.exception_register_act: DEVIATION_LINKED and DISPOSITIONED (written with the engine row that does them),
--      and the QA review acts QUERIED, RESPONDED, ACCEPTED_BY_QA and ESCALATED (to a deviation reference; D-S2-2,
--      deviations are linked by reference only until slice 5), written by recipe.review_exception.
--   4. The sync (trigger zzr_exception_register on recipe.execution_state, after insert or update, so on every ISSUE,
--      COMMAND, PREPARE and SWEEP row): the register follows the state, and the state may not leave the register:
--        * an exception the row adds gets its register row (EBMR-EXE-161 when it arrives already linked or closed);
--        * an exception keeps the facts it was raised with, compared with the register's copy, not only with the
--          state before (EBMR-EXE-160); none is ever taken out of the state, and the state holds no register row's
--          exception less, nor any exception of the state before without its register row (EBMR-EXE-160);
--        * a deviation link appears only with an accepted ATTACH_DEVIATION of that exception by the linker, and never
--          changes after (EBMR-EXE-161);
--        * an exception closes only by its disposition (INV-41): DISPOSITIONED appears only with an accepted
--          DISPOSITION_EXCEPTION of that exception, by the row's person, under one of the row's signatures, and never
--          changes or reopens after (EBMR-EXE-161); a correction, an invalidation or any other row never closes one;
--        * a QA-only exception (limit tier REGISTERED or VALIDATED, DECISION_AFFECTING_CORRECTION, or flagged qaOnly)
--          is dispositioned only by a person whose verified engine roles on the row include one of the batch policy's
--          QA roles (EBMR-EXE-162; PR-08, PR-13);
--        * the disposer is outside the involvement set of the raising step (performers, data enterers, correctors and
--          PERFORMED signers, from the stored lists and the accepted rows, recipe.exception_step_involvement of 0315)
--          and is not the raiser (EBMR-EXE-163; INV-03, PR-13). 0306/0310 already refuse it before the row; this is
--          the register's own copy of the rule.
--   5. recipe.review_exception: the QA review of an exception (review by exception, DI-26): QUERIED by QA, RESPONDED by
--      production to an open query (not by the querier), ACCEPTED_BY_QA of a dispositioned exception with no open query,
--      ESCALATED to a deviation reference; the reviewer who accepts or escalates is outside the involvement set and is
--      neither the raiser nor the disposer (EBMR-EXE-164, EBMR-EXE-165). A review never closes an exception: only its
--      disposition does (INV-41). Review acts are attributed, not signed: the QA review signature of the batch record
--      is Phase 4 (D-S2-3).
--   6. recipe.exception_register_review: the read view of the register for review by exception (one row per exception
--      with its status, link, disposition, review state and whether it still blocks).
--
-- Action tier (PR-08). The block an INTERNAL_ACTION breach puts on the measuring step and the steps after it (or, with
-- the MBR's CONTINUE_CURRENT_STEP_WITH_DEVIATION, on the steps after it only) until a deviation is linked is already
-- refused in the database for START_STEP, completing SIGN_PERFORMED and VERIFY (0308, EBMR-EXE-131). The register now
-- also freezes the block as raised (item 4), so the block cannot be dropped from the state to lift it.
--
-- Execution stays sandbox-only (D-S2-1): recipe.review_exception refuses a GMP installation through
-- recipe.execution_actor. Existing test batches are back-filled from their stored state and events.
--
-- New tables are owned by ebmr_owner, audited on the batch chain, insert-only, on database time, readable by the
-- application role and written only by the SECURITY DEFINER functions here. Every function pins its search_path with
-- pg_temp last. Applied as a new migration because applied migrations are checksummed and never edited.

set local role ebmr_owner;

-- ---------------------------------------------------------------------------------------------
-- 1. Review categories (DI-26 mandatory set)
-- ---------------------------------------------------------------------------------------------

create table recipe.exception_review_category (
  category     text primary key check (category ~ '^[A-Z][A-Z_]{1,39}$'),
  mandatory    boolean not null,
  description  text not null check (btrim(description) <> '')
);
revoke all on recipe.exception_review_category from public;

select kernel.set_actor_context(jsonb_build_object(
  'person_id', '00000000-0000-0000-0000-000000000000', 'account_id', '00000000-0000-0000-0000-000000000000',
  'role_code', 'SOFTWARE_RELEASE', 'session_id', '00000000-0000-0000-0000-000000000000', 'source', 'SYSTEM',
  'site_zone', 'UTC', 'correlation_id', gen_random_uuid(),
  'legal_name', 'Software release (recipe-core migration 0440_exception_register)',
  'reason_code', 'SOFTWARE_RELEASE',
  'reason_text', 'exception register and its mandatory review categories (DI-26, PR-08, INV-41)'));

select kernel.register_audited_table('recipe.exception_review_category', 'exception_review_category', 'category', true);

insert into recipe.exception_review_category (category, mandatory, description) values
  ('OUT_OF_LIMIT', true, 'Out-of-limit values (limit tiers, yields, acceptance criteria, calculations)'),
  ('DEVIATION_OR_OVERRIDE', true, 'Deviations, overrides and exceptions raised by a person'),
  ('FORCED_SKIPPED_NA', true, 'Forced, skipped or not-applicable steps'),
  ('POST_ENTRY_CHANGE', true, 'Post-entry changes, voids and invalidations'),
  ('REPEAT_OR_ABORTED', true, 'Repeats and aborted attempts'),
  ('LATE_ENTRY', true, 'Late or back-entered data'),
  ('MANUAL_ENTRY', true, 'Manual entry where automatic capture was configured'),
  ('INTERFACE_FALLBACK', true, 'Interface fallbacks and failures'),
  ('TIME_LIMIT', true, 'Time limits and alarm events'),
  ('FLOW', true, 'Flow exceptions (loops, replicate counts, undecidable decisions)'),
  ('TIME_SYNC', true, 'Time-sync events');

-- ---------------------------------------------------------------------------------------------
-- 2. The register and its acts
-- ---------------------------------------------------------------------------------------------

create table recipe.exception_register (
  batch_id               uuid not null references recipe.batch_execution (id),
  exception_id           text not null check (btrim(exception_id) <> ''),
  row_seq                bigint not null,
  exception_type         text not null check (btrim(exception_type) <> ''),
  category               text not null references recipe.exception_review_category (category),
  severity               text not null check (severity in ('ALERT', 'ACTION', 'CRITICAL')),
  tier                   text check (tier in ('REGISTERED', 'VALIDATED', 'INTERNAL_ACTION', 'ALERT')),
  title                  text not null,
  raising_step_key       text,
  raising_step           text,
  raised_at              timestamptz not null,
  raised_at_us           bigint not null,
  raised_by              text not null,
  command_person         uuid not null,
  mandatory              boolean not null,
  qa_only                boolean not null,
  deviation_required     boolean not null,
  registration_relevant  boolean not null,
  release_blocking       boolean not null,
  blocks_until           text check (blocks_until in ('DEVIATION', 'DISPOSITION')),
  raised_record          jsonb not null check (jsonb_typeof(raised_record) = 'object'),
  correlation_id         uuid not null,
  recorded_at            timestamptz not null default clock_timestamp(),
  primary key (batch_id, exception_id),
  foreign key (batch_id, row_seq) references recipe.execution_command (batch_id, seq),
  check (not (tier in ('REGISTERED', 'VALIDATED')) or qa_only),
  check (exception_type <> 'DECISION_AFFECTING_CORRECTION' or qa_only)
);
revoke all on recipe.exception_register from public;
comment on table recipe.exception_register is 'Exception register (outline 5.2.4; DI-26, PR-08, INV-41): one insert-only row per exception, written with the engine row that raised it';

create table recipe.exception_register_act (
  id              bigint generated always as identity primary key,
  batch_id        uuid not null,
  exception_id    text not null,
  act             text not null check (act in ('DEVIATION_LINKED', 'DISPOSITIONED', 'QUERIED', 'RESPONDED', 'ACCEPTED_BY_QA', 'ESCALATED')),
  row_seq         bigint,
  by_person       uuid not null,
  by_account      uuid not null,
  role_code       text not null,
  outcome         text check (outcome in ('NO_IMPACT', 'DEVIATION_RAISED')),
  signature_id    uuid,
  deviation_ref   text,
  note            text,
  correlation_id  uuid not null,
  recorded_at     timestamptz not null default clock_timestamp(),
  foreign key (batch_id, exception_id) references recipe.exception_register (batch_id, exception_id),
  foreign key (batch_id, row_seq) references recipe.execution_command (batch_id, seq),
  check ((act in ('DEVIATION_LINKED', 'DISPOSITIONED')) = (row_seq is not null)),
  check ((act = 'DISPOSITIONED') = (outcome is not null)),
  check ((act = 'DISPOSITIONED') = (signature_id is not null)),
  check ((act in ('DEVIATION_LINKED', 'ESCALATED')) = (deviation_ref is not null and btrim(deviation_ref) <> '')),
  check (act not in ('QUERIED', 'RESPONDED', 'ESCALATED', 'DISPOSITIONED') or (note is not null and btrim(note) <> ''))
);
revoke all on recipe.exception_register_act from public;
comment on table recipe.exception_register_act is 'Acts on a registered exception (deviation link, disposition, QA review): insert-only, one row per act';
create unique index exception_register_act_one_link on recipe.exception_register_act (batch_id, exception_id) where act = 'DEVIATION_LINKED';
create unique index exception_register_act_one_disposition on recipe.exception_register_act (batch_id, exception_id) where act = 'DISPOSITIONED';
create unique index exception_register_act_one_conclusion on recipe.exception_register_act (batch_id, exception_id) where act in ('ACCEPTED_BY_QA', 'ESCALATED');
create index exception_register_act_exception on recipe.exception_register_act (batch_id, exception_id, id);

select kernel.register_audited_table('recipe.exception_register', 'batch', 'batch_id', true);
select kernel.register_audited_table('recipe.exception_register_act', 'batch', 'batch_id', true);
select platform.enforce_db_time('recipe.exception_register', array['recorded_at']);
select platform.enforce_db_time('recipe.exception_register_act', array['recorded_at']);

-- ---------------------------------------------------------------------------------------------
-- 3. Helpers (owner only)
-- ---------------------------------------------------------------------------------------------

-- An exception record without the members its acts change (status, disposition, deviation): the facts it was raised with.
create function recipe.exception_as_raised(p jsonb) returns jsonb
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select p - 'status' - 'disposition' - 'deviation'
$$;

-- PR-08, PR-13, INV-41: true when only QA may disposition the exception (limit tier REGISTERED or VALIDATED, a
-- correction that would have changed a decision taken, or the engine's qaOnly flag).
create function recipe.exception_qa_only(p jsonb) returns boolean
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select coalesce((p -> 'qaOnly') = 'true'::jsonb, false)
      or coalesce(p ->> 'tier' in ('REGISTERED', 'VALIDATED'), false)
      or coalesce(p ->> 'type' = 'DECISION_AFFECTING_CORRECTION', false)
$$;

-- A JSON text member as text; NULL when absent or not a string.
create function recipe.json_text(p jsonb, k text) returns text
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select case when jsonb_typeof(p -> k) = 'string' then p ->> k end
$$;

-- The register row of exception record p_x, raised by row c (batch policy not needed). Refuses an unknown category.
create function recipe.register_exception(c recipe.execution_command, p_id text, p_x jsonb) returns void
language plpgsql volatile security definer set search_path = pg_catalog, recipe, pg_temp as $$
declare
  v_mandatory boolean;
begin
  if jsonb_typeof(p_x) is distinct from 'object' then
    raise exception using errcode = 'P0001',
      message = format('Exception %s of the state is not an exception record, so it cannot be registered (DI-26, INV-41). [EBMR-EXE-160]', p_id);
  end if;
  select k.mandatory into v_mandatory from recipe.exception_review_category k where k.category = p_x ->> 'category';
  if v_mandatory is null then
    raise exception using errcode = 'P0001',
      message = format('Exception %s has the review category %s, which the register does not know; every exception belongs to a review category (DI-26). [EBMR-EXE-160]',
                       p_id, coalesce(p_x ->> 'category', 'none'));
  end if;
  insert into recipe.exception_register (batch_id, exception_id, row_seq, exception_type, category, severity, tier, title, raising_step_key, raising_step,
                                         raised_at, raised_at_us, raised_by, command_person, mandatory, qa_only, deviation_required,
                                         registration_relevant, release_blocking, blocks_until, raised_record, correlation_id)
  values (c.batch_id, p_id, c.seq, coalesce(recipe.json_text(p_x, 'type'), '?'), p_x ->> 'category', p_x ->> 'severity', recipe.json_text(p_x, 'tier'),
          coalesce(recipe.json_text(p_x, 'title'), ''), recipe.json_text(p_x -> 'source', 'stepKey'), recipe.json_text(p_x -> 'source', 'step'),
          c.recorded_at, c.now_us, coalesce(recipe.json_text(p_x, 'raisedBy'), '?'), c.actor_person, v_mandatory, recipe.exception_qa_only(p_x),
          coalesce((p_x -> 'deviationRequired') = 'true'::jsonb, false), coalesce((p_x -> 'registrationRelevant') = 'true'::jsonb, false),
          coalesce((p_x -> 'releaseBlocking') = 'true'::jsonb, false), recipe.json_text(p_x -> 'block', 'until'),
          recipe.exception_as_raised(p_x), c.correlation_id);
end
$$;

-- ---------------------------------------------------------------------------------------------
-- 4. The sync: the register follows the state, and the state never leaves the register
-- ---------------------------------------------------------------------------------------------

create function recipe.exception_register_sync() returns trigger
language plpgsql security definer set search_path = pg_catalog, recipe, pg_temp as $$
declare
  c        recipe.execution_command;
  b        recipe.batch_execution;
  v_prior  jsonb := case when tg_op = 'UPDATE' then old.state else '{}'::jsonb end;
  v_now    jsonb := case when jsonb_typeof(new.state -> 'exceptions') = 'object' then new.state -> 'exceptions' else '{}'::jsonb end;
  v_cmd    text;
  v_ex     text;
  k        text;
  x        jsonb;
  reg      recipe.exception_register;
  v_link   recipe.exception_register_act;
  v_disp   recipe.exception_register_act;
  v_own    boolean;
  v_extra  text;
begin
  select * into c from recipe.execution_command where batch_id = new.batch_id and seq = new.last_seq;
  if not found then
    raise exception using errcode = 'P0001',
      message = format('The state of batch %s names row %s, which is not recorded, so its exceptions cannot be registered (DI-26, INV-41). [EBMR-EXE-160]', new.batch_id, new.last_seq);
  end if;
  v_cmd := case when c.kind = 'COMMAND' and c.accepted then c.command_type end;
  v_ex := recipe.json_text(c.command, 'exception');

  for k, x in select e.key, e.value from jsonb_each(v_now) e order by e.key loop
    select * into reg from recipe.exception_register r where r.batch_id = new.batch_id and r.exception_id = k;
    if not found then
      if jsonb_typeof(v_prior -> 'exceptions') = 'object' and (v_prior -> 'exceptions') ? k then
        raise exception using errcode = 'P0001',
          message = format('Exception %s is in the state of the batch but not in the register; the state and the register are kept together (DI-26, INV-41). [EBMR-EXE-160]', k);
      end if;
      if x ->> 'status' is distinct from 'OPEN' or x ? 'disposition' or x ? 'deviation' then
        raise exception using errcode = 'P0001',
          message = format('Exception %s arrives already linked or closed; an exception is raised open and closes only by its disposition (DI-26, INV-41). [EBMR-EXE-161]', k);
      end if;
      perform recipe.register_exception(c, k, x);
      continue;
    end if;
    if recipe.exception_as_raised(x) is distinct from reg.raised_record then
      raise exception using errcode = 'P0001',
        message = format('Exception %s no longer has the facts the register holds for it (type, tier, flags, source, block or title changed); an exception stays as it was raised (DI-26, INV-41). [EBMR-EXE-160]', k);
    end if;

    -- The deviation link: only by an accepted ATTACH_DEVIATION of this exception, by its linker; never changed after.
    select * into v_link from recipe.exception_register_act a where a.batch_id = new.batch_id and a.exception_id = k and a.act = 'DEVIATION_LINKED';
    if v_link.id is null and x ? 'deviation' then
      if v_cmd is distinct from 'ATTACH_DEVIATION' or v_ex is distinct from k or jsonb_typeof(x -> 'deviation') is distinct from 'object'
         or recipe.json_text(x -> 'deviation', 'linkedBy') is distinct from c.actor_person::text
         or coalesce(btrim(recipe.json_text(x -> 'deviation', 'ref')), '') = '' then
        raise exception using errcode = 'P0001',
          message = format('Exception %s is linked to a deviation by a %s row; a deviation is linked only by its own ATTACH_DEVIATION, by the person who links it (PR-08, INV-41). [EBMR-EXE-161]', k, c.command_type);
      end if;
      insert into recipe.exception_register_act (batch_id, exception_id, act, row_seq, by_person, by_account, role_code, deviation_ref, correlation_id)
      values (new.batch_id, k, 'DEVIATION_LINKED', c.seq, c.actor_person, c.actor_account, c.actor_role, x -> 'deviation' ->> 'ref', c.correlation_id);
    elsif v_link.id is not null and (recipe.json_text(x -> 'deviation', 'ref') is distinct from v_link.deviation_ref
                                     or recipe.json_text(x -> 'deviation', 'linkedBy') is distinct from v_link.by_person::text) then
      raise exception using errcode = 'P0001',
        message = format('The deviation link of exception %s was changed or taken away; a link is never changed (INV-41, PR-08). [EBMR-EXE-161]', k);
    end if;

    -- The disposition: an exception closes only by its own signed DISPOSITION_EXCEPTION (INV-41), never reopens.
    select * into v_disp from recipe.exception_register_act a where a.batch_id = new.batch_id and a.exception_id = k and a.act = 'DISPOSITIONED';
    if v_disp.id is null and (x ->> 'status' is distinct from 'OPEN' or x ? 'disposition') then
      v_own := v_cmd = 'DISPOSITION_EXCEPTION' and v_ex = k and x ->> 'status' = 'DISPOSITIONED' and jsonb_typeof(x -> 'disposition') = 'object'
               and recipe.json_text(x -> 'disposition', 'by') = c.actor_person::text
               and recipe.json_text(x -> 'disposition', 'signature') = any (c.signature_ids::text[])
               and recipe.json_text(x -> 'disposition', 'outcome') in ('NO_IMPACT', 'DEVIATION_RAISED')
               and coalesce(btrim(recipe.json_text(x -> 'disposition', 'justification')), '') <> '';
      if not coalesce(v_own, false) then
        raise exception using errcode = 'P0001',
          message = format('Exception %s is closed by a %s row; an exception closes only by its own signed disposition, never by a correction or any other change (INV-41, DI-26). [EBMR-EXE-161]', k, c.command_type);
      end if;
      if reg.qa_only then
        select * into b from recipe.batch_execution where id = new.batch_id;
        if not exists (select 1 from jsonb_array_elements(case when jsonb_typeof(c.roles) = 'array' then c.roles else '[]'::jsonb end) r
                        where jsonb_typeof(b.policy -> 'qaRoles') = 'array' and (b.policy -> 'qaRoles') ? (r ->> 'role')) then
          raise exception using errcode = 'P0001',
            message = format('Exception %s (%s%s) is dispositioned only by QA, and the row holds no QA role of the batch; the disposition is refused (PR-08, PR-13). [EBMR-EXE-162]',
                             k, reg.exception_type, coalesce(', tier ' || reg.tier, ''));
        end if;
      end if;
      v_extra := null;
      if recipe.exception_step_involvement(new.batch_id, v_prior, k, c.seq) ? c.actor_person::text then
        v_extra := 'was involved in the step that raised it';
      elsif reg.raised_by = c.actor_person::text then
        v_extra := 'raised it';
      end if;
      if v_extra is not null then
        raise exception using errcode = 'P0001',
          message = format('%s %s, so the disposition of exception %s is refused: an exception is decided by a person outside the work that raised it (INV-03, PR-13). [EBMR-EXE-163]',
                           c.actor_person, v_extra, k);
      end if;
      insert into recipe.exception_register_act (batch_id, exception_id, act, row_seq, by_person, by_account, role_code, outcome, signature_id, note, correlation_id)
      values (new.batch_id, k, 'DISPOSITIONED', c.seq, c.actor_person, c.actor_account, c.actor_role, x -> 'disposition' ->> 'outcome',
              (x -> 'disposition' ->> 'signature')::uuid, x -> 'disposition' ->> 'justification', c.correlation_id);
    elsif v_disp.id is not null and (x ->> 'status' is distinct from 'DISPOSITIONED'
                                     or recipe.json_text(x -> 'disposition', 'by') is distinct from v_disp.by_person::text
                                     or recipe.json_text(x -> 'disposition', 'outcome') is distinct from v_disp.outcome
                                     or recipe.json_text(x -> 'disposition', 'signature') is distinct from v_disp.signature_id::text
                                     or recipe.json_text(x -> 'disposition', 'justification') is distinct from v_disp.note) then
      raise exception using errcode = 'P0001',
        message = format('The disposition of exception %s was changed or taken away; a disposition is never changed and an exception never reopens (INV-41, DI-26). [EBMR-EXE-161]', k);
    end if;
  end loop;

  -- Never deleted: every registered exception of the batch is still in the state.
  select r.exception_id into k from recipe.exception_register r where r.batch_id = new.batch_id and not (v_now ? r.exception_id) order by r.exception_id limit 1;
  if k is not null then
    raise exception using errcode = 'P0001',
      message = format('Exception %s is in the register but no longer in the state of the batch; an exception is never removed (DI-26, INV-41). [EBMR-EXE-160]', k);
  end if;
  return null;
end
$$;

create trigger zzr_exception_register after insert or update on recipe.execution_state
  for each row execute function recipe.exception_register_sync();

-- ---------------------------------------------------------------------------------------------
-- 5. The QA review of an exception (review by exception)
-- ---------------------------------------------------------------------------------------------

-- Who may perform each review act (any one of the list, the first the declared role holds; DI-17).
create table recipe.exception_review_permission (
  act          text primary key check (act in ('QUERIED', 'RESPONDED', 'ACCEPTED_BY_QA', 'ESCALATED')),
  permissions  text[] not null check (cardinality(permissions) >= 1)
);
revoke all on recipe.exception_review_permission from public;
select kernel.register_audited_table('recipe.exception_review_permission', 'exception_review_permission', 'act', true);
insert into recipe.exception_review_permission (act, permissions) values
  ('QUERIED', array['RECORD.QA_REVIEW']),
  ('ACCEPTED_BY_QA', array['RECORD.QA_REVIEW']),
  ('ESCALATED', array['RECORD.QA_REVIEW']),
  ('RESPONDED', array['STEP.SUPERVISE', 'RECORD.PRODUCTION_APPROVE']);

select kernel.set_actor_context(null);

-- DI-26, INV-41, INV-03: records review act p_act on exception p_exception of test batch p_batch with note p_note (the
-- question, the answer, the escalation's reason; optional for an acceptance) and, for ESCALATED, the deviation
-- reference p_deviation_ref. Returns the act's id.
create function recipe.review_exception(p_batch uuid, p_exception text, p_act text, p_note text, p_deviation_ref text) returns bigint
language plpgsql volatile security definer set search_path = pg_catalog, recipe, iam, kernel, pg_temp as $$
declare
  v_actor  jsonb := recipe.execution_actor('Reviewing an exception of a test run');
  v_perms  text[];
  v_held   text[];
  v_perm   text;
  v_person uuid := (v_actor ->> 'person_id')::uuid;
  reg      recipe.exception_register;
  v_disp   recipe.exception_register_act;
  v_last   recipe.exception_register_act;
  v_query  recipe.exception_register_act;
  v_state  jsonb;
  v_id     bigint;
begin
  select permissions into v_perms from recipe.exception_review_permission where act = p_act;
  if v_perms is null then
    raise exception using errcode = 'P0001',
      message = format('%s is not a review act; an exception is QUERIED, RESPONDED, ACCEPTED_BY_QA or ESCALATED in review (DI-26). [EBMR-EXE-164]', coalesce(p_act, 'null'));
  end if;
  v_held := iam.role_permissions_at(v_actor ->> 'role_code', clock_timestamp());
  select p into v_perm from unnest(v_perms) with ordinality as x (p, i) where p = any (v_held) order by i limit 1;
  perform iam.require_permission(coalesce(v_perm, v_perms[1]), iam.actor_location_scope());

  select * into reg from recipe.exception_register r where r.batch_id = p_batch and r.exception_id = p_exception for update;
  if not found then
    raise exception using errcode = 'P0001',
      message = format('Test batch %s has no registered exception %s (DI-26). [EBMR-EXE-164]', p_batch, coalesce(p_exception, 'null'));
  end if;
  select * into v_disp from recipe.exception_register_act a where a.batch_id = p_batch and a.exception_id = p_exception and a.act = 'DISPOSITIONED';
  select * into v_last from recipe.exception_register_act a
   where a.batch_id = p_batch and a.exception_id = p_exception and a.act in ('QUERIED', 'RESPONDED', 'ACCEPTED_BY_QA', 'ESCALATED') order by a.id desc limit 1;
  if v_last.act in ('ACCEPTED_BY_QA', 'ESCALATED') then
    raise exception using errcode = 'P0001',
      message = format('Exception %s was already %s in review; its review is concluded (DI-26). [EBMR-EXE-164]', p_exception, lower(replace(v_last.act, '_', ' ')));
  end if;
  if p_act <> 'ACCEPTED_BY_QA' and (p_note is null or recipe.reason_is_blank(p_note)) then
    raise exception using errcode = 'P0001',
      message = format('A %s review act on exception %s states its text in words (DI-26, PR-49). [EBMR-EXE-164]', p_act, p_exception);
  end if;

  case p_act
    when 'QUERIED' then
      if v_last.act = 'QUERIED' then
        raise exception using errcode = 'P0001',
          message = format('Exception %s has an open query; it is answered before another is asked (DI-26). [EBMR-EXE-164]', p_exception);
      end if;
    when 'RESPONDED' then
      if v_last.act is distinct from 'QUERIED' then
        raise exception using errcode = 'P0001',
          message = format('Exception %s has no open query to respond to (DI-26). [EBMR-EXE-164]', p_exception);
      end if;
      if v_last.by_person = v_person then
        raise exception using errcode = 'P0001',
          message = format('%s asked the query on exception %s and cannot answer it too (INV-03, DI-26). [EBMR-EXE-165]', v_person, p_exception);
      end if;
    when 'ACCEPTED_BY_QA', 'ESCALATED' then
      if p_act = 'ACCEPTED_BY_QA' and v_disp.id is null then
        raise exception using errcode = 'P0001',
          message = format('Exception %s is still open; QA accepts an exception in review only after its disposition, and a review never closes it (DI-26, INV-41). [EBMR-EXE-164]', p_exception);
      end if;
      if p_act = 'ACCEPTED_BY_QA' and v_last.act = 'QUERIED' then
        raise exception using errcode = 'P0001',
          message = format('Exception %s has an open query; it is answered before QA accepts the exception (DI-26). [EBMR-EXE-164]', p_exception);
      end if;
      if p_act = 'ESCALATED' and (p_deviation_ref is null or recipe.reason_is_blank(p_deviation_ref)) then
        raise exception using errcode = 'P0001',
          message = format('An escalation of exception %s names the deviation it is escalated to (DI-26, PR-49). [EBMR-EXE-164]', p_exception);
      end if;
      select s.state into v_state from recipe.execution_state s where s.batch_id = p_batch;
      if recipe.exception_step_involvement(p_batch, v_state, p_exception, null) ? v_person::text or reg.raised_by = v_person::text
         or v_disp.by_person = v_person then
        raise exception using errcode = 'P0001',
          message = format('%s raised, worked in the step of, or dispositioned exception %s, so they cannot conclude its review (INV-03, DI-26). [EBMR-EXE-165]', v_person, p_exception);
      end if;
  end case;

  insert into recipe.exception_register_act (batch_id, exception_id, act, by_person, by_account, role_code, deviation_ref, note, correlation_id)
  values (p_batch, p_exception, p_act, v_person, (v_actor ->> 'account_id')::uuid, v_actor ->> 'role_code',
          case when p_act = 'ESCALATED' then btrim(p_deviation_ref) end, case when p_note is null or recipe.reason_is_blank(p_note) then null else p_note end,
          (v_actor ->> 'correlation_id')::uuid)
  returning id into v_id;
  return v_id;
end
$$;

-- ---------------------------------------------------------------------------------------------
-- 6. The read view for review by exception
-- ---------------------------------------------------------------------------------------------

create view recipe.exception_register_review as
  select r.batch_id, b.batch_number, r.exception_id, r.exception_type, r.category, r.severity, r.tier, r.title,
         r.mandatory, r.qa_only, r.deviation_required, r.registration_relevant, r.release_blocking,
         r.raising_step_key, r.raising_step, r.raised_at, r.raised_by, r.command_person, r.row_seq,
         case when d.id is null then 'OPEN' else 'DISPOSITIONED' end as status,
         l.deviation_ref, l.by_person as deviation_linked_by, l.recorded_at as deviation_linked_at,
         d.outcome as disposition_outcome, d.note as disposition_justification, d.by_person as dispositioned_by,
         d.signature_id as disposition_signature, d.recorded_at as dispositioned_at,
         coalesce(v.act, 'NOT_REVIEWED') as review_state, v.by_person as reviewed_by, v.recorded_at as reviewed_at,
         case when v.act = 'ESCALATED' then v.deviation_ref end as escalated_to,
         (d.id is null and coalesce(r.blocks_until = 'DISPOSITION' or (r.blocks_until = 'DEVIATION' and l.id is null), false)) as blocking
    from recipe.exception_register r
    join recipe.batch_execution b on b.id = r.batch_id
    left join recipe.exception_register_act l on l.batch_id = r.batch_id and l.exception_id = r.exception_id and l.act = 'DEVIATION_LINKED'
    left join recipe.exception_register_act d on d.batch_id = r.batch_id and d.exception_id = r.exception_id and d.act = 'DISPOSITIONED'
    left join lateral (select a.* from recipe.exception_register_act a
                        where a.batch_id = r.batch_id and a.exception_id = r.exception_id and a.act in ('QUERIED', 'RESPONDED', 'ACCEPTED_BY_QA', 'ESCALATED')
                        order by a.id desc limit 1) v on true;
comment on view recipe.exception_register_review is 'The exception register for review by exception (DI-26): status, link, disposition, review state and whether the exception still blocks';

-- ---------------------------------------------------------------------------------------------
-- 7. Back-fill of the test batches recorded before this migration (state and events as stored)
-- ---------------------------------------------------------------------------------------------

do $$
declare
  st  recipe.execution_state;
  k   text;
  x   jsonb;
  c   recipe.execution_command;
begin
  for st in select * from recipe.execution_state order by batch_id loop
    for k, x in select e.key, e.value from jsonb_each(case when jsonb_typeof(st.state -> 'exceptions') = 'object' then st.state -> 'exceptions' else '{}'::jsonb end) e order by e.key loop
      select cm.* into c from recipe.execution_command cm
       where cm.batch_id = st.batch_id
         and cm.seq = coalesce((select min(e.row_seq) from recipe.execution_event e
                                 where e.batch_id = st.batch_id and e.event_type = 'EXCEPTION_RAISED' and e.event ->> 'exception' = k),
                               case when (x ->> 'raisedSeq') ~ '^[0-9]{1,18}$' then (x ->> 'raisedSeq')::bigint end, 1);
      perform kernel.set_actor_context(jsonb_build_object(
        'person_id', '00000000-0000-0000-0000-000000000000', 'account_id', '00000000-0000-0000-0000-000000000000',
        'role_code', 'SOFTWARE_RELEASE', 'session_id', '00000000-0000-0000-0000-000000000000', 'source', 'SYSTEM',
        'site_zone', 'UTC', 'correlation_id', gen_random_uuid(),
        'legal_name', 'Software release (recipe-core migration 0440_exception_register)',
        'reason_code', 'SOFTWARE_RELEASE', 'reason_text', 'exception register back-filled from the stored test batches (DI-26)'));
      perform recipe.register_exception(c, k, x);
      if jsonb_typeof(x -> 'deviation') = 'object' then
        select cm.* into c from recipe.execution_command cm
         where cm.batch_id = st.batch_id and cm.seq = coalesce((select min(e.row_seq) from recipe.execution_event e
                                                                 where e.batch_id = st.batch_id and e.event_type = 'DEVIATION_LINKED' and e.event ->> 'exception' = k), st.last_seq);
        insert into recipe.exception_register_act (batch_id, exception_id, act, row_seq, by_person, by_account, role_code, deviation_ref, correlation_id)
        values (st.batch_id, k, 'DEVIATION_LINKED', c.seq, c.actor_person, c.actor_account, c.actor_role, coalesce(x -> 'deviation' ->> 'ref', '?'), c.correlation_id);
      end if;
      if x ->> 'status' = 'DISPOSITIONED' and jsonb_typeof(x -> 'disposition') = 'object' then
        select cm.* into c from recipe.execution_command cm
         where cm.batch_id = st.batch_id and cm.seq = coalesce((select min(e.row_seq) from recipe.execution_event e
                                                                 where e.batch_id = st.batch_id and e.event_type = 'EXCEPTION_DISPOSITIONED' and e.event ->> 'exception' = k), st.last_seq);
        insert into recipe.exception_register_act (batch_id, exception_id, act, row_seq, by_person, by_account, role_code, outcome, signature_id, note, correlation_id)
        values (st.batch_id, k, 'DISPOSITIONED', c.seq, c.actor_person, c.actor_account, c.actor_role, x -> 'disposition' ->> 'outcome',
                (x -> 'disposition' ->> 'signature')::uuid, coalesce(x -> 'disposition' ->> 'justification', '?'), c.correlation_id);
      end if;
    end loop;
  end loop;
  perform kernel.set_actor_context(null);
end
$$;

-- ---------------------------------------------------------------------------------------------
-- Privileges: the application role reads the register, its acts, the catalogues and the view, and records a review act
-- through recipe.review_exception; everything else is private to the owner.
-- ---------------------------------------------------------------------------------------------

revoke all on function recipe.exception_as_raised(jsonb), recipe.exception_qa_only(jsonb), recipe.json_text(jsonb, text),
                       recipe.register_exception(recipe.execution_command, text, jsonb), recipe.exception_register_sync(),
                       recipe.review_exception(uuid, text, text, text, text) from public;
grant execute on function recipe.review_exception(uuid, text, text, text, text) to ebmr_app;
grant select on recipe.exception_review_category, recipe.exception_register, recipe.exception_register_act, recipe.exception_review_permission,
                recipe.exception_register_review to ebmr_app;

reset role;
