-- Recipe core: the penicillin facility rule and the beta-lactam classification take effect only with QA's approval
-- (Phase 7 slice 7a, item 6jc-R10; control PR-27; decision 0022). Until now one master-data steward (MASTERDATA.CHANGE)
-- could declare a site a penicillin facility, or declassify a penicillin material, alone, and the latest version won.
-- Same pattern as the hazard classification and the area dedication (recipe-core 0912).
--
-- Handbook: modules/recipe-core.md
--
--   plant.set_facility_rule, plant.classify_beta_lactam (0973, unchanged): a new version is now a PROPOSAL by the steward.
--   plant.facility_rule.id, plant.beta_lactam_class.id   a uuid per version, the subject of its approval signature.
--   plant.facility_rule_approval, plant.beta_lactam_class_approval   insert-only, audited: QA's QA_APPROVED signature over
--       one version, never by its proposer (the meaning excludes performers; the command checks it too). Only the latest
--       version of a site (or of a material or product) is approved, once; an older one is SUPERSEDED.
--
-- In force (the stricter rule wins, as in 0912: an unapproved proposal can only add a restriction, never lift one):
--   What the rule does (0973, plant.penicillin_problem): a beta-lactam material or product is refused at a site that is
--   not a penicillin facility. So "beta-lactam = true" and "penicillin facility = false" TIGHTEN (they refuse more);
--   "beta-lactam = false" and "penicillin facility = true" LOOSEN (they let a beta-lactam in).
--   plant.classified_beta_lactam(kind, code)   re-created from 0973: the latest approved version says beta-lactam, or any
--       version after it does (a tightening counts at once, approved or not, superseded or not: a restriction is lifted
--       only by an approved loosening); false without either.
--   plant.penicillin_facility(site)   the latest approved version says penicillin facility and no version after it says
--       not (a pending loosening counts only once approved; a pending tightening at once); false without an approved one.
--   plant.penicillin_problem   re-created from 0973: reads plant.penicillin_facility. It and classified_beta_lactam serve
--       the room start, plant.batch_beta_lactam and the receipt guard.
--   plant.facility_rule_in_force, plant.beta_lactam_class_in_force (views): per subject the value in force, the approved
--       version and whether a later proposal is pending QA's approval.
--   Commands (never an administrator, the permission first): plant.approve_facility_rule(id, signature) and
--       plant.approve_beta_lactam_class(id, signature), PLANT_RULE.APPROVE (QA MBR approver, QA reviewer). Signed
--       aggregates facility_rule <id> and beta_lactam_class <id>, state PROPOSED (APPROVED or SUPERSEDED after).
--   Upgrade: every version recorded before this migration is an unapproved proposal, so the readers above keep each
--       restriction in force (a beta-lactam classification, a site that is not a penicillin facility) and hold back
--       each loosening (a declassification, a penicillin facility declared) until QA approves the latest version.
-- Messages: EBMR-PLANT-173 to 176.

set local role ebmr_owner;

select kernel.set_actor_context(jsonb_build_object(
  'person_id', '00000000-0000-0000-0000-000000000000', 'account_id', '00000000-0000-0000-0000-000000000000',
  'role_code', 'SOFTWARE_RELEASE', 'session_id', '00000000-0000-0000-0000-000000000000', 'source', 'SYSTEM',
  'site_zone', 'UTC', 'correlation_id', gen_random_uuid(),
  'legal_name', 'Software release (recipe-core migration 1210_plant_rule_qa_approval)',
  'reason_code', 'SOFTWARE_RELEASE',
  'reason_text', 'the penicillin facility rule and the beta-lactam classification take effect only with QA approval (PR-27, 6jc-R10)'));

insert into iam.permission (code, domain, effect, description) values
  ('PLANT_RULE.APPROVE', 'GMP', 'SIGN', 'Approve a penicillin facility rule or a beta-lactam classification proposed by another person (PR-27)');
insert into iam.role_permission (role_code, permission_code) values ('QA_MBR_APPROVER', 'PLANT_RULE.APPROVE'), ('QA_REVIEWER', 'PLANT_RULE.APPROVE');

insert into esig.meaning_type (code, version, origin, is_minimum, status, category, role_class, title, meaning_text, permissions,
                               independent_of, excludes_performers, excludes_involved, witness, reauth, delegable, sources)
values
  ('QA_APPROVED', 1, 'VENDOR', true, 'ACTIVE', 'MASTER_RECORD', 'APPROVER', 'Quality-unit approved',
   'Quality-unit approval: I approve this plant rule as shown (whether the site is a penicillin facility, or whether the material or product is beta-lactam) to take effect.',
   array['PLANT_RULE.APPROVE'], '{}', true, false, false, 'ALL_COMPONENTS', false, 'PR-27; Schedule M segregation of penicillin and beta-lactam manufacture');

-- The versions recorded before this migration get their id here; every later version gets one on insert.
alter table plant.facility_rule add column id uuid not null default gen_random_uuid();
alter table plant.facility_rule add constraint facility_rule_id_key unique (id);
alter table plant.beta_lactam_class add column id uuid not null default gen_random_uuid();
alter table plant.beta_lactam_class add constraint beta_lactam_class_id_key unique (id);

create table plant.facility_rule_approval (
  rule_id              uuid primary key references plant.facility_rule (id),
  signature_id         uuid not null unique,
  approved_by_person   uuid not null,
  approved_by_account  uuid not null,
  approved_at          timestamptz not null default clock_timestamp()
);
create table plant.beta_lactam_class_approval (
  class_id             uuid primary key references plant.beta_lactam_class (id),
  signature_id         uuid not null unique,
  approved_by_person   uuid not null,
  approved_by_account  uuid not null,
  approved_at          timestamptz not null default clock_timestamp()
);
revoke all on plant.facility_rule_approval, plant.beta_lactam_class_approval from public;
grant select on plant.facility_rule_approval, plant.beta_lactam_class_approval to ebmr_app;
select platform.enforce_db_time('plant.facility_rule_approval', array['approved_at']);
select platform.enforce_db_time('plant.beta_lactam_class_approval', array['approved_at']);
select kernel.register_audited_table('plant.facility_rule_approval', 'facility_rule', 'rule_id', true);
select kernel.register_audited_table('plant.beta_lactam_class_approval', 'beta_lactam_class', 'class_id', true);
create trigger zz_immutable before update or delete on plant.facility_rule_approval for each row execute function site.india_record_immutable();
create trigger zz_immutable before update or delete on plant.beta_lactam_class_approval for each row execute function site.india_record_immutable();

select kernel.set_actor_context(null);

-- ---------------------------------------------------------------------------------------------
-- In force: the latest approved version
-- ---------------------------------------------------------------------------------------------

-- The latest approved version of a subject (none: NULL row).
create function plant.facility_rule_approved(p_site text) returns plant.facility_rule
language sql stable security definer set search_path = pg_catalog, plant, pg_temp as $$
  select f.* from plant.facility_rule f join plant.facility_rule_approval a on a.rule_id = f.id
   where f.site_code = p_site order by f.version desc limit 1
$$;

create function plant.beta_lactam_class_approved(p_kind text, p_code text) returns plant.beta_lactam_class
language sql stable security definer set search_path = pg_catalog, plant, pg_temp as $$
  select c.* from plant.beta_lactam_class c join plant.beta_lactam_class_approval a on a.class_id = c.id
   where c.subject_kind = p_kind and c.code = p_code order by c.version desc limit 1
$$;

-- In force: the approved site is a penicillin facility and no later version says it is not (a tightening counts at once,
-- a loosening only once approved). A site without an approved rule is not a penicillin facility.
create function plant.penicillin_facility(p_site text) returns boolean
language sql stable security definer set search_path = pg_catalog, plant, pg_temp as $$
  with a as (select (plant.facility_rule_approved(p_site)).*)
  select coalesce((select a.penicillin_facility from a), false)
     and not exists (select 1 from plant.facility_rule f where f.site_code = p_site and not f.penicillin_facility
                        and f.version > (select a.version from a))
$$;

-- Re-created from 0973: in force, (kind, code) is beta-lactam when its latest approved version says so or any version
-- after that one does (pending or superseded: only an approved loosening lifts the restriction); false without either.
create or replace function plant.classified_beta_lactam(p_kind text, p_code text) returns boolean
language sql stable security definer set search_path = pg_catalog, plant, pg_temp as $$
  with a as (select (plant.beta_lactam_class_approved(p_kind, p_code)).*)
  select coalesce((select a.beta_lactam from a), false)
      or exists (select 1 from plant.beta_lactam_class c where c.subject_kind = p_kind and c.code = p_code and c.beta_lactam
                    and c.version > coalesce((select a.version from a), 0))
$$;

-- Re-created from 0973: PR-27: null unless a beta-lactam subject would enter site p_site, which is not a penicillin
-- facility in force (plant.penicillin_facility).
create or replace function plant.penicillin_problem(p_site text, p_kind text, p_code text, p_beta_lactam boolean) returns text
language sql stable security definer set search_path = pg_catalog, plant, pg_temp as $$
  select case when p_beta_lactam and not plant.penicillin_facility(p_site)
         then format('EBMR-PLANT-170 %s %s is beta-lactam (penicillin) and site %s is not a penicillin facility: it is not received or processed there (PR-27)',
                     lower(p_kind), p_code, coalesce(p_site, 'NULL'))
         end
$$;

-- Per subject: the value in force, the approved version (null: none) and whether a later version waits for QA.
create view plant.facility_rule_in_force as
  select s.site_code, plant.penicillin_facility(s.site_code) as penicillin_facility, (plant.facility_rule_approved(s.site_code)).version as approved_version,
         s.latest > coalesce((plant.facility_rule_approved(s.site_code)).version, 0) as pending
    from (select site_code, max(version) as latest from plant.facility_rule group by site_code) s;

create view plant.beta_lactam_class_in_force as
  select s.subject_kind, s.code, plant.classified_beta_lactam(s.subject_kind, s.code) as beta_lactam,
         (plant.beta_lactam_class_approved(s.subject_kind, s.code)).version as approved_version,
         s.latest > coalesce((plant.beta_lactam_class_approved(s.subject_kind, s.code)).version, 0) as pending
    from (select subject_kind, code, max(version) as latest from plant.beta_lactam_class group by subject_kind, code) s;

-- ---------------------------------------------------------------------------------------------
-- Signed content
-- ---------------------------------------------------------------------------------------------

create function plant.facility_rule_state(p_rule uuid) returns text
language sql stable security definer set search_path = pg_catalog, plant, pg_temp as $$
  select case when exists (select 1 from plant.facility_rule_approval a where a.rule_id = f.id) then 'APPROVED'
              when exists (select 1 from plant.facility_rule l where l.site_code = f.site_code and l.version > f.version) then 'SUPERSEDED'
              else 'PROPOSED' end
    from plant.facility_rule f where f.id = p_rule
$$;

create function plant.beta_lactam_class_state(p_class uuid) returns text
language sql stable security definer set search_path = pg_catalog, plant, pg_temp as $$
  select case when exists (select 1 from plant.beta_lactam_class_approval a where a.class_id = c.id) then 'APPROVED'
              when exists (select 1 from plant.beta_lactam_class l where l.subject_kind = c.subject_kind and l.code = c.code and l.version > c.version) then 'SUPERSEDED'
              else 'PROPOSED' end
    from plant.beta_lactam_class c where c.id = p_class
$$;

-- The content a QA person signs: the proposal, the value approved before it (the latest approved version older than this
-- one) and whether it tightens or loosens that. Both are fixed once this version exists (an older version is approved only
-- while it is the latest), so the signed content never changes.
create function plant.facility_rule_content(p_id text) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, plant, site, pg_temp as $$
declare
  f      plant.facility_rule;
  v_prev boolean;
begin
  if coalesce(p_id, '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return '{"exists": false}'::jsonb;
  end if;
  select * into f from plant.facility_rule where id = p_id::uuid;
  if f.id is null then
    return '{"exists": false}'::jsonb;
  end if;
  v_prev := (select p.penicillin_facility from plant.facility_rule p join plant.facility_rule_approval a on a.rule_id = p.id
              where p.site_code = f.site_code and p.version < f.version order by p.version desc limit 1);
  return jsonb_build_object('exists', true, 'content_version', 1,
    'content', jsonb_build_object('site_code', f.site_code, 'version', f.version, 'penicillin_facility', f.penicillin_facility,
                                  'justification', f.justification, 'penicillin_facility_approved_before', coalesce(v_prev, false),
                                  'effect', case when f.penicillin_facility and not coalesce(v_prev, false) then 'LOOSENS'
                                                 when not f.penicillin_facility and coalesce(v_prev, false) then 'TIGHTENS' else 'UNCHANGED' end,
                                  'proposed_by', f.recorded_by_person, 'proposed_at', site.utc_text(f.recorded_at)),
    'state', plant.facility_rule_state(f.id),
    'scope', jsonb_build_object('site', f.site_code),
    'entered_by', jsonb_build_array(f.recorded_by_person));
end
$$;

create function plant.beta_lactam_class_content(p_id text) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, plant, site, pg_temp as $$
declare
  c      plant.beta_lactam_class;
  v_prev boolean;
begin
  if coalesce(p_id, '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return '{"exists": false}'::jsonb;
  end if;
  select * into c from plant.beta_lactam_class where id = p_id::uuid;
  if c.id is null then
    return '{"exists": false}'::jsonb;
  end if;
  v_prev := (select p.beta_lactam from plant.beta_lactam_class p join plant.beta_lactam_class_approval a on a.class_id = p.id
              where p.subject_kind = c.subject_kind and p.code = c.code and p.version < c.version order by p.version desc limit 1);
  return jsonb_build_object('exists', true, 'content_version', 1,
    'content', jsonb_build_object('subject_kind', c.subject_kind, 'code', c.code, 'version', c.version, 'beta_lactam', c.beta_lactam,
                                  'reason', c.reason, 'beta_lactam_approved_before', coalesce(v_prev, false),
                                  'effect', case when c.beta_lactam and not coalesce(v_prev, false) then 'TIGHTENS'
                                                 when not c.beta_lactam and coalesce(v_prev, false) then 'LOOSENS' else 'UNCHANGED' end,
                                  'proposed_by', c.recorded_by_person, 'proposed_at', site.utc_text(c.recorded_at)),
    'state', plant.beta_lactam_class_state(c.id),
    'scope', case when c.subject_kind = 'PRODUCT' then jsonb_build_object('product', c.code) else '{}'::jsonb end,
    'entered_by', jsonb_build_array(c.recorded_by_person));
end
$$;

select esig.register_content_provider('facility_rule', 'plant.facility_rule_content(text)',
  'A site''s penicillin facility rule as proposed by the master-data steward, in force once QA approves it (PR-27)');
select esig.register_content_provider('beta_lactam_class', 'plant.beta_lactam_class_content(text)',
  'A material''s or product''s beta-lactam classification as proposed by the master-data steward, in force once QA approves it (PR-27)');

-- ---------------------------------------------------------------------------------------------
-- Commands
-- ---------------------------------------------------------------------------------------------

-- The approver's own valid QA_APPROVED signature on the version, in its current state; never the proposer.
create function plant.assert_plant_rule_approval(p_signature uuid, p_type text, p_id uuid, p_proposer uuid, p_actor jsonb) returns void
language plpgsql volatile security definer set search_path = pg_catalog, plant, esig, pg_temp as $$
declare
  v_prob text;
begin
  if p_proposer::text = p_actor ->> 'person_id' then
    raise exception using errcode = 'P0001', message = 'EBMR-PLANT-175 a penicillin facility rule or a beta-lactam classification is approved by another person than its proposer (PR-27, DI-35)';
  end if;
  perform esig.assert_signature(p_signature, 'QA_APPROVED', p_type, p_id::text);
  v_prob := esig.signature_state_problem(p_signature);
  if v_prob is not null then
    raise exception using errcode = 'P0001', message = 'EBMR-PLANT-176 ' || v_prob;
  end if;
  if (select g.signer_person from esig.signature g where g.id = p_signature)::text is distinct from p_actor ->> 'person_id' then
    raise exception using errcode = 'P0001', message = 'EBMR-PLANT-176 the approval is recorded by the person who signed it (PR-27)';
  end if;
end
$$;

create function plant.approve_facility_rule(p_rule uuid, p_signature uuid) returns void
language plpgsql volatile security definer set search_path = pg_catalog, plant, iam, pg_temp as $$
declare
  v_ctx jsonb;
  f     plant.facility_rule;
begin
  perform iam.assert_not_administrator();
  select * into f from plant.facility_rule where id = p_rule;
  if f.id is null then
    raise exception using errcode = 'P0001', message = format('EBMR-PLANT-173 unknown facility rule proposal %s (PR-27)', coalesce(p_rule::text, 'NULL'));
  end if;
  v_ctx := iam.require_permission('PLANT_RULE.APPROVE', jsonb_build_object('site', f.site_code));
  -- The proposal's own lock (plant.set_facility_rule): no new version slips in between the check and the approval.
  perform pg_advisory_xact_lock(hashtextextended('plant.facility_rule:' || f.site_code, 0));
  if plant.facility_rule_state(f.id) <> 'PROPOSED' then
    raise exception using errcode = 'P0001', message = format('EBMR-PLANT-174 version %s of the facility rule of %s is %s; only the latest proposal of a site is approved, once (PR-27)',
                                                              f.version, f.site_code, plant.facility_rule_state(f.id));
  end if;
  perform plant.assert_plant_rule_approval(p_signature, 'facility_rule', f.id, f.recorded_by_person, v_ctx);
  insert into plant.facility_rule_approval (rule_id, signature_id, approved_by_person, approved_by_account)
  values (f.id, p_signature, (v_ctx ->> 'person_id')::uuid, (v_ctx ->> 'account_id')::uuid);
end
$$;

create function plant.approve_beta_lactam_class(p_class uuid, p_signature uuid) returns void
language plpgsql volatile security definer set search_path = pg_catalog, plant, iam, pg_temp as $$
declare
  v_ctx jsonb;
  c     plant.beta_lactam_class;
begin
  perform iam.assert_not_administrator();
  select * into c from plant.beta_lactam_class where id = p_class;
  if c.id is null then
    raise exception using errcode = 'P0001', message = format('EBMR-PLANT-173 unknown beta-lactam classification proposal %s (PR-27)', coalesce(p_class::text, 'NULL'));
  end if;
  v_ctx := iam.require_permission('PLANT_RULE.APPROVE', case when c.subject_kind = 'PRODUCT' then jsonb_build_object('product', c.code) else '{}'::jsonb end);
  perform pg_advisory_xact_lock(hashtextextended('plant.beta_lactam_class:' || c.subject_kind || ':' || c.code, 0));
  if plant.beta_lactam_class_state(c.id) <> 'PROPOSED' then
    raise exception using errcode = 'P0001', message = format('EBMR-PLANT-174 version %s of the classification of %s %s is %s; only the latest proposal of a material or product is approved, once (PR-27)',
                                                              c.version, lower(c.subject_kind), c.code, plant.beta_lactam_class_state(c.id));
  end if;
  perform plant.assert_plant_rule_approval(p_signature, 'beta_lactam_class', c.id, c.recorded_by_person, v_ctx);
  insert into plant.beta_lactam_class_approval (class_id, signature_id, approved_by_person, approved_by_account)
  values (c.id, p_signature, (v_ctx ->> 'person_id')::uuid, (v_ctx ->> 'account_id')::uuid);
end
$$;

revoke all on function plant.penicillin_facility(text), plant.facility_rule_approved(text), plant.beta_lactam_class_approved(text, text), plant.facility_rule_state(uuid), plant.beta_lactam_class_state(uuid), plant.facility_rule_content(text),
  plant.beta_lactam_class_content(text), plant.assert_plant_rule_approval(uuid, text, uuid, uuid, jsonb), plant.approve_facility_rule(uuid, uuid),
  plant.approve_beta_lactam_class(uuid, uuid) from public;
grant select on plant.facility_rule_in_force, plant.beta_lactam_class_in_force to ebmr_app;
-- The views call the readers as the reading role, so it executes them (they only read what it may select anyway).
grant execute on function plant.penicillin_facility(text), plant.facility_rule_approved(text), plant.beta_lactam_class_approved(text, text), plant.facility_rule_state(uuid), plant.beta_lactam_class_state(uuid), plant.approve_facility_rule(uuid, uuid),
  plant.approve_beta_lactam_class(uuid, uuid) to ebmr_app;

reset role;
