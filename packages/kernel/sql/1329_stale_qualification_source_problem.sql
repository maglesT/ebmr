-- Phase 7 slice 7b-1 (finding F-6jb-2; control DI-31): the stale-mirror refusal names the mirror, its age and the system
-- owner to call.
--
-- Handbook: modules/integrations.md
--
-- Before: a signature or an act refused because a qualification came from a stale mirror said only
-- STALE_QUALIFICATION_SOURCE:<qualification> (kernel 0130, 1181). Which mirror, how old it is and whom to call was on
-- the integration health page only, and iam.lms_mirror_problem() (1181) had no caller.
--
-- Now: iam.stale_qualification_source_problem() lists every qualification source that is stale at the database's clock,
-- by the same rule iam.qualification_source_fresh applies at signing (1181): the LMS mirror on platform.mirror_sync and
-- its bound when the site runs LMS_QUALIFICATION as a MIRROR, otherwise the source's heartbeat (iam.mirror_heartbeat)
-- and the policy qualification.mirror_max_staleness_seconds. Each entry names the mirror, its age in seconds (null when
-- it never synchronised), its bound, the system owner to call and one line saying so. The server adds it to a refusal
-- that names STALE_QUALIFICATION_SOURCE (platform/http/errors.ts). A read of operational freshness only, the same facts
-- the integration health page shows; it decides nothing (the refusal is the authority check's).

set local role ebmr_owner;

create function iam.stale_qualification_source_problem() returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, iam, platform, pg_temp as $$
declare
  s       iam.qualification_source;
  v_now   timestamptz := clock_timestamp();
  v_out   jsonb := '[]'::jsonb;
  v_mir   text;
  v_label text;
  v_last  timestamptz;
  v_bound bigint;
  v_age   bigint;
  v_owner text;
begin
  for s in select * from iam.qualification_source q where q.kind <> 'INTERNAL' order by q.code loop
    if iam.qualification_source_fresh(s.code, v_now) then
      continue;
    end if;
    if s.code = 'LMS' and platform.setting_text('integration.mode.lms_qualification') = 'MIRROR' then
      v_mir := 'LMS_QUALIFICATION';
      v_label := 'LMS mirror LMS_QUALIFICATION';
      select m.last_synced_at into v_last from platform.mirror_sync m where m.data_class = 'LMS_QUALIFICATION';
      v_bound := platform.setting_numeric('integration.mirror_max_age_s.lms_qualification')::bigint;
    else
      v_mir := s.code || ' qualification heartbeat';
      v_label := v_mir;
      select h.last_synced_at into v_last from iam.mirror_heartbeat h where h.source_code = s.code;
      v_bound := iam.policy_int('qualification.mirror_max_staleness_seconds');
    end if;
    v_age := case when v_last is null then null else greatest(0, floor(extract(epoch from v_now - v_last)))::bigint end;
    v_owner := format('the %s system owner', s.code);
    v_out := v_out || jsonb_build_array(jsonb_build_object(
      'source', s.code, 'mirror', v_mir, 'ageSeconds', v_age::text, 'boundSeconds', v_bound::text, 'systemOwner', v_owner,
      'message', format('the %s is stale: %s, more than its bound of %s s; call %s', v_label,
                        case when v_age is null then 'it has never synchronised' else format('last synchronised %s s ago', v_age) end,
                        v_bound, v_owner)));
  end loop;
  return v_out;
end
$$;

revoke all on function iam.stale_qualification_source_problem() from public;
grant execute on function iam.stale_qualification_source_problem() to ebmr_app;

reset role;
