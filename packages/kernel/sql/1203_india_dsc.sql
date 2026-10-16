-- Phase 6 slice 6f: the India DSC second signature becomes real, with a TEST CA as its trust anchor in v1 (IN-10;
-- decision 0001 item 3 = B; D-P6f-3, D-P6f-4).
--
-- Handbook: modules/kernel.md
--
-- The IT Act 2000 (section 3A and its Second Schedule; section 5) recognises an electronic signature made with a
-- reliable technique under a certificate from a licensed certifying authority, whose chain ends at the root run by the
-- Controller of Certifying Authorities (paraphrased; legal status secondary until counsel's opinion). Decision 0001
-- item 3: optional per signature meaning; off until a licensed CA or eSign provider is configured; a TEST CA in v1,
-- shown with a banner while the counsel questions are open.
--
--   esig.india_dsc (policy, kernel 0200)  now takes OFF (default), TEST_CA and LICENSED (esig.policy_allowed_values;
--                                 esig.set_policy and esig.policy_values replaced from 0210 / 0200 to read it). TEST_CA
--                                 needs a live TEST_CA anchor; LICENSED needs a live LICENSED anchor, which cannot be
--                                 registered in v1 (EBMR-ESIG-081): it stays refused until the legal opinion (deployment).
--   esig.dsc_trust_anchor         insert-only: the root certificate (DER and SHA-256) the chains must end at, of kind
--                                 TEST_CA or LICENSED; esig.dsc_trust_anchor_retirement ends one. One live anchor per kind.
--   esig.dsc_meaning_setting      insert-only: per signature meaning, whether a DSC is required while the policy is on;
--                                 without a row, the default proposal APPROVED (MBR approval) and MANUFACTURER_RELEASE
--                                 (the AP's release) are required.
--   esig.dsc_signature            insert-only, written only by esig.record_dsc_signature in the signing command: the DSC
--                                 beside its password signature (statement, signature value, chain, signer certificate,
--                                 the anchor and mode it was verified against).
--
-- The statement the token signs is the database's (esig.dsc_statement): canonical JSON of the challenge id, the content
-- hash, the meaning and the record, so the DSC is over the same content hash as the password signature and cannot be
-- replayed onto another challenge. The server verifies the chain and the signature (packages/kernel/src/esig/dsc.ts;
-- X.509 is not parsed in SQL); esig.record_dsc_signature checks what the database can: the signature was made in this
-- transaction, a DSC is required for its meaning now, the statement and its SHA-256 are the challenge's, the last
-- certificate of the chain is the live anchor of the current mode. A deferred trigger refuses to commit a signature whose
-- meaning needs a DSC without its DSC row (EBMR-ESIG-084).
--
-- Configuration of the anchor and of the per-meaning setting is made by the quality unit (MBR.APPROVE, never an
-- administrator), with a reason; builder A's configuration change control (kernel 1195) covers esig.policy_value, so
-- switching the mode needs an approved change record. [6f hook] The two new configuration tables are registered as
-- configuration areas once that interface is merged (see the slice 6f report).
-- Messages: EBMR-ESIG-080 to EBMR-ESIG-089.

set local role ebmr_owner;

-- ---------------------------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------------------------

create table esig.dsc_trust_anchor (
  id                    uuid primary key default gen_random_uuid(),
  kind                  text not null check (kind in ('TEST_CA', 'LICENSED')),
  label                 text not null check (btrim(label) <> '' and length(label) <= 200),
  subject               text not null check (btrim(subject) <> '' and length(subject) <= 1000),
  root_der              bytea not null check (length(root_der) between 64 and 16384),
  root_sha256           text not null check (root_sha256 ~ '^[0-9a-f]{64}$'),
  reason                text not null check (btrim(reason) <> ''),
  registered_by_person  uuid not null,
  registered_by_account uuid not null,
  recorded_at           timestamptz not null default clock_timestamp(),
  correlation_id        uuid not null
);
revoke all on esig.dsc_trust_anchor from public;

create table esig.dsc_trust_anchor_retirement (
  anchor_id           uuid primary key references esig.dsc_trust_anchor (id),
  reason              text not null check (btrim(reason) <> ''),
  retired_by_person   uuid not null,
  retired_by_account  uuid not null,
  recorded_at         timestamptz not null default clock_timestamp(),
  correlation_id      uuid not null
);
revoke all on esig.dsc_trust_anchor_retirement from public;

create table esig.dsc_meaning_setting (
  id              bigint generated always as identity primary key,
  meaning_code    text not null,
  required        boolean not null,
  reason          text not null check (btrim(reason) <> ''),
  set_by_person   uuid not null,
  set_by_account  uuid not null,
  recorded_at     timestamptz not null default clock_timestamp(),
  correlation_id  uuid not null
);
revoke all on esig.dsc_meaning_setting from public;
create index dsc_meaning_setting_code on esig.dsc_meaning_setting (meaning_code, id desc);

create table esig.dsc_signature (
  signature_id      uuid primary key references esig.signature (id),
  mode              text not null check (mode in ('TEST_CA', 'LICENSED')),
  anchor_id         uuid not null references esig.dsc_trust_anchor (id),
  statement         text not null,
  statement_sha256  text not null check (statement_sha256 ~ '^[0-9a-f]{64}$'),
  signature_value   bytea not null check (length(signature_value) between 32 and 1024),
  algorithm         text not null check (btrim(algorithm) <> ''),
  chain_der         bytea[] not null check (cardinality(chain_der) between 2 and 6),
  leaf_sha256       text not null check (leaf_sha256 ~ '^[0-9a-f]{64}$'),
  leaf_subject      text not null,
  leaf_serial       text not null,
  leaf_valid_from   timestamptz not null,
  leaf_valid_to     timestamptz not null,
  recorded_at       timestamptz not null default clock_timestamp()
);
revoke all on esig.dsc_signature from public;

select platform.enforce_db_time('esig.dsc_trust_anchor', array['recorded_at']);
select platform.enforce_db_time('esig.dsc_trust_anchor_retirement', array['recorded_at']);
select platform.enforce_db_time('esig.dsc_meaning_setting', array['recorded_at']);
select platform.enforce_db_time('esig.dsc_signature', array['recorded_at']);
select kernel.register_audited_table('esig.dsc_trust_anchor', 'esig_dsc_anchor', 'id', true);
select kernel.register_audited_table('esig.dsc_trust_anchor_retirement', 'esig_dsc_anchor', 'anchor_id', true);
select kernel.register_audited_table('esig.dsc_meaning_setting', 'esig_dsc_meaning', 'meaning_code', true);
select kernel.register_audited_table('esig.dsc_signature', 'esig_dsc_signature', 'signature_id', true);
select esig.protect_log('esig.dsc_trust_anchor');
select esig.protect_log('esig.dsc_trust_anchor_retirement');
select esig.protect_log('esig.dsc_meaning_setting');
select esig.protect_log('esig.dsc_signature');

-- ---------------------------------------------------------------------------------------------
-- Policy values
-- ---------------------------------------------------------------------------------------------

-- The values a TEXT policy takes now (esig.policy_key is insert-only; esig.india_dsc gained TEST_CA and LICENSED here).
create function esig.policy_allowed_values(p_key text) returns text[]
language sql stable security definer set search_path = pg_catalog, esig, pg_temp as $$
  select case when p_key = 'esig.india_dsc' then array['OFF', 'TEST_CA', 'LICENSED']
              else (select k.allowed_values from esig.policy_key k where k.key = p_key) end
$$;

-- esig.set_policy: CREATE OR REPLACE from its only definition (0210), same signature, owner, SECURITY DEFINER, search_path
-- and privileges; the allowed values come from esig.policy_allowed_values.
create or replace function esig.set_policy(p_key text, p_value text, p_reason text, p_change_ref text) returns void
language plpgsql volatile security definer set search_path = pg_catalog, esig, iam, kernel, pg_temp as $$
declare
  v_actor jsonb := iam.require_permission('MBR.APPROVE', '{}'::jsonb);
  v_k     esig.policy_key%rowtype;
  v_n     bigint;
  v_vals  text[];
begin
  perform iam.assert_not_administrator();
  select * into v_k from esig.policy_key where key = p_key;
  if not found then
    raise exception using errcode = 'P0001', message = format('EBMR-ESIG-002 unknown e-signature policy key %s', p_key);
  end if;
  if coalesce(btrim(p_reason), '') = '' or coalesce(btrim(p_change_ref), '') = '' then
    raise exception using errcode = 'P0001', message = 'EBMR-ESIG-005 a policy change needs a reason and a change-control reference';
  end if;
  v_vals := esig.policy_allowed_values(p_key);
  if v_k.value_type = 'INTEGER' then
    if p_value !~ '^-?[0-9]{1,18}$' then
      raise exception using errcode = 'P0001', message = format('EBMR-ESIG-005 %s takes a whole number', p_key);
    end if;
    v_n := p_value::bigint;
    if (v_k.min_value is not null and v_n < v_k.min_value) or (v_k.max_value is not null and v_n > v_k.max_value) then
      raise exception using errcode = 'P0001',
        message = format('EBMR-ESIG-005 %s must lie between %s and %s', p_key, v_k.min_value, v_k.max_value);
    end if;
  elsif v_k.value_type = 'BOOLEAN' then
    if p_value not in ('true', 'false') then
      raise exception using errcode = 'P0001', message = format('EBMR-ESIG-005 %s takes true or false', p_key);
    end if;
  elsif v_vals is not null and not p_value = any (v_vals) then
    raise exception using errcode = 'P0001', message = format('EBMR-ESIG-005 %s takes one of %s', p_key, v_vals);
  end if;
  insert into esig.policy_value (key, value, set_by_person, set_by_account, reason, change_ref)
  values (p_key, p_value, (v_actor ->> 'person_id')::uuid, (v_actor ->> 'account_id')::uuid, p_reason, p_change_ref);
end
$$;

-- esig.policy_values: CREATE OR REPLACE from its only definition (0200), same signature and privileges.
create or replace function esig.policy_values() returns table (key text, value text, value_type text, min_value bigint, max_value bigint,
                                                      allowed_values text[], unit text, description text, basis text, is_default boolean)
language sql stable security definer set search_path = pg_catalog, esig, pg_temp as $$
  select k.key, esig.policy_text(k.key), k.value_type, k.min_value, k.max_value, esig.policy_allowed_values(k.key), k.unit,
         case when k.key = 'esig.india_dsc'
              then 'India option (IN-10): a second signature with a Class 3 DSC over the same content hash, for the meanings configured. OFF; TEST_CA (a test certificate authority, not legally valid, decision 0001 item 3); LICENSED only once a licensed CA or eSign provider is configured after the legal opinion'
              else k.description end,
         k.basis, not exists (select 1 from esig.policy_value v where v.key = k.key)
  from esig.policy_key k
  order by k.key
$$;

-- ---------------------------------------------------------------------------------------------
-- Reads
-- ---------------------------------------------------------------------------------------------

create function esig.dsc_mode() returns text
language sql stable security definer set search_path = pg_catalog, esig, pg_temp as $$
  select esig.policy_text('esig.india_dsc')
$$;

-- The live anchor of a kind (not retired), latest first.
create function esig.dsc_live_anchor(p_kind text) returns esig.dsc_trust_anchor
language sql stable security definer set search_path = pg_catalog, esig, pg_temp as $$
  select a.* from esig.dsc_trust_anchor a
   where a.kind = p_kind and not exists (select 1 from esig.dsc_trust_anchor_retirement r where r.anchor_id = a.id)
   order by a.recorded_at desc, a.id limit 1
$$;

-- Default proposal (decision 0001 item 3): MBR approval and the AP's manufacturer release.
create function esig.dsc_meaning_required(p_meaning text) returns boolean
language sql stable security definer set search_path = pg_catalog, esig, pg_temp as $$
  select coalesce((select s.required from esig.dsc_meaning_setting s where s.meaning_code = p_meaning order by s.id desc limit 1),
                  p_meaning in ('APPROVED', 'MANUFACTURER_RELEASE'))
$$;

-- A DSC is required for a signing with this meaning now: the policy is on and the meaning needs one.
create function esig.dsc_required(p_meaning text) returns boolean
language sql stable security definer set search_path = pg_catalog, esig, pg_temp as $$
  select esig.dsc_mode() <> 'OFF' and esig.dsc_meaning_required(p_meaning)
$$;

-- The statement the token signs for a challenge: canonical JSON over the same content hash.
create function esig.dsc_statement(p_challenge uuid) returns text
language sql stable security definer set search_path = pg_catalog, esig, pg_temp as $$
  select esig.canonical_json(jsonb_build_object(
           'format', 'EBMR-DSC-1', 'challenge_id', c.id, 'aggregate_type', c.aggregate_type, 'aggregate_id', c.aggregate_id,
           'content_version', c.content_version::text, 'content_sha256', c.content_hash, 'meaning', c.meaning_code))
    from esig.challenge c where c.id = p_challenge
$$;

-- What the screen asks for at a challenge: {required, mode, statement}.
create function esig.dsc_requirement(p_challenge uuid) returns jsonb
language sql stable security definer set search_path = pg_catalog, esig, pg_temp as $$
  select jsonb_build_object('required', coalesce(esig.dsc_required(c.meaning_code), false), 'mode', esig.dsc_mode(),
                            'statement', case when esig.dsc_required(c.meaning_code) then esig.dsc_statement(c.id) end)
    from (select 1) one left join esig.challenge c on c.id = p_challenge
$$;

-- For the server's verification in the signing command: {required, statement, anchor (base64 DER), at}.
create function esig.dsc_verification_input(p_signature uuid) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, esig, pg_temp as $$
declare
  s esig.signature;
  a esig.dsc_trust_anchor;
begin
  select * into s from esig.signature where id = p_signature;
  if s.id is null or not esig.dsc_required(s.meaning_code) then
    return jsonb_build_object('required', false, 'at', clock_timestamp());
  end if;
  a := esig.dsc_live_anchor(esig.dsc_mode());
  return jsonb_build_object('required', true, 'statement', esig.dsc_statement(s.challenge_id),
                            'anchor', case when a.id is null then null else encode(a.root_der, 'base64') end, 'at', clock_timestamp());
end
$$;

-- The configuration as the screens show it.
create function esig.dsc_configuration() returns jsonb
language sql stable security definer set search_path = pg_catalog, esig, pg_temp as $$
  select jsonb_build_object(
    'mode', esig.dsc_mode(),
    'anchors', coalesce((select jsonb_agg(jsonb_build_object('anchorId', a.id, 'kind', a.kind, 'label', a.label, 'subject', a.subject,
                                                             'rootSha256', a.root_sha256, 'recordedAt', a.recorded_at,
                                                             'live', not exists (select 1 from esig.dsc_trust_anchor_retirement r where r.anchor_id = a.id))
                                          order by a.recorded_at desc) from esig.dsc_trust_anchor a), '[]'::jsonb),
    'meanings', coalesce((select jsonb_agg(jsonb_build_object('meaning', m.code, 'required', esig.dsc_meaning_required(m.code)) order by m.code)
                            from (select distinct code from esig.meaning_type where status = 'ACTIVE') m), '[]'::jsonb))
$$;

-- ---------------------------------------------------------------------------------------------
-- Configuration acts (quality unit, never an administrator)
-- ---------------------------------------------------------------------------------------------

create function esig.register_dsc_anchor(p_kind text, p_label text, p_subject text, p_root_der bytea, p_reason text) returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, esig, iam, kernel, pg_temp as $$
declare
  v_actor jsonb := iam.require_permission('MBR.APPROVE', '{}'::jsonb);
  v_id    uuid;
  v_old   esig.dsc_trust_anchor;
begin
  perform iam.assert_not_administrator();
  if p_kind = 'LICENSED' then
    raise exception using errcode = 'P0001',
      message = 'EBMR-ESIG-081 a licensed CA or eSign provider is configured only after the legal opinion (decision 0001 item 3); v1 takes a TEST_CA anchor only';
  end if;
  if p_kind is distinct from 'TEST_CA' then
    raise exception using errcode = 'P0001', message = 'EBMR-ESIG-080 a DSC trust anchor is of kind TEST_CA or LICENSED';
  end if;
  if kernel.is_blank(p_label) or kernel.is_blank(p_subject) or kernel.is_blank(p_reason) or p_root_der is null then
    raise exception using errcode = 'P0001', message = 'EBMR-ESIG-080 a DSC trust anchor names its label, subject, root certificate and the reason';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('esig.dsc_trust_anchor:' || p_kind, 0));
  v_old := esig.dsc_live_anchor(p_kind);
  if v_old.id is not null then
    insert into esig.dsc_trust_anchor_retirement (anchor_id, reason, retired_by_person, retired_by_account, correlation_id)
    values (v_old.id, 'replaced by a new anchor: ' || btrim(p_reason), (v_actor ->> 'person_id')::uuid, (v_actor ->> 'account_id')::uuid,
            (v_actor ->> 'correlation_id')::uuid);
  end if;
  insert into esig.dsc_trust_anchor (kind, label, subject, root_der, root_sha256, reason, registered_by_person, registered_by_account, correlation_id)
  values (p_kind, btrim(p_label), btrim(p_subject), p_root_der, encode(sha256(p_root_der), 'hex'), btrim(p_reason),
          (v_actor ->> 'person_id')::uuid, (v_actor ->> 'account_id')::uuid, (v_actor ->> 'correlation_id')::uuid)
  returning id into v_id;
  return v_id;
end
$$;

create function esig.set_dsc_meaning(p_meaning text, p_required boolean, p_reason text) returns void
language plpgsql volatile security definer set search_path = pg_catalog, esig, iam, kernel, pg_temp as $$
declare
  v_actor jsonb := iam.require_permission('MBR.APPROVE', '{}'::jsonb);
begin
  perform iam.assert_not_administrator();
  if not exists (select 1 from esig.meaning_type m where m.code = p_meaning) then
    raise exception using errcode = 'P0001', message = format('EBMR-ESIG-080 unknown signature meaning %s', coalesce(p_meaning, 'NULL'));
  end if;
  if p_required is null or kernel.is_blank(p_reason) then
    raise exception using errcode = 'P0001', message = 'EBMR-ESIG-080 a DSC setting says whether the meaning needs a DSC, with a reason';
  end if;
  insert into esig.dsc_meaning_setting (meaning_code, required, reason, set_by_person, set_by_account, correlation_id)
  values (p_meaning, p_required, btrim(p_reason), (v_actor ->> 'person_id')::uuid, (v_actor ->> 'account_id')::uuid,
          (v_actor ->> 'correlation_id')::uuid);
end
$$;

-- The mode follows its anchor: TEST_CA needs a live TEST_CA anchor; LICENSED a live LICENSED one (none in v1). Every
-- writer of esig.policy_value is covered.
create function esig.dsc_policy_guard() returns trigger
language plpgsql security definer set search_path = pg_catalog, esig, pg_temp as $$
begin
  if new.key = 'esig.india_dsc' then
    if new.value = 'LICENSED' and (esig.dsc_live_anchor('LICENSED')).id is null then
      raise exception using errcode = 'P0001',
        message = 'EBMR-ESIG-081 LICENSED is refused until a licensed CA or eSign provider is configured after the legal opinion (decision 0001 item 3)';
    end if;
    if new.value = 'TEST_CA' and (esig.dsc_live_anchor('TEST_CA')).id is null then
      raise exception using errcode = 'P0001', message = 'EBMR-ESIG-082 TEST_CA needs a registered test-CA trust anchor first';
    end if;
  end if;
  return new;
end
$$;
create trigger ac_dsc_policy_guard before insert on esig.policy_value for each row execute function esig.dsc_policy_guard();

-- ---------------------------------------------------------------------------------------------
-- The DSC beside its signature
-- ---------------------------------------------------------------------------------------------

-- In the signing command, after esig.sign and the server's verification (packages/kernel/src/esig/dsc.ts).
-- p_dsc: {signature (base64), chain (base64 DER, signer first, root last), leafSha256, leafSubject, leafSerial,
-- leafValidFrom, leafValidTo, algorithm}.
create function esig.record_dsc_signature(p_signature uuid, p_dsc jsonb) returns void
language plpgsql volatile security definer set search_path = pg_catalog, esig, iam, pg_temp as $$
declare
  v_actor  jsonb := iam.assert_validated_actor();
  s        esig.signature;
  v_xmin   xid;
  a        esig.dsc_trust_anchor;
  v_chain  bytea[];
  v_stmt   text;
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
  v_stmt := esig.dsc_statement(s.challenge_id);
  insert into esig.dsc_signature (signature_id, mode, anchor_id, statement, statement_sha256, signature_value, algorithm, chain_der,
                                  leaf_sha256, leaf_subject, leaf_serial, leaf_valid_from, leaf_valid_to)
  values (s.id, a.kind, a.id, v_stmt, encode(sha256(convert_to(v_stmt, 'UTF8')), 'hex'), decode(p_dsc ->> 'signature', 'base64'),
          p_dsc ->> 'algorithm', v_chain, lower(p_dsc ->> 'leafSha256'), p_dsc ->> 'leafSubject', p_dsc ->> 'leafSerial',
          (p_dsc ->> 'leafValidFrom')::timestamptz, (p_dsc ->> 'leafValidTo')::timestamptz);
  perform v_actor;
end
$$;

-- No signature whose meaning needs a DSC commits without it.
create function esig.dsc_present_check() returns trigger
language plpgsql security definer set search_path = pg_catalog, esig, pg_temp as $$
begin
  if esig.dsc_required(new.meaning_code) and not exists (select 1 from esig.dsc_signature d where d.signature_id = new.id) then
    raise exception using errcode = 'P0001',
      message = format('EBMR-ESIG-084 IN-10: a %s signature needs a second signature with a Class 3 certificate (India DSC) in the same command', new.meaning_code);
  end if;
  return null;
end
$$;
create constraint trigger zz_dsc_present after insert on esig.signature deferrable initially deferred
  for each row execute function esig.dsc_present_check();

-- The DSC of a signature, for the record's signature list and the verifier.
create function esig.dsc_of(p_signature uuid) returns jsonb
language sql stable security definer set search_path = pg_catalog, esig, pg_temp as $$
  select jsonb_build_object('signatureId', d.signature_id, 'mode', d.mode, 'anchorSha256', a.root_sha256, 'anchorLabel', a.label,
                            'statementSha256', d.statement_sha256, 'leafSubject', d.leaf_subject, 'leafSerial', d.leaf_serial,
                            'leafSha256', d.leaf_sha256, 'algorithm', d.algorithm, 'recordedAt', d.recorded_at)
    from esig.dsc_signature d join esig.dsc_trust_anchor a on a.id = d.anchor_id where d.signature_id = p_signature
$$;

revoke all on function esig.policy_allowed_values(text), esig.dsc_mode(), esig.dsc_live_anchor(text), esig.dsc_meaning_required(text),
  esig.dsc_required(text), esig.dsc_statement(uuid), esig.dsc_requirement(uuid), esig.dsc_verification_input(uuid), esig.dsc_configuration(),
  esig.register_dsc_anchor(text, text, text, bytea, text), esig.set_dsc_meaning(text, boolean, text), esig.dsc_policy_guard(),
  esig.record_dsc_signature(uuid, jsonb), esig.dsc_present_check(), esig.dsc_of(uuid) from public;
grant select on esig.dsc_trust_anchor, esig.dsc_trust_anchor_retirement, esig.dsc_meaning_setting, esig.dsc_signature to ebmr_app;
grant execute on function esig.policy_allowed_values(text), esig.dsc_mode(), esig.dsc_required(text), esig.dsc_requirement(uuid),
  esig.dsc_verification_input(uuid), esig.dsc_configuration(), esig.register_dsc_anchor(text, text, text, bytea, text),
  esig.set_dsc_meaning(text, boolean, text), esig.record_dsc_signature(uuid, jsonb), esig.dsc_of(uuid) to ebmr_app;

reset role;
