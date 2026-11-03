-- Recipe core, decision 0026 slice S3: the library of block definitions (blocks as data, QA-approved and versioned).
--
-- Handbook: modules/recipe-core.md
--
--   recipe.library_block           insert-only, audited: one version of a library block definition (code, version,
--                                  title, category, the definition as JSON and its content hash). Versions count up per
--                                  code. The definition's own code and version must match the row, and content_hash is
--                                  recipe.json_hash(definition): the same canonical hash the formulation pins (S1
--                                  definitionHash). The application checks the definition's form before it is stored
--                                  (recipe-core library/checkBlockDefinition); the database keeps the shape, the hash,
--                                  the version order and who may do what.
--   recipe.library_block_approval  insert-only, audited: QA's LIBRARY_BLOCK_APPROVED signature over the version, never by
--                                  the person who drafted it (the meaning excludes performers; the command checks it too).
--   recipe.library_block_retirement  insert-only, audited: an approved version retired with a reason (no new formulation
--                                  may use it; formulations that pinned it keep their pin, S9).
--   recipe.library_block_state(id) DRAFT, APPROVED or RETIRED.
--   recipe.draft_library_block(definition)    MBR.AUTHOR: stores the next version of the definition's code.
--   recipe.approve_library_block(id, sig)      MBR.APPROVE, signed LIBRARY_BLOCK_APPROVED, never the drafter.
--   recipe.retire_library_block(id, reason)    MBR.APPROVE: retires an approved version.
-- Owner decision O-9 (b): the database stores calculated figures with their evaluation record and does not recompute
-- them; the check of entered values against a formulation's limits joins the execution store in S4.
-- Messages EBMR-LIB-001 to EBMR-LIB-019.

set local role ebmr_owner;

create table recipe.library_block (
  id                  uuid primary key default gen_random_uuid(),
  code                text not null check (code ~ '^[A-Z][A-Z0-9-]{1,39}$'),
  version             integer not null check (version >= 1),
  title               text not null check (title ~ '^[^\s].{0,199}$'),
  category            text not null check (category in ('PROCESS', 'COATING', 'TEST_IPC', 'TEST_RELEASE', 'CONTROL', 'PACKAGING')),
  definition          jsonb not null check (jsonb_typeof(definition) = 'object'),
  content_hash        text not null check (content_hash ~ '^[0-9a-f]{64}$'),
  drafted_by_person   uuid not null,
  drafted_by_account  uuid not null,
  drafted_at          timestamptz not null default clock_timestamp(),
  correlation_id      uuid not null,
  unique (code, version)
);
revoke all on recipe.library_block from public;

create table recipe.library_block_approval (
  block_id            uuid primary key references recipe.library_block (id),
  signature_id        uuid not null unique,
  approved_by_person  uuid not null,
  approved_by_account uuid not null,
  approved_at         timestamptz not null default clock_timestamp()
);
revoke all on recipe.library_block_approval from public;

create table recipe.library_block_retirement (
  block_id            uuid primary key references recipe.library_block_approval (block_id),
  reason              text not null check (reason ~ '^[^\s]' and char_length(reason) <= 2000),
  retired_by_person   uuid not null,
  retired_by_account  uuid not null,
  retired_at          timestamptz not null default clock_timestamp(),
  correlation_id      uuid not null
);
revoke all on recipe.library_block_retirement from public;

-- The row and its definition agree, and the hash is the canonical hash of the definition (S1 definitionHash).
create function recipe.library_block_guard() returns trigger
language plpgsql security definer set search_path = pg_catalog, recipe, pg_temp as $$
begin
  if new.definition ->> 'code' is distinct from new.code or (new.definition -> 'version') is distinct from to_jsonb(new.version)
     or new.definition ->> 'title' is distinct from new.title or new.definition ->> 'category' is distinct from new.category then
    raise exception using errcode = 'P0001', message = 'EBMR-LIB-001 the definition''s code, version, title and category must match the library row';
  end if;
  if jsonb_typeof(new.definition -> 'sections') is distinct from 'array' or jsonb_array_length(new.definition -> 'sections') = 0
     or jsonb_typeof(new.definition -> 'signatures') is distinct from 'array' then
    raise exception using errcode = 'P0001', message = 'EBMR-LIB-001 a library block has at least one section and a list of signatures (PR-03)';
  end if;
  if new.content_hash is distinct from recipe.json_hash(new.definition) then
    raise exception using errcode = 'P0001', message = 'EBMR-LIB-002 content_hash is not the canonical hash of the definition (PR-05)';
  end if;
  return new;
end
$$;
create trigger a1_library_block_guard before insert on recipe.library_block for each row execute function recipe.library_block_guard();

select platform.enforce_db_time('recipe.library_block', array['drafted_at']);
select platform.enforce_db_time('recipe.library_block_approval', array['approved_at']);
select platform.enforce_db_time('recipe.library_block_retirement', array['retired_at']);
select kernel.register_audited_table('recipe.library_block', 'library_block', 'id', true);
select kernel.register_audited_table('recipe.library_block_approval', 'library_block', 'block_id', true);
select kernel.register_audited_table('recipe.library_block_retirement', 'library_block', 'block_id', true);

-- DRAFT, APPROVED or RETIRED; NULL for an unknown id.
create function recipe.library_block_state(p_id uuid) returns text
language sql stable security definer set search_path = pg_catalog, recipe, pg_temp as $$
  select case when exists (select 1 from recipe.library_block_retirement r where r.block_id = b.id) then 'RETIRED'
              when exists (select 1 from recipe.library_block_approval a where a.block_id = b.id) then 'APPROVED'
              else 'DRAFT' end
  from recipe.library_block b where b.id = p_id
$$;

-- What LIBRARY_BLOCK_APPROVED covers: the definition and its hash.
create function recipe.library_block_content(p_id text) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, recipe, pg_temp as $$
declare
  b recipe.library_block;
begin
  if coalesce(p_id, '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return '{"exists": false}'::jsonb;
  end if;
  select * into b from recipe.library_block where id = p_id::uuid;
  if not found then
    return '{"exists": false}'::jsonb;
  end if;
  return jsonb_build_object(
    'exists', true,
    'content_version', 1,
    'content', jsonb_build_object('code', b.code, 'version', b.version, 'title', b.title, 'category', b.category,
                                  'content_hash', b.content_hash, 'definition', b.definition,
                                  'drafted_by', b.drafted_by_person, 'drafted_at', recipe.utc_text(b.drafted_at)),
    'state', recipe.library_block_state(b.id),
    'scope', '{}'::jsonb,
    'entered_by', jsonb_build_array(b.drafted_by_person));
end
$$;

select kernel.set_actor_context(jsonb_build_object(
  'person_id', '00000000-0000-0000-0000-000000000000', 'account_id', '00000000-0000-0000-0000-000000000000',
  'role_code', 'SOFTWARE_RELEASE', 'session_id', '00000000-0000-0000-0000-000000000000', 'source', 'SYSTEM',
  'site_zone', 'UTC', 'correlation_id', gen_random_uuid(),
  'legal_name', 'Software release (recipe-core migration 1800_library_blocks)',
  'reason_code', 'SOFTWARE_RELEASE',
  'reason_text', 'the library of block definitions and its QA approval (decision 0026, slice S3; PR-03, PR-05, DI-35)'));

select esig.register_content_provider('library_block', 'recipe.library_block_content(text)',
  'A library block definition: its sections, typed fields, signatures and reference limits, with its content hash (decision 0026)');

insert into esig.meaning_type (code, version, origin, is_minimum, status, category, role_class, title, meaning_text, permissions,
                               independent_of, excludes_performers, excludes_involved, witness, reauth, delegable, sources)
values
  ('LIBRARY_BLOCK_APPROVED', 1, 'VENDOR', true, 'ACTIVE', 'MASTER_RECORD', 'APPROVER', 'Library block approved',
   'Quality-unit approval: I approve this library block definition, its fields, limits slots and signatures as shown, for use in formulations.',
   array['MBR.APPROVE'], '{}', true, false, false, 'ALL_COMPONENTS', false, 'Decision 0026; US 211.186(a); EU Ch.4 4.3; DI-35; PR-05');

select kernel.set_actor_context(null);

-- MBR.AUTHOR: stores the next version of the definition's code; the version in the definition must be that next
-- version (the author's tool sets it). Returns {blockId, code, version, contentHash}.
create function recipe.draft_library_block(p jsonb) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, recipe, iam, pg_temp as $$
declare
  v_actor jsonb;
  v_code  text;
  v_ver   integer;
  v_id    uuid;
begin
  perform iam.assert_not_administrator();
  v_actor := iam.require_permission('MBR.AUTHOR', '{}'::jsonb);
  if jsonb_typeof(p) is distinct from 'object' or coalesce(p ->> 'code', '') !~ '^[A-Z][A-Z0-9-]{1,39}$'
     or jsonb_typeof(p -> 'version') is distinct from 'number' then
    raise exception using errcode = 'P0001', message = 'EBMR-LIB-003 a library block definition names its code (upper-case letters, digits, hyphens) and its version (PR-03)';
  end if;
  v_code := p ->> 'code';
  perform pg_advisory_xact_lock(hashtext('recipe.library_block:' || v_code));
  select coalesce(max(b.version), 0) + 1 into v_ver from recipe.library_block b where b.code = v_code;
  if (p ->> 'version') is distinct from v_ver::text then
    raise exception using errcode = 'P0001',
      message = format('EBMR-LIB-004 the next version of %s is %s, not %s; each change is a new version (PR-05)', v_code, v_ver, p ->> 'version');
  end if;
  insert into recipe.library_block (code, version, title, category, definition, content_hash, drafted_by_person, drafted_by_account, correlation_id)
  values (v_code, v_ver, p ->> 'title', p ->> 'category', p, recipe.json_hash(p), (v_actor ->> 'person_id')::uuid, (v_actor ->> 'account_id')::uuid,
          (v_actor ->> 'correlation_id')::uuid)
  returning id into v_id;
  return jsonb_build_object('blockId', v_id, 'code', v_code, 'version', v_ver, 'contentHash', recipe.json_hash(p));
end
$$;

-- MBR.APPROVE: QA's signed approval, never by the drafter (DI-35).
create function recipe.approve_library_block(p_id uuid, p_signature uuid) returns void
language plpgsql volatile security definer set search_path = pg_catalog, recipe, iam, esig, pg_temp as $$
declare
  v_actor jsonb;
  b       recipe.library_block;
  v_prob  text;
begin
  perform iam.assert_not_administrator();
  v_actor := iam.require_permission('MBR.APPROVE', '{}'::jsonb);
  select * into b from recipe.library_block where id = p_id;
  if not found then
    raise exception using errcode = 'P0001', message = format('EBMR-LIB-005 unknown library block %s', coalesce(p_id::text, 'NULL'));
  end if;
  perform pg_advisory_xact_lock(hashtext('recipe.library_block:' || b.code));
  if recipe.library_block_state(b.id) <> 'DRAFT' then
    raise exception using errcode = 'P0001', message = format('EBMR-LIB-006 %s version %s is %s; only a draft is approved', b.code, b.version, recipe.library_block_state(b.id));
  end if;
  if b.drafted_by_person = (v_actor ->> 'person_id')::uuid then
    raise exception using errcode = 'P0001', message = 'EBMR-LIB-007 a library block is approved by another person than its author (DI-35; decision 0026)';
  end if;
  perform esig.assert_signature(p_signature, 'LIBRARY_BLOCK_APPROVED', 'library_block', b.id::text);
  v_prob := esig.signature_state_problem(p_signature);
  if v_prob is not null then
    raise exception using errcode = 'P0001', message = 'EBMR-LIB-007 ' || v_prob;
  end if;
  if (select g.signer_person from esig.signature g where g.id = p_signature)::text is distinct from v_actor ->> 'person_id' then
    raise exception using errcode = 'P0001', message = 'EBMR-LIB-007 the approval is recorded by the person who signed it';
  end if;
  insert into recipe.library_block_approval (block_id, signature_id, approved_by_person, approved_by_account)
  values (b.id, p_signature, (v_actor ->> 'person_id')::uuid, (v_actor ->> 'account_id')::uuid);
end
$$;

-- MBR.APPROVE: retires an approved version with a reason. Returns the state.
create function recipe.retire_library_block(p_id uuid, p_reason text) returns text
language plpgsql volatile security definer set search_path = pg_catalog, recipe, iam, pg_temp as $$
declare
  v_actor jsonb;
  b       recipe.library_block;
begin
  perform iam.assert_not_administrator();
  v_actor := iam.require_permission('MBR.APPROVE', '{}'::jsonb);
  select * into b from recipe.library_block where id = p_id;
  if not found then
    raise exception using errcode = 'P0001', message = format('EBMR-LIB-005 unknown library block %s', coalesce(p_id::text, 'NULL'));
  end if;
  if coalesce(btrim(p_reason), '') = '' then
    raise exception using errcode = 'P0001', message = 'EBMR-LIB-008 a retirement states its reason (DI-22)';
  end if;
  perform pg_advisory_xact_lock(hashtext('recipe.library_block:' || b.code));
  if recipe.library_block_state(b.id) <> 'APPROVED' then
    raise exception using errcode = 'P0001', message = format('EBMR-LIB-008 %s version %s is %s; only an approved version is retired', b.code, b.version, recipe.library_block_state(b.id));
  end if;
  insert into recipe.library_block_retirement (block_id, reason, retired_by_person, retired_by_account, correlation_id)
  values (b.id, btrim(p_reason), (v_actor ->> 'person_id')::uuid, (v_actor ->> 'account_id')::uuid, (v_actor ->> 'correlation_id')::uuid);
  return 'RETIRED';
end
$$;

revoke all on recipe.library_block, recipe.library_block_approval, recipe.library_block_retirement from ebmr_app;
grant select on recipe.library_block, recipe.library_block_approval, recipe.library_block_retirement to ebmr_app;
grant execute on function recipe.draft_library_block(jsonb), recipe.approve_library_block(uuid, uuid), recipe.retire_library_block(uuid, text),
                          recipe.library_block_state(uuid) to ebmr_app;

reset role;
