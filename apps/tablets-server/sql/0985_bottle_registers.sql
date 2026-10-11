-- Tablets server, Phase 3 slice 4b (builder B): the block versions TB-23@1 (bottle line) and TB-24@1 (secondary and
-- tertiary packaging with the finished-pack examination) in the database's own registers, and the SSCC register of the
-- shippers (tablets spec B.2 TB-23, TB-24; controls PR-37, PR-38, PR-41, PR-42, IN-17, IN-22, DI-30; ADR 0012: the rules
-- hold when the application's own database credentials are used directly).
--
--   * recipe.block_data_schema: the data schemas of every entry kind of the two versions as src/blocks/tb-23.ts and
--     tb-24.ts declare them (their CHALLENGE is G-21@1's own schema); a parity test compares them with the registry
--     (test/blocks/bottle/db-guards.test.ts). A version's schemas never change (ADR 0010).
--   * recipe.engine_name: the two block types and their rule codes (a test run's record may hold them, recipe-core 0346),
--     the codes only the database gives included (TB23-TESTER, TB24-SSCC-ISSUE, TB24-NOT-APPROVED, TB24-AGGREGATION and
--     the others).
--   * tab.sscc_issue: insert-only, audited: each SSCC (GS1 serial shipping container code) the database issued, once, for
--     a TB-24 step of a batch in progress, under the step's GS1 prefix with the next serial reference of that prefix and
--     its check digit (tab.issue_sscc, STEP.EXECUTE). A shipper entry names an SSCC of this register for its own batch and
--     step that no other entry names (tablets 0987), so a shipper label is never keyed and never repeated (PR-42).
--
-- New functions are owned by ebmr_owner, SECURITY DEFINER where they write, and pin their search_path with pg_temp last
-- (ADR 0016). Applied as a new migration because applied migrations are checksummed and never edited.

set local role ebmr_owner;

select kernel.set_actor_context(jsonb_build_object(
  'person_id', '00000000-0000-0000-0000-000000000000', 'account_id', '00000000-0000-0000-0000-000000000000',
  'role_code', 'SOFTWARE_RELEASE', 'session_id', '00000000-0000-0000-0000-000000000000', 'source', 'SYSTEM',
  'site_zone', 'UTC', 'correlation_id', gen_random_uuid(),
  'legal_name', 'Software release (tablets migration 0985_bottle_registers)',
  'reason_code', 'SOFTWARE_RELEASE',
  'reason_text', 'the block versions TB-23@1 and TB-24@1 of Phase 3 slice 4b in the registers every entry is checked against (DI-30, PR-37)'));

insert into recipe.block_data_schema (block_type, block_version, part, entry_kind, schema) values
  ('TB-23', '1', 'ENTRY', 'COUNT_CHECK', '{"type":"object","fields":{"counts":{"type":"array","items":{"type":"string","pattern":"^(0|[1-9][0-9]{0,17})$"},"minItems":1,"maxItems":50}}}'),
  ('TB-23', '1', 'ENTRY', 'DESICCANT_CHECK', '{"type":"object","fields":{"examined":{"type":"string","pattern":"^[1-9][0-9]{0,17}$"},"missing":{"type":"string","pattern":"^(0|[1-9][0-9]{0,17})$"}}}'),
  ('TB-23', '1', 'ENTRY', 'TORQUE_CHECK', '{"type":"object","fields":{"tester":{"type":"string","pattern":"^[A-Z0-9][A-Z0-9_-]{0,39}$"},"application":{"type":"array","items":{"type":"decimal","min":"0"},"minItems":1,"maxItems":24},"removal":{"type":"array","items":{"type":"decimal","min":"0"},"minItems":1,"maxItems":24}}}'),
  ('TB-23', '1', 'ENTRY', 'SEAL_CHECK', '{"type":"object","fields":{"examined":{"type":"string","pattern":"^[1-9][0-9]{0,17}$"},"defective":{"type":"string","pattern":"^(0|[1-9][0-9]{0,17})$"},"statementChecked":{"type":"boolean","optional":true}}}'),
  ('TB-23', '1', 'ENTRY', 'CHALLENGE', '{"type":"object","fields":{"device":{"type":"string"},"trigger":{"type":"string","enum":["START","INTERVAL","STOPPAGE","REEL_CHANGE","END"]},"result":{"type":"string","enum":["PASS","FAIL"]},"event":{"type":"string","pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$","optional":true},"at":{"type":"string","pattern":"^[0-9]{1,20}$","optional":true}}}'),
  ('TB-23', '1', 'ENTRY', 'REJECTS', '{"type":"object","fields":{"reason":{"type":"string","enum":["COUNT","DESICCANT_MISSING","TORQUE","SEAL","LABEL","CHECKWEIGHER","OTHER"]},"bottles":{"type":"string","pattern":"^[1-9][0-9]{0,17}$"}}}'),
  ('TB-23', '1', 'ENTRY', 'BRIGHT_STOCK', '{"type":"object","fields":{"bottles":{"type":"string","pattern":"^[1-9][0-9]{0,17}$"}}}'),
  ('TB-23', '1', 'ENTRY', 'BRIGHT_STOCK_USE', '{"type":"object","fields":{"tag":{"type":"string","pattern":"^[1-9][0-9]{0,5}$"},"scannedBatch":{"type":"string"},"scannedProduct":{"type":"string"},"bottles":{"type":"string","pattern":"^[1-9][0-9]{0,17}$"}}}'),
  ('TB-23', '1', 'ENTRY', 'GOOD_OUTPUT', '{"type":"object","fields":{"bottles":{"type":"string","pattern":"^(0|[1-9][0-9]{0,17})$"}}}'),
  ('TB-24', '1', 'ENTRY', 'CHALLENGE', '{"type":"object","fields":{"device":{"type":"string"},"trigger":{"type":"string","enum":["START","INTERVAL","STOPPAGE","REEL_CHANGE","END"]},"result":{"type":"string","enum":["PASS","FAIL"]},"event":{"type":"string","pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$","optional":true},"at":{"type":"string","pattern":"^[0-9]{1,20}$","optional":true}}}'),
  ('TB-24', '1', 'ENTRY', 'ATD_CHECK', '{"type":"object","fields":{"examined":{"type":"string","pattern":"^[1-9][0-9]{0,17}$"},"defective":{"type":"string","pattern":"^(0|[1-9][0-9]{0,17})$"}}}'),
  ('TB-24', '1', 'ENTRY', 'EXAMINATION', '{"type":"object","fields":{"timing":{"type":"string","enum":["IN_RUN","END"]},"examined":{"type":"string","pattern":"^[1-9][0-9]{0,17}$"},"defective":{"type":"string","pattern":"^(0|[1-9][0-9]{0,17})$"},"labelCorrect":{"type":"boolean"}}}'),
  ('TB-24', '1', 'ENTRY', 'PACKS_MADE', '{"type":"object","fields":{"packs":{"type":"string","pattern":"^[1-9][0-9]{0,17}$"}}}'),
  ('TB-24', '1', 'ENTRY', 'REJECTS', '{"type":"object","fields":{"reason":{"type":"string","enum":["CHECKWEIGHER","LEAFLET","ATD","VISION","EXAMINATION","OTHER"]},"packs":{"type":"string","pattern":"^[1-9][0-9]{0,17}$"}}}'),
  ('TB-24', '1', 'ENTRY', 'PACK_SAMPLE', '{"type":"object","fields":{"purpose":{"type":"string","enum":["QC","RETENTION","STABILITY","EXAMINATION"]},"packs":{"type":"string","pattern":"^[1-9][0-9]{0,17}$"}}}'),
  ('TB-24', '1', 'ENTRY', 'SET_ASIDE', '{"type":"object","fields":{"event":{"type":"string","pattern":"^[A-Z0-9][A-Z0-9_-]{0,31}$"},"description":{"type":"string"},"packs":{"type":"string","pattern":"^[1-9][0-9]{0,17}$"}}}'),
  ('TB-24', '1', 'ENTRY', 'RE_ENTRY', '{"type":"object","fields":{"event":{"type":"string","pattern":"^[A-Z0-9][A-Z0-9_-]{0,31}$"},"packs":{"type":"string","pattern":"^[1-9][0-9]{0,17}$"},"inspection":{"type":"string","enum":["PASS","FAIL"]},"investigation":{"type":"string","pattern":"^[!-~]{1,64}$"}}}'),
  ('TB-24', '1', 'ENTRY', 'SHIPPER', '{"type":"object","fields":{"sscc":{"type":"string","pattern":"^[0-9]{18}$"},"packs":{"type":"string","pattern":"^[1-9][0-9]{0,17}$"},"part":{"type":"boolean"}}}'),
  ('TB-24', '1', 'ENTRY', 'RECONCILIATION', '{"type":"object","fields":{}}');

insert into recipe.engine_name (name, kind) values
  ('TB-23', 'BLOCK_TYPE'), ('TB-24', 'BLOCK_TYPE'),
  ('TB23-BRIGHT-STOCK-OPEN', 'RULE_CODE'), ('TB23-BRIGHT-STOCK-QUANTITY', 'RULE_CODE'), ('TB23-BRIGHT-STOCK-SCAN', 'RULE_CODE'),
  ('TB23-BRIGHT-STOCK-TAG', 'RULE_CODE'), ('TB23-CHECK-DUE', 'RULE_CODE'), ('TB23-COUNTS', 'RULE_CODE'), ('TB23-DEVICE', 'RULE_CODE'),
  ('TB23-ENTRY', 'RULE_CODE'), ('TB23-INTERVAL', 'RULE_CODE'), ('TB23-LABEL-STEP', 'RULE_CODE'), ('TB23-LAST-CHECK', 'RULE_CODE'),
  ('TB23-NO-BRIGHT-STOCK', 'RULE_CODE'), ('TB23-NO-CHECK', 'RULE_CODE'), ('TB23-NO-DESICCANT', 'RULE_CODE'), ('TB23-NO-OUTPUT', 'RULE_CODE'),
  ('TB23-OUTPUT-TWICE', 'RULE_CODE'), ('TB23-STOPPED', 'RULE_CODE'), ('TB23-TAMPER-EVIDENT', 'RULE_CODE'), ('TB23-TESTER', 'RULE_CODE'),
  ('TB23-TORQUE', 'RULE_CODE'), ('TB23-UNIT', 'RULE_CODE'),
  ('TB24-AGGREGATION', 'RULE_CODE'), ('TB24-ATD-REQUIRED', 'RULE_CODE'), ('TB24-CHECK-DUE', 'RULE_CODE'), ('TB24-COUNTS', 'RULE_CODE'),
  ('TB24-DEVICE', 'RULE_CODE'), ('TB24-END-EXAM-FAILED', 'RULE_CODE'), ('TB24-ENDED', 'RULE_CODE'), ('TB24-ENTRY', 'RULE_CODE'),
  ('TB24-EVENT', 'RULE_CODE'), ('TB24-EVENT-TWICE', 'RULE_CODE'), ('TB24-INSPECTION', 'RULE_CODE'), ('TB24-INTERVAL', 'RULE_CODE'),
  ('TB24-LAST-CHECK', 'RULE_CODE'), ('TB24-NO-ATD', 'RULE_CODE'), ('TB24-NO-CHECK', 'RULE_CODE'), ('TB24-NO-END-EXAM', 'RULE_CODE'),
  ('TB24-NO-IN-RUN', 'RULE_CODE'), ('TB24-NOT-APPROVED', 'RULE_CODE'), ('TB24-NOT-RECONCILED', 'RULE_CODE'), ('TB24-PART-SHIPPER', 'RULE_CODE'),
  ('TB24-PRINTED-STEP', 'RULE_CODE'), ('TB24-RE-ENTRY-QUANTITY', 'RULE_CODE'), ('TB24-RECONCILED', 'RULE_CODE'), ('TB24-SAMPLE', 'RULE_CODE'),
  ('TB24-SHIPPER-COUNT', 'RULE_CODE'), ('TB24-SSCC', 'RULE_CODE'), ('TB24-SSCC-ISSUE', 'RULE_CODE'), ('TB24-SSCC-TWICE', 'RULE_CODE'),
  ('TB24-STOPPED', 'RULE_CODE'), ('TB24-UNIT', 'RULE_CODE');

select kernel.set_actor_context(null);

-- ---------------------------------------------------------------------------------------------
-- The SSCC register (header)

create table tab.sscc_issue (
  sscc             text primary key check (sscc ~ '^[0-9]{18}$'),
  prefix           text not null check (prefix ~ '^[0-9]{8,12}$'),
  serial_ref       numeric not null check (serial_ref >= 1 and scale(serial_ref) = 0),
  batch_id         uuid not null references recipe.batch_execution (id),
  step_key         text not null check (btrim(step_key) <> ''),
  person_id        uuid not null,
  account_id       uuid not null,
  issued_at        timestamptz not null default clock_timestamp(),
  unique (prefix, serial_ref)
);
revoke all on tab.sscc_issue from public;
create trigger aa_sscc_issue_insert_only before update or delete on tab.sscc_issue for each row execute function kernel.reject_mutation();
create trigger aa_sscc_issue_no_truncate before truncate on tab.sscc_issue for each statement execute function kernel.reject_mutation();
select platform.enforce_db_time('tab.sscc_issue', array['issued_at']);
select kernel.register_audited_table('tab.sscc_issue', 'batch', 'batch_id', true);
grant select on tab.sscc_issue to ebmr_app;

-- Whether GS1 key p_code (digits) carries its check digit (tb-24.ts gs1CheckDigitOk): mod 10 of the data digits weighted
-- 3 and 1 from the right.
create function tab.gs1_check_ok(p_code text) returns boolean
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select coalesce(p_code ~ '^[0-9]{2,}$', false)
     and (10 - (select coalesce(sum(substr(p_code, length(p_code) - 1 - i, 1)::int * case when i % 2 = 0 then 3 else 1 end), 0)
                  from generate_series(0, length(p_code) - 2) i) % 10) % 10 = substr(p_code, length(p_code), 1)::int
$$;

-- PR-42 (header): the next SSCC of TB-24 step p_key of batch p_batch, recorded: {sscc, prefix, serialRef}.
create function tab.issue_sscc(p_batch uuid, p_key text) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, tab, recipe, iam, plant, pg_temp as $$
declare
  v_actor  jsonb;
  v_state  jsonb;
  v_inst   jsonb;
  v_node   jsonb;
  v_prefix text;
  v_ref    numeric;
  v_body   text;
  v_sscc   text;
  d        integer;
begin
  perform iam.assert_not_administrator();
  v_actor := iam.require_permission('STEP.EXECUTE', plant.batch_scope(p_batch));
  select s.state into v_state from recipe.execution_state s where s.batch_id = p_batch;
  v_inst := v_state -> 'steps' -> p_key;
  v_node := recipe.step_node(recipe.batch_mbr_content(p_batch), v_inst ->> 'step');
  v_prefix := v_node -> 'config' ->> 'ssccPrefix';
  if v_node -> 'block' ->> 'type' is distinct from 'TB-24' or v_inst ->> 'status' is distinct from 'IN_PROGRESS' or coalesce(v_prefix, '') !~ '^[0-9]{8,12}$' then
    raise exception using errcode = 'P0001',
      message = format('%s is not a secondary packaging step (TB-24) of this batch in progress with a GS1 prefix: an SSCC is issued only for one (PR-42). [EBMR-TAB-383]', left(coalesce(p_key, 'NULL'), 120));
  end if;
  -- One issue of a prefix at a time, so the next serial reference is exact.
  perform pg_advisory_xact_lock(hashtext('tab.sscc_issue:' || v_prefix));
  select coalesce(max(serial_ref), 0) + 1 into v_ref from tab.sscc_issue where prefix = v_prefix;
  if length(v_ref::text) > 17 - length(v_prefix) then
    raise exception using errcode = 'P0001', message = format('The serial references of GS1 prefix %s are used up (PR-42). [EBMR-TAB-383]', v_prefix);
  end if;
  v_body := v_prefix || lpad(v_ref::text, 17 - length(v_prefix), '0');
  for d in 0 .. 9 loop
    if tab.gs1_check_ok(v_body || d::text) then
      v_sscc := v_body || d::text;
      exit;
    end if;
  end loop;
  insert into tab.sscc_issue (sscc, prefix, serial_ref, batch_id, step_key, person_id, account_id)
  values (v_sscc, v_prefix, v_ref, p_batch, p_key, (v_actor ->> 'person_id')::uuid, (v_actor ->> 'account_id')::uuid);
  return jsonb_build_object('sscc', v_sscc, 'prefix', v_prefix, 'serialRef', v_ref::text);
end
$$;

revoke all on function tab.gs1_check_ok(text), tab.issue_sscc(uuid, text) from public;
grant execute on function tab.issue_sscc(uuid, text) to ebmr_app;

reset role;
