/**
 * CMMS contract (Phase 6 slice 6a; builder B). Inbound: calibrations and maintenance work orders with due dates (mirror
 * data classes CMMS_CALIBRATION and CMMS_MAINTENANCE; the equipment-use guard reads them).
 * Receiving commands (recipe-core 0950): plant.receive_cmms_calibration, plant.receive_cmms_maintenance.
 */
import { z } from 'zod';
import { CalendarDate, SourceCode, type SystemContract } from '../contract.ts';
import { EpochMicrosText } from '../envelope.ts';

export const CmmsCalibrationV1 = z.strictObject({
  equipmentCode: SourceCode,
  calibrationRef: SourceCode,
  performedAt: EpochMicrosText,
  result: z.enum(['PASS', 'FAIL', 'ADJUSTED_PASS']),
  dueOn: CalendarDate,
});
export const CmmsMaintenanceV1 = z.strictObject({
  equipmentCode: SourceCode,
  workOrder: SourceCode,
  kind: z.enum(['PREVENTIVE', 'CORRECTIVE']),
  status: z.enum(['OPEN', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED']),
  dueOn: CalendarDate.nullable(),
});

export const CMMS: SystemContract = {
  system: 'CMMS',
  inbound: {
    'cmms.calibration': { summary: 'A calibration with its result and next due date', versions: { '1': CmmsCalibrationV1 } },
    'cmms.maintenance': { summary: 'A maintenance work order and its due date', versions: { '1': CmmsMaintenanceV1 } },
  },
  outbound: ['cmms.equipment_fault'],
  refusalCodes: {
    'EBMR-CMMS-001': 'WRONG_IDENTITY',
    'EBMR-CMMS-002': 'MALFORMED',
    'EBMR-CMMS-003': 'WRONG_IDENTITY',
    'EBMR-CMMS-004': 'STALE',
    'EBMR-CMMS-005': 'DUPLICATE',
    'EBMR-CMMS-006': 'OUT_OF_RANGE',
  },
};
