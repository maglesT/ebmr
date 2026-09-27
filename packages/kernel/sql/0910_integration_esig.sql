-- Integration wiring for electronic signatures (Phase 1). The platform state engine checks every
-- signature a transition needs through its SIGNATURE hook; the e-signature module provides it.
-- The platform's sample record (test scaffolding for the state engine) becomes signable, so a
-- transition that needs a signature is proven end to end with real signatures.

set local role ebmr_owner;

select platform.register_hook('SIGNATURE', 'esig.platform_signature_check(uuid, text, text, text, jsonb)');

-- Canonical signable content of a platform sample record (content-provider contract in esig 0200).
create function platform.sample_record_content(p_id text) returns jsonb
language sql stable security definer set search_path = pg_catalog, platform, kernel, pg_temp as $$
  select coalesce((
    select jsonb_build_object(
      'exists', true,
      'content_version', 1 + (select count(*) from kernel.audit_event e
                              where e.table_name = 'platform.stub_record' and e.record_id = r.id::text and e.action = 'UPDATE'),
      'content', jsonb_build_object('title', r.title, 'body', r.body),
      'state', (select s.state from platform.aggregate_state s where s.aggregate_type = 'sample_record' and s.aggregate_id = r.id))
    from platform.stub_record r where r.id::text = p_id), '{"exists": false}'::jsonb)
$$;

select esig.register_content_provider('sample_record', 'platform.sample_record_content(text)', 'platform sample record (state-engine scaffolding)');
select esig.register_signed_table('platform.stub_record', 'sample_record', 'id', array['title', 'body']);

reset role;
