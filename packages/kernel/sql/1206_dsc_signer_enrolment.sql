-- Phase 6 slice 6f, review fix: a DSC is accepted only from the certificate enrolled for the person who signs (IN-10;
-- kernel 1203; D-P6f-B-9).
--
-- Handbook: modules/kernel.md
--
-- Kernel 1203 checked that the DSC chain ends at the live anchor and that the token signed the challenge's statement, but
-- not whose certificate it was: any certificate of the CA would have stood beside any person's password signature. The
-- IT Act (paraphrased) attributes an electronic signature to the subscriber named in the certificate, and Part 11 needs
-- each signature to be unique to one person and never usable by another, so the certificate must be bound to its signer.
--
--   esig.dsc_enrolment      insert-only: one person's certificate (its SHA-256, subject, serial and validity, the chain and
--                           the anchor it was verified against), enrolled by that person in their own command with a
--                           proof of possession: the token's signature over esig.dsc_enrolment_statement (the person and
--                           the account), verified by the server (packages/kernel/src/esig/dsc.ts) like a signing DSC.
--   esig.dsc_enrolment_end  insert-only: the enrolment ended (a lost token, a new certificate), by the person or by the
--                           quality unit (MBR.APPROVE), with a reason.
-- Rules: a certificate is live-enrolled for one person only (EBMR-ESIG-086); a person has at most one live enrolment
-- per anchor (a new one ends the old one); an enrolment counts only for the anchor it was verified against, so a new
-- anchor needs new enrolments. esig.record_dsc_signature (replaced from 1203, its only definition, same signature,
-- owner, privileges) now also refuses a DSC whose signer certificate is not the live enrolment of the signature's
-- signer under the live anchor (EBMR-ESIG-087).
-- Messages: EBMR-ESIG-086 to EBMR-ESIG-088.

set local role ebmr_owner;

create table esig.dsc_enrolment (
  id               uuid primary key default gen_random_uuid(),
  person_id        uuid not null,
  account_id       uuid not null,
  anchor_id        uuid not null references esig.dsc_trust_anchor (id),
  statement        text not null,
  proof_value      bytea not null check (length(proof_value) between 32 and 1024),
  algorithm        text not null check (btrim(algorithm) <> ''),
  chain_der        bytea[] not null check (cardinality(chain_der) between 2 and 6),
  leaf_sha256      text not null check (leaf_sha256 ~ '^[0-9a-f]{64}$'),
  leaf_subject     text not null check (btrim(leaf_subject) <> ''),
  leaf_serial      text not null check (btrim(leaf_serial) <> ''),
  leaf_valid_from  timestamptz not null,
  leaf_valid_to    timestamptz not null,
  recorded_at      timestamptz not null default clock_timestamp(),
  correlation_id   uuid not null
);
revoke all on esig.dsc_enrolment from public;
create index dsc_enrolment_leaf on esig.dsc_enrolment (leaf_sha256);
create index dsc_enrolment_person on esig.dsc_enrolment (person_id, recorded_at desc);

create table esig.dsc_enrolment_end (
  enrolment_id    uuid primary key references esig.dsc_enrolment (id),
  reason          text not null check (btrim(reason) <> ''),
  ended_by_person  uuid not null,
  ended_by_account uuid not null,
  recorded_at     timestamptz not null default clock_timestamp(),
  correlation_id  uuid not null
);
revoke all on esig.dsc_enrolment_end from public;

select platform.enforce_db_time('esig.dsc_enrolment', array['recorded_at']);
select platform.enforce_db_time('esig.dsc_enrolment_end', array['recorded_at']);
select kernel.register_audited_table('esig.dsc_enrolment', 'esig_dsc_enrolment', 'id', true);
select kernel.register_audited_table('esig.dsc_enrolment_end', 'esig_dsc_enrolment', 'enrolment_id', true);
select esig.protect_log('esig.dsc_enrolment');
select esig.protect_log('esig.dsc_enrolment_end');

-- The text the token signs to enrol its certificate for this person and account (canonical JSON).
create function esig.dsc_enrolment_statement(p_person uuid, p_account uuid) returns text
language sql immutable set search_path = pg_catalog, esig, pg_temp as $$
  select esig.canonical_json(jsonb_build_object('format', 'EBMR-DSC-ENROL-1', 'person_id', p_person, 'account_id', p_account))
$$;

-- The live enrolments (not ended) under the live anchor of the current mode.
create function esig.dsc_live_enrolment(p_person uuid) returns esig.dsc_enrolment
language sql stable security definer set search_path = pg_catalog, esig, pg_temp as $$
  select e.* from esig.dsc_enrolment e
   where e.person_id = p_person and e.anchor_id = (esig.dsc_live_anchor(esig.dsc_mode())).id
     and not exists (select 1 from esig.dsc_enrolment_end x where x.enrolment_id = e.id)
   order by e.recorded_at desc limit 1
$$;

-- What the server verifies an enrolment against, in the enrolling person's own command: {statement, anchor, at}.
create function esig.dsc_enrolment_input() returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, esig, iam, pg_temp as $$
declare
  v_actor jsonb := iam.assert_validated_actor();
  a       esig.dsc_trust_anchor;
begin
  if esig.dsc_mode() = 'OFF' then
    raise exception using errcode = 'P0001', message = 'EBMR-ESIG-086 the India DSC option is off; there is nothing to enrol a certificate for';
  end if;
  a := esig.dsc_live_anchor(esig.dsc_mode());
  if a.id is null then
    raise exception using errcode = 'P0001', message = 'EBMR-ESIG-082 no live trust anchor is configured for the India DSC';
  end if;
  return jsonb_build_object('statement', esig.dsc_enrolment_statement((v_actor ->> 'person_id')::uuid, (v_actor ->> 'account_id')::uuid),
                            'anchor', encode(a.root_der, 'base64'), 'at', clock_timestamp());
end
$$;

-- p_dsc: {signature (base64, over the enrolment statement), chain, leafSha256, leafSubject, leafSerial, leafValidFrom,
-- leafValidTo, algorithm}, verified by the server first.
create function esig.enrol_dsc_certificate(p_dsc jsonb) returns uuid
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

-- Ends an enrolment: the person themselves, or the quality unit (MBR.APPROVE).
create function esig.end_dsc_enrolment(p_enrolment uuid, p_reason text) returns void
language plpgsql volatile security definer set search_path = pg_catalog, esig, iam, kernel, pg_temp as $$
declare
  v_actor jsonb := iam.assert_validated_actor();
  e       esig.dsc_enrolment;
begin
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

-- A person's enrolments, for their own screen: [{enrolmentId, leafSubject, leafSerial, leafSha256, leafValidTo, anchorLabel,
-- recordedAt, live}], newest first.
create function esig.dsc_enrolments_of(p_person uuid) returns jsonb
language sql stable security definer set search_path = pg_catalog, esig, pg_temp as $$
  select coalesce(jsonb_agg(jsonb_build_object('enrolmentId', e.id, 'leafSubject', e.leaf_subject, 'leafSerial', e.leaf_serial,
                                               'leafSha256', e.leaf_sha256, 'leafValidTo', e.leaf_valid_to, 'anchorLabel', a.label,
                                               'recordedAt', e.recorded_at,
                                               'live', e.id is not distinct from (esig.dsc_live_enrolment(p_person)).id)
                            order by e.recorded_at desc), '[]'::jsonb)
    from esig.dsc_enrolment e join esig.dsc_trust_anchor a on a.id = e.anchor_id
   where e.person_id = p_person
$$;

-- Replaced from 1203 (its only definition): also the certificate must be the signer's live enrolment.
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

revoke all on function esig.dsc_enrolment_statement(uuid, uuid), esig.dsc_live_enrolment(uuid), esig.dsc_enrolment_input(),
  esig.enrol_dsc_certificate(jsonb), esig.end_dsc_enrolment(uuid, text), esig.dsc_enrolments_of(uuid) from public;
grant select on esig.dsc_enrolment, esig.dsc_enrolment_end to ebmr_app;
grant execute on function esig.dsc_enrolment_statement(uuid, uuid), esig.dsc_enrolment_input(), esig.enrol_dsc_certificate(jsonb),
  esig.end_dsc_enrolment(uuid, text), esig.dsc_enrolments_of(uuid) to ebmr_app;

reset role;
