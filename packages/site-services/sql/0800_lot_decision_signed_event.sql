-- Material lots: a MATERIAL_LOT_STATUS_DECIDED signature binds the decision it was given for (Phase 3 exit review
-- HIGH-2; outline 5.2.9; controls DI-37, IN-24, INV-09).
--
-- The lot's machine (0711) signs HOLD, UNHOLD, RETURN, RECALL and RELEASE_FOR_FURTHER_PROCESSING with the one meaning
-- MATERIAL_LOT_STATUS_DECIDED, and the signed content (0721) showed the lot and its states only. A signature given in
-- ON_HOLD for a RETURN therefore also served an UNHOLD (or a RECALL), and one given in RELEASED for a HOLD served a
-- RECALL or a RETURN. A signature is bound to the content hash only, with no place for command arguments (0720), so
-- the decision has to be in the content before the signing:
--
--   * site.lot_decision_intent: insert-only, audited, a registered signed table of the lot. QA proposes the decision
--     (site.propose_lot_decision, MATERIAL.QA_DISPOSITION in the lot's site): an event the lot's pinned machine
--     version signs with MATERIAL_LOT_STATUS_DECIDED out of its current state, recorded with that state and version.
--     A proposal supersedes the lot's earlier signatures (a signed-table change, INV-09).
--   * site.lot_signed_decision(lot): the event of the latest proposal made at the lot's current state version, or NULL.
--   * site.material_lot_content (CREATE OR REPLACE from 0721): 0721's content plus 'decision'; proposals count in the
--     content version.
--   * the guard material_lot.command_recorded (CREATE OR REPLACE from 0710; every transition of the machine runs it):
--     0710's check first, then, for a transition whose meaning is MATERIAL_LOT_STATUS_DECIDED, the event fired must be
--     the decision the signed content shows (EBMR-SITE-114). The engine accepts the signature only while its content
--     hash is the lot's current one, so the event applied is the event signed.
--
-- RELEASE (MATERIAL_LOT_RELEASED), REJECT (MATERIAL_LOT_REJECTED) and DESTROY (MATERIAL_DESTRUCTION_WITNESSED) have a
-- meaning of their own and need no proposal.
--
-- Existing signatures: the content changes (a new key), so, as in 0720 and 0721, every lot with a signature not yet
-- superseded goes through esig.content_changed (recorded SUPERSEDED_BY_CHANGE with the previous hash).
-- Messages: EBMR-SITE-113, EBMR-SITE-114.

set local role ebmr_owner;

create table site.lot_decision_intent (
  id                   uuid primary key default gen_random_uuid(),
  lot_id               uuid not null references site.material_lot (id),
  event                text not null check (event ~ '^[A-Z][A-Z_]{0,63}$'),
  from_state           text not null,
  state_version        bigint not null check (state_version >= 1),
  proposed_by_person   uuid not null,
  proposed_by_account  uuid not null,
  proposed_at          timestamptz not null default clock_timestamp()
);
create index lot_decision_intent_lot on site.lot_decision_intent (lot_id, state_version, proposed_at desc);
revoke all on site.lot_decision_intent from public;

select platform.enforce_db_time('site.lot_decision_intent', array['proposed_at']);
select kernel.register_audited_table('site.lot_decision_intent', 'material_lot', 'lot_id', true);
select esig.register_signed_table('site.lot_decision_intent', 'material_lot', 'lot_id');

-- The event of the latest proposal made at the lot's current state version, or NULL.
create function site.lot_signed_decision(p_lot uuid) returns text
language sql stable security definer set search_path = pg_catalog, site, platform, pg_temp as $$
  select i.event
    from site.lot_decision_intent i
    join platform.aggregate_state s on s.aggregate_type = 'material_lot' and s.aggregate_id = p_lot
   where i.lot_id = p_lot and i.state_version = s.version and i.from_state = s.state
   order by i.proposed_at desc, i.id desc
   limit 1
$$;

-- The meaning the lot's pinned machine version signs p_event with out of its current state, or NULL.
create function site.lot_event_meaning(p_lot uuid, p_event text) returns text
language sql stable security definer set search_path = pg_catalog, site, platform, pg_temp as $$
  select t.signature_meaning
    from platform.aggregate_state s
    join platform.machine_transition t on t.machine_code = s.machine_code and t.machine_version = s.machine_version
                                      and t.from_state = s.state and t.event = p_event
   where s.aggregate_type = 'material_lot' and s.aggregate_id = p_lot
$$;

create function site.propose_lot_decision(p_lot uuid, p_event text) returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, site, iam, platform, pg_temp as $$
declare
  v_ctx jsonb := site.require_actor();
  l     site.material_lot;
  s     platform.aggregate_state;
  v_id  uuid;
begin
  perform iam.assert_not_administrator();
  l := site.lock_lot(p_lot);
  perform iam.require_permission('MATERIAL.QA_DISPOSITION', jsonb_build_object('site', l.site_code));
  select * into s from platform.aggregate_state where aggregate_type = 'material_lot' and aggregate_id = l.id;
  if site.lot_event_meaning(l.id, p_event) is distinct from 'MATERIAL_LOT_STATUS_DECIDED' then
    raise exception using errcode = 'P0001',
      message = format('EBMR-SITE-113 %s is no QA status decision on lot %s in state %s: a proposal names HOLD, UNHOLD, RETURN, RECALL or RELEASE_FOR_FURTHER_PROCESSING where the lot''s machine allows it (RELEASE and REJECT carry their own meaning)',
                       coalesce(p_event, 'NULL'), l.lot_code, s.state);
  end if;
  insert into site.lot_decision_intent (lot_id, event, from_state, state_version, proposed_by_person, proposed_by_account)
  values (l.id, p_event, s.state, s.version, (v_ctx ->> 'person_id')::uuid, (v_ctx ->> 'account_id')::uuid)
  returning id into v_id;
  return v_id;
end
$$;

-- 0721's provider plus 'decision' (header); proposals count in the content version.
create or replace function site.material_lot_content(p_id text) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, site, platform, pg_temp as $$
declare
  l site.material_lot;
begin
  if coalesce(p_id, '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return '{"exists": false}'::jsonb;
  end if;
  select * into l from site.material_lot where id = p_id::uuid;
  if not found then
    return '{"exists": false}'::jsonb;
  end if;
  return jsonb_build_object(
    'exists', true,
    'content_version', 1 + (select count(*) from site.lot_identity_result r where r.lot_id = l.id)
                         + (select count(*) from site.lot_destruction d where d.lot_id = l.id)
                         + (select count(*) from site.lot_state_entry e where e.lot_id = l.id)
                         + (select count(*) from site.lot_decision_intent i where i.lot_id = l.id),
    'content', jsonb_build_object(
      'lot_code', l.lot_code, 'site_code', l.site_code, 'material_code', l.material_code, 'material_name', l.material_name,
      'material_kind', l.material_kind, 'supplier', l.supplier, 'supplier_lot', l.supplier_lot,
      'received_quantity', l.received_quantity::text, 'unit', l.unit, 'retest_at', site.utc_text(l.retest_at),
      'expires_at', site.utc_text(l.expires_at), 'received_by', l.received_by_person,
      'release_route', site.lot_signed_release_route(l.id),
      'decision', site.lot_signed_decision(l.id),
      'identity_results', (select coalesce(jsonb_agg(jsonb_build_object('id', r.id, 'result', r.result, 'method_reference', r.method_reference,
                                                                        'test_reference', r.test_reference, 'recorded_by', r.recorded_by_person,
                                                                        'recorded_at', site.utc_text(r.recorded_at))
                                                     order by r.recorded_at, r.id), '[]'::jsonb)
                           from site.lot_identity_result r where r.lot_id = l.id),
      'destruction', (select jsonb_build_object('id', d.id, 'method', d.method, 'reason', d.reason, 'quantity', d.quantity::text, 'unit', d.unit,
                                                'performed_by', d.performed_by_person, 'recorded_at', site.utc_text(d.recorded_at))
                      from site.lot_destruction d where d.lot_id = l.id),
      'state_entries', (select coalesce(jsonb_agg(jsonb_build_object('state', e.state, 'state_version', e.state_version::text)
                                                  order by e.state_version), '[]'::jsonb)
                        from site.lot_state_entry e where e.lot_id = l.id)),
    'state', site.lot_state(l.id),
    'scope', jsonb_build_object('site', l.site_code),
    'entered_by', (select to_jsonb(array_agg(distinct p)) from (
                     select l.received_by_person as p
                     union all select r.recorded_by_person from site.lot_identity_result r where r.lot_id = l.id
                     union all select d.performed_by_person from site.lot_destruction d where d.lot_id = l.id) x));
end
$$;

-- 0710's check, then the signed decision of a MATERIAL_LOT_STATUS_DECIDED transition (header).
create or replace function site.guard_command_recorded(p_type text, p_id uuid, p_transition jsonb, p_payload jsonb, p_actor jsonb) returns text
language plpgsql stable security definer set search_path = pg_catalog, site, platform, pg_temp as $$
declare
  v_meaning text;
  v_signed  text;
begin
  if not exists (select 1 from site.lot_status_command c
                  where c.lot_id = p_id and c.xact_id = txid_current()
                    and c.event = p_transition ->> 'event' and c.from_state = p_transition ->> 'from') then
    return 'a lot''s status changes only through the site lot commands, which record the change and revoke reservations; a direct transition is refused (INV-13)';
  end if;
  select t.signature_meaning into v_meaning
    from platform.machine_transition t
   where t.machine_code = p_transition ->> 'machine' and t.machine_version = (p_transition ->> 'machine_version')::integer
     and t.from_state = p_transition ->> 'from' and t.event = p_transition ->> 'event';
  if v_meaning is distinct from 'MATERIAL_LOT_STATUS_DECIDED' then
    return null;
  end if;
  v_signed := site.lot_signed_decision(p_id);
  if v_signed is distinct from p_transition ->> 'event' then
    return format('EBMR-SITE-114 the MATERIAL_LOT_STATUS_DECIDED signature on lot %s covers %s; %s is refused: QA proposes the decision (site.propose_lot_decision) and signs the content that names it (DI-37, IN-24)',
                  (select l.lot_code from site.material_lot l where l.id = p_id),
                  coalesce('decision ' || v_signed, 'no decision'), p_transition ->> 'event');
  end if;
  return null;
end
$$;

revoke all on site.lot_decision_intent from ebmr_app;
grant select on site.lot_decision_intent to ebmr_app;
revoke all on function site.lot_signed_decision(uuid), site.lot_event_meaning(uuid, text), site.propose_lot_decision(uuid, text) from public;
grant execute on function site.lot_signed_decision(uuid), site.propose_lot_decision(uuid, text) to ebmr_app;

select kernel.set_actor_context(jsonb_build_object(
  'person_id', '00000000-0000-0000-0000-000000000000', 'account_id', '00000000-0000-0000-0000-000000000000',
  'role_code', 'SOFTWARE_RELEASE', 'session_id', '00000000-0000-0000-0000-000000000000', 'source', 'SYSTEM',
  'site_zone', 'UTC', 'correlation_id', gen_random_uuid(),
  'legal_name', 'Software release (site-services migration 0800_lot_decision_signed_event)',
  'reason_code', 'SOFTWARE_RELEASE',
  'reason_text', 'the material lot signed content names the QA status decision proposed (DI-37, IN-24, INV-09)'));

select esig.content_changed('material_lot', l.id::text, 'site.material_lot_content', 'UPDATE')
from site.material_lot l
where exists (select 1 from esig.signature s
              where s.aggregate_ref = 'material_lot:' || l.id::text
                and not exists (select 1 from esig.signature_invalidation i where i.signature_id = s.id));

select kernel.set_actor_context(null);

reset role;
