-- Tablets edition, module C1: the application role logs a signing failure only against a signing request of the session
-- whose token the server presents, so no security alert names to it the record of a request it did not make (Phase 2
-- exit follow-up HIGH-WATER, round 5, lane round 1; DI-17, DI-50, DI-19; Annex 11 and Part 11 limit access to authorised
-- persons; ADR 0012 item 9: the read rules hold when the application's own database credentials are used directly).
--
-- Found while correcting default HW.1 (5) after tablets 0610. The authentication of a signing (iam.auth_event, which the
-- application role still selects: owner residual F34.2) names its signing request. Given that id, the kernel's
-- esig.record_signing_failure, which the application role executed without a session, logged a failure against any
-- request; given also another person's authentication (any row of iam.auth_event), its misuse check raised a HIGH
-- SIGNING_FAILED alert whose details name the request's record and meaning, in iam.security_alert, which the application
-- role also selects. Measured as ebmr_app on a GMP copy with tablets 0610: the authentication of a QA reviewer's
-- DI_INVESTIGATION_CLOSED request and one call gave an alert naming di_investigation:<the investigation's id> and
-- DI_INVESTIGATION_CLOSED. So, at the price of an alert, it told which record and which kind of GOVERNANCE-class signing
-- each such authentication was for (an investigation's closure, a disposal approval or a restore approval), and so when
-- and how many investigations' closures were requested; default HW.1 (5), which said it did not tell which one, is
-- corrected alongside.
--
-- Now the application role (GMP; the sandbox role follows through sandbox.mirror_application_privileges) no longer
-- executes esig.record_signing_failure. The server logs a refused signing through tab.record_signing_failure (SECURITY
-- DEFINER, pinned search_path), which logs it through the kernel's function, unchanged (the failure row, its misuse
-- check, the alert), when the request was made in the session bound, now or before, to the token the server presents:
-- the ceremony logs only failures of its own session's requests (the sign route reads the request back through
-- tab.session_challenge first), and a failure that arrives after a sign-out or the account lock that ended the session
-- is still logged (DI-19: every failed attempt is logged). Any other request, or a token bound to no session that made
-- it, is answered as an unknown request (EBMR-ESIG-031), with the kernel's own words, and nothing is logged or alerted.
-- The kernel's logSigningFailure takes the server's recorder for this (its default stays the kernel function, for the
-- kernel's own callers). The migration fails if the application role or PUBLIC can still execute the kernel function
-- (EBMR-TAB-026). Applied as a new migration because applied migrations are checksummed and never edited.

set local role ebmr_owner;

-- DI-19, DI-17, DI-50 (HIGH-WATER round 5): a signing failure, logged only against a request made in the session that
-- p_token_hash is or was bound to.
create function tab.record_signing_failure(p_token_hash text, p_challenge uuid, p_auth_event uuid, p_code text, p_message text)
returns void
language plpgsql volatile security definer set search_path = pg_catalog, pg_temp as $$
begin
  if not exists (select 1
                   from esig.challenge c
                   join tab.session_binding b on b.session_id = c.session_id
                  where c.id = p_challenge and b.token_hash = p_token_hash) then
    raise exception using errcode = 'P0001',
      message = 'EBMR-ESIG-031 unknown signature challenge: a signing failure is logged against its challenge';
  end if;
  perform esig.record_signing_failure(p_challenge, p_auth_event, p_code, p_message);
end
$$;

revoke all on function tab.record_signing_failure(text, uuid, uuid, text, text) from public;
grant execute on function tab.record_signing_failure(text, uuid, uuid, text, text) to ebmr_app;

-- DI-17, DI-50 (HIGH-WATER round 5): the kernel's failure log, without a session.
revoke execute on function esig.record_signing_failure(uuid, uuid, text, text) from ebmr_app;

do $$
begin
  if pg_catalog.has_function_privilege('ebmr_app', 'esig.record_signing_failure(uuid, uuid, text, text)', 'EXECUTE')
     or pg_catalog.has_function_privilege('public', 'esig.record_signing_failure(uuid, uuid, text, text)', 'EXECUTE') then
    raise exception using errcode = 'P0001',
      message = 'The kernel''s signing-failure log is still executable by the application role (DI-17, DI-50). [EBMR-TAB-026]';
  end if;
end
$$;

reset role;
