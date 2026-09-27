-- Electronic signatures (B2), part 5: the signature integrity job (DI-37 transplant detection,
-- INV-09, INV-10) and the non-repudiation evidence package (DI-13).
--
-- esig.verify_signatures() re-derives, for every signature, what the database alone can check:
-- the seal payload digest (any change to the row, including a copy or move to another record,
-- changes the payload), the manifestation, the binding to its challenge, authentication event,
-- authority evaluation and audit event, the register entry, and the current content hash of the
-- record (a change without invalidation). The cryptographic seal itself is verified by the
-- application with its trusted key ring (verifySignatures in src/esig/integrity.ts), because the
-- seal key never enters the database. Both must report nothing; production runs them on a schedule.

set local role ebmr_owner;

create function esig.signature_problems(p_signature_id uuid) returns setof text
language plpgsql volatile security definer set search_path = pg_catalog, esig, iam, kernel, pg_temp as $$
declare
  s      esig.signature%rowtype;
  v_seal esig.signature_seal%rowtype;
  v_ch   esig.challenge%rowtype;
  v_ev   iam.auth_event%rowtype;
  v_ae   iam.authority_evaluation%rowtype;
  v_inv  esig.signature_invalidation%rowtype;
  v_hash text;
begin
  select * into s from esig.signature where id = p_signature_id;
  if not found then
    return next 'SIGNATURE_UNKNOWN';
    return;
  end if;
  if not exists (select 1 from esig.signature_id_register r where r.signature_id = s.id) then
    return next 'ID_NOT_REGISTERED: the signature ID was not issued by the signing function';
  end if;
  select * into v_seal from esig.signature_seal x where x.signature_id = s.id;
  if not found then
    return next 'SEAL_MISSING';
  else
    if v_seal.payload_sha256 <> esig.sha256_hex(esig.seal_payload(s.id)) then
      return next 'SEAL_PAYLOAD_MISMATCH: the row differs from what was sealed (altered, copied or transplanted)';
    end if;
    if v_seal.aggregate_ref <> s.aggregate_ref then
      return next 'SEAL_RECORD_MISMATCH: the seal was made for another record';
    end if;
  end if;
  if s.manifestation is distinct from esig.build_manifestation(s) or s.manifestation_text is distinct from esig.manifestation_line(s.manifestation) then
    return next 'MANIFESTATION_MISMATCH: the stored manifestation differs from the signature row';
  end if;
  select * into v_ch from esig.challenge c where c.id = s.challenge_id;
  if not found or v_ch.aggregate_ref <> s.aggregate_ref or v_ch.content_hash <> s.content_hash or v_ch.content_version <> s.content_version
     or v_ch.meaning_code <> s.meaning_code or v_ch.signer_account <> s.signer_account or v_ch.signer_person <> s.signer_person
     or v_ch.session_id <> s.session_id or v_ch.device_id <> s.device_id then
    return next 'CHALLENGE_MISMATCH: the signature is not bound to the challenge it names';
  end if;
  select * into v_ev from iam.auth_event e where e.id = s.auth_event_id;
  if not found or v_ev.person_id <> s.signer_person or v_ev.account_id <> s.signer_account or v_ev.challenge_id is distinct from s.challenge_id
     or v_ev.purpose <> 'SIGNATURE' or v_ev.device_id <> s.device_id then
    return next 'AUTH_EVENT_MISMATCH: the authentication event is not the signer''s event for this challenge (INV-10)';
  elsif not exists (select 1 from iam.auth_event_use u where u.auth_event_id = s.auth_event_id and u.use_kind = 'SIGNATURE'
                      and u.correlation_id = s.correlation_id) then
    return next 'AUTH_EVENT_NOT_CONSUMED: the authentication event was not consumed by this signing (INV-10)';
  end if;
  select * into v_ae from iam.authority_evaluation a where a.id = s.authority_evaluation_id;
  if not found or not v_ae.allowed or v_ae.person_id <> s.signer_person or v_ae.account_id <> s.signer_account then
    return next 'AUTHORITY_EVALUATION_MISMATCH: no stored, allowing authority evaluation of the signer (INV-26)';
  end if;
  if not exists (select 1 from kernel.audit_event e
                 where e.chain_key = 'esig_signature:' || s.aggregate_ref and e.table_name = 'esig.signature' and e.record_id = s.id::text
                   and e.action = 'INSERT') then
    return next 'AUDIT_EVENT_MISSING: the signature was not inserted through the audited path of this record';
  end if;
  select * into v_inv from esig.signature_invalidation i where i.signature_id = s.id;
  if v_inv.id is null then
    v_hash := esig.content_hash_of(s.aggregate_type, s.aggregate_id, esig.provide(s.aggregate_type, s.aggregate_id));
    if v_hash is distinct from s.content_hash then
      return next 'CONTENT_CHANGED_WITHOUT_INVALIDATION: the record no longer has the signed content hash (INV-09)';
    end if;
  elsif v_inv.aggregate_ref <> s.aggregate_ref or v_inv.previous_content_hash <> s.content_hash then
    return next 'INVALIDATION_MISMATCH';
  end if;
  return;
end
$$;

-- The integrity job: every problem of every signature (optionally only those signed since an
-- instant), plus any signed table whose invalidation trigger is missing or disabled.
create function esig.verify_signatures(p_since timestamptz default null) returns table (signature_id uuid, problem text)
language plpgsql volatile security definer set search_path = pg_catalog, esig, pg_temp as $$
declare
  s record;
  t record;
begin
  for t in select st.table_name::text as tbl, st.trigger_name from esig.signed_table st
           where not exists (select 1 from pg_catalog.pg_trigger g where g.tgrelid = st.table_name and g.tgname = st.trigger_name
                               and g.tgenabled in ('O', 'A'))
  loop
    signature_id := null;
    problem := format('CHANGE_TRIGGER_MISSING: the invalidation trigger of %s is missing or disabled', t.tbl);
    return next;
  end loop;
  for s in select g.id from esig.signature g where p_since is null or g.recorded_at >= p_since order by g.recorded_at, g.id loop
    for problem in select * from esig.signature_problems(s.id) loop
      signature_id := s.id;
      return next;
    end loop;
  end loop;
  -- Seals whose signature row is gone or was replaced.
  for s in select x.signature_id as id from esig.signature_seal x where not exists (select 1 from esig.signature g where g.id = x.signature_id) loop
    signature_id := s.id;
    problem := 'SEAL_WITHOUT_SIGNATURE';
    return next;
  end loop;
  return;
end
$$;

-- ---------------------------------------------------------------------------------------------
-- Invariant queries (outline 5.3): each must return no rows; production runs them on a schedule.
-- ---------------------------------------------------------------------------------------------

create function esig.invariant_violations() returns table (invariant text, signature_id uuid, detail text)
language plpgsql volatile security definer set search_path = pg_catalog, esig, iam, kernel, pg_temp as $$
begin
  -- INV-03: a verifier or witness (any type that excludes performers) is never a person who
  -- performed, entered data in or corrected the record before signing it.
  return query
    select 'INV-03'::text, s.id, 'the signer performed, entered data in or corrected the record before signing'::text
    from esig.signature s join esig.meaning_type m on m.code = s.meaning_code and m.version = s.meaning_version
    where m.excludes_performers
      and (exists (select 1 from esig.content_change c
                   where c.aggregate_ref = s.aggregate_ref and c.person_id = s.signer_person and c.recorded_at <= s.recorded_at)
           or exists (select 1 from esig.signature p join esig.meaning_type pm on pm.code = p.meaning_code and pm.version = p.meaning_version
                      where p.aggregate_ref = s.aggregate_ref and pm.role_class = 'PERFORMER' and p.signer_person = s.signer_person
                        and p.recorded_at < s.recorded_at));
  -- INV-09: a signature that is not superseded is bound to the record's current content hash.
  return query
    select 'INV-09'::text, s.id, 'the record changed but the signature was not superseded'::text
    from esig.signature s
    where not exists (select 1 from esig.signature_invalidation i where i.signature_id = s.id)
      and esig.content_hash_of(s.aggregate_type, s.aggregate_id, esig.provide(s.aggregate_type, s.aggregate_id)) is distinct from s.content_hash;
  -- INV-10: every signature consumed one authentication event of the same person for its challenge,
  -- was written by the signing function (audited insert) and sealed.
  return query
    select 'INV-10'::text, s.id, 'no consumed authentication event of the signer for this challenge, no audited insert or no seal'::text
    from esig.signature s
    where not exists (select 1 from iam.auth_event e join iam.auth_event_use u on u.auth_event_id = e.id and u.use_kind = 'SIGNATURE'
                      where e.id = s.auth_event_id and e.person_id = s.signer_person and e.challenge_id = s.challenge_id)
       or not exists (select 1 from esig.challenge c where c.id = s.challenge_id and c.signer_person = s.signer_person
                        and c.aggregate_ref = s.aggregate_ref and c.content_hash = s.content_hash)
       or not exists (select 1 from esig.signature_seal x where x.signature_id = s.id)
       or not exists (select 1 from kernel.audit_event e where e.chain_key = 'esig_signature:' || s.aggregate_ref
                        and e.table_name = 'esig.signature' and e.record_id = s.id::text and e.action = 'INSERT');
  -- INV-27: every signature ID was issued by the signing function and entered in the permanent register.
  return query
    select 'INV-27'::text, s.id, 'the signature ID is not in the permanent register'::text
    from esig.signature s where not exists (select 1 from esig.signature_id_register r where r.signature_id = s.id);
end
$$;

-- ---------------------------------------------------------------------------------------------
-- DI-13: non-repudiation evidence package for one signature
-- ---------------------------------------------------------------------------------------------

create function esig.chain_extract(p_chain_key text) returns jsonb
language sql stable security definer set search_path = pg_catalog, esig, kernel, pg_temp as $$
  select jsonb_build_object(
    'chain_key', p_chain_key,
    'events', coalesce((select jsonb_agg(jsonb_build_object('id', e.id, 'seq', e.seq, 'recorded_at', esig.utc_text(e.recorded_at),
                                                            'action', e.action, 'table', e.table_name, 'record_id', e.record_id,
                                                            'prev_hash', encode(e.prev_hash, 'hex'), 'hash', encode(e.hash, 'hex'),
                                                            'payload', e.payload) order by e.seq)
                        from kernel.audit_event e where e.chain_key = p_chain_key), '[]'::jsonb),
    'verification_problems', coalesce((select jsonb_agg(jsonb_build_object('seq', v.seq, 'problem', v.problem))
                                       from kernel.verify_chain(p_chain_key) v), '[]'::jsonb))
$$;

create function esig.evidence_package(p_signature_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, esig, iam, kernel, pg_temp as $$
declare
  s      esig.signature%rowtype;
  v_seal esig.signature_seal%rowtype;
  v_ev   iam.auth_event%rowtype;
  v_dev  iam.device%rowtype;
  v_iv   iam.identity_verification%rowtype;
  v_payload text;
begin
  select * into s from esig.signature where id = p_signature_id;
  if not found then
    raise exception using errcode = 'P0001', message = format('EBMR-ESIG-070 signature %s does not exist', p_signature_id);
  end if;
  select * into v_seal from esig.signature_seal where signature_id = s.id;
  select * into v_ev from iam.auth_event where id = s.auth_event_id;
  select * into v_dev from iam.device where id = coalesce(v_ev.device_id, s.device_id);
  select * into v_iv from iam.identity_verification v
  where v.person_id = s.signer_person and v.recorded_at <= s.recorded_at order by v.recorded_at desc limit 1;
  v_payload := esig.seal_payload(s.id);
  return jsonb_build_object(
    'format', 'ebmr-esig-evidence-v1',
    'generated_at', esig.utc_text(clock_timestamp()),
    'signature', to_jsonb(s) || jsonb_build_object('recorded_at_utc', esig.utc_text(s.recorded_at)),
    'manifestation', s.manifestation,
    'manifestation_text', s.manifestation_text,
    'status', esig.signature_state(s.id),
    'challenge', (select to_jsonb(c) || jsonb_build_object('recorded_at_utc', esig.utc_text(c.recorded_at), 'expires_at_utc', esig.utc_text(c.expires_at))
                  from esig.challenge c where c.id = s.challenge_id),
    -- The authentication event: components used, method, terminal and time; no secret, verifier or badge UID.
    'authentication_event', case when v_ev.id is null then null else jsonb_build_object(
        'id', v_ev.id, 'person_id', v_ev.person_id, 'account_id', v_ev.account_id, 'method', v_ev.method,
        'components', to_jsonb(v_ev.components), 'purpose', v_ev.purpose, 'challenge_id', v_ev.challenge_id,
        'restricted', v_ev.restricted, 'recorded_at_utc', esig.utc_text(v_ev.recorded_at), 'badge_id', v_ev.badge_id,
        'credential_kinds', coalesce((select jsonb_agg(c.kind order by c.kind) from iam.credential c where c.id = any (v_ev.credential_ids)), '[]'::jsonb),
        'device', jsonb_build_object('id', v_dev.id, 'code', v_dev.code, 'class', v_dev.device_class, 'site', v_dev.site_code,
                                     'room', v_dev.room_code, 'line', v_dev.line_code),
        'uses', coalesce((select jsonb_agg(jsonb_build_object('use', u.use_kind, 'correlation_id', u.correlation_id, 'session_id', u.session_id,
                                                              'used_at_utc', esig.utc_text(u.used_at)) order by u.used_at)
                          from iam.auth_event_use u where u.auth_event_id = v_ev.id), '[]'::jsonb)) end,
    'identity_verification', case when v_iv.id is null then null else jsonb_build_object(
        'id', v_iv.id, 'purpose', v_iv.purpose, 'method', v_iv.method, 'document_type', v_iv.document_type, 'evidence_ref', v_iv.evidence_ref,
        'verified_by_person', v_iv.verified_by_person, 'verified_by_account', v_iv.verified_by_account,
        'occurred_at_utc', esig.utc_text(v_iv.occurred_at), 'recorded_at_utc', esig.utc_text(v_iv.recorded_at)) end,
    'signer_as_at_signing', iam.resolve_signer(s.signer_account, s.recorded_at),
    'authority_evaluation', (select to_jsonb(a) from iam.authority_evaluation a where a.id = s.authority_evaluation_id),
    'segregation_evaluations', coalesce((select jsonb_agg(to_jsonb(x) order by x.evaluated_at) from iam.segregation_evaluation x
                                         where x.correlation_id = s.correlation_id and x.person_id = s.signer_person), '[]'::jsonb),
    'delegation', (select to_jsonb(d) from iam.delegation d where d.id = s.delegation_id),
    'invalidation', (select to_jsonb(i) from esig.signature_invalidation i where i.signature_id = s.id),
    'seal', case when v_seal.signature_id is null then null else jsonb_build_object(
        'key_id', v_seal.key_id, 'algorithm', v_seal.algorithm, 'seal', v_seal.seal, 'payload_sha256', v_seal.payload_sha256,
        'recorded_at_utc', esig.utc_text(v_seal.recorded_at), 'payload', v_payload,
        'payload_matches', v_seal.payload_sha256 = esig.sha256_hex(v_payload),
        'key', (select jsonb_build_object('public_key', k.public_key, 'registered_at_utc', esig.utc_text(k.recorded_at),
                                          'retired', exists (select 1 from esig.seal_key_retirement r where r.key_id = k.key_id))
                from esig.seal_key k where k.key_id = v_seal.key_id)) end,
    'integrity_problems', coalesce((select jsonb_agg(p) from esig.signature_problems(s.id) p), '[]'::jsonb),
    'audit_trail', jsonb_build_object('record_chain', esig.chain_extract(s.aggregate_ref),
                                      'signature_chain', esig.chain_extract('esig_signature:' || s.aggregate_ref)));
end
$$;

grant execute on function esig.signature_problems(uuid), esig.verify_signatures(timestamptz), esig.chain_extract(text), esig.invariant_violations(),
                          esig.evidence_package(uuid) to ebmr_app;

reset role;
