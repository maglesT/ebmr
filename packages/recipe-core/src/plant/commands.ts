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
  /** PROCESS only: the validation of the class's CIP program; without it every cleaning is MANUAL (two persons). */
  cipValidationRef?: string;
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

/**
 * IN-25 (d): the repairer records the repair of the unit's open failure (work-order reference); the unit stays out of use
 * until a second person verifies it. 'REPAIRED' is no longer accepted by recordEquipmentEvent (sql/0460).
 */
export const recordRepair = (db: Db, equipmentCode: string, detail: string, reference: string): Promise<string> =>
  one(db, 'select plant.record_repair($1, $2, $3) as r', [equipmentCode, detail, reference]);
/**
 * The verifier's LOGBOOK_DOUBLE_CHECKED signature on aggregate plant_equipment_repair, applied in their own session
 * first; the verifier is neither who signalled the failure nor who repaired it. Returns the REPAIRED event id.
 */
export const verifyRepair = (db: Db, repairId: string, signatureId: string): Promise<string> =>
  one(db, 'select plant.verify_repair($1, $2) as r', [repairId, signatureId]);

export const recordCalibration = (
  db: Db,
  equipmentCode: string,
  dueAt: string,
  asFound: 'PASS' | 'FAIL',
  asLeft: 'PASS' | 'FAIL',
  reference: string,
): Promise<string> => one(db, 'select plant.record_calibration($1, $2::timestamptz, $3, $4, $5) as r', [equipmentCode, dueAt, asFound, asLeft, reference]);

/** A per-use check names the batch (id) it is made for; a daily check names none. */
export const recordInstrumentCheck = (db: Db, equipmentCode: string, result: 'PASS' | 'FAIL', reference: string, batchId?: string): Promise<string> =>
  one(db, 'select plant.record_instrument_check($1, $2, $3, $4) as r', [equipmentCode, result, reference, batchId ?? null]);

/** The batch number and product are read from the batch record. */
export const recordInstrumentUse = (db: Db, equipmentCode: string, batchId: string, plannedEnd: string): Promise<string> =>
  one(db, 'select plant.record_instrument_use($1, $2, $3::timestamptz) as r', [equipmentCode, batchId, plannedEnd]);

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

/** The batch number and product are read from the batch record; the planned end bounds the calibration check. */
export const startEquipmentUse = (db: Db, equipmentCode: string, batchId: string, plannedEnd: string): Promise<string> =>
  one(db, 'select plant.start_equipment_use($1, $2, $3::timestamptz) as r', [equipmentCode, batchId, plannedEnd]);

export interface UseEnd {
  use_id: string;
  clean_hold_crossed: boolean;
  calibration_crossed: boolean;
  campaign_crossed: boolean;
  overran_plan: boolean;
}
export const endEquipmentUse = (db: Db, useId: string): Promise<UseEnd> => one(db, 'select plant.end_equipment_use($1) as r', [useId]);

/** The performer records the clearance and its finding; the next batch's number and product are read from the batch. */
export const recordClearance = (
  db: Db,
  areaCode: string,
  type: ClearanceType,
  next: { batchId: string; result: 'PASSED' | 'FAILED'; order?: string; artworkSet?: string },
): Promise<string> =>
  one(db, 'select plant.record_clearance($1, $2, $3, $4, $5, $6) as r', [
    areaCode,
    type,
    next.batchId,
    next.result,
    next.order ?? null,
    next.artworkSet ?? null,
  ]);
/** The verifier's signature VERIFIED on aggregate plant_clearance (covering the recorded finding), applied in their own session first. */
export const verifyClearance = async (db: Db, clearanceId: string, signatureId: string): Promise<void> => {
  await one(db, 'select plant.verify_clearance($1, $2) as r', [clearanceId, signatureId]);
};

export const startAreaOccupancy = (db: Db, areaCode: string, start: { batchId: string; stage: string; order?: string; artworkSet?: string }): Promise<string> =>
  one(db, 'select plant.start_area_occupancy($1, $2, $3, $4, $5) as r', [areaCode, start.batchId, start.stage, start.order ?? null, start.artworkSet ?? null]);
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

/**
 * The packaging lines' passed clearances for `batchId` not yet used by a start, which the kiosk offers a line start on.
 * It mirrors start_area_occupancy (recipe-core 1886) so the screen never offers a start the database refuses: a
 * verified clearance always; an unverified PASSED one only where the stage's G-10 names no checker
 * (`clearanceChecked` false: recipe.clearance_checked, 211.130(e), lead ruling A5) and the area's aggregate is on
 * area_status version 2 (1887; an older area keeps the verified rule until the owner decides).
 */
export const lineClearancesForBatch = (db: Db, batchId: string, clearanceChecked: boolean): Promise<pg.QueryResult<{ code: string; next_order: string; next_artwork_set: string }>> =>
  db.query(
    `select a.code, c.next_order, c.next_artwork_set from plant.clearance_status c join plant.area a on a.id = c.area_id
      where c.next_batch_id = $1 and c.recorded_result = 'PASSED' and c.next_order is not null
        and (c.verified_at is not null
             or (not $2::boolean and coalesce((select s.machine_version from platform.aggregate_state s where s.aggregate_type = 'plant_area' and s.aggregate_id = a.id), 1) >= 2))
        and not exists (select 1 from plant.area_occupancy o where o.clearance_id = c.id) order by c.performed_at`,
    [batchId, clearanceChecked],
  );
