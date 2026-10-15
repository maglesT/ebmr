/**
 * Namespace `equipmentData` (Phase 6 slice 6b-0; DI-32, DI-49; recipe-core 0960): native equipment and room data for
 * the trend viewer (interactive over the native samples, also for a restored archive), equipment events in the batch
 * context, and the original records of simple devices. Read-only: data arrive through the OPC UA and EMS adapters and
 * the gateway, never through these routes.
 *
 * Samples are as the source sent them: raw value text, the decimal shown (null when BAD or not a number), the status
 * code and the source timestamps (epoch microseconds as text). Builders add the equipment status board (PR-22) and the
 * line station display (PR-35) here, additively.
 */
import { z } from 'zod';
import { Instant, PersonRef, Uuid } from '../common.ts';
import { defineRoute } from '../route.ts';

const DecimalText = z.string().regex(/^-?(0|[1-9][0-9]*)(\.[0-9]+)?$/, 'decimal text');
const WholeText = z.string().regex(/^(0|[1-9][0-9]{0,17})$/, 'a whole number as text');
const PlantCode = z.string().regex(/^[A-Z0-9][A-Z0-9_-]{0,63}$/);
const TagName = z.string().regex(/^[a-z][a-z0-9_]*(\.[a-zA-Z0-9_]+)+$/).max(64);
export const SeriesSubjectKind = z.enum(['EQUIPMENT', 'AREA']);

export const NativeSampleView = z.strictObject({
  sourceTime: WholeText,
  serverTime: WholeText.nullable(),
  raw: z.string().min(1),
  value: DecimalText.nullable(),
  status: z.string().regex(/^0x[0-9A-F]{8}$/),
  quality: z.enum(['GOOD', 'UNCERTAIN', 'BAD']),
});
export type NativeSampleView = z.infer<typeof NativeSampleView>;

export const SeriesChunkView = z.strictObject({
  seriesId: Uuid,
  source: z.enum(['OPCUA', 'EMS']),
  subject: z.strictObject({ kind: SeriesSubjectKind, code: PlantCode }),
  tag: TagName,
  unit: z.string().min(1),
  chunkNo: WholeText,
  fromUs: WholeText,
  toUs: WholeText,
  /** SHA-256 of the chunk's canonical text, as the source sent it and the database recomputed it. */
  chunkHash: z.string().regex(/^[0-9a-f]{64}$/),
  samples: z.array(NativeSampleView),
  receivedAt: Instant,
});
export type SeriesChunkView = z.infer<typeof SeriesChunkView>;

export const SeriesTagView = z.strictObject({
  tag: TagName,
  subjectKind: SeriesSubjectKind,
  equipmentType: z.string().nullable(),
  unit: z.string().min(1),
  scale: WholeText,
});

export const EquipmentEventView = z.strictObject({
  eventId: Uuid,
  source: z.enum(['EBMR', 'OPCUA']),
  sourceEventId: z.string().min(1),
  equipmentCode: PlantCode,
  kind: z.enum(['STATE_CHANGED', 'RECIPE_LOADED', 'RECIPE_MISMATCH', 'PHASE_STARTED', 'PHASE_ENDED', 'OPERATOR_ACTION', 'FAULT']),
  state: z.enum(['IDLE', 'RUNNING', 'HELD', 'STOPPED', 'FAULTED', 'MAINTENANCE']).nullable(),
  recipeVersion: z.string().nullable(),
  message: z.string().min(1),
  occurredAtSource: Instant,
  batchId: Uuid.nullable(),
  step: z.string().nullable(),
  receivedAt: Instant,
});
export type EquipmentEventView = z.infer<typeof EquipmentEventView>;

export const DeviceOriginalView = z.strictObject({
  recordId: Uuid,
  equipmentCode: PlantCode,
  capture: z.enum(['TRANSMITTED', 'PRINTED_TICKET']),
  deviceRef: z.string().nullable(),
  rawOutput: z.string().nullable(),
  value: DecimalText,
  unit: z.string().min(1),
  deviceTime: Instant.nullable(),
  ticketSha256: z.string().nullable(),
  ticketRef: z.string().nullable(),
  step: z.string().min(1),
  entryRef: z.string().nullable(),
  recordedBy: PersonRef,
  recordedAt: Instant,
});
export type DeviceOriginalView = z.infer<typeof DeviceOriginalView>;

/** The most chunks one page returns. */
export const SERIES_PAGE_MAX = 200;

export const equipmentData = {
  tags: defineRoute({
    id: 'equipmentData.tags',
    method: 'GET',
    path: '/api/equipment-data/tags',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: false,
    summary: 'The tags a series may carry: every released process tag and the EMS room tags, with unit and fraction digits',
    response: z.strictObject({ tags: z.array(SeriesTagView) }),
  }),
  series: defineRoute({
    id: 'equipmentData.series',
    method: 'GET',
    path: '/api/equipment-data/series',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: false,
    summary: 'Native series chunks of one tag of a unit or room over [fromUs, toUs) of source time, oldest first, paged by chunk number',
    query: z.strictObject({
      subjectKind: SeriesSubjectKind,
      subjectCode: PlantCode,
      tag: TagName,
      fromUs: WholeText,
      toUs: WholeText,
      /** The last chunk number of the previous page. */
      after: WholeText.optional(),
      limit: z.string().regex(/^([1-9]|[1-9][0-9]|1[0-9][0-9]|200)$/).optional(),
    }),
    response: z.strictObject({ chunks: z.array(SeriesChunkView), nextAfter: WholeText.nullable() }),
  }),
  batchSeries: defineRoute({
    id: 'equipmentData.batchSeries',
    method: 'GET',
    path: '/api/equipment-data/batches/:batchId/series',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: false,
    summary: 'The native chunks of one tag taken while the batch (one step, when given) held its unit or occupied its room',
    params: z.strictObject({ batchId: Uuid }),
    query: z.strictObject({ tag: TagName, step: z.string().min(1).max(200).optional() }),
    response: z.strictObject({ chunks: z.array(SeriesChunkView) }),
  }),
  events: defineRoute({
    id: 'equipmentData.events',
    method: 'GET',
    path: '/api/equipment-data/events',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: false,
    summary: 'Equipment events in the batch context, newest first, by unit or batch',
    query: z.strictObject({ equipmentCode: PlantCode.optional(), batchId: Uuid.optional() }),
    response: z.strictObject({ events: z.array(EquipmentEventView) }),
  }),
  originals: defineRoute({
    id: 'equipmentData.originals',
    method: 'GET',
    path: '/api/equipment-data/batches/:batchId/originals',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: false,
    summary: 'The original records of simple devices of a batch: transmitted raw outputs and printed tickets with their entries (DI-32)',
    params: z.strictObject({ batchId: Uuid }),
    response: z.strictObject({ records: z.array(DeviceOriginalView) }),
  }),
};

// ---------------------------------------------------------------------------------------------
// Slice 6b builder B: the status displays read straight from the system state (recipe-core 0975). The equipment status
// board (PR-22) and the line station display (PR-35); registered as the namespace equipmentDisplays in routes.ts
// (D-P6b-B-9: its own namespace, so the equipment-data feature and the plant-rules feature each bind their own routes).

/** One PROCESS unit, room or line on the status board: its machine state as the database holds it now. */
export const StatusBoardEntry = z.strictObject({
  subjectKind: SeriesSubjectKind,
  code: PlantCode,
  name: z.string().min(1),
  /** PROCESS for a unit, ROOM or LINE for an area. */
  kind: z.string().min(1),
  classCode: z.string().nullable(),
  /** The state of its machine (equipment_cleanliness or area_status) and the state's version. */
  state: z.string().nullable(),
  stateVersion: WholeText.nullable(),
  stateSince: Instant.nullable(),
  batch: z.strictObject({ batchId: Uuid, batchRef: z.string().min(1), product: z.string().min(1) }).nullable(),
  /** Rooms and lines: CLEAN, OVERDUE, CLEANING_REQUIRED or NOT_CLEANED (PR-25, PR-27); null for a unit. */
  cleaningState: z.enum(['CLEAN', 'OVERDUE', 'CLEANING_REQUIRED', 'NOT_CLEANED']).nullable(),
  lastCleanedAt: Instant.nullable(),
  /** Alarms of the unit or room awaiting acknowledgment (DI-49). */
  openAlarms: z.number().int().min(0),
});
export type StatusBoardEntry = z.infer<typeof StatusBoardEntry>;

/** The line station display: what runs on the line now (PR-35); the batch fields are null while the line is idle. */
export const LineStationView = z.strictObject({
  code: PlantCode,
  name: z.string().min(1),
  kind: z.enum(['ROOM', 'LINE']),
  state: z.string().nullable(),
  stateVersion: WholeText.nullable(),
  batch: z.strictObject({
    batchId: Uuid,
    batchRef: z.string().min(1),
    product: z.string().min(1),
    productName: z.string().nullable(),
    stage: z.string().min(1),
    packagingOrder: z.string().nullable(),
    artworkSet: z.string().nullable(),
    since: Instant,
  }).nullable(),
  readAt: Instant,
});
export type LineStationView = z.infer<typeof LineStationView>;

export const equipmentDisplays = {
  statusBoard: defineRoute({
    id: 'equipmentDisplays.statusBoard',
    method: 'GET',
    path: '/api/equipment-data/status-board',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: false,
    summary: 'The equipment status board: every PROCESS unit, room and line with its state, batch, cleaning state and open alarms, as the database holds them now (PR-22)',
    response: z.strictObject({ entries: z.array(StatusBoardEntry), readAt: Instant }),
  }),
  lineStation: defineRoute({
    id: 'equipmentDisplays.lineStation',
    method: 'GET',
    path: '/api/equipment-data/line-station/:code',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: false,
    summary: 'The station display of a line (or room): the product and batch running on it now (PR-35)',
    params: z.strictObject({ code: PlantCode }),
    response: LineStationView,
  }),
};
