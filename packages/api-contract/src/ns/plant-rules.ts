/**
 * Namespace `plantRules` (Phase 6 slice 6b, builder B; GMP): the plant rules behind the clauses Phase 4 deferred to
 * Phase 6 (recipe-core 0973 to 0975, kernel 1190, site services 0940). Rooms and lines with their clean-hold time and
 * cleaning state (PR-25), spills (PR-27), the room's conditions from the EMS (DI-32, DI-49), line adjacency and
 * segregation (PR-35), the penicillin facility rule and beta-lactam classification (PR-27), controlled areas and area
 * authorisations (PR-15), reagent and buffer lots and their use at an in-process control (PR-29). Every rule is the
 * database's; a refusal carries its EBMR-PLANT-*, EBMR-SITE-95x or EBMR-IAM-20x code.
 */
import { z } from 'zod';
import { Instant, PersonRef, Uuid, withAttribution } from '../common.ts';
import { defineRoute } from '../route.ts';
import { NativeSampleView } from './equipment-data.ts';

const PlantCode = z.string().regex(/^[A-Z0-9][A-Z0-9_-]{0,63}$/);
const LotCode = z.string().regex(/^[A-Z0-9][A-Z0-9/._-]{0,39}$/);
const WholeText = z.string().regex(/^(0|[1-9][0-9]{0,17})$/, 'a whole number as text');
const Text = (max: number) => z.string().trim().min(1).max(max);

export const RoomCleaningState = z.enum(['CLEAN', 'OVERDUE', 'CLEANING_REQUIRED', 'NOT_CLEANED']);

/** A room or line with its rules and cleaning state (PR-15, PR-25, PR-27). */
export const RoomStateView = z.strictObject({
  code: PlantCode,
  name: z.string().min(1),
  kind: z.enum(['ROOM', 'LINE']),
  cleaningState: RoomCleaningState,
  lastCleanedAt: Instant.nullable(),
  /** The clean-hold time in seconds (null: none); a room whose verified cleaning is older is overdue (PR-25). */
  cleanHoldSeconds: WholeText.nullable(),
  /** A controlled area: work in it needs the person's area authorisation (PR-15). */
  authorisationRequired: z.boolean(),
  ruleVersion: WholeText.nullable(),
  /** Spills recorded since the last verified cleaning (PR-27). */
  openSpills: z.number().int().min(0),
});
export type RoomStateView = z.infer<typeof RoomStateView>;

/** A room's latest EMS sample per room tag, its open alarms and its cleaning state. */
export const RoomConditionsView = z.strictObject({
  code: PlantCode,
  name: z.string().min(1),
  cleaningState: RoomCleaningState.nullable(),
  tags: z.array(z.strictObject({ tag: z.string().min(1), unit: z.string().min(1), sample: NativeSampleView.nullable(), receivedAt: Instant.nullable() })),
  openAlarms: z.array(z.strictObject({ alarmId: Uuid, source: z.enum(['EBMR', 'OPCUA', 'EMS']), alarmCode: z.string().min(1), message: z.string().min(1), gmpCritical: z.boolean(), raisedAtSource: Instant })),
  readAt: Instant,
});
export type RoomConditionsView = z.infer<typeof RoomConditionsView>;

export const AdjacencyView = z.strictObject({
  one: PlantCode,
  two: PlantCode,
  version: WholeText,
  adjacent: z.boolean(),
  segregated: z.boolean(),
  justification: z.string().nullable(),
  recordedAt: Instant,
});
export type AdjacencyView = z.infer<typeof AdjacencyView>;

export const ReagentLotView = z.strictObject({
  lotCode: LotCode,
  kind: z.enum(['REAGENT', 'BUFFER', 'VOLUMETRIC_SOLUTION', 'STANDARD']),
  reagentCode: LotCode,
  name: z.string().min(1),
  nominal: z.string().nullable(),
  preparedAt: Instant,
  expiresAt: Instant,
  /** IN_DATE, EXPIRED or WITHDRAWN at the read (PR-29). */
  state: z.enum(['IN_DATE', 'EXPIRED', 'WITHDRAWN']),
  withdrawalReason: z.string().nullable(),
});
export type ReagentLotView = z.infer<typeof ReagentLotView>;

/** One person's area authorisation record (a qualification AREA.<code> of the register; kernel 0130, 1190). */
export const AreaAuthorisationRecordView = z.strictObject({
  recordId: Uuid,
  person: PersonRef,
  validFrom: Instant,
  validTo: Instant.nullable(),
  /** INTERNAL (recorded here) or the mirror that fed it (the LMS). */
  source: z.string().min(1),
  recordedBy: PersonRef,
  recordedAt: Instant,
  withdrawnAt: Instant.nullable(),
  withdrawalReason: z.string().nullable(),
  /** The record counts now (iam.person_area_authorised: recorded, valid, not withdrawn, from a fresh source). */
  current: z.boolean(),
});
export type AreaAuthorisationRecordView = z.infer<typeof AreaAuthorisationRecordView>;

/** The area authorisations of the qualification matrix: each room or line that is controlled or has a type (PR-15). */
export const AreaAuthorisationMatrixView = z.strictObject({
  areas: z.array(
    z.strictObject({
      code: PlantCode,
      name: z.string().min(1),
      kind: z.enum(['ROOM', 'LINE']),
      authorisationRequired: z.boolean(),
      qualificationCode: z.string().min(1),
      /** The qualification type AREA.<code> exists (createAreaAuthorisation); records need it. */
      typeDefined: z.boolean(),
      records: z.array(AreaAuthorisationRecordView),
    }),
  ),
  readAt: Instant,
});
export type AreaAuthorisationMatrixView = z.infer<typeof AreaAuthorisationMatrixView>;

const roomParams = z.strictObject({ code: PlantCode });
const VersionResponse = z.strictObject({ version: WholeText });

export const plantRules = {
  rooms: defineRoute({
    id: 'plantRules.rooms',
    method: 'GET',
    path: '/api/plant-rules/rooms',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: false,
    summary: 'Rooms and lines with their clean-hold time, controlled-area flag and cleaning state (PR-15, PR-25, PR-27)',
    response: z.strictObject({ rooms: z.array(RoomStateView) }),
  }),
  roomConditions: defineRoute({
    id: 'plantRules.roomConditions',
    method: 'GET',
    path: '/api/plant-rules/rooms/:code/conditions',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: false,
    summary: "A room's temperature and humidity as the EMS sent them last, its open alarms and its cleaning state (DI-32, DI-49)",
    params: roomParams,
    response: RoomConditionsView,
  }),
  recordSpill: defineRoute({
    id: 'plantRules.recordSpill',
    method: 'POST',
    path: '/api/plant-rules/rooms/:code/spills',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: true,
    attribution: 'FRESH_ON_SHARED',
    summary: 'Record a spill: the room is CLEANING_REQUIRED until a verified cleaning (PR-27; STEP.EXECUTE in the batch scope, or LOGBOOK.ENTRY)',
    params: roomParams,
    body: withAttribution({ description: Text(1000), material: Text(200).optional(), batchId: Uuid.optional() }),
    response: RoomStateView,
  }),
  setRoomRule: defineRoute({
    id: 'plantRules.setRoomRule',
    method: 'POST',
    path: '/api/plant-rules/rooms/:code/rule',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: true,
    attribution: 'FRESH_ON_SHARED',
    summary: "A new version of a room's rules: controlled area (PR-15) and clean-hold time (PR-25) (MASTERDATA.CHANGE)",
    params: roomParams,
    body: withAttribution({ authorisationRequired: z.boolean(), cleanHoldSeconds: WholeText.nullable(), reason: Text(500) }),
    response: RoomStateView,
  }),
  adjacencies: defineRoute({
    id: 'plantRules.adjacencies',
    method: 'GET',
    path: '/api/plant-rules/adjacencies',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: false,
    summary: 'The current adjacency and segregation of each pair of rooms or lines (PR-35)',
    response: z.strictObject({ adjacencies: z.array(AdjacencyView) }),
  }),
  defineAdjacency: defineRoute({
    id: 'plantRules.defineAdjacency',
    method: 'POST',
    path: '/api/plant-rules/adjacencies',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: true,
    attribution: 'FRESH_ON_SHARED',
    summary: 'Two rooms or lines are adjacent (or no longer), segregated with a justification or not (PR-35; MASTERDATA.CHANGE)',
    body: withAttribution({ one: PlantCode, two: PlantCode, adjacent: z.boolean(), segregated: z.boolean(), justification: Text(500).optional() }),
    response: VersionResponse,
  }),
  setFacilityRule: defineRoute({
    id: 'plantRules.setFacilityRule',
    method: 'POST',
    path: '/api/plant-rules/facilities/:site',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: true,
    attribution: 'FRESH_ON_SHARED',
    summary: 'Whether a site is a penicillin facility (PR-27; MASTERDATA.CHANGE); a site without a rule is not one',
    params: z.strictObject({ site: z.string().regex(/^[A-Z0-9][A-Z0-9-]{0,15}$/) }),
    body: withAttribution({ penicillinFacility: z.boolean(), justification: Text(500) }),
    response: VersionResponse,
  }),
  classifyBetaLactam: defineRoute({
    id: 'plantRules.classifyBetaLactam',
    method: 'POST',
    path: '/api/plant-rules/beta-lactam',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: true,
    attribution: 'FRESH_ON_SHARED',
    summary: 'Classify a material or product as beta-lactam (penicillin) or not (PR-27; MASTERDATA.CHANGE)',
    body: withAttribution({ kind: z.enum(['MATERIAL', 'PRODUCT']), code: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9/._-]{0,63}$/), betaLactam: z.boolean(), reason: Text(500) }),
    response: VersionResponse,
  }),
  createAreaAuthorisation: defineRoute({
    id: 'plantRules.createAreaAuthorisation',
    method: 'POST',
    path: '/api/plant-rules/area-authorisations',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: true,
    attribution: 'FRESH_ON_SHARED',
    summary: "The qualification type AREA.<code> a person's area authorisation is recorded under (PR-15; TRAINING.MANAGE)",
    body: withAttribution({ area: PlantCode, name: Text(200) }),
    response: z.strictObject({ qualificationCode: z.string().min(1) }),
  }),
  areaAuthorisations: defineRoute({
    id: 'plantRules.areaAuthorisations',
    method: 'GET',
    path: '/api/plant-rules/area-authorisations',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: false,
    summary: 'The area authorisations of the qualification matrix: controlled rooms and lines with each person\'s record (PR-15)',
    response: AreaAuthorisationMatrixView,
  }),
  recordAreaAuthorisation: defineRoute({
    id: 'plantRules.recordAreaAuthorisation',
    method: 'POST',
    path: '/api/plant-rules/area-authorisations/:code/records',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: true,
    attribution: 'FRESH_ON_SHARED',
    summary: "Record a person's authorisation for a controlled area, valid from now (PR-15; QUALIFICATION.RECORD, never for oneself)",
    params: roomParams,
    body: withAttribution({ loginName: z.string().trim().min(1).max(100), validTo: z.iso.datetime({ offset: true }).optional() }),
    response: AreaAuthorisationRecordView,
  }),
  withdrawAreaAuthorisation: defineRoute({
    id: 'plantRules.withdrawAreaAuthorisation',
    method: 'POST',
    path: '/api/plant-rules/area-authorisation-records/:recordId/withdraw',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: true,
    attribution: 'FRESH_ON_SHARED',
    summary: "Withdraw a person's area authorisation with the reason (PR-15; QUALIFICATION.RECORD)",
    params: z.strictObject({ recordId: Uuid }),
    body: withAttribution({ reason: Text(500) }),
    response: AreaAuthorisationRecordView,
  }),
  reagentLots: defineRoute({
    id: 'plantRules.reagentLots',
    method: 'GET',
    path: '/api/plant-rules/reagent-lots',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: false,
    summary: 'Reagent, buffer, volumetric solution and standard lots with their expiry and state now (PR-29)',
    response: z.strictObject({ lots: z.array(ReagentLotView) }),
  }),
  recordReagentLot: defineRoute({
    id: 'plantRules.recordReagentLot',
    method: 'POST',
    path: '/api/plant-rules/reagent-lots',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: true,
    attribution: 'FRESH_ON_SHARED',
    summary: 'Record a reagent or buffer lot with its expiry (PR-29; QC.RESULT_RECORD)',
    body: withAttribution({
      lotCode: LotCode, kind: z.enum(['REAGENT', 'BUFFER', 'VOLUMETRIC_SOLUTION', 'STANDARD']), reagentCode: LotCode, name: Text(200), nominal: Text(64).optional(),
      preparedAt: z.iso.datetime({ offset: true }), expiresAt: z.iso.datetime({ offset: true }),
    }),
    response: ReagentLotView,
  }),
  withdrawReagentLot: defineRoute({
    id: 'plantRules.withdrawReagentLot',
    method: 'POST',
    path: '/api/plant-rules/reagent-lots/:lotCode/withdraw',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: true,
    attribution: 'FRESH_ON_SHARED',
    summary: 'Withdraw (discard) a reagent or buffer lot before its expiry, with the reason (PR-29; QC.RESULT_RECORD)',
    params: z.strictObject({ lotCode: LotCode }),
    body: withAttribution({ reason: Text(500) }),
    response: ReagentLotView,
  }),
  recordReagentUse: defineRoute({
    id: 'plantRules.recordReagentUse',
    method: 'POST',
    path: '/api/plant-rules/reagent-uses',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: true,
    attribution: 'FRESH_ON_SHARED',
    summary: 'The reagent or buffer lot an in-process control of a step used; an expired, withdrawn or unknown lot is refused (PR-29; STEP.EXECUTE)',
    body: withAttribution({ batchId: Uuid, step: Text(200), lotCode: LotCode, purpose: Text(200) }),
    response: z.strictObject({ useId: Uuid }),
  }),
};
