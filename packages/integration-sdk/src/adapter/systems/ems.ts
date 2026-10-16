/**
 * EMS contract (Phase 6 slice 6b-0; DI-49, DI-32, DI-31; D-P6b-6): environmental monitoring of Tablets rooms, the room
 * temperature and relative humidity only (differential pressure, particles and grades are Injectables, on the same
 * alarm log). The EMS is its own system with its own adapter (6a framework); its messages reuse the shapes of the
 * equipment data (equipment-data.ts) with subjectKind AREA and a room tag below. A feed gap is an alarm (outline 4.6:
 * the adapter framework's SEQUENCE_GAP, and the EMS's own FEED_GAP occurrence on the plant alarm log).
 *
 * Receiving commands (recipe-core 0960): plant.receive_series_chunk, plant.receive_equipment_alarm.
 */
import type { SystemContract } from '../contract.ts';
import { EquipmentAlarmV1, SeriesChunkV1 } from '../equipment-data.ts';
import { EQUIPMENT_DATA_REFUSALS } from './opcua.ts';

/** The room tags of the Tablets EMS (unit and fraction digits as the eBMR shows them). */
export const EMS_TAGS = [
  { tag: 'room.temp_C', unit: 'degC', scale: 1 },
  { tag: 'room.rh_pct', unit: '%RH', scale: 1 },
] as const;
export type EmsTag = (typeof EMS_TAGS)[number]['tag'];

export const EMS: SystemContract = {
  system: 'EMS',
  inbound: {
    'ems.series_chunk': { summary: 'Native temperature or humidity samples of one room sensor (subjectKind AREA)', versions: { '1': SeriesChunkV1 } },
    'ems.alarm': { summary: 'A room alarm raised, cleared or acknowledged at the EMS (limit excursion, feed gap)', versions: { '1': EquipmentAlarmV1 } },
  },
  outbound: [],
  refusalCodes: EQUIPMENT_DATA_REFUSALS,
};
