-- Recipe core: the record amendment with slice 5a's suspension merged (Phase 4 slice 5 integration; INV-21, R-04, L-19;
-- defaults D-5b-7, D-5b-9 in docs/build-plan/phase-4/phase-4-plan.md).
--
-- With 5a (0840) a deviation linked to a released lot suspends it at once, and the manufacturer release then reads
-- RELEASE_SUSPENDED over its RELEASED decision. So an amendment opened under that deviation found no "released" lot.
--   * recipe.record_released_lots: CREATE OR REPLACE from 0872: every finished lot made from the record whose manufacturer
--     decision is RELEASED (recipe.market_decided_released, whatever happened after) and that is not recalled or rejected
--     after release for IN; per market (IN, and US or EU in the lot's set) decided RELEASED or CERTIFIED and not terminal:
--     {market, disposition (the decided state: RELEASED or CERTIFIED), now (the state now, RELEASE_SUSPENDED included)}.
--   * recipe.open_record_amendment: CREATE OR REPLACE from 0872: the cause handed to recipe.suspend_release carries the
--     ref 5a needs (the amendment id), the via node (the batch) and a label; 5a's suspend_lot adds it to a lot already
--     suspended (one row per lot, market and cause). The AP's task per market keeps the decided state as
--     disposition_before.
--   * recipe.suspension_cause_problem: CREATE OR REPLACE from 0840: a RECORD_AMENDMENT cause is resolved once that
--     amendment is closed (D-5b-9). Nothing else changes.

set local role ebmr_owner;

create or replace function recipe.record_released_lots(p_batch uuid) returns jsonb
language sql stable security definer set search_path = pg_catalog, recipe, site, pg_temp as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'lot_id', l, 'lot_code', (select m.lot_code from site.material_lot m where m.id = l),
           'markets', (select coalesce(jsonb_agg(jsonb_build_object('market', mk, 'disposition', case mk when 'EU' then 'CERTIFIED' else 'RELEASED' end,
                                                                    'now', recipe.disposition_state(l, mk)) order by mk), '[]'::jsonb)
                         from unnest(array['EU', 'IN', 'US']) mk
                        where (mk = 'IN' or mk = any (coalesce(recipe.market_set('LOT', l), '{}')))
                          and recipe.market_decided_released(l, mk)
                          and not exists (select 1 from recipe.after_release_decision d where d.lot_id = l and d.market = mk and d.act <> 'RECONFIRM')))
         order by l), '[]'::jsonb)
    from unnest(recipe.lots_of_batch(p_batch)) l
   where recipe.market_decided_released(l, 'IN')
     and not exists (select 1 from recipe.after_release_decision d where d.lot_id = l and d.market = 'IN' and d.act <> 'RECONFIRM')
$$;

create or replace function recipe.open_record_amendment(p_batch uuid, p_basis_kind text, p_basis uuid, p_reason_code text, p_reason_text text, p_signature uuid) returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, recipe, site, esig, iam, plant, pg_temp as $$
declare
  v_actor   jsonb;
  b         recipe.batch_execution;
  v_state   text;
  v_dstate  text;
  v_aid     text;
  v_sig     jsonb;
  v_content jsonb;
  v_lots    jsonb;
  v_id      uuid;
  v_n       integer;
  l         jsonb;
  k         jsonb;
begin
  perform iam.assert_not_administrator();
  select * into b from recipe.batch_execution where id = p_batch for update;
  if not found or b.purpose <> 'GMP_BATCH' then
    raise exception using errcode = 'P0001', message = format('EBMR-LCK-030 %s is no GMP batch record', coalesce(p_batch::text, 'NULL'));
  end if;
  v_actor := iam.require_permission('RECORD.QA_REVIEW', plant.batch_scope(p_batch));
  v_state := recipe.record_lock_state(p_batch);
  if v_state <> 'LOCKED' then
    raise exception using errcode = 'P0001',
      message = format('EBMR-LCK-031 batch record %s is %s: an amendment is opened on a LOCKED record only (%s) (INV-21)', b.batch_number, v_state,
                       case v_state when 'UNLOCKED' then 'an unlocked record is still written by its own paths' else 'one amendment is open at a time' end);
  end if;
  if p_basis_kind = 'DEVIATION' then
    v_dstate := site.deviation_state(p_basis);
    if v_dstate is null or v_dstate in ('CLOSED', 'CANCELLED') then
      raise exception using errcode = 'P0001',
        message = format('EBMR-LCK-032 an amendment is opened under an open deviation (the deviation is %s) or a change record (D-5-7)', coalesce(v_dstate, 'unknown'));
    end if;
    if not exists (select 1 from site.deviation_link k2 where k2.deviation_id = p_basis
                      and (k2.batch_id = p_batch or (k2.subject_kind = 'LOT' and k2.subject_id = any (recipe.lots_of_batch(p_batch))))) then
      raise exception using errcode = 'P0001', message = format('EBMR-LCK-033 the deviation is not linked to batch record %s or to a lot made from it (D-5-7)', b.batch_number);
    end if;
  elsif p_basis_kind = 'CHANGE_RECORD' then
    if p_basis is null or not exists (select 1 from recipe.change_record c where c.id = p_basis) then
      raise exception using errcode = 'P0001', message = 'EBMR-LCK-032 an amendment is opened under an open deviation or a change record (D-5-7): the change record does not exist';
    end if;
  else
    raise exception using errcode = 'P0001', message = format('EBMR-LCK-032 an amendment is opened under a DEVIATION or a CHANGE_RECORD, not %s (D-5-7)', coalesce(p_basis_kind, 'NULL'));
  end if;
  if p_reason_code is null or btrim(p_reason_code) = '' or length(p_reason_code) > 64 or p_reason_text is null or length(btrim(p_reason_text)) < 10 then
    raise exception using errcode = 'P0001', message = 'EBMR-LCK-034 an amendment carries the person''s own reason: a code and a text of at least 10 characters (DI-22)';
  end if;

  v_aid := recipe.record_lock_next_id(p_batch, 'OPEN', p_basis_kind, p_basis);
  v_sig := recipe.assert_release_signature(p_signature, 'AMENDMENT_OPENED', 'record_lock', v_aid, (v_actor ->> 'person_id')::uuid);
  v_content := esig.provide('record_lock', v_aid);
  if esig.content_hash_of('record_lock', v_aid, v_content) is distinct from v_sig ->> 'content_hash' then
    raise exception using errcode = 'P0001', message = 'EBMR-LCK-035 the signed amendment is not the current one (the record or its lots moved); sign it again (DI-37)';
  end if;
  v_n := split_part(v_aid, '/', 2)::integer;
  v_lots := v_content -> 'content' -> 'released_lots';
  insert into recipe.record_amendment (batch_id, number, basis_kind, deviation_id, change_record_id, reason_code, reason_text, suspended_lots, content,
                                       signature_id, person_id, account_id)
  values (p_batch, v_n, p_basis_kind, case p_basis_kind when 'DEVIATION' then p_basis end, case p_basis_kind when 'CHANGE_RECORD' then p_basis end,
          btrim(p_reason_code), btrim(p_reason_text), array(select (x ->> 'lot_id')::uuid from jsonb_array_elements(v_lots) x), v_content -> 'content',
          p_signature, (v_actor ->> 'person_id')::uuid, (v_actor ->> 'account_id')::uuid)
  returning id into v_id;
  perform recipe.record_lock_append(p_batch, 'AMENDMENT_OPENED', null, null, v_id, (v_actor ->> 'person_id')::uuid, (v_actor ->> 'account_id')::uuid);
  -- R-04: the AP assesses every market already released; the releases are suspended in this transaction (L-19).
  for l in select * from jsonb_array_elements(v_lots) loop
    for k in select * from jsonb_array_elements(l -> 'markets') loop
      insert into recipe.amendment_market_task (amendment_id, batch_id, lot_id, market, disposition_before)
      values (v_id, p_batch, (l ->> 'lot_id')::uuid, k ->> 'market', k ->> 'disposition');
    end loop;
    perform recipe.suspend_release((l ->> 'lot_id')::uuid, jsonb_build_object(
      'kind', 'RECORD_AMENDMENT', 'ref', v_id::text, 'via_kind', 'BATCH', 'via_id', p_batch,
      'label', format('amendment %s of batch record %s', v_n, b.batch_number),
      'batch_id', p_batch, 'batch_number', b.batch_number, 'amendment_id', v_id, 'amendment_number', v_n,
      'basis_kind', p_basis_kind, 'basis_id', p_basis, 'signature_id', p_signature));
    perform recipe.bump_epoch('LOT', (l ->> 'lot_id')::uuid);
  end loop;
  return v_id;
end
$$;


create or replace function recipe.suspension_cause_problem(p_suspension uuid) returns text
language plpgsql stable security definer set search_path = pg_catalog, recipe, site, records, plant, pg_temp as $$
declare
  s     recipe.release_suspension;
  v_st  text;
  v_ref text;
  r     site.lot_test_result;
begin
  select * into s from recipe.release_suspension where id = p_suspension;
  if not found then
    return 'no such suspension';
  end if;
  case s.cause_kind
    when 'DEVIATION' then
      v_st := site.deviation_state(s.cause_ref::uuid);
      select d.ref into v_ref from site.deviation d where d.id = s.cause_ref::uuid;
      if v_st is null or v_st not in ('CLOSED', 'CANCELLED') then
        return format('deviation %s is %s: a cause is resolved once its deviation is closed (D-5-4)', coalesce(v_ref, s.cause_ref), coalesce(v_st, 'unknown'));
      end if;
      if exists (select 1 from site.deviation_link k where k.deviation_id = s.cause_ref::uuid
                    and (site.deviation_latest_impact(k.id, s.market)).impact = 'CONFIRMED') then
        return format('deviation %s has a CONFIRMED impact for %s: the market is not re-confirmed on it (D-2a-9)', v_ref, s.market);
      end if;
      return null;
    when 'INCIDENT', 'DI_INVESTIGATION' then
      if exists (select 1 from records.open_blockers(case s.via_kind when 'LOT' then 'material_lot' else 'batch' end, s.via_id::text) o
                  where o.blocker_id = s.cause_ref::uuid and o.blocks_disposition) then
        return format('%s %s still blocks %s %s: it is closed or assessed for it first', lower(replace(s.cause_kind, '_', ' ')), s.cause_ref, lower(s.via_kind), s.via_id);
      end if;
      return null;
    when 'LIMS_REVISION' then
      select * into r from site.lot_test_result t where t.id = s.cause_ref::uuid;
      -- the latest revision of the result
      while r.id is not null and exists (select 1 from site.lot_test_result t where t.revises = r.id) loop
        select * into r from site.lot_test_result t where t.revises = r.id;
      end loop;
      if r.id is null or r.verdict <> 'PASS' then
        return format('the revised %s result is %s: a cause is resolved once the result is within its limits (D-5-4)', coalesce(r.test_code, 'test'), coalesce(r.verdict, 'missing'));
      end if;
      return null;
    when 'CALIBRATION_FAILURE' then
      -- D-5a-3: the AP's impact assessment of the as-found failure resolves it.
      return null;
    when 'RECORD_AMENDMENT' then
      -- D-5b-9: resolved once the amendment is closed (AMENDMENT_CLOSED; the record is LOCKED again).
      if not exists (select 1 from recipe.record_amendment_close x where x.amendment_id::text = s.cause_ref) then
        return format('%s is still open: a record amendment is resolved once QA closes it (AMENDMENT_CLOSED, D-5b-9)', s.label);
      end if;
      return null;
    else
      return format('a %s cause is resolved by its own record (slice 5b); it is not resolved yet', s.cause_kind);
  end case;
end
$$;


reset role;
