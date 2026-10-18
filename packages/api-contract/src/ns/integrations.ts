/**
 * Namespace `integrations` (Phase 6 slice 6a-0; DI-31, DI-20; kernel 1180): the health of each integration adapter,
 * its last messages and refusals, its reconciliation reports, the freshness of each mirrored data class, and the
 * integration alarms with the one act on this page: a person acknowledges an alarm with a note.
 *
 * Read-only otherwise. Adapters themselves never use this namespace: they hand data over through the database
 * (platform.accept_inbound under their integration identity), never through the screens' API.
 *
 * The enums repeat those of @ebmr/integration-sdk/adapter (the contract package may not import it: browser-safe rule);
 * apps/tablets-server/test/integrations checks they stay equal. Counts and ages travel as whole-number text.
 *
 * Signed act: none. `acknowledgeAlarm` is an ACKNOWLEDGE act (ALARM.ACKNOWLEDGE): attributed, with a fresh badge tap
 * on a shared terminal, never by an integration identity (DI-14).
 */
import { z } from 'zod';
import { Instant, PersonRef, Uuid, withAttribution } from '../common.ts';
import { defineRoute } from '../route.ts';

export const IntegrationSourceSystem = z.enum(['ERP_WMS', 'QMS', 'LIMS', 'LMS', 'CMMS', 'EMS', 'OPCUA', 'L3']);
export type IntegrationSourceSystem = z.infer<typeof IntegrationSourceSystem>;
export const MirrorDataClassName = z.enum(['LMS_QUALIFICATION', 'CMMS_CALIBRATION', 'CMMS_MAINTENANCE', 'QMS_STATUS', 'ERP_LOT_STATUS', 'ERP_ITEM_MASTER', 'WMS_STOCK', 'L3_SERIAL_STATUS']);
export const IntegrationAlarmKind = z.enum(['SEQUENCE_GAP', 'OUT_OF_ORDER', 'MALFORMED', 'DUPLICATE', 'WRONG_IDENTITY', 'OUT_OF_RANGE', 'STALE', 'PARTIAL', 'TRANSPORT', 'RECONCILIATION_MISMATCH', 'SERIES_GAP']);
export const InboundErrorClass = z.enum(['MALFORMED', 'DUPLICATE', 'OUT_OF_ORDER', 'WRONG_IDENTITY', 'OUT_OF_RANGE', 'STALE', 'PARTIAL', 'TRANSPORT']);

const WholeText = z.string().regex(/^(0|[1-9][0-9]{0,17})$/, 'a whole number as text');
const AdapterCode = z.string().regex(/^[A-Z][A-Z0-9_-]{1,63}$/);

/** platform.mirror_freshness of one data class (STAND_IN: no bound, never stale). */
export const MirrorFreshnessView = z.strictObject({
  dataClass: MirrorDataClassName,
  sourceSystem: IntegrationSourceSystem,
  mode: z.enum(['STAND_IN', 'MIRROR']),
  blocking: z.boolean(),
  asOf: Instant.nullable(),
  ageSeconds: WholeText.nullable(),
  boundSeconds: WholeText.nullable(),
  stale: z.boolean(),
});
export type MirrorFreshnessView = z.infer<typeof MirrorFreshnessView>;

export const InboundMessageView = z.strictObject({
  messageId: Uuid,
  messageType: z.string().min(1),
  sourceRecordId: z.string().min(1),
  sourceTimestamp: Instant,
  sequenceNo: WholeText,
  sequenceStatus: z.enum(['FIRST', 'IN_ORDER', 'GAP', 'LATE']),
  receivedAt: Instant,
});
export type InboundMessageView = z.infer<typeof InboundMessageView>;

export const InboundRefusalView = z.strictObject({
  refusalId: Uuid,
  errorClass: InboundErrorClass,
  idempotencyKey: z.string().nullable(),
  sequenceNo: WholeText.nullable(),
  detail: z.string().min(1),
  alarmId: Uuid,
  recordedAt: Instant,
});
export type InboundRefusalView = z.infer<typeof InboundRefusalView>;

export const ReconciliationReportView = z.strictObject({
  reportId: Uuid,
  adapterCode: AdapterCode,
  periodFrom: Instant,
  periodTo: Instant,
  sourceCount: WholeText,
  receivedCount: WholeText,
  acceptedCount: WholeText,
  refusedCount: WholeText,
  matched: z.boolean(),
  alarmId: Uuid.nullable(),
  recordedAt: Instant,
});
export type ReconciliationReportView = z.infer<typeof ReconciliationReportView>;

export const IntegrationAlarmView = z.strictObject({
  alarmId: Uuid,
  adapterCode: AdapterCode,
  sourceSystem: IntegrationSourceSystem,
  kind: IntegrationAlarmKind,
  severity: z.enum(['MINOR', 'MAJOR', 'CRITICAL']),
  messageId: Uuid.nullable(),
  /** What the database recorded with the alarm (missing sequence numbers, the refusal text), as text. */
  summary: z.string().min(1),
  raisedAt: Instant,
  acknowledgement: z.strictObject({ by: PersonRef, at: Instant, note: z.string().min(1) }).nullable(),
});
export type IntegrationAlarmView = z.infer<typeof IntegrationAlarmView>;

/** One adapter on the health page: identity, last message, data age, open alarms, last reconciliation. */
/** The adapter's worker as this server process runs it (slice 6a: started with the server in MIRROR mode). */
export const AdapterWorkerView = z.strictObject({
  /** IDLE between cycles; RUNNING in one; RETRYING after a TRANSPORT failure (back-off); BLOCKED on an unclassified one. */
  state: z.enum(['IDLE', 'RUNNING', 'RETRYING', 'BLOCKED']),
  /** The highest sequence number handled. */
  cursor: WholeText,
  /** The source's head as it last reported it (as received, at most 64 characters). */
  head: z.string().max(64).nullable(),
  cycles: WholeText,
  /** Failed cycles in a row. */
  attempts: WholeText,
  lastError: z.string().max(500).nullable(),
  accepted: WholeText,
  duplicates: WholeText,
  refused: WholeText,
});
export type AdapterWorkerView = z.infer<typeof AdapterWorkerView>;

export const AdapterHealthView = z.strictObject({
  adapterCode: AdapterCode,
  sourceSystem: IntegrationSourceSystem,
  status: z.enum(['ACTIVE', 'BLOCKED', 'DECOMMISSIONED']),
  description: z.string().min(1),
  lastMessage: InboundMessageView.nullable(),
  /** Whole seconds since the last accepted message; null before the first. */
  dataAgeSeconds: WholeText.nullable(),
  openAlarms: WholeText,
  lastReconciliation: ReconciliationReportView.nullable(),
  /** The data classes this system mirrors, with their freshness. */
  mirrors: z.array(MirrorFreshnessView),
  /** This server's worker for the adapter; null when none runs (the system is STAND_IN, or no endpoint is configured). */
  worker: AdapterWorkerView.nullable(),
});
export type AdapterHealthView = z.infer<typeof AdapterHealthView>;

export const AdapterDetailView = z.strictObject({
  health: AdapterHealthView,
  /** The newest 50 accepted messages, newest first. */
  messages: z.array(InboundMessageView),
  /** The newest 50 recorded refusals, newest first. */
  refusals: z.array(InboundRefusalView),
});
export type AdapterDetailView = z.infer<typeof AdapterDetailView>;

const adapterParams = z.strictObject({ adapterCode: AdapterCode });

export const integrations = {
  adapters: defineRoute({
    id: 'integrations.adapters',
    method: 'GET',
    path: '/api/integrations/adapters',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: false,
    summary: 'The integration health page: every registered adapter with its last message, data age, open alarms and last reconciliation',
    response: z.strictObject({ adapters: z.array(AdapterHealthView) }),
  }),
  adapter: defineRoute({
    id: 'integrations.adapter',
    method: 'GET',
    path: '/api/integrations/adapters/:adapterCode',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: false,
    summary: 'One adapter: its health, its newest messages and its newest refusals',
    params: adapterParams,
    response: AdapterDetailView,
  }),
  reconciliations: defineRoute({
    id: 'integrations.reconciliations',
    method: 'GET',
    path: '/api/integrations/adapters/:adapterCode/reconciliations',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: false,
    summary: 'The reconciliation reports of one adapter, newest period first',
    params: adapterParams,
    response: z.strictObject({ reports: z.array(ReconciliationReportView) }),
  }),
  mirrors: defineRoute({
    id: 'integrations.mirrors',
    method: 'GET',
    path: '/api/integrations/mirrors',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: false,
    summary: 'Every mirrored data class: STAND_IN or MIRROR, last synchronisation, age, bound and whether it is stale',
    response: z.strictObject({ mirrors: z.array(MirrorFreshnessView) }),
  }),
  alarms: defineRoute({
    id: 'integrations.alarms',
    method: 'GET',
    path: '/api/integrations/alarms',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: false,
    summary: 'Integration alarms, newest first (open ones by default)',
    query: z.strictObject({ state: z.enum(['OPEN', 'ACKNOWLEDGED', 'ALL']).optional(), adapterCode: AdapterCode.optional() }),
    response: z.strictObject({ alarms: z.array(IntegrationAlarmView) }),
  }),
  acknowledgeAlarm: defineRoute({
    id: 'integrations.acknowledgeAlarm',
    method: 'POST',
    path: '/api/integrations/alarms/:alarmId/acknowledge',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: true,
    attribution: 'FRESH_ON_SHARED',
    summary: 'Acknowledge an integration alarm with a note (ALARM.ACKNOWLEDGE; once per alarm)',
    params: z.strictObject({ alarmId: Uuid }),
    body: withAttribution({ note: z.string().trim().min(3).max(2000) }),
    response: IntegrationAlarmView,
  }),
};
