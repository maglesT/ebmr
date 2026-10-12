-- Recipe core: production approval, QA review, the audit-trail review and its delta, reopening, the exception register
-- in QA review, the abort checklist and the free-text translations of a GMP batch record (Phase 4 slice 1a; outline
-- 5.2.2, 5.2.4, 5.4, 7.3, 7.4; INV-30, INV-35, INV-48, DI-25, DI-26, DI-34, PR-52, PR-16, L-09, L-20, D-P4-12; ADR 0012:
-- the rules hold when the application's own database credentials are used directly).
--
-- Signature meanings (new, in this range): REVIEW_REOPENED (QA, reviewer class, with the person's reason) and
-- REVIEW_ITEMS_DISPOSITIONED (QA's signed disposition of one or more register items). The others are the kernel's
-- (0210): PRODUCTION_APPROVED, PACKAGING_RECORD_APPROVED, AUDIT_TRAIL_REVIEWED (excludes the involvement set),
-- DELTA_AUDIT_TRAIL_REVIEWED (same), QA_REVIEWED (independent of the production approver).
--
-- Signed aggregates (content providers here):
--   batch_review         <batch>                 the completed record: execution status, last row and state hash, every
--                                                exception with its engine disposition and deviation link, the verified
--                                                translations and the abort checklist; the review cycle. Signed by the
--                                                production approval and the QA review. Nothing in it can change while
--                                                the record is in review (0713 freezes the execution), and a reopen
--                                                changes the cycle, so every review signature of the cycle is superseded.
--   batch_audit_review   <batch>/<n>             the n-th audit-trail review of the record: FULL (first of the cycle) or
--                                                DELTA (from the last mark), its high-water mark, report hash and event
--                                                count; `involved` is recipe.batch_involvement (INV-35). A recorded review
--                                                keeps its content; `current` turns false after a reopen.
--   batch_review_reopen  <batch>/<cycle>         the cycle closed and the review signatures it supersedes.
--   review_items         <batch>/<disp>/<sha>/<ids>  the items one disposition covers (ids sorted, '+'-joined), with the
--                                                SHA-256 of its text (justification, query or reason, and the deviation).
--
-- Acts (all SECURITY DEFINER; the signature is checked against its meaning, record and state, and is the actor's own):
--   recipe.record_production_approval(batch, sig)  RECORD.PRODUCTION_APPROVE; from EXECUTION_COMPLETE or ABORTED; every
--       exception dispositioned or raised as a deviation (PR-52); an aborted record with its abort checklist and no
--       usable output (L-20); free text translated and verified where D-P4-12 needs it. EBMR-REV-001 to 004.
--   recipe.record_audit_trail_review(id, sig)      RECORD.AUDIT_TRAIL_REVIEW; after production approval; the next review
--       number; a delta only with events after the mark; never by an involved person (INV-35). EBMR-REV-010 to 013.
--   recipe.record_qa_review(batch, sig, epoch)     RECORD.QA_REVIEW; from PRODUCTION_APPROVED only (INV-30, S8); the
--       batch's evidence epoch unchanged since the reviewer evaluated it; every item concluded (PR-52); the audit-trail
--       review of the cycle signed and covering every in-scope event (DI-25, INV-48). EBMR-REV-020 to 022.
--   recipe.reopen_review(batch, sig, reason)       RECORD.QA_REVIEW; from PRODUCTION_APPROVED or QA_REVIEWED; a new cycle;
--       every review signature of the closed cycle superseded (L-09). EBMR-REV-030.
--   recipe.dispose_review_items(...)               RECORD.QA_REVIEW; only in QA review (PRODUCTION_APPROVED: DI-34 clause,
--       INV-30); ACCEPT of one critical item after its detail was opened, with a justification; ACCEPT of several only
--       when none is critical, none is on a paused step (PR-07), all share one linked deviation and the person was shown
--       the full list after the last item arrived, with one justification; QUERY and ESCALATE one item at a time. Each
--       item gets its own register row (PR-52). EBMR-REV-050 to 058.
--   recipe.show_review_register(batch), recipe.open_review_item(batch, item): the tracked showing and opening.
--   recipe.record_abort_checklist(batch, jsonb), recipe.record_translation(batch, ref, english),
--   recipe.verify_translation(id): before production approval only. EBMR-REV-060 to 064.
--   recipe.review_gate_problems(batch, act) text[]: the reasons an act is not possible now (the screens show them).
--   recipe.review_disposition_problem(batch) text: NULL only when the record is QA_REVIEWED and the audit-trail mark
--       covers every in-scope event (the gate slices 3 and 4 call before any disposition: DI-34, INV-48).
-- Applied as a new migration; the review_exception change is in 0713.

set local role ebmr_owner;

select kernel.set_actor_context(jsonb_build_object(
  'person_id', '00000000-0000-0000-0000-000000000000', 'account_id', '00000000-0000-0000-0000-000000000000',
  'role_code', 'SOFTWARE_RELEASE', 'session_id', '00000000-0000-0000-0000-000000000000', 'source', 'SYSTEM',
  'site_zone', 'UTC', 'correlation_id', gen_random_uuid(),
  'legal_name', 'Software release (recipe-core migration 0712_review_acts)',
  'reason_code', 'SOFTWARE_RELEASE',
  'reason_text', 'signature types of the reopening of a batch record review and of QA''s disposition of register items (L-09, PR-52)'));

insert into esig.meaning_type (code, version, origin, is_minimum, status, category, role_class, title, meaning_text, permissions,
                               independent_of, excludes_performers, excludes_involved, witness, reauth, delegable, sources)
values
  ('REVIEW_REOPENED', 1, 'VENDOR', true, 'ACTIVE', 'REVIEW', 'REVIEWER', 'Review reopened',
   'Quality unit: I reopen the review of this batch record for the reason given; its review signatures no longer stand.',
   array['RECORD.QA_REVIEW'], '{}', false, false, false, 'ALL_COMPONENTS', false, 'Outline 5.2.2 reopen; L-09'),
  ('REVIEW_ITEMS_DISPOSITIONED', 1, 'VENDOR', true, 'ACTIVE', 'REVIEW', 'REVIEWER', 'Review items dispositioned',
   'Quality unit: I disposition each listed exception of this batch record as stated, after reviewing it.',
   array['RECORD.QA_REVIEW'], '{}', true, false, false, 'ALL_COMPONENTS', false, 'Outline 7.3 QA review, 5.2.4; PR-52; DI-26');

select kernel.set_actor_context(null);

-- ---------------------------------------------------------------------------------------------
-- Tables (insert-only, audited on batch_review:<batch>, outside the audit-trail review's scope)
-- ---------------------------------------------------------------------------------------------

create table recipe.review_list_view (
  id          uuid primary key default gen_random_uuid(),
  batch_id    uuid not null references recipe.batch_execution (id),
  item_count  integer not null check (item_count >= 0),
  person_id   uuid not null,
  account_id  uuid not null,
  shown_at    timestamptz not null default clock_timestamp()
);
create index review_list_view_batch on recipe.review_list_view (batch_id, person_id, shown_at);

create table recipe.review_item_view (
  id            uuid primary key default gen_random_uuid(),
  batch_id      uuid not null,
  exception_id  text not null,
  person_id     uuid not null,
  account_id    uuid not null,
  opened_at     timestamptz not null default clock_timestamp(),
  foreign key (batch_id, exception_id) references recipe.exception_register (batch_id, exception_id)
);
create index review_item_view_item on recipe.review_item_view (batch_id, exception_id, person_id);

create table recipe.review_item_disposition (
  act_id         bigint primary key references recipe.exception_register_act (id),
  batch_id       uuid not null,
  exception_id   text not null,
  disposition    text not null check (disposition in ('ACCEPT', 'QUERY', 'ESCALATE')),
  aggregate_id   text not null,
  signature_id   uuid not null,
  item_count     integer not null check (item_count >= 1),
  justification  text,
  recorded_at    timestamptz not null default clock_timestamp(),
  foreign key (batch_id, exception_id) references recipe.exception_register (batch_id, exception_id)
);
create index review_item_disposition_signature on recipe.review_item_disposition (signature_id);

create table recipe.abort_checklist (
  batch_id                uuid primary key references recipe.batch_execution (id),
  materials_accounted     text not null check (btrim(materials_accounted) <> ''),
  outputs_dispositioned   text not null check (btrim(outputs_dispositioned) <> ''),
  equipment_dirty         text not null check (btrim(equipment_dirty) <> ''),
  genealogy_closed        text not null check (btrim(genealogy_closed) <> ''),
  contingency_reconciled  text not null check (btrim(contingency_reconciled) <> ''),
  person_id               uuid not null,
  account_id              uuid not null,
  role_code               text not null,
  recorded_at             timestamptz not null default clock_timestamp()
);

create table recipe.free_text_translation (
  id               uuid primary key default gen_random_uuid(),
  batch_id         uuid not null references recipe.batch_execution (id),
  source_ref       text not null check (btrim(source_ref) <> ''),
  source_sha256    text not null check (source_sha256 ~ '^[0-9a-f]{64}$'),
  english          text not null check (btrim(english) <> ''),
  translated_by    uuid not null,
  translated_account uuid not null,
  translated_at    timestamptz not null default clock_timestamp()
);
create index free_text_translation_source on recipe.free_text_translation (batch_id, source_ref, translated_at);

create table recipe.free_text_translation_verification (
  translation_id  uuid primary key references recipe.free_text_translation (id),
  verified_by     uuid not null,
  verified_account uuid not null,
  verified_at     timestamptz not null default clock_timestamp()
);

revoke all on recipe.review_list_view, recipe.review_item_view, recipe.review_item_disposition, recipe.abort_checklist,
              recipe.free_text_translation, recipe.free_text_translation_verification from public;
select platform.enforce_db_time('recipe.review_list_view', array['shown_at']);
select platform.enforce_db_time('recipe.review_item_view', array['opened_at']);
select platform.enforce_db_time('recipe.review_item_disposition', array['recorded_at']);
select platform.enforce_db_time('recipe.abort_checklist', array['recorded_at']);
select platform.enforce_db_time('recipe.free_text_translation', array['translated_at']);
select platform.enforce_db_time('recipe.free_text_translation_verification', array['verified_at']);
select kernel.register_audited_table('recipe.review_list_view', 'batch_review', 'batch_id', true);
select kernel.register_audited_table('recipe.review_item_view', 'batch_review', 'batch_id', true);
select kernel.register_audited_table('recipe.review_item_disposition', 'batch_review', 'batch_id', true);
select kernel.register_audited_table('recipe.abort_checklist', 'batch_review', 'batch_id', true);
select kernel.register_audited_table('recipe.free_text_translation', 'batch_review', 'batch_id', true);
select kernel.register_audited_table('recipe.free_text_translation_verification', 'free_text_translation', 'translation_id', true);

-- ---------------------------------------------------------------------------------------------
-- Small readers
-- ---------------------------------------------------------------------------------------------

-- A GMP batch of this installation, or an error.
create function recipe.review_batch(p_batch uuid) returns recipe.batch_execution
language plpgsql stable security definer set search_path = pg_catalog, recipe, pg_temp as $$
declare
  b recipe.batch_execution;
begin
  select * into b from recipe.batch_execution where id = p_batch;
  if not found or b.purpose <> 'GMP_BATCH' then
    raise exception using errcode = 'P0001',
      message = format('EBMR-REV-001 %s is no GMP batch record; review applies to the records of issued GMP batches (outline 5.2.2)', coalesce(p_batch::text, 'NULL'));
  end if;
  return b;
end
$$;

-- Critical register items: dispositioned one by one (PR-52; outline 7.3).
create function recipe.review_item_critical(r recipe.exception_register) returns boolean
language sql immutable set search_path = pg_catalog, recipe, pg_temp as $$
  select r.severity = 'CRITICAL' or r.qa_only or r.registration_relevant
$$;

-- An item's review status: OPEN, QUERIED, RESPONDED, ACCEPTED or ESCALATED (its latest QA review act).
create function recipe.review_item_status(p_batch uuid, p_exception text) returns text
language sql stable security definer set search_path = pg_catalog, recipe, pg_temp as $$
  select coalesce((select case a.act when 'ACCEPTED_BY_QA' then 'ACCEPTED' else a.act end
                     from recipe.exception_register_act a
                    where a.batch_id = p_batch and a.exception_id = p_exception and a.act in ('QUERIED', 'RESPONDED', 'ACCEPTED_BY_QA', 'ESCALATED')
                    order by a.id desc limit 1), 'OPEN')
$$;

-- D-P4-12: a text written in a script other than Latin (Cyrillic to Devanagari and the other Indic scripts, CJK, Hangul).
create function recipe.text_needs_translation(p_text text) returns boolean
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select coalesce(p_text, '') ~ '[Ѐ-῿⺀-鿿가-힯]'
$$;

-- The free-text GMP fields of the record: exception descriptions (as registered, so a raised exception's description is
-- listed once), the notes of the register's acts before review, and the reasons, justifications and comments of its
-- accepted commands.
create function recipe.batch_free_text(p_batch uuid) returns table (source_ref text, source text, body text)
language sql stable security definer set search_path = pg_catalog, recipe, pg_temp as $$
  select 'exception:' || r.exception_id || ':raised', 'Exception ' || r.exception_id, r.title
    from recipe.exception_register r where r.batch_id = p_batch
  union all
  select 'exception:' || a.exception_id || ':' || a.act || ':' || a.id, initcap(replace(lower(a.act), '_', ' ')) || ' note of ' || a.exception_id, a.note
    from recipe.exception_register_act a
   where a.batch_id = p_batch and a.note is not null and a.act in ('DEVIATION_LINKED', 'DISPOSITIONED')
  union all
  select 'command:' || c.seq || ':' || k, initcap(k) || ' of ' || c.command_type || ' (row ' || c.seq || ')', c.command ->> k
    from recipe.execution_command c cross join unnest(array['reason', 'justification', 'comment']) k
   where c.batch_id = p_batch and c.kind = 'COMMAND' and c.accepted and jsonb_typeof(c.command -> k) = 'string'
$$;

-- The latest translation of a source of the record, with its verification.
create function recipe.latest_translation(p_batch uuid, p_source_ref text)
returns table (id uuid, source_sha256 text, english text, translated_by uuid, translated_at timestamptz, verified_by uuid, verified_at timestamptz)
language sql stable security definer set search_path = pg_catalog, recipe, pg_temp as $$
  select t.id, t.source_sha256, t.english, t.translated_by, t.translated_at, v.verified_by, v.verified_at
    from recipe.free_text_translation t left join recipe.free_text_translation_verification v on v.translation_id = t.id
   where t.batch_id = p_batch and t.source_ref = p_source_ref
   order by t.translated_at desc, t.id desc limit 1
$$;

-- D-P4-12: the record's free texts that still need a verified English translation (none for an India-only market set).
create function recipe.free_text_problems(p_batch uuid) returns text[]
language sql stable security definer set search_path = pg_catalog, recipe, pg_temp as $$
  select coalesce(array_agg(format('%s needs an English translation verified by a second person, as the batch is for %s (D-P4-12)',
                                   f.source, array_to_string(b.market_set, ', ')) order by f.source_ref), '{}')
    from recipe.batch_execution b cross join recipe.batch_free_text(b.id) f
   where b.id = p_batch and b.market_set && array['US', 'EU'] and recipe.text_needs_translation(f.body)
     and not exists (select 1 from recipe.latest_translation(b.id, f.source_ref) t
                      where t.verified_by is not null and t.source_sha256 = encode(sha256(convert_to(f.body, 'UTF8')), 'hex'))
$$;

-- The review number the next audit-trail review signs, and the last mark of the current cycle (NULL: none yet).
create function recipe.audit_review_next_id(p_batch uuid) returns text
language sql stable security definer set search_path = pg_catalog, recipe, pg_temp as $$
  select p_batch::text || '/' || (1 + coalesce((select max(a.review_number) from recipe.batch_review_act a where a.batch_id = p_batch), 0))
$$;

create function recipe.audit_review_last(p_batch uuid) returns recipe.batch_review_act
language sql stable security definer set search_path = pg_catalog, recipe, pg_temp as $$
  select a.* from recipe.batch_review_act a
   where a.batch_id = p_batch and a.cycle = recipe.batch_review_cycle(p_batch) and a.review_number is not null
   order by a.review_number desc limit 1
$$;

-- INV-48: the last signed mark of the cycle covers every in-scope event.
create function recipe.audit_review_covered(p_batch uuid) returns boolean
language plpgsql stable security definer set search_path = pg_catalog, recipe, pg_temp as $$
declare
  l recipe.batch_review_act := recipe.audit_review_last(p_batch);
begin
  if l.id is null then
    return false;
  end if;
  return not exists (select 1 from recipe.audit_review_events(p_batch, l.high_water));
end
$$;

-- ---------------------------------------------------------------------------------------------
-- Content providers
-- ---------------------------------------------------------------------------------------------

create function recipe.batch_review_content(p_id text) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, recipe, plant, pg_temp as $$
declare
  b  recipe.batch_execution;
  st recipe.execution_state;
  ck recipe.abort_checklist;
begin
  if coalesce(p_id, '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return '{"exists": false}'::jsonb;
  end if;
  select * into b from recipe.batch_execution where id = p_id::uuid and purpose = 'GMP_BATCH';
  select * into st from recipe.execution_state where batch_id = p_id::uuid;
  if b.id is null or st.batch_id is null then
    return '{"exists": false}'::jsonb;
  end if;
  select * into ck from recipe.abort_checklist where batch_id = b.id;
  return jsonb_build_object(
    'exists', true,
    'content_version', recipe.batch_review_cycle(b.id),
    'content', jsonb_build_object(
      'batch_id', b.id, 'batch_number', b.batch_number, 'record_kind', recipe.batch_record_kind(b.id), 'cycle', recipe.batch_review_cycle(b.id),
      'market_set', to_jsonb(b.market_set),
      'execution', jsonb_build_object('status', st.status, 'last_seq', st.last_seq::text, 'state_hash', st.state_hash, 'last_row_hash', st.last_row_hash),
      'exceptions', (select coalesce(jsonb_agg(jsonb_build_object(
                        'id', r.exception_id, 'type', r.exception_type, 'category', r.category, 'severity', r.severity, 'tier', r.tier,
                        'title', r.title, 'step', r.raising_step_key,
                        'disposition', (select jsonb_build_object('outcome', a.outcome, 'by', a.by_person, 'note', a.note, 'signature', a.signature_id)
                                          from recipe.exception_register_act a where a.batch_id = r.batch_id and a.exception_id = r.exception_id and a.act = 'DISPOSITIONED'),
                        'deviation', (select a.deviation_ref from recipe.exception_register_act a
                                       where a.batch_id = r.batch_id and a.exception_id = r.exception_id and a.act = 'DEVIATION_LINKED'))
                      order by r.exception_id), '[]'::jsonb)
                     from recipe.exception_register r where r.batch_id = b.id),
      'translations', (select coalesce(jsonb_agg(jsonb_build_object('source', f.source_ref, 'source_sha256', t.source_sha256, 'english', t.english,
                                                                    'translated_by', t.translated_by, 'verified_by', t.verified_by) order by f.source_ref), '[]'::jsonb)
                         from recipe.batch_free_text(b.id) f cross join lateral recipe.latest_translation(b.id, f.source_ref) t),
      'abort_checklist', case when ck.batch_id is null then null else jsonb_build_object(
                           'materials_accounted', ck.materials_accounted, 'outputs_dispositioned', ck.outputs_dispositioned,
                           'equipment_dirty', ck.equipment_dirty, 'genealogy_closed', ck.genealogy_closed,
                           'contingency_reconciled', ck.contingency_reconciled, 'by', ck.person_id) end),
    'state', recipe.batch_review_state(b.id),
    'scope', plant.batch_scope(b.id));
end
$$;

create function recipe.batch_audit_review_content(p_id text) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, recipe, plant, pg_temp as $$
declare
  m     text[] := regexp_match(coalesce(p_id, ''), '^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/([1-9][0-9]{0,6})$');
  b     recipe.batch_execution;
  a     recipe.batch_review_act;
  l     recipe.batch_review_act;
  v_n   integer;
  v_c   jsonb;
begin
  if m is null then
    return '{"exists": false}'::jsonb;
  end if;
  select * into b from recipe.batch_execution where id = m[1]::uuid and purpose = 'GMP_BATCH';
  if b.id is null then
    return '{"exists": false}'::jsonb;
  end if;
  v_n := m[2]::integer;
  select * into a from recipe.batch_review_act x where x.batch_id = b.id and x.review_number = v_n;
  if a.id is not null then
    v_c := jsonb_build_object('batch_id', b.id, 'review_number', v_n,
                              'kind', case when a.act = 'AUDIT_TRAIL_REVIEWED' then 'FULL' else 'DELTA' end, 'cycle', a.cycle,
                              'from_mark', a.from_mark, 'high_water', a.high_water, 'report_hash', a.report_hash,
                              'current', a.cycle = recipe.batch_review_cycle(b.id));
  elsif p_id = recipe.audit_review_next_id(b.id) then
    l := recipe.audit_review_last(b.id);
    v_c := jsonb_build_object('batch_id', b.id, 'review_number', v_n, 'kind', case when l.id is null then 'FULL' else 'DELTA' end,
                              'cycle', recipe.batch_review_cycle(b.id), 'from_mark', l.high_water, 'high_water', recipe.audit_review_mark(b.id),
                              'report_hash', recipe.audit_review_report_hash(b.id, l.high_water), 'current', true);
  else
    return '{"exists": false}'::jsonb;
  end if;
  return jsonb_build_object('exists', true, 'content_version', v_n, 'content', v_c, 'state', recipe.batch_review_state(b.id),
                            'scope', plant.batch_scope(b.id), 'involved', to_jsonb(recipe.batch_involvement(b.id)));
end
$$;

-- The review signatures of a cycle of the record (not the reopen of it).
create function recipe.review_cycle_signatures(p_batch uuid, p_cycle integer) returns uuid[]
language sql stable security definer set search_path = pg_catalog, recipe, pg_temp as $$
  select coalesce(array_agg(a.signature_id order by a.recorded_at, a.id), '{}') from recipe.batch_review_act a
   where a.batch_id = p_batch and a.cycle = p_cycle and a.act <> 'REOPENED'
$$;

create function recipe.batch_review_reopen_content(p_id text) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, recipe, plant, pg_temp as $$
declare
  m   text[] := regexp_match(coalesce(p_id, ''), '^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/([1-9][0-9]{0,6})$');
  b   recipe.batch_execution;
begin
  if m is null then
    return '{"exists": false}'::jsonb;
  end if;
  select * into b from recipe.batch_execution where id = m[1]::uuid and purpose = 'GMP_BATCH';
  if b.id is null or m[2]::integer > recipe.batch_review_cycle(b.id) then
    return '{"exists": false}'::jsonb;
  end if;
  return jsonb_build_object('exists', true, 'content_version', m[2]::integer,
    'content', jsonb_build_object('batch_id', b.id, 'batch_number', b.batch_number, 'cycle', m[2]::integer,
                                  'superseded_signatures', to_jsonb(recipe.review_cycle_signatures(b.id, m[2]::integer))),
    'state', recipe.batch_review_state(b.id), 'scope', plant.batch_scope(b.id));
end
$$;

-- The aggregate id of a disposition: the batch, the disposition, the SHA-256 of its text and the item ids.
create function recipe.review_items_aggregate_id(p_batch uuid, p_disposition text, p_items text[], p_justification text, p_deviation_ref text) returns text
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select p_batch::text || '/' || coalesce(p_disposition, '') || '/'
         || encode(sha256(convert_to(coalesce(btrim(p_justification), '') || E'\n' || coalesce(btrim(p_deviation_ref), ''), 'UTF8')), 'hex') || '/'
         || coalesce((select string_agg(distinct x collate "C", '+' order by x collate "C") from unnest(p_items) x), '')
$$;

create function recipe.review_items_content(p_id text) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, recipe, plant, pg_temp as $$
declare
  m     text[] := regexp_match(coalesce(p_id, ''), '^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/(ACCEPT|QUERY|ESCALATE)/([0-9a-f]{64})/([^/]+)$');
  b     recipe.batch_execution;
  v_ids text[];
  v_items jsonb;
begin
  if m is null then
    return '{"exists": false}'::jsonb;
  end if;
  select * into b from recipe.batch_execution where id = m[1]::uuid and purpose = 'GMP_BATCH';
  if b.id is null then
    return '{"exists": false}'::jsonb;
  end if;
  v_ids := string_to_array(m[4], '+');
  select jsonb_agg(jsonb_build_object('id', r.exception_id, 'type', r.exception_type, 'severity', r.severity, 'critical', recipe.review_item_critical(r),
                                      'title', r.title, 'step', r.raising_step_key,
                                      'deviation', (select a.deviation_ref from recipe.exception_register_act a
                                                     where a.batch_id = r.batch_id and a.exception_id = r.exception_id and a.act = 'DEVIATION_LINKED'))
                   order by r.exception_id)
    into v_items
    from recipe.exception_register r where r.batch_id = b.id and r.exception_id = any (v_ids);
  if coalesce(jsonb_array_length(v_items), 0) <> cardinality(v_ids) then
    return '{"exists": false}'::jsonb;
  end if;
  return jsonb_build_object('exists', true, 'content_version', 1,
    'content', jsonb_build_object('batch_id', b.id, 'batch_number', b.batch_number, 'disposition', m[2], 'text_sha256', m[3], 'items', v_items),
    'state', recipe.batch_review_state(b.id), 'scope', plant.batch_scope(b.id));
end
$$;

select esig.register_content_provider('batch_review', 'recipe.batch_review_content(text)',
  'A completed GMP batch record in review: execution status, last row and state hash, exceptions with their engine dispositions, translations, abort checklist, review cycle');
select esig.register_content_provider('batch_audit_review', 'recipe.batch_audit_review_content(text)',
  'An audit-trail review of a GMP batch record: full or delta, its mark, high-water mark and report hash');
select esig.register_content_provider('batch_review_reopen', 'recipe.batch_review_reopen_content(text)',
  'The reopening of a review cycle of a GMP batch record and the review signatures it supersedes');
select esig.register_content_provider('review_items', 'recipe.review_items_content(text)',
  'Register items of a GMP batch record dispositioned in QA review together, with the SHA-256 of the disposition text');

-- ---------------------------------------------------------------------------------------------
-- Gates
-- ---------------------------------------------------------------------------------------------

create function recipe.review_gate_problems(p_batch uuid, p_act text) returns text[]
language plpgsql stable security definer set search_path = pg_catalog, recipe, plant, pg_temp as $$
declare
  v_state text := recipe.batch_review_state(p_batch);
  v_out   text[] := '{}';
  r       recipe.exception_register;
  c       plant.output_container;
  v_st    text;
  l       recipe.batch_review_act;
begin
  perform recipe.review_batch(p_batch);
  case p_act
    when 'PRODUCTION_APPROVE' then
      if v_state is distinct from 'EXECUTION_COMPLETE' and v_state is distinct from 'ABORTED' then
        v_out := v_out || format('the record is %s; production approval follows EXECUTION_COMPLETE or ABORTED (PR-16, L-20)', coalesce(v_state, 'without a stored state'));
      end if;
      for r in select * from recipe.exception_register x where x.batch_id = p_batch order by x.exception_id loop
        if not exists (select 1 from recipe.exception_register_act a where a.batch_id = p_batch and a.exception_id = r.exception_id
                        and a.act in ('DISPOSITIONED', 'DEVIATION_LINKED')) then
          v_out := v_out || format('exception %s (%s) is neither dispositioned nor raised as a deviation (PR-52)', r.exception_id, r.title);
        end if;
      end loop;
      if v_state = 'ABORTED' then
        if not exists (select 1 from recipe.abort_checklist k where k.batch_id = p_batch) then
          v_out := v_out || 'the abort checklist is not recorded: materials, outputs, equipment, genealogy, contingency forms (L-20)'::text;
        end if;
        for c in select * from plant.output_container x where x.batch_id = p_batch order by x.label_code loop
          if plant.container_usable_problem(c.id) is null then
            v_out := v_out || format('output container %s of the aborted batch is still usable; QA holds or rejects it first (L-20)', c.label_code);
          end if;
        end loop;
      end if;
      v_out := v_out || recipe.free_text_problems(p_batch);
    when 'AUDIT_TRAIL_REVIEW' then
      if v_state is distinct from 'PRODUCTION_APPROVED' and v_state is distinct from 'QA_REVIEWED' then
        v_out := v_out || format('the record is %s; the audit-trail review follows the production approval (DI-25, S8)', coalesce(v_state, 'without a stored state'));
      elsif recipe.audit_review_covered(p_batch) then
        v_out := v_out || 'the audit trail is reviewed up to its last in-scope event; there is nothing to review (INV-48)'::text;
      end if;
    when 'QA_REVIEW' then
      if v_state is distinct from 'PRODUCTION_APPROVED' then
        v_out := v_out || format('the record is %s; QA review follows production approval and is given once per review cycle (INV-30, S8)', coalesce(v_state, 'without a stored state'));
      end if;
      for r in select * from recipe.exception_register x where x.batch_id = p_batch order by x.exception_id loop
        v_st := recipe.review_item_status(p_batch, r.exception_id);
        if v_st not in ('ACCEPTED', 'ESCALATED') then
          v_out := v_out || format('exception %s is not concluded in review (it is %s) (PR-52, DI-26)', r.exception_id, v_st);
        end if;
      end loop;
      l := recipe.audit_review_last(p_batch);
      if l.id is null then
        v_out := v_out || format('the audit-trail review of review cycle %s is not signed (DI-25)', recipe.batch_review_cycle(p_batch));
      elsif not recipe.audit_review_covered(p_batch) then
        v_out := v_out || 'audit events in scope were recorded after the review''s high-water mark; a delta review is due (INV-48)'::text;
      end if;
    when 'REOPEN' then
      if v_state is distinct from 'PRODUCTION_APPROVED' and v_state is distinct from 'QA_REVIEWED' then
        v_out := v_out || format('the record is %s; only a record in review (PRODUCTION_APPROVED or QA_REVIEWED) is reopened (L-09)', coalesce(v_state, 'without a stored state'));
      end if;
    else
      raise exception using errcode = 'P0001', message = format('EBMR-REV-001 %s is not a review act', coalesce(p_act, 'NULL'));
  end case;
  return v_out;
end
$$;

-- DI-34 clause and INV-48: NULL only when the record may be dispositioned as far as its review goes.
create function recipe.review_disposition_problem(p_batch uuid) returns text
language plpgsql stable security definer set search_path = pg_catalog, recipe, pg_temp as $$
declare
  v_state text := recipe.batch_review_state(p_batch);
begin
  if v_state is distinct from 'QA_REVIEWED' then
    return format('the record is %s; a disposition follows the completed QA review (DI-34)', coalesce(v_state, 'unknown'));
  end if;
  if not recipe.audit_review_covered(p_batch) then
    return 'audit events in scope were recorded after the audit-trail review''s high-water mark; a signed delta review is due before any disposition (INV-48, DI-25)';
  end if;
  return null;
end
$$;

-- ---------------------------------------------------------------------------------------------
-- Acts
-- ---------------------------------------------------------------------------------------------

-- The actor's own valid signature of p_meaning on the record, applied in the record's current state.
create function recipe.assert_review_signature(p_signature uuid, p_meaning text, p_type text, p_id text, p_person uuid) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, recipe, esig, pg_temp as $$
declare
  v_prob text := esig.signature_problem(p_signature, p_meaning, p_type, p_id);
  v      jsonb;
begin
  v_prob := coalesce(v_prob, esig.signature_state_problem(p_signature));
  if v_prob is not null then
    raise exception using errcode = 'P0001', message = format('EBMR-REV-005 %s (DI-35, DI-37)', v_prob);
  end if;
  v := esig.signature_state(p_signature);
  if (v ->> 'signer_person')::uuid is distinct from p_person then
    raise exception using errcode = 'P0001', message = format('EBMR-REV-005 %s is recorded by the person who signed it (DI-14, S16)', p_meaning);
  end if;
  return v;
end
$$;

create function recipe.review_actor(p_batch uuid, p_permission text) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, recipe, iam, plant, pg_temp as $$
begin
  perform iam.assert_not_administrator();
  perform recipe.review_batch(p_batch);
  return iam.require_permission(p_permission, plant.batch_scope(p_batch));
end
$$;

create function recipe.raise_review_problems(p_code text, p_what text, p_problems text[]) returns void
language plpgsql immutable set search_path = pg_catalog, pg_temp as $$
begin
  if cardinality(p_problems) > 0 then
    raise exception using errcode = 'P0001', message = format('%s %s: %s', p_code, p_what, array_to_string(p_problems, '; '));
  end if;
end
$$;

create function recipe.insert_review_act(p_actor jsonb, p_batch uuid, p_act text, p_signature uuid, p_values jsonb) returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, recipe, pg_temp as $$
declare
  v_id uuid;
begin
  insert into recipe.batch_review_act (batch_id, cycle, act, signature_id, review_number, from_mark, high_water, report_hash, reviewed_content_hash,
                                       epoch, reason, person_id, account_id, role_code, correlation_id)
  values (p_batch, recipe.batch_review_cycle(p_batch), p_act, p_signature, (p_values ->> 'review_number')::integer, nullif(p_values -> 'from_mark', 'null'::jsonb),
          nullif(p_values -> 'high_water', 'null'::jsonb), p_values ->> 'report_hash', p_values ->> 'reviewed_content_hash', (p_values ->> 'epoch')::bigint,
          p_values ->> 'reason', (p_actor ->> 'person_id')::uuid, (p_actor ->> 'account_id')::uuid, p_actor ->> 'role_code',
          (p_actor ->> 'correlation_id')::uuid)
  returning id into v_id;
  return v_id;
end
$$;

create function recipe.record_production_approval(p_batch uuid, p_signature uuid) returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, recipe, pg_temp as $$
declare
  v_actor   jsonb := recipe.review_actor(p_batch, 'RECORD.PRODUCTION_APPROVE');
  v_meaning text;
  v_sig     jsonb;
begin
  perform 1 from recipe.execution_state s where s.batch_id = p_batch for update;
  perform recipe.raise_review_problems('EBMR-REV-002', 'the record cannot be approved by production',
                                       recipe.review_gate_problems(p_batch, 'PRODUCTION_APPROVE'));
  v_meaning := case when recipe.batch_record_kind(p_batch) = 'PACKAGING' then 'PACKAGING_RECORD_APPROVED' else 'PRODUCTION_APPROVED' end;
  v_sig := recipe.assert_review_signature(p_signature, v_meaning, 'batch_review', p_batch::text, (v_actor ->> 'person_id')::uuid);
  return recipe.insert_review_act(v_actor, p_batch, v_meaning, p_signature,
                                  jsonb_build_object('reviewed_content_hash', v_sig ->> 'content_hash', 'epoch', recipe.epoch_of('BATCH', p_batch)));
end
$$;

create function recipe.record_audit_trail_review(p_review_id text, p_signature uuid) returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, recipe, pg_temp as $$
declare
  m       text[] := regexp_match(coalesce(p_review_id, ''), '^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/([1-9][0-9]{0,6})$');
  v_batch uuid;
  v_actor jsonb;
  l       recipe.batch_review_act;
  v_mark  jsonb;
  v_kind  text;
begin
  if m is null then
    raise exception using errcode = 'P0001', message = format('EBMR-REV-010 %s names no audit-trail review of a batch record (<batch>/<n>)', coalesce(p_review_id, 'NULL'));
  end if;
  v_batch := m[1]::uuid;
  v_actor := recipe.review_actor(v_batch, 'RECORD.AUDIT_TRAIL_REVIEW');
  perform 1 from recipe.execution_state s where s.batch_id = v_batch for update;
  perform recipe.raise_review_problems('EBMR-REV-010', 'the audit trail of the record cannot be reviewed now',
                                       recipe.review_gate_problems(v_batch, 'AUDIT_TRAIL_REVIEW'));
  if p_review_id is distinct from recipe.audit_review_next_id(v_batch) then
    raise exception using errcode = 'P0001',
      message = format('EBMR-REV-011 %s is not the next audit-trail review of the record (%s is); reload the report', p_review_id, recipe.audit_review_next_id(v_batch));
  end if;
  -- INV-35: the kernel refuses an involved signer (the provider's involvement set); the record keeps its own copy of the rule.
  if (v_actor ->> 'person_id')::uuid = any (recipe.batch_involvement(v_batch)) then
    raise exception using errcode = 'P0001',
      message = 'EBMR-REV-012 a person involved in the batch (who entered, corrected or signed in it, or approved it for production) cannot sign its audit-trail review (INV-35, outline 7.2 S10)';
  end if;
  l := recipe.audit_review_last(v_batch);
  v_kind := case when l.id is null then 'AUDIT_TRAIL_REVIEWED' else 'DELTA_AUDIT_TRAIL_REVIEWED' end;
  perform recipe.assert_review_signature(p_signature, v_kind, 'batch_audit_review', p_review_id, (v_actor ->> 'person_id')::uuid);
  v_mark := recipe.audit_review_mark(v_batch);
  return recipe.insert_review_act(v_actor, v_batch, v_kind, p_signature,
                                  jsonb_build_object('review_number', m[2]::integer, 'from_mark', l.high_water, 'high_water', v_mark,
                                                     'report_hash', recipe.audit_review_report_hash(v_batch, l.high_water),
                                                     'epoch', recipe.epoch_of('BATCH', v_batch)));
end
$$;

create function recipe.record_qa_review(p_batch uuid, p_signature uuid, p_expected_epoch bigint) returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, recipe, pg_temp as $$
declare
  v_actor jsonb := recipe.review_actor(p_batch, 'RECORD.QA_REVIEW');
  v_epoch bigint;
  v_sig   jsonb;
  v_items text;
begin
  perform 1 from recipe.execution_state s where s.batch_id = p_batch for update;
  perform 1 from recipe.evidence_epoch e where e.subject_kind = 'BATCH' and e.subject_id = p_batch for share;
  perform recipe.raise_review_problems('EBMR-REV-020', 'the record cannot be QA reviewed', recipe.review_gate_problems(p_batch, 'QA_REVIEW'));
  v_epoch := recipe.epoch_of('BATCH', p_batch);
  if p_expected_epoch is null or p_expected_epoch <> v_epoch then
    raise exception using errcode = 'P0001',
      message = format('EBMR-REV-021 the evidence of the record changed after it was evaluated (epoch %s, now %s); review it again (DI-37)',
                       coalesce(p_expected_epoch::text, 'none given'), v_epoch);
  end if;
  v_sig := recipe.assert_review_signature(p_signature, 'QA_REVIEWED', 'batch_review', p_batch::text, (v_actor ->> 'person_id')::uuid);
  select string_agg(a.exception_id || '#' || a.act || '#' || a.id, E'\n' order by a.exception_id, a.id) into v_items
    from recipe.exception_register_act a where a.batch_id = p_batch and a.act in ('QUERIED', 'RESPONDED', 'ACCEPTED_BY_QA', 'ESCALATED');
  return recipe.insert_review_act(v_actor, p_batch, 'QA_REVIEWED', p_signature,
    jsonb_build_object('reviewed_content_hash', encode(sha256(convert_to((v_sig ->> 'content_hash') || E'\n' || coalesce(v_items, ''), 'UTF8')), 'hex'),
                       'epoch', v_epoch));
end
$$;

create function recipe.reopen_review(p_batch uuid, p_signature uuid, p_reason text) returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, recipe, esig, pg_temp as $$
declare
  v_actor jsonb := recipe.review_actor(p_batch, 'RECORD.QA_REVIEW');
  v_cycle integer;
  v_id    uuid;
  a       recipe.batch_review_act;
begin
  perform 1 from recipe.execution_state s where s.batch_id = p_batch for update;
  perform recipe.raise_review_problems('EBMR-REV-030', 'the review cannot be reopened', recipe.review_gate_problems(p_batch, 'REOPEN'));
  if p_reason is null or recipe.reason_is_blank(p_reason) then
    raise exception using errcode = 'P0001', message = 'EBMR-REV-030 a reopen states the person''s own reason (L-09, DI-22)';
  end if;
  v_cycle := recipe.batch_review_cycle(p_batch);
  perform recipe.assert_review_signature(p_signature, 'REVIEW_REOPENED', 'batch_review_reopen', p_batch::text || '/' || v_cycle, (v_actor ->> 'person_id')::uuid);
  v_id := recipe.insert_review_act(v_actor, p_batch, 'REOPENED', p_signature, jsonb_build_object('reason', btrim(p_reason)));
  -- L-09: the review signatures of the closed cycle no longer stand (each record's content changed with the cycle).
  perform esig.content_changed('batch_review', p_batch::text, 'recipe.batch_review_act', 'INSERT');
  for a in select * from recipe.batch_review_act x where x.batch_id = p_batch and x.cycle = v_cycle and x.review_number is not null loop
    perform esig.content_changed('batch_audit_review', p_batch::text || '/' || a.review_number, 'recipe.batch_review_act', 'INSERT');
  end loop;
  return v_id;
end
$$;

create function recipe.show_review_register(p_batch uuid) returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, recipe, pg_temp as $$
declare
  v_actor jsonb := recipe.review_actor(p_batch, 'RECORD.READ');
  v_id    uuid;
begin
  insert into recipe.review_list_view (batch_id, item_count, person_id, account_id)
  values (p_batch, (select count(*) from recipe.exception_register r where r.batch_id = p_batch), (v_actor ->> 'person_id')::uuid, (v_actor ->> 'account_id')::uuid)
  returning id into v_id;
  return v_id;
end
$$;

create function recipe.open_review_item(p_batch uuid, p_exception text) returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, recipe, pg_temp as $$
declare
  v_actor jsonb := recipe.review_actor(p_batch, 'RECORD.READ');
  v_id    uuid;
begin
  if not exists (select 1 from recipe.exception_register r where r.batch_id = p_batch and r.exception_id = p_exception) then
    raise exception using errcode = 'P0001', message = format('EBMR-REV-050 batch %s has no register item %s (DI-26)', p_batch, coalesce(p_exception, 'NULL'));
  end if;
  insert into recipe.review_item_view (batch_id, exception_id, person_id, account_id)
  values (p_batch, p_exception, (v_actor ->> 'person_id')::uuid, (v_actor ->> 'account_id')::uuid)
  returning id into v_id;
  return v_id;
end
$$;

create function recipe.dispose_review_items(p_batch uuid, p_items text[], p_disposition text, p_justification text, p_deviation_ref text, p_signature uuid)
returns integer
language plpgsql volatile security definer set search_path = pg_catalog, recipe, site, pg_temp as $$
declare
  v_actor  jsonb := recipe.review_actor(p_batch, 'RECORD.QA_REVIEW');
  v_person uuid := (v_actor ->> 'person_id')::uuid;
  v_state  text;
  v_ids    text[];
  v_agg    text;
  v_text   text := nullif(btrim(coalesce(p_justification, '')), '');
  v_ref    text := nullif(btrim(coalesce(p_deviation_ref, '')), '');
  r        recipe.exception_register;
  v_st     text;
  v_disp   recipe.exception_register_act;
  v_refs   text[];
  v_shown  timestamptz;
  v_last   timestamptz;
  v_prob   text;
  v_act    bigint;
  st       jsonb;
begin
  perform 1 from recipe.execution_state s where s.batch_id = p_batch for update;
  v_state := recipe.batch_review_state(p_batch);
  -- INV-30, S8, DI-34 clause: QA dispositions items only in its review, after the production approval.
  if v_state is distinct from 'PRODUCTION_APPROVED' then
    raise exception using errcode = 'P0001',
      message = format('EBMR-REV-050 the record is %s; QA dispositions register items in its review, which follows the production approval (INV-30, DI-34)', coalesce(v_state, 'unknown'));
  end if;
  if p_disposition is null or p_disposition not in ('ACCEPT', 'QUERY', 'ESCALATE') then
    raise exception using errcode = 'P0001', message = format('EBMR-REV-050 %s is not a disposition; an item is accepted, queried or escalated (outline 7.3)', coalesce(p_disposition, 'NULL'));
  end if;
  if p_items is null or cardinality(p_items) = 0 or exists (select 1 from unnest(p_items) x where x is null or x ~ '[/+]' or btrim(x) = '')
     or (select count(distinct x) from unnest(p_items) x) <> cardinality(p_items) then
    raise exception using errcode = 'P0001', message = 'EBMR-REV-050 a disposition names its register items, each once (PR-52)';
  end if;
  v_ids := array(select x from unnest(p_items) x order by x collate "C");
  if p_disposition in ('QUERY', 'ESCALATE') and cardinality(v_ids) > 1 then
    raise exception using errcode = 'P0001', message = format('EBMR-REV-051 a %s names one item; only non-critical items are accepted together (PR-52)', lower(p_disposition));
  end if;
  if p_disposition = 'QUERY' and v_text is null then
    raise exception using errcode = 'P0001', message = 'EBMR-REV-051 a query states its question (DI-26)';
  end if;
  if p_disposition = 'ESCALATE' and (v_ref is null or v_text is null) then
    raise exception using errcode = 'P0001', message = 'EBMR-REV-051 an escalation names the deviation it is escalated to and its reason (DI-26, PR-49)';
  end if;
  if p_disposition = 'ACCEPT' and cardinality(v_ids) > 1 and v_text is null then
    raise exception using errcode = 'P0001', message = 'EBMR-REV-054 items accepted together carry one justification (PR-52)';
  end if;
  v_agg := recipe.review_items_aggregate_id(p_batch, p_disposition, v_ids, v_text, v_ref);
  perform recipe.assert_review_signature(p_signature, 'REVIEW_ITEMS_DISPOSITIONED', 'review_items', v_agg, v_person);

  select max(x.recorded_at) into v_last from recipe.exception_register x where x.batch_id = p_batch;
  select max(v.shown_at) into v_shown from recipe.review_list_view v where v.batch_id = p_batch and v.person_id = v_person;
  select s.state into st from recipe.execution_state s where s.batch_id = p_batch;
  for r in select * from recipe.exception_register x where x.batch_id = p_batch and x.exception_id = any (v_ids) order by x.exception_id for update loop
    v_st := recipe.review_item_status(p_batch, r.exception_id);
    if v_st in ('ACCEPTED', 'ESCALATED') then
      raise exception using errcode = 'P0001', message = format('EBMR-REV-052 exception %s is already %s in review (DI-26)', r.exception_id, lower(v_st));
    end if;
    select * into v_disp from recipe.exception_register_act a where a.batch_id = p_batch and a.exception_id = r.exception_id and a.act = 'DISPOSITIONED';
    if p_disposition = 'QUERY' then
      if v_st = 'QUERIED' then
        raise exception using errcode = 'P0001', message = format('EBMR-REV-052 exception %s has an open query; it is answered before another is asked (DI-26)', r.exception_id);
      end if;
      continue;
    end if;
    -- ACCEPT and ESCALATE conclude the item: by a person outside its involvement (INV-03, DI-26).
    if recipe.exception_step_involvement(p_batch, st, r.exception_id, null) ? v_person::text or r.raised_by = v_person::text or v_disp.by_person = v_person then
      raise exception using errcode = 'P0001',
        message = format('EBMR-REV-053 this person raised, worked in the step of, or dispositioned exception %s, so they cannot conclude its review (INV-03, DI-26)', r.exception_id);
    end if;
    if p_disposition = 'ESCALATE' then
      v_prob := site.deviation_ref_problem(v_ref, 'LINK', p_batch);
      if v_prob is not null then
        raise exception using errcode = 'P0001', message = format('EBMR-REV-051 exception %s cannot be escalated to %s: %s (PR-49, PR-13)', r.exception_id, v_ref, v_prob);
      end if;
      continue;
    end if;
    if v_disp.id is null then
      raise exception using errcode = 'P0001',
        message = format('EBMR-REV-052 exception %s is not dispositioned; QA accepts an item only after its disposition, and a review never closes it (DI-26, INV-41)', r.exception_id);
    end if;
    if v_st = 'QUERIED' then
      raise exception using errcode = 'P0001', message = format('EBMR-REV-052 exception %s has an open query; it is answered before QA accepts it (DI-26)', r.exception_id);
    end if;
    if recipe.review_item_critical(r) then
      if cardinality(v_ids) > 1 then
        raise exception using errcode = 'P0001', message = format('EBMR-REV-054 exception %s is critical; a critical item is accepted on its own (PR-52, outline 7.3)', r.exception_id);
      end if;
      if v_text is null then
        raise exception using errcode = 'P0001', message = format('EBMR-REV-054 exception %s is critical; its acceptance carries a justification (PR-52)', r.exception_id);
      end if;
      if not exists (select 1 from recipe.review_item_view v where v.batch_id = p_batch and v.exception_id = r.exception_id and v.person_id = v_person) then
        raise exception using errcode = 'P0001', message = format('EBMR-REV-055 exception %s is critical; its detail is opened before it is accepted (PR-52, outline 7.3)', r.exception_id);
      end if;
    end if;
    if cardinality(v_ids) > 1 then
      if exists (select 1 from recipe.rbe_paused_step(p_batch) ps where ps = r.raising_step) then
        raise exception using errcode = 'P0001',
          message = format('EBMR-REV-056 exception %s is on step %s, whose review by exception is paused after three deviations; it is reviewed on its own (PR-07)', r.exception_id, r.raising_step);
      end if;
      v_refs := v_refs || (select a.deviation_ref from recipe.exception_register_act a where a.batch_id = p_batch and a.exception_id = r.exception_id and a.act = 'DEVIATION_LINKED');
    end if;
  end loop;
  if (select count(*) from recipe.exception_register x where x.batch_id = p_batch and x.exception_id = any (v_ids)) <> cardinality(v_ids) then
    raise exception using errcode = 'P0001', message = format('EBMR-REV-050 batch %s has no register item among %s (DI-26)', p_batch, array_to_string(v_ids, ', '));
  end if;
  if p_disposition = 'ACCEPT' and cardinality(v_ids) > 1 then
    if cardinality(v_refs) <> cardinality(v_ids) or exists (select 1 from unnest(v_refs) x where x is null) or (select count(distinct x) from unnest(v_refs) x) <> 1 then
      raise exception using errcode = 'P0001', message = 'EBMR-REV-057 items are accepted together only when they share one linked deviation (PR-52, outline 7.3)';
    end if;
    if v_shown is null or v_shown < v_last then
      raise exception using errcode = 'P0001', message = 'EBMR-REV-058 grouped acceptance follows the showing of the full list of register items to this person (PR-52, outline 7.3)';
    end if;
  end if;
  foreach v_st in array v_ids loop
    insert into recipe.exception_register_act (batch_id, exception_id, act, by_person, by_account, role_code, deviation_ref, note, correlation_id)
    values (p_batch, v_st, case p_disposition when 'ACCEPT' then 'ACCEPTED_BY_QA' when 'QUERY' then 'QUERIED' else 'ESCALATED' end,
            v_person, (v_actor ->> 'account_id')::uuid, v_actor ->> 'role_code', case when p_disposition = 'ESCALATE' then v_ref end, v_text,
            (v_actor ->> 'correlation_id')::uuid)
    returning id into v_act;
    insert into recipe.review_item_disposition (act_id, batch_id, exception_id, disposition, aggregate_id, signature_id, item_count, justification)
    values (v_act, p_batch, v_st, p_disposition, v_agg, p_signature, cardinality(v_ids), v_text);
  end loop;
  return cardinality(v_ids);
end
$$;

create function recipe.record_abort_checklist(p_batch uuid, p_checklist jsonb) returns void
language plpgsql volatile security definer set search_path = pg_catalog, recipe, pg_temp as $$
declare
  v_actor jsonb := recipe.review_actor(p_batch, 'RECORD.PRODUCTION_APPROVE');
  k       text;
begin
  perform 1 from recipe.execution_state s where s.batch_id = p_batch for update;
  if recipe.batch_review_state(p_batch) is distinct from 'ABORTED' then
    raise exception using errcode = 'P0001',
      message = format('EBMR-REV-060 the record is %s; the abort checklist belongs to an ABORTED record before its production approval (L-20)', recipe.batch_review_state(p_batch));
  end if;
  foreach k in array array['materialsAccounted', 'outputsDispositioned', 'equipmentDirty', 'genealogyClosed', 'contingencyReconciled'] loop
    if jsonb_typeof(p_checklist -> k) is distinct from 'string' or recipe.reason_is_blank(p_checklist ->> k) then
      raise exception using errcode = 'P0001', message = format('EBMR-REV-060 the abort checklist states %s in words (L-20)', k);
    end if;
  end loop;
  insert into recipe.abort_checklist (batch_id, materials_accounted, outputs_dispositioned, equipment_dirty, genealogy_closed, contingency_reconciled,
                                      person_id, account_id, role_code)
  values (p_batch, btrim(p_checklist ->> 'materialsAccounted'), btrim(p_checklist ->> 'outputsDispositioned'), btrim(p_checklist ->> 'equipmentDirty'),
          btrim(p_checklist ->> 'genealogyClosed'), btrim(p_checklist ->> 'contingencyReconciled'),
          (v_actor ->> 'person_id')::uuid, (v_actor ->> 'account_id')::uuid, v_actor ->> 'role_code');
exception when unique_violation then
  raise exception using errcode = 'P0001', message = 'EBMR-REV-060 the abort checklist of this record is recorded already (L-20)';
end
$$;

create function recipe.assert_translation_open(p_batch uuid) returns void
language plpgsql stable security definer set search_path = pg_catalog, recipe, pg_temp as $$
declare
  v_state text := recipe.batch_review_state(p_batch);
begin
  if v_state in ('PRODUCTION_APPROVED', 'QA_REVIEWED') then
    raise exception using errcode = 'P0001',
      message = format('EBMR-REV-061 the record is %s; translations are completed before the production approval (D-P4-12; reopen the review to change one)', v_state);
  end if;
end
$$;

create function recipe.record_translation(p_batch uuid, p_source_ref text, p_english text) returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, recipe, pg_temp as $$
declare
  v_actor jsonb := recipe.review_actor(p_batch, 'RECORD.READ');
  v_body  text;
  v_id    uuid;
begin
  perform 1 from recipe.execution_state s where s.batch_id = p_batch for update;
  perform recipe.assert_translation_open(p_batch);
  select f.body into v_body from recipe.batch_free_text(p_batch) f where f.source_ref = p_source_ref;
  if v_body is null then
    raise exception using errcode = 'P0001', message = format('EBMR-REV-062 the record holds no free text %s (D-P4-12)', coalesce(p_source_ref, 'NULL'));
  end if;
  if p_english is null or recipe.reason_is_blank(p_english) or recipe.text_needs_translation(p_english) then
    raise exception using errcode = 'P0001', message = 'EBMR-REV-062 a translation is English text in Latin script (D-P4-12)';
  end if;
  insert into recipe.free_text_translation (batch_id, source_ref, source_sha256, english, translated_by, translated_account)
  values (p_batch, p_source_ref, encode(sha256(convert_to(v_body, 'UTF8')), 'hex'), btrim(p_english), (v_actor ->> 'person_id')::uuid, (v_actor ->> 'account_id')::uuid)
  returning id into v_id;
  return v_id;
end
$$;

create function recipe.verify_translation(p_translation uuid) returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, recipe, pg_temp as $$
declare
  t       recipe.free_text_translation;
  v_actor jsonb;
  v_latest uuid;
begin
  select * into t from recipe.free_text_translation where id = p_translation;
  if not found then
    raise exception using errcode = 'P0001', message = format('EBMR-REV-063 there is no translation %s (D-P4-12)', coalesce(p_translation::text, 'NULL'));
  end if;
  v_actor := recipe.review_actor(t.batch_id, 'RECORD.READ');
  perform 1 from recipe.execution_state s where s.batch_id = t.batch_id for update;
  perform recipe.assert_translation_open(t.batch_id);
  select x.id into v_latest from recipe.latest_translation(t.batch_id, t.source_ref) x;
  if v_latest is distinct from t.id then
    raise exception using errcode = 'P0001', message = 'EBMR-REV-063 a newer translation of this text exists; verify that one (D-P4-12)';
  end if;
  if t.translated_by = (v_actor ->> 'person_id')::uuid then
    raise exception using errcode = 'P0001', message = 'EBMR-REV-064 a translation is verified by a second person, not by its translator (D-P4-12, outline 7.4)';
  end if;
  insert into recipe.free_text_translation_verification (translation_id, verified_by, verified_account)
  values (t.id, (v_actor ->> 'person_id')::uuid, (v_actor ->> 'account_id')::uuid);
  return t.id;
exception when unique_violation then
  raise exception using errcode = 'P0001', message = 'EBMR-REV-063 this translation is verified already (D-P4-12)';
end
$$;

revoke all on recipe.review_list_view, recipe.review_item_view, recipe.review_item_disposition, recipe.abort_checklist,
              recipe.free_text_translation, recipe.free_text_translation_verification from ebmr_app;
grant select on recipe.review_list_view, recipe.review_item_view, recipe.review_item_disposition, recipe.abort_checklist,
              recipe.free_text_translation, recipe.free_text_translation_verification to ebmr_app;

revoke all on function
  recipe.review_batch(uuid), recipe.review_item_critical(recipe.exception_register), recipe.review_item_status(uuid, text), recipe.text_needs_translation(text),
  recipe.batch_free_text(uuid), recipe.latest_translation(uuid, text), recipe.free_text_problems(uuid), recipe.audit_review_next_id(uuid),
  recipe.audit_review_last(uuid), recipe.audit_review_covered(uuid), recipe.batch_review_content(text), recipe.batch_audit_review_content(text),
  recipe.review_cycle_signatures(uuid, integer), recipe.batch_review_reopen_content(text), recipe.review_items_aggregate_id(uuid, text, text[], text, text),
  recipe.review_items_content(text), recipe.review_gate_problems(uuid, text), recipe.review_disposition_problem(uuid),
  recipe.assert_review_signature(uuid, text, text, text, uuid), recipe.review_actor(uuid, text), recipe.raise_review_problems(text, text, text[]),
  recipe.insert_review_act(jsonb, uuid, text, uuid, jsonb), recipe.record_production_approval(uuid, uuid), recipe.record_audit_trail_review(text, uuid),
  recipe.record_qa_review(uuid, uuid, bigint), recipe.reopen_review(uuid, uuid, text), recipe.show_review_register(uuid), recipe.open_review_item(uuid, text),
  recipe.dispose_review_items(uuid, text[], text, text, text, uuid), recipe.record_abort_checklist(uuid, jsonb), recipe.assert_translation_open(uuid),
  recipe.record_translation(uuid, text, text), recipe.verify_translation(uuid)
from public;

grant execute on function
  recipe.review_item_critical(recipe.exception_register), recipe.review_item_status(uuid, text), recipe.text_needs_translation(text),
  recipe.batch_free_text(uuid), recipe.latest_translation(uuid, text), recipe.free_text_problems(uuid), recipe.audit_review_next_id(uuid),
  recipe.audit_review_covered(uuid), recipe.review_items_aggregate_id(uuid, text, text[], text, text), recipe.review_gate_problems(uuid, text),
  recipe.review_disposition_problem(uuid), recipe.record_production_approval(uuid, uuid), recipe.record_audit_trail_review(text, uuid),
  recipe.record_qa_review(uuid, uuid, bigint), recipe.reopen_review(uuid, uuid, text), recipe.show_review_register(uuid), recipe.open_review_item(uuid, text),
  recipe.dispose_review_items(uuid, text[], text, text, text, uuid), recipe.record_abort_checklist(uuid, jsonb), recipe.record_translation(uuid, text, text),
  recipe.verify_translation(uuid)
to ebmr_app;

reset role;
