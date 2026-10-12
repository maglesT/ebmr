-- Records (kernel): contingency packs, numbered paper forms issued at batch issue and at stage start, and their
-- reconciliation before the batch completes (Phase 4 slice 6b; DI-43, PR-16; default D-6-6; plan
-- docs/build-plan/phase-4/phase-4-plan.md slice 6b).
--
--   records.contingency_form        insert-only: one numbered paper form (page x of y of its pack) issued for a batch at
--                                   ISSUE or at STAGE_START (with the stage), from a template version, to a destination,
--                                   by a person. The serial (CF-000001, ...) comes from the protected sequence
--                                   records.contingency_form_serial (INV-27: never handed out twice, also after a restore).
--   records.contingency_form_event  insert-only: what happened to a form. RETURNED (it came back with entries on it),
--                                   TRANSCRIBED (its entries were back-entered, with a reference to them), VERIFIED (a
--                                   second person checked the transcription, DI-30), VOIDED (never used or spoilt, with a
--                                   reason), REPORTED_MISSING (it did not come back; a missing form is voided only with a
--                                   reference, the deviation raised for it).
--   records.form_reconciliation     insert-only: the FORMS_RECONCILED signature over the reconciled forms of one batch.
--
-- A form is reconciled when VERIFIED or VOIDED (D-6-6: used, transcribed and verified, or voided). The forms of a batch
-- are reconciled when every form is, and the reconciliation is signed (FORMS_RECONCILED, aggregate form_reconciliation
-- <batch id>, state RECONCILED; QA on the floor or a QA reviewer). A batch with no form issued is reconciled trivially.
--
--   records.form_reconciliation_problem(batch uuid) returns text: NULL when the batch may complete, else why not (every
--   unreconciled serial named, or the missing signature). The batch-completion gate (EXECUTION_COMPLETE) calls it; the gate
--   itself is a trigger on recipe.execution_state that only a recipe-core or edition migration can add (kernel migrations
--   run first): residual R-6b-1 for the lead (plan, slice 6b).
--
-- Database rules (they hold with the application's own credentials; ADR 0012):
--   * issue: CONTINGENCY.ISSUE, not an administrator; 1 to 50 pages; a STAGE_START pack names its stage, an ISSUE pack
--     none; the template and destination are given; no pack after the batch's reconciliation is signed (EBMR-REC-100).
--   * events: CONTINGENCY.RECONCILE, not an administrator; only from the states the life cycle allows; a reason or a
--     reference where named; the verifier is not the person who transcribed (EBMR-REC-101..103).
--   * sign: a valid FORMS_RECONCILED signature by the actor of the current content, every form reconciled, once
--     (EBMR-REC-104, 105).
--   * the application role reads the tables and calls the definers; it never writes a table.
-- New permissions: CONTINGENCY.ISSUE, CONTINGENCY.RECONCILE (GMP, WRITE). New meaning: FORMS_RECONCILED.
-- Messages: EBMR-REC-100 to EBMR-REC-106.

set local role ebmr_owner;

select kernel.set_actor_context(jsonb_build_object(
  'person_id', '00000000-0000-0000-0000-000000000000', 'account_id', '00000000-0000-0000-0000-000000000000',
  'role_code', 'SOFTWARE_RELEASE', 'session_id', '00000000-0000-0000-0000-000000000000', 'source', 'SYSTEM',
  'site_zone', 'UTC', 'correlation_id', gen_random_uuid(),
  'legal_name', 'Software release (kernel migration 1170_contingency_forms)',
  'reason_code', 'SOFTWARE_RELEASE',
  'reason_text', 'contingency packs and their reconciliation before batch completion (DI-43, PR-16)'));

insert into iam.permission (code, domain, effect, description) values
  ('CONTINGENCY.ISSUE', 'GMP', 'WRITE', 'Issue a numbered contingency pack (paper forms) for a batch at its issue or at a stage start'),
  ('CONTINGENCY.RECONCILE', 'GMP', 'WRITE', 'Record the return, transcription, verification, void or loss of an issued contingency form');

insert into iam.role_permission (role_code, permission_code) values
  ('SHIFT_SUPERVISOR', 'CONTINGENCY.ISSUE'), ('QA_SHOP_FLOOR', 'CONTINGENCY.ISSUE'), ('QA_REVIEWER', 'CONTINGENCY.ISSUE'),
  ('OPERATOR', 'CONTINGENCY.RECONCILE'), ('SHIFT_SUPERVISOR', 'CONTINGENCY.RECONCILE'), ('QA_SHOP_FLOOR', 'CONTINGENCY.RECONCILE'),
  ('QA_REVIEWER', 'CONTINGENCY.RECONCILE');

insert into esig.meaning_type (code, version, origin, is_minimum, status, category, role_class, title, meaning_text, permissions,
                               independent_of, excludes_performers, excludes_involved, witness, reauth, delegable, sources)
values ('FORMS_RECONCILED', 1, 'VENDOR', true, 'ACTIVE', 'RECORDS', 'VERIFIER', 'Contingency forms reconciled',
        'I checked that every paper form issued for this batch is accounted for: used and transcribed with a verified transcription, or voided with its reason.',
        array['QA.FLOOR_APPROVE', 'RECORD.QA_REVIEW'], '{}', true, false, false, 'ALL_COMPONENTS', false, 'DI-43; PR-16; D-6-6');

select kernel.set_actor_context(null);

-- ---------------------------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------------------------

create sequence records.contingency_form_serial;
revoke all on sequence records.contingency_form_serial from public;

create table records.contingency_form (
  id              uuid primary key default gen_random_uuid(),
  serial          text not null unique check (serial ~ '^CF-[0-9]{6,}$'),
  batch_id        uuid not null,
  batch_label     text not null check (btrim(batch_label) <> '' and length(batch_label) <= 120),
  pack_id         uuid not null,
  moment          text not null check (moment in ('ISSUE', 'STAGE_START')),
  stage_ref       text check (stage_ref is null or (btrim(stage_ref) <> '' and length(stage_ref) <= 120)),
  template_ref    text not null check (btrim(template_ref) <> '' and length(template_ref) <= 200),
  destination     text not null check (btrim(destination) <> '' and length(destination) <= 200),
  page_no         integer not null check (page_no >= 1),
  page_count      integer not null check (page_count between 1 and 50 and page_no <= page_count),
  reason          text not null check (btrim(reason) <> ''),
  person_id       uuid not null,
  account_id      uuid not null,
  correlation_id  uuid not null,
  recorded_at     timestamptz not null default clock_timestamp(),
  check ((moment = 'STAGE_START') = (stage_ref is not null)),
  unique (pack_id, page_no)
);
create index contingency_form_batch on records.contingency_form (batch_id, serial);

create table records.contingency_form_event (
  id              uuid primary key default gen_random_uuid(),
  form_id         uuid not null references records.contingency_form (id),
  batch_id        uuid not null,
  event           text not null check (event in ('RETURNED', 'TRANSCRIBED', 'VERIFIED', 'VOIDED', 'REPORTED_MISSING')),
  reason          text check (reason is null or btrim(reason) <> ''),
  reference       text check (reference is null or (btrim(reference) <> '' and length(reference) <= 200)),
  person_id       uuid not null,
  account_id      uuid not null,
  correlation_id  uuid not null,
  recorded_at     timestamptz not null default clock_timestamp()
);
create index contingency_form_event_form on records.contingency_form_event (form_id, recorded_at, id);

create table records.form_reconciliation (
  batch_id        uuid primary key,
  signature_id    uuid not null unique,
  form_count      integer not null check (form_count >= 1),
  person_id       uuid not null,
  account_id      uuid not null,
  correlation_id  uuid not null,
  recorded_at     timestamptz not null default clock_timestamp()
);

do $$
declare
  t text;
begin
  foreach t in array array['contingency_form', 'contingency_form_event', 'form_reconciliation'] loop
    execute format('revoke all on records.%I from public', t);
    execute format('grant select on records.%I to ebmr_app', t);
  end loop;
end
$$;
select platform.enforce_db_time('records.contingency_form', array['recorded_at']);
select platform.enforce_db_time('records.contingency_form_event', array['recorded_at']);
select platform.enforce_db_time('records.form_reconciliation', array['recorded_at']);
-- One chain per batch: form_reconciliation:<batch id> (the forms, their events and the signed reconciliation).
select kernel.register_audited_table('records.contingency_form', 'form_reconciliation', 'batch_id', true);
select kernel.register_audited_table('records.contingency_form_event', 'form_reconciliation', 'batch_id', true);
select kernel.register_audited_table('records.form_reconciliation', 'form_reconciliation', 'batch_id', true);

select continuity.register_protected_sequence('records.contingency_form_serial', 'records.contingency_form_serial'::regclass,
  'OTHER', 'kernel', 'Serial numbers of issued contingency forms (printed on paper; DI-43)', 100000);

-- ---------------------------------------------------------------------------------------------
-- Reads
-- ---------------------------------------------------------------------------------------------

-- The state of one form from its latest event: ISSUED, RETURNED, TRANSCRIBED, VERIFIED, VOIDED or MISSING.
create function records.contingency_form_state(p_form uuid) returns text
language sql stable security definer set search_path = pg_catalog, records, pg_temp as $$
  select case when f.id is null then null
              else coalesce((select case e.event when 'REPORTED_MISSING' then 'MISSING' else e.event end
                               from records.contingency_form_event e where e.form_id = f.id order by e.recorded_at desc, e.id desc limit 1), 'ISSUED') end
    from (select p_form as id) x left join records.contingency_form f on f.id = x.id
$$;

-- The forms of a batch with their states, in serial order (the signed content and the screens).
create function records.contingency_forms_of(p_batch uuid) returns jsonb
language sql stable security definer set search_path = pg_catalog, records, pg_temp as $$
  select coalesce(jsonb_agg(jsonb_build_object('form_id', f.id, 'serial', f.serial, 'moment', f.moment, 'stage_ref', f.stage_ref,
                                               'template_ref', f.template_ref, 'page_no', f.page_no, 'page_count', f.page_count,
                                               'state', records.contingency_form_state(f.id)) order by f.serial), '[]'::jsonb)
    from records.contingency_form f where f.batch_id = p_batch
$$;

-- The serials of the batch's forms that are not reconciled (not VERIFIED and not VOIDED).
create function records.unreconciled_forms(p_batch uuid) returns text[]
language sql stable security definer set search_path = pg_catalog, records, pg_temp as $$
  select coalesce(array_agg(f.serial order by f.serial), '{}')
    from records.contingency_form f
   where f.batch_id = p_batch and records.contingency_form_state(f.id) not in ('VERIFIED', 'VOIDED')
$$;

-- RECONCILED (every form reconciled, not yet signed), SIGNED, OPEN (a form is not reconciled) or NONE (no form issued).
create function records.form_reconciliation_state(p_batch uuid) returns text
language sql stable security definer set search_path = pg_catalog, records, pg_temp as $$
  select case when exists (select 1 from records.form_reconciliation r where r.batch_id = p_batch) then 'SIGNED'
              when not exists (select 1 from records.contingency_form f where f.batch_id = p_batch) then 'NONE'
              when cardinality(records.unreconciled_forms(p_batch)) > 0 then 'OPEN'
              else 'RECONCILED' end
$$;

-- NULL when the batch may complete as far as its paper forms go (none issued, or all reconciled and the reconciliation
-- signed), else why not (DI-43, PR-16; the message names the gap).
create function records.form_reconciliation_problem(p_batch uuid) returns text
language plpgsql stable security definer set search_path = pg_catalog, records, pg_temp as $$
declare
  v_open text[];
begin
  case records.form_reconciliation_state(p_batch)
    when 'NONE', 'SIGNED' then return null;
    when 'OPEN' then
      v_open := records.unreconciled_forms(p_batch);
      return format('EBMR-REC-106 %s contingency form(s) of this batch are not reconciled (each is returned, transcribed and verified, or voided): %s (DI-43)',
                    cardinality(v_open), array_to_string(v_open, ', '));
    else
      return 'EBMR-REC-106 every contingency form of this batch is reconciled, but the reconciliation is not signed (FORMS_RECONCILED, DI-43)';
  end case;
end
$$;

-- Signed content of a batch's reconciliation: the forms and their states (esig content provider).
create function records.form_reconciliation_content(p_id text) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, records, pg_temp as $$
declare
  v_batch uuid;
begin
  if coalesce(p_id, '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return '{"exists": false}'::jsonb;
  end if;
  v_batch := p_id::uuid;
  if not exists (select 1 from records.contingency_form f where f.batch_id = v_batch) then
    return '{"exists": false}'::jsonb;
  end if;
  return jsonb_build_object('exists', true, 'content_version', 1,
                            'content', jsonb_build_object('batch_id', v_batch, 'forms', records.contingency_forms_of(v_batch)),
                            'state', records.form_reconciliation_state(v_batch), 'scope', '{}'::jsonb);
end
$$;

select esig.register_content_provider('form_reconciliation', 'records.form_reconciliation_content(text)',
  'The contingency forms issued for a batch and how each was reconciled (DI-43)');

-- ---------------------------------------------------------------------------------------------
-- Acts
-- ---------------------------------------------------------------------------------------------

-- Issues a pack of p_pages numbered forms for a batch; returns the forms (id, serial, page) in page order.
create function records.issue_contingency_pack(p_batch uuid, p_batch_label text, p_moment text, p_stage_ref text, p_template_ref text,
                                               p_destination text, p_pages integer, p_reason text) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, records, iam, pg_temp as $$
declare
  v_actor jsonb;
  v_pack  uuid := gen_random_uuid();
  v_out   jsonb := '[]'::jsonb;
  v_id    uuid;
  v_ser   text;
  i       integer;
begin
  perform iam.assert_not_administrator();
  v_actor := iam.require_permission('CONTINGENCY.ISSUE', '{}'::jsonb);
  if p_batch is null or records.is_blank(p_batch_label) or records.is_blank(p_template_ref) or records.is_blank(p_destination) or records.is_blank(p_reason) then
    raise exception using errcode = 'P0001',
      message = 'EBMR-REC-100 a contingency pack names its batch, the template version, the destination and the reason';
  end if;
  if p_moment is null or p_moment not in ('ISSUE', 'STAGE_START') or (p_moment = 'STAGE_START') <> not records.is_blank(p_stage_ref) then
    raise exception using errcode = 'P0001',
      message = 'EBMR-REC-100 a contingency pack is issued at the batch issue (no stage) or at a stage start (naming the stage)';
  end if;
  if p_pages is null or p_pages < 1 or p_pages > 50 then
    raise exception using errcode = 'P0001', message = 'EBMR-REC-100 a contingency pack has 1 to 50 numbered forms';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('records.form_reconciliation:' || p_batch::text, 0));
  if exists (select 1 from records.form_reconciliation r where r.batch_id = p_batch) then
    raise exception using errcode = 'P0001',
      message = 'EBMR-REC-100 the paper forms of this batch are reconciled and signed; no further pack is issued (DI-43)';
  end if;
  for i in 1 .. p_pages loop
    v_ser := 'CF-' || lpad(nextval('records.contingency_form_serial')::text, 6, '0');
    insert into records.contingency_form (serial, batch_id, batch_label, pack_id, moment, stage_ref, template_ref, destination, page_no, page_count,
                                          reason, person_id, account_id, correlation_id)
    values (v_ser, p_batch, btrim(p_batch_label), v_pack, p_moment, nullif(btrim(coalesce(p_stage_ref, '')), ''), btrim(p_template_ref),
            btrim(p_destination), i, p_pages, p_reason, (v_actor ->> 'person_id')::uuid, (v_actor ->> 'account_id')::uuid,
            (v_actor ->> 'correlation_id')::uuid)
    returning id into v_id;
    v_out := v_out || jsonb_build_object('formId', v_id, 'serial', v_ser, 'pageNo', i, 'pageCount', p_pages, 'packId', v_pack);
  end loop;
  return v_out;
end
$$;

-- Records what happened to one form (RETURNED, TRANSCRIBED, VERIFIED, VOIDED, REPORTED_MISSING).
create function records.record_contingency_form_event(p_form uuid, p_event text, p_reason text, p_reference text) returns void
language plpgsql volatile security definer set search_path = pg_catalog, records, iam, pg_temp as $$
declare
  v_actor  jsonb;
  f        records.contingency_form;
  v_state  text;
  v_transcriber uuid;
begin
  perform iam.assert_not_administrator();
  v_actor := iam.require_permission('CONTINGENCY.RECONCILE', '{}'::jsonb);
  select * into f from records.contingency_form where id = p_form;
  if f.id is null then
    raise exception using errcode = 'P0001', message = format('EBMR-REC-101 %s is no issued contingency form', coalesce(p_form::text, 'NULL'));
  end if;
  perform pg_advisory_xact_lock(hashtextextended('records.form_reconciliation:' || f.batch_id::text, 0));
  if exists (select 1 from records.form_reconciliation r where r.batch_id = f.batch_id) then
    raise exception using errcode = 'P0001', message = 'EBMR-REC-101 the reconciliation of this batch is signed; its forms do not change (DI-43)';
  end if;
  v_state := records.contingency_form_state(f.id);
  if p_event is null or not (
       (p_event = 'RETURNED' and v_state = 'ISSUED')
    or (p_event = 'TRANSCRIBED' and v_state = 'RETURNED')
    or (p_event = 'VERIFIED' and v_state = 'TRANSCRIBED')
    or (p_event = 'VOIDED' and v_state in ('ISSUED', 'MISSING'))
    or (p_event = 'REPORTED_MISSING' and v_state = 'ISSUED')) then
    raise exception using errcode = 'P0001',
      message = format('EBMR-REC-101 form %s is %s; %s is not a step it can take (issued, returned, transcribed, verified; or voided while unused or missing)',
                       f.serial, v_state, coalesce(p_event, 'NULL'));
  end if;
  if p_event in ('VOIDED', 'REPORTED_MISSING') and records.is_blank(p_reason) then
    raise exception using errcode = 'P0001', message = format('EBMR-REC-102 form %s: a void or a loss needs its reason', f.serial);
  end if;
  if p_event = 'TRANSCRIBED' and records.is_blank(p_reference) then
    raise exception using errcode = 'P0001',
      message = format('EBMR-REC-102 form %s: the transcription names where its entries were back-entered (flagged as transcribed from paper)', f.serial);
  end if;
  if p_event = 'VOIDED' and v_state = 'MISSING' and records.is_blank(p_reference) then
    raise exception using errcode = 'P0001',
      message = format('EBMR-REC-102 form %s is missing: it is voided only with the reference of the deviation raised for it (DI-43)', f.serial);
  end if;
  if p_event = 'VERIFIED' then
    select e.person_id into v_transcriber from records.contingency_form_event e
     where e.form_id = f.id and e.event = 'TRANSCRIBED' order by e.recorded_at desc, e.id desc limit 1;
    if v_transcriber = (v_actor ->> 'person_id')::uuid then
      raise exception using errcode = 'P0001',
        message = format('EBMR-REC-103 form %s: the transcription is verified by a second person, not the one who transcribed it (DI-30)', f.serial);
    end if;
  end if;
  insert into records.contingency_form_event (form_id, batch_id, event, reason, reference, person_id, account_id, correlation_id)
  values (f.id, f.batch_id, p_event, nullif(btrim(coalesce(p_reason, '')), ''), nullif(btrim(coalesce(p_reference, '')), ''),
          (v_actor ->> 'person_id')::uuid, (v_actor ->> 'account_id')::uuid, (v_actor ->> 'correlation_id')::uuid);
end
$$;

-- Signs the reconciliation of a batch's forms (FORMS_RECONCILED on form_reconciliation <batch id>, state RECONCILED).
create function records.sign_form_reconciliation(p_batch uuid, p_signature uuid) returns void
language plpgsql volatile security definer set search_path = pg_catalog, records, esig, iam, pg_temp as $$
declare
  v_actor jsonb;
  v_prob  text;
  v_sig   jsonb;
  v_count integer;
begin
  perform iam.assert_not_administrator();
  v_actor := iam.require_permission('CONTINGENCY.RECONCILE', '{}'::jsonb);
  if p_batch is null then
    raise exception using errcode = 'P0001', message = 'EBMR-REC-104 the reconciliation names its batch';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('records.form_reconciliation:' || p_batch::text, 0));
  case records.form_reconciliation_state(p_batch)
    when 'SIGNED' then raise exception using errcode = 'P0001', message = 'EBMR-REC-104 the reconciliation of this batch is already signed';
    when 'NONE' then raise exception using errcode = 'P0001', message = 'EBMR-REC-104 no contingency form was issued for this batch: there is nothing to reconcile';
    when 'OPEN' then raise exception using errcode = 'P0001', message = records.form_reconciliation_problem(p_batch);
    else null;
  end case;
  v_prob := coalesce(esig.signature_problem(p_signature, 'FORMS_RECONCILED', 'form_reconciliation', p_batch::text), esig.signature_state_problem(p_signature));
  if v_prob is not null then
    raise exception using errcode = 'P0001', message = format('EBMR-REC-105 %s (DI-35, DI-37)', v_prob);
  end if;
  v_sig := esig.signature_state(p_signature);
  if (v_sig ->> 'signer_person')::uuid is distinct from (v_actor ->> 'person_id')::uuid then
    raise exception using errcode = 'P0001', message = 'EBMR-REC-105 the reconciliation is recorded by the person who signed it (DI-14)';
  end if;
  if esig.content_hash_of('form_reconciliation', p_batch::text, esig.provide('form_reconciliation', p_batch::text)) is distinct from v_sig ->> 'content_hash' then
    raise exception using errcode = 'P0001', message = 'EBMR-REC-105 the signed content is not the current state of the batch''s forms (DI-37)';
  end if;
  select count(*) into v_count from records.contingency_form f where f.batch_id = p_batch;
  insert into records.form_reconciliation (batch_id, signature_id, form_count, person_id, account_id, correlation_id)
  values (p_batch, p_signature, v_count, (v_actor ->> 'person_id')::uuid, (v_actor ->> 'account_id')::uuid, (v_actor ->> 'correlation_id')::uuid);
end
$$;

revoke all on function records.contingency_form_state(uuid), records.contingency_forms_of(uuid), records.unreconciled_forms(uuid),
  records.form_reconciliation_state(uuid), records.form_reconciliation_problem(uuid), records.form_reconciliation_content(text),
  records.issue_contingency_pack(uuid, text, text, text, text, text, integer, text), records.record_contingency_form_event(uuid, text, text, text),
  records.sign_form_reconciliation(uuid, uuid) from public;
grant execute on function records.contingency_form_state(uuid), records.contingency_forms_of(uuid), records.unreconciled_forms(uuid),
  records.form_reconciliation_state(uuid), records.form_reconciliation_problem(uuid),
  records.issue_contingency_pack(uuid, text, text, text, text, text, integer, text), records.record_contingency_form_event(uuid, text, text, text),
  records.sign_form_reconciliation(uuid, uuid) to ebmr_app;

reset role;
