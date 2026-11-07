-- API edition plan A3 (docs/build-plan/api/plan.md row C3, control AS-17): the certificate of analysis (CoA) of a released
-- finished lot of the SUBSTANCE edition, built only from data that already exists, signed by the quality unit through the
-- existing e-signature ceremony and kept as a true copy.
--
-- Handbook: modules/substance.md
--
-- Data and functions of the substance namespace only; tablets and injectables behave as before. The clause (Schedule M
-- and ICH Q7 on certificates of analysis, paraphrased): an authentic CoA for each batch on request, giving the product's
-- name and grade, the batch number, the release date, the retest or expiry date, each test with its limits and numerical
-- result, dated and signed by the quality unit, with the original manufacturer's name, address and telephone.
--
--   substance.coa_document(lot)  {document, problems, gaps}: what a CoA of the lot says now, read from the records:
--       product name (the lot's material name) and grade (the monograph reference of the specification in effect), the lot
--       number and the packaging order's batch number, the release date (the manufacturer release decision, RELEASED),
--       the retest and expiry dates of the lot, each test of the specification in effect with its limits and the latest
--       approved current numerical result, and the manufacturer: the holder name and address of the manufacturing licence
--       the product is made under (site.licence_basis at the release), else of the site's current manufacturing licence.
--       problems (each refuses a CoA): the lot is no finished lot of the SUBSTANCE edition, it is not RELEASED, no approved
--       specification is in effect, a required test has no approved result, a result is outside its limits, no
--       manufacturer address is on record. gaps (shown, never invented): the manufacturer's telephone when the licence
--       records none (site-services 1735 keeps it on the licence, beside the holder's name and address).
--   substance.coa                 insert-only: one prepared CoA (the document as it was, its SHA-256 over the canonical
--                                 text). The stored document is the true copy: it never changes, and its hash is checked
--                                 on every read (substance.coa_intact).
--   substance.coa_signature       insert-only: the quality unit's COA_APPROVED signature over the prepared CoA (aggregate
--                                 substance_coa <coa id>, state PREPARED); the CoA is then SIGNED. One per CoA.
--   substance.prepare_coa(lot)    RELEASE.MANUFACTURER in the lot's scope (the lead: the existing lot-release right; no new
--                                 right code): refuses while a problem stands; returns the unsigned CoA of the same
--                                 document when one exists, else records a new one.
--   substance.sign_coa(coa, sig)  RELEASE.MANUFACTURER: a valid COA_APPROVED signature of this CoA by the actor, the CoA
--                                 PREPARED, and the lot's CoA still saying the same (a change since, e.g. a suspension or
--                                 a new result, refuses: prepare it again).
-- Signing catalogue: QA_APPROVED (recipe-core 1210) is a minimum type whose fixed meaning text approves a plant rule and
-- whose right is PLANT_RULE.APPROVE, so it cannot mean a CoA. This migration adds the vendor type COA_APPROVED (category
-- RELEASE, right RELEASE.MANUFACTURER). Content provider: substance_coa (substance.coa_content).
-- The tablets read class (tab.aggregate_read_class) lists substance_coa as a RECORD-class record (tablets 1904, the
-- function's owner), so a reader with RECORD.READ previews it and the signing command reads its content.
-- Messages: EBMR-COA-001 to EBMR-COA-009.
--
-- Owned by ebmr_owner, SECURITY DEFINER, search_path pinned with pg_temp last (ADR 0016). PL/pgSQL throughout: a sandbox
-- database is migrated without the tablets namespace.

set local role ebmr_owner;

grant usage on schema substance to ebmr_app;

create table substance.coa (
  id                   uuid primary key default gen_random_uuid(),
  lot_id               uuid not null,
  document             jsonb not null check (jsonb_typeof(document) = 'object'),
  document_sha256      text not null check (document_sha256 ~ '^[0-9a-f]{64}$'),
  prepared_by_person   uuid not null,
  prepared_by_account  uuid not null,
  prepared_at          timestamptz not null default clock_timestamp(),
  correlation_id       uuid not null
);
create index coa_lot on substance.coa (lot_id, prepared_at);
revoke all on substance.coa from public;

create table substance.coa_signature (
  coa_id               uuid primary key references substance.coa (id),
  signature_id         uuid not null unique,
  signed_by_person     uuid not null,
  signed_by_account    uuid not null,
  signed_at            timestamptz not null default clock_timestamp()
);
revoke all on substance.coa_signature from public;

select platform.enforce_db_time('substance.coa', array['prepared_at']);
select platform.enforce_db_time('substance.coa_signature', array['signed_at']);
select kernel.register_audited_table('substance.coa', 'substance_coa', 'id', true);
select kernel.register_audited_table('substance.coa_signature', 'substance_coa', 'coa_id', true);

-- What a CoA of the lot says now (header): {document, problems, gaps}.
create function substance.coa_document(p_lot uuid) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, substance, site, recipe, pg_temp as $$
declare
  f        site.finished_lot;
  l        site.material_lot;
  d        recipe.manufacturer_release_decision;
  v_spec   uuid;
  s        site.specification;
  v_lic    jsonb;
  v_tests  jsonb := '[]'::jsonb;
  v_probs  text[] := '{}';
  t        site.specification_test;
  r        site.lot_test_result;
begin
  select * into f from site.finished_lot x where x.lot_id = p_lot;
  if f.lot_id is null or f.edition is distinct from 'SUBSTANCE' then
    return jsonb_build_object('document', null, 'gaps', '[]'::jsonb,
      'problems', jsonb_build_array(format('%s is no finished lot of the API edition: a CoA is issued here for an API lot only', coalesce(p_lot::text, 'NULL'))));
  end if;
  select * into l from site.material_lot m where m.id = p_lot;
  d := recipe.manufacturer_decision(p_lot);
  if d.decision is distinct from 'RELEASED' then
    v_probs := v_probs || format('lot %s has no manufacturer release (decision %s): a CoA follows the release', l.lot_code, coalesce(d.decision, 'none'));
  elsif site.lot_state(p_lot) is distinct from 'RELEASED' then
    v_probs := v_probs || format('lot %s is %s, not RELEASED', l.lot_code, coalesce(site.lot_state(p_lot), 'of no status'));
  end if;
  v_spec := site.specification_in_effect(l.site_code, l.material_code);
  select * into s from site.specification x where x.id = v_spec;
  if s.id is null then
    v_probs := v_probs || format('no approved specification of %s is in effect at site %s', l.material_code, l.site_code);
  else
    for t in select x.* from site.specification_test x where x.specification_id = s.id order by x.test_code collate "C" loop
      r := null;
      select x.* into r from site.lot_test_result x
       where x.lot_id = p_lot and x.test_code = t.test_code and site.lot_test_is_current(x.id) and site.lot_test_state(x.id) = 'APPROVED'
       order by x.recorded_at desc, x.id desc limit 1;
      if r.id is null then
        if t.required then
          v_probs := v_probs || format('the required test %s has no approved result for lot %s', t.test_code, l.lot_code);
        end if;
        continue;
      end if;
      if r.unit is distinct from t.unit then
        v_probs := v_probs || format('the result of %s is in %s, the specification states %s', t.test_code, r.unit, t.unit);
      end if;
      if (t.lower_limit is not null and r.result_value < t.lower_limit) or (t.upper_limit is not null and r.result_value > t.upper_limit) then
        v_probs := v_probs || format('the result of %s (%s %s) is outside its limits', t.test_code, r.result_value::text, r.unit);
      end if;
      v_tests := v_tests || jsonb_build_array(jsonb_build_object(
        'testCode', t.test_code, 'methodReference', t.method_reference, 'pharmacopoeia', t.pharmacopoeia, 'edition', t.edition,
        'unit', t.unit, 'lowerLimit', t.lower_limit::text, 'upperLimit', t.upper_limit::text,
        'result', r.result_value::text, 'resultId', r.id));
    end loop;
    if jsonb_array_length(v_tests) = 0 then
      v_probs := v_probs || format('lot %s has no approved result of a test of its specification', l.lot_code);
    end if;
  end if;
  v_lic := site.licence_basis(l.site_code, f.product_code, f.strength, coalesce(d.recorded_at, clock_timestamp()));
  if v_lic is null then
    select jsonb_build_object('licenceId', m.id, 'licenceNumber', m.licence_number, 'form', m.form, 'holderName', m.holder_name, 'holderAddress', m.holder_address, 'holderTelephone', m.holder_telephone)
      into v_lic from site.manufacturing_licence m
     where m.site_code = l.site_code and m.licence_kind = 'MANUFACTURING' and site.licence_current(m.id, coalesce(d.recorded_at, clock_timestamp()))
     order by m.valid_from desc, m.recorded_at desc, m.id limit 1;
  end if;
  if v_lic is null then
    v_probs := v_probs || format('no current manufacturing licence of site %s gives the manufacturer''s name and address', l.site_code);
  end if;
  return jsonb_build_object(
    'problems', to_jsonb(v_probs),
    'gaps', case when v_lic ->> 'holderTelephone' is null
                 then jsonb_build_array('the manufacturer''s telephone (the manufacturing licence names none)')
                 else '[]'::jsonb end,
    -- Each member is what SM Part XII 11.3 (ICH Q7 11.41 to 11.43) names, nothing more (lead audit of #145):
    'document', jsonb_build_object(
      'kind', 'CERTIFICATE_OF_ANALYSIS',
      -- SM Part XII 11.3.4; Q7 11.43: the original manufacturer's name, address and telephone.
      'manufacturer', jsonb_build_object('name', v_lic ->> 'holderName', 'address', v_lic ->> 'holderAddress', 'telephone', v_lic ->> 'holderTelephone'),
      -- SM Part XII 11.3.2; Q7 11.41: the name of the API, with its grade.
      'product', jsonb_build_object('name', l.material_name, 'grade', s.monograph_reference),
      -- SM Part XII 11.3.2; Q7 11.41: the batch (lot) number.
      'lot', jsonb_build_object('lotId', l.id, 'lotCode', l.lot_code, 'batchNumber', f.batch_number),
      -- SM Part XII 11.3.2; Q7 11.41: the date of release.
      'releasedAt', case when d.decision = 'RELEASED' then recipe.utc_text(d.recorded_at) end,
      -- SM Part XII 11.3.2, 11.5.2; Q7 11.41, 11.61: the retest or expiry date.
      'retestAt', case when l.retest_at is not null then recipe.utc_text(l.retest_at) end,
      'expiresAt', recipe.utc_text(l.expires_at),
      -- SM Part XII 11.3.3; Q7 11.42: each test performed (its method), its acceptance limits and numerical result.
      'tests', v_tests));
end
$$;

-- PREPARED or SIGNED; NULL for an unknown id.
create function substance.coa_state(p_coa uuid) returns text
language plpgsql stable security definer set search_path = pg_catalog, substance, pg_temp as $$
begin
  if not exists (select 1 from substance.coa c where c.id = p_coa) then
    return null;
  end if;
  return case when exists (select 1 from substance.coa_signature g where g.coa_id = p_coa) then 'SIGNED' else 'PREPARED' end;
end
$$;

-- The true copy is intact: the stored document still hashes to the SHA-256 recorded with it.
create function substance.coa_intact(p_coa uuid) returns boolean
language plpgsql stable security definer set search_path = pg_catalog, substance, esig, pg_temp as $$
declare
  c substance.coa;
begin
  select * into c from substance.coa x where x.id = p_coa;
  return c.id is not null and esig.sha256_hex(esig.canonical_json(c.document)) = c.document_sha256;
end
$$;

-- The content COA_APPROVED covers (provider of substance_coa): the stored document and its SHA-256.
create function substance.coa_content(p_id text) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, substance, recipe, pg_temp as $$
declare
  c substance.coa;
begin
  if coalesce(p_id, '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return '{"exists": false}'::jsonb;
  end if;
  select * into c from substance.coa x where x.id = p_id::uuid;
  if c.id is null then
    return '{"exists": false}'::jsonb;
  end if;
  return jsonb_build_object(
    'exists', true,
    'content_version', 1,
    'content', jsonb_build_object('title', format('Certificate of analysis of lot %s', c.document -> 'lot' ->> 'lotCode'),
                                  'document', c.document, 'document_sha256', c.document_sha256,
                                  'prepared_by', c.prepared_by_person, 'prepared_at', recipe.utc_text(c.prepared_at)),
    'state', substance.coa_state(c.id),
    'scope', '{}'::jsonb,
    'entered_by', jsonb_build_array(c.prepared_by_person));
end
$$;

-- RELEASE.MANUFACTURER: prepares the CoA of a released API lot (header). Returns the CoA id.
create function substance.prepare_coa(p_lot uuid) returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, substance, recipe, iam, esig, pg_temp as $$
declare
  v_actor jsonb;
  v_doc   jsonb;
  v_hash  text;
  v_id    uuid;
begin
  perform iam.assert_not_administrator();
  if not exists (select 1 from site.finished_lot x where x.lot_id = p_lot and x.edition = 'SUBSTANCE') then
    raise exception using errcode = 'P0001', message = format('EBMR-COA-001 %s is no finished lot of the API edition (AS-17)', coalesce(p_lot::text, 'NULL'));
  end if;
  v_actor := iam.require_permission('RELEASE.MANUFACTURER', recipe.release_scope(p_lot));
  perform pg_advisory_xact_lock(hashtext('substance.coa:' || p_lot::text));
  v_doc := substance.coa_document(p_lot);
  if jsonb_array_length(v_doc -> 'problems') > 0 then
    raise exception using errcode = 'P0001',
      message = format('EBMR-COA-002 no CoA can be issued: %s (AS-17)', (select string_agg(p, '; ') from jsonb_array_elements_text(v_doc -> 'problems') p));
  end if;
  v_hash := esig.sha256_hex(esig.canonical_json(v_doc -> 'document'));
  select c.id into v_id from substance.coa c
   where c.lot_id = p_lot and c.document_sha256 = v_hash and substance.coa_state(c.id) = 'PREPARED'
   order by c.prepared_at desc, c.id limit 1;
  if v_id is not null then
    return v_id;
  end if;
  insert into substance.coa (lot_id, document, document_sha256, prepared_by_person, prepared_by_account, correlation_id)
  values (p_lot, v_doc -> 'document', v_hash, (v_actor ->> 'person_id')::uuid, (v_actor ->> 'account_id')::uuid, (v_actor ->> 'correlation_id')::uuid)
  returning id into v_id;
  return v_id;
end
$$;

-- RELEASE.MANUFACTURER: the quality unit's dated signature of a prepared CoA (header).
create function substance.sign_coa(p_coa uuid, p_signature uuid) returns void
language plpgsql volatile security definer set search_path = pg_catalog, substance, recipe, iam, esig, pg_temp as $$
declare
  v_actor jsonb;
  c       substance.coa;
  v_doc   jsonb;
  v_prob  text;
begin
  perform iam.assert_not_administrator();
  select * into c from substance.coa x where x.id = p_coa;
  if c.id is null then
    raise exception using errcode = 'P0001', message = format('EBMR-COA-003 unknown CoA %s', coalesce(p_coa::text, 'NULL'));
  end if;
  v_actor := iam.require_permission('RELEASE.MANUFACTURER', recipe.release_scope(c.lot_id));
  perform pg_advisory_xact_lock(hashtext('substance.coa:' || c.lot_id::text));
  if substance.coa_state(c.id) <> 'PREPARED' then
    raise exception using errcode = 'P0001', message = format('EBMR-COA-004 the CoA %s is %s; a CoA is signed once (AS-17)', c.id, substance.coa_state(c.id));
  end if;
  if not substance.coa_intact(c.id) then
    raise exception using errcode = 'P0001', message = format('EBMR-COA-005 the stored CoA %s no longer matches its SHA-256: it is not signed (DI-41)', c.id);
  end if;
  v_doc := substance.coa_document(c.lot_id);
  if jsonb_array_length(v_doc -> 'problems') > 0 then
    raise exception using errcode = 'P0001',
      message = format('EBMR-COA-006 the CoA cannot be signed now: %s (AS-17)', (select string_agg(p, '; ') from jsonb_array_elements_text(v_doc -> 'problems') p));
  end if;
  if esig.sha256_hex(esig.canonical_json(v_doc -> 'document')) <> c.document_sha256 then
    raise exception using errcode = 'P0001',
      message = 'EBMR-COA-007 the lot''s records changed since this CoA was prepared: prepare it again and sign the new one (AS-17)';
  end if;
  perform esig.assert_signature(p_signature, 'COA_APPROVED', 'substance_coa', c.id::text);
  v_prob := esig.signature_state_problem(p_signature);
  if v_prob is not null then
    raise exception using errcode = 'P0001', message = 'EBMR-COA-008 ' || v_prob;
  end if;
  if (select g.signer_person from esig.signature g where g.id = p_signature)::text is distinct from v_actor ->> 'person_id' then
    raise exception using errcode = 'P0001', message = 'EBMR-COA-009 the CoA signature is recorded by the person who signed it';
  end if;
  insert into substance.coa_signature (coa_id, signature_id, signed_by_person, signed_by_account)
  values (c.id, p_signature, (v_actor ->> 'person_id')::uuid, (v_actor ->> 'account_id')::uuid);
end
$$;

revoke all on function substance.coa_document(uuid), substance.coa_state(uuid), substance.coa_intact(uuid), substance.coa_content(text),
                       substance.prepare_coa(uuid), substance.sign_coa(uuid, uuid) from public;
grant select on substance.coa, substance.coa_signature to ebmr_app;
grant execute on function substance.coa_document(uuid), substance.coa_state(uuid), substance.coa_intact(uuid),
                          substance.prepare_coa(uuid), substance.sign_coa(uuid, uuid) to ebmr_app;

select kernel.set_actor_context(jsonb_build_object(
  'person_id', '00000000-0000-0000-0000-000000000000', 'account_id', '00000000-0000-0000-0000-000000000000',
  'role_code', 'SOFTWARE_RELEASE', 'session_id', '00000000-0000-0000-0000-000000000000', 'source', 'SYSTEM',
  'site_zone', 'UTC', 'correlation_id', gen_random_uuid(),
  'legal_name', 'Software release (substance migration 5005_api_coa)',
  'reason_code', 'SOFTWARE_RELEASE',
  'reason_text', 'the API edition: the certificate of analysis of a released lot, signed by the quality unit (AS-17)'));

select esig.register_content_provider('substance_coa', 'substance.coa_content(text)',
  'A certificate of analysis of a released API lot: the document as prepared and its SHA-256 (API plan C3)');

insert into esig.meaning_type (code, version, origin, is_minimum, status, category, role_class, title, meaning_text, permissions,
                               independent_of, excludes_performers, excludes_involved, witness, reauth, delegable, sources)
values
  ('COA_APPROVED', 1, 'VENDOR', true, 'ACTIVE', 'RELEASE', 'APPROVER', 'Certificate of analysis approved',
   'Quality-unit approval: I approve this certificate of analysis of the released lot as shown, its tests, limits and results, and sign it with today''s date.',
   array['RELEASE.MANUFACTURER'], '{}', false, false, false, 'ALL_COMPONENTS', false,
   'Revised Schedule M and ICH Q7 on certificates of analysis (API plan C3); AS-17; DI-35');

select kernel.set_actor_context(null);

reset role;
