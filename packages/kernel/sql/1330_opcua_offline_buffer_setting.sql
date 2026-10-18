-- Phase 7 slice 7b-1 (review round 1 of 7b-1b, finding 1 and 3; control DI-32): how long the site gateway holds data
-- while it is cut off from its endpoints or from the server, as a platform setting.
--
-- Handbook: modules/integrations.md
--
-- integration.opcua_offline_buffer_s (seconds, default 7 days, 1 hour to 30 days): the oldest an OPC UA alarm or
-- equipment event may be before the endpoint session it stands on, and the oldest an endpoint session's start may be
-- before the database's clock when it is received (recipe-core 1234). A record that happened while the gateway was
-- down and arrives at reconnect, or a session pulled after a server outage, is within it; a time from a clock at 1970
-- is not. Like every platform setting it changes only through platform.set_setting under a change record (DI-09).

set local role ebmr_owner;

select kernel.set_actor_context(jsonb_build_object(
  'person_id', '00000000-0000-0000-0000-000000000000', 'account_id', '00000000-0000-0000-0000-000000000000',
  'role_code', 'SOFTWARE_RELEASE', 'session_id', '00000000-0000-0000-0000-000000000000', 'source', 'SYSTEM',
  'site_zone', 'UTC', 'correlation_id', gen_random_uuid(),
  'legal_name', 'Software release (kernel migration 1330_opcua_offline_buffer_setting)',
  'reason_code', 'SOFTWARE_RELEASE',
  'reason_text', 'OPC UA offline buffer window (DI-32, Phase 7 slice 7b-1)'));

insert into platform.setting_definition (key, value_type, default_value, min_value, max_value, allowed_values, max_scale, unit, description, basis) values
  ('integration.opcua_offline_buffer_s', 'INTEGER', '604800', 3600, 2592000, null, null, 's',
   'How long the site gateway holds OPC UA data while offline: the oldest an alarm or equipment event may be before its endpoint session, and a session''s start before the database clock at receipt',
   'Phase 7 slice 7b-1 review finding 1: data that happened while the gateway was down still land; a 1970 time does not. Default 7 days');

select kernel.set_actor_context(null);

reset role;
