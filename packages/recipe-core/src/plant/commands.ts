/**
 * Thin, typed callers of the plant functions (sql/0400-0405). Every writer runs inside a command the caller started
 * (kernel withCommand); the database decides and refuses with a code (EBMR-PLANT-NNN, or the kernel's EBMR-PLAT,
 * EBMR-IAM, EBMR-ESIG codes), raised here as KernelError. Instants travel as ISO text and are compared in the
 * database; durations as PostgreSQL interval text.
 */
import type pg from 'pg';
import { commands } from '@ebmr/kernel';
import { AREA_AGGREGATE, AREA_MACHINE, EQUIPMENT_AGGREGATE, EQUIPMENT_MACHINE } from './machine.ts';

type Db = pg.Pool | pg.PoolClient;

export type EquipmentKind = 'PROCESS' | 'INSTRUMENT' | 'UTILITY';
export type CleaningLevel = 'MINOR' | 'MAJOR';
export type ClearanceType = 'PRODUCT_CHANGE' | 'CAMPAIGN' | 'PACKAGING_ORDER';
export type EquipmentEventKind =
  | 'QUALIFIED'
  | 'QUALIFICATION_WITHDRAWN'
  | 'MAINTENANCE_STARTED'
  | 'MAINTENANCE_ENDED'
  | 'TAKEN_OUT_OF_SERVICE'
  | 'RETURNED_TO_SERVICE'
  | 'FAILURE_SIGNALLED'
  | 'REPAIRED'
  | 'RETIRED';

export interface ProductDefinition {
  code: string;
  name: string;
  highlyPotent: boolean;
}

export interface EquipmentClassDefinition {
  code: string;
  kind: EquipmentKind;
  description: string;
  /** PROCESS only: PostgreSQL interval text, e.g. '72 hours'. */
  cleanHold?: string;
  dirtyHold?: string;
  calibrationRequired?: boolean;
  /** INSTRUMENT only. */
  checkRegime?: 'PER_USE' | 'DAILY';
}

export interface AreaDefinition {
  code: string;
  kind: 'ROOM' | 'LINE';
  name: string;
  segregated?: boolean;
  segregationJustification?: string;
  negativePressure?: boolean;
}

export interface EquipmentDefinition {
  code: string;
  name: string;
  classCode: string;
  areaCode?: string;
}

export interface CampaignDefinition {
  equipmentCode?: string;
  areaCode?: string;
  product: string;
  maxBatches: number;
  maxDays: number;
  validationRef: string;
}

async function one<T>(db: Db, sql: string, params: unknown[]): Promise<T> {
  try {
    const { rows } = await db.query<{ r: T }>(sql, params);
    if (rows.length === 0) throw new Error(`no result from ${sql}`);
    return (rows[0] as { r: T }).r;
  } catch (error) {
    throw commands.asKernelError(error);
  }
}

export const defineProduct = (db: Db, def: ProductDefinition): Promise<string> => one(db, 'select plant.define_product($1::jsonb) as r', [JSON.stringify(def)]);
export const defineEquipmentClass = (db: Db, def: EquipmentClassDefinition): Promise<string> =>
  one(db, 'select plant.define_equipment_class($1::jsonb) as r', [JSON.stringify(def)]);
export const defineArea = (db: Db, def: AreaDefinition): Promise<string> => one(db, 'select plant.define_area($1::jsonb) as r', [JSON.stringify(def)]);
export const defineEquipment = (db: Db, def: EquipmentDefinition): Promise<string> =>
  one(db, 'select plant.define_equipment($1::jsonb) as r', [JSON.stringify(def)]);

export const recordEquipmentEvent = (
  db: Db,
  equipmentCode: string,
  kind: EquipmentEventKind,
  detail: string,
  reference?: string,
  batchRef?: string,
): Promise<string> =>
  one(db, 'select plant.record_equipment_event($1, $2, $3, $4, $5) as r', [equipmentCode, kind, detail, reference ?? null, batchRef ?? null]);

/** IN-25 (d): a failure signalled from a step takes the unit out of use until it is repaired. */
export const signalFailure = (db: Db, equipmentCode: string, batchRef: string, detail: string): Promise<string> =>
  recordEquipmentEvent(db, equipmentCode, 'FAILURE_SIGNALLED', detail, undefined, batchRef);

export const recordCalibration = (
  db: Db,
  equipmentCode: string,
  dueAt: string,
  asFound: 'PASS' | 'FAIL',
  asLeft: 'PASS' | 'FAIL',
  reference: string,
): Promise<string> => one(db, 'select plant.record_calibration($1, $2::timestamptz, $3, $4, $5) as r', [equipmentCode, dueAt, asFound, asLeft, reference]);

export const recordInstrumentCheck = (db: Db, equipmentCode: string, result: 'PASS' | 'FAIL', reference: string, batchRef?: string): Promise<string> =>
  one(db, 'select plant.record_instrument_check($1, $2, $3, $4) as r', [equipmentCode, result, reference, batchRef ?? null]);

export const recordInstrumentUse = (db: Db, equipmentCode: string, batchRef: string, product: string, plannedEnd: string): Promise<string> =>
  one(db, 'select plant.record_instrument_use($1, $2, $3, $4::timestamptz) as r', [equipmentCode, batchRef, product, plannedEnd]);

export const recordUtilityReading = (
  db: Db,
  equipmentCode: string,
  status: 'OK' | 'ALARM' | 'FAULT' | 'OFFLINE',
  source: string,
  observedAt: string,
): Promise<string> => one(db, 'select plant.record_utility_reading($1, $2, $3, $4::timestamptz) as r', [equipmentCode, status, source, observedAt]);

export const utilityProblem = (db: Db, equipmentCode: string): Promise<string | null> => one(db, 'select plant.utility_problem($1) as r', [equipmentCode]);

export const openCampaign = (db: Db, def: CampaignDefinition): Promise<string> => one(db, 'select plant.open_campaign($1::jsonb) as r', [JSON.stringify(def)]);
export const closeCampaign = async (db: Db, campaignId: string, reason: string): Promise<void> => {
  await one(db, 'select plant.close_campaign($1, $2) as r', [campaignId, reason]);
};

export const startCleaning = (db: Db, target: 'EQUIPMENT' | 'AREA', code: string, level: CleaningLevel, method: 'MANUAL' | 'CIP' = 'MANUAL'): Promise<string> =>
  one(db, 'select plant.start_cleaning($1, $2, $3, $4) as r', [target, code, level, method]);
export const completeCleaning = async (db: Db, cleaningId: string, cycleReference?: string): Promise<void> => {
  await one(db, 'select plant.complete_cleaning($1, $2) as r', [cleaningId, cycleReference ?? null]);
};
/** The verifier's signature LOGBOOK_DOUBLE_CHECKED on aggregate plant_cleaning, applied in their own session first. */
export const verifyCleaning = async (db: Db, cleaningId: string, signatureId: string): Promise<void> => {
  await one(db, 'select plant.verify_cleaning($1, $2) as r', [cleaningId, signatureId]);
};
/** The command carries the person's own reason (reason code and text of the command context). */
export const abandonCleaning = async (db: Db, cleaningId: string): Promise<void> => {
  await one(db, 'select plant.abandon_cleaning($1) as r', [cleaningId]);
};

export const startEquipmentUse = (db: Db, equipmentCode: string, batchRef: string, product: string, plannedEnd: string): Promise<string> =>
  one(db, 'select plant.start_equipment_use($1, $2, $3, $4::timestamptz) as r', [equipmentCode, batchRef, product, plannedEnd]);
export const endEquipmentUse = (
  db: Db,
  useId: string,
): Promise<{
  use_id: string;
  clean_hold_crossed: boolean;
  calibration_crossed: boolean;
}> => one(db, 'select plant.end_equipment_use($1) as r', [useId]);

export const recordClearance = (
  db: Db,
  areaCode: string,
  type: ClearanceType,
  next: { batch: string; product: string; order?: string; artworkSet?: string },
): Promise<string> =>
  one(db, 'select plant.record_clearance($1, $2, $3, $4, $5, $6) as r', [
    areaCode,
    type,
    next.batch,
    next.product,
    next.order ?? null,
    next.artworkSet ?? null,
  ]);
/** The verifier's signature VERIFIED on aggregate plant_clearance, applied in their own session first. */
export const verifyClearance = async (db: Db, clearanceId: string, result: 'PASSED' | 'FAILED', signatureId: string): Promise<void> => {
  await one(db, 'select plant.verify_clearance($1, $2, $3) as r', [clearanceId, result, signatureId]);
};

export const startAreaOccupancy = (
  db: Db,
  areaCode: string,
  start: {
    batch: string;
    product: string;
    stage: string;
    order?: string;
    artworkSet?: string;
  },
): Promise<string> =>
  one(db, 'select plant.start_area_occupancy($1, $2, $3, $4, $5, $6) as r', [
    areaCode,
    start.batch,
    start.product,
    start.stage,
    start.order ?? null,
    start.artworkSet ?? null,
  ]);
export const endAreaOccupancy = async (db: Db, occupancyId: string): Promise<void> => {
  await one(db, 'select plant.end_area_occupancy($1) as r', [occupancyId]);
};

export interface PlantState {
  state: string;
  version: number;
}

async function stateOf(db: Db, aggregateType: string, id: string): Promise<PlantState | null> {
  const { rows } = await db.query<{ state: string; version: string }>(
    'select state, version::text as version from platform.aggregate_state where aggregate_type = $1 and aggregate_id = $2',
    [aggregateType, id],
  );
  const r = rows[0];
  return r ? { state: r.state, version: Number(r.version) } : null;
}

export const equipmentState = (db: Db, equipmentId: string): Promise<PlantState | null> => stateOf(db, EQUIPMENT_AGGREGATE, equipmentId);
export const areaState = (db: Db, areaId: string): Promise<PlantState | null> => stateOf(db, AREA_AGGREGATE, areaId);
export const equipmentFitness = (db: Db, equipmentId: string): Promise<string | null> => one(db, 'select plant.equipment_fitness($1) as r', [equipmentId]);

export const MACHINES = {
  equipment: EQUIPMENT_MACHINE,
  area: AREA_MACHINE,
} as const;
