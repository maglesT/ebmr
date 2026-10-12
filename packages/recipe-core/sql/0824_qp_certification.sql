-- Recipe core: the EU disposition, its certification intake and the in-system QP register (Phase 4 slice 4a; outline
-- 5.2.6 EU, 5.7, decision 1 point 2; controls DI-39, DI-30, PR-55, INV-39, INV-35, PR-56; ADR 0012, ADR 0013).
-- recipe.eu_outcome and recipe.market_rejections are replaced from their latest definitions (0822).
--
-- The EU importer registry (0820): recipe.register_eu_importer(definition, signature) QA, signed EU_IMPORTER_APPROVED on
--   eu_importer <code>/<sha256 of the canonical definition>; the products it imports (one importer per product) and the
--   Ed25519 key its certification messages are signed with.
-- The certification register recipe.qp_certification (insert-only, audited; PR-55: batch, product, market, QP, time and
--   the checklist relied on): one row per outcome received or given, with its source:
--   MESSAGE      a structured message signed by the importer's key (format ebmr.qp-certification.v1), verified by the
--                edition's intake definer (tablets 1180: Ed25519 in the database) and taken in by
--                recipe.take_qp_message (owner only): every message gets an acknowledgement row (ACCEPTED or REFUSED
--                with the database's reason) returned to the sender (DI-39); a refused message changes nothing else.
--   TRANSCRIBED  the fallback (DI-30): QA records the details read from the certification (QP_CERTIFICATION_RECORDED on
--                qp_transcription <lot>/<sha256 of the details>); it counts only once another QA person verifies it
--                (QP_CERTIFICATION_VERIFIED on qp_transcription_check <id>; never the transcriber).
--   IN_SYSTEM    with the switch release.in_system_qp_certification ON (default OFF, PR-55), a QP registered in
--                recipe.qp_register (QA's signed QP_REGISTERED; append-only, REGISTER or WITHDRAW) signs QP_CERTIFIED on
--                qp_certification <lot>/<outcome> over the EU checklist at an unchanged epoch (INV-05), never involved in
--                the lot's records (INV-35).
-- Every outcome needs, at the instant it takes effect (intake, verification, signature): EU in the lot's set, not
-- INELIGIBLE, the manufacturer release RELEASED (INV-39), no effective outcome yet; CERTIFIED also needs the EU
-- disposition AWAITING_QP_CERTIFICATION (G-REL for EU ready); the certifier's MIA number is the importer's; the
-- certification date is neither in the future nor before the manufacturer release. REJECTED_BY_QP needs the QP's reason
-- and is visible to every other market (G11.MARKET_REJECTIONS, PR-56).
-- New meanings: QP_CERTIFICATION_VERIFIED, EU_IMPORTER_APPROVED, QP_REGISTERED (QA, RECORD.QA_REVIEW).
-- Messages: EBMR-DSP-050 to EBMR-DSP-089.

set local role ebmr_owner;

select kernel.set_actor_context(jsonb_build_object(
  'person_id', '00000000-0000-0000-0000-000000000000', 'account_id', '00000000-0000-0000-0000-000000000000',
  'role_code', 'SOFTWARE_RELEASE', 'session_id', '00000000-0000-0000-0000-000000000000', 'source', 'SYSTEM',
  'site_zone', 'UTC', 'correlation_id', gen_random_uuid(),
  'legal_name', 'Software release (recipe-core migration 0824_qp_certification)',
  'reason_code', 'SOFTWARE_RELEASE',
  'reason_text', 'EU certification intake, transcription check and the in-system QP register (DI-39, DI-30, PR-55)'));

insert into esig.meaning_type (code, version, origin, is_minimum, status, category, role_class, title, meaning_text, permissions,
                               independent_of, excludes_performers, excludes_involved, witness, reauth, delegable, sources)
values
  ('QP_CERTIFICATION_VERIFIED', 1, 'VENDOR', true, 'ACTIVE', 'RELEASE', 'VERIFIER', 'QP certification transcription verified',
   'As second person, I verified this transcription of the qualified person''s certification against the certification received.',
   array['RECORD.QA_REVIEW'], array['QP_CERTIFICATION_RECORDED'], true, false, false, 'ALL_COMPONENTS', false, 'DI-30; DI-39; outline 5.2.6 EU'),
  ('EU_IMPORTER_APPROVED', 1, 'VENDOR', true, 'ACTIVE', 'REVIEW', 'APPROVER', 'EU importer approved',
   'Quality unit: I approve this EU importer, its technical agreement, products and message key as stated.',
   array['RECORD.QA_REVIEW'], '{}', false, false, false, 'ALL_COMPONENTS', false, 'DI-39; outline 4.6 shipping rule'),
  ('QP_REGISTERED', 1, 'VENDOR', true, 'ACTIVE', 'REVIEW', 'APPROVER', 'Qualified person registered',
   'Quality unit: I register (or withdraw) this account as a qualified person named on the authorisation stated.',
   array['RECORD.QA_REVIEW'], '{}', false, false, false, 'ALL_COMPONENTS', false, 'PR-55; DI-39');

insert into platform.setting_definition (key, value_type, default_value, min_value, max_value, allowed_values, max_scale, unit, description, basis)
values ('release.in_system_qp_certification', 'TEXT', 'OFF', null, null, array['OFF', 'ON'], null, null,
        'PR-55: a qualified person registered in the system certifies EU lots here (otherwise the certification of the EU importer''s QP is received)',
        'Decision 1 point 2 and outline 5.2.6: in-system QP certification is a tenant switch, OFF by default (DI-39, PR-55)');

select kernel.set_actor_context(null);

-- ---------------------------------------------------------------------------------------------
-- Tables (insert-only, audited; the application role reads them, the definers write them)
-- ---------------------------------------------------------------------------------------------

create table recipe.qp_register (
  id            uuid primary key default gen_random_uuid(),
  person_id     uuid not null,
  action        text not null check (action in ('REGISTER', 'WITHDRAW')),
  mia_number    text not null check (btrim(mia_number) <> '' and length(mia_number) <= 64),
  importer_id   uuid not null references recipe.eu_importer (id),
  signature_id  uuid not null unique,
  by_person     uuid not null,
  by_account    uuid not null,
  recorded_at   timestamptz not null default clock_timestamp()
);

create table recipe.qp_certification (
  id               uuid primary key default gen_random_uuid(),
  lot_id           uuid not null,
  source           text not null check (source in ('MESSAGE', 'TRANSCRIBED', 'IN_SYSTEM')),
  outcome          text not null check (outcome in ('CERTIFIED', 'REJECTED_BY_QP')),
  certifier        text not null check (btrim(certifier) <> '' and length(certifier) <= 200),
  mia_number       text not null check (btrim(mia_number) <> '' and length(mia_number) <= 64),
  certified_at     timestamptz not null,
  importer_id      uuid references recipe.eu_importer (id),
  reference        text not null check (btrim(reference) <> '' and length(reference) <= 128),
  reason           text check (reason is null or btrim(reason) <> ''),
  details_sha256   text check (details_sha256 is null or details_sha256 ~ '^[0-9a-f]{64}$'),
  message          text,
  message_sha256   text check (message_sha256 is null or message_sha256 ~ '^[0-9a-f]{64}$'),
  signature_id     uuid unique,
  epoch            text check (epoch is null or epoch ~ '^[0-9a-f]{64}$'),
  checklist        jsonb,
  person_id        uuid not null,
  account_id       uuid not null,
  recorded_at      timestamptz not null default clock_timestamp(),
  check (outcome = 'CERTIFIED' or reason is not null),
  check ((source = 'MESSAGE') = (message is not null and message_sha256 is not null)),
  check (source = 'MESSAGE' or signature_id is not null),
  check ((source = 'TRANSCRIBED') = (details_sha256 is not null))
);
create index qp_certification_lot on recipe.qp_certification (lot_id, recorded_at);
create unique index qp_certification_message on recipe.qp_certification (message_sha256) where message_sha256 is not null;

create table recipe.qp_transcription_check (
  certification_id  uuid primary key references recipe.qp_certification (id),
  signature_id      uuid not null unique,
  person_id         uuid not null,
  account_id        uuid not null,
  recorded_at       timestamptz not null default clock_timestamp()
);

create table recipe.qp_message_ack (
  id                uuid primary key default gen_random_uuid(),
  message_id        text not null check (length(message_id) <= 128),
  message_sha256    text not null check (message_sha256 ~ '^[0-9a-f]{64}$'),
  outcome           text not null check (outcome in ('ACCEPTED', 'REFUSED')),
  reason            text,
  lot_id            uuid,
  certification_id  uuid references recipe.qp_certification (id),
  person_id         uuid not null,
  account_id        uuid not null,
  recorded_at       timestamptz not null default clock_timestamp(),
  check ((outcome = 'ACCEPTED') = (certification_id is not null)),
  check ((outcome = 'REFUSED') = (reason is not null))
);

do $$
declare
  t text;
begin
  foreach t in array array['qp_register', 'qp_certification', 'qp_transcription_check', 'qp_message_ack'] loop
    execute format('revoke all on recipe.%I from public', t);
    execute format('grant select on recipe.%I to ebmr_app', t);
    execute format('select platform.enforce_db_time(%L, array[''recorded_at''])', 'recipe.' || t);
  end loop;
end
$$;
select kernel.register_audited_table('recipe.qp_register', 'qp_register', 'person_id', true);
select kernel.register_audited_table('recipe.qp_certification', 'qp_certification', 'lot_id', true);
select kernel.register_audited_table('recipe.qp_transcription_check', 'qp_certification', 'certification_id', true);
select kernel.register_audited_table('recipe.qp_message_ack', 'qp_certification', 'message_sha256', true);

create function recipe.epoch_on_qp_outcome() returns trigger
language plpgsql security definer set search_path = pg_catalog, recipe, pg_temp as $$
begin
  perform recipe.bump_epoch('LOT', coalesce((to_jsonb(new) ->> 'lot_id')::uuid,
                                            (select c.lot_id from recipe.qp_certification c where c.id = (to_jsonb(new) ->> 'certification_id')::uuid)));
  return null;
end
$$;
create trigger zzze_epoch_market after insert on recipe.qp_certification for each row execute function recipe.epoch_on_qp_outcome();
create trigger zzze_epoch_market after insert on recipe.qp_transcription_check for each row execute function recipe.epoch_on_qp_outcome();

-- ---------------------------------------------------------------------------------------------
-- Reads
-- ---------------------------------------------------------------------------------------------

-- The certification rows that count: a message or an in-system signature at once, a transcription once verified; with
-- the instant each took effect.
create function recipe.qp_effective(p_lot uuid) returns table (certification_id uuid, outcome text, effective_at timestamptz)
language sql stable security definer set search_path = pg_catalog, recipe, pg_temp as $$
  select c.id, c.outcome, coalesce(k.recorded_at, c.recorded_at)
    from recipe.qp_certification c left join recipe.qp_transcription_check k on k.certification_id = c.id
   where c.lot_id = p_lot and (c.source <> 'TRANSCRIBED' or k.certification_id is not null)
$$;

create or replace function recipe.eu_outcome(p_lot uuid) returns text
language sql stable security definer set search_path = pg_catalog, recipe, pg_temp as $$
  select e.outcome from recipe.qp_effective(p_lot) e order by e.effective_at, e.certification_id limit 1
$$;

create or replace function recipe.market_rejections(p_lot uuid) returns table (market text, rejected_at timestamptz, ref text, deviation_id uuid)
language sql stable security definer set search_path = pg_catalog, recipe, pg_temp as $$
  select 'US'::text, d.recorded_at, d.signature_id::text, d.deviation_id from recipe.us_disposition_decision d where d.lot_id = p_lot and d.decision = 'REJECTED'
  union all
  select 'EU'::text, e.effective_at, e.certification_id::text, null::uuid from recipe.qp_effective(p_lot) e where e.outcome = 'REJECTED_BY_QP'
$$;

-- The latest register row of a person (REGISTER: a registered QP).
create function recipe.qp_registration(p_person uuid) returns recipe.qp_register
language sql stable security definer set search_path = pg_catalog, recipe, pg_temp as $$
  select r.* from recipe.qp_register r where r.person_id = p_person order by r.recorded_at desc, r.id desc limit 1
$$;

-- The importer of the lot's product (0820's table).
create function recipe.lot_importer(p_lot uuid) returns recipe.eu_importer
language sql stable security definer set search_path = pg_catalog, recipe, site, pg_temp as $$
  select i.* from site.finished_lot f join recipe.eu_importer_product p on p.product_code = f.product_code join recipe.eu_importer i on i.id = p.importer_id
   where f.lot_id = p_lot
$$;

-- The checks of an EU outcome at the instant it takes effect (whatever its source); NULL when it may take effect.
create function recipe.eu_outcome_problem(p_lot uuid, p_outcome text, p_mia text, p_certified_at timestamptz, p_person uuid) returns text
language plpgsql stable security definer set search_path = pg_catalog, recipe, site, pg_temp as $$
declare
  v_p   text := recipe.market_act_problem(p_lot, 'EU', p_person);
  v_imp recipe.eu_importer := recipe.lot_importer(p_lot);
  v_mr  recipe.manufacturer_release_decision := recipe.manufacturer_decision(p_lot);
begin
  if not exists (select 1 from site.finished_lot f where f.lot_id = p_lot) then
    return 'EBMR-DSP-050 the lot is no finished lot of a packaging batch';
  end if;
  if v_p is not null then
    return v_p;
  end if;
  if recipe.eu_outcome(p_lot) is not null then
    return format('EBMR-DSP-051 the EU disposition of the lot is already %s', recipe.disposition_state(p_lot, 'EU'));
  end if;
  if p_outcome is null or p_outcome not in ('CERTIFIED', 'REJECTED_BY_QP') then
    return format('EBMR-DSP-052 %s is no certification outcome (CERTIFIED or REJECTED_BY_QP)', coalesce(p_outcome, 'NULL'));
  end if;
  if p_outcome = 'CERTIFIED' and recipe.disposition_state(p_lot, 'EU') is distinct from 'AWAITING_QP_CERTIFICATION' then
    return format('EBMR-DSP-053 the lot is %s for EU: a certification is taken only while it awaits QP certification (G-REL for EU ready; INV-05, INV-39)',
                  recipe.disposition_state(p_lot, 'EU'));
  end if;
  if v_imp.id is null then
    return 'EBMR-DSP-054 no EU importer is named for the lot''s product: an EU certification comes from the importer of the technical agreement';
  end if;
  if p_mia is distinct from v_imp.mia_number then
    return format('EBMR-DSP-055 the certifier''s MIA number %s is not the importer''s (%s %s)', coalesce(p_mia, 'none'), v_imp.code, v_imp.mia_number);
  end if;
  if p_certified_at is null or p_certified_at > clock_timestamp() or p_certified_at < v_mr.recorded_at then
    return 'EBMR-DSP-056 the certification time is in the future or before the manufacturer release of the lot';
  end if;
  return null;
end
$$;

-- Why an EU act is not possible now (the cockpit's certify gate).
create function recipe.eu_certification_gate_problems(p_lot uuid) returns text[]
language plpgsql stable security definer set search_path = pg_catalog, recipe, site, pg_temp as $$
declare
  v_p text := recipe.eu_outcome_problem(p_lot, 'CERTIFIED', (recipe.lot_importer(p_lot)).mia_number, clock_timestamp(), null);
  i   jsonb;
  v_out text[] := '{}';
begin
  if v_p is not null then
    v_out := v_out || v_p;
  end if;
  if exists (select 1 from site.finished_lot f where f.lot_id = p_lot) and 'EU' = any (coalesce(recipe.market_set('LOT', p_lot), '{}')) then
    for i in select value from jsonb_array_elements(recipe.grel_evaluate(p_lot, 'EU') -> 'items') loop
      if i ->> 'status' = 'RED' then
        v_out := v_out || format('G-REL item %s is RED: %s', i ->> 'id', i ->> 'problem');
      end if;
    end loop;
  end if;
  return v_out;
end
$$;

-- ---------------------------------------------------------------------------------------------
-- Content providers
-- ---------------------------------------------------------------------------------------------

create function recipe.eu_importer_content(p_id text) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, recipe, pg_temp as $$
declare
  m text[] := regexp_match(coalesce(p_id, ''), '^([A-Z0-9][A-Z0-9-]{1,31})/([0-9a-f]{64})$');
begin
  if m is null then
    return '{"exists": false}'::jsonb;
  end if;
  return jsonb_build_object('exists', true, 'content_version', 1,
    'content', jsonb_build_object('code', m[1], 'definition_sha256', m[2]),
    'state', case when exists (select 1 from recipe.eu_importer i where i.code = m[1]) then 'REGISTERED' else 'NEW' end,
    'scope', '{}'::jsonb, 'involved', '[]'::jsonb);
end
$$;

create function recipe.qp_register_content(p_id text) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, recipe, iam, pg_temp as $$
declare
  m text[] := regexp_match(coalesce(p_id, ''), '^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/(REGISTER|WITHDRAW)/([A-Z0-9][A-Z0-9-]{1,31})/([!-~]{1,64})$');
  v_name text;
begin
  if m is null or not exists (select 1 from recipe.eu_importer i where i.code = m[3]) then
    return '{"exists": false}'::jsonb;
  end if;
  select p.legal_name into v_name from iam.person p where p.id = m[1]::uuid;
  if v_name is null then
    return '{"exists": false}'::jsonb;
  end if;
  return jsonb_build_object('exists', true, 'content_version', 1,
    'content', jsonb_build_object('person_id', m[1], 'legal_name', v_name, 'action', m[2], 'importer', m[3], 'mia_number', m[4]),
    'state', coalesce((recipe.qp_registration(m[1]::uuid)).action, 'NONE'),
    'scope', '{}'::jsonb, 'involved', '[]'::jsonb);
end
$$;

create function recipe.qp_transcription_content(p_id text) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, recipe, site, pg_temp as $$
declare
  m text[] := regexp_match(coalesce(p_id, ''), '^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/([0-9a-f]{64})$');
begin
  if m is null or not exists (select 1 from site.finished_lot f where f.lot_id = m[1]::uuid) then
    return '{"exists": false}'::jsonb;
  end if;
  return jsonb_build_object('exists', true, 'content_version', 1,
    'content', jsonb_build_object('lot_id', m[1], 'lot_code', (select l.lot_code from site.material_lot l where l.id = m[1]::uuid), 'market', 'EU',
                                  'details_sha256', m[2]),
    'market', 'EU',
    'state', recipe.disposition_state(m[1]::uuid, 'EU'),
    'scope', recipe.release_scope(m[1]::uuid),
    'involved', '[]'::jsonb);
end
$$;

create function recipe.qp_transcription_check_content(p_id text) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, recipe, site, pg_temp as $$
declare
  c recipe.qp_certification;
begin
  if coalesce(p_id, '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return '{"exists": false}'::jsonb;
  end if;
  select * into c from recipe.qp_certification where id = p_id::uuid and source = 'TRANSCRIBED';
  if c.id is null then
    return '{"exists": false}'::jsonb;
  end if;
  return jsonb_build_object('exists', true, 'content_version', 1,
    'content', jsonb_build_object('certification_id', c.id, 'lot_id', c.lot_id, 'lot_code', (select l.lot_code from site.material_lot l where l.id = c.lot_id),
                                  'outcome', c.outcome, 'certifier', c.certifier, 'mia_number', c.mia_number,
                                  'certified_at', to_char(c.certified_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'), 'reference', c.reference,
                                  'reason', c.reason, 'transcribed_by', c.person_id),
    'market', 'EU',
    'state', case when exists (select 1 from recipe.qp_transcription_check k where k.certification_id = c.id) then 'VERIFIED' else 'TRANSCRIBED' end,
    'scope', recipe.release_scope(c.lot_id),
    'involved', '[]'::jsonb);
end
$$;

create function recipe.qp_certification_content(p_id text) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, recipe, site, pg_temp as $$
declare
  m text[] := regexp_match(coalesce(p_id, ''), '^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/(CERTIFIED|REJECTED_BY_QP)$');
  f site.finished_lot;
  c recipe.qp_certification;
begin
  if m is null then
    return '{"exists": false}'::jsonb;
  end if;
  select * into f from site.finished_lot where lot_id = m[1]::uuid;
  if f.lot_id is null then
    return '{"exists": false}'::jsonb;
  end if;
  select * into c from recipe.qp_certification x where x.lot_id = f.lot_id and x.source = 'IN_SYSTEM' and x.outcome = m[2] order by x.recorded_at limit 1;
  return jsonb_build_object('exists', true, 'content_version', 1,
    'content', jsonb_build_object('lot_id', f.lot_id, 'lot_code', (select l.lot_code from site.material_lot l where l.id = f.lot_id), 'product_code', f.product_code,
                                  'strength', f.strength, 'batch_number', f.batch_number, 'market', 'EU', 'outcome', m[2],
                                  -- Once certified here, the checklist stored with the register entry.
                                  'checklist', coalesce(c.checklist, recipe.grel_evaluate(f.lot_id, 'EU'))),
    'market', 'EU',
    'state', recipe.disposition_state(f.lot_id, 'EU'),
    'scope', recipe.release_scope(f.lot_id),
    'involved', to_jsonb(recipe.release_involvement(f.lot_id)));
end
$$;

select esig.register_content_provider('eu_importer', 'recipe.eu_importer_content(text)', 'An EU importer named in a technical agreement, with its products and message key (DI-39)');
select esig.register_content_provider('qp_register', 'recipe.qp_register_content(text)', 'A qualified person registered (or withdrawn) for in-system certification (PR-55)');
select esig.register_content_provider('qp_transcription', 'recipe.qp_transcription_content(text)', 'A QP certification transcribed by hand (DI-30)');
select esig.register_content_provider('qp_transcription_check', 'recipe.qp_transcription_check_content(text)', 'The second person''s check of a transcribed QP certification (DI-30)');
select esig.register_content_provider('qp_certification', 'recipe.qp_certification_content(text)', 'A QP certification signed in the system (PR-55)');

-- ---------------------------------------------------------------------------------------------
-- Acts
-- ---------------------------------------------------------------------------------------------

-- The canonical text of an importer definition (its SHA-256 is in the signed aggregate id).
create function recipe.eu_importer_canonical(p_def jsonb) returns text
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select concat_ws(E'\n', btrim(p_def ->> 'code'), btrim(p_def ->> 'name'), btrim(p_def ->> 'technicalAgreementRef'), btrim(p_def ->> 'miaNumber'),
                   btrim(p_def ->> 'publicKey'),
                   (select string_agg(btrim(x), ',' order by btrim(x)) from jsonb_array_elements_text(case when jsonb_typeof(p_def -> 'products') = 'array' then p_def -> 'products' else '[]'::jsonb end) x))
$$;

create function recipe.register_eu_importer(p_def jsonb, p_signature uuid) returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, recipe, site, esig, iam, pg_temp as $$
declare
  v_actor jsonb;
  v_key   bytea;
  v_id    uuid;
  p       text;
begin
  perform iam.assert_not_administrator();
  v_actor := iam.require_permission('RECORD.QA_REVIEW', '{}'::jsonb);
  if jsonb_typeof(p_def) is distinct from 'object' or coalesce(p_def ->> 'code', '') !~ '^[A-Z0-9][A-Z0-9-]{1,31}$'
     or coalesce(btrim(p_def ->> 'name'), '') = '' or coalesce(btrim(p_def ->> 'technicalAgreementRef'), '') = '' or coalesce(btrim(p_def ->> 'miaNumber'), '') = ''
     or jsonb_typeof(p_def -> 'products') is distinct from 'array' or jsonb_array_length(p_def -> 'products') = 0 then
    raise exception using errcode = 'P0001',
      message = 'EBMR-DSP-060 an EU importer is defined by its code, name, technical agreement, MIA number, Ed25519 public key and the products it imports';
  end if;
  begin
    v_key := decode(p_def ->> 'publicKey', 'base64');
  exception when others then
    v_key := null;
  end;
  if v_key is null or length(v_key) <> 32 then
    raise exception using errcode = 'P0001', message = 'EBMR-DSP-060 the importer''s public key is a 32-byte Ed25519 key, base64';
  end if;
  if exists (select 1 from recipe.eu_importer i where i.code = p_def ->> 'code') then
    raise exception using errcode = 'P0001', message = format('EBMR-DSP-061 importer %s is registered already', p_def ->> 'code');
  end if;
  perform recipe.assert_release_signature(p_signature, 'EU_IMPORTER_APPROVED', 'eu_importer',
    (p_def ->> 'code') || '/' || encode(sha256(convert_to(recipe.eu_importer_canonical(p_def), 'UTF8')), 'hex'), (v_actor ->> 'person_id')::uuid);
  insert into recipe.eu_importer (code, name, technical_agreement_ref, mia_number, public_key, signature_id, person_id, account_id)
  values (p_def ->> 'code', btrim(p_def ->> 'name'), btrim(p_def ->> 'technicalAgreementRef'), btrim(p_def ->> 'miaNumber'), v_key, p_signature,
          (v_actor ->> 'person_id')::uuid, (v_actor ->> 'account_id')::uuid)
  returning id into v_id;
  for p in select distinct btrim(x) from jsonb_array_elements_text(p_def -> 'products') x loop
    if exists (select 1 from recipe.eu_importer_product q where q.product_code = p) then
      raise exception using errcode = 'P0001', message = format('EBMR-DSP-062 product %s is imported by another importer already (one importer per product)', p);
    end if;
    insert into recipe.eu_importer_product (product_code, importer_id) values (p, v_id);
  end loop;
  return v_id;
end
$$;

create function recipe.register_qp(p_person uuid, p_action text, p_importer_code text, p_mia text, p_signature uuid) returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, recipe, esig, iam, pg_temp as $$
declare
  v_actor jsonb;
  v_imp   recipe.eu_importer;
  v_id    uuid;
begin
  perform iam.assert_not_administrator();
  v_actor := iam.require_permission('RECORD.QA_REVIEW', '{}'::jsonb);
  if p_action is null or p_action not in ('REGISTER', 'WITHDRAW') then
    raise exception using errcode = 'P0001', message = format('EBMR-DSP-063 %s is no QP register action (REGISTER or WITHDRAW)', coalesce(p_action, 'NULL'));
  end if;
  select * into v_imp from recipe.eu_importer i where i.code = p_importer_code;
  if v_imp.id is null or p_mia is distinct from v_imp.mia_number then
    raise exception using errcode = 'P0001', message = 'EBMR-DSP-064 a QP is registered on the authorisation (MIA number) of a registered EU importer';
  end if;
  if p_person = (v_actor ->> 'person_id')::uuid then
    raise exception using errcode = 'P0001', message = 'EBMR-DSP-065 nobody registers themselves as a qualified person (S14)';
  end if;
  if coalesce((recipe.qp_registration(p_person)).action, 'WITHDRAW') = p_action then
    raise exception using errcode = 'P0001', message = format('EBMR-DSP-066 the person''s QP registration is already %s', case p_action when 'REGISTER' then 'registered' else 'withdrawn or absent' end);
  end if;
  perform recipe.assert_release_signature(p_signature, 'QP_REGISTERED', 'qp_register', format('%s/%s/%s/%s', p_person, p_action, p_importer_code, p_mia),
                                          (v_actor ->> 'person_id')::uuid);
  insert into recipe.qp_register (person_id, action, mia_number, importer_id, signature_id, by_person, by_account)
  values (p_person, p_action, p_mia, v_imp.id, p_signature, (v_actor ->> 'person_id')::uuid, (v_actor ->> 'account_id')::uuid)
  returning id into v_id;
  return v_id;
end
$$;

-- The canonical details of a transcription (their SHA-256 is in the signed aggregate id): the fields as entered, trimmed,
-- one per line: outcome, certifier, MIA number, certification time (as entered), reference, reason.
create function recipe.qp_details_sha256(p_outcome text, p_certifier text, p_mia text, p_certified_at text, p_reference text, p_reason text) returns text
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select encode(sha256(convert_to(concat_ws(E'\n', btrim(coalesce(p_outcome, '')), btrim(coalesce(p_certifier, '')), btrim(coalesce(p_mia, '')),
                                            btrim(coalesce(p_certified_at, '')), btrim(coalesce(p_reference, '')), btrim(coalesce(p_reason, ''))), 'UTF8')), 'hex')
$$;

create function recipe.parse_certified_at(p_text text) returns timestamptz
language plpgsql stable set search_path = pg_catalog, pg_temp as $$
begin
  -- An ISO-8601 instant with its offset (the zone of the certification is not guessed).
  if coalesce(p_text, '') !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:\d{2})$' then
    return null;
  end if;
  return p_text::timestamptz;
exception when others then
  return null;
end
$$;

create function recipe.record_qp_transcription(p_lot uuid, p_outcome text, p_certifier text, p_mia text, p_certified_at text, p_reference text, p_reason text,
                                              p_signature uuid) returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, recipe, site, esig, iam, pg_temp as $$
declare
  v_actor jsonb;
  v_at    timestamptz := recipe.parse_certified_at(p_certified_at);
  v_p     text;
  v_id    uuid;
  g       jsonb;
  v_sha   text := recipe.qp_details_sha256(p_outcome, p_certifier, p_mia, p_certified_at, p_reference, p_reason);
begin
  perform iam.assert_not_administrator();
  v_actor := iam.require_permission('RECORD.QA_REVIEW', recipe.release_scope(p_lot));
  perform recipe.lock_release_evidence(p_lot);
  if coalesce(btrim(p_certifier), '') = '' or coalesce(btrim(p_reference), '') = '' or v_at is null then
    raise exception using errcode = 'P0001',
      message = 'EBMR-DSP-067 a transcription names the certifying QP, the MIA number, the certification time with its offset and the certification reference (DI-39)';
  end if;
  if p_outcome = 'REJECTED_BY_QP' and (p_reason is null or recipe.reason_is_blank(p_reason)) then
    raise exception using errcode = 'P0001', message = 'EBMR-DSP-068 a QP rejection carries the QP''s reason';
  end if;
  v_p := recipe.eu_outcome_problem(p_lot, p_outcome, btrim(p_mia), v_at, null);
  if v_p is not null then
    raise exception using errcode = 'P0001', message = v_p;
  end if;
  if exists (select 1 from recipe.qp_certification c where c.lot_id = p_lot and c.source = 'TRANSCRIBED'
                and not exists (select 1 from recipe.qp_transcription_check k where k.certification_id = c.id)) then
    raise exception using errcode = 'P0001', message = 'EBMR-DSP-069 a transcription of this lot waits for its second person already';
  end if;
  perform recipe.assert_release_signature(p_signature, 'QP_CERTIFICATION_RECORDED', 'qp_transcription', p_lot::text || '/' || v_sha, (v_actor ->> 'person_id')::uuid);
  g := recipe.grel_evaluate(p_lot, 'EU');
  insert into recipe.qp_certification (lot_id, source, outcome, certifier, mia_number, certified_at, importer_id, reference, reason, details_sha256, signature_id,
                                       epoch, checklist, person_id, account_id)
  values (p_lot, 'TRANSCRIBED', p_outcome, btrim(p_certifier), btrim(p_mia), v_at, (recipe.lot_importer(p_lot)).id, btrim(p_reference), nullif(btrim(coalesce(p_reason, '')), ''),
          v_sha, p_signature, g ->> 'epoch', g, (v_actor ->> 'person_id')::uuid, (v_actor ->> 'account_id')::uuid)
  returning id into v_id;
  return v_id;
end
$$;

create function recipe.verify_qp_transcription(p_certification uuid, p_signature uuid) returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, recipe, site, esig, iam, pg_temp as $$
declare
  v_actor jsonb;
  c       recipe.qp_certification;
  v_p     text;
begin
  perform iam.assert_not_administrator();
  select * into c from recipe.qp_certification where id = p_certification and source = 'TRANSCRIBED';
  if c.id is null then
    raise exception using errcode = 'P0001', message = 'EBMR-DSP-070 there is no transcribed certification with this id';
  end if;
  v_actor := iam.require_permission('RECORD.QA_REVIEW', recipe.release_scope(c.lot_id));
  perform recipe.lock_release_evidence(c.lot_id);
  perform 1 from recipe.qp_certification x where x.id = c.id for update;
  if exists (select 1 from recipe.qp_transcription_check k where k.certification_id = c.id) then
    raise exception using errcode = 'P0001', message = 'EBMR-DSP-071 the transcription is verified already';
  end if;
  if (v_actor ->> 'person_id')::uuid = c.person_id then
    raise exception using errcode = 'P0001', message = 'EBMR-DSP-072 the person who transcribed a certification never verifies it (DI-30)';
  end if;
  -- At the instant the outcome takes effect (INV-39, INV-05).
  v_p := recipe.eu_outcome_problem(c.lot_id, c.outcome, c.mia_number, c.certified_at, null);
  if v_p is not null then
    raise exception using errcode = 'P0001', message = v_p;
  end if;
  perform recipe.assert_release_signature(p_signature, 'QP_CERTIFICATION_VERIFIED', 'qp_transcription_check', c.id::text, (v_actor ->> 'person_id')::uuid);
  insert into recipe.qp_transcription_check (certification_id, signature_id, person_id, account_id)
  values (c.id, p_signature, (v_actor ->> 'person_id')::uuid, (v_actor ->> 'account_id')::uuid);
  return c.id;
end
$$;

create function recipe.record_qp_certification(p_lot uuid, p_outcome text, p_signature uuid, p_expected_epoch text, p_reason text) returns uuid
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
  v_p := recipe.eu_outcome_problem(p_lot, p_outcome, v_reg.mia_number, clock_timestamp(), (v_actor ->> 'person_id')::uuid);
  if v_p is not null then
    raise exception using errcode = 'P0001', message = v_p;
  end if;
  g := recipe.grel_evaluate(p_lot, 'EU');
  if p_expected_epoch is null or p_expected_epoch is distinct from g ->> 'epoch' then
    raise exception using errcode = 'P0001', message = 'EBMR-DSP-075 the evidence of the lot changed after it was evaluated for EU; evaluate G-REL again (INV-05, DI-37)';
  end if;
  v_sig := recipe.assert_release_signature(p_signature, 'QP_CERTIFIED', 'qp_certification', v_id, (v_actor ->> 'person_id')::uuid);
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
-- reason and changes nothing else. A message already taken in is answered with its first acknowledgement.
create function recipe.take_qp_message(p_message text, p_signature_valid boolean) returns jsonb
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
  select * into v_ack from recipe.qp_message_ack a where a.message_sha256 = v_sha order by a.recorded_at limit 1;
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
    v_p := recipe.eu_outcome_problem(v_lot, m ->> 'outcome', m #>> '{certifier,miaNumber}', v_at, null);
    if v_p is not null then
      raise exception using errcode = 'P0001', message = v_p;
    end if;
    g := recipe.grel_evaluate(v_lot, 'EU');
    insert into recipe.qp_certification (lot_id, source, outcome, certifier, mia_number, certified_at, importer_id, reference, reason, message, message_sha256,
                                         epoch, checklist, person_id, account_id)
    values (v_lot, 'MESSAGE', m ->> 'outcome', btrim(m #>> '{certifier,name}'), m #>> '{certifier,miaNumber}', v_at, v_imp.id, v_mid,
            nullif(btrim(coalesce(m ->> 'reason', '')), ''), p_message, v_sha, g ->> 'epoch', g, (v_actor ->> 'person_id')::uuid, (v_actor ->> 'account_id')::uuid)
    returning id into v_cid;
  exception when others then
    -- The subtransaction is rolled back (nothing taken in); the refusal is acknowledged with its reason.
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

revoke all on function recipe.epoch_on_qp_outcome(), recipe.qp_effective(uuid), recipe.qp_registration(uuid), recipe.lot_importer(uuid),
  recipe.eu_outcome_problem(uuid, text, text, timestamptz, uuid), recipe.eu_certification_gate_problems(uuid), recipe.eu_importer_content(text),
  recipe.qp_register_content(text), recipe.qp_transcription_content(text), recipe.qp_transcription_check_content(text), recipe.qp_certification_content(text),
  recipe.eu_importer_canonical(jsonb), recipe.register_eu_importer(jsonb, uuid), recipe.register_qp(uuid, text, text, text, uuid),
  recipe.qp_details_sha256(text, text, text, text, text, text), recipe.parse_certified_at(text),
  recipe.record_qp_transcription(uuid, text, text, text, text, text, text, uuid), recipe.verify_qp_transcription(uuid, uuid),
  recipe.record_qp_certification(uuid, text, uuid, text, text), recipe.take_qp_message(text, boolean) from public;
grant execute on function recipe.qp_effective(uuid), recipe.qp_registration(uuid), recipe.eu_certification_gate_problems(uuid), recipe.eu_importer_canonical(jsonb),
  recipe.register_eu_importer(jsonb, uuid), recipe.register_qp(uuid, text, text, text, uuid), recipe.qp_details_sha256(text, text, text, text, text, text),
  recipe.record_qp_transcription(uuid, text, text, text, text, text, text, uuid), recipe.verify_qp_transcription(uuid, uuid),
  recipe.record_qp_certification(uuid, text, uuid, text, text) to ebmr_app;

reset role;
