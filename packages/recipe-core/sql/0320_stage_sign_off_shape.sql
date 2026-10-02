-- Recipe core, execution store (module C3): a stage sign-off records exactly what the engine records, and the list of
-- the sign-offs made before 0319 is an audited, insert-only record the application reads (Phase 2 exit review F01,
-- round 2; DI-37, IN-15, PR-16, DI-17, DI-23; ADR 0012: the rules hold when the application's own database
-- credentials are used directly).
--
-- What was wrong after 0319:
--   A. recipe.execution_stage_summary_check (trigger zk_execution_stage_summary, EBMR-EXE-135) compared the canonical
--      form of the recorded summary (recipe.canonical_stage_summary) with the summary the signature covers, plus its
--      stage and start. The canonical form keeps the members the signed text holds and drops every other one, and
--      dedups the deviations. A SIGN_OFF_STAGE appended through the store with the application's role was accepted,
--      and its signature read VALID, while its recorded summary carried members no signature covers: a step count
--      `rejected`, a yield `verdict` ("within limits"), a deviation listed twice, or an end time one microsecond after
--      the start. The sign-off's own signer, signature, time and validity were not checked either.
--   B. recipe.execution_stage_summary_legacy (0319) was readable by the owner only and neither audited nor
--      insert-only, against the rules every recipe table keeps (the application role reads every recipe table; every
--      table is audited and, where it holds evidence, insert-only).
--
-- This migration:
--   1. recipe.stage_sign_off_shape_problem(sign_off, now, by, signature): why a recorded sign-off is not exactly what
--      the engine writes (steps.ts signOffStage, types.ts StageFrameState.signOff and StageSummary); NULL when it is.
--      The sign-off holds exactly {by, signature, at, valid, summary}: by the row's person, the row's signature id,
--      valid true, at the row's trusted time; the summary exactly {stage, startedAt, endedAt, steps, exceptions,
--      deviations, statement, yields}, endedAt the row's trusted time, steps exactly {completed, notApplicable,
--      skipped}, each yield exactly {calculation, value, unit}, no deviation listed twice. The row's trusted time is
--      the engine's transaction time (engine.ts openTx): the later of the row's database time (now_us, INV-16) and
--      the last time seen of the state before the row; a time is the engine codec's {"$u": "<microseconds>"};
--   2. recipe.execution_stage_summary_check (body of 0319 carried forward) first refuses a sign-off with a shape
--      problem (item 1), then, as before, one whose summary is not the one its signature covers (EBMR-EXE-135);
--   3. recipe.execution_stage_summary_legacy is made again with the batch it belongs to (batch_id, so the batch's
--      record holds it: retention, true copy and purge go by batch_id) and registered as an audited, insert-only
--      table of aggregate type batch; its rows are copied unchanged, each insert audited under the software-release
--      identity of this migration; the application role reads it. No function writes it: only a migration does.
--
-- The provider (recipe.execution_content_of, last defined in 0319) reads the table by aggregate_id and signature_id,
-- which are kept, so it is not replaced. CREATE OR REPLACE keeps the owner (ebmr_owner), SECURITY DEFINER, the
-- search_path and the privileges of execution_stage_summary_check (owner only). The new function is private to the
-- owner and pins its search_path with pg_temp last. Applied as a new migration because applied migrations are
-- checksummed and never edited.

set local role ebmr_owner;

-- ---------------------------------------------------------------------------------------------
-- 1. The shape of a recorded sign-off
-- ---------------------------------------------------------------------------------------------

-- DI-37, IN-15, PR-16 (F01 round 2): why sign-off p_sign_off, recorded by person p_by under signature p_signature at
-- the trusted time p_now (microseconds), is not exactly what the engine records (header item 1); NULL when it is.
create function recipe.stage_sign_off_shape_problem(p_sign_off jsonb, p_now bigint, p_by text, p_signature text) returns text
language sql immutable set search_path = pg_catalog, pg_temp as $$
  with m as (
    select p_sign_off -> 'summary' as s,
           array['by', 'signature', 'at', 'valid', 'summary'] as sign_off_members,
           array['stage', 'startedAt', 'endedAt', 'steps', 'exceptions', 'deviations', 'statement', 'yields'] as summary_members,
           array['completed', 'notApplicable', 'skipped'] as step_members,
           array['calculation', 'value', 'unit'] as yield_members,
           jsonb_build_object('$u', p_now::text) as now_json
  )
  select case
    when jsonb_typeof(p_sign_off) is distinct from 'object' then 'it is missing'
    when not (p_sign_off ?& m.sign_off_members) or (p_sign_off - m.sign_off_members) <> '{}'::jsonb
      then format('it holds the members %s, not exactly by, signature, at, valid and summary',
                  (select string_agg(k, ', ' order by k collate "C") from jsonb_object_keys(p_sign_off) k))
    when p_sign_off -> 'by' is distinct from to_jsonb(p_by) then format('it names %s as the signer, not the person of the row', p_sign_off -> 'by')
    when p_sign_off -> 'signature' is distinct from to_jsonb(p_signature) then format('it names signature %s, not the signature of the row', p_sign_off -> 'signature')
    when p_sign_off -> 'valid' is distinct from 'true'::jsonb then 'it is not recorded as valid'
    when p_sign_off -> 'at' is distinct from m.now_json then format('it is recorded at %s, not at the row''s trusted time %s', p_sign_off -> 'at', p_now)
    when jsonb_typeof(m.s) is distinct from 'object' then 'its summary is missing'
    when not (m.s ?& m.summary_members) or (m.s - m.summary_members) <> '{}'::jsonb
      then format('its summary holds the members %s, not exactly stage, startedAt, endedAt, steps, exceptions, deviations, statement and yields',
                  (select string_agg(k, ', ' order by k collate "C") from jsonb_object_keys(m.s) k))
    when m.s -> 'endedAt' is distinct from m.now_json then format('its summary ends at %s, not at the row''s trusted time %s', m.s -> 'endedAt', p_now)
    when jsonb_typeof(m.s -> 'steps') is distinct from 'object' or not ((m.s -> 'steps') ?& m.step_members)
         or ((m.s -> 'steps') - m.step_members) <> '{}'::jsonb
      then 'its step counts are not exactly completed, notApplicable and skipped'
    when jsonb_typeof(m.s -> 'yields') = 'array'
         and exists (select 1 from jsonb_array_elements(m.s -> 'yields') y
                      where jsonb_typeof(y) is distinct from 'object' or not (y ?& m.yield_members) or (y - m.yield_members) <> '{}'::jsonb)
      then 'a yield of its summary is not exactly a calculation, a value and a unit'
    when jsonb_typeof(m.s -> 'deviations') = 'array'
         and (select count(*) from jsonb_array_elements(m.s -> 'deviations')) <> (select count(distinct x) from jsonb_array_elements(m.s -> 'deviations') x)
      then 'its summary lists a deviation twice'
  end
  from m
$$;

-- ---------------------------------------------------------------------------------------------
-- 2. The sign-off row
-- ---------------------------------------------------------------------------------------------

-- DI-37, IN-15, PR-16 (F01): an accepted SIGN_OFF_STAGE row records, for the frame it signs off, exactly the sign-off
-- the engine records (header item 1), and the summary derived from the state before the row, the one its signature
-- covers (0319 header item 6). EBMR-EXE-135. Raises; returns nothing.
create or replace function recipe.execution_stage_summary_check() returns trigger
language plpgsql security definer set search_path = pg_catalog, recipe, pg_temp as $$
declare
  r         recipe.execution_command;
  v_key     text;
  v_mbr     jsonb;
  v_signed  jsonb;
  v_rec     jsonb;
  v_frame   jsonb;
  v_now     bigint;
  v_problem text;
begin
  select * into r from recipe.execution_command c where c.batch_id = new.batch_id and c.seq = new.last_seq;
  if r.kind is distinct from 'COMMAND' or r.accepted is not true or r.command_type is distinct from 'SIGN_OFF_STAGE' then
    return null;
  end if;
  v_key := (r.command ->> 'stage') || '@' || recipe.ctx_key(r.command -> 'context');
  -- The engine's transaction time: the later of the row's database time and the last time seen before the row.
  v_now := greatest(r.now_us, coalesce(recipe.micros_of(old.state -> 'lastRecordedUs'), r.now_us));
  v_problem := recipe.stage_sign_off_shape_problem(new.state -> 'stages' -> v_key -> 'signOff', v_now, r.actor_person::text,
                                                   r.command -> 'signature' ->> 'id');
  if v_problem is not null then
    raise exception using errcode = 'P0001',
      message = format('The sign-off of stage %s is not the one the engine records: %s. A stage sign-off records its signer, signature and time and exactly the summary its signature covers (DI-37, IN-15, PR-16). [EBMR-EXE-135]',
                       v_key, v_problem);
  end if;
  select pk.content into v_mbr from recipe.batch_execution b join recipe.test_package pk on pk.package_hash = b.package_hash where b.id = new.batch_id;
  v_signed := recipe.stage_summary_of(v_mbr, old.state, v_key);
  v_rec := new.state -> 'stages' -> v_key -> 'signOff' -> 'summary';
  v_frame := old.state -> 'stages' -> v_key;
  if v_signed is null or recipe.canonical_stage_summary(v_rec) is distinct from v_signed
     or v_rec -> 'stage' is distinct from v_frame -> 'stage' or v_rec -> 'startedAt' is distinct from v_frame -> 'startedAt' then
    raise exception using errcode = 'P0001',
      message = format('The sign-off of stage %s records the summary %s, but the summary of the stage as signed is %s: a stage sign-off records the summary its signature covers, derived from the record (DI-37, IN-15, PR-16). [EBMR-EXE-135]',
                       v_key, coalesce(recipe.canonical_stage_summary(v_rec)::text, coalesce(v_rec::text, 'none')), coalesce(v_signed::text, 'none (it cannot be derived)'));
  end if;
  return null;
end
$$;

-- ---------------------------------------------------------------------------------------------
-- 3. Sign-offs recorded before 0319: an audited, insert-only record of the batch
-- ---------------------------------------------------------------------------------------------

alter table recipe.execution_stage_summary_legacy rename constraint execution_stage_summary_legacy_pkey to execution_stage_summary_legacy_0319_pkey;
alter table recipe.execution_stage_summary_legacy rename to execution_stage_summary_legacy_0319;

create table recipe.execution_stage_summary_legacy (
  batch_id      uuid not null references recipe.batch_execution (id),
  aggregate_id  text not null check (starts_with(aggregate_id, batch_id::text || ':')),
  signature_id  text not null,
  primary key (aggregate_id, signature_id)
);
revoke all on recipe.execution_stage_summary_legacy from public;
select kernel.register_audited_table('recipe.execution_stage_summary_legacy', 'batch', 'batch_id', true);

select kernel.set_actor_context(jsonb_build_object(
  'person_id', '00000000-0000-0000-0000-000000000000', 'account_id', '00000000-0000-0000-0000-000000000000',
  'role_code', 'SOFTWARE_RELEASE', 'session_id', '00000000-0000-0000-0000-000000000000', 'source', 'SYSTEM',
  'site_zone', 'UTC', 'correlation_id', gen_random_uuid(),
  'legal_name', 'Software release (recipe-core migration 0320_stage_sign_off_shape)',
  'reason_code', 'SOFTWARE_RELEASE',
  'reason_text', 'the stage sign-offs recorded before recipe-core 0319 keep the text they were signed on (DI-37, INV-09)'));

insert into recipe.execution_stage_summary_legacy (batch_id, aggregate_id, signature_id)
select split_part(l.aggregate_id, ':', 1)::uuid, l.aggregate_id, l.signature_id
  from recipe.execution_stage_summary_legacy_0319 l
 order by l.aggregate_id, l.signature_id;

do $$
begin
  if (select count(*) from recipe.execution_stage_summary_legacy) is distinct from (select count(*) from recipe.execution_stage_summary_legacy_0319) then
    raise exception using errcode = 'P0001', message = 'The sign-offs listed by recipe-core 0319 were not all copied (DI-37, INV-09)';
  end if;
end
$$;

select kernel.set_actor_context(null);

drop table recipe.execution_stage_summary_legacy_0319;

grant select on recipe.execution_stage_summary_legacy to ebmr_app;

revoke all on function recipe.stage_sign_off_shape_problem(jsonb, bigint, text, text) from public;

reset role;
