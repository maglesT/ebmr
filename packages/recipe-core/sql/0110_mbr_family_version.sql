-- Recipe core, MBR life cycle (A3), part 2: MBR families, versions, content revisions, draft
-- cycles, the version log (the basis of INV-04), and the change-control and risk-assessment
-- references that stand in for the QMS in Phase 2.
--
--   mbr_family       product x strength x batch-size set x dosage form x edition (x record kind);
--                    insert-only. The MBR content's header must agree with it.
--   mbr_version      one version of a family: number, author, derived-from version, change record,
--                    effective date, periodic-review due date. The last three are draft attributes:
--                    they change only in DRAFT. The state lives in the platform state engine
--                    (machine mbr_version, pinned per version).
--   mbr_content      content revisions (the MBR JSON of the flow model) with the canonical content
--                    hash; insert-only; a revision can be added only while the version is in DRAFT
--                    (PR-06: an approved master's content never changes). The current content is
--                    the latest revision.
--   mbr_draft_entry  every entry into DRAFT (creation is cycle 1, each return adds a cycle). Part
--                    of the signed content, so a return supersedes every signature (DI-37, INV-09).
--   mbr_version_log  who changed what on the version, per draft cycle: the edits since the last
--                    entry into DRAFT decide who may not sign CHECKED or APPROVED (INV-04).
--   change_record, change_record_validation, change_record_regulatory
--                    stub of the QMS change-control record: number, class, the change owner's
--                    process-impact classification, validation links (PR-06) and the regulatory
--                    assessment per market with its reporting category and, where needed, the
--                    variation or supplement reference (PR-04; ICH Q12 reporting category).
--   risk_assessment, mbr_risk_link
--                    stub of the QRM record (id, risk class, rationale reference) and its links
--                    to a version, per critical element or for the whole master (PR-07).

set local role ebmr_owner;

-- ---------------------------------------------------------------------------------------------
-- Change control and risk assessment (QMS stand-ins)
-- ---------------------------------------------------------------------------------------------

create table recipe.change_record (
  id                   uuid primary key default gen_random_uuid(),
  number               text not null unique check (number ~ '^[A-Za-z0-9][A-Za-z0-9._/-]{0,63}$'),
  title                text not null check (btrim(title) <> ''),
  change_class         text not null check (change_class in ('MINOR', 'MAJOR', 'CRITICAL')),
  -- The change owner's own process-impact classification. The database computes its own (PR-06)
  -- and applies the stricter of the two.
  process_impacting    boolean not null,
  qms_reference        text,
  recorded_by_person   uuid not null,
  recorded_by_account  uuid not null,
  recorded_at          timestamptz not null default clock_timestamp()
);

create table recipe.change_record_validation (
  id                   uuid primary key default gen_random_uuid(),
  change_record_id     uuid not null references recipe.change_record (id),
  validation_ref       text not null check (btrim(validation_ref) <> ''),
  description          text,
  recorded_by_person   uuid not null,
  recorded_by_account  uuid not null,
  recorded_at          timestamptz not null default clock_timestamp()
);
create index change_record_validation_record on recipe.change_record_validation (change_record_id);

create table recipe.change_record_regulatory (
  id                    uuid primary key default gen_random_uuid(),
  change_record_id      uuid not null references recipe.change_record (id),
  market                text not null check (market ~ '^[A-Z]{2}$'),
  -- e.g. PRIOR_APPROVAL, NOTIFICATION_MODERATE, NOTIFICATION_LOW, NOT_REPORTED, or the market's own
  -- category (US PAS / CBE-30 / CBE-0 / annual report; EU type II / IB / IA; India prior approval).
  reporting_category    text not null check (btrim(reporting_category) <> ''),
  -- Variation, supplement or approval number: required when a registered range is widened (PR-04).
  regulatory_reference  text,
  recorded_by_person    uuid not null,
  recorded_by_account   uuid not null,
  recorded_at           timestamptz not null default clock_timestamp()
);
create index change_record_regulatory_record on recipe.change_record_regulatory (change_record_id, market);

create table recipe.risk_assessment (
  id                   uuid primary key default gen_random_uuid(),
  code                 text not null check (btrim(code) <> ''),
  version              text not null check (btrim(version) <> ''),
  title                text not null check (btrim(title) <> ''),
  risk_class           text not null check (btrim(risk_class) <> ''),
  rationale_ref        text not null check (btrim(rationale_ref) <> ''),
  recorded_by_person   uuid not null,
  recorded_by_account  uuid not null,
  recorded_at          timestamptz not null default clock_timestamp(),
  unique (code, version)
);

-- ---------------------------------------------------------------------------------------------
-- Families, versions, content
-- ---------------------------------------------------------------------------------------------

create table recipe.mbr_family (
  id                   uuid primary key default gen_random_uuid(),
  code                 text not null unique check (code ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'),
  title                text not null check (btrim(title) <> ''),
  edition              text not null check (edition in ('tablets', 'injectables')),
  record_kind          text not null check (record_kind in ('PROCESSING', 'PACKAGING')),
  product_code         text not null check (btrim(product_code) <> ''),
  product_name         text not null check (btrim(product_name) <> ''),
  strength             text not null check (btrim(strength) <> ''),
  dosage_form          text not null check (btrim(dosage_form) <> ''),
  -- Discrete approved batch sizes (PR-01, Decision 9): [{id, quantity: {value, unit}}] ordered by id.
  batch_sizes          jsonb not null check (jsonb_typeof(batch_sizes) = 'array' and jsonb_array_length(batch_sizes) >= 1),
  created_by_person    uuid not null,
  created_by_account   uuid not null,
  recorded_at          timestamptz not null default clock_timestamp()
);
-- One family per product, strength, batch-size set, dosage form, edition and record kind, so INV-17
-- (one CURRENT version per family, market and scope) cannot be sidestepped with a twin family.
create unique index mbr_family_identity on recipe.mbr_family (edition, record_kind, product_code, strength, dosage_form, batch_sizes);

create table recipe.mbr_version (
  id                  uuid primary key default gen_random_uuid(),
  family_id           uuid not null references recipe.mbr_family (id),
  version_number      integer not null check (version_number >= 1),
  author_person       uuid not null,
  author_account      uuid not null,
  derived_from        uuid references recipe.mbr_version (id),
  -- Draft attributes (change only in DRAFT; signed with the content):
  change_record_id    uuid references recipe.change_record (id),
  effective_from      timestamptz,
  review_due          date,
  recorded_at         timestamptz not null default clock_timestamp(),
  unique (family_id, version_number),
  check (derived_from is null or derived_from <> id)
);

create table recipe.mbr_content (
  id                  uuid primary key default gen_random_uuid(),
  version_id          uuid not null references recipe.mbr_version (id),
  revision            integer not null check (revision >= 1),
  content             jsonb not null check (jsonb_typeof(content) = 'object'),
  content_hash        text not null check (content_hash ~ '^[0-9a-f]{64}$'),
  reason              text,
  edited_by_person    uuid not null,
  edited_by_account   uuid not null,
  recorded_at         timestamptz not null default clock_timestamp(),
  unique (version_id, revision)
);

create table recipe.mbr_draft_entry (
  id           uuid primary key default gen_random_uuid(),
  version_id   uuid not null references recipe.mbr_version (id),
  cycle        integer not null check (cycle >= 1),
  from_state   text,
  reason_code  text,
  reason_text  text,
  person_id    uuid not null,
  account_id   uuid not null,
  xact_id      bigint not null,
  recorded_at  timestamptz not null default clock_timestamp(),
  unique (version_id, cycle),
  check ((cycle = 1) = (from_state is null))
);

create table recipe.mbr_version_log (
  id           bigint generated always as identity primary key,
  version_id   uuid not null references recipe.mbr_version (id),
  cycle        integer not null check (cycle >= 1),
  kind         text not null check (kind in ('CREATED', 'CONTENT', 'EFFECTIVE_DATE', 'REVIEW_DUE', 'CHANGE_RECORD',
                                             'RISK_LINK', 'RISK_UNLINK', 'EVIDENCE', 'DRAFT_ENTRY')),
  -- INV-04: an edit of the version's signed content (not evidence, not a draft entry).
  is_edit      boolean not null,
  person_id    uuid not null,
  account_id   uuid not null,
  detail       jsonb not null default '{}'::jsonb,
  recorded_at  timestamptz not null default clock_timestamp(),
  check (is_edit = (kind in ('CREATED', 'CONTENT', 'EFFECTIVE_DATE', 'REVIEW_DUE', 'CHANGE_RECORD', 'RISK_LINK', 'RISK_UNLINK')))
);
create index mbr_version_log_version on recipe.mbr_version_log (version_id, cycle);

create table recipe.mbr_risk_link (
  id                  uuid primary key default gen_random_uuid(),
  version_id          uuid not null references recipe.mbr_version (id),
  risk_assessment_id  uuid not null references recipe.risk_assessment (id),
  action              text not null check (action in ('LINK', 'UNLINK')),
  -- Parameter and calculation ids the assessment covers; empty means the whole master.
  subjects            text[] not null default '{}',
  person_id           uuid not null,
  account_id          uuid not null,
  recorded_at         timestamptz not null default clock_timestamp()
);
create index mbr_risk_link_version on recipe.mbr_risk_link (version_id, risk_assessment_id, recorded_at);

-- ---------------------------------------------------------------------------------------------
-- Reading helpers
-- ---------------------------------------------------------------------------------------------

-- The version's state in the platform state engine (NULL before the state row exists).
create function recipe.version_state(p_version uuid) returns text
language sql stable security definer set search_path = pg_catalog, recipe, platform, pg_temp as $$
  select s.state from platform.aggregate_state s where s.aggregate_type = 'mbr_version' and s.aggregate_id = p_version
$$;

-- The state the version was in at an instant (from the insert-only state history).
create function recipe.version_state_at(p_version uuid, p_at timestamptz) returns text
language sql stable security definer set search_path = pg_catalog, recipe, platform, pg_temp as $$
  select h.to_state from platform.state_history h
  where h.aggregate_type = 'mbr_version' and h.aggregate_id = p_version and h.recorded_at <= p_at
  order by h.to_version desc limit 1
$$;

-- True when the version reached APPROVED at some time (it may be RETIRED since).
create function recipe.version_was_approved(p_version uuid) returns boolean
language sql stable security definer set search_path = pg_catalog, recipe, platform, pg_temp as $$
  select exists (select 1 from platform.state_history h
                 where h.aggregate_type = 'mbr_version' and h.aggregate_id = p_version and h.to_state = 'APPROVED')
$$;

create function recipe.current_cycle(p_version uuid) returns integer
language sql stable security definer set search_path = pg_catalog, recipe, pg_temp as $$
  select coalesce(max(d.cycle), 1) from recipe.mbr_draft_entry d where d.version_id = p_version
$$;

create function recipe.current_content(p_version uuid) returns recipe.mbr_content
language sql stable security definer set search_path = pg_catalog, recipe, pg_temp as $$
  select c.* from recipe.mbr_content c where c.version_id = p_version order by c.revision desc limit 1
$$;

create function recipe.content_hash_of(p_version uuid) returns text
language sql stable security definer set search_path = pg_catalog, recipe, pg_temp as $$
  select c.content_hash from recipe.mbr_content c where c.version_id = p_version order by c.revision desc limit 1
$$;

-- Persons who edited the version's signed content since it last entered DRAFT (INV-04).
create function recipe.editors_since_draft(p_version uuid) returns uuid[]
language sql stable security definer set search_path = pg_catalog, recipe, pg_temp as $$
  select coalesce(array_agg(distinct l.person_id order by l.person_id), '{}')
  from recipe.mbr_version_log l
  where l.version_id = p_version and l.is_edit and l.cycle = recipe.current_cycle(p_version)
$$;

-- Risk assessments currently linked to a version: the latest action per assessment is LINK.
create function recipe.current_risk_links(p_version uuid)
returns table (risk_assessment_id uuid, code text, version text, risk_class text, rationale_ref text, subjects text[])
language sql stable security definer set search_path = pg_catalog, recipe, pg_temp as $$
  select a.id, a.code, a.version, a.risk_class, a.rationale_ref, l.subjects
  from (select distinct on (k.risk_assessment_id) k.risk_assessment_id, k.action, k.subjects
        from recipe.mbr_risk_link k where k.version_id = p_version
        order by k.risk_assessment_id, k.recorded_at desc, k.id desc) l
  join recipe.risk_assessment a on a.id = l.risk_assessment_id
  where l.action = 'LINK'
$$;

-- Batch sizes in canonical form: [{id, quantity: {value, unit}}] ordered by id, ids unique,
-- values positive decimal strings, units non-empty. Refuses anything else.
create function recipe.canonical_batch_sizes(p jsonb) returns jsonb
language plpgsql immutable set search_path = pg_catalog, recipe, pg_temp as $$
declare
  x jsonb;
begin
  if p is null or jsonb_typeof(p) <> 'array' or jsonb_array_length(p) = 0 then
    raise exception using errcode = 'P0001', message = 'A family needs at least one approved batch size (PR-01; EBMR-RCP-011)';
  end if;
  for x in select * from jsonb_array_elements(p) loop
    if jsonb_typeof(x) <> 'object' or coalesce(btrim(x ->> 'id'), '') = '' or jsonb_typeof(x -> 'quantity') is distinct from 'object'
       or not recipe.is_decimal(x -> 'quantity' ->> 'value') or (x -> 'quantity' ->> 'value')::numeric <= 0
       or coalesce(btrim(x -> 'quantity' ->> 'unit'), '') = ''
       or (select count(*) from jsonb_object_keys(x)) <> 2 or (select count(*) from jsonb_object_keys(x -> 'quantity')) <> 2 then
      raise exception using errcode = 'P0001',
        message = format('Batch size %s is not {id, quantity: {value, unit}} with a positive decimal value (PR-01; EBMR-RCP-011)', x);
    end if;
  end loop;
  if (select count(distinct e ->> 'id') from jsonb_array_elements(p) e) <> jsonb_array_length(p) then
    raise exception using errcode = 'P0001', message = 'Batch size ids must be unique within a family (PR-01; EBMR-RCP-011)';
  end if;
  return (select jsonb_agg(e order by e ->> 'id' collate "C") from jsonb_array_elements(p) e);
end
$$;

-- Why MBR content does not belong to its family (NULL when it does). The full shape of the content
-- is checked by the flow model's parser before saving; the database checks what the life cycle
-- relies on: format, family identity, batch-size set and the market set with India in it (INV-28).
create function recipe.content_family_problem(p_content jsonb, p_family recipe.mbr_family) returns text
language plpgsql stable set search_path = pg_catalog, recipe, pg_temp as $$
declare
  h jsonb := p_content -> 'header';
  v_sizes jsonb;
  v_markets text[];
begin
  if p_content ->> 'format' is distinct from 'ebmr.mbr-content' or p_content ->> 'formatVersion' is distinct from '1' then
    return 'the content is not ebmr.mbr-content format version 1';
  end if;
  if jsonb_typeof(h) is distinct from 'object' then
    return 'the content has no header';
  end if;
  if h ->> 'family' is distinct from p_family.code then
    return format('the header names family %s, not %s', h ->> 'family', p_family.code);
  end if;
  if h ->> 'edition' is distinct from p_family.edition or h ->> 'recordKind' is distinct from p_family.record_kind then
    return format('the header edition and record kind (%s, %s) differ from the family (%s, %s)', h ->> 'edition', h ->> 'recordKind',
                  p_family.edition, p_family.record_kind);
  end if;
  if h -> 'product' ->> 'code' is distinct from p_family.product_code or h -> 'product' ->> 'strength' is distinct from p_family.strength
     or h -> 'product' ->> 'dosageForm' is distinct from p_family.dosage_form then
    return format('the header product (%s, %s, %s) differs from the family (%s, %s, %s)', h -> 'product' ->> 'code',
                  h -> 'product' ->> 'strength', h -> 'product' ->> 'dosageForm', p_family.product_code, p_family.strength, p_family.dosage_form);
  end if;
  begin
    v_sizes := recipe.canonical_batch_sizes(h -> 'batchSizes');
  exception when others then
    return 'the header batch sizes are not valid';
  end;
  if v_sizes is distinct from p_family.batch_sizes then
    return 'the header batch sizes differ from the family''s approved batch-size set (PR-01)';
  end if;
  if jsonb_typeof(h -> 'marketSet') is distinct from 'array' then
    return 'the header has no market set';
  end if;
  v_markets := array(select jsonb_array_elements_text(h -> 'marketSet'));
  if cardinality(v_markets) = 0 or exists (select 1 from unnest(v_markets) m where m !~ '^[A-Z]{2}$')
     or cardinality(v_markets) <> (select count(distinct m) from unnest(v_markets) m) then
    return 'the market set must list distinct two-letter market codes';
  end if;
  if not ('IN' = any (v_markets)) then
    return 'India (IN) must be in every market set (INV-28)';
  end if;
  return null;
end
$$;

-- ---------------------------------------------------------------------------------------------
-- The version log: one row per change of the signed version data, written by triggers so that no
-- path can change a version without it.
-- ---------------------------------------------------------------------------------------------

create function recipe.log_version_event(p_version uuid, p_kind text, p_detail jsonb default '{}'::jsonb) returns void
language plpgsql volatile security definer set search_path = pg_catalog, recipe, kernel, pg_temp as $$
declare
  v_ctx jsonb := recipe.require_actor();
begin
  insert into recipe.mbr_version_log (version_id, cycle, kind, is_edit, person_id, account_id, detail)
  values (p_version, recipe.current_cycle(p_version), p_kind,
          p_kind in ('CREATED', 'CONTENT', 'EFFECTIVE_DATE', 'REVIEW_DUE', 'CHANGE_RECORD', 'RISK_LINK', 'RISK_UNLINK'),
          (v_ctx ->> 'person_id')::uuid, (v_ctx ->> 'account_id')::uuid, coalesce(p_detail, '{}'::jsonb));
end
$$;

-- The version's state, read with a share lock on its state row: a change that depends on the state
-- (a content revision, evidence, a draft attribute, a market activation) and a transition of the
-- version (which locks the row for update) never interleave.
create function recipe.version_state_locked(p_version uuid) returns text
language plpgsql volatile security definer set search_path = pg_catalog, recipe, platform, pg_temp as $$
declare
  v_state text;
begin
  select s.state into v_state from platform.aggregate_state s
  where s.aggregate_type = 'mbr_version' and s.aggregate_id = p_version
  for share;
  return v_state;
end
$$;

-- Refuses a change to a version that is not in DRAFT. A version without a state row is being created.
create function recipe.assert_draft(p_version uuid, p_what text) returns void
language plpgsql volatile security definer set search_path = pg_catalog, recipe, pg_temp as $$
declare
  v_state text := recipe.version_state_locked(p_version);
begin
  if v_state is not null and v_state <> 'DRAFT' then
    raise exception using errcode = 'P0001',
      message = format('This MBR version is %s: %s can change only in DRAFT; to change an approved master derive a new version (PR-06; EBMR-RCP-021)',
                       v_state, p_what);
  end if;
end
$$;

-- Families: insert-only, canonical batch sizes, attributed.
create function recipe.mbr_family_guard() returns trigger
language plpgsql security definer set search_path = pg_catalog, recipe, pg_temp as $$
declare
  v_ctx jsonb := recipe.require_actor();
begin
  new.batch_sizes := recipe.canonical_batch_sizes(new.batch_sizes);
  new.created_by_person := (v_ctx ->> 'person_id')::uuid;
  new.created_by_account := (v_ctx ->> 'account_id')::uuid;
  return new;
end
$$;
create trigger a1_guard before insert on recipe.mbr_family for each row execute function recipe.mbr_family_guard();

-- Versions: identity columns never change; draft attributes change only in DRAFT; each change is logged.
create function recipe.mbr_version_guard() returns trigger
language plpgsql security definer set search_path = pg_catalog, recipe, pg_temp as $$
declare
  v_ctx jsonb := recipe.require_actor();
begin
  if tg_op = 'INSERT' then
    new.author_person := (v_ctx ->> 'person_id')::uuid;
    new.author_account := (v_ctx ->> 'account_id')::uuid;
    return new;
  end if;
  if new.id <> old.id or new.family_id <> old.family_id or new.version_number <> old.version_number
     or new.author_person <> old.author_person or new.author_account <> old.author_account
     or new.derived_from is distinct from old.derived_from or new.recorded_at <> old.recorded_at then
    raise exception using errcode = 'P0001',
      message = 'The identity of an MBR version (family, number, author, predecessor) never changes (PR-05; EBMR-RCP-024)';
  end if;
  perform recipe.assert_draft(old.id, 'the change record, effective date and review due date');
  return new;
end
$$;
create trigger a1_guard before insert or update on recipe.mbr_version for each row execute function recipe.mbr_version_guard();

create function recipe.mbr_version_after_update() returns trigger
language plpgsql security definer set search_path = pg_catalog, recipe, pg_temp as $$
begin
  if new.effective_from is distinct from old.effective_from then
    perform recipe.log_version_event(new.id, 'EFFECTIVE_DATE', jsonb_build_object('old', recipe.utc_text(old.effective_from), 'new', recipe.utc_text(new.effective_from)));
  end if;
  if new.review_due is distinct from old.review_due then
    perform recipe.log_version_event(new.id, 'REVIEW_DUE', jsonb_build_object('old', old.review_due, 'new', new.review_due));
  end if;
  if new.change_record_id is distinct from old.change_record_id then
    perform recipe.log_version_event(new.id, 'CHANGE_RECORD', jsonb_build_object('old', old.change_record_id, 'new', new.change_record_id));
  end if;
  return null;
end
$$;
create trigger b1_log after update on recipe.mbr_version for each row execute function recipe.mbr_version_after_update();
create trigger aa_no_delete before delete on recipe.mbr_version for each row execute function kernel.reject_mutation();
create trigger aa_no_truncate before truncate on recipe.mbr_version for each statement execute function kernel.reject_mutation();

-- Content revisions: only in DRAFT; the hash is recomputed by the database and must match; the
-- header must belong to the family; the next revision number and the editor are set here.
create function recipe.mbr_content_guard() returns trigger
language plpgsql security definer set search_path = pg_catalog, recipe, pg_temp as $$
declare
  v_ctx     jsonb := recipe.require_actor();
  v_ver     recipe.mbr_version;
  v_fam     recipe.mbr_family;
  v_hash    text;
  v_problem text;
begin
  select * into v_ver from recipe.mbr_version where id = new.version_id for update;
  if not found then
    raise exception using errcode = 'P0001', message = format('Unknown MBR version %s (EBMR-RCP-020)', new.version_id);
  end if;
  perform recipe.assert_draft(new.version_id, 'its content');
  if recipe.version_state(new.version_id) is null and exists (select 1 from recipe.mbr_content c where c.version_id = new.version_id) then
    raise exception using errcode = 'P0001', message = 'A version under creation has exactly one initial content revision (EBMR-RCP-020)';
  end if;
  new.revision := coalesce((select max(c.revision) from recipe.mbr_content c where c.version_id = new.version_id), 0) + 1;
  v_hash := recipe.json_hash(new.content);
  if new.content_hash is distinct from v_hash then
    raise exception using errcode = 'P0001',
      message = format('The content hash %s does not match the canonical hash %s computed by the database; nothing was saved (DI-04; EBMR-RCP-022)',
                       coalesce(new.content_hash, '(none)'), v_hash);
  end if;
  select * into v_fam from recipe.mbr_family where id = v_ver.family_id;
  v_problem := recipe.content_family_problem(new.content, v_fam);
  if v_problem is not null then
    raise exception using errcode = 'P0001', message = format('The content does not belong to family %s: %s (EBMR-RCP-023)', v_fam.code, v_problem);
  end if;
  new.edited_by_person := (v_ctx ->> 'person_id')::uuid;
  new.edited_by_account := (v_ctx ->> 'account_id')::uuid;
  return new;
end
$$;
create trigger a1_guard before insert on recipe.mbr_content for each row execute function recipe.mbr_content_guard();

-- Any edit of the content voids the verification evidence gathered on the version (outline 5.2.1;
-- DI-04). Evidence tables are created in 0120; this trigger function is created there too.

create function recipe.mbr_draft_entry_guard() returns trigger
language plpgsql security definer set search_path = pg_catalog, recipe, pg_temp as $$
declare
  v_ctx jsonb := recipe.require_actor();
begin
  perform 1 from recipe.mbr_version where id = new.version_id for update;
  new.cycle := coalesce((select max(d.cycle) from recipe.mbr_draft_entry d where d.version_id = new.version_id), 0) + 1;
  if new.cycle = 1 then
    new.from_state := null;
  elsif new.from_state is null then
    raise exception using errcode = 'P0001', message = 'A return to DRAFT names the state it returns from (EBMR-RCP-026)';
  end if;
  new.person_id := (v_ctx ->> 'person_id')::uuid;
  new.account_id := (v_ctx ->> 'account_id')::uuid;
  new.reason_code := v_ctx ->> 'reason_code';
  new.reason_text := v_ctx ->> 'reason_text';
  new.xact_id := txid_current();
  return new;
end
$$;
create trigger a1_guard before insert on recipe.mbr_draft_entry for each row execute function recipe.mbr_draft_entry_guard();

create function recipe.mbr_draft_entry_after() returns trigger
language plpgsql security definer set search_path = pg_catalog, recipe, pg_temp as $$
begin
  if new.cycle > 1 then
    perform recipe.log_version_event(new.version_id, 'DRAFT_ENTRY', jsonb_build_object('cycle', new.cycle, 'from_state', new.from_state));
  end if;
  return null;
end
$$;
create trigger b1_log after insert on recipe.mbr_draft_entry for each row execute function recipe.mbr_draft_entry_after();

create function recipe.mbr_risk_link_guard() returns trigger
language plpgsql security definer set search_path = pg_catalog, recipe, pg_temp as $$
declare
  v_ctx jsonb := recipe.require_actor();
begin
  perform 1 from recipe.mbr_version where id = new.version_id for update;
  perform recipe.assert_draft(new.version_id, 'its risk-assessment links');
  if exists (select 1 from unnest(new.subjects) s where coalesce(btrim(s), '') = '') then
    raise exception using errcode = 'P0001', message = 'Risk-assessment subjects are parameter or calculation ids (PR-07; EBMR-RCP-061)';
  end if;
  new.subjects := array(select distinct s from unnest(new.subjects) s order by s);
  new.person_id := (v_ctx ->> 'person_id')::uuid;
  new.account_id := (v_ctx ->> 'account_id')::uuid;
  return new;
end
$$;
create trigger a1_guard before insert on recipe.mbr_risk_link for each row execute function recipe.mbr_risk_link_guard();

create function recipe.mbr_risk_link_after() returns trigger
language plpgsql security definer set search_path = pg_catalog, recipe, pg_temp as $$
begin
  perform recipe.log_version_event(new.version_id, case new.action when 'LINK' then 'RISK_LINK' else 'RISK_UNLINK' end,
                                   jsonb_build_object('risk_assessment_id', new.risk_assessment_id, 'subjects', to_jsonb(new.subjects)));
  return null;
end
$$;
create trigger b1_log after insert on recipe.mbr_risk_link for each row execute function recipe.mbr_risk_link_after();

-- Stamp the recorder of QMS stand-in rows from the actor.
create function recipe.stamp_recorder() returns trigger
language plpgsql security definer set search_path = pg_catalog, recipe, pg_temp as $$
declare
  v_ctx jsonb := recipe.require_actor();
begin
  new.recorded_by_person := (v_ctx ->> 'person_id')::uuid;
  new.recorded_by_account := (v_ctx ->> 'account_id')::uuid;
  return new;
end
$$;
create trigger a1_stamp before insert on recipe.change_record for each row execute function recipe.stamp_recorder();
create trigger a1_stamp before insert on recipe.change_record_validation for each row execute function recipe.stamp_recorder();
create trigger a1_stamp before insert on recipe.change_record_regulatory for each row execute function recipe.stamp_recorder();
create trigger a1_stamp before insert on recipe.risk_assessment for each row execute function recipe.stamp_recorder();

-- ---------------------------------------------------------------------------------------------
-- Database time, audit registration, privileges
-- ---------------------------------------------------------------------------------------------

select platform.enforce_db_time('recipe.change_record', array['recorded_at']);
select platform.enforce_db_time('recipe.change_record_validation', array['recorded_at']);
select platform.enforce_db_time('recipe.change_record_regulatory', array['recorded_at']);
select platform.enforce_db_time('recipe.risk_assessment', array['recorded_at']);
select platform.enforce_db_time('recipe.mbr_family', array['recorded_at']);
select platform.enforce_db_time('recipe.mbr_version', array['recorded_at']);
select platform.enforce_db_time('recipe.mbr_content', array['recorded_at']);
select platform.enforce_db_time('recipe.mbr_draft_entry', array['recorded_at']);
select platform.enforce_db_time('recipe.mbr_version_log', array['recorded_at']);
select platform.enforce_db_time('recipe.mbr_risk_link', array['recorded_at']);

select kernel.register_audited_table('recipe.change_record', 'mbr_change_record', 'id', true);
select kernel.register_audited_table('recipe.change_record_validation', 'mbr_change_record', 'change_record_id', true);
select kernel.register_audited_table('recipe.change_record_regulatory', 'mbr_change_record', 'change_record_id', true);
select kernel.register_audited_table('recipe.risk_assessment', 'mbr_risk_assessment', 'id', true);
select kernel.register_audited_table('recipe.mbr_family', 'mbr_family', 'id', true);
-- The version row carries the draft attributes (UPDATE, audited with old and new values and a reason).
select kernel.register_audited_table('recipe.mbr_version', 'mbr_version', 'id', false);
select kernel.register_audited_table('recipe.mbr_content', 'mbr_version', 'version_id', true);
select kernel.register_audited_table('recipe.mbr_draft_entry', 'mbr_version', 'version_id', true);
select kernel.register_audited_table('recipe.mbr_version_log', 'mbr_version', 'version_id', true);
select kernel.register_audited_table('recipe.mbr_risk_link', 'mbr_version', 'version_id', true);

grant select on recipe.change_record, recipe.change_record_validation, recipe.change_record_regulatory, recipe.risk_assessment,
                recipe.mbr_family, recipe.mbr_version, recipe.mbr_content, recipe.mbr_draft_entry, recipe.mbr_version_log,
                recipe.mbr_risk_link to ebmr_app;
grant execute on function recipe.version_state(uuid), recipe.version_state_at(uuid, timestamptz), recipe.version_was_approved(uuid),
                          recipe.current_cycle(uuid), recipe.current_content(uuid), recipe.content_hash_of(uuid),
                          recipe.editors_since_draft(uuid), recipe.current_risk_links(uuid), recipe.canonical_batch_sizes(jsonb),
                          recipe.content_family_problem(jsonb, recipe.mbr_family) to ebmr_app;

reset role;
