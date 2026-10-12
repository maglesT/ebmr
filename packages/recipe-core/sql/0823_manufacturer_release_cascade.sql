-- Recipe core: the manufacturer release cascades to the market dispositions (Phase 4 slice 4a; outline 5.2.6 cascade;
-- INV-39; ADR 0012). Each function is replaced from its latest definition (0781); only the stated change is made:
--   * recipe.record_manufacturer_release: a REJECT records, in the same transaction, the state every export market of the
--     lot moved to (recipe.cascade_market_dispositions, 0822): NOT_READY for an undecided market (a decided one reads
--     RELEASE_SUSPENDED through recipe.disposition_state whenever the manufacturer release is not RELEASED).
--   * recipe.acknowledge_release_item: for EU, the person acknowledging holds RECORD.QA_REVIEW or, the in-system QP
--     switch on, RELEASE.EU_QP_CERTIFY (the registered QP signs the EU checklist; PR-55).
-- Messages: unchanged.

set local role ebmr_owner;

create or replace function recipe.record_manufacturer_release(p_lot uuid, p_decision text, p_signature uuid, p_expected_epoch text, p_reason text)
returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, recipe, site, esig, iam, records, pg_temp as $$
declare
  v_actor   jsonb;
  v_scope   jsonb;
  l         site.material_lot;
  v_sig     jsonb;
  v_prob    text;
  v_deleg   jsonb;
  b         uuid;
  d         uuid;
  g         jsonb;
  i         jsonb;
  v_red     text[] := '{}';
  v_content text;
  v_id      text := p_lot::text || '/' || coalesce(p_decision, '');
  v_from    platform.aggregate_state;
  v_role    text;
  v_deleg_id uuid;
begin
  perform iam.assert_not_administrator();
  if p_decision is null or p_decision not in ('RELEASE', 'REJECT') then
    raise exception using errcode = 'P0001', message = format('EBMR-REL-011 %s is no decision of the manufacturer release (RELEASE or REJECT)', coalesce(p_decision, 'NULL'));
  end if;
  v_scope := recipe.release_scope(p_lot);
  v_actor := iam.require_permission('RELEASE.MANUFACTURER', v_scope);

  -- The locks of everything G-REL reads (outline 5.7): the lot, the records, then every evidence version.
  l := site.lock_lot(p_lot);
  perform 1 from recipe.execution_state s where s.batch_id = any (recipe.release_batches(p_lot)) order by s.batch_id for update;
  perform recipe.lock_epoch('LOT', p_lot);
  perform records.lock_blocker_epoch('material_lot', p_lot::text);
  foreach b in array recipe.release_batches(p_lot) loop
    perform recipe.lock_epoch('BATCH', b);
    perform records.lock_blocker_epoch('batch', b::text);
  end loop;
  foreach d in array recipe.release_deviations(p_lot) loop
    perform recipe.lock_epoch('DEVIATION', d);
  end loop;
  for b in select distinct lc.lot_id from site.lot_consumption lc where lc.batch_id = any (recipe.release_batches(p_lot)) order by 1 loop
    perform recipe.lock_epoch('LOT', b);
  end loop;

  if (recipe.manufacturer_decision(p_lot)).lot_id is not null then
    raise exception using errcode = 'P0001', message = format('EBMR-REL-012 the manufacturer release of lot %s is already %s', l.lot_code, (recipe.manufacturer_decision(p_lot)).decision);
  end if;

  -- INV-05: G-REL again, under the locks, at the epoch the signer evaluated, first (the signature is checked against it below).
  g := recipe.grel_evaluate(p_lot, 'IN');
  if p_expected_epoch is null or p_expected_epoch is distinct from g ->> 'epoch' then
    raise exception using errcode = 'P0001',
      message = format('EBMR-REL-018 the evidence of lot %s changed after it was evaluated (epoch %s, now %s); evaluate G-REL again (INV-05, DI-37)',
                       l.lot_code, coalesce(left(p_expected_epoch, 12), 'none given'), left(g ->> 'epoch', 12));
  end if;

  -- The signature: this record, this meaning, valid, the actor's own, as the AP or a delegate with a valid delegation.
  v_prob := coalesce(esig.signature_problem(p_signature, 'MANUFACTURER_RELEASE', 'manufacturer_release', v_id), esig.signature_state_problem(p_signature));
  if v_prob is not null then
    raise exception using errcode = 'P0001', message = format('EBMR-REL-013 %s (DI-35, DI-37)', v_prob);
  end if;
  v_sig := esig.signature_state(p_signature);
  if (v_sig ->> 'signer_person')::uuid is distinct from (v_actor ->> 'person_id')::uuid then
    raise exception using errcode = 'P0001', message = 'EBMR-REL-013 the manufacturer release is recorded by the person who signed it (DI-14, S16)';
  end if;
  select s.signer_role_code, s.delegation_id into v_role, v_deleg_id from esig.signature s where s.id = p_signature;
  if v_role is distinct from 'AUTHORISED_PERSON' then
    raise exception using errcode = 'P0001',
      message = format('EBMR-REL-014 the manufacturer release is signed by the authorised person or a named delegate in that role, not as %s (IN-05 (b))', coalesce(v_role, 'no role'));
  end if;
  if v_deleg_id is not null then
    v_deleg := iam.delegation_valid(v_deleg_id, (v_sig ->> 'signer_person')::uuid, 'MANUFACTURER_RELEASE', v_scope, 'IN', clock_timestamp());
    if not (v_deleg ->> 'valid')::boolean then
      raise exception using errcode = 'P0001',
        message = format('EBMR-REL-015 the delegation the signer cited is no longer valid: %s (IN-05 (b), outline 7.1)', v_deleg -> 'reasons');
    end if;
  end if;
  -- INV-35 (the kernel refuses it at signing; the record keeps its own copy of the rule).
  if (v_actor ->> 'person_id')::uuid = any (recipe.release_involvement(p_lot)) then
    raise exception using errcode = 'P0001', message = 'EBMR-REL-016 a person involved in the lot''s records never decides its release (INV-35, IN-05)';
  end if;
  if p_decision = 'RELEASE' then
    foreach b in array array[p_lot] || recipe.release_batches(p_lot) loop
      v_prob := site.deviation_release_problem(case when b = p_lot then 'LOT' else 'BATCH' end, b, 'IN', (v_actor ->> 'person_id')::uuid);
      if v_prob is not null and strpos(v_prob, 'cancelled') > 0 then
        raise exception using errcode = 'P0001', message = format('EBMR-REL-017 %s', v_prob);
      end if;
    end loop;
  end if;

  -- INV-05: the signed checklist is the current one.
  v_content := esig.content_hash_of('manufacturer_release', v_id, esig.provide('manufacturer_release', v_id));
  if v_content is distinct from v_sig ->> 'content_hash' then
    raise exception using errcode = 'P0001', message = 'EBMR-REL-018 the signed checklist is not the current one; sign the current evaluation (INV-05, IN-05 (d))';
  end if;
  if site.lot_state(p_lot) is distinct from 'QUARANTINE' then
    raise exception using errcode = 'P0001', message = format('EBMR-REL-019 lot %s is %s: the manufacturer release decides a lot in quarantine', l.lot_code, site.lot_state(p_lot));
  end if;

  if p_decision = 'RELEASE' then
    for i in select value from jsonb_array_elements(g -> 'items') loop
      if i ->> 'status' = 'RED' then
        v_red := v_red || format('%s: %s', i ->> 'id', i ->> 'problem');
      end if;
    end loop;
    if cardinality(v_red) > 0 then
      raise exception using errcode = 'P0001', message = format('EBMR-REL-020 lot %s is not READY: %s (IN-05, INV-05)', l.lot_code, array_to_string(v_red, '; '));
    end if;
    for i in select value from jsonb_array_elements(g -> 'items') loop
      if (i -> 'since_review') = 'true'::jsonb and not exists (
           select 1 from recipe.grel_acknowledgement a where a.lot_id = p_lot and a.market = 'IN' and a.item_id = i ->> 'id'
              and a.epoch = g ->> 'epoch' and a.person_id = (v_actor ->> 'person_id')::uuid) then
        raise exception using errcode = 'P0001',
          message = format('EBMR-REL-021 item %s changed after the QA review; the signer acknowledges it at the current evaluation before releasing (outline 5.2.7 item 1)', i ->> 'id');
      end if;
    end loop;
  elsif p_reason is null or recipe.reason_is_blank(p_reason) then
    raise exception using errcode = 'P0001', message = 'EBMR-REL-022 a rejection states the person''s own reason (DI-22, L-20)';
  end if;

  insert into recipe.manufacturer_release_decision (lot_id, decision, signature_id, delegation_id, reason, epoch, checklist, checklist_hash, content_hash,
                                                     person_id, account_id, role_code, correlation_id)
  values (p_lot, case p_decision when 'RELEASE' then 'RELEASED' else 'REJECTED' end, p_signature, v_deleg_id,
          nullif(btrim(coalesce(p_reason, '')), ''), g ->> 'epoch', g, encode(sha256(convert_to(g::text, 'UTF8')), 'hex'), v_content,
          (v_actor ->> 'person_id')::uuid, (v_actor ->> 'account_id')::uuid, v_role, (v_actor ->> 'correlation_id')::uuid);
  -- IN-05 (a): the finished lot leaves quarantine through this act only (material_lot v2, site services 0860, 0861).
  select * into v_from from platform.aggregate_state s where s.aggregate_type = 'material_lot' and s.aggregate_id = p_lot;
  perform site.lot_transition(l, case p_decision when 'RELEASE' then 'MANUFACTURER_RELEASE' else 'MANUFACTURER_REJECT' end, v_from.version, p_signature, null);
  -- Slice 4a, INV-39: a rejection moves every export market of the lot in this transaction.
  if p_decision = 'REJECT' then
    perform recipe.cascade_market_dispositions(p_lot, jsonb_build_object('cause', 'MANUFACTURER_REJECTED', 'signature_id', p_signature));
  end if;
  return p_signature;
end
$$;

create or replace function recipe.acknowledge_release_item(p_lot uuid, p_market text, p_item text, p_epoch text) returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, recipe, iam, platform, pg_temp as $$
declare
  v_actor jsonb;
  g       jsonb;
  v_id    uuid;
begin
  perform iam.assert_not_administrator();
  if p_market = 'EU' and platform.setting_text('release.in_system_qp_certification') = 'ON' then
    begin
      v_actor := iam.require_permission('RELEASE.EU_QP_CERTIFY', recipe.release_scope(p_lot));
    exception when others then
      v_actor := null;
    end;
  end if;
  v_actor := coalesce(v_actor, iam.require_permission(case p_market when 'US' then 'RELEASE.US_DISPOSITION' when 'EU' then 'RECORD.QA_REVIEW' else 'RELEASE.MANUFACTURER' end,
                                                      recipe.release_scope(p_lot)));
  g := recipe.grel_evaluate(p_lot, p_market);
  if p_epoch is distinct from g ->> 'epoch' then
    raise exception using errcode = 'P0001', message = 'EBMR-REL-050 the evidence changed since it was shown; acknowledge the item in the current evaluation (INV-05)';
  end if;
  if not exists (select 1 from jsonb_array_elements(g -> 'items') i where i ->> 'id' = p_item and (i -> 'since_review') = 'true'::jsonb) then
    raise exception using errcode = 'P0001', message = format('EBMR-REL-051 %s is no item that changed after the QA review', coalesce(p_item, 'NULL'));
  end if;
  insert into recipe.grel_acknowledgement (lot_id, market, item_id, epoch, person_id, account_id)
  values (p_lot, p_market, p_item, p_epoch, (v_actor ->> 'person_id')::uuid, (v_actor ->> 'account_id')::uuid)
  on conflict (lot_id, market, item_id, epoch, person_id) do nothing
  returning id into v_id;
  return coalesce(v_id, (select a.id from recipe.grel_acknowledgement a where a.lot_id = p_lot and a.market = p_market and a.item_id = p_item
                                                                            and a.epoch = p_epoch and a.person_id = (v_actor ->> 'person_id')::uuid));
end
$$;

reset role;
