/**
 * The EMS adapter (Phase 6 slice 6b, builder B; DI-31, DI-32, DI-49; D-P6b-6): the room temperature and relative humidity
 * of the Tablets rooms. ems.series_chunk goes to plant.receive_series_chunk (native samples into plant.series, read by
 * plant.room_conditions) and ems.alarm to plant.receive_equipment_alarm (the plant alarm log, source EMS, the room as
 * subject; the EMS's own FEED_GAP occurrence included) (recipe-core 0960). Runs on the worker framework (../framework.ts).
 *
 * No mirror data class (D-P6b-B-8): the EMS is a feed of observations, not a mirror of master data, so its heartbeat
 * records no synchronisation (the cycle reports `synced: false`). A stalled feed shows on the worker (nothing
 * fetched, not caught up) and is delivered in order afterwards; a hole among the accepted sequence numbers (a refused
 * message) raises the framework's SEQUENCE_GAP integration alarm; a silent room sensor is the EMS's FEED_GAP room alarm.
 */
import { EMS } from '@ebmr/integration-sdk/adapter';
import type { FeedAdapterSpec } from '../framework.ts';

export const EMS_ADAPTER: FeedAdapterSpec = {
  system: 'EMS',
  prefix: 'ems',
  receive: { 'ems.series_chunk': 'plant.receive_series_chunk', 'ems.alarm': 'plant.receive_equipment_alarm' },
  mirrorClasses: [],
  contract: EMS,
};
