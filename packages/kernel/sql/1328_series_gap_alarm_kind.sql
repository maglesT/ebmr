-- Phase 7 slice 7b-1 (the T12 observation of the gateway, decision 0022; controls DI-32, DI-31): the integration alarm
-- kind SERIES_GAP, a stretch of a unit's series the gateway could not record.
--
-- Handbook: modules/integrations.md
--
-- The gateway spools each sample of an open chunk on receipt; after a crash it completes the open chunk from the spool
-- and reports, for each series it was recording, the stretch from its last spooled sample to the restart as an
-- opcua.series_gap message (recipe-core 1232, plant.receive_series_gap), which raises this alarm naming the unit, the
-- tag and the interval. The kind joins the list of kernel 1180; every existing kind stays.

set local role ebmr_owner;

alter table platform.integration_alarm drop constraint integration_alarm_kind_check;
alter table platform.integration_alarm add constraint integration_alarm_kind_check
  check (kind in ('SEQUENCE_GAP', 'OUT_OF_ORDER', 'MALFORMED', 'DUPLICATE', 'WRONG_IDENTITY', 'OUT_OF_RANGE',
                  'STALE', 'PARTIAL', 'TRANSPORT', 'RECONCILIATION_MISMATCH', 'SERIES_GAP'));

reset role;
