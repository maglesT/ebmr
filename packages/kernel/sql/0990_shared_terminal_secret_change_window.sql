-- Kernel, identity: on a shared shop-floor terminal, the authentication that allows a secret change counts only for
-- as long as any authentication of a command there does (Phase 2 exit review F04; controls DI-15, DI-19, DI-38; ADR
-- 0006 item 8).
--
-- Why. A first login with an initial or reset secret gives a restricted CREDENTIAL_CHANGE authentication event and no
-- session; the person then chooses a secret of their own. iam.change_event_check (0160) let such an event change the
-- secret for authn.event_max_age_seconds (120 s by default) whatever the terminal. On a SHARED or GRADE_A_B kiosk the
-- next person at the screen stands at the same terminal: when the first person walked away from the "Choose a new PIN"
-- form, the next one could choose the absent person's PIN for up to two minutes, and so know it (a secret must be known
-- to its owner alone), or lock them out until an administrator reset it. Every command on those terminals already
-- needs an authentication event no older than attribution.freshness_seconds.<device class> (60 s by default, allowed
-- 1-300 s, 0190 and 0160); a secret change there was the one action allowed an older one.
--
-- Now iam.change_event_check (CREATE OR REPLACE, otherwise unchanged) also refuses, with EBMR-IAM-092, an event made on
-- a SHARED or GRADE_A_B terminal that is older than that terminal class's attribution window, when that window is the
-- shorter one. Other terminals keep authn.event_max_age_seconds. The web kiosk wipes the change after KEEP_BADGE_MS
-- without input and asks for the badge again to confirm the new PIN (Phase 2 exit review F04; default F04.1).
--
-- The function stays SECURITY DEFINER, owned by ebmr_owner, private (it is called by iam.authn_secret_history and
-- iam.authn_change_secret only), with its search_path pinned and pg_temp last. Applied as a new migration because
-- applied migrations are checksummed and never edited.

set local role ebmr_owner;

-- DI-15, DI-19, DI-38 (F04): checks that an event can serve a self-service step (credential change, history lookup).
create or replace function iam.change_event_check(p_auth_event uuid, p_kind text) returns iam.auth_event
language plpgsql volatile security definer set search_path = pg_catalog, iam, pg_temp as $$
declare
  -- Locks the event and refuses it once its account, person or badge is no longer active, as for
  -- every other consumer (iam.lock_auth_event).
  v_ev     iam.auth_event := iam.lock_auth_event(p_auth_event);
  v_window interval := make_interval(secs => iam.policy_int('authn.event_max_age_seconds'));
begin
  if v_ev.purpose <> 'CREDENTIAL_CHANGE' then
    raise exception using errcode = 'P0001', message = 'EBMR-IAM-096 the authentication event was not made to change a secret';
  end if;
  if exists (select 1 from iam.auth_event_use where auth_event_id = v_ev.id) then
    raise exception using errcode = 'P0001', message = 'EBMR-IAM-091 the authentication event has been used';
  end if;
  -- F04: on a shared shop-floor terminal, no longer than an authentication of a command there counts.
  if v_ev.device_class in ('SHARED', 'GRADE_A_B') then
    v_window := least(v_window, make_interval(secs => iam.policy_int('attribution.freshness_seconds.' || v_ev.device_class)));
  end if;
  if clock_timestamp() - v_ev.recorded_at > v_window then
    raise exception using errcode = 'P0001', message = 'EBMR-IAM-092 the authentication event is too old';
  end if;
  if not ((p_kind = 'PASSWORD' and 'PASSWORD' = any (v_ev.components)) or (p_kind = 'PIN' and 'PIN' = any (v_ev.components))) then
    raise exception using errcode = 'P0001', message = format('EBMR-IAM-096 changing the %s needs an authentication with the current %s', p_kind, p_kind);
  end if;
  return v_ev;
end
$$;

reset role;
