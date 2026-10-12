-- Recipe core: the review register and the evidence epochs (Phase 4 slice 1-0, the interface fixed up front; plan
-- docs/build-plan/phase-4/phase-4-plan.md "Interfaces fixed up front"; outline 5.2.2, 5.4; INV-30, INV-48, L-09).
--
--   * recipe.evidence_epoch (subject_kind, subject_id, version): one version token per subject (BATCH, LOT, CONTAINER,
--     DEVIATION). recipe.bump_epoch(kind, id) adds one; it is called only by the triggers slice 1a adds (exception,
--     deviation link, lot status, LIMS result, correction, review-scope audit event) and by later slices' own. An act
--     that evaluated evidence names the version it saw and is refused when the version moved (write after evaluation).
--     The table is a version counter, not GMP data: it is not audited (a bump is caused by an audited change).
--   * recipe.batch_review_act: insert-only, audited on the chain `batch_review:<batch>` (outside the batch audit-trail
--     review's own scope, so recording a review never makes the review stale): one row per signed review act of a GMP
--     batch record: PRODUCTION_APPROVED or PACKAGING_RECORD_APPROVED, AUDIT_TRAIL_REVIEWED, DELTA_AUDIT_TRAIL_REVIEWED,
--     QA_REVIEWED and REOPENED, each with its review cycle (1, and one more after each reopen) and its signature. The
--     recording functions are slice 1a's (0711 to 0739); the rows are written only by them.
--   * recipe.batch_review_cycle(batch), recipe.batch_record_kind(batch) (PROCESSING or PACKAGING, from the master's
--     family) and recipe.batch_review_state(batch): the execution status until the record is EXECUTION_COMPLETE or
--     ABORTED, then PRODUCTION_APPROVED and QA_REVIEWED as the acts of the current cycle say. A reopen starts a new cycle:
--     the record is back at EXECUTION_COMPLETE (or IN_PROGRESS once a correction moved the execution there).
--
-- Every function is SECURITY DEFINER with search_path pinned, pg_temp last. Applied as a new migration.

set local role ebmr_owner;

create table recipe.evidence_epoch (
  subject_kind  text not null check (subject_kind in ('BATCH', 'LOT', 'CONTAINER', 'DEVIATION')),
  subject_id    uuid not null,
  version       bigint not null check (version >= 1),
  bumped_at     timestamptz not null default clock_timestamp(),
  primary key (subject_kind, subject_id)
);
revoke all on recipe.evidence_epoch from public;
comment on table recipe.evidence_epoch is 'Evidence version tokens (Phase 4 slice 1): one per subject, bumped by triggers on the evidence an act evaluates';

create function recipe.bump_epoch(p_kind text, p_id uuid) returns bigint
language plpgsql volatile security definer set search_path = pg_catalog, recipe, pg_temp as $$
declare
  v bigint;
begin
  if p_id is null then
    return null;
  end if;
  insert into recipe.evidence_epoch as e (subject_kind, subject_id, version) values (p_kind, p_id, 1)
  on conflict (subject_kind, subject_id) do update set version = e.version + 1, bumped_at = clock_timestamp()
  returning version into v;
  return v;
end
$$;

create function recipe.epoch_of(p_kind text, p_id uuid) returns bigint
language sql stable security definer set search_path = pg_catalog, recipe, pg_temp as $$
  select coalesce((select e.version from recipe.evidence_epoch e where e.subject_kind = p_kind and e.subject_id = p_id), 0)
$$;

create table recipe.batch_review_act (
  id                     uuid primary key default gen_random_uuid(),
  batch_id               uuid not null references recipe.batch_execution (id),
  cycle                  integer not null check (cycle >= 1),
  act                    text not null check (act in ('PRODUCTION_APPROVED', 'PACKAGING_RECORD_APPROVED', 'AUDIT_TRAIL_REVIEWED',
                                                      'DELTA_AUDIT_TRAIL_REVIEWED', 'QA_REVIEWED', 'REOPENED')),
  signature_id           uuid not null unique,
  -- The audit-trail reviews: their number in the batch (the aggregate id `<batch>/<n>`), the mark they start from (delta)
  -- and the high-water mark they cover (chain key -> last sequence number), and the report's hash.
  review_number          integer check (review_number >= 1),
  from_mark              jsonb check (from_mark is null or jsonb_typeof(from_mark) = 'object'),
  high_water             jsonb check (high_water is null or jsonb_typeof(high_water) = 'object'),
  report_hash            text check (report_hash is null or report_hash ~ '^[0-9a-f]{64}$'),
  -- The production approval and the QA review: the hash of the record content they signed (with the dispositions for QA).
  reviewed_content_hash  text check (reviewed_content_hash is null or reviewed_content_hash ~ '^[0-9a-f]{64}$'),
  epoch                  bigint,
  reason                 text,
  person_id              uuid not null,
  account_id             uuid not null,
  role_code              text not null,
  correlation_id         uuid not null,
  recorded_at            timestamptz not null default clock_timestamp(),
  check ((act in ('AUDIT_TRAIL_REVIEWED', 'DELTA_AUDIT_TRAIL_REVIEWED')) = (review_number is not null and high_water is not null and report_hash is not null)),
  check ((act = 'DELTA_AUDIT_TRAIL_REVIEWED') = (from_mark is not null)),
  check (act <> 'REOPENED' or btrim(coalesce(reason, '')) <> '')
);
revoke all on recipe.batch_review_act from public;
create unique index batch_review_act_one_per_cycle on recipe.batch_review_act (batch_id, cycle, act)
  where act in ('PRODUCTION_APPROVED', 'PACKAGING_RECORD_APPROVED', 'AUDIT_TRAIL_REVIEWED', 'QA_REVIEWED', 'REOPENED');
create unique index batch_review_act_review_number on recipe.batch_review_act (batch_id, review_number) where review_number is not null;
comment on table recipe.batch_review_act is 'Signed review acts of a GMP batch record (Phase 4 slice 1): insert-only, one row per act, with its review cycle';

select kernel.register_audited_table('recipe.batch_review_act', 'batch_review', 'batch_id', true);

create function recipe.batch_review_cycle(p_batch uuid) returns integer
language sql stable security definer set search_path = pg_catalog, recipe, pg_temp as $$
  select 1 + (select count(*)::integer from recipe.batch_review_act a where a.batch_id = p_batch and a.act = 'REOPENED')
$$;

create function recipe.batch_record_kind(p_batch uuid) returns text
language sql stable security definer set search_path = pg_catalog, recipe, pg_temp as $$
  select f.record_kind from recipe.stub_batch sb join recipe.mbr_family f on f.id = sb.family_id where sb.id = p_batch
$$;

create function recipe.batch_review_state(p_batch uuid) returns text
language plpgsql stable security definer set search_path = pg_catalog, recipe, pg_temp as $$
declare
  v_status text;
  v_cycle  integer;
begin
  select s.status into v_status from recipe.execution_state s where s.batch_id = p_batch;
  if v_status is null or v_status not in ('EXECUTION_COMPLETE', 'ABORTED') then
    return v_status;
  end if;
  v_cycle := recipe.batch_review_cycle(p_batch);
  if exists (select 1 from recipe.batch_review_act a where a.batch_id = p_batch and a.cycle = v_cycle and a.act = 'QA_REVIEWED') then
    return 'QA_REVIEWED';
  end if;
  if exists (select 1 from recipe.batch_review_act a where a.batch_id = p_batch and a.cycle = v_cycle
             and a.act in ('PRODUCTION_APPROVED', 'PACKAGING_RECORD_APPROVED')) then
    return 'PRODUCTION_APPROVED';
  end if;
  return v_status;
end
$$;

revoke all on recipe.batch_review_act, recipe.evidence_epoch from ebmr_app;
grant select on recipe.batch_review_act, recipe.evidence_epoch to ebmr_app;
revoke all on function recipe.bump_epoch(text, uuid), recipe.epoch_of(text, uuid), recipe.batch_review_cycle(uuid), recipe.batch_record_kind(uuid),
                       recipe.batch_review_state(uuid) from public;
grant execute on function recipe.epoch_of(text, uuid), recipe.batch_review_cycle(uuid), recipe.batch_record_kind(uuid), recipe.batch_review_state(uuid) to ebmr_app;

reset role;
