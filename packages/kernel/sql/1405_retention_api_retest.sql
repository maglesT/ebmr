-- API plan C5 (lead ruling of 6 November 2026; control AS-24, record retention for APIs): the records of an active
-- substance that carries a retest date instead of only an expiry are kept at least three years after the batch has been
-- completely distributed (Revised Schedule M Part XII 6.1.4, which follows ICH Q7 6.13; for EU-market APIs EU GMP
-- Part II 6.13). The expiry rules stay: the evaluator already takes the latest date of every rule that applies, so the
-- India expiry + 1 year rule remains the floor.
--
-- Handbook: modules/kernel.md
--
--   * Rule set RET-2026.2, published after RET-2026.1 and so the current one (records.current_retention_rule_set): every
--     row of RET-2026.1 unchanged, plus IN_SCHEDULE_M_RETEST_DISTRIBUTION (India) and EU_GMP_II_RETEST_DISTRIBUTION
--     (EU), both for the batch record, both when the batch is retest-labelled, both distribution + 3 years. No US row
--     (ICH Q7 is guidance there). The rows are written under the software-release identity, so configuration change
--     control (kernel 1196, areas RETENTION_RULE_SET and RETENTION_RULE) records each as a RELEASE version and the audit
--     trail records the inserts; RET-2026.1 itself is not touched and every evaluation stored under it keeps naming it.
--   * records.evaluate_retention (re-created from 0420): one new fact, retestLabelled, from the input of that name
--     (absent = false). Until the distribution date is known the new rules are OPEN with MISSING_INPUT:DISTRIBUTION.
--   * records.normalize_retention_inputs (re-created from 0420): accepts the optional boolean input retestLabelled. It is
--     written into the normalised inputs only when true: false and absent are the same canonical form (no key). So every
--     input row stored before this release normalises to itself (records.update_retention_inputs compares the
--     normalised merge with the stored row and adds no input version for a change that changes nothing; a new version
--     would also void a signed disposal approval, kernel 0720), the archive's drift check shows nothing new for them, and
--     their evaluation under RET-2026.2 gives the same dates as under RET-2026.1.
--
-- Messages: EBMR-REC-020 (as 0420).

set local role ebmr_owner;

select kernel.set_actor_context(jsonb_build_object(
  'person_id', '00000000-0000-0000-0000-000000000000', 'account_id', '00000000-0000-0000-0000-000000000000',
  'role_code', 'SOFTWARE_RELEASE', 'session_id', '00000000-0000-0000-0000-000000000000', 'source', 'SYSTEM',
  'site_zone', 'UTC', 'correlation_id', gen_random_uuid(),
  'legal_name', 'Software release (kernel migration 1405_retention_api_retest)',
  'reason_code', 'SOFTWARE_RELEASE',
  'reason_text', 'retention rule set RET-2026.2: API records with a retest date kept three years after distribution (AS-24)'));

insert into records.retention_rule_set (version, note)
values ('RET-2026.2', 'RET-2026.1 plus the retest-date API rules (AS-24): distribution plus three years for India and the EU (src/records/retention-rules.ts).');

insert into records.retention_rule (rule_set_version, rule_id, proposed_rule_key, retention_keys, market, predicate, anchor, period_years, period_months,
                                    open_reason, source, verification)
select 'RET-2026.2', rule_id, proposed_rule_key, retention_keys, market, predicate, anchor, period_years, period_months, open_reason, source, verification
  from records.retention_rule where rule_set_version = 'RET-2026.1'
 order by rule_id collate "C";

insert into records.retention_rule (rule_set_version, rule_id, proposed_rule_key, retention_keys, market, predicate, anchor, period_years, period_months, open_reason, source, verification) values
('RET-2026.2', 'IN_SCHEDULE_M_RETEST_DISTRIBUTION', 'kernel.retention.batch.retestAfterDistribution', '{BATCH_RECORD}', 'IN', '{"retestLabelled": true}', 'DISTRIBUTION', 3, 0, null,
 'Revised Schedule M Part XII 6.1.4 (as ICH Q7 6.13): records of an API with a retest date kept at least three years after the batch is completely distributed', 'P~'),
('RET-2026.2', 'EU_GMP_II_RETEST_DISTRIBUTION', 'kernel.retention.batch.retestAfterDistribution', '{BATCH_RECORD}', 'EU', '{"retestLabelled": true}', 'DISTRIBUTION', 3, 0, null,
 'EU GMP Part II 6.13: records of an active substance with a retest date kept at least three years after the batch is completely distributed', 'CHECKED');

select kernel.set_actor_context(null);

-- p_inputs: normalised inputs plus "retentionKey". Returns
-- {ruleSetVersion, status DATED|OPEN|NONE, retainUntil, latestDated, governingRules[], openReasons[], evaluated[]}.
create or replace function records.evaluate_retention(p_inputs jsonb, p_rule_set_version text default null) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, records, kernel, pg_temp as $$
declare
  v_version text := coalesce(p_rule_set_version, records.current_retention_rule_set());
  v_markets text[] := array(select jsonb_array_elements_text(coalesce(p_inputs -> 'markets', '[]'::jsonb)));
  v_facts jsonb;
  r records.retention_rule%rowtype;
  v_anchor_key text;
  v_anchor date;
  v_date date;
  v_evaluated jsonb := '[]'::jsonb;
  v_any boolean := false;
  v_max date;
  v_open text[] := '{}';
  v_governing text[] := '{}';
begin
  if not exists (select 1 from records.retention_rule_set where version = v_version) then
    raise exception using errcode = 'P0001', message = format('EBMR-REC-020 retention rule set %s does not exist', v_version);
  end if;
  v_facts := jsonb_build_object(
    'licenceForm', coalesce(p_inputs -> 'licenceForm', 'null'::jsonb),
    -- An unknown expiry date is not an unlabelled product: only the explicit input says the batch
    -- carries no labelled expiry; otherwise the expiry rules apply and stay OPEN until the date is known (F31).
    'expiryLabelled', not coalesce((p_inputs ->> 'noLabelledExpiry')::boolean, false),
    'otcExpiryExempt', coalesce((p_inputs ->> 'otcExpiryExempt')::boolean, false),
    -- An API lot that carries a retest date (AS-24); inputs stored before 1405 have no such key and are not.
    'retestLabelled', coalesce((p_inputs ->> 'retestLabelled')::boolean, false),
    'euCertification', case when (p_inputs ->> 'euCertificationDate') is not null then 'CERTIFIED'
                            when coalesce((p_inputs ->> 'euNeverCertified')::boolean, false) then 'NEVER_CERTIFIED'
                            else 'PENDING' end,
    'aborted', (p_inputs ->> 'abortCancelDate') is not null,
    'maInForce', (p_inputs ->> 'maEndDate') is null);
  for r in
    select * from records.retention_rule rr
    where rr.rule_set_version = v_version
      and (p_inputs ->> 'retentionKey') = any(rr.retention_keys)
      and (rr.market is null or rr.market = any(v_markets))
      and not exists (select 1 from jsonb_each(rr.predicate) p where coalesce(v_facts -> p.key, 'null'::jsonb) is distinct from p.value)
    order by rr.rule_id collate "C"
  loop
    v_any := true;
    if r.anchor = 'OPEN' then
      v_evaluated := v_evaluated || jsonb_build_array(jsonb_build_object('ruleId', r.rule_id, 'status', 'OPEN', 'date', null, 'reason', r.open_reason));
      v_open := v_open || r.open_reason;
      continue;
    end if;
    v_anchor_key := case r.anchor when 'EXPIRY' then 'expiryDate' when 'MANUFACTURE' then 'manufactureDate'
                                  when 'DISTRIBUTION' then 'distributionDate' when 'EU_CERTIFICATION' then 'euCertificationDate'
                                  when 'DISPOSITION' then 'dispositionDate' when 'ABORT_CANCEL' then 'abortCancelDate'
                                  when 'TRANSACTION' then 'lastTransactionDate' when 'MA_END' then 'maEndDate' end;
    v_anchor := (p_inputs ->> v_anchor_key)::date;
    if v_anchor is null then
      v_evaluated := v_evaluated || jsonb_build_array(jsonb_build_object('ruleId', r.rule_id, 'status', 'OPEN', 'date', null,
                                                                          'reason', 'MISSING_INPUT:' || r.anchor));
      v_open := v_open || ('MISSING_INPUT:' || r.anchor);
      continue;
    end if;
    v_date := records.add_period(v_anchor, r.period_years, r.period_months);
    v_evaluated := v_evaluated || jsonb_build_array(jsonb_build_object('ruleId', r.rule_id, 'status', 'DATED',
                                                                        'date', to_char(v_date, 'YYYY-MM-DD'), 'reason', null));
    if v_max is null or v_date > v_max then
      v_max := v_date;
      v_governing := array[r.rule_id];
    elsif v_date = v_max then
      v_governing := v_governing || r.rule_id;
    end if;
  end loop;
  v_open := array(select y.x from (select distinct x from unnest(v_open) x) y order by y.x collate "C");
  return jsonb_build_object(
    'ruleSetVersion', v_version,
    'status', case when not v_any then 'NONE' when cardinality(v_open) > 0 then 'OPEN' else 'DATED' end,
    'retainUntil', case when v_any and cardinality(v_open) = 0 then to_char(v_max, 'YYYY-MM-DD') end,
    'latestDated', to_char(v_max, 'YYYY-MM-DD'),
    'governingRules', case when cardinality(v_open) > 0
                           then to_jsonb(array(select x.e ->> 'ruleId' from jsonb_array_elements(v_evaluated) with ordinality x(e, n)
                                               where x.e ->> 'status' = 'OPEN' order by x.n))
                           else to_jsonb(v_governing) end,
    'openReasons', to_jsonb(v_open),
    'evaluated', v_evaluated);
end
$$;

-- Validates and normalises retention inputs: every key present (retestLabelled only when true), dates as YYYY-MM-DD,
-- markets sorted.
create or replace function records.normalize_retention_inputs(p jsonb) returns jsonb
language plpgsql immutable set search_path = pg_catalog, records, pg_temp as $$
declare
  k text;
  v_dates text[] := array['manufactureDate', 'expiryDate', 'distributionDate', 'euCertificationDate', 'dispositionDate',
                          'abortCancelDate', 'lastTransactionDate', 'maEndDate'];
  v_bools text[] := array['noLabelledExpiry', 'otcExpiryExempt', 'euNeverCertified'];
  v_out jsonb;
  v_markets text[];
  v_d date;
begin
  if p is null or jsonb_typeof(p) <> 'object' then
    raise exception using errcode = 'P0001', message = 'EBMR-REC-020 retention inputs must be a JSON object';
  end if;
  for k in select jsonb_object_keys(p) loop
    if not (k = any(v_dates) or k = any(v_bools) or k in ('markets', 'licenceForm', 'retestLabelled')) then
      raise exception using errcode = 'P0001', message = format('EBMR-REC-020 unknown retention input %s', k);
    end if;
  end loop;
  if jsonb_typeof(p -> 'markets') is distinct from 'array' then
    raise exception using errcode = 'P0001', message = 'EBMR-REC-020 retention inputs need the market set';
  end if;
  v_markets := array(select y.m from (select distinct m from jsonb_array_elements_text(p -> 'markets') m) y order by y.m collate "C");
  if exists (select 1 from unnest(v_markets) m where m not in ('IN', 'US', 'EU')) then
    raise exception using errcode = 'P0001', message = 'EBMR-REC-020 markets must be IN, US or EU';
  end if;
  if not 'IN' = any(v_markets) then
    raise exception using errcode = 'P0001', message = 'EBMR-REC-020 India is in every market set (INV-28); IN is missing';
  end if;
  v_out := jsonb_build_object('markets', to_jsonb(v_markets));
  if coalesce(jsonb_typeof(p -> 'licenceForm'), 'null') = 'null' then
    v_out := v_out || jsonb_build_object('licenceForm', null);
  elsif p ->> 'licenceForm' in ('FORM_25', 'FORM_28') then
    v_out := v_out || jsonb_build_object('licenceForm', p ->> 'licenceForm');
  else
    raise exception using errcode = 'P0001', message = 'EBMR-REC-020 licenceForm must be FORM_25, FORM_28 or null';
  end if;
  foreach k in array v_bools loop
    if coalesce(jsonb_typeof(p -> k), 'null') = 'null' then
      v_out := v_out || jsonb_build_object(k, false);
    elsif jsonb_typeof(p -> k) = 'boolean' then
      v_out := v_out || jsonb_build_object(k, (p ->> k)::boolean);
    else
      raise exception using errcode = 'P0001', message = format('EBMR-REC-020 %s must be true or false', k);
    end if;
  end loop;
  -- Written only when true, so the inputs stored before 1405 (which never carry it) are already in normal form.
  if coalesce(jsonb_typeof(p -> 'retestLabelled'), 'null') not in ('null', 'boolean') then
    raise exception using errcode = 'P0001', message = 'EBMR-REC-020 retestLabelled must be true or false';
  elsif (p ->> 'retestLabelled')::boolean then
    v_out := v_out || jsonb_build_object('retestLabelled', true);
  end if;
  foreach k in array v_dates loop
    if coalesce(jsonb_typeof(p -> k), 'null') = 'null' then
      v_out := v_out || jsonb_build_object(k, null);
    elsif jsonb_typeof(p -> k) = 'string' and (p ->> k) ~ '^\d{4}-\d{2}-\d{2}$' then
      begin
        v_d := (p ->> k)::date;
      exception when others then
        raise exception using errcode = 'P0001', message = format('EBMR-REC-020 %s is not a valid calendar date', k);
      end;
      if to_char(v_d, 'YYYY-MM-DD') <> p ->> k then
        raise exception using errcode = 'P0001', message = format('EBMR-REC-020 %s is not a valid calendar date', k);
      end if;
      v_out := v_out || jsonb_build_object(k, p ->> k);
    else
      raise exception using errcode = 'P0001', message = format('EBMR-REC-020 %s must be a date written YYYY-MM-DD', k);
    end if;
  end loop;
  if (v_out ->> 'euCertificationDate') is not null and (v_out ->> 'euNeverCertified')::boolean then
    raise exception using errcode = 'P0001', message = 'EBMR-REC-020 a batch cannot be both certified and never certified for the EU';
  end if;
  if (v_out ->> 'noLabelledExpiry')::boolean and (v_out ->> 'expiryDate') is not null then
    raise exception using errcode = 'P0001', message = 'EBMR-REC-020 a batch without a labelled expiry has no expiry date';
  end if;
  if (v_out ->> 'expiryDate') is not null and (v_out ->> 'manufactureDate') is not null
     and (v_out ->> 'expiryDate')::date < (v_out ->> 'manufactureDate')::date then
    raise exception using errcode = 'P0001', message = 'EBMR-REC-020 the expiry date lies before the manufacturing date';
  end if;
  return v_out;
end
$$;

reset role;
