-- Recipe core, decision 0026 owner decision O-2 (DI-04): a sandbox test run is no longer required evidence.
--
-- Handbook: modules/recipe-core.md
--
-- DI-04 says a dry run or simulation is one acceptable method of verification, not a requirement. The owner decided (1
-- November 2026, decision 0026 O-2) that a master's verification evidence is the validator's report, the simulation
-- with its coverage and the author-confirmed test vectors on the exact content, with the independent check and QA's
-- approval signed in the life cycle; a sandbox test run is optional. The control's text is unchanged.
--
--   recipe.evidence_status: CREATE OR REPLACE from its latest definition (0120). A SANDBOX_RUN is no longer missing
--   when absent; one that was recorded for this content and did not pass still makes the evidence incomplete (a failed
--   test on record is never ignored). Nothing else changes.

set local role ebmr_owner;

create or replace function recipe.evidence_status(p_version uuid) returns jsonb
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
  -- O-2: optional, but a recorded run that did not pass is never ignored.
  if not v_delta and v_items ? 'SANDBOX_RUN' and v_items -> 'SANDBOX_RUN' ->> 'result' is distinct from 'PASS' then
    v_missing := v_missing || 'a sandbox test run recorded for this content that passes (SANDBOX_RUN did not pass)'::text;
  end if;
  return jsonb_build_object('version_id', p_version, 'content_hash', recipe.content_hash_of(p_version), 'complete', cardinality(v_missing) = 0,
                            'missing', to_jsonb(v_missing), 'delta', v_delta, 'items', v_items);
end
$$;

reset role;
