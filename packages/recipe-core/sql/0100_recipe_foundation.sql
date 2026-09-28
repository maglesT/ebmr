-- Recipe core, MBR life cycle (module A3), part 1: the recipe schema, shared helpers and the
-- permission catalogue entries the life cycle needs.
--
-- Build outline 5.2.1 (MBR version machine, per-market effectivity), 5.2.2 (what batch issue needs),
-- 3.3.3-3.3.5, 5.8, 6.5, 7.1-7.2; ADR 0010, 0011 (recipe-core applied to each edition database's
-- recipe schema), 0012 (privilege separation), 0014 (per-market effectivity), 0016 (validated actor,
-- definer hardening). Controls PR-02, PR-04, PR-05, PR-06, PR-07, DI-04 (life-cycle part);
-- invariants INV-01, INV-02, INV-04, INV-17.
--
-- Privileges: the application role (ebmr_app) reads the recipe tables and writes nothing directly.
-- Every write is a SECURITY DEFINER function that first refuses administrators
-- (iam.assert_not_administrator, DI-18) and then checks the permission (iam.require_permission,
-- DI-17). State changes of MBR versions go only through the platform state engine
-- (platform.transition) along the published machine mbr_version (migration 0140, generated).
--
-- Messages are plain language first, then the rule or control and the code EBMR-RCP-NNN:
--   001-009 actor and generic        010-019 families            020-039 versions and content
--   040-059 verification evidence    060-069 change control      070-079 dispositions and reviews
--   080-099 market authorisation     100-119 selection, pin, control recipe
--   120-129 stub batches

create schema if not exists recipe authorization ebmr_owner;
revoke all on schema recipe from public;
grant usage on schema recipe to ebmr_app;

-- GiST support for plain equality in exclusion constraints (INV-17: no two CURRENT validities of
-- one family, market and scope overlap in time). A trusted extension; idempotent.
create extension if not exists btree_gist with schema public;

set local role ebmr_owner;

-- ---------------------------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------------------------

-- The validated actor of the current command, or a refusal.
create function recipe.require_actor() returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, recipe, kernel, pg_temp as $$
declare
  v jsonb := kernel.current_actor();
begin
  if v is null then
    raise exception using errcode = 'P0001',
      message = 'No validated command: every recipe change runs inside a command started with kernel.begin_command (INV-07; EBMR-RCP-001)';
  end if;
  return v;
end
$$;

-- The audit trigger needs a reason for every UPDATE of an audited row. Life-cycle updates made by
-- these functions (a draft attribute, a superseded authorisation cell, a stub batch status) carry
-- the command's own reason, or when it gave none a fixed reason naming the act. Returns the
-- original context so the caller can restore it with recipe.restore_actor.
create function recipe.push_reason(p_code text, p_text text) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, recipe, kernel, pg_temp as $$
declare
  v jsonb := recipe.require_actor();
begin
  if coalesce(v ->> 'reason_code', '') = '' then
    perform kernel.set_actor_context(v || jsonb_build_object('reason_code', p_code, 'reason_text', p_text));
  end if;
  return v;
end
$$;

create function recipe.restore_actor(p_ctx jsonb) returns void
language plpgsql volatile security definer set search_path = pg_catalog, recipe, kernel, pg_temp as $$
begin
  perform kernel.set_actor_context(p_ctx);
end
$$;

-- An instant as UTC text with microseconds, independent of the session time zone.
create function recipe.utc_text(p timestamptz) returns text
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select case when p is null then null else to_char(p at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') end
$$;

-- The site calendar date now (the site zone of the installation, iam policy site.zone).
create function recipe.site_today() returns date
language sql volatile security definer set search_path = pg_catalog, recipe, iam, pg_temp as $$
  select (clock_timestamp() at time zone iam.policy_text('site.zone'))::date
$$;

-- SHA-256 of the canonical JSON of a value (the same rules as esig.canonical_json and the
-- TypeScript canonicalJson, so the MBR content hash is identical in both).
create function recipe.json_hash(p jsonb) returns text
language sql immutable strict set search_path = pg_catalog, esig, pg_temp as $$
  select esig.sha256_hex(esig.canonical_json(p))
$$;

-- A decimal literal as written in MBR content ("95.0", "-2", ".5" is refused): GMP values travel as
-- strings and are compared as numeric, never as binary floating point.
create function recipe.is_decimal(p text) returns boolean
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select coalesce(p ~ '^-?[0-9]+(\.[0-9]+)?$', false)
$$;

-- ---------------------------------------------------------------------------------------------
-- Permission catalogue (DI-17). The MBR permissions MBR.AUTHOR, MBR.SIGN_PREPARED, MBR.CHECK,
-- MBR.APPROVE, MBR.REGULATORY_CONFIRM and BATCH.ISSUE exist in the identity catalogue (0120) and
-- are reused. One permission is new: recording the change-control and risk-assessment references
-- that stand in for the QMS in Phase 2. Rows are written under the software-release identity, like
-- kernel 0700, so they are in the hash-chained audit trail.
-- ---------------------------------------------------------------------------------------------

select kernel.set_actor_context(jsonb_build_object(
  'person_id', '00000000-0000-0000-0000-000000000000', 'account_id', '00000000-0000-0000-0000-000000000000',
  'role_code', 'SOFTWARE_RELEASE', 'session_id', '00000000-0000-0000-0000-000000000000', 'source', 'SYSTEM',
  'site_zone', 'UTC', 'correlation_id', gen_random_uuid(),
  'legal_name', 'Software release (recipe-core migration 0100_recipe_foundation)',
  'reason_code', 'SOFTWARE_RELEASE',
  'reason_text', 'permission catalogue entries of the MBR life cycle (DI-17, PR-06, PR-07)'));

insert into iam.permission (code, domain, effect, description) values
  ('MBR.CHANGE_RECORD', 'GMP', 'WRITE',
   'Record the change-control records (validation link, regulatory assessment per market) and risk assessments MBR versions cite (QMS stand-in)');

insert into iam.role_permission (role_code, permission_code) values
  ('QA_MBR_APPROVER', 'MBR.CHANGE_RECORD'),
  ('REGULATORY_SIGNER', 'MBR.CHANGE_RECORD');

select kernel.set_actor_context(null);

grant execute on function recipe.utc_text(timestamptz), recipe.json_hash(jsonb), recipe.is_decimal(text), recipe.site_today() to ebmr_app;
-- require_actor, push_reason and restore_actor stay private to the owner.

reset role;
