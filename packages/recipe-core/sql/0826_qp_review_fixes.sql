-- Recipe core: the slice 4 quick review of the EU certification paths (Phase 4 slice 4a; DI-39, DI-30, PR-55, INV-39;
-- ADR 0012). Each function is replaced from its latest definition (0824, 0823); only the stated changes are made:
--   * HIGH 1, recipe.take_qp_message: a resend of the same bytes is answered with its earlier acknowledgement only when
--     that one was ACCEPTED; a REFUSED message (a wrong signature, a lot not yet awaiting certification) is evaluated
--     afresh when sent again. Only the database's own refusals (SQLSTATE P0001) are acknowledged REFUSED; any other error
--     (a lock timeout, a deadlock, a serialisation failure) is raised, so the sender retries and nothing is recorded.
--   * MEDIUM 2: one EU outcome path at a time: while a transcription of the lot waits for its second person, neither a
--     message nor an in-system QP takes an outcome in (recipe.eu_pending_transcription_problem, EBMR-DSP-090). The
--     transcription itself already refuses an effective or pending outcome (EBMR-DSP-051, EBMR-DSP-069).
--   * MEDIUM 3, recipe.record_qp_certification: an in-system QP rejection is signed with its own meaning QP_REJECTED
--     (new; RELEASE.EU_QP_CERTIFY, the involved excluded), a certification with QP_CERTIFIED; each signature names what
--     the QP decided.
--   * LOW 5, recipe.acknowledge_release_item: the probe of RELEASE.EU_QP_CERTIFY catches only the permission refusal
--     (EBMR-IAM-040); any other error is raised.
-- MEDIUM 4 (the two-row release) needed no change: recipe.record_release_with_us_disposition requires
-- RELEASE.US_DISPOSITION of the actor in the lot's scope before anything (0822), and the kernel checks it again when the
-- US row is signed; the regression test proves an AP without it is refused.
-- Messages: EBMR-DSP-090.

set local role ebmr_owner;

select kernel.set_actor_context(jsonb_build_object(
  'person_id', '00000000-0000-0000-0000-000000000000', 'account_id', '00000000-0000-0000-0000-000000000000',
  'role_code', 'SOFTWARE_RELEASE', 'session_id', '00000000-0000-0000-0000-000000000000', 'source', 'SYSTEM',
  'site_zone', 'UTC', 'correlation_id', gen_random_uuid(),
  'legal_name', 'Software release (recipe-core migration 0826_qp_review_fixes)',
  'reason_code', 'SOFTWARE_RELEASE',
  'reason_text', 'an in-system QP rejection is signed with its own meaning (PR-55, DI-35)'));

insert into esig.meaning_type (code, version, origin, is_minimum, status, category, role_class, title, meaning_text, permissions,
                               independent_of, excludes_performers, excludes_involved, witness, reauth, delegable, sources)
values ('QP_REJECTED', 1, 'VENDOR', true, 'ACTIVE', 'RELEASE', 'RELEASE', 'QP rejection',
        'As qualified person, I refuse to certify this batch (only when in-system QP certification is used).',
        array['RELEASE.EU_QP_CERTIFY'], array['PRODUCTION_APPROVED', 'PACKAGING_RECORD_APPROVED'], true, true, false, 'ALL_COMPONENTS', false,
        'EU Annex 16; PR-55; DI-35 (if used)');

select kernel.set_actor_context(null);

-- MEDIUM 2: why a message or an in-system QP may not take an EU outcome in while a transcription waits, or NULL.
create function recipe.eu_pending_transcription_problem(p_lot uuid) returns text
language sql stable security definer set search_path = pg_catalog, recipe, pg_temp as $$
  select 'EBMR-DSP-090 a transcribed certification of the lot waits for its second person: one outcome path at a time (DI-30, DI-39)'
   where exists (select 1 from recipe.qp_certification c where c.lot_id = p_lot and c.source = 'TRANSCRIBED'
                    and not exists (select 1 from recipe.qp_transcription_check k where k.certification_id = c.id))
$$;
revoke all on function recipe.eu_pending_transcription_problem(uuid) from public;
grant execute on function recipe.eu_pending_transcription_problem(uuid) to ebmr_app;

create or replace function recipe.record_qp_certification(p_lot uuid, p_outcome text, p_signature uuid, p_expected_epoch text, p_reason text) returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, recipe, site, esig, iam, platform, pg_temp as $$
declare
  v_actor   jsonb;
  v_reg     recipe.qp_register;
  v_p       text;
  g         jsonb;
  i         jsonb;
  v_red     text[] := '{}';
  v_id      text := p_lot::text || '/' || coalesce(p_outcome, '');
  v_sig     jsonb;
  v_content text;
  v_cid     uuid;
begin
  perform iam.assert_not_administrator();
  if platform.setting_text('release.in_system_qp_certification') <> 'ON' then
    raise exception using errcode = 'P0001',
      message = 'EBMR-DSP-073 in-system QP certification is off: the certification of the importer''s QP is received as a signed message or transcribed and verified (PR-55)';
  end if;
  v_actor := iam.require_permission('RELEASE.EU_QP_CERTIFY', recipe.release_scope(p_lot));
  v_reg := recipe.qp_registration((v_actor ->> 'person_id')::uuid);
  if v_reg.action is distinct from 'REGISTER' then
    raise exception using errcode = 'P0001', message = 'EBMR-DSP-074 only a qualified person registered in the system certifies here (PR-55, DI-39)';
  end if;
  perform recipe.lock_release_evidence(p_lot);
  v_p := coalesce(recipe.eu_outcome_problem(p_lot, p_outcome, v_reg.mia_number, clock_timestamp(), (v_actor ->> 'person_id')::uuid),
                  recipe.eu_pending_transcription_problem(p_lot));
  if v_p is not null then
    raise exception using errcode = 'P0001', message = v_p;
  end if;
  g := recipe.grel_evaluate(p_lot, 'EU');
  if p_expected_epoch is null or p_expected_epoch is distinct from g ->> 'epoch' then
    raise exception using errcode = 'P0001', message = 'EBMR-DSP-075 the evidence of the lot changed after it was evaluated for EU; evaluate G-REL again (INV-05, DI-37)';
  end if;
  -- MEDIUM 3: a certification is signed QP_CERTIFIED, a rejection QP_REJECTED.
  v_sig := recipe.assert_release_signature(p_signature, case p_outcome when 'CERTIFIED' then 'QP_CERTIFIED' else 'QP_REJECTED' end, 'qp_certification', v_id,
                                           (v_actor ->> 'person_id')::uuid);
  v_content := esig.content_hash_of('qp_certification', v_id, esig.provide('qp_certification', v_id));
  if v_content is distinct from v_sig ->> 'content_hash' then
    raise exception using errcode = 'P0001', message = 'EBMR-DSP-075 the signed EU checklist is not the current one; sign the current evaluation (INV-05)';
  end if;
  if p_outcome = 'CERTIFIED' then
    for i in select value from jsonb_array_elements(g -> 'items') loop
      if i ->> 'status' = 'RED' then
        v_red := v_red || format('%s: %s', i ->> 'id', i ->> 'problem');
      end if;
      if (i -> 'since_review') = 'true'::jsonb and not exists (
           select 1 from recipe.grel_acknowledgement a where a.lot_id = p_lot and a.market = 'EU' and a.item_id = i ->> 'id'
              and a.epoch = g ->> 'epoch' and a.person_id = (v_actor ->> 'person_id')::uuid) then
        v_red := v_red || format('%s changed after the QA review and is not acknowledged', i ->> 'id');
      end if;
    end loop;
    if cardinality(v_red) > 0 then
      raise exception using errcode = 'P0001', message = format('EBMR-DSP-076 the lot cannot be certified: %s (PR-55)', array_to_string(v_red, '; '));
    end if;
  elsif p_reason is null or recipe.reason_is_blank(p_reason) then
    raise exception using errcode = 'P0001', message = 'EBMR-DSP-068 a QP rejection carries the QP''s reason';
  end if;
  insert into recipe.qp_certification (lot_id, source, outcome, certifier, mia_number, certified_at, importer_id, reference, reason, signature_id, epoch, checklist,
                                       person_id, account_id)
  values (p_lot, 'IN_SYSTEM', p_outcome, coalesce((select p.legal_name from iam.person p where p.id = (v_actor ->> 'person_id')::uuid), v_actor ->> 'legal_name'),
          v_reg.mia_number, clock_timestamp(), v_reg.importer_id, 'SIG-' || p_signature::text, nullif(btrim(coalesce(p_reason, '')), ''), p_signature,
          g ->> 'epoch', g, (v_actor ->> 'person_id')::uuid, (v_actor ->> 'account_id')::uuid)
  returning id into v_cid;
  return v_cid;
end
$$;

-- Owner only (the edition's intake definer calls it once it has verified the importer's signature): takes in one
-- structured certification message and answers its acknowledgement; a refused message is acknowledged REFUSED with the
-- reason and changes nothing else. A message already accepted is answered with its acknowledgement (0826: a refused one
-- is evaluated again; only the database's own refusals are acknowledged).
create or replace function recipe.take_qp_message(p_message text, p_signature_valid boolean) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, recipe, site, iam, pg_temp as $$
declare
  v_actor jsonb;
  v_sha   text := encode(sha256(convert_to(coalesce(p_message, ''), 'UTF8')), 'hex');
  m       jsonb;
  v_mid   text;
  v_lot   uuid;
  v_imp   recipe.eu_importer;
  v_at    timestamptz;
  v_p     text;
  v_cid   uuid;
  v_ack   recipe.qp_message_ack;
  v_why   text;
  g       jsonb;
begin
  perform iam.assert_not_administrator();
  v_actor := iam.require_permission('RECORD.QA_REVIEW', '{}'::jsonb);
  -- HIGH 1: only an accepted message is answered with its earlier acknowledgement; a refused one is evaluated afresh.
  select * into v_ack from recipe.qp_message_ack a where a.message_sha256 = v_sha and a.outcome = 'ACCEPTED' order by a.recorded_at limit 1;
  if v_ack.id is not null then
    return to_jsonb(v_ack);
  end if;
  begin
    m := p_message::jsonb;
  exception when others then
    m := null;
  end;
  v_mid := left(coalesce(m ->> 'messageId', ''), 128);
  begin
    if jsonb_typeof(m) is distinct from 'object' or m ->> 'format' is distinct from 'ebmr.qp-certification.v1' or v_mid !~ '^[!-~]{1,128}$' then
      raise exception using errcode = 'P0001', message = 'EBMR-DSP-080 the message is not a certification message of format ebmr.qp-certification.v1 with a message id';
    end if;
    select * into v_imp from recipe.eu_importer i where i.code = m ->> 'importerCode';
    if v_imp.id is null then
      raise exception using errcode = 'P0001', message = format('EBMR-DSP-081 importer %s is not registered', coalesce(m ->> 'importerCode', 'none'));
    end if;
    if not coalesce(p_signature_valid, false) then
      raise exception using errcode = 'P0001', message = format('EBMR-DSP-082 the message is not signed with the key of importer %s (DI-39)', v_imp.code);
    end if;
    select f.lot_id into v_lot from site.finished_lot f join site.material_lot l on l.id = f.lot_id
     where l.lot_code = m ->> 'lotCode' and f.product_code = m ->> 'productCode' and f.batch_number = m ->> 'batchNumber';
    if v_lot is null then
      raise exception using errcode = 'P0001', message = format('EBMR-DSP-083 no finished lot %s of product %s from batch %s', m ->> 'lotCode', m ->> 'productCode', m ->> 'batchNumber');
    end if;
    if (recipe.lot_importer(v_lot)).id is distinct from v_imp.id then
      raise exception using errcode = 'P0001', message = format('EBMR-DSP-084 importer %s is not the importer of the lot''s product', v_imp.code);
    end if;
    v_at := recipe.parse_certified_at(m ->> 'certifiedAt');
    if coalesce(btrim(m #>> '{certifier,name}'), '') = '' then
      raise exception using errcode = 'P0001', message = 'EBMR-DSP-085 the message names no certifying QP';
    end if;
    if m ->> 'outcome' = 'REJECTED_BY_QP' and coalesce(btrim(m ->> 'reason'), '') = '' then
      raise exception using errcode = 'P0001', message = 'EBMR-DSP-068 a QP rejection carries the QP''s reason';
    end if;
    perform recipe.lock_release_evidence(v_lot);
    v_p := coalesce(recipe.eu_outcome_problem(v_lot, m ->> 'outcome', m #>> '{certifier,miaNumber}', v_at, null), recipe.eu_pending_transcription_problem(v_lot));
    if v_p is not null then
      raise exception using errcode = 'P0001', message = v_p;
    end if;
    g := recipe.grel_evaluate(v_lot, 'EU');
    insert into recipe.qp_certification (lot_id, source, outcome, certifier, mia_number, certified_at, importer_id, reference, reason, message, message_sha256,
                                         epoch, checklist, person_id, account_id)
    values (v_lot, 'MESSAGE', m ->> 'outcome', btrim(m #>> '{certifier,name}'), m #>> '{certifier,miaNumber}', v_at, v_imp.id, v_mid,
            nullif(btrim(coalesce(m ->> 'reason', '')), ''), p_message, v_sha, g ->> 'epoch', g, (v_actor ->> 'person_id')::uuid, (v_actor ->> 'account_id')::uuid)
    returning id into v_cid;
  exception when sqlstate 'P0001' then
    -- The subtransaction is rolled back (nothing taken in); the database's refusal is acknowledged with its reason. Any
    -- other error (a lock timeout, a deadlock, a serialisation failure) is not caught: it is raised and nothing is
    -- recorded, so the sender's retry is evaluated afresh (HIGH 1).
    v_why := sqlerrm;
    v_cid := null;
  end;
  insert into recipe.qp_message_ack (message_id, message_sha256, outcome, reason, lot_id, certification_id, person_id, account_id)
  values (coalesce(nullif(v_mid, ''), '(none)'), v_sha, case when v_cid is null then 'REFUSED' else 'ACCEPTED' end, v_why, v_lot, v_cid,
          (v_actor ->> 'person_id')::uuid, (v_actor ->> 'account_id')::uuid)
  returning * into v_ack;
  return to_jsonb(v_ack);
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
    exception when sqlstate 'P0001' then
      -- LOW 5: only the permission refusal falls back to the QA permission; any other error is raised.
      if sqlerrm not like 'EBMR-IAM-040%' then
        raise;
      end if;
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
