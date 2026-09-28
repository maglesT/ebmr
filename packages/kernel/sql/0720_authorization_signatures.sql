-- Authorization (B7), part 3: electronic signatures on the records and continuity approvals
-- (DI-37 linking; DI-01, DI-45, DI-47, DI-50 approvals).
--
-- 1. The signature types of these approvals name the permissions the approving functions check
--    (0700), so a person can sign only what they may approve: new versions of the records types
--    and a new vendor type RESTORE_APPROVED. The catalogue is insert-only and audited
--    (esig_meaning:<code>); like 0700, the rows are written under the software-release identity,
--    which the e-signature catalogue guard (0210) accepts for vendor types and new versions.
-- 2. Content providers (contract: esig 0200) for the signed aggregates; each names its record by its
--    canonical id (aggregate_id), so a challenge naming it any other way is refused. Each signed content is
--    immutable, so a signature stays valid for the life of the record and a changed situation needs
--    a new signature on a new aggregate:
--      record_type_version  <code>:<version>              one version of a record type (DI-01)
--      di_investigation     <investigation id>            the investigation as opened (DI-50)
--      record_disposal      <record key>@<retain-until>[@<true copy id>]
--                                                         the disposal of a record at that retain-until, with
--                                                         the archived true copy the approval cites (DI-47)
--      restore_event        <restore event id>            the recorded restore, as hashed (DI-45)
--    The approving functions (0400, 0430, 0440, 0600) accept a signature only through
--    esig.assert_signature for that meaning and aggregate, signed by the approving person.

set local role ebmr_owner;

select kernel.set_actor_context(jsonb_build_object(
  'person_id', '00000000-0000-0000-0000-000000000000', 'account_id', '00000000-0000-0000-0000-000000000000',
  'role_code', 'SOFTWARE_RELEASE', 'session_id', '00000000-0000-0000-0000-000000000000', 'source', 'SYSTEM',
  'site_zone', 'UTC', 'correlation_id', gen_random_uuid(),
  'legal_name', 'Software release (kernel migration 0720_authorization_signatures)',
  'reason_code', 'SOFTWARE_RELEASE',
  'reason_text', 'signature types of the records and continuity approvals name the approving permissions (DI-17)'));

-- New versions: only the permissions change (the minimum-set guard keeps meaning, class and rules).
insert into esig.meaning_type (code, version, origin, is_minimum, status, category, role_class, title, meaning_text, permissions,
                               independent_of, excludes_performers, excludes_involved, witness, reauth, delegable, sources, reason)
select m.code, m.version + 1, m.origin, m.is_minimum, m.status, m.category, m.role_class, m.title, m.meaning_text, x.permissions,
       m.independent_of, m.excludes_performers, m.excludes_involved, m.witness, m.reauth, m.delegable, m.sources,
       'kernel 0720: signed by the holders of the approving permission'
from (values
  ('RECORD_TYPE_APPROVED', array['RECORD.TYPE_APPROVE']),
  ('RECORD_DISPOSAL_APPROVED', array['RECORD.DISPOSAL_APPROVE']),
  ('DI_INVESTIGATION_CLOSED', array['DI_INVESTIGATION.APPROVE_CLOSURE'])
) as x (code, permissions)
join esig.meaning_catalogue m on m.code = x.code;

-- A vendor type for the approval of a restore event by a named second person.
insert into esig.meaning_type (code, version, origin, is_minimum, status, category, role_class, title, meaning_text, permissions,
                               independent_of, excludes_performers, excludes_involved, witness, reauth, delegable, sources)
values ('RESTORE_APPROVED', 1, 'VENDOR', true, 'ACTIVE', 'RECORDS', 'APPROVER', 'Restore approved',
        'As a named second person, I approve this recorded restore and the history it lists as discarded.',
        array['CONTINUITY.RESTORE_APPROVE'], '{}', true, false, false, 'ALL_COMPONENTS', false,
        'DI-45; outline 4.2 restore procedure; INV-08; INV-27');

select kernel.set_actor_context(null);

-- ---------------------------------------------------------------------------------------------
-- Content providers
-- ---------------------------------------------------------------------------------------------

-- One version of a record type; its author entered it, so INV-03 keeps them from approving it.
create function records.record_type_version_content(p_id text) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, records, pg_temp as $$
declare
  m text[] := regexp_match(coalesce(p_id, ''), '^(.+):([1-9][0-9]{0,8})$');
  t records.record_type%rowtype;
begin
  if m is null then
    return '{"exists": false}'::jsonb;
  end if;
  select * into t from records.record_type where code = m[1] and version = m[2]::integer;
  if not found then
    return '{"exists": false}'::jsonb;
  end if;
  return jsonb_build_object(
    'exists', true,
    'aggregate_id', t.code || ':' || t.version::text,
    'content_version', 1,
    'content', jsonb_build_object(
      'code', t.code, 'version', t.version::text, 'title', t.title, 'description', t.description, 'official_record', t.official_record,
      'data_class', t.data_class, 'gmp_criticality', t.gmp_criticality, 'official_medium', t.official_medium,
      'original_and_copies', t.original_and_copies, 'hybrid_linkage', t.hybrid_linkage, 'storage_location', t.storage_location,
      'owning_module', t.owning_module, 'owner_role', t.owner_role, 'retention_key', t.retention_key, 'review_rule', t.review_rule,
      'retained_metadata', to_jsonb(t.retained_metadata), 'feeds_acceptance_limit', t.feeds_acceptance_limit),
    'state', case when exists (select 1 from records.record_type_approval a where a.code = t.code and a.version = t.version)
                  then 'APPROVED' else 'DEFINED' end,
    'entered_by', jsonb_build_array(t.defined_by_person));
end
$$;

-- A data-integrity investigation as opened: subject, window, concern, investigator. The person who
-- opened it and the investigator are its authors (INV-03); the closure function also refuses the
-- person investigated.
create function records.di_investigation_content(p_id text) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, records, pg_temp as $$
declare
  d records.di_investigation_current%rowtype;
begin
  if coalesce(p_id, '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return '{"exists": false}'::jsonb;
  end if;
  select * into d from records.di_investigation_current where id = p_id::uuid;
  if not found then
    return '{"exists": false}'::jsonb;
  end if;
  return jsonb_build_object(
    'exists', true,
    'aggregate_id', d.id::text,
    'content_version', 1,
    'content', jsonb_build_object(
      'reference', d.reference, 'subject_person_id', d.subject_person_id,
      'window_from', to_char(d.window_from at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
      'window_to', to_char(d.window_to at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
      'concern', d.concern, 'investigator_person', d.investigator_person, 'opened_by_person', d.opened_by_person,
      'qms_reference', d.qms_reference,
      'opened_at', to_char(d.recorded_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')),
    'state', d.status,
    'entered_by', jsonb_build_array(d.opened_by_person, d.investigator_person));
end
$$;

-- The disposal of one record at one retain-until date, with the archived true copy it cites (if
-- any) and the tables that copy holds, the retention inputs in force (their latest version: a new
-- version supersedes the one signed, so the signature no longer matches) and the hold watermark (the
-- last hold placed on the record or on a record depending on it: a hold voids every approval given
-- before it, owner decision 0004, so a signature made before a hold no longer matches either). The
-- state says whether the record may be disposed of at that date now (retention ended there and
-- nothing blocks disposal).
-- Everyone who entered what decides that date (the schedule, every version of the retention inputs and
-- every dependency link of the record and of the records depending on it: records.retention_authors)
-- is an author of the disposal, so the independence rules refuse their signature (F33, DI-47).
create function records.record_disposal_content(p_id text) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, records, kernel, pg_temp as $$
declare
  m     text[] := regexp_match(coalesce(p_id, ''),
                               '^(.+)@([0-9]{4}-[0-9]{2}-[0-9]{2})(@[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})?$');
  s     records.retention_schedule%rowtype;
  c     records.true_copy%rowtype;
  i     records.retention_input%rowtype;
  v_eff jsonb;
begin
  if m is null then
    return '{"exists": false}'::jsonb;
  end if;
  select * into s from records.retention_schedule where record_key = m[1];
  if not found then
    return '{"exists": false}'::jsonb;
  end if;
  if m[3] is not null then
    select * into c from records.true_copy where id = substr(m[3], 2)::uuid and record_key = s.record_key;
    if not found then
      return '{"exists": false}'::jsonb;
    end if;
  end if;
  i := records.latest_inputs(s.id);
  v_eff := records.compute_effective_retention(s.id);
  return jsonb_build_object(
    'exists', true,
    'aggregate_id', s.record_key || '@' || m[2] || coalesce('@' || c.id::text, ''),
    'content_version', 1,
    'content', jsonb_build_object('record_key', s.record_key, 'retain_until', m[2], 'record_type_code', s.record_type_code,
                                  'record_type_version', s.record_type_version::text, 'retention_key', s.retention_key,
                                  'site_zone', s.site_zone,
                                  'retention_inputs', case when i.id is null then null else
                                    jsonb_build_object('input_version', i.input_version::text, 'inputs', i.inputs,
                                                       'change_reason', i.change_reason) end,
                                  'hold_watermark', records.hold_watermark(s.id)::text,
                                  'true_copy', case when c.id is null then null else
                                    jsonb_build_object('id', c.id, 'manifest_sha256', c.manifest_sha256, 'head_seq', c.head_seq::text,
                                                       'head_hash', encode(c.head_hash, 'hex'), 'tables', to_jsonb(c.tables)) end),
    'state', case when v_eff ->> 'retainUntil' = m[2] and not exists (select 1 from records.disposal_refusals(s.id))
                  then 'DISPOSABLE' else 'NOT_DISPOSABLE' end,
    'entered_by', coalesce((select jsonb_agg(a.person order by a.person) from (select distinct x as person from records.retention_authors(s.id) x) a),
                           '[]'::jsonb));
end
$$;

-- A disposal signature covers the record's retention inputs and its hold watermark: a new version of
-- the inputs, or a hold placed on the record or on a record depending on it, supersedes it in the same
-- transaction (esig.content_changed, INV-09), so the disposal is unsigned and a fresh approval can be
-- signed, by the same QA reviewer too (owner decision 0004: a hold voids every earlier approval).
create function records.disposal_content_changed() returns trigger
language plpgsql volatile security definer set search_path = pg_catalog, records, esig, pg_temp as $$
declare
  v_aggregate text;
  v_key       text;
begin
  for v_aggregate, v_key in
    select distinct g.aggregate_id, (regexp_match(g.aggregate_id, '^(.+)@[0-9]{4}-[0-9]{2}-[0-9]{2}(@[0-9a-f-]{36})?$'))[1]
    from esig.signature g
    where g.aggregate_type = 'record_disposal'
      and not exists (select 1 from esig.signature_invalidation i where i.signature_id = g.id)
    order by 1
  loop
    if tg_table_name = 'retention_hold' then
      continue when not exists (select 1 from records.retention_schedule sup, records.retention_schedule held
                                where sup.record_key = v_key and held.record_key = new.record_key
                                  and held.id = any (records.retention_closure(sup.id)));
    else
      continue when not exists (select 1 from records.retention_schedule sup where sup.record_key = v_key and sup.id = new.schedule_id);
    end if;
    perform esig.content_changed('record_disposal', v_aggregate, tg_table_schema || '.' || tg_table_name, tg_op);
  end loop;
  return null;
end
$$;

create trigger zz_disposal_signatures after insert on records.retention_hold
  for each row execute function records.disposal_content_changed();
create trigger zz_disposal_signatures after insert on records.retention_input
  for each row execute function records.disposal_content_changed();

-- A recorded restore event exactly as its content hash covers it; its operator is its author.
create function continuity.restore_event_signing_content(p_id text) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, continuity, pg_temp as $$
declare
  e continuity.restore_event%rowtype;
begin
  if coalesce(p_id, '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return '{"exists": false}'::jsonb;
  end if;
  select * into e from continuity.restore_event where id = p_id::uuid;
  if not found then
    return '{"exists": false}'::jsonb;
  end if;
  return jsonb_build_object(
    'exists', true,
    'aggregate_id', e.id::text,
    'content_version', 1,
    'content', continuity.restore_event_content(e) || jsonb_build_object('content_hash', encode(e.content_hash, 'hex')),
    'state', (select s.status from continuity.restore_event_status s where s.id = e.id),
    'entered_by', jsonb_build_array(e.operator_person_id));
end
$$;

select esig.register_content_provider('record_type_version', 'records.record_type_version_content(text)',
                                      'one version of a record type in the record-type register (DI-01)');
select esig.register_content_provider('di_investigation', 'records.di_investigation_content(text)',
                                      'a data-integrity investigation as opened (DI-50)');
select esig.register_content_provider('record_disposal', 'records.record_disposal_content(text)',
                                      'the disposal of a record at a retain-until date (DI-47)');
select esig.register_content_provider('restore_event', 'continuity.restore_event_signing_content(text)',
                                      'a recorded restore or failover event (DI-45)');

reset role;
