-- Identity and access: the site policy site.zone holds the IANA time zone name of the site's place, or
-- UTC (DI-27; kernel item K1 of the phase-2/recipe-core merge review, 28 September 2026, with the
-- residuals its round-1 verifier found).
--
-- iam.set_policy (0130) checked whole numbers, true/false and listed values only, so site.zone took any
-- text: an abbreviation such as IST, a bare offset or a typo. Every actor context must declare that
-- text (EBMR-IAM-118, EBMR-ESIG-035), and the kernel reads it as a zone: the signature row's UTC offset
-- and the manifestation's local signing time (esig 0220), the market's "today" (0340), the zone of an
-- entry (platform.entry_site_zone, EBMR-PLAT-017) and the site date that ends retention (EBMR-REC-020).
-- PostgreSQL reads IST as its own abbreviation (+02:00 in its default set), not as India's +05:30.
--
-- The site rule (iam.is_valid_site_zone) is stricter than EBMR-PLAT-017 (platform.is_valid_time_zone,
-- an IANA Area/Location name or UTC that the database knows): the name must also lie in one of the
-- geographic areas of the IANA database (Africa, America, Antarctica, Arctic, Asia, Atlantic,
-- Australia, Europe, Indian, Pacific), or be UTC or Etc/UTC. The rest of the Etc area is refused: its
-- fixed-offset names carry inverted POSIX signs (Etc/GMT+5 is five hours behind UTC), so a site at
-- +05:00 that picked Etc/GMT+5 would record every local time ten hours off, and they name no place.
-- Whether a link name (such as Asia/Calcutta) is known depends on the time zone data installed with
-- the database server; nothing here relies on one.
--
-- EBMR-IAM-119 refuses any other value where it is recorded, not only in iam.set_policy: a row guard on
-- iam.policy_value (aa_site_zone_iam_policy_value) refuses a site.zone row the rule refuses, whoever
-- inserts it, the owner and its SECURITY DEFINER code included. iam.set_policy applies the same check
-- first (after the permission check and the trim every policy value gets).
--
-- The installation's site zone in force must already pass the rule: otherwise this migration fails and
-- names the value; correct the policy (iam.set_policy, as before) and apply it again. The migration
-- first takes the table's SHARE ROW EXCLUSIVE lock, which waits for every transaction that has
-- recorded a policy value and not yet ended and holds back every new insert until it commits; so the
-- check sees any value recorded by a set_policy call already under way, and a call that reaches its
-- insert later meets the row guard. After it, the policy never holds anything else.
--
-- iam.set_policy keeps its signature, owner (ebmr_owner), SECURITY DEFINER, search_path and grants;
-- the only change is the site.zone check before the value is recorded. The new functions belong to
-- ebmr_owner and are granted to nobody: only the owner's code and the row guard call them.

set local role ebmr_owner;

lock table iam.policy_value in share row exclusive mode;

-- DI-27: the site's zone names a place in a geographic area of the IANA database (or is UTC), and the
-- database knows it (platform.is_valid_time_zone, EBMR-PLAT-017).
create function iam.is_valid_site_zone(p_zone text) returns boolean
language sql stable set search_path = pg_catalog, pg_temp as $$
  select platform.is_valid_time_zone(p_zone)
     and (p_zone in ('UTC', 'Etc/UTC')
          or split_part(p_zone, '/', 1) in ('Africa', 'America', 'Antarctica', 'Arctic', 'Asia', 'Atlantic',
                                            'Australia', 'Europe', 'Indian', 'Pacific'))
$$;

create function iam.assert_site_zone(p_zone text) returns void
language plpgsql stable set search_path = pg_catalog, iam, pg_temp as $$
begin
  if not iam.is_valid_site_zone(p_zone) then
    raise exception using errcode = 'P0001',
      message = format('EBMR-IAM-119 DI-27: site.zone takes an IANA time zone name (Area/Location in a geographic area, or UTC) that the database knows; %L is not one',
                       p_zone);
  end if;
end
$$;

-- The row guard: the rule holds for every site.zone row, however it is written.
create function iam.site_zone_row_guard() returns trigger
language plpgsql security definer set search_path = pg_catalog, iam, pg_temp as $$
begin
  perform iam.assert_site_zone(new.value);
  return new;
end
$$;
create trigger aa_site_zone_iam_policy_value before insert on iam.policy_value
  for each row when (new.key = 'site.zone') execute function iam.site_zone_row_guard();

do $$
declare
  v_zone text := iam.policy_text('site.zone');
begin
  if not iam.is_valid_site_zone(v_zone) then
    raise exception using errcode = 'P0001',
      message = format('EBMR-IAM-119 DI-27: the site policy site.zone holds %L, which is not an IANA time zone name (Area/Location in a geographic area, or UTC) that the database knows; correct the policy, then apply kernel migration 0940 again',
                       v_zone);
  end if;
end
$$;

create or replace function iam.set_policy(p_key text, p_value text, p_reason text) returns void
language plpgsql volatile security definer set search_path = pg_catalog, iam, kernel, pg_temp as $$
declare
  v_actor  jsonb := iam.require_permission('IAM.POLICY_MANAGE', '{}'::jsonb);
  v_key    iam.policy_key%rowtype;
  v_int    bigint;
  v_value  text := btrim(coalesce(p_value, ''));
  v_aging  bigint;
  v_screen boolean;
begin
  select * into v_key from iam.policy_key where key = p_key;
  if not found then
    raise exception using errcode = 'P0001', message = format('EBMR-IAM-110 unknown policy key %s', p_key);
  end if;
  if v_key.value_type = 'INTEGER' then
    if v_value !~ '^-?[0-9]{1,15}$' then
      raise exception using errcode = 'P0001', message = format('EBMR-IAM-110 %s takes a whole number', p_key);
    end if;
    v_int := v_value::bigint;
    if (v_key.min_value is not null and v_int < v_key.min_value) or (v_key.max_value is not null and v_int > v_key.max_value) then
      raise exception using errcode = 'P0001',
        message = format('EBMR-IAM-110 %s must lie between %s and %s', p_key, v_key.min_value, v_key.max_value);
    end if;
    v_value := v_int::text;
  elsif v_key.value_type = 'BOOLEAN' then
    if lower(v_value) not in ('true', 'false') then
      raise exception using errcode = 'P0001', message = format('EBMR-IAM-110 %s takes true or false', p_key);
    end if;
    v_value := lower(v_value);
  elsif v_key.allowed_values is not null and not v_value = any (v_key.allowed_values) then
    raise exception using errcode = 'P0001', message = format('EBMR-IAM-110 %s takes one of %s', p_key, v_key.allowed_values);
  end if;
  -- DI-27: the site's zone is the IANA name of its place or UTC, known to the database (the site rule,
  -- iam.is_valid_site_zone); never an abbreviation, a bare offset, a typo or an Etc fixed offset.
  if p_key = 'site.zone' then
    perform iam.assert_site_zone(v_value);
  end if;
  v_aging := case when p_key = 'credential.password_max_age_days' then v_value::bigint else iam.policy_int('credential.password_max_age_days') end;
  v_screen := case when p_key = 'credential.compromised_screening' then v_value::boolean else iam.policy_bool('credential.compromised_screening') end;
  if v_aging = 0 and not v_screen then
    raise exception using errcode = 'P0001',
      message = 'EBMR-IAM-111 DI-19: password aging or compromised-password screening must be active; this change would leave neither';
  end if;
  insert into iam.policy_value (key, value, set_by_person, set_by_account, reason)
  values (p_key, v_value, (v_actor ->> 'person_id')::uuid, (v_actor ->> 'account_id')::uuid, p_reason);
end
$$;

reset role;
