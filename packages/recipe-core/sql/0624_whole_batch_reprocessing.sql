-- Recipe core, Phase 3 slice 5b (outline 5.2.9 case 1: whole-batch reprocessing; the release-side reader; the recovered
-- input's expiry; D-S5-5, D-S5-6, D-S5-7, D-S5-9; controls PR-47, IN-18, IN-19, INV-33; ADR 0012: the rules hold when the
-- application's own database credentials are used directly). Part 5, on site-services 0730 to 0733 (slice 5a-0).
--
--   * recipe.mbr_family.record_kind takes REPROCESSING (flow/model.ts RecordKind): the master of a whole-batch
--     reprocessing of the same product (D-S5-6). Its batch takes an ordinary PROCESSING number of the register, never a
--     parent's.
--   * REPROCESSING.AUTHORISE is also the authorised person's (AUTHORISED_PERSON, the quality-control unit authoriser of
--     slice 5a's personas): the QCU authorisation of a reprocessing (REPROCESSING_AUTHORISED, 0621).
--   * recipe.reprocessing_request (insert-only, audited, signable aggregate reprocessing_request): what the quality unit
--     authorises before a reprocessing batch is planned: the REPROCESSING family, the parent batches, the deviation-lite
--     investigation it answers (its ref) and the stored risk evaluation (an evidence document, site-services 0731);
--     recipe.reprocessing_request_signature: its REPROCESSING_AUTHORISED signature (recipe.authorise_reprocessing_request).
--   * recipe.reprocessing_request_problem: why a request does not allow planning a batch now: unsigned; the family is no
--     REPROCESSING family of the parents' product and strength; the product master does not permit reprocessing (D-S5-5:
--     an unknown product or reprocessingPermitted false refuses: product-level disable); a parent is no issued GMP batch
--     of that product at the batch's site; the investigation is no QA-concluded deviation-lite record linked to each
--     parent (site.deviation_ref_problem(ref, 'REPROCESSING', parent)); the risk evaluation is no stored document of the
--     site (site.evidence_document_problem); the signer is the person who plans the batch; the request was used already.
--   * recipe.prepare_reprocessing_issue(p_batch, p_def): checks the request named in p_def.reprocessingRequest, then
--     calls 5a's recipe.prepare_gmp_issue unchanged with the rest of p_def, and records the parent links in the same
--     transaction. recipe.batch_parent_link (insert-only, audited; INV-33, IN-18): the child batch, each parent, its
--     number, its held, sorted or rejected containers at planning, and the request. The deferred constraint trigger
--     zz_reprocessing_parents on recipe.stub_batch refuses a planned batch of a REPROCESSING family without them.
--   * plant.charge_container (CREATE OR REPLACE from recipe-core 0422, the latest): a container of another batch is
--     charged only by a child of that batch, and only a container its link names (held, sorted or rejected material is
--     chargeable only into its reprocessing batch); every other rule stands.
--   * recipe.batch_reprocessing_basis and recipe.batch_contains_recovered (CREATE OR REPLACE from 0621): WHOLE_BATCH for a
--     child of a whole-batch reprocessing, which is reprocessed material for chained recovery as well.
--   * recipe.source_batch_expiry (CREATE OR REPLACE from 0621): the source batch's manufacturing month (its issue date in
--     the site's zone) plus the product master's shelf life, less one month (the print rule of tablets 0951; D-S5-7);
--     NULL when the master has no shelf life.
--   * recipe.reprocessing_release_problem (D-S5-9; the Phase 4 release checklist): a batch with a reprocessing basis has
--     no QC decision on additional testing (site.qc_extra_testing_decision_of), or NULL.
--
-- Messages: EBMR-RPR-050 to 059. Applied as a new migration because applied migrations are checksummed and never edited.

set local role ebmr_owner;

alter table recipe.mbr_family drop constraint mbr_family_record_kind_check;
alter table recipe.mbr_family add constraint mbr_family_record_kind_check check (record_kind in ('PROCESSING', 'PACKAGING', 'REPROCESSING'));

select kernel.set_actor_context(jsonb_build_object(
  'person_id', '00000000-0000-0000-0000-000000000000', 'account_id', '00000000-0000-0000-0000-000000000000',
  'role_code', 'SOFTWARE_RELEASE', 'session_id', '00000000-0000-0000-0000-000000000000', 'source', 'SYSTEM',
  'site_zone', 'UTC', 'correlation_id', gen_random_uuid(),
  'legal_name', 'Software release (recipe-core migration 0624_whole_batch_reprocessing)',
  'reason_code', 'SOFTWARE_RELEASE',
  'reason_text', 'the quality-control unit''s authorisation of a reprocessing by the authorised person (PR-47, IN-18)'));

insert into iam.role_permission (role_code, permission_code) values ('AUTHORISED_PERSON', 'REPROCESSING.AUTHORISE');

select kernel.set_actor_context(null);

create table recipe.reprocessing_request (
  id                   uuid primary key default gen_random_uuid(),
  family_id            uuid not null references recipe.mbr_family (id),
  site_code            text not null check (btrim(site_code) <> ''),
  parent_batch_ids     uuid[] not null check (cardinality(parent_batch_ids) between 1 and 10),
  investigation_ref    text not null check (btrim(investigation_ref) <> '' and length(investigation_ref) <= 64),
  risk_evaluation_id   uuid not null,
  proposed_by_person   uuid not null,
  proposed_by_account  uuid not null,
  correlation_id       uuid not null,
  proposed_at          timestamptz not null default clock_timestamp()
);
revoke all on recipe.reprocessing_request from public;

create table recipe.reprocessing_request_signature (
  request_id           uuid primary key references recipe.reprocessing_request (id),
  signature_id         uuid not null unique,
  signer_person        uuid not null,
  recorded_by_account  uuid not null,
  recorded_at          timestamptz not null default clock_timestamp()
);
revoke all on recipe.reprocessing_request_signature from public;

create table recipe.batch_parent_link (
  child_batch_id       uuid not null references recipe.stub_batch (id),
  parent_batch_id      uuid not null references recipe.batch_execution (id),
  parent_batch_number  text not null,
  parent_containers    uuid[] not null,
  request_id           uuid not null references recipe.reprocessing_request (id),
  recorded_at          timestamptz not null default clock_timestamp(),
  primary key (child_batch_id, parent_batch_id),
  check (child_batch_id <> parent_batch_id)
);
revoke all on recipe.batch_parent_link from public;
create index batch_parent_link_parent on recipe.batch_parent_link (parent_batch_id);
create unique index batch_parent_link_request on recipe.batch_parent_link (request_id, parent_batch_id);

create trigger aa_insert_only before update or delete on recipe.reprocessing_request for each row execute function kernel.reject_mutation();
create trigger aa_no_truncate before truncate on recipe.reprocessing_request for each statement execute function kernel.reject_mutation();
create trigger aa_insert_only before update or delete on recipe.reprocessing_request_signature for each row execute function kernel.reject_mutation();
create trigger aa_no_truncate before truncate on recipe.reprocessing_request_signature for each statement execute function kernel.reject_mutation();
create trigger aa_insert_only before update or delete on recipe.batch_parent_link for each row execute function kernel.reject_mutation();
create trigger aa_no_truncate before truncate on recipe.batch_parent_link for each statement execute function kernel.reject_mutation();
select platform.enforce_db_time('recipe.reprocessing_request', array['proposed_at']);
select platform.enforce_db_time('recipe.reprocessing_request_signature', array['recorded_at']);
select platform.enforce_db_time('recipe.batch_parent_link', array['recorded_at']);
select kernel.register_audited_table('recipe.reprocessing_request', 'reprocessing_request', 'id', true);
select kernel.register_audited_table('recipe.reprocessing_request_signature', 'reprocessing_request', 'request_id', true);
select kernel.register_audited_table('recipe.batch_parent_link', 'batch', 'child_batch_id', true);
grant select on recipe.reprocessing_request, recipe.reprocessing_request_signature, recipe.batch_parent_link to ebmr_app;

-- The signable content of a request (header).
create function recipe.reprocessing_request_content(p_id text) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, recipe, pg_temp as $$
declare
  q recipe.reprocessing_request;
  f recipe.mbr_family;
begin
  if coalesce(p_id, '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return '{"exists": false}'::jsonb;
  end if;
  select * into q from recipe.reprocessing_request where id = p_id::uuid;
  if not found then
    return '{"exists": false}'::jsonb;
  end if;
  select * into f from recipe.mbr_family where id = q.family_id;
  return jsonb_build_object(
    'exists', true, 'aggregate_id', q.id::text, 'content_version', 1,
    'content', jsonb_build_object(
      'title', format('Whole-batch reprocessing of %s on %s', (select string_agg(b.batch_number, ', ' order by b.batch_number) from recipe.batch_execution b where b.id = any (q.parent_batch_ids)), f.code),
      'family', jsonb_build_object('id', f.id, 'code', f.code, 'record_kind', f.record_kind, 'product_code', f.product_code, 'strength', f.strength),
      'site', q.site_code,
      'parents', (select coalesce(jsonb_agg(jsonb_build_object('id', b.id, 'batch_number', b.batch_number) order by b.batch_number), '[]'::jsonb) from recipe.batch_execution b where b.id = any (q.parent_batch_ids)),
      'investigation_ref', q.investigation_ref, 'risk_evaluation_id', q.risk_evaluation_id,
      'risk_evaluation_sha256', (select e.sha256 from site.evidence_document e where e.id = q.risk_evaluation_id),
      'proposed_by', q.proposed_by_person, 'proposed_at', recipe.utc_text(q.proposed_at)),
    'state', 'PROPOSED',
    'scope', jsonb_build_object('product', f.product_code, 'site', q.site_code),
    'entered_by', jsonb_build_array(q.proposed_by_person));
end
$$;

select esig.register_content_provider('reprocessing_request', 'recipe.reprocessing_request_content(text)',
  'A whole-batch reprocessing the quality-control unit is asked to authorise: the reprocessing master, the parent batches, the investigation and the stored risk evaluation (outline 5.2.9 case 1; PR-47, IN-18)');
select esig.register_signed_table('recipe.reprocessing_request', 'reprocessing_request', 'id',
  array['family_id', 'site_code', 'parent_batch_ids', 'investigation_ref', 'risk_evaluation_id', 'proposed_by_person', 'proposed_at']);

-- PR-47, IN-18 (header): asks for the QCU's authorisation of a whole-batch reprocessing of parents p_parents on
-- REPROCESSING family p_family at site p_site, citing deviation-lite record p_investigation and evidence document p_risk.
create function recipe.propose_reprocessing_request(p_family uuid, p_site text, p_parents uuid[], p_investigation text, p_risk uuid) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, recipe, iam, pg_temp as $$
declare
  f       recipe.mbr_family;
  v_actor jsonb;
  v_id    uuid;
begin
  perform iam.assert_not_administrator();
  select * into f from recipe.mbr_family where id = p_family;
  if f.id is null or f.record_kind <> 'REPROCESSING' then
    raise exception using errcode = 'P0001', message = 'A whole-batch reprocessing runs on a master of record kind REPROCESSING (D-S5-6; PR-47). [EBMR-RPR-050]';
  end if;
  v_actor := iam.require_permission('BATCH.ISSUE', jsonb_build_object('site', p_site, 'product', f.product_code));
  if p_parents is null or cardinality(p_parents) = 0 or btrim(coalesce(p_investigation, '')) = '' or p_risk is null then
    raise exception using errcode = 'P0001', message = 'The request names its parent batches, the investigation and the stored risk evaluation (PR-47, IN-18). [EBMR-RPR-050]';
  end if;
  insert into recipe.reprocessing_request (family_id, site_code, parent_batch_ids, investigation_ref, risk_evaluation_id, proposed_by_person, proposed_by_account, correlation_id)
  values (p_family, p_site, (select array_agg(distinct x order by x) from unnest(p_parents) x), btrim(p_investigation), p_risk,
          (v_actor ->> 'person_id')::uuid, (v_actor ->> 'account_id')::uuid, (v_actor ->> 'correlation_id')::uuid)
  returning id into v_id;
  return jsonb_build_object('id', v_id);
end
$$;

-- PR-47: the QCU records its REPROCESSING_AUTHORISED signature p_signature on request p_id, once.
create function recipe.authorise_reprocessing_request(p_id uuid, p_signature uuid) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, recipe, iam, esig, pg_temp as $$
declare
  q        recipe.reprocessing_request;
  v_actor  jsonb;
  v_signer uuid;
begin
  perform iam.assert_not_administrator();
  select * into q from recipe.reprocessing_request where id = p_id;
  if not found then
    raise exception using errcode = 'P0001', message = format('There is no reprocessing request %s (PR-47). [EBMR-RPR-051]', p_id);
  end if;
  v_actor := iam.require_permission('REPROCESSING.AUTHORISE', jsonb_build_object('site', q.site_code, 'product', (select f.product_code from recipe.mbr_family f where f.id = q.family_id)));
  perform pg_advisory_xact_lock(hashtext('recipe.reprocessing_request:' || p_id::text));
  if exists (select 1 from recipe.reprocessing_request_signature s where s.request_id = p_id) then
    raise exception using errcode = 'P0001', message = 'This reprocessing request is already authorised (PR-47). [EBMR-RPR-051]';
  end if;
  v_signer := (esig.assert_signature(p_signature, 'REPROCESSING_AUTHORISED', 'reprocessing_request', p_id::text) ->> 'signer_person')::uuid;
  if v_signer is distinct from (v_actor ->> 'person_id')::uuid then
    raise exception using errcode = 'P0001', message = 'The quality-control unit records its own authorisation (PR-47). [EBMR-RPR-051]';
  end if;
  insert into recipe.reprocessing_request_signature (request_id, signature_id, signer_person, recorded_by_account) values (p_id, p_signature, v_signer, (v_actor ->> 'account_id')::uuid);
  return jsonb_build_object('id', p_id, 'signedBy', v_signer);
end
$$;

-- PR-47, IN-18, IN-19, D-S5-5 (header): why request p_request does not allow planning a batch of family p_family at site
-- p_site by person p_issuer now, or NULL.
create function recipe.reprocessing_request_problem(p_request uuid, p_family uuid, p_site text, p_issuer uuid) returns text
language plpgsql stable security definer set search_path = pg_catalog, recipe, site, pg_temp as $$
declare
  q       recipe.reprocessing_request;
  s       recipe.reprocessing_request_signature;
  f       recipe.mbr_family;
  v_pm    jsonb;
  v_par   uuid;
  x       recipe.batch_execution;
  v_prob  text;
begin
  select * into q from recipe.reprocessing_request where id = p_request;
  if q.id is null then
    return 'it names no reprocessing request';
  end if;
  select * into s from recipe.reprocessing_request_signature where request_id = q.id;
  if s.request_id is null then
    return 'the quality-control unit has not authorised the reprocessing (no REPROCESSING_AUTHORISED signature)';
  end if;
  if q.family_id is distinct from p_family or q.site_code is distinct from p_site then
    return 'the request is for another reprocessing master or site';
  end if;
  select * into f from recipe.mbr_family where id = p_family;
  if f.record_kind is distinct from 'REPROCESSING' then
    return format('family %s is no reprocessing master (record kind REPROCESSING)', f.code);
  end if;
  v_pm := site.product_master_of(f.product_code, f.strength);
  if v_pm is null or (v_pm -> 'reprocessingPermitted') is distinct from 'true'::jsonb then
    return format('the product master does not permit reprocessing of %s %s (product-level disable; D-S5-5)', f.product_code, f.strength);
  end if;
  foreach v_par in array q.parent_batch_ids loop
    select * into x from recipe.batch_execution where id = v_par;
    if x.id is null or x.purpose <> 'GMP_BATCH' then
      return format('parent %s is no issued GMP batch', v_par);
    end if;
    if (recipe.batch_product(v_par) ->> 'code') is distinct from f.product_code or (recipe.batch_product(v_par) ->> 'strength') is distinct from f.strength
       or (select sb.site from recipe.stub_batch sb where sb.id = v_par) is distinct from p_site then
      return format('parent %s is not of %s %s at site %s', x.batch_number, f.product_code, f.strength, p_site);
    end if;
    v_prob := site.deviation_ref_problem(q.investigation_ref, 'REPROCESSING', v_par);
    if v_prob is not null then
      return format('the investigation %s does not stand for parent %s: %s', q.investigation_ref, x.batch_number, v_prob);
    end if;
  end loop;
  v_prob := site.evidence_document_problem(q.risk_evaluation_id, p_site);
  if v_prob is not null then
    return format('the risk evaluation %s', v_prob);
  end if;
  if s.signer_person = p_issuer then
    return 'the reprocessing is authorised by the person who plans the batch; the quality-control unit authorises it, not the issuer';
  end if;
  if exists (select 1 from recipe.batch_parent_link l where l.request_id = q.id) then
    return 'the request was used for a batch already; each reprocessing is authorised once';
  end if;
  return null;
end
$$;

-- INV-33, IN-18, PR-47 (header): plans reprocessing batch p_batch with definition p_def (5a's prepare_gmp_issue
-- definition plus reprocessingRequest) and links it to its parents.
create function recipe.prepare_reprocessing_issue(p_batch uuid, p_def jsonb) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, recipe, iam, plant, pg_temp as $$
declare
  v_actor   jsonb := iam.assert_not_administrator();
  v_problem text;
  v_req     uuid;
  q         recipe.reprocessing_request;
  v_out     jsonb;
  v_par     uuid;
begin
  if coalesce(p_def ->> 'reprocessingRequest', '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     or coalesce(p_def ->> 'familyId', '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    raise exception using errcode = 'P0001', message = 'A reprocessing batch is planned on its master with the authorised request (reprocessingRequest) (PR-47, IN-18). [EBMR-RPR-052]';
  end if;
  perform iam.require_permission('BATCH.ISSUE', jsonb_strip_nulls(jsonb_build_object('site', p_def ->> 'site',
                                                                                    'product', (select f.product_code from recipe.mbr_family f where f.id = (p_def ->> 'familyId')::uuid))));
  v_req := (p_def ->> 'reprocessingRequest')::uuid;
  perform pg_advisory_xact_lock(hashtext('recipe.reprocessing_request:' || v_req::text));
  v_problem := recipe.reprocessing_request_problem(v_req, (p_def ->> 'familyId')::uuid, p_def ->> 'site', (v_actor ->> 'person_id')::uuid);
  if v_problem is not null then
    raise exception using errcode = 'P0001',
      message = format('The reprocessing batch cannot be planned: %s. A whole-batch reprocessing needs the QCU''s prior authorisation citing a concluded investigation and a stored risk evaluation, and the product''s permission (PR-47, IN-18, IN-19). [EBMR-RPR-052]', v_problem);
  end if;
  v_out := recipe.prepare_gmp_issue(p_batch, p_def - 'reprocessingRequest');
  select * into q from recipe.reprocessing_request where id = v_req;
  foreach v_par in array q.parent_batch_ids loop
    insert into recipe.batch_parent_link (child_batch_id, parent_batch_id, parent_batch_number, parent_containers, request_id)
    values (p_batch, v_par, (select b.batch_number from recipe.batch_execution b where b.id = v_par),
            coalesce((select array_agg(o.id order by o.opened_at, o.id) from plant.output_container o
                       where o.batch_id = v_par and plant.container_state(o.id) in ('HELD', 'SORTED', 'REJECTED')), '{}'), v_req);
  end loop;
  return v_out || jsonb_build_object('parents', to_jsonb(q.parent_batch_ids), 'reprocessingRequest', v_req);
end
$$;

-- INV-33 (header): a planned batch of a REPROCESSING family is linked to its parents by the end of its transaction.
create function recipe.reprocessing_parents_check() returns trigger
language plpgsql security definer set search_path = pg_catalog, recipe, pg_temp as $$
begin
  if (select f.record_kind from recipe.mbr_family f where f.id = new.family_id) = 'REPROCESSING'
     and not exists (select 1 from recipe.batch_parent_link l where l.child_batch_id = new.id) then
    raise exception using errcode = 'P0001',
      message = format('Batch %s runs a reprocessing master but names no parent batches: a reprocessed batch takes a new number linked to its parents, planned through recipe.prepare_reprocessing_issue (INV-33, IN-18). [EBMR-RPR-053]', new.batch_number);
  end if;
  return null;
end
$$;

create constraint trigger zz_reprocessing_parents after insert on recipe.stub_batch deferrable initially deferred
  for each row execute function recipe.reprocessing_parents_check();

-- As recipe-core 0422, with a parent's held, sorted or rejected container chargeable by its reprocessing batch (header).
create or replace function plant.charge_container(p_batch uuid, p_stage text, p_scanned_label text, p_purpose text default 'CHARGE') returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, plant, recipe, iam, kernel, platform, pg_temp as $$
declare
  v_actor   jsonb;
  b         recipe.batch_execution;
  c         plant.output_container;
  v_problem text;
  v_id      uuid;
  v_parent  boolean := false;
begin
  perform iam.assert_not_administrator();
  select * into b from recipe.batch_execution where id = p_batch;
  if not found then
    raise exception using errcode = 'P0001', message = format('Unknown batch %s (EBMR-CNT-020)', p_batch);
  end if;
  v_actor := iam.require_permission('STEP.EXECUTE', plant.batch_scope(p_batch));
  select * into c from plant.output_container where label_code = p_scanned_label for update;
  if not found then
    raise exception using errcode = 'P0001',
      message = format('The scanned label %s names no output container; scan refused (IN-26 (c); EBMR-CNT-040)', coalesce(p_scanned_label, '(none)'));
  end if;
  if c.batch_id <> p_batch then
    v_parent := p_purpose = 'CHARGE' and exists (select 1 from recipe.batch_parent_link l where l.child_batch_id = p_batch and l.parent_batch_id = c.batch_id and c.id = any (l.parent_containers));
    if not v_parent then
      raise exception using errcode = 'P0001',
        message = format('Container %s is labelled for batch %s, not batch %s; scan refused (IN-26 (c); EBMR-CNT-041)', c.label_code, c.batch_number,
                         b.batch_number);
    end if;
  end if;
  -- The state row is locked so a hold recorded concurrently is either seen here or waits for this charge.
  perform 1 from platform.aggregate_state s where s.aggregate_type = 'output_container' and s.aggregate_id = c.id for update;
  if v_parent then
    -- PR-47, INV-33: the parent's held, sorted or rejected material goes only into its reprocessing batch, once.
    v_problem := case when plant.container_state(c.id) not in ('HELD', 'SORTED', 'REJECTED') then format('container %s is %s, no longer held for reprocessing', c.label_code, plant.container_state(c.id))
                      when exists (select 1 from plant.container_charge g where g.container_id = c.id) then format('container %s was already charged', c.label_code)
                      when exists (select 1 from plant.container_merge m where m.source_id = c.id) then format('container %s was merged', c.label_code) end;
  else
    v_problem := plant.container_usable_problem(c.id);
  end if;
  if v_problem is not null then
    raise exception using errcode = 'P0001', message = format('Container %s cannot be %s: %s (L-30, TB-11; EBMR-CNT-042)', c.label_code,
                                                              case p_purpose when 'PACK' then 'packed' else 'charged' end, v_problem);
  end if;
  insert into plant.container_charge (container_id, batch_id, stage, purpose, scanned_label, person_id, account_id)
  values (c.id, p_batch, p_stage, p_purpose, p_scanned_label, (v_actor ->> 'person_id')::uuid, (v_actor ->> 'account_id')::uuid)
  returning id into v_id;
  return jsonb_build_object('charge_id', v_id, 'container_id', c.id, 'label_code', c.label_code,
                            'net_quantity', (select x.net_quantity::text from plant.container_close x where x.container_id = c.id),
                            'quantity_unit', c.quantity_unit);
end
$$;

create or replace function recipe.batch_contains_recovered(p_batch uuid) returns boolean
language sql stable security definer set search_path = pg_catalog, recipe, pg_temp as $$
  select exists (select 1 from recipe.source_addition a where a.batch_id = p_batch)
      or exists (select 1 from recipe.batch_parent_link l where l.child_batch_id = p_batch)
$$;

create or replace function recipe.batch_reprocessing_basis(p_batch uuid) returns text
language sql stable security definer set search_path = pg_catalog, recipe, pg_temp as $$
  select case
           when exists (select 1 from recipe.batch_parent_link l where l.child_batch_id = p_batch) then 'WHOLE_BATCH'
           when exists (select 1 from recipe.source_addition a where a.batch_id = p_batch and a.case_code = 'REPROCESSING_ADDITION') then 'REPROCESSING_ADDITION'
           when exists (select 1 from recipe.source_addition a where a.batch_id = p_batch) then 'RECOVERY'
         end
$$;

create or replace function recipe.source_batch_expiry(p_batch uuid) returns date
language sql stable security definer set search_path = pg_catalog, recipe, site, kernel, pg_temp as $$
  select (date_trunc('month', (b.issued_at at time zone kernel.site_zone())::date)
          + make_interval(months => (m ->> 'shelfLifeMonths')::integer - 1))::date
    from recipe.batch_execution b,
         lateral (select site.product_master_of(recipe.batch_product(b.id) ->> 'code', recipe.batch_product(b.id) ->> 'strength') as m) pm
   where b.id = p_batch and jsonb_typeof(pm.m -> 'shelfLifeMonths') = 'number' and (pm.m ->> 'shelfLifeMonths')::integer >= 1
$$;

-- PR-47, D-S5-9 (header): why batch p_batch is not ready for release for its reprocessing basis, or NULL.
create function recipe.reprocessing_release_problem(p_batch uuid) returns text
language plpgsql stable security definer set search_path = pg_catalog, recipe, site, pg_temp as $$
declare
  v_basis text := recipe.batch_reprocessing_basis(p_batch);
begin
  if v_basis is null then
    return null;
  end if;
  if site.qc_extra_testing_decision_of(p_batch) is null then
    return format('the batch is %s and QC has recorded no decision on additional testing (PR-47)',
                  case v_basis when 'WHOLE_BATCH' then 'a whole-batch reprocessing' when 'REPROCESSING_ADDITION' then 'reprocessed material added' else 'recovered material added' end);
  end if;
  return null;
end
$$;

revoke all on function recipe.reprocessing_request_content(text), recipe.propose_reprocessing_request(uuid, text, uuid[], text, uuid),
  recipe.authorise_reprocessing_request(uuid, uuid), recipe.reprocessing_request_problem(uuid, uuid, text, uuid),
  recipe.prepare_reprocessing_issue(uuid, jsonb), recipe.reprocessing_parents_check(), recipe.reprocessing_release_problem(uuid) from public;
grant execute on function recipe.reprocessing_request_content(text), recipe.propose_reprocessing_request(uuid, text, uuid[], text, uuid),
  recipe.authorise_reprocessing_request(uuid, uuid), recipe.prepare_reprocessing_issue(uuid, jsonb), recipe.reprocessing_release_problem(uuid) to ebmr_app;

reset role;
