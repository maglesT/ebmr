-- Phase 7 slice 7g-4 (decision 0025 point 2): the first-run set-up of a new installation from the browser, instead of
-- the set-up command line. The database stays the enforcement point; the server's set-up route only calls it.
--
-- Handbook: modules/kernel.md
--
--   iam.setup_token                 the SHA-256 of the one-time set-up token the installer printed (tools/install). Never
--                                   the token itself. Owner only: nobody but the owner's code reads or writes it.
--   iam.issue_setup_token(sha256, minutes)
--                                   owner only (the installer, as the database owner): replaces any unused token by this
--                                   one, valid for 5 to 10080 minutes. Refused once the installation is set up
--                                   (EBMR-SETUP-001).
--   iam.setup_state()               {bootstrapped, tokenIssued, zone, site}: what the set-up screen may show before
--                                   anyone signs in (no names, no token).
--   iam.first_run_setup(token, def) the browser's set-up: the token must hash to an unused, unexpired token
--                                   (EBMR-SETUP-002), then the site (code and name, EBMR-SETUP-003), the site time zone
--                                   the screen showed, which must be the policy's (site.zone, DI-27; EBMR-SETUP-006),
--                                   and the first system administrator and process owner, two different persons
--                                   (EBMR-SETUP-004), through
--                                   iam.bootstrap_installation (kernel 0180, 1000: its own checks, EBMR-IAM-190 once
--                                   bootstrapped), and optionally the seal key the server generated (esig.seal_key: the
--                                   key's id and algorithm, never its secret), registered for the administrator. The
--                                   token is used up in the same transaction: a refused set-up leaves it unused.
--   iam.installation_site           the site's code and name, recorded once by the set-up (insert-only, audited).
--
-- Every write here is made under the installation pipeline's context (as the bootstrap's own), with the reason
-- FIRST_RUN_SETUP: no person is signed in yet. The first passwords are BOOTSTRAP credentials, which must be changed at
-- the first sign-in (kernel 0150).
--
-- The set-up does not change the site's time zone (D-P7g4-3): site.zone is configuration (area IAM_POLICY, kernel
-- 1195), changed only under an approved change record (DI-09), and no quality unit exists to approve one before the
-- set-up. The screen shows the zone in force and the set-up confirms it; the process owner changes it afterwards under
-- a change record, before the first GMP record.
--
-- Messages: EBMR-SETUP-001 to EBMR-SETUP-006.

set local role ebmr_owner;

create table iam.setup_token (
  token_sha256  text primary key check (token_sha256 ~ '^[0-9a-f]{64}$'),
  issued_at     timestamptz not null default clock_timestamp(),
  expires_at    timestamptz not null,
  consumed_at   timestamptz,
  check (expires_at > issued_at),
  check (consumed_at is null or consumed_at >= issued_at)
);
revoke all on iam.setup_token from public;

create table iam.installation_site (
  singleton    boolean primary key default true check (singleton),
  site_code    text not null check (site_code ~ '^[A-Z0-9][A-Z0-9_-]{0,31}$'),
  site_name    text not null check (btrim(site_name) <> '' and length(site_name) <= 200),
  recorded_at  timestamptz not null default clock_timestamp()
);
revoke all on iam.installation_site from public;
grant select on iam.installation_site to ebmr_app;
select kernel.register_audited_table('iam.installation_site', 'installation_site', 'site_code', true);
select platform.enforce_db_time('iam.installation_site', array['recorded_at']);

-- True once the bootstrap ran (the test of iam.bootstrap_installation itself, EBMR-IAM-190).
create function iam.is_bootstrapped() returns boolean
language sql stable security definer set search_path = pg_catalog, iam, pg_temp as $$
  select exists (select 1 from iam.role_grant where status in ('APPROVED', 'REVOKED'))
$$;
revoke all on function iam.is_bootstrapped() from public;
grant execute on function iam.is_bootstrapped() to ebmr_app;

create function iam.issue_setup_token(p_sha256 text, p_valid_minutes integer) returns void
language plpgsql volatile security definer set search_path = pg_catalog, iam, pg_temp as $$
begin
  if iam.is_bootstrapped() then
    raise exception using errcode = 'P0001',
      message = 'EBMR-SETUP-001 the installation is already set up: a set-up token is issued only before the first administrator exists';
  end if;
  if p_sha256 is null or p_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = 'P0001', message = 'EBMR-SETUP-003 a set-up token is stored as its SHA-256 (64 lowercase hex digits)';
  end if;
  if p_valid_minutes is null or p_valid_minutes < 5 or p_valid_minutes > 10080 then
    raise exception using errcode = 'P0001', message = 'EBMR-SETUP-003 a set-up token is valid for 5 minutes to 7 days';
  end if;
  delete from iam.setup_token where consumed_at is null;
  insert into iam.setup_token (token_sha256, expires_at) values (p_sha256, clock_timestamp() + make_interval(mins => p_valid_minutes));
end
$$;
revoke all on function iam.issue_setup_token(text, integer) from public;

create function iam.setup_state() returns jsonb
language sql stable security definer set search_path = pg_catalog, iam, pg_temp as $$
  select jsonb_build_object(
    'bootstrapped', iam.is_bootstrapped(),
    'tokenIssued', exists (select 1 from iam.setup_token t where t.consumed_at is null and t.expires_at > clock_timestamp()),
    'zone', iam.policy_text('site.zone'),
    'site', (select jsonb_build_object('code', s.site_code, 'name', s.site_name) from iam.installation_site s))
$$;
revoke all on function iam.setup_state() from public;
grant execute on function iam.setup_state() to ebmr_app;

-- p_def: {site: {code, name, zone}, administrator: {legalName, loginName, verifier, console},
--         processOwner: {legalName, loginName, verifier, console}, sealKey?: {keyId, algorithm, publicKey?}}
create function iam.first_run_setup(p_token text, p_def jsonb) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, iam, kernel, pg_temp as $$
declare
  v_nil    uuid := '00000000-0000-0000-0000-000000000000';
  v_hash   text;
  v_site   jsonb := p_def -> 'site';
  v_adm    jsonb := p_def -> 'administrator';
  v_own    jsonb := p_def -> 'processOwner';
  v_seal   jsonb := p_def -> 'sealKey';
  v_code   text;
  v_name   text;
  v_zone   text;
  v_ctx    jsonb;
  v_result jsonb;
begin
  if iam.is_bootstrapped() then
    raise exception using errcode = 'P0001', message = 'EBMR-SETUP-001 the installation is already set up; sign in instead';
  end if;
  v_hash := case when p_token is null or length(p_token) < 32 or length(p_token) > 256 then null
                 else encode(sha256(convert_to(p_token, 'UTF8')), 'hex') end;
  perform 1 from iam.setup_token t
   where t.token_sha256 = v_hash and t.consumed_at is null and t.expires_at > clock_timestamp()
   for update;
  if v_hash is null or not found then
    raise exception using errcode = 'P0001',
      message = 'EBMR-SETUP-002 the set-up token is not valid (wrong, already used or expired): the installer prints a new one (tools/install --issue-token)';
  end if;
  if p_def is null or jsonb_typeof(p_def) <> 'object' or jsonb_typeof(v_site) is distinct from 'object'
     or jsonb_typeof(v_adm) is distinct from 'object' or jsonb_typeof(v_own) is distinct from 'object' then
    raise exception using errcode = 'P0001', message = 'EBMR-SETUP-003 the set-up names the site, the system administrator and the process owner';
  end if;
  v_code := upper(btrim(coalesce(v_site ->> 'code', '')));
  v_name := btrim(coalesce(v_site ->> 'name', ''));
  v_zone := btrim(coalesce(v_site ->> 'zone', ''));
  if v_code !~ '^[A-Z0-9][A-Z0-9_-]{0,31}$' then
    raise exception using errcode = 'P0001', message = 'EBMR-SETUP-003 the site code is 1 to 32 letters, digits, hyphens or underscores, starting with a letter or digit';
  end if;
  if v_name = '' or length(v_name) > 200 then
    raise exception using errcode = 'P0001', message = 'EBMR-SETUP-003 the site name is 1 to 200 characters';
  end if;
  if iam.normalize_login_name(coalesce(v_adm ->> 'loginName', '')) = iam.normalize_login_name(coalesce(v_own ->> 'loginName', ''))
     or lower(btrim(coalesce(v_adm ->> 'legalName', ''))) = lower(btrim(coalesce(v_own ->> 'legalName', ''))) then
    raise exception using errcode = 'P0001',
      message = 'EBMR-SETUP-004 the system administrator and the process owner are two different persons with their own user IDs (DI-18: administration and GMP ownership are segregated)';
  end if;

  v_ctx := jsonb_build_object('person_id', v_nil, 'account_id', v_nil, 'role_code', 'INSTALLATION_BOOTSTRAP', 'session_id', v_nil,
                              'source', 'SYSTEM', 'site_zone', iam.policy_text('site.zone'), 'correlation_id', gen_random_uuid(),
                              'legal_name', case when kernel.installation_kind() = 'SANDBOX' then 'TEST-' else '' end || 'Installation pipeline',
                              'reason_code', 'FIRST_RUN_SETUP', 'reason_text', 'first-run set-up from the browser');
  -- DI-27, DI-09: the zone the screen showed is the zone in force; the set-up does not change it (header).
  if v_zone <> '' and v_zone is distinct from iam.policy_text('site.zone') then
    raise exception using errcode = 'P0001',
      message = format('EBMR-SETUP-006 the site time zone is %s (policy site.zone); the set-up does not change it: the process owner changes it afterwards under an approved change record (DI-09, DI-27), not %s',
                       iam.policy_text('site.zone'), v_zone);
  end if;
  perform iam.set_internal_actor(v_ctx);
  insert into iam.installation_site (site_code, site_name) values (v_code, v_name);
  perform kernel.set_actor_context(null);

  v_result := iam.bootstrap_installation(
    v_adm ->> 'legalName', v_adm ->> 'loginName', v_adm ->> 'verifier', v_adm ->> 'console',
    v_own ->> 'legalName', v_own ->> 'loginName', v_own ->> 'verifier', v_own ->> 'console',
    v_code, 'FIRST-RUN-SETUP', iam.policy_text('site.zone'));

  if v_seal is not null and jsonb_typeof(v_seal) <> 'null' then
    if jsonb_typeof(v_seal) <> 'object' or coalesce(v_seal ->> 'algorithm', '') not in ('HMAC-SHA256', 'ED25519') then
      raise exception using errcode = 'P0001', message = 'EBMR-SETUP-005 the seal key names its id and its algorithm (HMAC-SHA256 or ED25519), never its secret';
    end if;
    perform iam.set_internal_actor(v_ctx || jsonb_build_object('person_id', v_result ->> 'installation_person_id', 'correlation_id', gen_random_uuid(),
                                                              'reason_text', 'first-run set-up: the e-signature seal key'));
    insert into esig.seal_key (key_id, algorithm, public_key, description, registered_by_person, registered_by_account)
    values (v_seal ->> 'keyId', v_seal ->> 'algorithm', nullif(btrim(coalesce(v_seal ->> 'publicKey', '')), ''),
            'seal key generated at the first-run set-up', (v_result ->> 'admin_person_id')::uuid, (v_result ->> 'admin_account_id')::uuid);
    perform kernel.set_actor_context(null);
  end if;

  update iam.setup_token set consumed_at = clock_timestamp() where token_sha256 = v_hash;
  return v_result || jsonb_build_object('site_code', v_code, 'zone', iam.policy_text('site.zone'));
end
$$;
revoke all on function iam.first_run_setup(text, jsonb) from public;
grant execute on function iam.first_run_setup(text, jsonb) to ebmr_app;

reset role;
