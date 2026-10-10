-- Tablets server, Phase 3 slice 4b (builder B): what each entry of the packaging-line blocks TB-23 (bottle line) and
-- TB-24 (secondary and tertiary packaging, finished-pack examination) holds, built in the database exactly as
-- src/blocks/tb-23.ts, tb-24.ts and bottle/common.ts build it (controls PR-37, PR-38, PR-41, PR-42, IN-17, IN-22; ADR
-- 0012). The guard (tablets 0987) compares every new entry with what these functions build and requires the exceptions
-- they name.
--
--   * tab.packline_* : the shared pieces: the last check of a stream, a check missed by the interval, the devices whose last
--     challenge failed (the line is stopped for them), the exceptions a check raises;
--   * tab.bottle_entry: TB-23's kinds (COUNT_CHECK, DESICCANT_CHECK, TORQUE_CHECK, SEAL_CHECK, REJECTS, BRIGHT_STOCK,
--     BRIGHT_STOCK_USE, GOOD_OUTPUT); its CHALLENGE is G-21@1's, built by recipe.g21_entry_data with the step's devices
--     (recipe-core 0580), never a copy;
--   * tab.pack_entry: TB-24's kinds (ATD_CHECK, EXAMINATION, PACKS_MADE, REJECTS, PACK_SAMPLE, SET_ASIDE, RE_ENTRY, SHIPPER,
--     RECONCILIATION), its CHALLENGE as TB-23's.
-- Each returns {data, raise: [{type, item, mode}], verify} or {problem}; a problem names the block's rule code. mode
-- HELD: severity ACTION, a deviation required, the steps after it blocked until one is linked; QA: severity ACTION,
-- QA only, the step unable to complete until QA's disposition (deviation as `deviation` says); RELEASE: as HELD and
-- release-blocking. Counts are whole-number text compared as numeric; instants are epoch microseconds.
--
-- New functions are owned by ebmr_owner, private to it, and pin their search_path with pg_temp last (ADR 0016). Applied
-- as a new migration because applied migrations are checksummed and never edited.

set local role ebmr_owner;

-- The whole number of count text p (NULL when it is none).
create function tab.packline_n(p jsonb) returns numeric
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select case when jsonb_typeof(p) = 'string' and (p #>> '{}') ~ '^(0|[1-9][0-9]{0,17})$' then (p #>> '{}')::numeric end
$$;

-- The decimal of text p (NULL when it is none).
create function tab.packline_dec(p jsonb) returns numeric
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select case when jsonb_typeof(p) = 'string' and (p #>> '{}') ~ '^-?(0|[1-9][0-9]{0,30})(\.[0-9]{1,30})?$' then (p #>> '{}')::numeric end
$$;

-- The last check entry of stream p_stream among p_prior (bottle/common.ts lastCheck: the latest entry whose data names
-- the stream and a result).
create function tab.packline_last_check(p_prior jsonb, p_stream text) returns jsonb
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select e from jsonb_array_elements(case when jsonb_typeof(p_prior) = 'array' then p_prior else '[]'::jsonb end) e
   where e -> 'data' ->> 'stream' = p_stream and jsonb_typeof(e -> 'data' -> 'result') = 'string'
   order by (e ->> 'recordedSeq')::numeric desc limit 1
$$;

-- Whether a check of p_stream at p_now is later than p_every after the stream's previous check (missedNow).
create function tab.packline_missed(p_prior jsonb, p_stream text, p_every numeric, p_now numeric) returns boolean
language sql immutable set search_path = pg_catalog, recipe, tab, pg_temp as $$
  select coalesce(p_every is not null and tab.packline_last_check(p_prior, p_stream) is not null
                  and p_now - recipe.micros_of(tab.packline_last_check(p_prior, p_stream) -> 'recordedAt') > p_every, false)
$$;

-- The devices whose last challenge among p_prior failed, in order (stoppedDevices), or NULL when none.
create function tab.packline_stopped(p_prior jsonb) returns text
language sql immutable set search_path = pg_catalog, recipe, pg_temp as $$
  select string_agg(device, ', ' order by device) from (
    select distinct on (e -> 'data' ->> 'device') e -> 'data' ->> 'device' as device, e -> 'data' ->> 'result' as result
      from jsonb_array_elements(case when jsonb_typeof(p_prior) = 'array' then p_prior else '[]'::jsonb end) e
     where e ->> 'kind' = 'CHALLENGE'
     order by e -> 'data' ->> 'device', recipe.micros_of(e -> 'recordedAt') desc, (e ->> 'recordedSeq')::numeric desc) x
   where result is distinct from 'PASS'
$$;

-- A check's data and exceptions (bottle/common.ts checkExceptions; tb-23.ts and tb-24.ts check).
create function tab.packline_check(p_prior jsonb, p_stream text, p_every numeric, p_now numeric, p_pass boolean, p_data jsonb, p_by jsonb) returns jsonb
language sql immutable set search_path = pg_catalog, tab, pg_temp as $$
  select jsonb_build_object(
    'data', jsonb_build_object('stream', p_stream) || p_data
            || jsonb_build_object('result', case when p_pass then 'PASS' else 'FAIL' end, 'missed', tab.packline_missed(p_prior, p_stream, p_every, p_now), 'checkedBy', p_by),
    'raise', case when tab.packline_missed(p_prior, p_stream, p_every, p_now) then jsonb_build_array(jsonb_build_object('type', 'LINE_CHECK_MISSED', 'item', p_stream, 'mode', 'HELD')) else '[]'::jsonb end
             || case when p_pass then '[]'::jsonb else jsonb_build_array(jsonb_build_object('type', 'LINE_CHECK_FAILED', 'item', p_stream, 'mode', 'HELD')) end,
    'verify', false)
$$;

-- A CHALLENGE of a device of a TB-23 or TB-24 step (G-21@1's rule, recipe-core 0580): its data, and the exceptions that
-- stop the step until QA decides.
create function tab.packline_challenge(p_cfg jsonb, c jsonb, p_prior jsonb, p_markets jsonb, p_now numeric, p_by jsonb) returns jsonb
language plpgsql immutable set search_path = pg_catalog, tab, recipe, pg_temp as $$
declare
  v jsonb := recipe.g21_entry_data(jsonb_build_object('devices', case when jsonb_typeof(p_cfg -> 'devices') = 'array' then p_cfg -> 'devices' else '[]'::jsonb end),
                                    c, 'CHALLENGE', p_prior, p_markets, p_now, p_by);
begin
  if v ? 'problem' then
    return v;
  end if;
  return jsonb_build_object('data', v -> 'data', 'verify', coalesce(v -> 'verify', 'false'::jsonb),
    'raise', case when (v -> 'data' -> 'missed') = 'true'::jsonb then jsonb_build_array(jsonb_build_object('type', 'CHALLENGE_MISSED', 'item', c ->> 'device', 'mode', 'QA', 'deviation', false)) else '[]'::jsonb end
             || case when v -> 'data' ->> 'result' = 'PASS' then '[]'::jsonb else jsonb_build_array(jsonb_build_object('type', 'CHALLENGE_FAILED', 'item', c ->> 'device', 'mode', 'QA', 'deviation', false)) end);
end
$$;

-- Whether every decimal of array p_values lies in limits p_l ({min, max}) (tb-23.ts within).
create function tab.packline_within(p_values jsonb, p_l jsonb) returns boolean
language sql immutable set search_path = pg_catalog, tab, pg_temp as $$
  select tab.packline_dec(p_l -> 'min') is not null and tab.packline_dec(p_l -> 'max') is not null
     and not exists (select 1 from jsonb_array_elements(case when jsonb_typeof(p_values) = 'array' then p_values else '[]'::jsonb end) v
                      where tab.packline_dec(v) is null or tab.packline_dec(v) < tab.packline_dec(p_l -> 'min') or tab.packline_dec(v) > tab.packline_dec(p_l -> 'max'))
$$;

-- The sum of count member p_member of the entries of kind p_kind in p_prior (with data member p_key equal to p_val when given).
create function tab.packline_sum(p_prior jsonb, p_kind text, p_member text, p_key text, p_val jsonb) returns numeric
language sql immutable set search_path = pg_catalog, tab, pg_temp as $$
  select coalesce(sum(tab.packline_n(e -> 'data' -> p_member)), 0)
    from jsonb_array_elements(case when jsonb_typeof(p_prior) = 'array' then p_prior else '[]'::jsonb end) e
   where e ->> 'kind' = p_kind and (p_key is null or e -> 'data' -> p_key = p_val)
$$;

-- ---------------------------------------------------------------------------------------------
-- TB-23

-- PR-37, PR-38, PR-41, IN-17, IN-22: what a TB-23 entry of kind p_kind holds (tb-23.ts acceptEntry), given the step's
-- configuration p_cfg, earlier entries p_prior, the MBR's product p_product ({code, name, strength}), the batch number
-- p_batch_no, the batch's markets, the row's time p_now and the person p_by.
create function tab.bottle_entry(p_kind text, p_cfg jsonb, p_prior jsonb, c jsonb, p_product jsonb, p_batch_no text, p_markets jsonb, p_now numeric, p_by jsonb) returns jsonb
language plpgsql immutable set search_path = pg_catalog, tab, recipe, pg_temp as $$
declare
  v_every numeric := recipe.duration_us(p_cfg -> 'checkEvery');
  v_te    boolean := coalesce((p_cfg -> 'tamperEvident') = 'true'::jsonb, false);
  v_stop  text;
  v_left  numeric;
  v_tag   jsonb;
begin
  case p_kind
    when 'COUNT_CHECK' then
      return tab.packline_check(p_prior, 'COUNT', v_every, p_now,
        not exists (select 1 from jsonb_array_elements(case when jsonb_typeof(c -> 'counts') = 'array' then c -> 'counts' else '[]'::jsonb end) x
                     where x #>> '{}' is distinct from coalesce(p_cfg ->> 'countPerBottle', '')),
        jsonb_build_object('counts', coalesce(c -> 'counts', '[]'::jsonb), 'expected', coalesce(p_cfg ->> 'countPerBottle', '')), p_by);
    when 'DESICCANT_CHECK' then
      if jsonb_typeof(p_cfg -> 'desiccant') is distinct from 'object' then
        return jsonb_build_object('problem', 'checks a desiccant the MBR does not name (TB23-NO-DESICCANT)');
      end if;
      if tab.packline_n(c -> 'missing') is null or tab.packline_n(c -> 'examined') is null or tab.packline_n(c -> 'missing') > tab.packline_n(c -> 'examined') then
        return jsonb_build_object('problem', 'counts more bottles without a desiccant than it examined (TB23-COUNTS)');
      end if;
      return tab.packline_check(p_prior, 'DESICCANT', v_every, p_now, tab.packline_n(c -> 'missing') = 0,
        jsonb_build_object('examined', c -> 'examined', 'missing', c -> 'missing') || case when p_cfg -> 'desiccant' ? 'item' then jsonb_build_object('desiccant', p_cfg -> 'desiccant' -> 'item') else '{}'::jsonb end, p_by);
    when 'TORQUE_CHECK' then
      return tab.packline_check(p_prior, 'TORQUE', v_every, p_now,
        tab.packline_within(c -> 'application', p_cfg -> 'torque' -> 'application') and tab.packline_within(c -> 'removal', p_cfg -> 'torque' -> 'removal'),
        jsonb_build_object('tester', c -> 'tester', 'application', coalesce(c -> 'application', '[]'::jsonb), 'removal', coalesce(c -> 'removal', '[]'::jsonb))
        || case when p_cfg -> 'torque' ? 'unit' then jsonb_build_object('unit', p_cfg -> 'torque' -> 'unit') else '{}'::jsonb end, p_by);
    when 'SEAL_CHECK' then
      if tab.packline_n(c -> 'defective') is null or tab.packline_n(c -> 'examined') is null or tab.packline_n(c -> 'defective') > tab.packline_n(c -> 'examined') then
        return jsonb_build_object('problem', 'counts more defective seals than bottles examined (TB23-COUNTS)');
      end if;
      if v_te <> (jsonb_typeof(c -> 'statementChecked') = 'boolean') then
        return jsonb_build_object('problem', 'states the labelling statement check exactly when the pack is tamper-evident (TB23-TAMPER-EVIDENT; PR-41)');
      end if;
      return tab.packline_check(p_prior, 'SEAL', v_every, p_now, tab.packline_n(c -> 'defective') = 0 and (not v_te or (c -> 'statementChecked') = 'true'::jsonb),
        jsonb_build_object('examined', c -> 'examined', 'defective', c -> 'defective') || case when v_te then jsonb_build_object('statementChecked', c -> 'statementChecked') else '{}'::jsonb end, p_by);
    when 'CHALLENGE' then
      return tab.packline_challenge(p_cfg, c, p_prior, p_markets, p_now, p_by);
    when 'REJECTS' then
      return jsonb_build_object('data', jsonb_build_object('reason', c -> 'reason', 'bottles', c -> 'bottles', 'disposition', 'DESTRUCTION', 'recordedBy', p_by), 'raise', '[]'::jsonb, 'verify', false);
    when 'BRIGHT_STOCK', 'BRIGHT_STOCK_USE', 'GOOD_OUTPUT' then
      if p_kind = 'BRIGHT_STOCK' and (p_cfg -> 'brightStock') is distinct from 'true'::jsonb then
        return jsonb_build_object('problem', 'sets bright stock aside where the MBR does not allow it (TB23-NO-BRIGHT-STOCK; PR-38)');
      end if;
      v_stop := tab.packline_stopped(p_prior);
      if v_stop is not null then
        return jsonb_build_object('problem', format('counts output while %s failed its last challenge: the line is stopped (TB23-STOPPED; IN-22)', v_stop));
      end if;
      if p_kind = 'BRIGHT_STOCK' then
        return jsonb_build_object('data', jsonb_build_object(
          'tag', ((select count(*) from jsonb_array_elements(p_prior) e where e ->> 'kind' = 'BRIGHT_STOCK') + 1)::text,
          'bottles', c -> 'bottles', 'product', jsonb_build_object('code', p_product -> 'code', 'name', p_product -> 'name', 'strength', p_product -> 'strength'),
          'batch', p_batch_no, 'countPerBottle', p_cfg -> 'countPerBottle', 'setAsideBy', p_by), 'raise', '[]'::jsonb, 'verify', false);
      end if;
      if p_kind = 'GOOD_OUTPUT' then
        if exists (select 1 from jsonb_array_elements(p_prior) e where e ->> 'kind' = 'GOOD_OUTPUT') then
          return jsonb_build_object('problem', 'records the good output a second time (TB23-OUTPUT-TWICE)');
        end if;
        return jsonb_build_object('data', jsonb_build_object('bottles', c -> 'bottles', 'recordedBy', p_by), 'raise', '[]'::jsonb, 'verify', false);
      end if;
      v_tag := c -> 'tag';
      if not exists (select 1 from jsonb_array_elements(p_prior) e where e ->> 'kind' = 'BRIGHT_STOCK' and e -> 'data' -> 'tag' = v_tag) then
        return jsonb_build_object('problem', format('labels bright stock %s, which this step never set aside (TB23-BRIGHT-STOCK-TAG; PR-38)', left(coalesce(c ->> 'tag', '(none)'), 32)));
      end if;
      if c ->> 'scannedBatch' is distinct from p_batch_no or c ->> 'scannedProduct' is distinct from p_product ->> 'code' then
        return jsonb_build_object('problem', 'labels bright stock whose scanned batch or product is not this batch''s (TB23-BRIGHT-STOCK-SCAN; PR-38)');
      end if;
      v_left := tab.packline_sum(p_prior, 'BRIGHT_STOCK', 'bottles', 'tag', v_tag) - tab.packline_sum(p_prior, 'BRIGHT_STOCK_USE', 'bottles', 'tag', v_tag);
      if tab.packline_n(c -> 'bottles') is null or tab.packline_n(c -> 'bottles') > v_left then
        return jsonb_build_object('problem', format('labels more bright stock than the %s bottles left under its tag (TB23-BRIGHT-STOCK-QUANTITY; PR-38)', v_left));
      end if;
      return jsonb_build_object('data', jsonb_build_object('tag', v_tag, 'bottles', c -> 'bottles', 'scannedBatch', c -> 'scannedBatch', 'scannedProduct', c -> 'scannedProduct', 'usedBy', p_by),
                                'raise', '[]'::jsonb, 'verify', false);
    else
      return jsonb_build_object('problem', format('is a %s entry, which a bottle line step does not record (TB23-ENTRY)', coalesce(p_kind, 'unnamed')));
  end case;
end
$$;

-- ---------------------------------------------------------------------------------------------
-- TB-24

-- The pack balance of the entries p_prior (tb-24.ts packBalance), judged against limit p_limit.
create function tab.pack_balance(p_prior jsonb, p_limit numeric) returns jsonb
language sql immutable set search_path = pg_catalog, tab, pg_temp as $$
  select jsonb_build_object('made', m::text, 'shipped', s::text, 'rejects', r::text, 'samples', x::text, 'setAside', a::text, 'reEntered', e::text,
                            'unexplained', (m - s - r - x - (a - e))::text, 'withinLimits', abs(m - s - r - x - (a - e)) <= p_limit)
    from (select tab.packline_sum(p_prior, 'PACKS_MADE', 'packs', null, null) m, tab.packline_sum(p_prior, 'SHIPPER', 'packs', null, null) s,
                 tab.packline_sum(p_prior, 'REJECTS', 'packs', null, null) r, tab.packline_sum(p_prior, 'PACK_SAMPLE', 'packs', null, null) x,
                 tab.packline_sum(p_prior, 'SET_ASIDE', 'packs', null, null) a, tab.packline_sum(p_prior, 'RE_ENTRY', 'packs', null, null) e) t
$$;

-- PR-37, PR-41, PR-42, IN-17, IN-22: what a TB-24 entry of kind p_kind holds (tb-24.ts acceptEntry); arguments as
-- tab.bottle_entry.
create function tab.pack_entry(p_kind text, p_cfg jsonb, p_prior jsonb, c jsonb, p_product jsonb, p_batch_no text, p_markets jsonb, p_now numeric, p_by jsonb) returns jsonb
language plpgsql immutable set search_path = pg_catalog, tab, recipe, pg_temp as $$
declare
  v_stop   text;
  v_timing text := c ->> 'timing';
  v_want   numeric;
  v_per    numeric := tab.packline_n(p_cfg -> 'cartonsPerShipper');
  v_bal    jsonb;
  v_part   boolean := coalesce((c -> 'part') = 'true'::jsonb, false);
  v_left   numeric;
begin
  if p_kind in ('PACKS_MADE', 'REJECTS', 'PACK_SAMPLE', 'SET_ASIDE', 'RE_ENTRY', 'SHIPPER')
     and exists (select 1 from jsonb_array_elements(p_prior) e where e ->> 'kind' = 'RECONCILIATION') then
    return jsonb_build_object('problem', 'counts packs after the reconciliation (TB24-RECONCILED; PR-37)');
  end if;
  if p_kind in ('PACKS_MADE', 'SHIPPER') then
    v_stop := tab.packline_stopped(p_prior);
    if v_stop is not null then
      return jsonb_build_object('problem', format('counts output while %s failed its last challenge: the line is stopped (TB24-STOPPED; IN-22)', v_stop));
    end if;
  end if;
  case p_kind
    when 'CHALLENGE' then
      return tab.packline_challenge(p_cfg, c, p_prior, p_markets, p_now, p_by);
    when 'ATD_CHECK' then
      if jsonb_typeof(p_cfg -> 'atd') is distinct from 'object' then
        return jsonb_build_object('problem', 'checks an anti-tampering device the MBR does not configure (TB24-NO-ATD)');
      end if;
      if tab.packline_n(c -> 'defective') is null or tab.packline_n(c -> 'examined') is null or tab.packline_n(c -> 'defective') > tab.packline_n(c -> 'examined') then
        return jsonb_build_object('problem', 'counts more defective than examined (TB24-COUNTS)');
      end if;
      return tab.packline_check(p_prior, 'ATD', recipe.duration_us(p_cfg -> 'atd' -> 'every'), p_now, tab.packline_n(c -> 'defective') = 0,
                            jsonb_build_object('examined', c -> 'examined', 'defective', c -> 'defective'), p_by);
    when 'EXAMINATION' then
      if exists (select 1 from jsonb_array_elements(p_prior) e where e ->> 'kind' = 'EXAMINATION' and e -> 'data' ->> 'timing' = 'END') then
        return jsonb_build_object('problem', 'examines packs after the end-of-run examination (TB24-ENDED)');
      end if;
      if v_timing = 'END' and not exists (select 1 from jsonb_array_elements(p_prior) e where e ->> 'kind' = 'EXAMINATION' and e -> 'data' ->> 'timing' = 'IN_RUN') then
        return jsonb_build_object('problem', 'takes the end-of-run sample before any examination during finishing (TB24-NO-IN-RUN)');
      end if;
      v_want := coalesce(tab.packline_n(p_cfg -> 'examination' -> case when v_timing = 'END' then 'endSample' else 'inRunSample' end), 0);
      if tab.packline_n(c -> 'examined') is null or tab.packline_n(c -> 'examined') < v_want then
        return jsonb_build_object('problem', format('examines fewer packs than the %s the MBR sets (TB24-SAMPLE; PR-37)', v_want));
      end if;
      if tab.packline_n(c -> 'defective') is null or tab.packline_n(c -> 'defective') > tab.packline_n(c -> 'examined') then
        return jsonb_build_object('problem', 'counts more defective than examined (TB24-COUNTS)');
      end if;
      return tab.packline_check(p_prior, 'EXAM', case when v_timing = 'END' then null else recipe.duration_us(p_cfg -> 'examination' -> 'every') end, p_now,
                            tab.packline_n(c -> 'defective') = 0 and (c -> 'labelCorrect') = 'true'::jsonb,
                            jsonb_build_object('timing', v_timing, 'examined', c -> 'examined', 'defective', c -> 'defective', 'labelCorrect', coalesce((c -> 'labelCorrect') = 'true'::jsonb, false)), p_by);
    when 'PACKS_MADE' then
      return jsonb_build_object('data', jsonb_build_object('packs', c -> 'packs', 'recordedBy', p_by), 'raise', '[]'::jsonb, 'verify', false);
    when 'REJECTS' then
      return jsonb_build_object('data', jsonb_build_object('reason', c -> 'reason', 'packs', c -> 'packs', 'disposition', 'DESTRUCTION', 'recordedBy', p_by), 'raise', '[]'::jsonb, 'verify', false);
    when 'PACK_SAMPLE' then
      return jsonb_build_object('data', jsonb_build_object('purpose', c -> 'purpose', 'packs', c -> 'packs', 'takenBy', p_by), 'raise', '[]'::jsonb, 'verify', false);
    when 'SET_ASIDE' then
      if exists (select 1 from jsonb_array_elements(p_prior) e where e ->> 'kind' = 'SET_ASIDE' and e -> 'data' -> 'event' = c -> 'event') then
        return jsonb_build_object('problem', 'sets packs aside a second time under one event (TB24-EVENT-TWICE)');
      end if;
      return jsonb_build_object('data', jsonb_build_object('event', c -> 'event', 'description', c -> 'description', 'packs', c -> 'packs', 'setAsideBy', p_by),
                                'raise', jsonb_build_array(jsonb_build_object('type', 'UNUSUAL_EVENT', 'item', c ->> 'event', 'mode', 'QA', 'deviation', true)), 'verify', false);
    when 'RE_ENTRY' then
      if not exists (select 1 from jsonb_array_elements(p_prior) e where e ->> 'kind' = 'SET_ASIDE' and e -> 'data' -> 'event' = c -> 'event') then
        return jsonb_build_object('problem', 'returns packs of no set-aside event of the step to good output: samples and other units never re-enter (TB24-EVENT; PR-37)');
      end if;
      if c ->> 'inspection' is distinct from 'PASS' then
        return jsonb_build_object('problem', 'returns packs to good output without a passing special inspection (TB24-INSPECTION; PR-37)');
      end if;
      v_left := tab.packline_sum(p_prior, 'SET_ASIDE', 'packs', 'event', c -> 'event') - tab.packline_sum(p_prior, 'RE_ENTRY', 'packs', 'event', c -> 'event');
      if tab.packline_n(c -> 'packs') is null or tab.packline_n(c -> 'packs') > v_left then
        return jsonb_build_object('problem', format('returns more packs than the %s set aside (TB24-RE-ENTRY-QUANTITY)', v_left));
      end if;
      return jsonb_build_object('data', jsonb_build_object('event', c -> 'event', 'packs', c -> 'packs', 'inspection', 'PASS', 'investigation', c -> 'investigation', 'approvedBy', p_by),
                                'raise', '[]'::jsonb, 'verify', true);
    when 'SHIPPER' then
      if coalesce(c ->> 'sscc', '') !~ '^[0-9]{18}$' or left(c ->> 'sscc', length(coalesce(p_cfg ->> 'ssccPrefix', ''))) is distinct from coalesce(p_cfg ->> 'ssccPrefix', '')
         or not tab.gs1_check_ok(c ->> 'sscc') then
        return jsonb_build_object('problem', 'labels a shipper with no SSCC of the MBR''s GS1 prefix with a valid check digit (TB24-SSCC; PR-42)');
      end if;
      if exists (select 1 from jsonb_array_elements(p_prior) e where e ->> 'kind' = 'SHIPPER' and e -> 'data' -> 'sscc' = c -> 'sscc') then
        return jsonb_build_object('problem', 'labels a second shipper with one SSCC (TB24-SSCC-TWICE; PR-42)');
      end if;
      if not v_part and tab.packline_n(c -> 'packs') is distinct from v_per then
        return jsonb_build_object('problem', format('fills a full shipper with other than %s packs (TB24-SHIPPER-COUNT)', v_per));
      end if;
      if v_part and (tab.packline_n(c -> 'packs') >= v_per or exists (select 1 from jsonb_array_elements(p_prior) e where e ->> 'kind' = 'SHIPPER' and (e -> 'data' -> 'part') = 'true'::jsonb)) then
        return jsonb_build_object('problem', 'marks a second part shipper, or a full one as part (TB24-PART-SHIPPER)');
      end if;
      return jsonb_build_object('data', jsonb_build_object('sscc', c -> 'sscc', 'packs', c -> 'packs', 'part', v_part,
                                                           'label', jsonb_build_object('sscc', c -> 'sscc', 'batch', p_batch_no, 'product', p_product -> 'code', 'name', p_product -> 'name',
                                                                                       'strength', p_product -> 'strength', 'packs', c -> 'packs'),
                                                           'labelledBy', p_by), 'raise', '[]'::jsonb, 'verify', false);
    when 'RECONCILIATION' then
      if exists (select 1 from jsonb_array_elements(p_prior) e where e ->> 'kind' = 'RECONCILIATION') then
        return jsonb_build_object('problem', 'reconciles the packs a second time (TB24-RECONCILED)');
      end if;
      v_bal := tab.pack_balance(p_prior, coalesce(tab.packline_n(p_cfg -> 'maxUnexplained'), 0));
      return jsonb_build_object('data', v_bal || jsonb_build_object('reconciledBy', p_by),
                                'raise', case when (v_bal -> 'withinLimits') = 'true'::jsonb then '[]'::jsonb
                                              else jsonb_build_array(jsonb_build_object('type', 'PACK_RECONCILIATION', 'item', 'PACKS', 'mode', 'RELEASE')) end,
                                'verify', false);
    else
      return jsonb_build_object('problem', format('is a %s entry, which a secondary packaging step does not record (TB24-ENTRY)', coalesce(p_kind, 'unnamed')));
  end case;
end
$$;

revoke all on function tab.packline_n(jsonb), tab.packline_dec(jsonb), tab.packline_last_check(jsonb, text), tab.packline_missed(jsonb, text, numeric, numeric), tab.packline_stopped(jsonb),
  tab.packline_check(jsonb, text, numeric, numeric, boolean, jsonb, jsonb), tab.packline_challenge(jsonb, jsonb, jsonb, jsonb, numeric, jsonb), tab.packline_within(jsonb, jsonb),
  tab.packline_sum(jsonb, text, text, text, jsonb), tab.bottle_entry(text, jsonb, jsonb, jsonb, jsonb, text, jsonb, numeric, jsonb), tab.pack_balance(jsonb, numeric),
  tab.pack_entry(text, jsonb, jsonb, jsonb, jsonb, text, jsonb, numeric, jsonb) from public;

reset role;
