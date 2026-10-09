-- Recipe core, MBR life cycle (A3), part 3: verification evidence bound to the content hash (DI-04,
-- life-cycle part; outline 5.2.1 and 6.5).
--
-- The static validator, the simulator and the sandbox run in TypeScript or in the separate sandbox
-- database (the flow model's validator and simulator, packages/recipe-core/src/{validator,simulator};
-- the sandbox, kernel 08xx). Their results are stored here with the exact content hash they were
-- produced on, by the author, and the database checks what it can check itself:
--   VALIDATOR     the validator report and the warning justifications. The database recounts the
--                 findings: PASS only with zero errors and every warning justified (outline 6.3).
--   VERIFICATION  the sealed verification evidence of the simulator (FULL, or DELTA reusing the
--                 structural evidence of a verified predecessor, outline 6.5). The database
--                 recomputes the evidence seal; PASS only when the verdict is VERIFIED; a DELTA
--                 must name a verified predecessor of this version by content and evidence hash.
--   TEST_VECTORS  the generated boundary vectors and golden cases, confirmed by the author.
--   SANDBOX_RUN   a test run on the real screens in the sandbox database, on this exact hash,
--                 with its coverage report (outline 6.5; DI-05 keeps the sandbox separate).
-- Evidence is insert-only; any new content revision voids all evidence of the version in the same
-- transaction (mbr_evidence_void), and evidence is accepted only for the current content hash, only
-- while the version is in DRAFT or IN_VERIFICATION.

set local role ebmr_owner;

create table recipe.mbr_evidence (
  id            uuid primary key default gen_random_uuid(),
  version_id    uuid not null references recipe.mbr_version (id),
  content_hash  text not null check (content_hash ~ '^[0-9a-f]{64}$'),
  kind          text not null check (kind in ('VALIDATOR', 'VERIFICATION', 'TEST_VECTORS', 'SANDBOX_RUN')),
  mode          text check (mode in ('FULL', 'DELTA')),
  result        text not null check (result in ('PASS', 'FAIL')),
  tool_version  text not null,
  report        jsonb not null check (jsonb_typeof(report) = 'object'),
  report_hash   text not null check (report_hash ~ '^[0-9a-f]{64}$'),
  reference     text,
  problems      text[] not null default '{}',
  person_id     uuid not null,
  account_id    uuid not null,
  recorded_at   timestamptz not null default clock_timestamp(),
  check ((kind = 'VERIFICATION') = (mode is not null))
);
create index mbr_evidence_version on recipe.mbr_evidence (version_id, kind, recorded_at);

create table recipe.mbr_evidence_void (
  evidence_id   uuid primary key references recipe.mbr_evidence (id),
  version_id    uuid not null references recipe.mbr_version (id),
  content_id    uuid not null references recipe.mbr_content (id),
  person_id     uuid not null,
  account_id    uuid not null,
  recorded_at   timestamptz not null default clock_timestamp()
);
create index mbr_evidence_void_version on recipe.mbr_evidence_void (version_id);

-- Why a VALIDATOR report does not pass (empty when it passes). Stored shape:
--   {"validation": <ValidationReport of the flow model's validator>, "justifications": [{key, text, by}]}
create function recipe.validator_problems(p_report jsonb, p_hash text) returns text[]
language plpgsql immutable set search_path = pg_catalog, recipe, pg_temp as $$
declare
  v        jsonb := p_report -> 'validation';
  v_out    text[] := '{}';
  v_errors integer;
  v_unjust text[];
begin
  if jsonb_typeof(v) is distinct from 'object' or jsonb_typeof(v -> 'findings') is distinct from 'array' then
    return array['the report has no validator findings list'];
  end if;
  if v ->> 'contentHash' is distinct from p_hash then
    v_out := v_out || format('the validator ran on content %s, not on the current content %s', coalesce(v ->> 'contentHash', '(none)'), p_hash);
  end if;
  select count(*) into v_errors from jsonb_array_elements(v -> 'findings') f where f ->> 'severity' = 'ERROR';
  if v_errors > 0 then
    v_out := v_out || format('%s validator error(s)', v_errors);
  end if;
  if (v ->> 'errors') is distinct from v_errors::text then
    v_out := v_out || 'the error count does not match the findings'::text;
  end if;
  v_unjust := array(
    select f ->> 'key' from jsonb_array_elements(v -> 'findings') f
    where f ->> 'severity' = 'WARNING'
      and not exists (select 1 from jsonb_array_elements(case when jsonb_typeof(p_report -> 'justifications') = 'array'
                                                              then p_report -> 'justifications' else '[]'::jsonb end) j
                      where j ->> 'key' = f ->> 'key' and btrim(coalesce(j ->> 'text', '')) <> '' and btrim(coalesce(j ->> 'by', '')) <> ''));
  if cardinality(v_unjust) > 0 then
    v_out := v_out || format('warnings without a recorded justification: %s', array_to_string(v_unjust, ', '));
  end if;
  return v_out;
end
$$;

-- Evidence: only for the version's current content hash, only in DRAFT or IN_VERIFICATION. The
-- database decides the result from the report; the caller's claim is not trusted.
create function recipe.mbr_evidence_guard() returns trigger
language plpgsql security definer set search_path = pg_catalog, recipe, pg_temp as $$
declare
  v_ctx    jsonb := recipe.require_actor();
  v_ver    recipe.mbr_version;
  v_state  text;
  v_hash   text;
  v_prob   text[] := '{}';
  v_basis  text;
  v_pred   recipe.mbr_version;
begin
  if new.kind is null or new.kind not in ('VALIDATOR', 'VERIFICATION', 'TEST_VECTORS', 'SANDBOX_RUN') then
    raise exception using errcode = 'P0001',
      message = format('Unknown kind of verification evidence %s: VALIDATOR, VERIFICATION, TEST_VECTORS or SANDBOX_RUN (DI-04; EBMR-RCP-041)', coalesce(new.kind, '(none)'));
  end if;
  select * into v_ver from recipe.mbr_version where id = new.version_id for update;
  if not found then
    raise exception using errcode = 'P0001', message = format('Unknown MBR version %s (EBMR-RCP-020)', new.version_id);
  end if;
  v_state := recipe.version_state_locked(new.version_id);
  if v_state is null or v_state not in ('DRAFT', 'IN_VERIFICATION') then
    raise exception using errcode = 'P0001',
      message = format('Verification evidence is recorded only in DRAFT or IN_VERIFICATION; this version is %s (DI-04; EBMR-RCP-040)', coalesce(v_state, 'being created'));
  end if;
  v_hash := recipe.content_hash_of(new.version_id);
  new.content_hash := v_hash;
  new.report_hash := recipe.json_hash(new.report);
  new.person_id := (v_ctx ->> 'person_id')::uuid;
  new.account_id := (v_ctx ->> 'account_id')::uuid;
  if new.kind = 'VALIDATOR' then
    new.mode := null;
    new.tool_version := coalesce(new.report -> 'validation' ->> 'validatorVersion', '');
    v_prob := recipe.validator_problems(new.report, v_hash);
  elsif new.kind = 'VERIFICATION' then
    -- The flow model's sealed VerificationEvidence: {kind FULL|DELTA, contentHash, validator, simulation,
    -- languageVersion, basis?, verdict, reasons, evidenceHash}; the seal is SHA-256 of the canonical JSON
    -- of everything but evidenceHash.
    new.mode := new.report ->> 'kind';
    if new.mode is null or new.mode not in ('FULL', 'DELTA') then
      raise exception using errcode = 'P0001', message = 'Verification evidence must be FULL or DELTA (outline 6.5; EBMR-RCP-041)';
    end if;
    new.tool_version := coalesce(new.report -> 'simulation' ->> 'version', '');
    if new.report ->> 'contentHash' is distinct from v_hash then
      v_prob := v_prob || format('the verification ran on content %s, not on the current content', coalesce(new.report ->> 'contentHash', '(none)'));
    end if;
    if new.report ->> 'evidenceHash' is distinct from recipe.json_hash(new.report - 'evidenceHash') then
      v_prob := v_prob || 'the evidence seal does not match its content (altered evidence)'::text;
    end if;
    if new.report ->> 'verdict' is distinct from 'VERIFIED' then
      v_prob := v_prob || format('the verdict is %s', coalesce(new.report ->> 'verdict', '(none)'));
    end if;
    if new.mode = 'DELTA' then
      v_basis := new.report -> 'basis' ->> 'contentHash';
      new.reference := v_basis;
      select * into v_pred from recipe.mbr_version where id = v_ver.derived_from;
      if v_pred.id is null or recipe.content_hash_of(v_pred.id) is distinct from v_basis or not recipe.version_was_approved(v_pred.id) then
        v_prob := v_prob || 'a delta verification must build on the approved version this one was derived from'::text;
      elsif not exists (select 1 from recipe.mbr_evidence e
                        where e.version_id = v_pred.id and e.kind = 'VERIFICATION' and e.result = 'PASS' and e.content_hash = v_basis
                          and e.report ->> 'evidenceHash' = new.report -> 'basis' ->> 'evidenceHash'
                          and not exists (select 1 from recipe.mbr_evidence_void x where x.evidence_id = e.id)) then
        v_prob := v_prob || 'the predecessor has no verified evidence with the cited evidence hash'::text;
      end if;
    end if;
  elsif new.kind = 'TEST_VECTORS' then
    -- {contentHash, goldenCases: [{id, status}], boundaryVectors: n, confirmedBy}; confirmed by the author.
    new.mode := null;
    new.tool_version := coalesce(new.report ->> 'simulatorVersion', '');
    if new.report ->> 'contentHash' is distinct from v_hash then
      v_prob := v_prob || 'the test vectors were generated for other content'::text;
    end if;
    if (v_ctx ->> 'person_id')::uuid is distinct from v_ver.author_person or new.report ->> 'confirmedBy' is distinct from v_ctx ->> 'person_id' then
      v_prob := v_prob || 'test vectors are confirmed by the version''s author'::text;
    end if;
    if jsonb_typeof(new.report -> 'goldenCases') is distinct from 'array'
       or exists (select 1 from jsonb_array_elements(new.report -> 'goldenCases') g where g ->> 'status' is distinct from 'PASS') then
      v_prob := v_prob || 'not every golden case passes'::text;
    end if;
  else
    -- SANDBOX_RUN: {contentHash, runId, sandbox, coverage, passed}
    new.mode := null;
    new.reference := new.report ->> 'runId';
    new.tool_version := coalesce(new.report ->> 'sandbox', '');
    if coalesce(btrim(new.reference), '') = '' then
      raise exception using errcode = 'P0001', message = 'A sandbox run is cited by its run id (outline 6.5; EBMR-RCP-041)';
    end if;
    if new.report ->> 'contentHash' is distinct from v_hash then
      v_prob := v_prob || 'the sandbox run used other content'::text;
    end if;
    if new.report ->> 'passed' is distinct from 'true' then
      v_prob := v_prob || 'the sandbox run did not pass'::text;
    end if;
    if jsonb_typeof(new.report -> 'coverage') is distinct from 'object' then
      v_prob := v_prob || 'the sandbox run has no coverage report'::text;
    end if;
  end if;
  new.problems := v_prob;
  new.result := case when cardinality(v_prob) = 0 then 'PASS' else 'FAIL' end;
  return new;
end
$$;
create trigger a1_guard before insert on recipe.mbr_evidence for each row execute function recipe.mbr_evidence_guard();

create function recipe.mbr_evidence_after() returns trigger
language plpgsql security definer set search_path = pg_catalog, recipe, pg_temp as $$
begin
  perform recipe.log_version_event(new.version_id, 'EVIDENCE',
    jsonb_build_object('evidence_id', new.id, 'kind', new.kind, 'mode', new.mode, 'result', new.result, 'content_hash', new.content_hash));
  return null;
end
$$;
create trigger b1_log after insert on recipe.mbr_evidence for each row execute function recipe.mbr_evidence_after();

create function recipe.mbr_evidence_void_guard() returns trigger
language plpgsql security definer set search_path = pg_catalog, recipe, pg_temp as $$
declare
  v_ctx jsonb := recipe.require_actor();
begin
  new.person_id := (v_ctx ->> 'person_id')::uuid;
  new.account_id := (v_ctx ->> 'account_id')::uuid;
  return new;
end
$$;
create trigger a1_guard before insert on recipe.mbr_evidence_void for each row execute function recipe.mbr_evidence_void_guard();

-- A new content revision voids every piece of evidence of the version and is logged as an edit.
create function recipe.mbr_content_after() returns trigger
language plpgsql security definer set search_path = pg_catalog, recipe, pg_temp as $$
begin
  insert into recipe.mbr_evidence_void (evidence_id, version_id, content_id, person_id, account_id)
  select e.id, e.version_id, new.id, new.edited_by_person, new.edited_by_account
  from recipe.mbr_evidence e
  where e.version_id = new.version_id and not exists (select 1 from recipe.mbr_evidence_void x where x.evidence_id = e.id)
  order by e.recorded_at, e.id;
  perform recipe.log_version_event(new.version_id, case when new.revision = 1 then 'CREATED' else 'CONTENT' end,
                                   jsonb_build_object('revision', new.revision, 'content_hash', new.content_hash));
  return null;
end
$$;
create trigger b1_after after insert on recipe.mbr_content for each row execute function recipe.mbr_content_after();

-- The evidence that counts: not voided, for the current content hash; per kind the latest item.
create function recipe.current_evidence(p_version uuid)
returns table (id uuid, kind text, mode text, result text, report_hash text, tool_version text, reference text, problems text[], recorded_at timestamptz)
language sql stable security definer set search_path = pg_catalog, recipe, pg_temp as $$
  select distinct on (e.kind) e.id, e.kind, e.mode, e.result, e.report_hash, e.tool_version, e.reference, e.problems, e.recorded_at
  from recipe.mbr_evidence e
  where e.version_id = p_version and e.content_hash = recipe.content_hash_of(p_version)
    and not exists (select 1 from recipe.mbr_evidence_void x where x.evidence_id = e.id)
  order by e.kind, e.recorded_at desc, e.id desc
$$;

-- Is the verification complete for the exact current content (DI-04)? VALIDATOR, VERIFICATION and
-- TEST_VECTORS must pass; a SANDBOX_RUN must pass unless the verification is a DELTA verification
-- (outline 5.2.1: sandbox runs on this exact hash, or delta verification per 6.5).
create function recipe.evidence_status(p_version uuid) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, recipe, pg_temp as $$
declare
  v_items   jsonb := '{}'::jsonb;
  v_missing text[] := '{}';
  r         record;
  v_delta   boolean := false;
begin
  for r in select * from recipe.current_evidence(p_version) loop
    v_items := v_items || jsonb_build_object(r.kind, jsonb_build_object('id', r.id, 'result', r.result, 'mode', r.mode,
                                                                          'problems', to_jsonb(r.problems)));
    if r.kind = 'VERIFICATION' and r.mode = 'DELTA' and r.result = 'PASS' then
      v_delta := true;
    end if;
  end loop;
  if v_items -> 'VALIDATOR' ->> 'result' is distinct from 'PASS' then
    v_missing := v_missing || 'a passing static validation (VALIDATOR)'::text;
  end if;
  if v_items -> 'VERIFICATION' ->> 'result' is distinct from 'PASS' then
    v_missing := v_missing || 'a passing simulation with coverage report (VERIFICATION)'::text;
  end if;
  if v_items -> 'TEST_VECTORS' ->> 'result' is distinct from 'PASS' then
    v_missing := v_missing || 'author-confirmed passing test vectors (TEST_VECTORS)'::text;
  end if;
  if not v_delta and v_items -> 'SANDBOX_RUN' ->> 'result' is distinct from 'PASS' then
    v_missing := v_missing || 'a passing sandbox test run on this exact content (SANDBOX_RUN)'::text;
  end if;
  return jsonb_build_object('version_id', p_version, 'content_hash', recipe.content_hash_of(p_version), 'complete', cardinality(v_missing) = 0,
                            'missing', to_jsonb(v_missing), 'delta', v_delta, 'items', v_items);
end
$$;

select platform.enforce_db_time('recipe.mbr_evidence', array['recorded_at']);
select platform.enforce_db_time('recipe.mbr_evidence_void', array['recorded_at']);
select kernel.register_audited_table('recipe.mbr_evidence', 'mbr_version', 'version_id', true);
select kernel.register_audited_table('recipe.mbr_evidence_void', 'mbr_version', 'version_id', true);

grant select on recipe.mbr_evidence, recipe.mbr_evidence_void to ebmr_app;
grant execute on function recipe.validator_problems(jsonb, text), recipe.current_evidence(uuid), recipe.evidence_status(uuid) to ebmr_app;

reset role;
