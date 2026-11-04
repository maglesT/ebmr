-- Phase B (lead decision of 4 Nov 2026, from the platform rehearsal; DI-20): the first browser terminal of a platform
-- installation. The standalone build enrols its first consoles in its own first-run set-up (iam.bootstrap_installation).
-- The platform build has no such set-up, and the device screens need a signed-in administrator on an enrolled terminal.
-- So the platform's operator registers that first terminal as an installation step (`ebmr first-terminal`,
-- cli/first-terminal.ts). Every later terminal is registered on the device screens by a person holding
-- ebmr.iam.device_manage (iam.register_device, unchanged).
--
-- Handbook: modules/kernel.md
--
--   iam.platform_register_terminal(code, fingerprint, by, reason, site, device_class)
--                              the platform's operator only (superuser; nobody else may), on the platform build, and
--                              only while no browser terminal is registered (EBMR-IAM-307 after that): a PERSONAL or
--                              SHARED browser terminal with that key fingerprint (the "not an enrolled terminal"
--                              screen shows it), registered by the platform's permission-register identity. The audit
--                              trail records it as an installation act, with who ran it and why. Site: the one given,
--                              else the installation's site, else the one site the device register already names;
--                              otherwise refused.

set local role ebmr_owner;

create function iam.platform_register_terminal(p_code text, p_fingerprint text, p_by text, p_reason text, p_site text default null,
                                                p_class text default 'PERSONAL')
returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, iam, kernel, pg_temp as $$
declare
  v_nil  uuid := '00000000-0000-0000-0000-000000000000';
  v_mode iam.platform_mode;
  v_site text := nullif(btrim(coalesce(p_site, '')), '');
  v_prev jsonb := kernel.current_actor();
  v_id   uuid;
begin
  select * into v_mode from iam.platform_mode;
  if not found then
    raise exception using errcode = 'P0001',
      message = 'EBMR-IAM-300 this is not a platform build; register terminals on the device screens';
  end if;
  if coalesce(btrim(p_by), '') = '' or coalesce(btrim(p_reason), '') = '' then
    raise exception using errcode = 'P0001', message = 'EBMR-IAM-004 say who registers the terminal and why';
  end if;
  if exists (select 1 from iam.device where device_class in ('PERSONAL', 'SHARED', 'GRADE_A_B')) then
    raise exception using errcode = 'P0001',
      message = 'EBMR-IAM-307 a browser terminal is registered already; register further terminals on the device screens';
  end if;
  if p_class not in ('PERSONAL', 'SHARED') then
    raise exception using errcode = 'P0001', message = 'EBMR-IAM-306 a first terminal is a PERSONAL or SHARED browser terminal';
  end if;
  if v_site is null then
    select site_code into v_site from iam.installation_site;
  end if;
  if v_site is null and (select count(distinct site_code) from iam.device) = 1 then
    select distinct site_code into v_site from iam.device;
  end if;
  if v_site is null then
    raise exception using errcode = 'P0001', message = 'EBMR-IAM-306 name the site of the terminal (--site)';
  end if;
  perform iam.set_internal_actor(jsonb_build_object(
    'person_id', v_mode.register_person, 'account_id', v_nil, 'role_code', 'PLATFORM_SIGN_ON', 'session_id', v_nil,
    'source', 'SYSTEM', 'site_zone', iam.policy_text('site.zone'), 'correlation_id', gen_random_uuid(),
    'legal_name', 'Platform installation (' || btrim(p_by) || ')', 'reason_code', 'FIRST_TERMINAL',
    'reason_text', btrim(p_reason), 'platform_ref', 'first-terminal'));
  insert into iam.device (code, device_class, site_code, key_fingerprint, description, registered_by_person)
  values (p_code, p_class, v_site, iam.normalize_fingerprint(p_fingerprint), 'browser terminal (platform installation step)',
          v_mode.register_person)
  returning id into v_id;
  perform kernel.set_actor_context(v_prev);
  return v_id;
end
$$;

revoke all on function iam.platform_register_terminal(text, text, text, text, text, text) from public;

reset role;
