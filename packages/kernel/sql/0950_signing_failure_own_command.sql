-- E-signatures (B2), K2 of the Phase 2 open questions: a refused signing attempt's own command use
-- of its authentication event is not re-use (DI-19, INV-10, INV-40).
--
-- esig.signing_misuse (0230) read every committed use of the event, other than a signature, as
-- another command's (EBMR-IAM-091), on the assumption that a failed attempt's own uses rolled back
-- with it. But a SIGNATURE event may attribute the very command it is used in
-- (iam.use_auth_event_for_command, iam.consume_auth_event; 0160), and a signing refused before
-- esig.sign commits that command on purpose (plan section 6: the refused COMMAND row, which on a
-- kiosk carries the event the command consumed). Logged with its event after that commit, the
-- attempt would have raised a HIGH alert against the rightful signer.
--
-- Now the attempt logs its refusal INSIDE its own command (esig.record_signing_failure is unchanged
-- and may be called there), and signing_misuse sets aside exactly one use: the COMMAND use written
-- in this same transaction by the validated command that this event attributes (the actor context
-- installed by kernel.begin_command names the event, and the use carries that command's
-- correlation id). The database decides this from the transaction and the validated context, never
-- from what the application reports: a failure reported after the commit, from another command,
-- or from a second command of the same transaction still finds the committed use and reports
-- re-use. With the attempt's own use set aside, the other attempted-misuse checks run on the event
-- as before: made for another challenge (EBMR-IAM-094), before the challenge (EBMR-ESIG-036), without
-- the components the signing needs (EBMR-ESIG-038). The checks that need no attempt (another
-- person, account or terminal) and esig.invariant_violations are unchanged.
--
-- Same signature, volatility, owner, SECURITY DEFINER, search_path and privileges as 0230 (private
-- to the owner).

set local role ebmr_owner;

create or replace function esig.signing_misuse(p_challenge uuid, p_auth_event uuid, p_attempted boolean default true) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, esig, iam, pg_temp as $$
declare
  v_ch    esig.challenge%rowtype;
  v_ev    iam.auth_event%rowtype;
  v_type  esig.meaning_type%rowtype;
  v_out   jsonb;
  v_xact  xid8;
  v_actor jsonb;
  v_own   uuid;
begin
  select * into v_ch from esig.challenge where id = p_challenge;
  select * into v_ev from iam.auth_event where id = p_auth_event;
  if v_ch.id is null or v_ev.id is null then
    return null;
  end if;
  v_out := jsonb_build_object('challenge_id', v_ch.id, 'auth_event_id', v_ev.id, 'record', v_ch.aggregate_ref,
                              'meaning_code', v_ch.meaning_code, 'challenge_signer_person', v_ch.signer_person,
                              'challenge_signer_account', v_ch.signer_account, 'challenge_device_id', v_ch.device_id,
                              'authenticated_person', v_ev.person_id, 'authenticated_account', v_ev.account_id,
                              'authenticated_device_id', v_ev.device_id);
  if v_ev.person_id is distinct from v_ch.signer_person then
    return v_out || jsonb_build_object('code', 'EBMR-IAM-093',
      'reason', 'another person authenticated to sign a challenge that names someone else (proxy signing)');
  end if;
  if p_attempted and v_ev.challenge_id is distinct from v_ch.id then
    return v_out || jsonb_build_object('code', 'EBMR-IAM-094', 'reason', 'an authentication made for another challenge was used');
  end if;
  if v_ev.account_id is distinct from v_ch.signer_account then
    return v_out || jsonb_build_object('code', 'EBMR-ESIG-036', 'reason', 'the signer authenticated with another account than the challenge names');
  end if;
  if v_ev.device_id is distinct from v_ch.device_id then
    return v_out || jsonb_build_object('code', 'EBMR-ESIG-036', 'reason', 'the signer authenticated on another terminal than the one showing the challenge');
  end if;
  if not p_attempted then
    return null;
  end if;
  if exists (select 1 from iam.auth_event_use u where u.auth_event_id = v_ev.id and u.use_kind = 'SIGNATURE') then
    return null;
  end if;
  -- The attempt's own command (K2): the validated command of this transaction, attributed by this
  -- event. Its COMMAND use is the attempt's, not another command's. Outside such a command (a failure
  -- logged after a rollback) nothing is set aside: every committed use is another command's.
  v_xact := pg_current_xact_id_if_assigned();
  if v_xact is not null and iam.actor_is_validated() then
    v_actor := kernel.current_actor();
    if pg_input_is_valid(v_actor ->> 'auth_event_id', 'uuid') and pg_input_is_valid(v_actor ->> 'correlation_id', 'uuid')
       and (v_actor ->> 'auth_event_id')::uuid = v_ev.id then
      v_own := (v_actor ->> 'correlation_id')::uuid;
    end if;
  end if;
  if exists (select 1 from iam.auth_event_use u
             where u.auth_event_id = v_ev.id
               and not coalesce(u.use_kind = 'COMMAND' and u.xact_id = v_xact and u.correlation_id = v_own, false)) then
    return v_out || jsonb_build_object('code', 'EBMR-IAM-091', 'reason', 'an authentication that already attributed another command was used for a signature');
  end if;
  if v_ev.recorded_at < v_ch.recorded_at then
    return v_out || jsonb_build_object('code', 'EBMR-ESIG-036', 'reason', 'the authentication happened before the challenge (pre-signing)');
  end if;
  select * into v_type from esig.meaning_type where code = v_ch.meaning_code and version = v_ch.meaning_version;
  if esig.component_problem(esig.required_components(v_type, v_ch.signer_person, v_ch.session_id) ->> 'requirement', v_ev.components) is not null then
    return v_out || jsonb_build_object('code', 'EBMR-ESIG-038', 'reason', 'the authentication lacks the components this signing needs');
  end if;
  return null;
end
$$;

reset role;
