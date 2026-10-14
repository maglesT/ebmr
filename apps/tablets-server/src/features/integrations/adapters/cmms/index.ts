/**
 * The CMMS adapter (Phase 6 slice 6a, builder B): cmms.calibration and cmms.maintenance to plant.receive_cmms_calibration
 * and plant.receive_cmms_maintenance (recipe-core 0950); its heartbeat keeps the CMMS_CALIBRATION and CMMS_MAINTENANCE
 * mirrors fresh, which the equipment-use guard reads (plant.fitness_problems). Runs on the feed pull worker.
 */
import { CMMS } from '@ebmr/integration-sdk/adapter';
import type { FeedAdapterSpec } from '../feed-pull/worker.ts';

export const CMMS_ADAPTER: FeedAdapterSpec = {
  system: 'CMMS',
  prefix: 'cmms',
  receive: { 'cmms.calibration': 'plant.receive_cmms_calibration', 'cmms.maintenance': 'plant.receive_cmms_maintenance' },
  mirrorClasses: ['CMMS_CALIBRATION', 'CMMS_MAINTENANCE'],
  refusalCodes: CMMS.refusalCodes,
};
