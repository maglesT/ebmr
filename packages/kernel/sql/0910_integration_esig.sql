-- Integration wiring for electronic signatures (Phase 1). The platform state engine checks every
-- signature a transition needs through its SIGNATURE hook; the e-signature module provides it.
-- The platform's sample record (test scaffolding for the state engine) becomes signable, so a
-- transition that needs a signature is proven end to end with real signatures.

set local role ebmr_owner;

-- SIGNATURE hook of the platform: the e-signature module's adapter (valid, not superseded, bound to
-- the record and meaning, applied in the state the transition leaves), plus the binding only the
-- engine can check: for a record that follows a state machine, the signature was applied during the
-- record's current stay in that state, after the transition that entered it. A signature from an
-- earlier stay in the same state (e.g. CHECKED signed in SUBMITTED, then RETURN and a new SUBMIT
-- with unchanged content) authorised nothing that happened since and is refused (DI-37, INV-04).
-- Before and after are taken from audit-trail positions (kernel.audit_event ids), never from the
-- clock, so a clock step cannot reorder them. For other aggregates (e.g. a batch's late-entry
-- co-signature) the adapter decides alone.
create function platform.transition_signature_check(p_signature_id uuid, p_meaning text, p_aggregate_type text, p_aggregate_id text,
                                                    p_actor jsonb) returns text
language plpgsql volatile security definer set search_path = pg_catalog, platform, pg_temp as $$
declare
  v_problem text := esig.platform_signature_check(p_signature_id, p_meaning, p_aggregate_type, p_aggregate_id, p_actor);
  v_state   platform.aggregate_state%rowtype;
  v_entered bigint;
  v_signed  bigint;
begin
  if v_problem is not null then
    return v_problem;
  end if;
  if not coalesce(pg_catalog.pg_input_is_valid(p_aggregate_id, 'uuid'), false) then
    return null;
  end if;
  select * into v_state from platform.aggregate_state where aggregate_type = p_aggregate_type and aggregate_id = p_aggregate_id::uuid;
  if not found then
    return null;
  end if;
  -- Both positions come from one statement, so one snapshot: in separate statements a change committed between them
  -- could let one audit row count as both (then the two can never be equal: a row has one table_name).
  select (select max(e.id)
            from platform.state_history h
            join kernel.audit_event e on e.table_name = 'platform.state_history' and e.record_id = h.id::text
           where h.aggregate_type = v_state.aggregate_type and h.aggregate_id = v_state.aggregate_id and h.to_version = v_state.version),
         (select min(e.id)
            from kernel.audit_event e where e.table_name = 'esig.signature' and e.record_id = p_signature_id::text)
    into v_entered, v_signed;
  if v_entered is null or v_signed is null or v_signed < v_entered then
    return format('signature %s was applied before %s:%s entered state %s at version %s; it belongs to an earlier stay in that state (sign again)',
                  p_signature_id, p_aggregate_type, p_aggregate_id, v_state.state, v_state.version);
  end if;
  return null;
end
$$;

select platform.register_hook('SIGNATURE', 'platform.transition_signature_check(uuid, text, text, text, jsonb)');

-- Canonical signable content of a platform sample record (content-provider contract in esig 0200).
-- The content is exactly the registered signed columns (title, body), and content_version is the
-- record's stored version of them (0551), which changes only when they do: a save that changes
-- nothing keeps the hash, and the hash a change supersedes a signature with is the final one.
create function platform.sample_record_content(p_id text) returns jsonb
language sql stable security definer set search_path = pg_catalog, platform, kernel, pg_temp as $$
  select coalesce((
    select jsonb_build_object(
      'exists', true,
      'content_version', r.content_version,
      'content', jsonb_build_object('title', r.title, 'body', r.body),
      'state', (select s.state from platform.aggregate_state s where s.aggregate_type = 'sample_record' and s.aggregate_id = r.id))
    from platform.stub_record r where r.id::text = p_id), '{"exists": false}'::jsonb)
$$;

select esig.register_content_provider('sample_record', 'platform.sample_record_content(text)', 'platform sample record (state-engine scaffolding)');
select esig.register_signed_table('platform.stub_record', 'sample_record', 'id', array['title', 'body']);

reset role;
