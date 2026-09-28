-- Electronic signatures (B2), part 4: challenge and sign (outline 5.5 steps 1 and 3), component
-- and session rules (DI-38), guards (authority INV-26, delegation, independence on the person,
-- INV-03 performer is not verifier, WITNESSED rules, record state), sealing, signature status,
-- the manifestation reader (DI-36) and the adapter for the platform state engine's SIGNATURE hook.
--
-- Flow (every step in the caller's command, so the whole signing is one transaction):
--   1. esig.create_challenge(record ref + content version, meaning, client-displayed hash[, signer])
--      rebuilds the canonical content, refuses a different hash and returns a single-use challenge
--      (120 s, bound to signer account, session and terminal) with the manifestation preview;
--   2. the authentication service (ebmr_authn) verifies the signer's components and inserts ONE
--      authentication event bound to the challenge (iam.authn_finish);
--   3. esig.sign(challenge, auth event, expected state, ...) consumes that event and runs every
--      guard, inserts the signature and returns the canonical seal payload;
--   4. the application seals the payload with its key provider (KMS/HSM; test key in tests) and
--      calls esig.seal_signature in the same transaction. A transaction that inserted a signature
--      cannot commit without its seal, so any failure aborts everything.

set local role ebmr_owner;

-- ---------------------------------------------------------------------------------------------
-- DI-38: which components this signing needs
-- ---------------------------------------------------------------------------------------------

-- The continuous period of controlled access of a session starts when it opened and again at every
-- lock or unlock (an inactivity timeout always ends in an unlock, since a locked session cannot
-- run a command). A session is bound to one terminal, so a terminal change is a new session.
create function esig.continuous_session_start(p_session uuid) returns timestamptz
language sql stable security definer set search_path = pg_catalog, esig, iam, pg_temp as $$
  select greatest(s.opened_at, coalesce((select max(e.recorded_at) from iam.session_event e
                                         where e.session_id = s.id and e.event in ('LOCKED', 'UNLOCKED')), s.opened_at))
  from iam.session s where s.id = p_session
$$;

-- ALL (identification and private component) or PRIVATE (the private component alone). PRIVATE
-- only when: the QA relaxation is on, the meaning is routine, the signer is the session owner, and
-- the owner already signed with all components in this continuous session.
create function esig.required_components(p_meaning esig.meaning_type, p_signer_person uuid, p_session uuid) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, esig, iam, pg_temp as $$
declare
  v_owner uuid;
  v_start timestamptz;
begin
  select person_id into v_owner from iam.session where id = p_session;
  if v_owner is distinct from p_signer_person then
    return jsonb_build_object('requirement', 'ALL', 'reason', 'NOT_THE_SESSION_OWNER');
  end if;
  if p_meaning.reauth <> 'SESSION_RELAXABLE' then
    return jsonb_build_object('requirement', 'ALL', 'reason', 'MEANING_NEEDS_ALL_COMPONENTS');
  end if;
  if not esig.policy_bool('esig.session_relaxation') then
    return jsonb_build_object('requirement', 'ALL', 'reason', 'ALL_COMPONENTS_AT_EVERY_SIGNING');
  end if;
  v_start := esig.continuous_session_start(p_session);
  if not exists (select 1 from esig.signature g
                 where g.session_id = p_session and g.signer_person = p_signer_person and g.components_required = 'ALL'
                   and g.recorded_at >= v_start) then
    return jsonb_build_object('requirement', 'ALL', 'reason', 'FIRST_SIGNING_OF_CONTINUOUS_SESSION', 'continuous_since', v_start);
  end if;
  return jsonb_build_object('requirement', 'PRIVATE', 'reason', 'LATER_SIGNING_OF_CONTINUOUS_SESSION', 'continuous_since', v_start);
end
$$;

-- NULL when the authentication event's components meet the requirement, otherwise why not.
-- Two distinct components: user ID + password or badge + PIN. Biometric signing is not offered.
create function esig.component_problem(p_requirement text, p_components text[]) returns text
language plpgsql stable security definer set search_path = pg_catalog, esig, pg_temp as $$
declare
  v_pair    boolean := ('USER_ID' = any (p_components) and 'PASSWORD' = any (p_components))
                    or ('BADGE' = any (p_components) and 'PIN' = any (p_components));
  v_private boolean := 'PASSWORD' = any (p_components) or 'PIN' = any (p_components);
begin
  if p_components is null or cardinality(p_components) = 0 then
    return 'NO_COMPONENTS';
  end if;
  if not p_components <@ array['USER_ID', 'PASSWORD', 'BADGE', 'PIN', 'MFA'] then
    return 'UNSUPPORTED_COMPONENT';
  end if;
  if p_requirement = 'ALL' and not v_pair then
    return 'ALL_COMPONENTS_REQUIRED';
  end if;
  if not v_private then
    return 'PRIVATE_COMPONENT_REQUIRED';
  end if;
  if esig.policy_bool('esig.mfa_at_signing') and not 'MFA' = any (p_components) then
    return 'MFA_REQUIRED';
  end if;
  return null;
end
$$;

-- ---------------------------------------------------------------------------------------------
-- Independence on the person (INV-03 and the per-type rules)
-- ---------------------------------------------------------------------------------------------

-- Persons who performed, entered data in or corrected the record: the signed-table change log, the
-- provider's own list and every signer of a PERFORMER-class meaning (whatever its status).
create function esig.performers_of(p_aggregate_type text, p_aggregate_id text, p_provided jsonb) returns uuid[]
language sql stable security definer set search_path = pg_catalog, esig, pg_temp as $$
  select coalesce(array_agg(distinct p) filter (where p is not null), '{}')
  from (
    select c.person_id as p from esig.content_change c where c.aggregate_ref = p_aggregate_type || ':' || p_aggregate_id
    union all
    select x::uuid from jsonb_array_elements_text(coalesce(p_provided -> 'entered_by', '[]'::jsonb)) x
    union all
    select g.signer_person from esig.signature g
    join esig.meaning_type m on m.code = g.meaning_code and m.version = g.meaning_version
    where g.aggregate_ref = p_aggregate_type || ':' || p_aggregate_id and m.role_class = 'PERFORMER'
  ) u
$$;

-- The involvement set for review and release meanings: performers, the provider's involvement set
-- and every signer other than of review and release meanings (outline 7.2).
create function esig.involved_in(p_aggregate_type text, p_aggregate_id text, p_provided jsonb) returns uuid[]
language sql stable security definer set search_path = pg_catalog, esig, pg_temp as $$
  select coalesce(array_agg(distinct p) filter (where p is not null), '{}')
  from (
    select unnest(esig.performers_of(p_aggregate_type, p_aggregate_id, p_provided)) as p
    union all
    select x::uuid from jsonb_array_elements_text(coalesce(p_provided -> 'involved', '[]'::jsonb)) x
    union all
    select g.signer_person from esig.signature g
    join esig.meaning_type m on m.code = g.meaning_code and m.version = g.meaning_version
    where g.aggregate_ref = p_aggregate_type || ':' || p_aggregate_id and m.role_class not in ('REVIEWER', 'RELEASE')
  ) u
$$;

-- Runs every independence rule for the signer, in both directions; each evaluation is stored by
-- the identity module (iam.segregation_evaluation). Refusals carry a JSON DETAIL for re-logging.
--
-- Every rule relates two sides of one record, and it holds whatever order the two are signed in
-- (INV-03, INV-04, DI-35): nothing forces a signing order (the caller chooses the expected state,
-- a stub entry has no order at all). So besides the rules of the type being signed against the
-- signatures already there ("forward"), the rules of the types already signed on the record are
-- applied to this signing ("reverse"):
--   independent_of  a signer of T, where this type is in T.independent_of, cannot sign it (043);
--   INV-03          a signer of a type that excludes performers cannot sign a PERFORMER type (044);
--   involvement     a signer of a type that excludes the involved cannot sign any type other than
--                   a review or release type (045).
-- Like the forward rules, every signature counts, superseded or not. A reverse rule is evaluated
-- (and stored) only when the record holds a signature of such a type. The other side of INV-03 for
-- data entry needs no rule: a change by a verifier supersedes the verification (INV-09) and makes
-- them a corrector, who can never sign it again.
create function esig.check_independence(p_type esig.meaning_type, p_ch esig.challenge, p_provided jsonb) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, esig, iam, kernel, pg_temp as $$
declare
  v_excluded uuid[];
  v_eval     jsonb;
  v_out      jsonb := '[]'::jsonb;
  v_other    text;
  v_types    text[];
begin
  if exists (select 1 from esig.signature g
             where g.aggregate_ref = p_ch.aggregate_ref and g.meaning_code = p_type.code and g.signer_person = p_ch.signer_person
               and not exists (select 1 from esig.signature_invalidation i where i.signature_id = g.id)) then
    raise exception using errcode = 'P0001',
      message = format('EBMR-ESIG-042 this person already holds a valid %s signature on %s', p_type.code, p_ch.aggregate_ref);
  end if;

  -- Independence of this type from earlier signers.
  if cardinality(p_type.independent_of) > 0 then
    v_excluded := array(select distinct g.signer_person from esig.signature g
                        where g.aggregate_ref = p_ch.aggregate_ref and g.meaning_code = any (p_type.independent_of));
    v_eval := iam.evaluate_segregation('ESIG.INDEPENDENT:' || p_type.code, p_ch.signer_person, v_excluded, p_ch.aggregate_ref);
    v_out := v_out || v_eval;
    if not (v_eval ->> 'allowed')::boolean then
      raise exception using errcode = 'P0001',
        message = format('EBMR-ESIG-043 %s must be signed by a person other than the signers of %s on this record', p_type.code, p_type.independent_of),
        detail = jsonb_build_object('rule', 'ESIG.INDEPENDENT:' || p_type.code, 'person_id', p_ch.signer_person, 'excluded', v_excluded,
                                    'subject', p_ch.aggregate_ref)::text;
    end if;
  end if;
  -- Reverse: types already signed on the record that must be independent of this type.
  for v_other in
    select t.code from esig.meaning_catalogue t
    where p_type.code = any (t.independent_of) and t.code <> p_type.code
      and exists (select 1 from esig.signature g where g.aggregate_ref = p_ch.aggregate_ref and g.meaning_code = t.code)
    order by t.code
  loop
    v_excluded := array(select distinct g.signer_person from esig.signature g
                        where g.aggregate_ref = p_ch.aggregate_ref and g.meaning_code = v_other);
    v_eval := iam.evaluate_segregation('ESIG.INDEPENDENT:' || v_other, p_ch.signer_person, v_excluded, p_ch.aggregate_ref);
    v_out := v_out || v_eval;
    if not (v_eval ->> 'allowed')::boolean then
      raise exception using errcode = 'P0001',
        message = format('EBMR-ESIG-043 %s must be signed by a person other than the signers of %s on this record (%s is independent of %s whatever the signing order)',
                         p_type.code, v_other, v_other, p_type.code),
        detail = jsonb_build_object('rule', 'ESIG.INDEPENDENT:' || v_other, 'person_id', p_ch.signer_person, 'excluded', v_excluded,
                                    'subject', p_ch.aggregate_ref)::text;
    end if;
  end loop;

  -- INV-03: a verifier, witness, checker or approver never performed, entered or corrected the record ...
  if p_type.excludes_performers then
    v_excluded := esig.performers_of(p_ch.aggregate_type, p_ch.aggregate_id, p_provided);
    v_eval := iam.evaluate_segregation('INV-03', p_ch.signer_person, v_excluded, p_ch.aggregate_ref);
    v_out := v_out || v_eval;
    if not (v_eval ->> 'allowed')::boolean then
      raise exception using errcode = 'P0001',
        message = format('EBMR-ESIG-044 INV-03: %s is never signed by a person who performed, entered data in or corrected the record', p_type.code),
        detail = jsonb_build_object('rule', 'INV-03', 'person_id', p_ch.signer_person, 'excluded', v_excluded, 'subject', p_ch.aggregate_ref)::text;
    end if;
  end if;
  -- ... and, the other way round, never becomes its performer afterwards.
  if p_type.role_class = 'PERFORMER' then
    select array_agg(distinct g.signer_person), array_agg(distinct g.meaning_code order by g.meaning_code) into v_excluded, v_types
    from esig.signature g join esig.meaning_catalogue t on t.code = g.meaning_code
    where g.aggregate_ref = p_ch.aggregate_ref and t.excludes_performers and t.code <> p_type.code;
    if v_excluded is not null then
      v_eval := iam.evaluate_segregation('INV-03', p_ch.signer_person, v_excluded, p_ch.aggregate_ref);
      v_out := v_out || v_eval;
      if not (v_eval ->> 'allowed')::boolean then
        raise exception using errcode = 'P0001',
          message = format('EBMR-ESIG-044 INV-03: a person who signed %s on the record never signs %s on it: the verifier, witness, checker or approver is never its performer',
                           v_types, p_type.code),
          detail = jsonb_build_object('rule', 'INV-03', 'person_id', p_ch.signer_person, 'excluded', v_excluded, 'subject', p_ch.aggregate_ref)::text;
      end if;
    end if;
  end if;

  -- Review and release: nobody in the record's involvement set ...
  if p_type.excludes_involved then
    v_excluded := esig.involved_in(p_ch.aggregate_type, p_ch.aggregate_id, p_provided);
    v_eval := iam.evaluate_segregation('ESIG.INVOLVEMENT', p_ch.signer_person, v_excluded, p_ch.aggregate_ref);
    v_out := v_out || v_eval;
    if not (v_eval ->> 'allowed')::boolean then
      raise exception using errcode = 'P0001',
        message = format('EBMR-ESIG-045 a person involved in the record cannot sign %s (outline 7.2 S10)', p_type.code),
        detail = jsonb_build_object('rule', 'ESIG.INVOLVEMENT', 'person_id', p_ch.signer_person, 'excluded', v_excluded,
                                    'subject', p_ch.aggregate_ref)::text;
    end if;
  end if;
  -- ... and a reviewer or releaser never becomes involved in it afterwards.
  if p_type.role_class not in ('REVIEWER', 'RELEASE') then
    select array_agg(distinct g.signer_person), array_agg(distinct g.meaning_code order by g.meaning_code) into v_excluded, v_types
    from esig.signature g join esig.meaning_catalogue t on t.code = g.meaning_code
    where g.aggregate_ref = p_ch.aggregate_ref and t.excludes_involved and t.code <> p_type.code;
    if v_excluded is not null then
      v_eval := iam.evaluate_segregation('ESIG.INVOLVEMENT', p_ch.signer_person, v_excluded, p_ch.aggregate_ref);
      v_out := v_out || v_eval;
      if not (v_eval ->> 'allowed')::boolean then
        raise exception using errcode = 'P0001',
          message = format('EBMR-ESIG-045 a person who signed %s on the record cannot then take part in it by signing %s (outline 7.2 S10)',
                           v_types, p_type.code),
          detail = jsonb_build_object('rule', 'ESIG.INVOLVEMENT', 'person_id', p_ch.signer_person, 'excluded', v_excluded,
                                      'subject', p_ch.aggregate_ref)::text;
      end if;
    end if;
  end if;
  return v_out;
end
$$;

-- WITNESSED: the witness watched the act, so the signature is applied on the act's terminal or a
-- terminal registered to the same room, within the witness window, before the next step started.
-- A late witness is refused; the caller records it as an exception. Every comparison fails closed:
-- an unknown act terminal, a terminal without a room, or a record that does not say whether the
-- next step has started never lets a witness signature through.
create function esig.check_witness(p_ch esig.challenge, p_provided jsonb, p_next_step_started boolean) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, esig, iam, pg_temp as $$
declare
  v_act     jsonb := p_provided -> 'act';
  v_act_dev iam.device%rowtype;
  v_sig_dev iam.device%rowtype;
  v_dev_id  uuid;
  v_act_at  timestamptz;
  v_window  interval := make_interval(secs => esig.policy_int('esig.witness_window_seconds'));
  v_same    boolean;
begin
  if v_act is null or jsonb_typeof(v_act) <> 'object' or coalesce(v_act ->> 'device_id', '') = '' or coalesce(v_act ->> 'at', '') = '' then
    raise exception using errcode = 'P0001',
      message = 'EBMR-ESIG-050 the record names no witnessed act (terminal and time); sign VERIFIED for recorded evidence instead';
  end if;
  -- The record says whether the next step has started (the database decides, not the caller); the
  -- caller's flag can only make the rule stricter. Unknown on either side counts as started.
  if coalesce(p_next_step_started, true)
     or (case when jsonb_typeof(v_act -> 'next_step_started') = 'boolean' then (v_act ->> 'next_step_started')::boolean else true end) then
    raise exception using errcode = 'P0001',
      message = 'EBMR-ESIG-051 the next step has started (or the record cannot show that it has not), so the act can no longer be witnessed (late witness: raise an exception)';
  end if;
  v_act_at := (v_act ->> 'at')::timestamptz;
  if v_act_at > clock_timestamp() or clock_timestamp() - v_act_at > v_window then
    raise exception using errcode = 'P0001',
      message = format('EBMR-ESIG-052 late witness: the act was recorded at %s and the witness window is %s (raise an exception instead)',
                       esig.utc_text(v_act_at), v_window);
  end if;
  begin
    v_dev_id := (v_act ->> 'device_id')::uuid;
  exception when invalid_text_representation then
    v_dev_id := null;
  end;
  select * into v_act_dev from iam.device where id = v_dev_id;
  select * into v_sig_dev from iam.device where id = p_ch.device_id;
  if v_act_dev.id is null or v_sig_dev.id is null then
    raise exception using errcode = 'P0001',
      message = format('EBMR-ESIG-053 the act names terminal %s, which is not a registered terminal, so nobody can be shown to have watched it',
                       v_act ->> 'device_id');
  end if;
  v_same := v_act_dev.id = v_sig_dev.id;
  if not v_same and not coalesce(v_act_dev.room_code = v_sig_dev.room_code and v_act_dev.site_code = v_sig_dev.site_code, false) then
    raise exception using errcode = 'P0001',
      message = 'EBMR-ESIG-053 a witness signs on the terminal of the act or on a terminal registered to the same room';
  end if;
  return jsonb_build_object('act_device_id', v_act_dev.id, 'act_at', esig.utc_text(v_act_at), 'witness_device_id', v_sig_dev.id,
                            'same_device', v_same, 'room_code', v_act_dev.room_code, 'window_seconds', extract(epoch from v_window)::integer);
end
$$;

-- ---------------------------------------------------------------------------------------------
-- Seal payload: the canonical text the seal covers, rebuilt from the stored row. It covers every
-- column of the row, directly or through the manifestation digest (printed name, user ID, role
-- name, meaning title and text, co-signature flag); aggregate_ref is fixed by a check constraint
-- and the seal row, manifestation_text is compared with the manifestation by the integrity job.
-- ---------------------------------------------------------------------------------------------

create function esig.seal_payload(p_signature_id uuid) returns text
language sql stable security definer set search_path = pg_catalog, esig, pg_temp as $$
  select esig.canonical_json(jsonb_build_object(
    'format', 'ebmr-esig-seal-payload-v1',
    'signature_id', s.id,
    'aggregate_type', s.aggregate_type,
    'aggregate_id', s.aggregate_id,
    'content_version', s.content_version::text,
    'content_hash', s.content_hash,
    'meaning_code', s.meaning_code,
    'meaning_version', s.meaning_version,
    'signer_person', s.signer_person,
    'signer_account', s.signer_account,
    'signer_role_code', s.signer_role_code,
    'session_id', s.session_id,
    'session_person', s.session_person,
    'device_id', s.device_id,
    'auth_event_id', s.auth_event_id,
    'auth_method', s.auth_method,
    'components_used', to_jsonb(s.components_used),
    'components_required', s.components_required,
    'authority_evaluation_id', s.authority_evaluation_id,
    'delegation_id', s.delegation_id,
    'challenge_id', s.challenge_id,
    'correlation_id', s.correlation_id,
    'recorded_at', esig.utc_text(s.recorded_at),
    'site_zone', s.site_zone,
    'utc_offset', s.utc_offset,
    'witness', s.witness,
    'record_state', s.record_state,
    'manifestation_sha256', esig.sha256_hex(esig.canonical_json(s.manifestation))))
  from esig.signature s where s.id = p_signature_id
$$;

-- ---------------------------------------------------------------------------------------------
-- Step 1: challenge
-- ---------------------------------------------------------------------------------------------

create function esig.create_challenge(p_aggregate_type text, p_aggregate_id text, p_content_version bigint, p_meaning text,
                                      p_client_content_hash text, p_signer_account uuid default null) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, esig, iam, kernel, pg_temp as $$
declare
  v_actor   jsonb := iam.assert_validated_actor();
  v_type    esig.meaning_type;
  v_account uuid;
  v_acc     iam.account%rowtype;
  v_session iam.session%rowtype;
  v_prov    jsonb;
  v_hash    text;
  v_signer  jsonb;
  v_req     jsonb;
  v_preview jsonb;
  v_ch      esig.challenge%rowtype;
  v_problem text;
begin
  perform iam.assert_not_administrator();
  perform esig.assert_change_triggers_ok();
  v_type := esig.current_meaning(p_meaning);
  v_account := coalesce(p_signer_account, (v_actor ->> 'account_id')::uuid);
  select * into v_acc from iam.account where id = v_account;
  if not found then
    raise exception using errcode = 'P0001', message = 'EBMR-ESIG-010 unknown signer account';
  end if;
  perform iam.assert_can_sign(v_account);
  select * into v_session from iam.session where id = (v_actor ->> 'session_id')::uuid;
  if v_acc.person_id = v_session.person_id and v_account <> v_session.account_id then
    raise exception using errcode = 'P0001', message = 'EBMR-ESIG-010 the session owner signs with the account of the session';
  end if;
  v_prov := esig.provide(p_aggregate_type, p_aggregate_id);
  if not (v_prov ->> 'exists')::boolean then
    raise exception using errcode = 'P0001',
      message = format('EBMR-ESIG-011 %s:%s does not exist or has no content provider', p_aggregate_type, p_aggregate_id);
  end if;
  -- One record, one identity: the challenge (and so the signature) names the record exactly as
  -- every lock, change log and independence rule does.
  v_problem := esig.aggregate_id_problem(p_aggregate_id, v_prov);
  if v_problem is not null then
    raise exception using errcode = 'P0001',
      message = format('EBMR-ESIG-014 %s:%s names the record by another id than its own (%s); a record is signed only under its canonical id',
                       p_aggregate_type, p_aggregate_id, v_problem);
  end if;
  if (v_prov ->> 'content_version')::bigint is distinct from p_content_version then
    raise exception using errcode = 'P0001',
      message = format('EBMR-ESIG-012 the record is at content version %s, not %s: review the current content before signing',
                       v_prov ->> 'content_version', p_content_version);
  end if;
  v_hash := esig.content_hash_of(p_aggregate_type, p_aggregate_id, v_prov);
  if lower(coalesce(p_client_content_hash, '')) <> v_hash then
    raise exception using errcode = 'P0001',
      message = 'EBMR-ESIG-013 the content shown to the signer differs from the record on the server; nothing is signed';
  end if;
  v_signer := iam.resolve_signer(v_account, clock_timestamp());
  v_req := esig.required_components(v_type, v_acc.person_id, v_session.id);
  v_preview := jsonb_build_object(
    'printed_name', v_signer ->> 'legal_name', 'user_id', v_signer ->> 'login_name',
    'role_code', case when v_acc.person_id = v_session.person_id then v_actor ->> 'role_code' end,
    'roles', v_signer -> 'roles',
    'meaning_code', v_type.code, 'meaning_title', v_type.title, 'meaning_text', v_type.meaning_text,
    'site_zone', iam.policy_text('site.zone'),
    'signed_at', 'applied by the server clock at signing',
    'record', jsonb_build_object('aggregate_type', p_aggregate_type, 'aggregate_id', p_aggregate_id,
                                 'content_version', p_content_version::text, 'content_hash', v_hash));
  insert into esig.challenge (aggregate_type, aggregate_id, aggregate_ref, content_version, content_hash, client_content_hash, meaning_code,
                              meaning_version, signer_person, signer_account, cosignature, session_id, session_person, device_id,
                              created_by_person, created_by_account, correlation_id, preview, expires_at)
  values (p_aggregate_type, p_aggregate_id, p_aggregate_type || ':' || p_aggregate_id, p_content_version, v_hash, lower(p_client_content_hash),
          v_type.code, v_type.version, v_acc.person_id, v_account, v_acc.person_id <> v_session.person_id, v_session.id, v_session.person_id,
          v_session.device_id, (v_actor ->> 'person_id')::uuid, (v_actor ->> 'account_id')::uuid, (v_actor ->> 'correlation_id')::uuid,
          v_preview, clock_timestamp())
  returning * into v_ch;
  return jsonb_build_object('challenge_id', v_ch.id, 'expires_at', esig.utc_text(v_ch.expires_at), 'content_hash', v_hash,
                            'content_version', p_content_version::text,
                            'canonical_content', esig.canonical_envelope(p_aggregate_type, p_aggregate_id, v_prov),
                            'meaning', jsonb_build_object('code', v_type.code, 'version', v_type.version, 'title', v_type.title,
                                                          'text', v_type.meaning_text),
                            'cosignature', v_ch.cosignature, 'required_components', v_req ->> 'requirement',
                            'required_components_reason', v_req ->> 'reason', 'manifestation_preview', v_preview);
end
$$;

-- ---------------------------------------------------------------------------------------------
-- Step 3: sign (the only writer of signature rows; INV-10)
-- ---------------------------------------------------------------------------------------------

create function esig.sign(p_challenge uuid, p_auth_event uuid, p_expected_state text default null, p_delegation uuid default null,
                          p_next_step_started boolean default false) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, esig, iam, kernel, pg_temp as $$
declare
  v_actor    jsonb := iam.assert_validated_actor();
  v_ch       esig.challenge%rowtype;
  v_type     esig.meaning_type;
  v_ev       jsonb;
  v_comps    text[];
  v_req      jsonb;
  v_problem  text;
  v_prov     jsonb;
  v_scope    jsonb;
  v_now      timestamptz;
  v_filter   text;
  v_perm     text;
  v_eval     jsonb;
  v_allowed  jsonb;
  v_evals    jsonb := '[]'::jsonb;
  v_deleg    jsonb;
  v_witness  jsonb;
  v_signer   jsonb;
  v_role     iam.role%rowtype;
  v_zone     text := iam.policy_text('site.zone');
  v_sig      esig.signature%rowtype;
begin
  perform iam.assert_not_administrator();
  perform esig.assert_change_triggers_ok();
  if p_challenge is null or p_auth_event is null then
    raise exception using errcode = 'P0001',
      message = 'EBMR-ESIG-030 a signature needs its challenge and a fresh authentication of the signer (no signing without authentication)';
  end if;
  select * into v_ch from esig.challenge where id = p_challenge for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'EBMR-ESIG-031 unknown signature challenge';
  end if;
  if exists (select 1 from esig.signature g where g.challenge_id = v_ch.id) then
    raise exception using errcode = 'P0001', message = 'EBMR-ESIG-032 the challenge has already been used; request a new one';
  end if;
  if clock_timestamp() > v_ch.expires_at then
    raise exception using errcode = 'P0001',
      message = format('EBMR-ESIG-033 the challenge expired at %s; request a new one', esig.utc_text(v_ch.expires_at));
  end if;
  if (v_actor ->> 'session_id')::uuid is distinct from v_ch.session_id or nullif(v_actor ->> 'device_id', '')::uuid is distinct from v_ch.device_id then
    raise exception using errcode = 'P0001', message = 'EBMR-ESIG-034 the challenge belongs to another session or terminal';
  end if;
  if (v_actor ->> 'site_zone') is distinct from v_zone then
    raise exception using errcode = 'P0001',
      message = format('EBMR-ESIG-035 the command declares zone %s but the site zone is %s', v_actor ->> 'site_zone', v_zone);
  end if;

  -- INV-09: serialise with every change to this record.
  perform esig.aggregate_lock(v_ch.aggregate_type, v_ch.aggregate_id);

  -- INV-10: one unused authentication event of the signer, bound to this challenge, fresh.
  v_ev := iam.consume_auth_event(p_auth_event, v_ch.signer_person, v_ch.id,
                                 make_interval(secs => esig.policy_int('esig.challenge_validity_seconds')));
  if (v_ev ->> 'account_id')::uuid is distinct from v_ch.signer_account then
    raise exception using errcode = 'P0001', message = 'EBMR-ESIG-036 the authentication event belongs to another account than the challenge names';
  end if;
  if (v_ev ->> 'device_id')::uuid is distinct from v_ch.device_id then
    raise exception using errcode = 'P0001', message = 'EBMR-ESIG-036 the signer authenticated on another terminal than the one showing the challenge';
  end if;
  if (v_ev ->> 'recorded_at')::timestamptz < v_ch.recorded_at then
    raise exception using errcode = 'P0001', message = 'EBMR-ESIG-036 the authentication happened before the challenge (no pre-signing)';
  end if;

  -- DI-38: components.
  v_type := esig.current_meaning(v_ch.meaning_code);
  if v_type.version <> v_ch.meaning_version then
    raise exception using errcode = 'P0001',
      message = format('EBMR-ESIG-037 signature type %s changed since the challenge; request a new one', v_type.code);
  end if;
  v_comps := array(select jsonb_array_elements_text(v_ev -> 'components'));
  v_req := esig.required_components(v_type, v_ch.signer_person, v_ch.session_id);
  v_problem := esig.component_problem(v_req ->> 'requirement', v_comps);
  if v_problem is not null then
    raise exception using errcode = 'P0001',
      message = format('EBMR-ESIG-038 %s: this signing needs %s (%s); the authentication used %s', v_problem,
                       case v_req ->> 'requirement' when 'ALL' then 'every signature component' else 'at least the private component' end,
                       v_req ->> 'reason', v_comps),
      detail = (v_req || jsonb_build_object('problem', v_problem, 'components', v_comps))::text;
  end if;

  -- DI-15, DI-21: the signer may sign at all.
  perform iam.assert_can_sign(v_ch.signer_account);

  -- The record: unchanged since the challenge, in the state the caller expects.
  v_prov := esig.provide(v_ch.aggregate_type, v_ch.aggregate_id);
  if not (v_prov ->> 'exists')::boolean then
    raise exception using errcode = 'P0001', message = format('EBMR-ESIG-011 %s no longer exists', v_ch.aggregate_ref);
  end if;
  if (v_prov ->> 'content_version')::bigint <> v_ch.content_version
     or esig.content_hash_of(v_ch.aggregate_type, v_ch.aggregate_id, v_prov) <> v_ch.content_hash then
    raise exception using errcode = 'P0001',
      message = 'EBMR-ESIG-012 the record changed after the challenge was issued; review the current content before signing';
  end if;
  if (v_prov ->> 'state') is distinct from p_expected_state then
    raise exception using errcode = 'P0001',
      message = format('EBMR-ESIG-039 the record is in state %s, not the expected %s', coalesce(v_prov ->> 'state', '(none)'),
                       coalesce(p_expected_state, '(none)'));
  end if;
  v_scope := coalesce(v_prov -> 'scope', '{}'::jsonb);

  -- INV-26: the signer holds a permitted role and its qualifications now; every evaluation stored.
  v_now := clock_timestamp();
  v_filter := case when v_ch.cosignature then null else v_actor ->> 'role_code' end;
  foreach v_perm in array v_type.permissions loop
    v_eval := iam.evaluate_authority(v_ch.signer_person, v_ch.signer_account, v_perm, v_scope, v_now, v_filter);
    v_evals := v_evals || jsonb_build_array(v_eval);
    if (v_eval ->> 'allowed')::boolean then
      v_allowed := v_eval;
      exit;
    end if;
  end loop;
  if v_allowed is null then
    raise exception using errcode = 'P0001',
      message = format('EBMR-ESIG-040 the signer is not authorised to sign %s now: %s', v_type.code,
                       (select jsonb_agg(e -> 'reasons') from jsonb_array_elements(v_evals) e)),
      detail = jsonb_build_object('person_id', v_ch.signer_person, 'account_id', v_ch.signer_account, 'role_code', v_filter,
                                  'permissions', to_jsonb(v_type.permissions), 'scope', v_scope, 'evaluations', v_evals)::text;
  end if;

  -- Delegation (outline 7.1): cited, valid now, for this meaning, scope and market.
  if p_delegation is not null then
    if not v_type.delegable then
      raise exception using errcode = 'P0001', message = format('EBMR-ESIG-041 %s cannot be signed under a delegation', v_type.code);
    end if;
    v_deleg := iam.delegation_valid(p_delegation, v_ch.signer_person, v_type.code, v_scope, v_prov ->> 'market', v_now);
    if not (v_deleg ->> 'valid')::boolean then
      raise exception using errcode = 'P0001', message = format('EBMR-ESIG-041 the cited delegation is not valid: %s', v_deleg -> 'reasons');
    end if;
  end if;

  -- Independence on the person, INV-03, involvement.
  perform esig.check_independence(v_type, v_ch, v_prov);

  -- WITNESSED.
  if v_type.witness then
    v_witness := esig.check_witness(v_ch, v_prov, p_next_step_started);
  end if;

  -- The signature row, attributed to the signer. A co-signature (a verifier at the performer's
  -- terminal) is the co-signer's own act: its audit entries carry the co-signer's identity and
  -- authentication event, with the terminal session in which it was applied.
  v_signer := iam.resolve_signer(v_ch.signer_account, v_now);
  select * into v_role from iam.role where code = v_allowed ->> 'role_code';
  if v_ch.cosignature then
    perform iam.set_internal_actor(v_actor || jsonb_build_object('person_id', v_ch.signer_person, 'account_id', v_ch.signer_account,
                                                                 'role_code', v_role.code, 'auth_event_id', p_auth_event,
                                                                 'legal_name', v_signer ->> 'legal_name'));
  end if;
  perform set_config('esig.signing_challenge', v_ch.id::text, true);
  insert into esig.signature (aggregate_type, aggregate_id, aggregate_ref, content_version, content_hash, meaning_code, meaning_version,
                              meaning_title, meaning_text, signer_person, signer_account, signer_login, signer_legal_name, signer_role_code,
                              signer_role_name, session_id, session_person, cosignature, device_id, auth_event_id, auth_method,
                              components_used, components_required, authority_evaluation_id, delegation_id, challenge_id, correlation_id,
                              site_zone, utc_offset, witness, record_state, manifestation, manifestation_text)
  values (v_ch.aggregate_type, v_ch.aggregate_id, v_ch.aggregate_ref, v_ch.content_version, v_ch.content_hash, v_type.code, v_type.version,
          v_type.title, v_type.meaning_text, v_ch.signer_person, v_ch.signer_account, v_signer ->> 'login_name', v_signer ->> 'legal_name',
          v_role.code, v_role.name, v_ch.session_id, v_ch.session_person, v_ch.cosignature, v_ch.device_id, p_auth_event, v_ev ->> 'method',
          v_comps, v_req ->> 'requirement', (v_allowed ->> 'evaluation_id')::uuid, p_delegation, v_ch.id,
          (v_actor ->> 'correlation_id')::uuid, v_zone, '+00:00', v_witness, v_prov ->> 'state', '{}'::jsonb, '')
  returning * into v_sig;
  perform kernel.audit_business_event(v_ch.aggregate_ref,
    format('signed %s by %s (%s) at %s UTC%s', v_type.code, v_sig.signer_legal_name, v_sig.signer_login,
           v_sig.manifestation ->> 'signed_at_local', v_sig.utc_offset),
    jsonb_build_object('signature_id', v_sig.id, 'meaning_code', v_type.code, 'content_hash', v_sig.content_hash,
                       'content_version', v_sig.content_version::text, 'cosignature', v_sig.cosignature,
                       'components_required', v_sig.components_required));
  if v_ch.cosignature then
    perform kernel.set_actor_context(v_actor);
  end if;
  perform set_config('esig.unsealed', coalesce(current_setting('esig.unsealed', true), '') || v_sig.id::text || ',', true);
  return jsonb_build_object('signature_id', v_sig.id, 'recorded_at', esig.utc_text(v_sig.recorded_at), 'seal_payload', esig.seal_payload(v_sig.id),
                            'manifestation', v_sig.manifestation, 'manifestation_text', v_sig.manifestation_text,
                            'components_required', v_sig.components_required, 'components_reason', v_req ->> 'reason',
                            'cosignature', v_sig.cosignature, 'authority_evaluation_id', v_sig.authority_evaluation_id);
end
$$;

-- Step 4: attach the seal computed by the application's key provider. Only a signature applied in
-- this transaction and not yet sealed can be sealed; the key must be registered and not retired.
create function esig.seal_signature(p_signature_id uuid, p_key_id text, p_algorithm text, p_seal text) returns void
language plpgsql volatile security definer set search_path = pg_catalog, esig, iam, kernel, pg_temp as $$
declare
  v_actor   jsonb := iam.assert_validated_actor();
  v_pending text := coalesce(current_setting('esig.unsealed', true), '');
  v_sig     esig.signature%rowtype;
  v_bytes   bytea;
begin
  select * into v_sig from esig.signature where id = p_signature_id;
  if not found or position(p_signature_id::text || ',' in v_pending) = 0 then
    raise exception using errcode = 'P0001', message = 'EBMR-ESIG-062 only a signature applied in this transaction can be sealed';
  end if;
  if exists (select 1 from esig.signature_seal where signature_id = p_signature_id) then
    raise exception using errcode = 'P0001', message = format('EBMR-ESIG-062 signature %s is already sealed', p_signature_id);
  end if;
  if not esig.seal_key_active(p_key_id, p_algorithm) then
    raise exception using errcode = 'P0001',
      message = format('EBMR-ESIG-063 seal key %s (%s) is not registered or has been retired', p_key_id, p_algorithm);
  end if;
  begin
    v_bytes := decode(p_seal, 'base64');
  exception when others then
    v_bytes := null;
  end;
  if v_bytes is null or length(v_bytes) <> (case p_algorithm when 'HMAC-SHA256' then 32 else 64 end) then
    raise exception using errcode = 'P0001', message = format('EBMR-ESIG-064 the seal is not a base64 %s value', p_algorithm);
  end if;
  insert into esig.signature_seal (signature_id, aggregate_ref, key_id, algorithm, payload_sha256, seal)
  values (v_sig.id, v_sig.aggregate_ref, p_key_id, p_algorithm, esig.sha256_hex(esig.seal_payload(v_sig.id)), p_seal);
  perform set_config('esig.unsealed', replace(v_pending, p_signature_id::text || ',', ''), true);
end
$$;

-- ---------------------------------------------------------------------------------------------
-- Status, verification by other modules, manifestation
-- ---------------------------------------------------------------------------------------------

-- VALID only while sealed, not superseded and the record's content hash is still the signed one
-- (INV-09). SUPERSEDED_BY_CHANGE shows the element as unsigned; CONTENT_MISMATCH is an integrity
-- problem (content changed without the invalidation mechanism).
create function esig.signature_state(p_signature_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, esig, pg_temp as $$
declare
  s      esig.signature%rowtype;
  v_inv  esig.signature_invalidation%rowtype;
  v_hash text;
  v_status text;
begin
  select * into s from esig.signature where id = p_signature_id;
  if not found then
    return jsonb_build_object('signature_id', p_signature_id, 'exists', false, 'valid', false, 'status', 'UNKNOWN');
  end if;
  select * into v_inv from esig.signature_invalidation where signature_id = s.id;
  if v_inv.id is not null then
    v_status := 'SUPERSEDED_BY_CHANGE';
  else
    v_hash := esig.content_hash_of(s.aggregate_type, s.aggregate_id, esig.provide(s.aggregate_type, s.aggregate_id));
    if v_hash is distinct from s.content_hash then
      v_status := 'CONTENT_MISMATCH';
    elsif not exists (select 1 from esig.signature_seal x where x.signature_id = s.id) then
      v_status := 'UNSEALED';
    else
      v_status := 'VALID';
    end if;
  end if;
  return jsonb_build_object('signature_id', s.id, 'exists', true, 'valid', v_status = 'VALID', 'status', v_status,
                            'aggregate_type', s.aggregate_type, 'aggregate_id', s.aggregate_id, 'content_version', s.content_version::text,
                            'content_hash', s.content_hash, 'meaning_code', s.meaning_code, 'signer_person', s.signer_person,
                            'signer_account', s.signer_account, 'recorded_at', esig.utc_text(s.recorded_at),
                            'invalidation', case when v_inv.id is null then null else
                              jsonb_build_object('id', v_inv.id, 'reason', v_inv.reason, 'recorded_at', esig.utc_text(v_inv.recorded_at),
                                                 'person_id', v_inv.person_id, 'current_content_hash', v_inv.current_content_hash) end);
end
$$;

-- NULL when p_signature_id is a valid signature with this meaning on this record, else the reason.
create function esig.signature_problem(p_signature_id uuid, p_meaning text, p_aggregate_type text, p_aggregate_id text) returns text
language plpgsql volatile security definer set search_path = pg_catalog, esig, pg_temp as $$
declare
  v jsonb := esig.signature_state(p_signature_id);
begin
  if not (v ->> 'exists')::boolean then
    return format('signature %s does not exist', p_signature_id);
  end if;
  if v ->> 'meaning_code' is distinct from p_meaning then
    return format('signature %s means %s, not %s', p_signature_id, v ->> 'meaning_code', p_meaning);
  end if;
  if v ->> 'aggregate_type' is distinct from p_aggregate_type or v ->> 'aggregate_id' is distinct from p_aggregate_id then
    return format('signature %s belongs to %s:%s, not to %s:%s (a signature is never transferred)', p_signature_id,
                  v ->> 'aggregate_type', v ->> 'aggregate_id', p_aggregate_type, p_aggregate_id);
  end if;
  if not (v ->> 'valid')::boolean then
    return format('signature %s is %s; the record must be signed again', p_signature_id, v ->> 'status');
  end if;
  return null;
end
$$;

-- For other modules' SECURITY DEFINER functions (records approvals, releases): raise unless valid.
create function esig.assert_signature(p_signature_id uuid, p_meaning text, p_aggregate_type text, p_aggregate_id text) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, esig, pg_temp as $$
declare
  v_problem text := esig.signature_problem(p_signature_id, p_meaning, p_aggregate_type, p_aggregate_id);
begin
  if v_problem is not null then
    raise exception using errcode = 'P0001', message = 'EBMR-ESIG-070 ' || v_problem;
  end if;
  return esig.signature_state(p_signature_id);
end
$$;

-- NULL when the record is still in the state the signature was applied in, else the reason. A
-- signature authorises the step of the life cycle it was given in, never a later one: an approval
-- signed while the record was a draft cannot approve it once it has been checked (DI-37, INV-04).
create function esig.signature_state_problem(p_signature_id uuid) returns text
language plpgsql volatile security definer set search_path = pg_catalog, esig, pg_temp as $$
declare
  s      esig.signature%rowtype;
  v_prov jsonb;
begin
  select * into s from esig.signature where id = p_signature_id;
  if not found then
    return format('signature %s does not exist', p_signature_id);
  end if;
  v_prov := esig.provide(s.aggregate_type, s.aggregate_id);
  if (v_prov ->> 'state') is distinct from s.record_state then
    return format('signature %s was applied while the record was in state %s; it cannot authorise a step out of state %s (sign again in the current state)',
                  p_signature_id, coalesce(s.record_state, '(none)'), coalesce(v_prov ->> 'state', '(none)'));
  end if;
  return null;
end
$$;

-- Platform state engine SIGNATURE hook: fn(signature_id, meaning, aggregate_type, aggregate_id,
-- actor) returns NULL when the signature is valid, not superseded, bound to the record and meaning
-- and was applied in the state the transition leaves (the engine calls the hook before it changes
-- the state), else the reason. The actor who fires the transition may be another person than the
-- signer (the permission to fire it is the engine's AUTHORITY check; the signer's authority was
-- evaluated and stored at signing). Registered in an integration migration (platform.register_hook).
create function esig.platform_signature_check(p_signature_id uuid, p_meaning text, p_aggregate_type text, p_aggregate_id text, p_actor jsonb)
returns text
language plpgsql volatile security definer set search_path = pg_catalog, esig, pg_temp as $$
begin
  return coalesce(esig.signature_problem(p_signature_id, p_meaning, p_aggregate_type, p_aggregate_id),
                  esig.signature_state_problem(p_signature_id));
end
$$;

-- Every signature of a record with its status (valid, superseded), for screens and reports.
create function esig.record_signatures(p_aggregate_type text, p_aggregate_id text) returns table (
  signature_id uuid, meaning_code text, signer_person uuid, printed_name text, recorded_at timestamptz, status text, valid boolean,
  manifestation_text text)
language sql volatile security definer set search_path = pg_catalog, esig, pg_temp as $$
  select s.id, s.meaning_code, s.signer_person, s.signer_legal_name, s.recorded_at, st ->> 'status', (st ->> 'valid')::boolean, s.manifestation_text
  from esig.signature s cross join lateral (select esig.signature_state(s.id) as st) x
  where s.aggregate_ref = p_aggregate_type || ':' || p_aggregate_id
  order by s.recorded_at, s.id
$$;

-- Meanings whose signature was superseded by a change and has not been signed again (DI-37:
-- re-signing is required), with the person who signed the superseded one.
create function esig.resigning_required(p_aggregate_type text, p_aggregate_id text) returns table (
  meaning_code text, superseded_signature_id uuid, previous_signer uuid, superseded_at timestamptz)
language sql volatile security definer set search_path = pg_catalog, esig, pg_temp as $$
  select s.meaning_code, s.id, s.signer_person, i.recorded_at
  from esig.signature s join esig.signature_invalidation i on i.signature_id = s.id
  where s.aggregate_ref = p_aggregate_type || ':' || p_aggregate_id
    and not exists (select 1 from esig.signature n
                    where n.aggregate_ref = s.aggregate_ref and n.meaning_code = s.meaning_code and n.recorded_at > s.recorded_at
                      and (esig.signature_state(n.id) ->> 'valid')::boolean)
  order by i.recorded_at, s.id
$$;

-- DI-36: the manifestation as stored with the signature (never re-derived from the user tables),
-- for screen, print, PDF and export renderers, with the signature's current status.
create function esig.manifestation(p_signature_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, esig, pg_temp as $$
declare
  s esig.signature%rowtype;
  v jsonb;
begin
  select * into s from esig.signature where id = p_signature_id;
  if not found then
    raise exception using errcode = 'P0001', message = format('EBMR-ESIG-070 signature %s does not exist', p_signature_id);
  end if;
  v := esig.signature_state(s.id);
  return jsonb_build_object('manifestation', s.manifestation, 'text', s.manifestation_text, 'status', v ->> 'status',
                            'valid', (v ->> 'valid')::boolean);
end
$$;

-- DI-19: what committed rows show about an authentication event used (or made) for a challenge,
-- whatever the application reports. NULL when they show no misuse, else {code, reason, ...} with the
-- refusal code esig.sign gives for it. p_attempted: a signing attempt with this event on this
-- challenge was reported (then an event that already attributed another command, a pre-signing
-- event and missing components count too); without it only what the event itself proves counts:
-- another person authenticated for the challenge (proxy signing), or the signer with another
-- account or on another terminal. An event already consumed by the challenge's own signature is a
-- repeated request for a completed signing (refused as EBMR-ESIG-032), not misuse.
create function esig.signing_misuse(p_challenge uuid, p_auth_event uuid, p_attempted boolean default true) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, esig, iam, pg_temp as $$
declare
  v_ch   esig.challenge%rowtype;
  v_ev   iam.auth_event%rowtype;
  v_type esig.meaning_type%rowtype;
  v_out  jsonb;
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
  -- Uses of the failed attempt itself rolled back with it: a committed use is another command's.
  if exists (select 1 from iam.auth_event_use u where u.auth_event_id = v_ev.id) then
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

-- Signing failures are logged after the failed command rolled back (the TypeScript signing
-- wrapper calls this), against the challenge and the authentication event the attempt used. The
-- reported code and message are kept as reported. The security unit is alerted (DI-19) only on
-- misuse the database itself finds in committed rows (esig.signing_misuse), naming the person who
-- authenticated, once per authentication event: the application can neither accuse anybody nor
-- hide the evidence (esig.invariant_violations reports misuse that was never alerted).
create function esig.record_signing_failure(p_challenge uuid, p_auth_event uuid, p_code text, p_message text) returns void
language plpgsql volatile security definer set search_path = pg_catalog, esig, iam, pg_temp as $$
declare
  v_ch     esig.challenge%rowtype;
  v_code   text := case when p_code ~ '^EBMR-[A-Z]+-[0-9]{3}$' then p_code else 'UNKNOWN' end;
  v_misuse jsonb;
  v_known  boolean;
begin
  select * into v_ch from esig.challenge where id = p_challenge;
  if not found then
    raise exception using errcode = 'P0001', message = 'EBMR-ESIG-031 unknown signature challenge: a signing failure is logged against its challenge';
  end if;
  v_misuse := esig.signing_misuse(v_ch.id, p_auth_event, true);
  v_known := exists (select 1 from esig.signing_failure f where f.auth_event_id = p_auth_event and f.misuse_code is not null);
  insert into esig.signing_failure (challenge_id, auth_event_id, code, message, misuse_code, misuse_detail, aggregate_ref, meaning_code,
                                    signer_account, signer_person, session_id, device_id)
  values (v_ch.id, p_auth_event, v_code, left(coalesce(p_message, ''), 1000), v_misuse ->> 'code', v_misuse, v_ch.aggregate_ref,
          v_ch.meaning_code, v_ch.signer_account, v_ch.signer_person, v_ch.session_id, v_ch.device_id);
  if v_misuse is not null and not v_known then
    perform iam.raise_alert('SIGNING_FAILED', 'HIGH', (v_misuse ->> 'authenticated_account')::uuid, (v_misuse ->> 'authenticated_person')::uuid,
                            (v_misuse ->> 'authenticated_device_id')::uuid, null, v_ch.session_id,
                            v_misuse || jsonb_build_object('reported_code', v_code));
  end if;
end
$$;

-- ---------------------------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------------------------

grant execute on function esig.continuous_session_start(uuid), esig.required_components(esig.meaning_type, uuid, uuid),
                          esig.component_problem(text, text[]), esig.seal_payload(uuid),
                          esig.create_challenge(text, text, bigint, text, text, uuid),
                          esig.sign(uuid, uuid, text, uuid, boolean), esig.seal_signature(uuid, text, text, text),
                          esig.signature_state(uuid), esig.signature_problem(uuid, text, text, text),
                          esig.assert_signature(uuid, text, text, text), esig.record_signatures(text, text),
                          esig.resigning_required(text, text), esig.manifestation(uuid), esig.signature_state_problem(uuid),
                          esig.record_signing_failure(uuid, uuid, text, text) to ebmr_app;
-- performers_of, involved_in, check_independence, check_witness, signing_misuse and
-- platform_signature_check stay private to the owner (the platform engine calls the adapter from
-- its own definer function).

reset role;
