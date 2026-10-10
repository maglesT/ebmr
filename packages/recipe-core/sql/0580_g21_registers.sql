-- Recipe core, Phase 3 slice 4a (builder B): the block version G-21@1 (printed materials, coding, challenges and
-- serialisation; tablets spec K-19 to K-21; outline 5.2.8 L-29, L-53) in the database's own registers, and the data each
-- of its entries holds (controls PR-32, PR-33, PR-36, PR-37, PR-39, PR-40, PR-42, IN-17, IN-22, INV-32, DI-05, DI-30;
-- ADR 0012: the rules hold when the application's own database credentials are used directly).
--
--   * recipe.block_data_schema: the data schema of each entry kind of G-21@1 (ISSUE, RECONCILIATION, FIRST_PRINT,
--     CHALLENGE, SERIAL_POOL, SERIAL_RECONCILIATION) as blocks/generic/printed.ts declares them (the parity test
--     test/execution/entry-data-sql.test.ts compares them);
--   * recipe.engine_name: the block type G-21 and its rule codes (a test run's record may hold them, 0346);
--   * recipe.g21_entry_data: what the block builds from an entry, rule for rule as printed.ts: an ISSUE of a configured
--     item from a released, unexpired lot of the item's material whose artwork is the one scanned at the line and the
--     one the master names for the pack's markets (those of the batch it names one for), in the item's unit, the issued total within the issue rule
--     (need plus allowance), counted as the item says (a manual count needs a second person); a RECONCILIATION of each
--     item once, its unexplained balance computed here from what was issued (issued - used - set-up waste - damaged -
--     coded destroyed - uncoded returned - specimens) and judged against the item's limits (INV-32, IN-17), coded surplus
--     only for an item coded on the line; a FIRST_PRINT of a configured printer; a CHALLENGE of a configured inspection
--     device, naming the gateway's result exactly when the device reports through the gateway (else two persons), and
--     missed when its interval ran out since its last passing challenge; a SERIAL_POOL per serialised market of the
--     batch with the master's GTIN; a SERIAL_RECONCILIATION of a pool of the step, closed only with zero unexplained
--     and every serial accounted for (PR-42);
--   * recipe.entry_block_problem, replaced from its latest definition (0520) with only the G-21 branch added: an entry of
--     a G-21 step holds exactly what g21_entry_data builds (TB-17 records a CHALLENGE of its own, so the branch is
--     chosen by the step's block, never by the kind alone).
-- What the entries stand on in the edition (the lot register and its artwork, print jobs and gateway events, the L3
-- pools) is the edition's (tablets 0950 to 0952); the exceptions, step close and holds are 0581's.
--
-- New functions are owned by ebmr_owner and private to the owner; every function pins its search_path with pg_temp
-- last. Applied as a new migration because applied migrations are checksummed and never edited.

set local role ebmr_owner;

select kernel.set_actor_context(jsonb_build_object(
  'person_id', '00000000-0000-0000-0000-000000000000', 'account_id', '00000000-0000-0000-0000-000000000000',
  'role_code', 'SOFTWARE_RELEASE', 'session_id', '00000000-0000-0000-0000-000000000000', 'source', 'SYSTEM',
  'site_zone', 'UTC', 'correlation_id', gen_random_uuid(),
  'legal_name', 'Software release (recipe-core migration 0580_g21_registers)',
  'reason_code', 'SOFTWARE_RELEASE',
  'reason_text', 'the block version G-21@1 of Phase 3 slice 4a in the registers every entry is checked against (DI-30, DI-05)'));

insert into recipe.block_data_schema (block_type, block_version, part, entry_kind, schema) values
  ('G-21', '1', 'ENTRY', 'ISSUE', '{"type":"object","fields":{"item":{"type":"string"},"lot":{"type":"object","fields":{"id":{"type":"string"},"material":{"type":"string"},"status":{"type":"string","enum":["RELEASED","QUARANTINE","ON_TEST","REJECTED","ON_HOLD","RECALLED","RETURNED","EXPIRED"]},"artwork":{"type":"string"},"expiresAtUs":{"type":"string","pattern":"^[0-9]{1,20}$","optional":true}}},"scannedArtwork":{"type":"string"},"quantity":{"type":"object","fields":{"value":{"type":"decimal"},"unit":{"type":"string"}}}}}'),
  ('G-21', '1', 'ENTRY', 'RECONCILIATION', '{"type":"object","fields":{"item":{"type":"string"},"used":{"type":"decimal","min":"0"},"setupWaste":{"type":"decimal","min":"0"},"damaged":{"type":"decimal","min":"0"},"codedDestroyed":{"type":"decimal","min":"0"},"uncodedReturned":{"type":"decimal","min":"0"},"specimens":{"type":"decimal","min":"0"}}}'),
  ('G-21', '1', 'ENTRY', 'FIRST_PRINT', '{"type":"object","fields":{"device":{"type":"string"},"job":{"type":"string","pattern":"^[!-~]{1,64}$"},"approved":{"type":"boolean"},"specimen":{"type":"string","pattern":"^[0-9a-f]{64}$","optional":true}}}'),
  ('G-21', '1', 'ENTRY', 'CHALLENGE', '{"type":"object","fields":{"device":{"type":"string"},"trigger":{"type":"string","enum":["START","INTERVAL","STOPPAGE","REEL_CHANGE","END"]},"result":{"type":"string","enum":["PASS","FAIL"]},"event":{"type":"string","pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$","optional":true},"at":{"type":"string","pattern":"^[0-9]{1,20}$","optional":true}}}'),
  ('G-21', '1', 'ENTRY', 'SERIAL_POOL', '{"type":"object","fields":{"poolId":{"type":"string","pattern":"^[!-~]{1,64}$"},"market":{"type":"string"},"gtin":{"type":"string","pattern":"^[0-9]{14}$"},"quantity":{"type":"string","pattern":"^(0|[1-9][0-9]{0,17})$"}}}'),
  ('G-21', '1', 'ENTRY', 'SERIAL_RECONCILIATION', '{"type":"object","fields":{"poolId":{"type":"string","pattern":"^[!-~]{1,64}$"},"commissioned":{"type":"string","pattern":"^(0|[1-9][0-9]{0,17})$"},"decommissioned":{"type":"string","pattern":"^(0|[1-9][0-9]{0,17})$"},"destroyed":{"type":"string","pattern":"^(0|[1-9][0-9]{0,17})$"},"samples":{"type":"string","pattern":"^(0|[1-9][0-9]{0,17})$"},"unusedReturned":{"type":"string","pattern":"^(0|[1-9][0-9]{0,17})$"},"unexplained":{"type":"string","pattern":"^(0|[1-9][0-9]{0,17})$"},"reportHash":{"type":"string","pattern":"^[0-9a-f]{64}$"}}}');


insert into recipe.engine_name (name, kind) values
  ('G-21', 'BLOCK_TYPE'),
  ('G21-APPROVER', 'RULE_CODE'),
  ('G21-ARTWORK', 'RULE_CODE'),
  ('G21-ARTWORK-MARKET', 'RULE_CODE'),
  ('G21-CHALLENGE-DUE', 'RULE_CODE'),
  ('G21-DESTRUCTION-STEP', 'RULE_CODE'),
  ('G21-DEVICE', 'RULE_CODE'),
  ('G21-DUPLICATE', 'RULE_CODE'),
  ('G21-ENTRY', 'RULE_CODE'),
  ('G21-EVENT', 'RULE_CODE'),
  ('G21-EVENT-ORDER', 'RULE_CODE'),
  ('G21-GTIN', 'RULE_CODE'),
  ('G21-GTIN-CHECK', 'RULE_CODE'),
  ('G21-INTERVAL', 'RULE_CODE'),
  ('G21-ITEM', 'RULE_CODE'),
  ('G21-LOT-EXPIRED', 'RULE_CODE'),
  ('G21-LOT-STATUS', 'RULE_CODE'),
  ('G21-MARKET', 'RULE_CODE'),
  ('G21-MATERIAL', 'RULE_CODE'),
  ('G21-NO-FIRST-PRINT', 'RULE_CODE'),
  ('G21-NO-LIMITS', 'RULE_CODE'),
  ('G21-NO-POOL', 'RULE_CODE'),
  ('G21-NO-UNIT', 'RULE_CODE'),
  ('G21-NOT-CODED', 'RULE_CODE'),
  ('G21-NOT-RECONCILED', 'RULE_CODE'),
  ('G21-OVER-ISSUE', 'RULE_CODE'),
  ('G21-POOL-TWICE', 'RULE_CODE'),
  ('G21-POOL-UNKNOWN', 'RULE_CODE'),
  ('G21-QUANTITY', 'RULE_CODE'),
  ('G21-RECONCILED', 'RULE_CODE'),
  ('G21-RECONCILED-TWICE', 'RULE_CODE'),
  ('G21-SCAN', 'RULE_CODE'),
  ('G21-SERIAL-GTIN', 'RULE_CODE'),
  ('G21-SERIALS-OPEN', 'RULE_CODE'),
  ('G21-UNIT', 'RULE_CODE');

select kernel.set_actor_context(null);

-- The decimal of text p (a decimal literal), or NULL.
create function recipe.g21_dec(p jsonb) returns numeric
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select case when jsonb_typeof(p) = 'string' and (p #>> '{}') ~ '^-?(0|[1-9][0-9]{0,30})(\.[0-9]{1,30})?$' then (p #>> '{}')::numeric end
$$;

-- When recorded challenge entry p_e was taken: the gateway result's source time (data.at), else when it was recorded.
create function recipe.g21_challenge_time(p_e jsonb) returns numeric
language sql immutable set search_path = pg_catalog, recipe, pg_temp as $$
  select case when jsonb_typeof(p_e -> 'data' -> 'at') = 'string' and (p_e -> 'data' ->> 'at') ~ '^[0-9]{1,20}$' then (p_e -> 'data' ->> 'at')::numeric
              else recipe.micros_of(p_e -> 'recordedAt') end
$$;

-- The element of configuration array p_cfg -> p_member whose id is p_id, or NULL.
create function recipe.g21_cfg_member(p_cfg jsonb, p_member text, p_id jsonb) returns jsonb
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select x from jsonb_array_elements(case when jsonb_typeof(p_cfg -> p_member) = 'array' then p_cfg -> p_member else '[]'::jsonb end) x
   where x -> 'id' = p_id limit 1
$$;

-- PR-32, PR-33, PR-36, PR-37, PR-39, PR-40, PR-42, IN-17, IN-22, INV-32 (G-21): the data an entry p_c of kind p_kind
-- holds at a step configured with p_cfg, given the step instance's earlier entries p_prior (an array of entry records),
-- the batch's market set p_markets, the row's time p_now_us and the person p_by: {"data": ..., "verify": bool}, or why the
-- block refuses it ({"problem": ...}); blocks/generic/printed.ts acceptEntry, rule for rule and in its order.
create function recipe.g21_entry_data(p_cfg jsonb, p_c jsonb, p_kind text, p_prior jsonb, p_markets jsonb, p_now_us numeric, p_by jsonb) returns jsonb
language plpgsql immutable set search_path = pg_catalog, recipe, pg_temp as $$
declare
  v_item    jsonb;
  v_dev     jsonb;
  v_lot     jsonb;
  v_q       numeric;
  v_total   numeric;
  v_issued  numeric;
  v_itext   text;
  v_parts   numeric;
  v_scale   integer;
  v_u       numeric;
  v_ok      boolean;
  v_ok2     boolean;
  v_at      numeric;
  v_last    numeric;
  v_every   numeric;
  v_missed  boolean;
  v_pool    jsonb;
  v_closed  boolean;
  v_m       text;
  v_wrong   text;
  v_data    jsonb;
  p         text;
  v_prior   jsonb := case when jsonb_typeof(p_prior) = 'array' then p_prior else '[]'::jsonb end;
  v_mk      jsonb := case when jsonb_typeof(p_markets) = 'array' then p_markets else '[]'::jsonb end;
begin
  case p_kind
    when 'ISSUE' then
      v_item := recipe.g21_cfg_member(p_cfg, 'items', p_c -> 'item');
      if v_item is null then
        return jsonb_build_object('problem', format('issues %s, which is no printed item of its step (G21-ITEM)', coalesce(p_c ->> 'item', '(none)')));
      end if;
      if exists (select 1 from jsonb_array_elements(v_prior) e where e ->> 'kind' = 'RECONCILIATION' and e -> 'data' -> 'item' = p_c -> 'item') then
        return jsonb_build_object('problem', format('issues %s, which is reconciled already (G21-RECONCILED)', p_c ->> 'item'));
      end if;
      v_lot := case when jsonb_typeof(p_c -> 'lot') = 'object' then p_c -> 'lot' else '{}'::jsonb end;
      if v_lot ->> 'status' is distinct from 'RELEASED' then
        return jsonb_build_object('problem', format('issues from lot %s, which is %s: printed material comes only from released lots (G21-LOT-STATUS)', coalesce(v_lot ->> 'id', '(none)'), coalesce(lower(v_lot ->> 'status'), 'of no status')));
      end if;
      if jsonb_typeof(v_lot -> 'expiresAtUs') = 'string' and (v_lot ->> 'expiresAtUs') ~ '^[0-9]{1,20}$' and (v_lot ->> 'expiresAtUs')::numeric <= p_now_us then
        return jsonb_build_object('problem', format('issues from lot %s, which is past its expiry date (G21-LOT-EXPIRED)', v_lot ->> 'id'));
      end if;
      if (v_lot -> 'material') is distinct from (v_item -> 'material') then
        return jsonb_build_object('problem', format('issues lot %s of %s as %s (G21-MATERIAL)', v_lot ->> 'id', coalesce(v_lot ->> 'material', '(none)'), v_item ->> 'material'));
      end if;
      if (p_c -> 'scannedArtwork') is distinct from (v_lot -> 'artwork') then
        return jsonb_build_object('problem', format('scans artwork %s at the line for lot %s, which carries %s (G21-SCAN)', coalesce(p_c ->> 'scannedArtwork', '(none)'), v_lot ->> 'id', coalesce(v_lot ->> 'artwork', '(none)')));
      end if;
      -- Every market of the batch names the artwork of the pack, and each is the lot's (review 4a HIGH 2).
      select string_agg(format('%s for %s', coalesce(v_item -> 'artwork' ->> m.v, 'none'), m.v), ', ' order by m.i) into v_wrong
        from jsonb_array_elements_text(v_mk) with ordinality m (v, i)
       where (case when jsonb_typeof(v_item -> 'artwork') = 'object' then v_item -> 'artwork' -> m.v end) is distinct from (v_lot -> 'artwork');
      if v_wrong is not null then
        return jsonb_build_object('problem', format('issues lot %s with artwork %s, where the master names %s (G21-ARTWORK)', v_lot ->> 'id', coalesce(v_lot ->> 'artwork', '(none)'), v_wrong));
      end if;
      if (p_c -> 'quantity' -> 'unit') is distinct from (v_item -> 'unit') then
        return jsonb_build_object('problem', format('issues %s in %s, not in %s (G21-UNIT)', p_c ->> 'item', coalesce(p_c -> 'quantity' ->> 'unit', '(none)'), v_item ->> 'unit'));
      end if;
      v_q := recipe.g21_dec(p_c -> 'quantity' -> 'value');
      if v_q is null or v_q <= 0 then
        return jsonb_build_object('problem', format('issues %s with a quantity that is not positive (G21-QUANTITY)', p_c ->> 'item'));
      end if;
      select coalesce(sum(recipe.g21_dec(e -> 'data' -> 'quantity' -> 'value')), 0) + v_q into v_total
        from jsonb_array_elements(v_prior) e where e ->> 'kind' = 'ISSUE' and e -> 'data' -> 'item' = p_c -> 'item';
      if recipe.g21_dec(v_item -> 'issue' -> 'need') is null or recipe.g21_dec(v_item -> 'issue' -> 'allowancePercent') is null
         or v_total * 100 > recipe.g21_dec(v_item -> 'issue' -> 'need') * (100 + recipe.g21_dec(v_item -> 'issue' -> 'allowancePercent')) then
        return jsonb_build_object('problem', format('issues %s up to %s %s, above the rule of %s plus %s %% (G21-OVER-ISSUE)', p_c ->> 'item', v_total, v_item ->> 'unit',
                                                    v_item -> 'issue' ->> 'need', v_item -> 'issue' ->> 'allowancePercent'));
      end if;
      return jsonb_build_object('data', jsonb_build_object('item', p_c -> 'item', 'lot', p_c -> 'lot', 'artwork', p_c -> 'scannedArtwork',
                                                           'quantity', jsonb_build_object('value', p_c -> 'quantity' -> 'value', 'unit', p_c -> 'quantity' -> 'unit'),
                                                           'counting', v_item -> 'counting', 'issuedBy', p_by),
                                'verify', (v_item ->> 'counting') = 'MANUAL_COUNT');
    when 'RECONCILIATION' then
      v_item := recipe.g21_cfg_member(p_cfg, 'items', p_c -> 'item');
      if v_item is null then
        return jsonb_build_object('problem', format('reconciles %s, which is no printed item of its step (G21-ITEM)', coalesce(p_c ->> 'item', '(none)')));
      end if;
      if exists (select 1 from jsonb_array_elements(v_prior) e where e ->> 'kind' = 'RECONCILIATION' and e -> 'data' -> 'item' = p_c -> 'item') then
        return jsonb_build_object('problem', format('reconciles %s a second time (G21-RECONCILED-TWICE)', p_c ->> 'item'));
      end if;
      if (v_item -> 'coded') is distinct from 'true'::jsonb and coalesce(recipe.g21_dec(p_c -> 'codedDestroyed'), 0) <> 0 then
        return jsonb_build_object('problem', format('reconciles coded %s, which is not printed on the line (G21-NOT-CODED)', p_c ->> 'item'));
      end if;
      select sum(recipe.g21_dec(e -> 'data' -> 'quantity' -> 'value')) into v_issued
        from jsonb_array_elements(v_prior) e where e ->> 'kind' = 'ISSUE' and e -> 'data' -> 'item' = p_c -> 'item';
      v_issued := coalesce(v_issued, 0);
      v_parts := 0;
      v_scale := scale(v_issued);
      foreach p in array array['used', 'setupWaste', 'damaged', 'codedDestroyed', 'uncodedReturned', 'specimens'] loop
        if recipe.g21_dec(p_c -> p) is null then
          return jsonb_build_object('problem', format('reconciles %s without its %s (G21-ITEM)', p_c ->> 'item', p));
        end if;
        v_parts := v_parts + recipe.g21_dec(p_c -> p);
        v_scale := greatest(v_scale, scale(recipe.g21_dec(p_c -> p)));
      end loop;
      v_u := round(v_issued - v_parts, v_scale);
      v_ok := (recipe.g21_dec(v_item -> 'limits' -> 'maxUnexplained') is null or abs(v_u) <= recipe.g21_dec(v_item -> 'limits' -> 'maxUnexplained'))
              and (recipe.g21_dec(v_item -> 'limits' -> 'maxUnexplainedPercent') is null or abs(v_u) * 100 <= recipe.g21_dec(v_item -> 'limits' -> 'maxUnexplainedPercent') * v_issued);
      v_data := jsonb_build_object('item', p_c -> 'item');
      foreach p in array array['used', 'setupWaste', 'damaged', 'codedDestroyed', 'uncodedReturned', 'specimens'] loop
        v_data := v_data || jsonb_build_object(p, p_c -> p);
      end loop;
      -- Review 4a MEDIUM 5: a coded item printed by a gateway printer is counted by the device, else typed (two persons).
      v_ok2 := (v_item -> 'coded') = 'true'::jsonb
               and exists (select 1 from jsonb_array_elements(case when jsonb_typeof(p_cfg -> 'devices') = 'array' then p_cfg -> 'devices' else '[]'::jsonb end) x
                            where x ->> 'kind' = 'PRINTER' and jsonb_typeof(x -> 'serial') = 'string');
      return jsonb_build_object('data', v_data || jsonb_build_object('unit', v_item -> 'unit', 'issued', v_issued::text, 'unexplained', v_u::text,
                                                                      'withinLimits', v_ok, 'counted', case when v_ok2 then 'DEVICE' else 'TYPED' end, 'reconciledBy', p_by),
                                'verify', not v_ok2);
    when 'FIRST_PRINT' then
      v_dev := recipe.g21_cfg_member(p_cfg, 'devices', p_c -> 'device');
      if v_dev is null or v_dev ->> 'kind' is distinct from 'PRINTER' then
        return jsonb_build_object('problem', format('approves the first print of %s, which is no printer of its step (G21-DEVICE)', coalesce(p_c ->> 'device', '(none)')));
      end if;
      return jsonb_build_object('data', jsonb_build_object('device', p_c -> 'device', 'job', p_c -> 'job', 'approved', coalesce((p_c -> 'approved') = 'true'::jsonb, false))
                                        || case when jsonb_typeof(p_c -> 'specimen') = 'string' then jsonb_build_object('specimen', p_c -> 'specimen') else '{}'::jsonb end
                                        || jsonb_build_object('approvedBy', p_by),
                                'verify', false);
    when 'CHALLENGE' then
      v_dev := recipe.g21_cfg_member(p_cfg, 'devices', p_c -> 'device');
      if v_dev is null or v_dev ->> 'kind' = 'PRINTER' then
        return jsonb_build_object('problem', format('challenges %s, which is no inspection device of its step (G21-DEVICE)', coalesce(p_c ->> 'device', '(none)')));
      end if;
      if coalesce(jsonb_typeof(v_dev -> 'serial') = 'string', false) <> coalesce(jsonb_typeof(p_c -> 'event') = 'string', false)
         or (jsonb_typeof(v_dev -> 'serial') is distinct from 'string' and p_c ? 'at') then
        return jsonb_build_object('problem', format('challenges %s %s the gateway''s result; a gateway device''s challenge names it and only such a device''s (G21-EVENT)', p_c ->> 'device',
                                                    case when jsonb_typeof(p_c -> 'event') = 'string' then 'naming' else 'without' end));
      end if;
      -- Review 4a HIGH 1: a gateway device's challenge is timed by the device's result (at), never later than now and in
      -- the device's order; missed is read from those times.
      v_at := case when jsonb_typeof(p_c -> 'at') = 'string' and (p_c ->> 'at') ~ '^[0-9]{1,20}$' then (p_c ->> 'at')::numeric end;
      if jsonb_typeof(v_dev -> 'serial') = 'string' and (v_at is null or v_at > p_now_us) then
        return jsonb_build_object('problem', format('challenges %s without the time the device took it, or later than now (G21-EVENT)', p_c ->> 'device'));
      end if;
      v_at := coalesce(v_at, p_now_us);
      if exists (select 1 from jsonb_array_elements(v_prior) e
                  where e ->> 'kind' = 'CHALLENGE' and e -> 'data' -> 'device' = p_c -> 'device' and recipe.g21_challenge_time(e) > v_at) then
        return jsonb_build_object('problem', format('challenges %s out of the order the device took its challenges (G21-EVENT-ORDER)', p_c ->> 'device'));
      end if;
      select max(recipe.g21_challenge_time(e)) into v_last
        from jsonb_array_elements(v_prior) e
       where e ->> 'kind' = 'CHALLENGE' and e -> 'data' -> 'device' = p_c -> 'device' and e -> 'data' ->> 'result' = 'PASS';
      v_every := recipe.duration_us(v_dev -> 'every');
      v_missed := v_last is not null and v_every is not null and v_at - v_last > v_every;
      return jsonb_build_object('data', jsonb_build_object('device', p_c -> 'device', 'trigger', p_c -> 'trigger', 'result', p_c -> 'result')
                                        || case when jsonb_typeof(p_c -> 'event') = 'string' then jsonb_build_object('event', p_c -> 'event') else '{}'::jsonb end
                                        || case when p_c ? 'at' then jsonb_build_object('at', p_c -> 'at') else '{}'::jsonb end
                                        || jsonb_build_object('missed', v_missed, 'challengedBy', p_by),
                                'verify', jsonb_typeof(v_dev -> 'serial') is distinct from 'string');
    when 'SERIAL_POOL' then
      v_m := p_c ->> 'market';
      if not exists (select 1 from jsonb_array_elements(case when jsonb_typeof(p_cfg -> 'serialisation' -> 'markets') = 'array' then p_cfg -> 'serialisation' -> 'markets' else '[]'::jsonb end) x where x #>> '{}' = v_m)
         or not exists (select 1 from jsonb_array_elements(v_mk) x where x #>> '{}' = v_m) then
        return jsonb_build_object('problem', format('records a pool for %s, which is no serialised market of its step and batch (G21-MARKET)', coalesce(v_m, '(none)')));
      end if;
      if (case when jsonb_typeof(p_cfg -> 'markets' -> v_m) = 'object' then p_cfg -> 'markets' -> v_m -> 'gtin' end) is distinct from (p_c -> 'gtin') then
        return jsonb_build_object('problem', format('records a pool for GTIN %s, not the master''s for %s (G21-GTIN)', coalesce(p_c ->> 'gtin', '(none)'), v_m));
      end if;
      if exists (select 1 from jsonb_array_elements(v_prior) e where e ->> 'kind' = 'SERIAL_POOL' and (e -> 'data' ->> 'market' = v_m or e -> 'data' -> 'poolId' = p_c -> 'poolId')) then
        return jsonb_build_object('problem', format('records a second pool for %s (G21-POOL-TWICE)', v_m));
      end if;
      return jsonb_build_object('data', jsonb_build_object('poolId', p_c -> 'poolId', 'market', p_c -> 'market', 'gtin', p_c -> 'gtin', 'quantity', p_c -> 'quantity', 'recordedBy', p_by),
                                'verify', false);
    when 'SERIAL_RECONCILIATION' then
      select e into v_pool from jsonb_array_elements(v_prior) e where e ->> 'kind' = 'SERIAL_POOL' and e -> 'data' -> 'poolId' = p_c -> 'poolId' limit 1;
      if v_pool is null then
        return jsonb_build_object('problem', format('reconciles %s, which is no serial pool of its step (G21-POOL-UNKNOWN)', coalesce(p_c ->> 'poolId', '(none)')));
      end if;
      v_total := 0;
      foreach p in array array['commissioned', 'decommissioned', 'destroyed', 'samples', 'unusedReturned', 'unexplained'] loop
        if jsonb_typeof(p_c -> p) is distinct from 'string' or (p_c ->> p) !~ '^(0|[1-9][0-9]{0,17})$' then
          return jsonb_build_object('problem', format('reconciles pool %s without a count of %s (G21-POOL-UNKNOWN)', p_c ->> 'poolId', p));
        end if;
        if p <> 'unexplained' then
          v_total := v_total + (p_c ->> p)::numeric;
        end if;
      end loop;
      v_closed := (p_c ->> 'unexplained')::numeric = 0 and v_total = recipe.g21_dec(v_pool -> 'data' -> 'quantity');
      v_data := jsonb_build_object('poolId', p_c -> 'poolId');
      foreach p in array array['commissioned', 'decommissioned', 'destroyed', 'samples', 'unusedReturned', 'unexplained', 'reportHash'] loop
        v_data := v_data || jsonb_build_object(p, p_c -> p);
      end loop;
      return jsonb_build_object('data', v_data || jsonb_build_object('quantity', v_pool -> 'data' -> 'quantity', 'closed', coalesce(v_closed, false), 'reconciledBy', p_by),
                                'verify', false);
    else
      return jsonb_build_object('problem', format('is a %s entry, which a printed-materials step does not record (G21-ENTRY)', coalesce(p_kind, 'unnamed')));
  end case;
end
$$;

-- As 0520 (the latest), with the G-21 branch (header).
create or replace function recipe.entry_block_problem(p_content jsonb, p_old jsonb, p_new jsonb, p_command jsonb) returns text
language plpgsql immutable set search_path = pg_catalog, recipe, pg_temp as $$
declare
  e0        jsonb := case when jsonb_typeof(p_old -> 'entries') = 'object' then p_old -> 'entries' else '{}'::jsonb end;
  e1        jsonb := case when jsonb_typeof(p_new -> 'entries') = 'object' then p_new -> 'entries' else '{}'::jsonb end;
  v_now     jsonb := p_new -> 'lastRecordedUs';
  v_now_us  numeric := recipe.micros_of(p_new -> 'lastRecordedUs');
  v_seq0    numeric := case when jsonb_typeof(p_old -> 'seq') = 'number' then (p_old ->> 'seq')::numeric else 0 end;
  v_seq1    numeric := case when jsonb_typeof(p_new -> 'seq') = 'number' then (p_new ->> 'seq')::numeric end;
  v_product jsonb := p_content -> 'header' -> 'product' -> 'code';
  v_batch   jsonb := p_new -> 'header' -> 'batchNumber';
  k         text;
  e         jsonb;
  d         jsonb;
  c         jsonb;
  v_inst    jsonb;
  v_node    jsonb;
  v_cfg     jsonb;
  v_rp      jsonb;
  v_ref     jsonb;
  v_by      jsonb;
  v_want    jsonb;
  v_what    text;
  v_member  text;
  v_problem text;
  v_ids     text[];
  v_items   jsonb;
  v_sub     jsonb;
  v_n       bigint;
  v_cat     text;
  v_verify  boolean;
begin
  for k, e in select x.key, x.value from jsonb_each(e1) x where not (e0 ? x.key) order by x.key loop
    v_what := format('entry %s (%s) of step %s', k, coalesce(e ->> 'kind', 'unnamed'), coalesce(e ->> 'stepKey', '(none)'));
    -- The entry record the engine writes (steps.ts recordEntry, startStep): its own id, the row's time, its event.
    if jsonb_typeof(e) is distinct from 'object' then
      return format('stores %s, which is no entry record', v_what);
    end if;
    if (e - 'id' - 'stepKey' - 'kind' - 'data' - 'enteredBy' - 'recordedAt' - 'recordedSeq') <> '{}'::jsonb then
      return format('stores %s with members the engine does not write (%s)', v_what,
                    (select string_agg(m, ', ' order by m) from jsonb_object_keys(e - 'id' - 'stepKey' - 'kind' - 'data' - 'enteredBy' - 'recordedAt' - 'recordedSeq') m));
    end if;
    if (e -> 'id') is distinct from to_jsonb(k) then
      return format('stores %s under another id (%s)', v_what, coalesce(e ->> 'id', '(none)'));
    end if;
    if (e -> 'recordedAt') is distinct from v_now or v_now is null then
      return format('stores %s recorded at %s, not at the row''s trusted time %s', v_what, coalesce(recipe.micros_of(e -> 'recordedAt')::text, '(none)'), coalesce(v_now_us::text, '(none)'));
    end if;
    if jsonb_typeof(e -> 'recordedSeq') is distinct from 'number' or (e ->> 'recordedSeq')::numeric <= v_seq0 or v_seq1 is null or (e ->> 'recordedSeq')::numeric > v_seq1 then
      return format('stores %s with recordedSeq %s, which is not an event of this row (after %s, up to %s)', v_what, coalesce(e ->> 'recordedSeq', '(none)'), v_seq0, coalesce(v_seq1::text, '(none)'));
    end if;
    d := case when jsonb_typeof(e -> 'data') = 'object' then e -> 'data' else '{}'::jsonb end;
    c := case when e ->> 'kind' = 'START_DATA' then p_command -> 'blockData' else p_command -> 'entry' end;
    c := case when jsonb_typeof(c) = 'object' then c else '{}'::jsonb end;
    v_by := e -> 'enteredBy';
    v_inst := p_new -> 'steps' -> (e ->> 'stepKey');
    v_node := recipe.step_node(p_content, v_inst ->> 'step');
    v_cfg := case when jsonb_typeof(v_node -> 'config') = 'object' then v_node -> 'config' else '{}'::jsonb end;
    v_rp := v_node -> 'reprocessing';
    v_want := null;
    v_verify := false;
    if v_node -> 'block' ->> 'type' = 'G-21' and e ->> 'kind' <> 'START_DATA' then
      -- G-21 (0580): what blocks/generic/printed.ts builds from the entry, its step's configuration, the step instance's
      -- earlier entries, the batch's market set, the row's time and the person. Gated by the block, as TB-17 records a
      -- CHALLENGE of its own.
      v_ref := recipe.g21_entry_data(v_cfg, c, e ->> 'kind',
                                     (select coalesce(jsonb_agg(x.value order by x.key), '[]'::jsonb) from jsonb_each(e0) x where x.value ->> 'stepKey' = e ->> 'stepKey'),
                                     p_new -> 'header' -> 'marketSet', v_now_us, v_by);
      if v_ref ? 'problem' then
        return format('stores %s that %s', v_what, v_ref ->> 'problem');
      end if;
      v_want := v_ref -> 'data';
      v_verify := coalesce((v_ref -> 'verify') = 'true'::jsonb, false);
    else
    case e ->> 'kind'
      when 'START_DATA' then
        v_want := c;
        if v_node -> 'block' ->> 'type' = 'G-24' and (d -> 'authorisedBy') = v_by then
          return format('stores %s authorised by the person who starts the step; a reprocessing is authorised by the quality unit (G24-SELF-AUTHORISED)', v_what);
        end if;
      when 'ACKNOWLEDGE' then
        -- G-03: the configuration's mode; the SOP reference its configuration names, with its code, version and hash.
        if jsonb_typeof(v_cfg -> 'sop') = 'string' then
          select r.v into v_ref
            from jsonb_array_elements(case when jsonb_typeof(p_content -> 'references') = 'array' then p_content -> 'references' else '[]'::jsonb end) with ordinality r (v, i)
           where r.v -> 'id' = v_cfg -> 'sop' order by r.i limit 1;
        else
          v_ref := null;
        end if;
        v_want := jsonb_build_object('mode', case when coalesce(v_cfg -> 'acknowledgement', 'null'::jsonb) = 'null'::jsonb then '"READ"'::jsonb else v_cfg -> 'acknowledgement' end,
                                     'acknowledgedBy', v_by);
        if jsonb_typeof(v_ref) = 'object' then
          v_want := v_want || recipe.json_pick(v_ref, array['code']) || recipe.json_pick(v_ref, array['version'])
                    || jsonb_build_object('sopHash', coalesce(v_ref -> 'hash', 'null'::jsonb));
          if v_want ? 'code' then
            v_want := (v_want - 'code') || jsonb_build_object('sop', v_ref -> 'code');
          end if;
          if v_want ? 'version' then
            v_want := (v_want - 'version') || jsonb_build_object('sopVersion', v_ref -> 'version');
          end if;
        end if;
      when 'EQUIPMENT_STATUS' then
        v_ids := recipe.status_check_ids(v_cfg);
        v_problem := recipe.checklist_answer_problem(recipe.checklist_answers(c -> 'answers'), v_ids);
        if v_problem is not null then
          return format('stores %s that %s (G09-ANSWERS)', v_what, v_problem);
        end if;
        v_want := jsonb_build_object('equipmentRef', c -> 'equipmentRef', 'labelId', c -> 'labelId', 'answers', recipe.checklist_answers(c -> 'answers'),
                                     'passed', not exists (select 1 from jsonb_array_elements(recipe.checklist_answers(c -> 'answers')) a where a -> 'answer' = '"NO"'::jsonb),
                                     'attestedBy', v_by);
      when 'CLEARANCE_CHECK' then
        v_items := recipe.clearance_items(v_cfg);
        v_ids := array(select i ->> 'id' from jsonb_array_elements(v_items) i);
        v_problem := recipe.checklist_answer_problem(recipe.checklist_answers(c -> 'answers'), v_ids);
        if v_problem is not null then
          return format('stores %s that %s (G10-ANSWERS)', v_what, v_problem);
        end if;
        select string_agg(a ->> 'id', ', ') into v_problem
          from jsonb_array_elements(recipe.checklist_answers(c -> 'answers')) a
          join jsonb_array_elements(v_items) i on i -> 'id' = a -> 'id'
         where a -> 'answer' = '"NOT_APPLICABLE"'::jsonb and i ->> 'expected' <> 'CONFIRMED_OR_NOT_APPLICABLE';
        if v_problem is not null then
          return format('stores %s that answers %s not applicable, which its step''s list requires confirmed (G10-NOT-APPLICABLE)', v_what, v_problem);
        end if;
        v_want := jsonb_build_object('answers', recipe.checklist_answers(c -> 'answers'),
                                     'passed', not exists (select 1 from jsonb_array_elements(recipe.checklist_answers(c -> 'answers')) a where a -> 'answer' = '"NOT_CONFIRMED"'::jsonb),
                                     'checkedBy', v_by);
        v_verify := true;
      when 'PREVIOUS_BATCH' then
        v_want := jsonb_build_object('product', c -> 'product', 'batchNumber', c -> 'batchNumber', 'recordedBy', v_by);
      when 'CONTAINER_WEIGHING' then
        v_problem := recipe.lot_usability_problem(p_content, c -> 'bomLine', c -> 'lot', v_now_us, p_new -> 'header' -> 'marketSet');
        if v_problem is not null then
          return format('stores %s whose %s', v_what, v_problem);
        end if;
        v_want := (c - 'kind') || recipe.json_pick(d, array['net', 'label']);
        v_verify := coalesce((c -> 'source') = '"MANUAL"'::jsonb, false);
      when 'CHARGE_LOT' then
        v_problem := recipe.lot_usability_problem(p_content, c -> 'bomLine', c -> 'lot', v_now_us, p_new -> 'header' -> 'marketSet');
        if v_problem is not null then
          return format('stores %s whose %s', v_what, v_problem);
        end if;
        v_want := jsonb_build_object('bomLine', c -> 'bomLine', 'container', c -> 'container', 'lot', c -> 'lot')
                  || case when jsonb_typeof(c -> 'quantity') = 'object' then jsonb_build_object('quantity', c -> 'quantity') else '{}'::jsonb end;
      when 'CHARGE_CONTAINER' then
        v_want := jsonb_build_object('container', c -> 'container') || recipe.json_pick(d, array['holds']);
      when 'OUTPUT_CONTAINER' then
        v_want := (c - 'kind' - 'container') || jsonb_build_object('status', 'QUARANTINE') || recipe.json_pick(d, array['container', 'net', 'item']);
        v_verify := coalesce((c -> 'source') = '"MANUAL"'::jsonb, false);
      when 'DISPOSAL' then
        -- G-23 keeps the whole entry as sent, its kind included.
        v_cat := c ->> 'category';
        if (c -> 'batchCoded') = 'true'::jsonb and v_cat = 'RETURN_TO_STORES' then
          return format('stores %s returning batch-coded %s to stores; batch-coded leftovers are only destroyed (G23-BATCH-CODED)', v_what, coalesce(c ->> 'material', '(material)'));
        end if;
        if v_cat = 'DESTRUCTION' and jsonb_typeof(c -> 'method') is distinct from 'string' then
          return format('stores %s, a destruction that names no method (G23-METHOD)', v_what);
        end if;
        if v_cat = 'REJECT_CONTAINER' and jsonb_typeof(c -> 'container') is distinct from 'string' then
          return format('stores %s, a reject held in no identified container (G23-CONTAINER)', v_what);
        end if;
        if v_cat = 'DESTRUCTION' and (v_cfg -> 'witness') is distinct from 'false'::jsonb
           and (v_node -> 'signatures' -> 'check' ->> 'meaning') is distinct from 'WITNESSED' then
          return format('stores %s, a destruction at a step whose check is not a witness (G23-WITNESS)', v_what);
        end if;
        v_want := c;
      when 'SAMPLE' then
        -- G-12: of the step's sampling plan; the id and label the block builds.
        if jsonb_typeof(v_node -> 'sampling') = 'array' and jsonb_array_length(v_node -> 'sampling') > 0 then
          v_items := (select jsonb_agg(jsonb_build_object('point', s -> 'point', 'purpose', s -> 'purpose')) from jsonb_array_elements(v_node -> 'sampling') s);
        elsif jsonb_typeof(v_cfg -> 'locations') = 'number' then
          v_items := (select coalesce(jsonb_agg(jsonb_build_object('point', 'L' || g, 'purpose', case when jsonb_typeof(v_cfg -> 'purpose') = 'string' then v_cfg -> 'purpose' else '"SAMPLE"'::jsonb end) order by g), '[]'::jsonb)
                        from generate_series(1, greatest(floor((v_cfg ->> 'locations')::numeric), 0)::integer) g);
        else
          v_items := '[]'::jsonb;
        end if;
        if jsonb_array_length(v_items) > 0
           and not exists (select 1 from jsonb_array_elements(v_items) s where s -> 'point' = c -> 'point' and s -> 'purpose' = c -> 'purpose') then
          return format('stores %s taken at point %s for %s, which is not in the sampling plan of its step (G12-NOT-PLANNED)', v_what, coalesce(c ->> 'point', '(none)'), coalesce(c ->> 'purpose', '(none)'));
        end if;
        select count(*) into v_n from jsonb_each(e0) x where x.value ->> 'stepKey' = e ->> 'stepKey' and x.value ->> 'kind' = 'SAMPLE';
        -- The innermost sub-lot whose frames begin the step instance's (engine view.ts: the inner replicate frame's).
        select s.value -> 'id' into v_sub
          from jsonb_each(case when jsonb_typeof(p_new -> 'subLots') = 'object' then p_new -> 'subLots' else '{}'::jsonb end) s
         where jsonb_typeof(s.value -> 'frames') = 'array' and jsonb_array_length(s.value -> 'frames') > 0
           and (select coalesce(jsonb_agg(f.v order by f.i), '[]'::jsonb)
                  from jsonb_array_elements(case when jsonb_typeof(v_inst -> 'frames') = 'array' then v_inst -> 'frames' else '[]'::jsonb end) with ordinality f (v, i)
                 where f.i <= jsonb_array_length(s.value -> 'frames')) = s.value -> 'frames'
         order by jsonb_array_length(s.value -> 'frames') desc limit 1;
        v_member := (v_batch #>> '{}') || '/' || (v_inst ->> 'step') || coalesce('/' || (v_sub #>> '{}'), '') || '/S' || (v_n + 1);
        v_want := jsonb_build_object('sampleId', v_member, 'point', c -> 'point', 'purpose', c -> 'purpose', 'units', c -> 'units')
                  || case when jsonb_typeof(c -> 'container') = 'string' and c ->> 'container' <> '' then jsonb_build_object('container', c -> 'container') else '{}'::jsonb end
                  || jsonb_build_object('label', jsonb_build_object('product', v_product, 'batch', v_batch, 'sample', v_member, 'sampler', v_by, 'takenAtUs', to_jsonb(v_now_us::text)));
      when 'TRANSFER_ISSUED', 'TRANSFER_RECEIVED' then
        v_want := c || jsonb_build_object('by', v_by);
      when 'SOURCE_ADDITION' then
        -- G-24: only at a recovery or reprocessing-addition step, of the batch's product, within the MBR's limits.
        if (v_rp ->> 'case') is distinct from 'RECOVERY' and (v_rp ->> 'case') is distinct from 'REPROCESSING_ADDITION' then
          return format('stores %s at a step that is no recovery or reprocessing-addition step (G24-NO-ADDITION)', v_what);
        end if;
        if (c -> 'productCode') is distinct from v_product then
          return format('stores %s of material of product %s added to a batch of %s (G24-OTHER-PRODUCT)', v_what, coalesce(c ->> 'productCode', '(none)'), coalesce(v_product #>> '{}', '(none)'));
        end if;
        if (c -> 'containsRecovered') = 'true'::jsonb then
          return format('stores %s from batch %s, which itself contains recovered material (G24-CHAINED)', v_what, coalesce(c ->> 'sourceBatch', '(none)'));
        end if;
        if jsonb_typeof(c -> 'manufacturedAtUs') = 'string' and (c ->> 'manufacturedAtUs') ~ '^[0-9]{1,20}$' and recipe.duration_us(v_rp -> 'maxAge') is not null
           and v_now_us - (c ->> 'manufacturedAtUs')::numeric > recipe.duration_us(v_rp -> 'maxAge') then
          return format('stores %s from batch %s, which is older than the MBR''s maximum of %s %s (G24-TOO-OLD)', v_what, coalesce(c ->> 'sourceBatch', '(none)'), v_rp -> 'maxAge' ->> 'value', v_rp -> 'maxAge' ->> 'unit');
        end if;
        if jsonb_typeof(v_rp -> 'maxSourceBatches') = 'number'
           and (select count(distinct coalesce(x.value -> 'data' ->> 'sourceBatch', 'undefined'))
                  from jsonb_each(e1) x where x.value ->> 'stepKey' = e ->> 'stepKey' and x.value ->> 'kind' = 'SOURCE_ADDITION') > (v_rp ->> 'maxSourceBatches')::numeric then
          return format('stores %s, which brings the source batches of its step above the MBR''s %s (G24-TOO-MANY-SOURCES)', v_what, v_rp ->> 'maxSourceBatches');
        end if;
        v_want := c || jsonb_build_object('case', v_rp -> 'case');
      when 'ATTACHMENT' then
        v_want := jsonb_build_object('sha256', c -> 'sha256', 'mediaType', c -> 'mediaType', 'description', c -> 'description',
                                     'paperOriginal', coalesce((c -> 'paperOriginal') = 'true'::jsonb, false), 'attachedBy', v_by);
        v_verify := coalesce((c -> 'paperOriginal') = 'true'::jsonb, false);
      when 'SETPOINT_READBACK', 'ACTUAL', 'ALARM' then
        -- G-06 (0520): the value with its provenance, as blocks/generic/automated.ts builds it.
        v_ref := recipe.g06_value_data(v_cfg, c, e ->> 'kind', v_now_us);
        if v_ref ? 'problem' then
          return format('stores %s that %s', v_what, v_ref ->> 'problem');
        end if;
        v_want := (v_ref -> 'data') || jsonb_build_object('recordedBy', v_by);
        v_verify := (c ->> 'source') = 'MANUAL';
      when 'ALARM_ACK' then
        -- G-06 (0520): an alarm of the step, acknowledged once, a GMP-critical one with a comment (DI-49).
        select x.value into v_ref from jsonb_each(e0) x
         where x.key = c ->> 'alarm' and x.value ->> 'kind' = 'ALARM' and x.value ->> 'stepKey' = e ->> 'stepKey';
        if v_ref is null then
          return format('stores %s acknowledging %s, which is no alarm of its step (G06-ACK-UNKNOWN)', v_what, coalesce(c ->> 'alarm', '(none)'));
        end if;
        if exists (select 1 from jsonb_each(e0) x where x.value ->> 'kind' = 'ALARM_ACK' and x.value ->> 'stepKey' = e ->> 'stepKey'
                                                     and x.value -> 'data' ->> 'alarm' = c ->> 'alarm') then
          return format('stores %s acknowledging alarm %s a second time (G06-ACK-TWICE)', v_what, c ->> 'alarm');
        end if;
        if (v_ref -> 'data' -> 'critical') = 'true'::jsonb and (jsonb_typeof(c -> 'comment') is distinct from 'string' or (c ->> 'comment') ~ '^\s*$') then
          return format('stores %s acknowledging the GMP-critical alarm %s without a comment (G06-ACK-COMMENT)', v_what, c ->> 'alarm');
        end if;
        v_want := jsonb_build_object('alarm', c -> 'alarm')
                  || case when jsonb_typeof(c -> 'comment') = 'string' then jsonb_build_object('comment', c -> 'comment') else '{}'::jsonb end
                  || jsonb_build_object('acknowledgedBy', v_by);
      when 'INTERFACE_LOSS' then
        v_want := jsonb_build_object('reason', c -> 'reason', 'recordedBy', v_by);
        v_verify := true;
      when 'RECIPE_CHECK' then
        if jsonb_typeof(v_node -> 'system' -> 'recipe') is distinct from 'string' or (v_node -> 'system' ->> 'recipe') = '' then
          return format('stores %s at a step that names no equipment recipe (G06-NO-RECIPE)', v_what);
        end if;
        v_want := jsonb_build_object('recipe', c -> 'recipe', 'recipeVersion', c -> 'recipeVersion',
                                     'matches', coalesce((c -> 'recipe') = (v_node -> 'system' -> 'recipe') and (c -> 'recipeVersion') = (v_node -> 'system' -> 'recipeVersion'), false),
                                     'checkedBy', v_by);
      when 'EQUIPMENT_USE' then
        -- G-09@2 (0520): equipment of the step's status check; one unit per reference. Which use it names is 0521's.
        if exists (select 1 from jsonb_array_elements(case when jsonb_typeof(v_node -> 'equipment') = 'array' then v_node -> 'equipment' else '[]'::jsonb end) q where q ->> 'use' = 'STATUS_CHECK')
           and not exists (select 1 from jsonb_array_elements(v_node -> 'equipment') q where q ->> 'use' = 'STATUS_CHECK' and q -> 'ref' = c -> 'equipmentRef') then
          return format('stores %s for %s, which is not equipment its step checks (G09-EQUIPMENT)', v_what, coalesce(c ->> 'equipmentRef', '(none)'));
        end if;
        if exists (select 1 from jsonb_each(e0) x where x.value ->> 'kind' = 'EQUIPMENT_USE' and x.value ->> 'stepKey' = e ->> 'stepKey'
                                                     and x.value -> 'data' -> 'equipmentRef' = c -> 'equipmentRef') then
          return format('stores %s for %s a second time (G09-TWICE)', v_what, c ->> 'equipmentRef');
        end if;
        v_want := jsonb_build_object('equipmentRef', c -> 'equipmentRef', 'equipmentCode', c -> 'equipmentCode', 'useId', c -> 'useId', 'recordedBy', v_by);
      when 'AREA_OCCUPANCY' then
        -- G-10@2 (0520): one area per step. Which occupancy it names is 0521's.
        if exists (select 1 from jsonb_each(e0) x where x.value ->> 'kind' = 'AREA_OCCUPANCY' and x.value ->> 'stepKey' = e ->> 'stepKey') then
          return format('stores %s, a second area of its step (G10-TWICE)', v_what);
        end if;
        v_want := jsonb_build_object('areaCode', c -> 'areaCode', 'occupancyId', c -> 'occupancyId', 'recordedBy', v_by);
      else
        -- An entry kind no block of this release records: which block takes which kind is lead TODO T2's.
        null;
    end case;
    end if;
    if v_want is not null and d is distinct from v_want then
      select m into v_member
        from (select jsonb_object_keys(d) m union select jsonb_object_keys(v_want)) u
       where (d -> m) is distinct from (v_want -> m)
       order by m limit 1;
      return format('stores %s with %s %s, where its block writes %s', v_what, v_member,
                    coalesce((d -> v_member)::text, '(no such member)'), coalesce((v_want -> v_member)::text, '(no such member)'));
    end if;
    if v_verify and (v_inst -> 'verificationRequired') is distinct from 'true'::jsonb then
      return format('stores %s, which needs a second person''s check of its step, and the step does not require it (PR-14)', v_what);
    end if;
  end loop;
  -- G-24: a reprocessing step other than a validated re-treatment starts only with its prior authorisation.
  if p_command ->> 'type' = 'START_STEP' then
    v_inst := recipe.step_instance_of(p_new, p_command);
    v_node := recipe.step_node(p_content, p_command ->> 'step');
    if v_inst ->> 'status' = 'IN_PROGRESS' and (recipe.step_instance_of(p_old, p_command) ->> 'status') is distinct from 'IN_PROGRESS'
       and v_node -> 'block' ->> 'type' = 'G-24' and (v_node -> 'reprocessing' ->> 'case') is distinct from 'VALIDATED_RETREATMENT'
       and not exists (select 1 from jsonb_each(e1) x where not (e0 ? x.key) and x.value ->> 'kind' = 'START_DATA' and x.value ->> 'stepKey' = v_inst ->> 'key') then
      return format('starts reprocessing step %s without the quality unit''s prior authorisation (G24-NOT-AUTHORISED)', v_inst ->> 'key');
    end if;
  end if;
  return null;
end
$$;

revoke all on function recipe.g21_dec(jsonb), recipe.g21_challenge_time(jsonb), recipe.g21_cfg_member(jsonb, text, jsonb), recipe.g21_entry_data(jsonb, jsonb, text, jsonb, jsonb, numeric, jsonb) from public;

reset role;
