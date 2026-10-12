-- The full deviation stand-in, its records (Phase 4 slice 2a; docs/build-plan/phase-4/phase-4-plan.md, D-P4-2; outline
-- 5.2.5; controls IN-02, PR-49, PR-50, PR-51; invariant INV-46). Deviation-lite (0730, 0753) is extended in place: new
-- insert-only tables beside its own, the state function re-created from 0730, the content provider re-created so the
-- signatures cover the new rows. The commands are 0821, release blocking 0822.
--
--   deviation_classification   QA's classification when the investigation starts (MINOR | MAJOR | CRITICAL) with the
--                              risk rationale (IN-02), the investigation's owner and due date; a later row reclassifies
--                              (registered signed table: it supersedes every signature given before it).
--   deviation_impact           the impact on one linked subject for one market (IN, US, EU): NONE | POTENTIAL |
--                              CONFIRMED with the rationale; the latest row per link and market counts (signed table).
--   deviation_impact_signoff   QA's DEVIATION_IMPACT_ASSESSED signature over the impact rows up to covers_seq.
--   deviation_closure_basis    what PENDING_CLOSURE needs besides the finding (0730): the root-cause method, the
--                              system-factor assessment of a human error, the CAPA references or why none, the
--                              regulatory-notification assessment (with the licensing-authority reference when a
--                              notification is required) and the non-empty list of other batches and products assessed
--                              with the reason each is included or excluded (signed table; the latest counts).
--   deviation_conclusion_basis the classification, impact sign-off and closure basis a conclusion concluded.
--
-- States (site.deviation_state, re-created; derived from the rows, never stored):
--   OPEN -> UNDER_INVESTIGATION (QA classification) -> IMPACT_ASSESSED (every link assessed for IN at least, signed) ->
--   PENDING_CLOSURE (the conclusion; deviation-lite's CONCLUDED reads as PENDING_CLOSURE, D-P4-2) -> CLOSED;
--   OPEN -> CANCELLED. IMPACT_ASSESSED holds while the latest sign-off covers every impact row and every link: a new link
--   or a new impact row takes the record back to UNDER_INVESTIGATION until QA signs again.
--
-- One sequence (site.deviation_seq) orders impact rows and sign-offs, so coverage never depends on clock ties.
-- Messages: EBMR-SITE-820 to 849 (this slice).

set local role ebmr_owner;

create sequence site.deviation_seq;
revoke all on sequence site.deviation_seq from public;

create table site.deviation_classification (
  id                    uuid primary key default gen_random_uuid(),
  deviation_id          uuid not null references site.deviation (id),
  seq                   bigint not null default nextval('site.deviation_seq') unique,
  classification        text not null check (classification in ('MINOR', 'MAJOR', 'CRITICAL')),
  risk_rationale        text not null check (length(btrim(risk_rationale)) >= 10),
  risk_document_id      uuid references site.evidence_document (id),
  owner_person          uuid not null,
  due_date              date not null,
  classified_by_person  uuid not null,
  classified_by_account uuid not null,
  classified_at         timestamptz not null default clock_timestamp()
);
create index deviation_classification_dev on site.deviation_classification (deviation_id, seq);
revoke all on site.deviation_classification from public;

create table site.deviation_impact (
  id                  uuid primary key default gen_random_uuid(),
  deviation_id        uuid not null references site.deviation (id),
  seq                 bigint not null default nextval('site.deviation_seq') unique,
  link_id             uuid not null references site.deviation_link (id),
  market              text not null check (market in ('IN', 'US', 'EU')),
  impact              text not null check (impact in ('NONE', 'POTENTIAL', 'CONFIRMED')),
  rationale           text not null check (length(btrim(rationale)) >= 10),
  recorded_by_person  uuid not null,
  recorded_by_account uuid not null,
  recorded_at         timestamptz not null default clock_timestamp()
);
create index deviation_impact_dev on site.deviation_impact (deviation_id, seq);
create index deviation_impact_link on site.deviation_impact (link_id, market, seq);
revoke all on site.deviation_impact from public;

create table site.deviation_impact_signoff (
  id             uuid primary key default gen_random_uuid(),
  deviation_id   uuid not null references site.deviation (id),
  seq            bigint not null default nextval('site.deviation_seq') unique,
  covers_seq     bigint not null check (covers_seq >= 0),
  signature_id   uuid not null unique,
  person_id      uuid not null,
  account_id     uuid not null,
  signed_at      timestamptz not null default clock_timestamp()
);
create index deviation_impact_signoff_dev on site.deviation_impact_signoff (deviation_id, seq);
revoke all on site.deviation_impact_signoff from public;

create table site.deviation_closure_basis (
  id                       uuid primary key default gen_random_uuid(),
  deviation_id             uuid not null references site.deviation (id),
  seq                      bigint not null default nextval('site.deviation_seq') unique,
  root_cause_method        text check (root_cause_method is null or length(btrim(root_cause_method)) >= 3),
  system_factors           jsonb check (system_factors is null or jsonb_typeof(system_factors) = 'object'),
  capa_refs                text[] not null default '{}' check (array_position(capa_refs, null) is null),
  no_capa_reason           text check (no_capa_reason is null or length(btrim(no_capa_reason)) >= 10),
  notification_required    boolean not null,
  notification_rationale   text not null check (length(btrim(notification_rationale)) >= 10),
  authority_reference      text check (authority_reference is null or btrim(authority_reference) <> ''),
  other_batches            jsonb not null check (jsonb_typeof(other_batches) = 'array' and jsonb_array_length(other_batches) >= 1),
  recorded_by_person       uuid not null,
  recorded_by_account      uuid not null,
  recorded_at              timestamptz not null default clock_timestamp(),
  check (cardinality(capa_refs) >= 1 or no_capa_reason is not null),
  check (not notification_required or authority_reference is not null)
);
create index deviation_closure_basis_dev on site.deviation_closure_basis (deviation_id, seq);
revoke all on site.deviation_closure_basis from public;

create table site.deviation_conclusion_basis (
  deviation_id       uuid primary key references site.deviation_conclusion (deviation_id),
  classification_id  uuid not null references site.deviation_classification (id),
  impact_signoff_id  uuid not null references site.deviation_impact_signoff (id),
  closure_basis_id   uuid not null references site.deviation_closure_basis (id)
);
revoke all on site.deviation_conclusion_basis from public;

select platform.enforce_db_time('site.deviation_classification', array['classified_at']);
select platform.enforce_db_time('site.deviation_impact', array['recorded_at']);
select platform.enforce_db_time('site.deviation_impact_signoff', array['signed_at']);
select platform.enforce_db_time('site.deviation_closure_basis', array['recorded_at']);

select kernel.register_audited_table('site.deviation_classification', 'deviation', 'deviation_id', true);
select kernel.register_audited_table('site.deviation_impact', 'deviation', 'deviation_id', true);
select kernel.register_audited_table('site.deviation_impact_signoff', 'deviation', 'deviation_id', true);
select kernel.register_audited_table('site.deviation_closure_basis', 'deviation', 'deviation_id', true);
select kernel.register_audited_table('site.deviation_conclusion_basis', 'deviation', 'deviation_id', true);

select esig.register_signed_table('site.deviation_classification', 'deviation', 'deviation_id');
select esig.register_signed_table('site.deviation_impact', 'deviation', 'deviation_id');
select esig.register_signed_table('site.deviation_closure_basis', 'deviation', 'deviation_id');

-- ---------------------------------------------------------------------------------------------
-- Reading a record
-- ---------------------------------------------------------------------------------------------

create function site.deviation_latest_classification(p_id uuid) returns site.deviation_classification
language sql stable security definer set search_path = pg_catalog, site, pg_temp as $$
  select c.* from site.deviation_classification c where c.deviation_id = p_id order by c.seq desc limit 1
$$;

create function site.deviation_latest_closure_basis(p_id uuid) returns site.deviation_closure_basis
language sql stable security definer set search_path = pg_catalog, site, pg_temp as $$
  select b.* from site.deviation_closure_basis b where b.deviation_id = p_id order by b.seq desc limit 1
$$;

-- The investigation's owner (NULL before QA classified the record).
create function site.deviation_owner(p_id uuid) returns uuid
language sql stable security definer set search_path = pg_catalog, site, pg_temp as $$
  select (site.deviation_latest_classification(p_id)).owner_person
$$;

-- The latest impact row of a link for a market (NULL when none).
create function site.deviation_latest_impact(p_link uuid, p_market text) returns site.deviation_impact
language sql stable security definer set search_path = pg_catalog, site, pg_temp as $$
  select i.* from site.deviation_impact i where i.link_id = p_link and i.market = p_market order by i.seq desc limit 1
$$;

-- The impact assessment is current: QA's latest sign-off covers every impact row of the record, and every link has an
-- impact row for IN (India always applies) within that sign-off.
create function site.deviation_impact_current(p_id uuid) returns boolean
language sql stable security definer set search_path = pg_catalog, site, pg_temp as $$
  select coalesce((
    select not exists (select 1 from site.deviation_impact i where i.deviation_id = p_id and i.seq > s.covers_seq)
       and not exists (select 1 from site.deviation_link l
                        where l.deviation_id = p_id
                          and not exists (select 1 from site.deviation_impact i where i.link_id = l.id and i.market = 'IN' and i.seq <= s.covers_seq))
      from site.deviation_impact_signoff s where s.deviation_id = p_id order by s.seq desc limit 1), false)
$$;

-- As 0730; IMPACT_ASSESSED between UNDER_INVESTIGATION and the conclusion, which now reads PENDING_CLOSURE (D-P4-2).
create or replace function site.deviation_state(p_id uuid) returns text
language sql stable security definer set search_path = pg_catalog, site, pg_temp as $$
  select case
    when exists (select 1 from site.deviation_event e where e.deviation_id = d.id and e.event = 'CANCELLED') then 'CANCELLED'
    when exists (select 1 from site.deviation_event e where e.deviation_id = d.id and e.event = 'CLOSED') then 'CLOSED'
    when exists (select 1 from site.deviation_conclusion c where c.deviation_id = d.id) then 'PENDING_CLOSURE'
    when not exists (select 1 from site.deviation_event e where e.deviation_id = d.id and e.event = 'INVESTIGATION_STARTED') then 'OPEN'
    when site.deviation_impact_current(d.id) then 'IMPACT_ASSESSED'
    else 'UNDER_INVESTIGATION' end
  from site.deviation d where d.id = p_id
$$;

-- As 0730; the signatures also cover the classification, the impact rows and sign-offs and the closure basis, and the
-- people who recorded a closure basis are performers (they neither conclude nor close).
create or replace function site.deviation_content(p_id text) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, site, pg_temp as $$
declare
  d  site.deviation;
  f  site.deviation_finding;
  k  site.deviation_classification;
  b  site.deviation_closure_basis;
begin
  if coalesce(p_id, '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return '{"exists": false}'::jsonb;
  end if;
  select * into d from site.deviation where id = p_id::uuid;
  if not found then
    return '{"exists": false}'::jsonb;
  end if;
  f := site.deviation_latest_finding(d.id);
  k := site.deviation_latest_classification(d.id);
  b := site.deviation_latest_closure_basis(d.id);
  return jsonb_build_object(
    'exists', true,
    'content_version', 1 + (select count(*) from site.deviation_link l where l.deviation_id = d.id)
                         + (select count(*) from site.deviation_event e where e.deviation_id = d.id)
                         + (select count(*) from site.deviation_finding x where x.deviation_id = d.id)
                         + (select count(*) from site.deviation_conclusion c where c.deviation_id = d.id)
                         + (select count(*) from site.deviation_classification x where x.deviation_id = d.id)
                         + (select count(*) from site.deviation_impact x where x.deviation_id = d.id)
                         + (select count(*) from site.deviation_impact_signoff x where x.deviation_id = d.id)
                         + (select count(*) from site.deviation_closure_basis x where x.deviation_id = d.id),
    'content', jsonb_build_object(
      'ref', d.ref, 'site_code', d.site_code, 'kind', d.kind, 'title', d.title, 'description', d.description,
      'classification', d.classification, 'risk_rationale', d.risk_rationale, 'raised_by', d.raised_by_person,
      'raised_at', site.utc_text(d.raised_at),
      'links', (select coalesce(jsonb_agg(jsonb_build_object('link_id', l.id, 'subject_kind', l.subject_kind, 'subject_id', l.subject_id, 'subject_ref', l.subject_ref,
                                                             'batch_number', l.batch_number, 'edition', l.edition)
                                          order by l.linked_at, l.id), '[]'::jsonb)
                from site.deviation_link l where l.deviation_id = d.id),
      'events', (select coalesce(jsonb_agg(jsonb_build_object('event', e.event, 'reason', e.reason, 'by', e.person_id) order by e.recorded_at, e.id), '[]'::jsonb)
                 from site.deviation_event e where e.deviation_id = d.id),
      'qa_classification', case when k.id is null then null
                                else jsonb_build_object('id', k.id, 'classification', k.classification, 'risk_rationale', k.risk_rationale,
                                                        'risk_document_id', k.risk_document_id, 'owner', k.owner_person, 'due_date', k.due_date::text,
                                                        'by', k.classified_by_person) end,
      'impacts', (select coalesce(jsonb_agg(jsonb_build_object('link_id', i.link_id, 'market', i.market, 'impact', i.impact, 'rationale', i.rationale,
                                                               'by', i.recorded_by_person) order by i.seq), '[]'::jsonb)
                  from site.deviation_impact i where i.deviation_id = d.id),
      'impact_signoffs', (select coalesce(jsonb_agg(jsonb_build_object('covers', s.covers_seq, 'by', s.person_id) order by s.seq), '[]'::jsonb)
                          from site.deviation_impact_signoff s where s.deviation_id = d.id),
      'finding', case when f.id is null then null
                      else jsonb_build_object('id', f.id, 'assignable_cause', f.assignable_cause, 'cause', f.cause,
                                              'root_cause_category', f.root_cause_category, 'recorded_by', f.recorded_by_person) end,
      'closure_basis', case when b.id is null then null
                            else jsonb_build_object('id', b.id, 'root_cause_method', b.root_cause_method, 'system_factors', b.system_factors,
                                                    'capa_refs', to_jsonb(b.capa_refs), 'no_capa_reason', b.no_capa_reason,
                                                    'notification_required', b.notification_required, 'notification_rationale', b.notification_rationale,
                                                    'authority_reference', b.authority_reference, 'other_batches', b.other_batches,
                                                    'recorded_by', b.recorded_by_person) end,
      'conclusion', (select jsonb_build_object('finding_id', c.finding_id, 'assignable_cause', c.assignable_cause, 'cause', c.cause,
                                               'root_cause_category', c.root_cause_category, 'concluded_by', c.concluded_by_person)
                     from site.deviation_conclusion c where c.deviation_id = d.id)),
    'state', site.deviation_state(d.id),
    'scope', jsonb_build_object('site', d.site_code),
    'entered_by', (select to_jsonb(array_agg(distinct p)) from (
                     select d.raised_by_person as p
                     union all select x.recorded_by_person from site.deviation_finding x where x.deviation_id = d.id
                     union all select x.recorded_by_person from site.deviation_closure_basis x where x.deviation_id = d.id) y));
end
$$;

-- ---------------------------------------------------------------------------------------------
-- Evidence epochs (Phase 4 slice 1): the batch side keeps one version token per subject (recipe.bump_epoch, recipe-core
-- 0710), bumped by its triggers on the deviation-lite tables (0714). Site services is applied before recipe-core and
-- never names its functions at creation, so the new tables bump through this hook, which looks the token writer up when
-- it runs and does nothing on an installation without it.
-- ---------------------------------------------------------------------------------------------

create function site.deviation_epoch_hook() returns trigger
language plpgsql security definer set search_path = pg_catalog, site, pg_temp as $$
declare
  v_id uuid := (to_jsonb(new) ->> 'deviation_id')::uuid;
  r    record;
begin
  if to_regprocedure('recipe.bump_epoch(text, uuid)') is null then
    return null;
  end if;
  execute 'select recipe.bump_epoch($1, $2)' using 'DEVIATION', v_id;
  for r in select distinct x.kind, x.id from (
             select l.subject_kind as kind, l.subject_id as id from site.deviation_link l where l.deviation_id = v_id
             union select 'BATCH', l.batch_id from site.deviation_link l where l.deviation_id = v_id and l.batch_id is not null) x
           order by 1, 2 loop
    execute 'select recipe.bump_epoch($1, $2)' using r.kind, r.id;
  end loop;
  return null;
end
$$;
revoke all on function site.deviation_epoch_hook() from public;

create trigger zzze_epoch_deviation_classification after insert on site.deviation_classification for each row execute function site.deviation_epoch_hook();
create trigger zzze_epoch_deviation_impact after insert on site.deviation_impact for each row execute function site.deviation_epoch_hook();
create trigger zzze_epoch_deviation_impact_signoff after insert on site.deviation_impact_signoff for each row execute function site.deviation_epoch_hook();
create trigger zzze_epoch_deviation_closure_basis after insert on site.deviation_closure_basis for each row execute function site.deviation_epoch_hook();

-- ---------------------------------------------------------------------------------------------
-- Permissions and the signature meaning (DI-17, DI-35)
-- ---------------------------------------------------------------------------------------------

select kernel.set_actor_context(jsonb_build_object(
  'person_id', '00000000-0000-0000-0000-000000000000', 'account_id', '00000000-0000-0000-0000-000000000000',
  'role_code', 'SOFTWARE_RELEASE', 'session_id', '00000000-0000-0000-0000-000000000000', 'source', 'SYSTEM',
  'site_zone', 'UTC', 'correlation_id', gen_random_uuid(),
  'legal_name', 'Software release (site-services migration 0820_deviation_full_records)',
  'reason_code', 'SOFTWARE_RELEASE',
  'reason_text', 'full deviation stand-in: QA classification and the impact assessment (IN-02, PR-49, PR-50; Phase 4 D-P4-2)'));

insert into iam.permission (code, domain, effect, description) values
  ('DEVIATION.CLASSIFY', 'GMP', 'WRITE', 'QA classification of a deviation record with its risk rationale, owner and due date (never by its initiator)');

insert into iam.role_permission (role_code, permission_code) values
  ('QA_SHOP_FLOOR', 'DEVIATION.CLASSIFY'),
  ('QA_REVIEWER', 'DEVIATION.CLASSIFY'),
  ('AUTHORISED_PERSON', 'DEVIATION.CLASSIFY');

insert into esig.meaning_type (code, version, origin, is_minimum, status, category, role_class, title, meaning_text, permissions,
                               independent_of, excludes_performers, excludes_involved, witness, reauth, delegable, sources)
values
  ('DEVIATION_IMPACT_ASSESSED', 1, 'VENDOR', true, 'ACTIVE', 'EXCEPTION', 'APPROVER', 'Deviation impact assessed by QA',
   'Quality-unit impact assessment: I approve the impact recorded for each linked lot and market (none, potential or confirmed) with its rationale.',
   array['DEVIATION.QA_APPROVE'], '{}', false, false, false, 'ALL_COMPONENTS', false, 'Outline 5.2.5; PR-49, PR-50; INV-46; outline 7.2 S7');

select kernel.set_actor_context(null);

revoke all on site.deviation_classification, site.deviation_impact, site.deviation_impact_signoff, site.deviation_closure_basis,
              site.deviation_conclusion_basis from ebmr_app;
grant select on site.deviation_classification, site.deviation_impact, site.deviation_impact_signoff, site.deviation_closure_basis,
                site.deviation_conclusion_basis to ebmr_app;
revoke all on function site.deviation_latest_classification(uuid), site.deviation_latest_closure_basis(uuid), site.deviation_owner(uuid),
                       site.deviation_latest_impact(uuid, text), site.deviation_impact_current(uuid) from public;
grant execute on function site.deviation_owner(uuid), site.deviation_impact_current(uuid) to ebmr_app;

reset role;
