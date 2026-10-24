/**
 * The plant acts a person performs on the floor for a GMP batch (Phase 7 slice 7h, WP-A; demo gap report A2 to A9;
 * decision 0025: every act has a screen), joined to namespace `plant`:
 *  - the start and end of a room's or line's use by a batch (plant.start_area_occupancy, end_area_occupancy: a passed,
 *    verified clearance first; IN-21, PR-34, INV-15);
 *  - the per-use check and the booking of a balance or instrument (plant.record_instrument_check, record_instrument_use:
 *    calibrated, its check passed; PR-23, IN-25);
 *  - the start and end of a process unit's use (plant.start_equipment_use, end_equipment_use: fitness, cleanliness,
 *    calibration and campaign guards; INV-12, IN-25, PR-23);
 *  - the charge of a container into a unit by its scanned label (plant.charge_container: IN-26 (c), L-30);
 *  - the inspection, issue and return of press tooling (tab.inspect_tooling, issue_tooling, return_tooling: INV-24,
 *    IN-36 (b), DI-31);
 *  - the discharge configuration of a press (plant.configure_press_discharge, master data) and a calibration
 *    (plant.record_calibration, logbook).
 * The step screen reads what it offers from `batches.stepPlant` (the step's rooms and units, the batch's open uses,
 * its tooling and its containers), so an operator never types an identifier. Every write is the person's own command
 * (a fresh badge tap on a shared terminal, INV-40) and every rule is the database's.
 */
import { z } from 'zod';
import { DecimalString, Instant, IntegerString, PersonRef, Uuid, withAttribution } from '../common.ts';
import { defineRoute } from '../route.ts';

export const Code = z.string().regex(/^[A-Z0-9][A-Z0-9_-]{0,63}$/);
/** A calendar date YYYY-MM-DD (a real day: an impossible one is refused here, before the database). */
const SiteDate = z.iso.date();
/** Hours from now (database time) a use is planned to end: 1 to 72. */
export const PlannedHours = z.string().regex(/^([1-9]|[1-6][0-9]|7[0-2])$/, 'whole hours from 1 to 72');

/**
 * R3.3 (hosted-demo trials; D-7k-2): the plant act a status or clearance step stands on, done and recorded in the step as
 * one act of the person (one badge tap on a kiosk): the start of the batch's use of a room or line of the step's stage
 * (on its verified clearance; a line names the order and artwork set it was cleared for), or the booking of a unit the
 * step checks (an instrument booked, a process unit's use started) for the hours given.
 */
export const PlantEntryAct = z.discriminatedUnion('act', [
  z.strictObject({ act: z.literal('START_AREA_OCCUPANCY'), areaCode: Code, order: z.string().trim().min(1).max(64).optional(), artworkSet: z.string().trim().min(1).max(64).optional() }),
  z.strictObject({ act: z.literal('BOOK_UNIT'), equipmentRef: z.string().trim().min(1).max(64), code: Code, plannedHours: PlannedHours }),
]);
export type PlantEntryAct = z.infer<typeof PlantEntryAct>;
const Reference = z.string().trim().min(1).max(200);
const Counts = z.strictObject({ upper: z.string().regex(/^[0-9]{1,4}$/), lower: z.string().regex(/^[0-9]{1,4}$/), dies: z.string().regex(/^[0-9]{1,4}$/) });

export const OccupancyView = z.strictObject({
  occupancyId: Uuid,
  areaCode: z.string(),
  batchNumber: z.string(),
  stage: z.string(),
  startedBy: PersonRef,
  startedAt: Instant,
  /** Ended, by whom and when; null while the batch uses the area. */
  ended: z.strictObject({ by: PersonRef, at: Instant }).nullable(),
});
export type OccupancyView = z.infer<typeof OccupancyView>;

export const PlantUseView = z.strictObject({
  useId: Uuid,
  /** PROCESS: an equipment use (ended by a person); INSTRUMENT: an instrument booking (open until its planned end). */
  kind: z.enum(['PROCESS', 'INSTRUMENT']),
  equipmentCode: z.string(),
  batchNumber: z.string(),
  startedBy: PersonRef,
  startedAt: Instant,
  plannedEnd: Instant,
  ended: z.strictObject({ by: PersonRef, at: Instant }).nullable(),
});
export type PlantUseView = z.infer<typeof PlantUseView>;

export const InstrumentCheckView = z.strictObject({ checkId: Uuid, equipmentCode: z.string(), result: z.enum(['PASS', 'FAIL']), regime: z.enum(['PER_USE', 'DAILY']), recordedAt: Instant });
export type InstrumentCheckView = z.infer<typeof InstrumentCheckView>;

export const ChargeView = z.strictObject({ chargeId: Uuid, containerId: Uuid, label: z.string(), netQuantity: DecimalString.nullable(), unit: z.string() });
export type ChargeView = z.infer<typeof ChargeView>;

export const ToolingInspectionView = z.strictObject({ inspectionId: Uuid, set: z.string(), kind: z.enum(['PRE_USE', 'POST_USE']), result: z.enum(['PASS', 'FAIL']), held: z.array(z.string()) });
export type ToolingInspectionView = z.infer<typeof ToolingInspectionView>;

export const ToolingIssueResultView = z.strictObject({ issueId: Uuid, set: z.string(), press: z.string(), preUseInspectionId: Uuid });
export type ToolingIssueResultView = z.infer<typeof ToolingIssueResultView>;

export const ToolingReturnView = z.strictObject({
  issueId: Uuid,
  strokes: IntegerString,
  strokeSource: z.enum(['PRESS_COUNTER', 'MANUAL']),
  cumulative: IntegerString,
  countMismatch: z.boolean(),
  limitExceeded: z.boolean(),
  held: z.array(z.string()),
});
export type ToolingReturnView = z.infer<typeof ToolingReturnView>;

export const PressDischargeView = z.strictObject({ press: z.string(), separateStreams: z.boolean(), version: z.number().int().positive() });
export type PressDischargeView = z.infer<typeof PressDischargeView>;

export const CalibrationView = z.strictObject({ calibrationId: Uuid, equipmentCode: z.string(), dueAt: Instant, asFound: z.enum(['PASS', 'FAIL']), asLeft: z.enum(['PASS', 'FAIL']), reference: z.string() });
export type CalibrationView = z.infer<typeof CalibrationView>;

/** The plant facts a step screen offers its acts from (batches.stepPlant). */
export const StepPlantView = z.strictObject({
  batchId: Uuid,
  stepKey: z.string(),
  batchNumber: z.string(),
  /** The step's block version (e.g. `G-10@2`), or null. */
  block: z.string().nullable(),
  /** The MBR stage of the step (an occupancy names it), or null. */
  stage: z.string().nullable(),
  /** The rooms and line the stage is bound to, rooms first. */
  areas: z.array(z.strictObject({ code: z.string(), kind: z.enum(['ROOM', 'LINE']), state: z.string() })),
  /** A packaging line's verified clearance for an order of this batch (the occupancy names its order and artwork set). */
  lineClearances: z.array(z.strictObject({ areaCode: z.string(), order: z.string(), artworkSet: z.string() })),
  /** The batch's occupancies still open. */
  occupancies: z.array(OccupancyView.extend({ mine: z.boolean() })),
  /** The units the step checks (STATUS_CHECK equipment of the phase), each with the plant units of its class. */
  equipment: z.array(
    z.strictObject({
      ref: z.string(),
      kind: z.enum(['PROCESS', 'INSTRUMENT', 'UTILITY']),
      classCode: z.string(),
      units: z.array(z.strictObject({ code: z.string(), name: z.string(), areaCode: z.string().nullable(), fitness: z.string().nullable(), lastCheck: z.strictObject({ result: z.enum(['PASS', 'FAIL']), at: Instant, mine: z.boolean() }).nullable() })),
    }),
  ),
  /** The batch's uses still open (equipment uses not ended, instrument bookings before their planned end). */
  uses: z.array(PlantUseView.extend({ mine: z.boolean() })),
  tooling: z.strictObject({
    /** The items every tooling inspection records (tab.tooling_checklist_items). */
    checklist: z.array(z.string()),
    sets: z.array(z.strictObject({ code: z.string(), upper: z.number().int(), lower: z.number().int(), dies: z.number().int(), issuedNow: z.boolean() })),
    issues: z.array(
      z.strictObject({
        issueId: Uuid,
        set: z.string(),
        press: z.string(),
        counts: z.strictObject({ upper: z.number().int(), lower: z.number().int(), dies: z.number().int() }),
        preUse: z.strictObject({ inspectionId: Uuid, result: z.enum(['PASS', 'FAIL']) }),
        returned: z.strictObject({ strokes: IntegerString, strokeSource: z.enum(['PRESS_COUNTER', 'MANUAL']), countMismatch: z.boolean(), limitExceeded: z.boolean() }).nullable(),
        postUse: z.strictObject({ inspectionId: Uuid, result: z.enum(['PASS', 'FAIL']) }).nullable(),
      }),
    ),
    /** The last pre-use inspection of each set of the product since its last issue (an issue takes it). */
    preUse: z.array(z.strictObject({ inspectionId: Uuid, set: z.string(), result: z.enum(['PASS', 'FAIL']), at: Instant })),
  }),
  /** The batch's closed containers not charged, merged or packed, and the charges its people made. */
  containers: z.array(z.strictObject({ containerId: Uuid, label: z.string(), stage: z.string(), netQuantity: DecimalString.nullable(), unit: z.string(), problem: z.string().nullable() })),
  charges: z.array(z.strictObject({ chargeId: Uuid, label: z.string(), stage: z.string(), chargedBy: PersonRef, chargedAt: Instant, mine: z.boolean() })),
  /**
   * Phase 7 slice 7m (R1): the layers of a bilayer compression step (TB-16@1), each with its hopper and the stage of the
   * blend containers that feed it; empty for any other step. A charge into a layer's hopper names the container's stage.
   */
  layers: z.array(z.strictObject({ id: z.string(), hopper: z.string(), stage: z.string() })),
  /** The stage of each charged container (charges[].stage is the plant stage it went into), by charge id. */
  chargedStages: z.record(z.string(), z.string()),
});
export type StepPlantView = z.infer<typeof StepPlantView>;

const post = <P extends z.ZodRawShape, B extends z.ZodRawShape, R extends z.ZodType>(id: string, path: string, summary: string, params: P, body: B, response: R) =>
  defineRoute({ id, method: 'POST', path, installation: 'ANY', auth: 'SESSION', mutating: true, attribution: 'FRESH_ON_SHARED', summary, params: z.strictObject(params), body: withAttribution(body), response });

export const plantFloor = {
  startAreaOccupancy: post(
    'plant.startAreaOccupancy',
    '/api/plant/occupancies',
    'Start the use of a room or line by a batch for a stage, on its passed and verified clearance (STEP.EXECUTE; IN-21, PR-34, INV-15); a line names the order and artwork set it was cleared for',
    {},
    { areaCode: Code, batchId: Uuid, stage: z.string().trim().min(1).max(64), order: z.string().trim().min(1).max(64).optional(), artworkSet: z.string().trim().min(1).max(64).optional() },
    OccupancyView,
  ),
  endAreaOccupancy: post('plant.endAreaOccupancy', '/api/plant/occupancies/:occupancyId/end', 'End the use of a room or line by a batch (STEP.EXECUTE); the area is released when no use remains', { occupancyId: Uuid }, {}, OccupancyView),
  recordInstrumentCheck: post(
    'plant.recordInstrumentCheck',
    '/api/plant/instruments/:code/checks',
    'Record the per-use or daily check of a balance or instrument with its result and reference (STEP.EXECUTE; PR-23, IN-25)',
    { code: Code },
    { result: z.enum(['PASS', 'FAIL']), reference: Reference, batchId: Uuid.optional() },
    InstrumentCheckView,
  ),
  recordInstrumentUse: post(
    'plant.recordInstrumentUse',
    '/api/plant/instruments/:code/uses',
    'Book a balance or instrument for a batch until a planned end (database time plus the hours given); calibrated and its check passed (STEP.EXECUTE; PR-23, IN-25)',
    { code: Code },
    { batchId: Uuid, plannedHours: PlannedHours },
    PlantUseView,
  ),
  startEquipmentUse: post(
    'plant.startEquipmentUse',
    '/api/plant/equipment/:code/uses',
    'Start the use of a process unit by a batch until a planned end (database time plus the hours given) after its status guards pass (STEP.EXECUTE; INV-12, IN-25, PR-23)',
    { code: Code },
    { batchId: Uuid, plannedHours: PlannedHours },
    PlantUseView,
  ),
  endEquipmentUse: post('plant.endEquipmentUse', '/api/plant/equipment-uses/:useId/end', 'End the use of a process unit: it becomes dirty and its dirty-hold clock starts (STEP.EXECUTE)', { useId: Uuid }, {}, PlantUseView),
  chargeContainer: post(
    'plant.chargeContainer',
    '/api/plant/charges',
    'Charge a closed container into the unit of a stage by its scanned label (STEP.EXECUTE; IN-26 (c), L-30): a container of another batch or one not usable is refused',
    {},
    { batchId: Uuid, stage: z.string().regex(/^[A-Z][A-Z0-9_]{0,39}$/), label: z.string().trim().min(1).max(64) },
    ChargeView,
  ),
  inspectTooling: post(
    'plant.inspectTooling',
    '/api/plant/tooling/:set/inspections',
    'Inspect a tooling set before use, or after its return, item by item of the checklist; a failed one states the disposition and, after use, holds the press output (STEP.EXECUTE; IN-36 (b))',
    { set: Code },
    { kind: z.enum(['PRE_USE', 'POST_USE']), issueId: Uuid.optional(), findings: z.record(z.string().regex(/^[A-Z][A-Z_]{0,31}$/), z.boolean()), disposition: z.enum(['REPAIR', 'POLISH', 'RETIRE']).optional() },
    ToolingInspectionView,
  ),
  issueTooling: post(
    'plant.issueTooling',
    '/api/plant/tooling/:set/issues',
    'Issue an inspected tooling set to a press for a batch with the punches and dies counted out (STEP.EXECUTE; INV-24, IN-36 (b), PR-27)',
    { set: Code },
    { batchId: Uuid, press: Code, counts: Counts },
    ToolingIssueResultView,
  ),
  returnTooling: post(
    'plant.returnTooling',
    '/api/plant/tooling-issues/:issueId/return',
    'Return issued tooling with the punches and dies counted back; the strokes come from the press counter, or are keyed from the press when it did not see the whole use (STEP.EXECUTE; DI-31)',
    { issueId: Uuid },
    { counts: Counts, manualStrokes: z.string().regex(/^[0-9]{1,18}$/).optional() },
    ToolingReturnView,
  ),
  configurePressDischarge: post(
    'plant.configurePressDischarge',
    '/api/plant/equipment/:code/press-discharge',
    'Configure whether each side of a press discharges into its own containers (MASTERDATA.CHANGE; PR-22)',
    { code: Code },
    { separateStreams: z.boolean() },
    PressDischargeView,
  ),
  recordCalibration: post(
    'plant.recordCalibration',
    '/api/plant/equipment/:code/calibrations',
    'Record a calibration of a unit whose class requires one: as found, as left, the certificate reference and the date the next is due (LOGBOOK.ENTRY)',
    { code: Code },
    { dueDate: SiteDate, asFound: z.enum(['PASS', 'FAIL']), asLeft: z.enum(['PASS', 'FAIL']), reference: Reference },
    CalibrationView,
  ),
} as const;
