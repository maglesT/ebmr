-- Phase 7 slice 7b-1 (review residual 6jc-R6; DI-18): the DSC enrolment and the DSC record refuse administrators.
--
-- Handbook: modules/kernel.md
--
-- esig.enrol_dsc_certificate and esig.record_dsc_signature (kernel 1206) did not call iam.assert_not_administrator().
-- No GMP data was reachable (the enrolment is the actor's own personal HUMAN account, and a DSC rides on a password
-- signature the kernel already refuses to administrators), but every other definer that writes signature evidence states
-- the refusal itself, and the authorization meta scan of the esig schema (6jc-R7, this slice) now looks for it.
--
--   esig.enrol_dsc_certificate(dsc)          CREATE OR REPLACE from its only definition (1206): first
--                                            iam.assert_not_administrator() (EBMR-IAM-042), then every check of 1206 in
--                                            its order and with its messages.
--   esig.record_dsc_signature(signature, dsc) CREATE OR REPLACE from its latest definition (1206): likewise.
--   esig.end_dsc_enrolment(enrolment, reason) CREATE OR REPLACE from its only definition (1206): likewise (it refused an
--                                            administrator only on the quality unit's path, after MBR.APPROVE; that
--                                            refusal stays where it was).
-- Same signatures, owner, SECURITY DEFINER, search_path and privileges. A later migration that re-creates either starts
-- from this definition.

set local role ebmr_owner;

-- p_dsc: {signature (base64, over the enrolment statement), chain, leafSha256, leafSubject, leafSerial, leafValidFrom,
-- leafValidTo, algorithm}, verified by the server first.
create or replace function esig.enrol_dsc_certificate(p_dsc jsonb) returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, esig, iam, pg_temp as $$
declare
  v_actor   jsonb := iam.assert_validated_actor();
  v_person  uuid := (v_actor ->> 'person_id')::uuid;
  v_account uuid := (v_actor ->> 'account_id')::uuid;
  acc       iam.account;
  a         esig.dsc_trust_anchor;
  v_chain   bytea[];
  v_leaf    text;
  v_old     esig.dsc_enrolment;
  v_id      uuid;
begin
  -- Phase 7 slice 7b-1 (kernel 1321, 6jc-R6): administrators never enrol or record a DSC (DI-18).
  perform iam.assert_not_administrator();
  select * into acc from iam.account x where x.id = v_account;
  if acc.id is null or acc.kind <> 'HUMAN' or acc.status <> 'ACTIVE' or acc.is_generic or acc.is_break_glass or acc.person_id is distinct from v_person then
    raise exception using errcode = 'P0001', message = 'EBMR-ESIG-086 a DSC certificate is enrolled by its own person, from an active, personal (HUMAN) account';
  end if;
  if esig.dsc_mode() = 'OFF' then
    raise exception using errcode = 'P0001', message = 'EBMR-ESIG-086 the India DSC option is off; there is nothing to enrol a certificate for';
  end if;
  a := esig.dsc_live_anchor(esig.dsc_mode());
  if a.id is null then
    raise exception using errcode = 'P0001', message = 'EBMR-ESIG-082 no live trust anchor is configured for the India DSC';
  end if;
  begin
    v_chain := array(select decode(x, 'base64') from jsonb_array_elements_text(p_dsc -> 'chain') with ordinality t(x, n) order by n);
  exception when others then
    raise exception using errcode = 'P0001', message = 'EBMR-ESIG-085 the DSC chain is not base64 DER';
  end;
  if cardinality(v_chain) < 2 or encode(sha256(v_chain[cardinality(v_chain)]), 'hex') <> a.root_sha256 then
    raise exception using errcode = 'P0001', message = 'EBMR-ESIG-085 the DSC chain does not end at the configured trust anchor';
  end if;
  v_leaf := encode(sha256(v_chain[1]), 'hex');
  if v_leaf is distinct from lower(p_dsc ->> 'leafSha256') then
    raise exception using errcode = 'P0001', message = 'EBMR-ESIG-085 the signer certificate is not the first of the chain';
  end if;
  -- Two people enrolling one certificate at once, or one person twice, wait for each other.
  perform pg_advisory_xact_lock(hashtextextended('esig.dsc_enrolment:' || v_leaf, 0));
  perform pg_advisory_xact_lock(hashtextextended('esig.dsc_enrolment_person:' || v_person::text, 0));
  if exists (select 1 from esig.dsc_enrolment e
              where e.leaf_sha256 = v_leaf and e.person_id <> v_person
                and not exists (select 1 from esig.dsc_enrolment_end x where x.enrolment_id = e.id)) then
    raise exception using errcode = 'P0001', message = 'EBMR-ESIG-086 IN-10: this certificate is enrolled for another person; a certificate signs for one person only';
  end if;
  -- One live enrolment per person and anchor: the new one ends the old one.
  for v_old in select e.* from esig.dsc_enrolment e
                where e.person_id = v_person and e.anchor_id = a.id
                  and not exists (select 1 from esig.dsc_enrolment_end x where x.enrolment_id = e.id) loop
    insert into esig.dsc_enrolment_end (enrolment_id, reason, ended_by_person, ended_by_account, correlation_id)
    values (v_old.id, 'replaced by a new enrolment', v_person, v_account, (v_actor ->> 'correlation_id')::uuid);
  end loop;
  insert into esig.dsc_enrolment (person_id, account_id, anchor_id, statement, proof_value, algorithm, chain_der, leaf_sha256,
                                  leaf_subject, leaf_serial, leaf_valid_from, leaf_valid_to, correlation_id)
  values (v_person, v_account, a.id, esig.dsc_enrolment_statement(v_person, v_account), decode(p_dsc ->> 'signature', 'base64'),
          p_dsc ->> 'algorithm', v_chain, v_leaf, p_dsc ->> 'leafSubject', p_dsc ->> 'leafSerial',
          (p_dsc ->> 'leafValidFrom')::timestamptz, (p_dsc ->> 'leafValidTo')::timestamptz, (v_actor ->> 'correlation_id')::uuid)
  returning id into v_id;
  return v_id;
end
$$;


-- As 1206 (replaced from 1203): the certificate must be the signer's live enrolment.
create or replace function esig.record_dsc_signature(p_signature uuid, p_dsc jsonb) returns void
language plpgsql volatile security definer set search_path = pg_catalog, esig, iam, pg_temp as $$
declare
  v_actor  jsonb := iam.assert_validated_actor();
  s        esig.signature;
  v_xmin   xid;
  a        esig.dsc_trust_anchor;
  v_chain  bytea[];
  v_stmt   text;
  v_enrol  esig.dsc_enrolment;
begin
  -- Phase 7 slice 7b-1 (kernel 1321, 6jc-R6): administrators never enrol or record a DSC (DI-18).
  perform iam.assert_not_administrator();
  select * into s from esig.signature sg where sg.id = p_signature;
  select sg.xmin into v_xmin from esig.signature sg where sg.id = p_signature;
  if s.id is null or v_xmin is distinct from pg_current_xact_id()::xid then
    raise exception using errcode = 'P0001', message = 'EBMR-ESIG-083 a DSC is recorded in the command that made its password signature';
  end if;
  if not esig.dsc_required(s.meaning_code) then
    raise exception using errcode = 'P0001', message = format('EBMR-ESIG-083 no DSC is configured for %s now', s.meaning_code);
  end if;
  a := esig.dsc_live_anchor(esig.dsc_mode());
  if a.id is null then
    raise exception using errcode = 'P0001', message = 'EBMR-ESIG-082 no live trust anchor is configured for the India DSC';
  end if;
  begin
    v_chain := array(select decode(x, 'base64') from jsonb_array_elements_text(p_dsc -> 'chain') with ordinality t(x, n) order by n);
  exception when others then
    raise exception using errcode = 'P0001', message = 'EBMR-ESIG-085 the DSC chain is not base64 DER';
  end;
  if cardinality(v_chain) < 2 or encode(sha256(v_chain[cardinality(v_chain)]), 'hex') <> a.root_sha256 then
    raise exception using errcode = 'P0001', message = 'EBMR-ESIG-085 the DSC chain does not end at the configured trust anchor';
  end if;
  if encode(sha256(v_chain[1]), 'hex') is distinct from lower(p_dsc ->> 'leafSha256') then
    raise exception using errcode = 'P0001', message = 'EBMR-ESIG-085 the signer certificate is not the first of the chain';
  end if;
  v_enrol := esig.dsc_live_enrolment(s.signer_person);
  if v_enrol.id is null or v_enrol.leaf_sha256 <> lower(p_dsc ->> 'leafSha256') then
    raise exception using errcode = 'P0001',
      message = 'EBMR-ESIG-087 IN-10: the DSC certificate is not the one enrolled for the signer; enrol your own certificate first';
  end if;
  v_stmt := esig.dsc_statement(s.challenge_id);
  insert into esig.dsc_signature (signature_id, mode, anchor_id, statement, statement_sha256, signature_value, algorithm, chain_der,
                                  leaf_sha256, leaf_subject, leaf_serial, leaf_valid_from, leaf_valid_to)
  values (s.id, a.kind, a.id, v_stmt, encode(sha256(convert_to(v_stmt, 'UTF8')), 'hex'), decode(p_dsc ->> 'signature', 'base64'),
          p_dsc ->> 'algorithm', v_chain, lower(p_dsc ->> 'leafSha256'), p_dsc ->> 'leafSubject', p_dsc ->> 'leafSerial',
          (p_dsc ->> 'leafValidFrom')::timestamptz, (p_dsc ->> 'leafValidTo')::timestamptz);
  perform v_actor;
end
$$;

-- Ends an enrolment: the person themselves, or the quality unit (MBR.APPROVE).
create or replace function esig.end_dsc_enrolment(p_enrolment uuid, p_reason text) returns void
language plpgsql volatile security definer set search_path = pg_catalog, esig, iam, kernel, pg_temp as $$
declare
  v_actor jsonb := iam.assert_validated_actor();
  e       esig.dsc_enrolment;
begin
  -- Phase 7 slice 7b-1 (kernel 1321, 6jc-R6): administrators never end an enrolment either, their own included (DI-18);
  -- the quality unit's path below keeps its own refusal.
  perform iam.assert_not_administrator();
  select * into e from esig.dsc_enrolment x where x.id = p_enrolment;
  if e.id is null or exists (select 1 from esig.dsc_enrolment_end x where x.enrolment_id = e.id) then
    raise exception using errcode = 'P0001', message = 'EBMR-ESIG-088 no live DSC enrolment with this id';
  end if;
  if kernel.is_blank(p_reason) then
    raise exception using errcode = 'P0001', message = 'EBMR-ESIG-088 ending a DSC enrolment needs a reason';
  end if;
  if e.person_id is distinct from (v_actor ->> 'person_id')::uuid then
    v_actor := iam.require_permission('MBR.APPROVE', '{}'::jsonb);
    perform iam.assert_not_administrator();
  end if;
  insert into esig.dsc_enrolment_end (enrolment_id, reason, ended_by_person, ended_by_account, correlation_id)
  values (e.id, btrim(p_reason), (v_actor ->> 'person_id')::uuid, (v_actor ->> 'account_id')::uuid, (v_actor ->> 'correlation_id')::uuid);
end
$$;

reset role;
