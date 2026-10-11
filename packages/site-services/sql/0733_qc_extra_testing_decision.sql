-- The QC decision on extra testing of a batch (Phase 3 slice 5a-0; slice 5 plan "Interfaces fixed before building",
-- default D-S5-9; control PR-47, release part): QC records, under its QC_EXTRA_TESTING_DECIDED signature, whether a
-- (reprocessed or recovered) batch needs tests beyond its specification before release, and which. Phase 3 records the
-- decision and proves its reader; the Phase 4 release checklist reads it through recipe.reprocessing_release_problem.
--
--   site.qc_extra_testing_decision       insert-only; the latest decision of a batch wins
--   site.qc_extra_testing_aggregate_id   the signed aggregate's id: <batch id>/<decision>/<tests joined by +>, so the
--                                        signature binds the batch, the decision and the tests (record_disposal pattern)
--   site.record_qc_extra_testing_decision(batch, decision, tests, signature)   QC.RESULT_APPROVE
--   site.qc_extra_testing_decision_of(batch)  {decision, tests, signatureId, decidedAt} or NULL
--
-- Messages: EBMR-SITE-345 to 349.

set local role ebmr_owner;

create table site.qc_extra_testing_decision (
  id                   uuid primary key default gen_random_uuid(),
  batch_id             uuid not null,
  batch_number         text not null check (batch_number ~ '^[A-Z0-9][A-Z0-9/.-]{0,31}$'),
  edition              text not null check (edition in ('TABLETS', 'INJECTABLES')),
  site_code            text not null check (site_code ~ '^[A-Z0-9][A-Z0-9-]{0,15}$'),
  decision             text not null check (decision in ('NONE_REQUIRED', 'EXTRA_TESTS')),
  tests                text[] not null default '{}',
  signature_id         uuid not null unique,
  decided_by_person    uuid not null,
  decided_by_account   uuid not null,
  decided_at           timestamptz not null default clock_timestamp(),
  check ((decision = 'EXTRA_TESTS') = (cardinality(tests) >= 1))
);
create index qc_extra_testing_decision_batch on site.qc_extra_testing_decision (batch_id, decided_at desc);
revoke all on site.qc_extra_testing_decision from public;

select platform.enforce_db_time('site.qc_extra_testing_decision', array['decided_at']);
select kernel.register_audited_table('site.qc_extra_testing_decision', 'qc_extra_testing', 'batch_id', true);

-- The tests in their canonical form (sorted, distinct), or NULL when one is not a test code.
create function site.qc_test_codes(p_tests text[]) returns text[]
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select case when exists (select 1 from unnest(coalesce(p_tests, '{}')) t where t is null or t !~ '^[A-Z0-9][A-Z0-9_.-]{0,39}$') then null
              else coalesce((select array_agg(distinct t order by t) from unnest(p_tests) t), '{}') end
$$;

create function site.qc_extra_testing_aggregate_id(p_batch uuid, p_decision text, p_tests text[]) returns text
language sql immutable set search_path = pg_catalog, site, pg_temp as $$
  select format('%s/%s/%s', p_batch, p_decision, array_to_string(site.qc_test_codes(p_tests), '+'))
$$;

-- Content of aggregate qc_extra_testing:<batch>/<decision>/<tests>: the batch (from the batch side) with the decision
-- and the tests. State: the latest recorded decision's id, or NONE, so a signature applies to one decision only.
create function site.qc_extra_testing_content(p_id text) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, site, pg_temp as $$
declare
  m       text[];
  v_b     jsonb;
  v_tests text[];
begin
  m := regexp_match(coalesce(p_id, ''), '^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/(NONE_REQUIRED|EXTRA_TESTS)/([A-Z0-9_.+-]*)$');
  if m is null then
    return '{"exists": false}'::jsonb;
  end if;
  v_tests := case when m[3] = '' then '{}'::text[] else string_to_array(m[3], '+') end;
  if site.qc_test_codes(v_tests) is distinct from v_tests or (m[2] = 'EXTRA_TESTS') <> (cardinality(v_tests) >= 1) then
    return '{"exists": false}'::jsonb;
  end if;
  v_b := site.subject_identity('BATCH', m[1]::uuid);
  if v_b is null then
    return '{"exists": false}'::jsonb;
  end if;
  return jsonb_build_object(
    'exists', true,
    'content_version', 1,
    'content', jsonb_build_object('batch_id', m[1], 'batch_number', v_b ->> 'batchNumber', 'edition', v_b ->> 'edition',
                                  'product_code', v_b ->> 'productCode', 'strength', v_b ->> 'strength',
                                  'decision', m[2], 'tests', to_jsonb(v_tests)),
    'state', coalesce((select d.id::text from site.qc_extra_testing_decision d where d.batch_id = m[1]::uuid order by d.decided_at desc, d.id desc limit 1), 'NONE'),
    'scope', jsonb_build_object('site', v_b ->> 'siteCode', 'product', v_b ->> 'productCode'));
end
$$;

select esig.register_content_provider('qc_extra_testing', 'site.qc_extra_testing_content(text)',
  'QC decision on extra testing of a batch before release: the batch, the decision and the tests');

select kernel.set_actor_context(jsonb_build_object(
  'person_id', '00000000-0000-0000-0000-000000000000', 'account_id', '00000000-0000-0000-0000-000000000000',
  'role_code', 'SOFTWARE_RELEASE', 'session_id', '00000000-0000-0000-0000-000000000000', 'source', 'SYSTEM',
  'site_zone', 'UTC', 'correlation_id', gen_random_uuid(),
  'legal_name', 'Software release (site-services migration 0733_qc_extra_testing_decision)',
  'reason_code', 'SOFTWARE_RELEASE',
  'reason_text', 'QC extra-testing decision meaning (PR-47; D-S5-9)'));

insert into esig.meaning_type (code, version, origin, is_minimum, status, category, role_class, title, meaning_text, permissions,
                               independent_of, excludes_performers, excludes_involved, witness, reauth, delegable, sources)
values
  ('QC_EXTRA_TESTING_DECIDED', 1, 'VENDOR', true, 'ACTIVE', 'LABORATORY', 'APPROVER', 'QC decision on extra testing',
   'Quality-control decision: this batch needs the extra tests listed before release, or none beyond its specification, as recorded.',
   array['QC.RESULT_APPROVE'], '{}', false, false, false, 'ALL_COMPONENTS', false, 'PR-47 (reprocessed and recovered batches); outline 5.2.9; D-S5-9');

select kernel.set_actor_context(null);

create function site.record_qc_extra_testing_decision(p_batch uuid, p_decision text, p_tests text[], p_signature uuid) returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, site, iam, esig, pg_temp as $$
declare
  v_ctx   jsonb := site.require_actor();
  v_b     jsonb;
  v_tests text[] := site.qc_test_codes(p_tests);
  v_prob  text;
  v_id    uuid;
begin
  perform iam.assert_not_administrator();
  v_b := site.subject_identity('BATCH', p_batch);
  if v_b is null then
    raise exception using errcode = 'P0001', message = format('EBMR-SITE-345 batch %s is not a GMP batch of this installation (PR-47)', coalesce(p_batch::text, 'NULL'));
  end if;
  perform iam.require_permission('QC.RESULT_APPROVE', jsonb_build_object('site', v_b ->> 'siteCode', 'product', v_b ->> 'productCode'));
  if p_decision is null or p_decision not in ('NONE_REQUIRED', 'EXTRA_TESTS') or v_tests is null
     or (p_decision = 'EXTRA_TESTS') <> (cardinality(v_tests) >= 1) then
    raise exception using errcode = 'P0001',
      message = 'EBMR-SITE-346 the decision is NONE_REQUIRED (no tests) or EXTRA_TESTS with at least one test code (PR-47)';
  end if;
  perform pg_advisory_xact_lock(hashtext('site.qc_extra_testing'), hashtext(p_batch::text));
  perform esig.assert_signature(p_signature, 'QC_EXTRA_TESTING_DECIDED', 'qc_extra_testing', site.qc_extra_testing_aggregate_id(p_batch, p_decision, v_tests));
  v_prob := esig.signature_state_problem(p_signature);
  if v_prob is not null then
    raise exception using errcode = 'P0001', message = 'EBMR-SITE-347 ' || v_prob;
  end if;
  if (select s.signer_person from esig.signature s where s.id = p_signature)::text is distinct from v_ctx ->> 'person_id' then
    raise exception using errcode = 'P0001', message = 'EBMR-SITE-347 the decision is recorded by the QC person who signed it (PR-47)';
  end if;
  insert into site.qc_extra_testing_decision (batch_id, batch_number, edition, site_code, decision, tests, signature_id, decided_by_person, decided_by_account)
  values (p_batch, v_b ->> 'batchNumber', v_b ->> 'edition', v_b ->> 'siteCode', p_decision, v_tests, p_signature,
          (v_ctx ->> 'person_id')::uuid, (v_ctx ->> 'account_id')::uuid)
  returning id into v_id;
  return v_id;
end
$$;

create function site.qc_extra_testing_decision_of(p_batch uuid) returns jsonb
language sql stable security definer set search_path = pg_catalog, site, pg_temp as $$
  select jsonb_build_object('decision', d.decision, 'tests', to_jsonb(d.tests), 'signatureId', d.signature_id, 'decidedAt', site.utc_text(d.decided_at))
  from site.qc_extra_testing_decision d where d.batch_id = p_batch order by d.decided_at desc, d.id desc limit 1
$$;

revoke all on site.qc_extra_testing_decision from ebmr_app;
grant select on site.qc_extra_testing_decision to ebmr_app;
grant execute on function site.record_qc_extra_testing_decision(uuid, text, text[], uuid), site.qc_extra_testing_decision_of(uuid),
                          site.qc_extra_testing_aggregate_id(uuid, text, text[]), site.qc_test_codes(text[]) to ebmr_app;

reset role;
