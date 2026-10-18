-- Tablets: a gateway's signed OPC UA feed is bound to one adapter (Phase 7 slice 7a, 6jc-R9 review round 1; controls
-- DI-31, DI-20; tablets 1405).
--
-- Handbook: modules/integrations.md
--
-- The feed signature names the gateway, not the adapter. With two OPCUA adapters bound to the same gateway (1405
-- allowed one live binding per adapter, any number per gateway), an envelope accepted through one could be replayed
-- through the other, whose sequence numbers and idempotency keys are its own. Now:
--   gateway_feed_binding_one_adapter   at most one live binding per gateway code (unique, partial on ended_at null);
--   tab.bind_gateway_feed              (re-created from 1405, every check kept) refuses to bind a gateway already bound
--                                      to another adapter (EBMR-DEV-179); the administrator ends that binding by
--                                      binding the other adapter elsewhere first.

set local role ebmr_owner;

create unique index gateway_feed_binding_one_adapter on tab.gateway_feed_binding (gateway_code) where ended_at is null;

create or replace function tab.bind_gateway_feed(p_adapter_code text, p_gateway_code text, p_reason_code text, p_reason_text text) returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, tab, iam, platform, kernel, pg_temp as $$
declare
  v_actor jsonb := iam.require_permission('IAM.DEVICE_MANAGE', '{}'::jsonb);
  v_ad    iam.integration_adapter%rowtype;
  v_live  tab.gateway_feed_binding%rowtype;
  v_saved jsonb;
  v_id    uuid;
begin
  select * into v_ad from iam.integration_adapter where code = p_adapter_code;
  if not found or v_ad.status <> 'ACTIVE' or not platform.source_requires_signature(v_ad.source_system) then
    raise exception using errcode = 'P0001',
      message = format('EBMR-DEV-178 %s is not an active adapter of a signed gateway feed (OPCUA)', coalesce(p_adapter_code, 'null'));
  end if;
  if not exists (select 1 from tab.gateway_key k where k.gateway_code = p_gateway_code and k.status = 'ACTIVE') then
    raise exception using errcode = 'P0001',
      message = format('EBMR-DEV-178 gateway %s has no active enrolled key; enrol its key first (tab.enrol_gateway_key)', coalesce(p_gateway_code, 'null'));
  end if;
  -- Review round 1 (tablets 1406): one adapter per gateway feed, so an envelope accepted through one adapter cannot be
  -- replayed through another adapter's own sequence space.
  if exists (select 1 from tab.gateway_feed_binding b where b.gateway_code = p_gateway_code and b.ended_at is null and b.adapter_id <> v_ad.id) then
    raise exception using errcode = 'P0001',
      message = format('EBMR-DEV-179 the feed of gateway %s is already bound to adapter %s; a gateway''s feed is pulled by one adapter',
                       p_gateway_code, (select b.adapter_code from tab.gateway_feed_binding b where b.gateway_code = p_gateway_code and b.ended_at is null and b.adapter_id <> v_ad.id limit 1));
  end if;
  select * into v_live from tab.gateway_feed_binding where adapter_id = v_ad.id and ended_at is null;
  if found then
    if v_live.gateway_code = p_gateway_code then
      return v_live.id;
    end if;
    v_saved := tab.with_reason_context(p_reason_code, p_reason_text);
    update tab.gateway_feed_binding set ended_at = clock_timestamp(), ended_reason = p_reason_text where id = v_live.id;
    perform kernel.set_actor_context(v_saved);
  end if;
  insert into tab.gateway_feed_binding (adapter_id, adapter_code, gateway_code, bound_by_person)
  values (v_ad.id, v_ad.code, p_gateway_code, (v_actor ->> 'person_id')::uuid)
  returning id into v_id;
  perform kernel.audit_business_event('gateway_feed_binding:' || v_id,
    format('OPC UA adapter %s bound to the feed of gateway %s', v_ad.code, p_gateway_code),
    jsonb_build_object('adapter_code', v_ad.code, 'gateway_code', p_gateway_code));
  return v_id;
end
$$;

reset role;
