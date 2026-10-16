/**
 * Namespace `alarms` (Phase 6 slice 6b-0; DI-49; recipe-core 0960): the plant alarm log, generic for both editions
 * (D-P6b-3): alarms from the eBMR itself, from OPC UA equipment and from the EMS, each bound at its source time to the
 * batches and steps the unit or room served, with its transitions at the source and its acknowledgment in the eBMR.
 * Integration alarms (adapter faults) stay in `integrations`; the time monitor's alarms stay the platform's
 * (D-P6a-0-3).
 *
 * Signed act: none. `acknowledge` is an ACKNOWLEDGE act (ALARM.ACKNOWLEDGE in the batch's scope): attributed, with a
 * fresh badge tap on a shared terminal, by a person only (DI-14). It is the alarm's disposition: the action taken
 * always, a comment for a GMP-critical alarm, a deviation reference where the alarm's configuration requires one.
 *
 * Values travel as decimal text with their unit, counts as whole-number text, times as Instants.
 */
import { z } from 'zod';
import { Instant, PersonRef, Uuid, withAttribution } from '../common.ts';
import { defineRoute } from '../route.ts';

export const PlantAlarmSource = z.enum(['EBMR', 'OPCUA', 'EMS']);
export type PlantAlarmSource = z.infer<typeof PlantAlarmSource>;
export const AlarmSubjectKind = z.enum(['EQUIPMENT', 'AREA']);
export const AlarmLimitKind = z.enum(['HIGH_HIGH', 'HIGH', 'LOW', 'LOW_LOW', 'DEVIATION', 'RATE', 'STATE']);

const DecimalText = z.string().regex(/^-?(0|[1-9][0-9]*)(\.[0-9]+)?$/, 'decimal text');
const WholeText = z.string().regex(/^(0|[1-9][0-9]{0,17})$/, 'a whole number as text');
const PlantCode = z.string().regex(/^[A-Z0-9][A-Z0-9_-]{0,63}$/);

export const PlantAlarmView = z.strictObject({
  alarmId: Uuid,
  source: PlantAlarmSource,
  occurrenceId: z.string().min(1),
  subject: z.strictObject({ kind: AlarmSubjectKind, code: PlantCode }),
  alarmCode: z.string().min(1),
  /** The configuration version applied at the raise; null when the code was not configured (then GMP-critical). */
  codeVersion: WholeText.nullable(),
  gmpCritical: z.boolean(),
  deviationRequired: z.boolean(),
  severity: WholeText,
  tag: z.string().nullable(),
  value: z.strictObject({ value: DecimalText, unit: z.string().min(1) }).nullable(),
  limit: z.strictObject({ value: DecimalText.nullable(), unit: z.string().nullable(), kind: AlarmLimitKind }).nullable(),
  message: z.string().min(1),
  raisedAtSource: Instant,
  receivedAt: Instant,
  clearedAtSource: Instant.nullable(),
  sourceAcknowledgedAt: Instant.nullable(),
  /** The batches (and steps) the alarm is bound to; empty when the unit or room served no batch at the time. */
  batches: z.array(z.strictObject({ batchId: Uuid, batchNumber: z.string().min(1), step: z.string().nullable() })),
  acknowledgement: z
    .strictObject({ by: PersonRef, at: Instant, actionTaken: z.string().min(1), comment: z.string().nullable(), deviationRef: z.string().nullable() })
    .nullable(),
});
export type PlantAlarmView = z.infer<typeof PlantAlarmView>;

const alarmParams = z.strictObject({ alarmId: Uuid });

export const alarms = {
  list: defineRoute({
    id: 'alarms.list',
    method: 'GET',
    path: '/api/alarms',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: false,
    summary: 'Plant alarms, newest first (open ones by default), by source and unit or room',
    query: z.strictObject({ state: z.enum(['OPEN', 'ACKNOWLEDGED', 'ALL']).optional(), source: PlantAlarmSource.optional(), subjectCode: PlantCode.optional() }),
    response: z.strictObject({ alarms: z.array(PlantAlarmView) }),
  }),
  batchLog: defineRoute({
    id: 'alarms.batchLog',
    method: 'GET',
    path: '/api/alarms/by-batch/:batchId',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: false,
    summary: 'The alarm log of a batch (review, step screen), oldest first; one step when given',
    params: z.strictObject({ batchId: Uuid }),
    query: z.strictObject({ step: z.string().min(1).max(200).optional() }),
    response: z.strictObject({ alarms: z.array(PlantAlarmView) }),
  }),
  alarm: defineRoute({
    id: 'alarms.alarm',
    method: 'GET',
    path: '/api/alarms/:alarmId',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: false,
    summary: 'One plant alarm with its transitions, bound batches and acknowledgment',
    params: alarmParams,
    response: PlantAlarmView,
  }),
  acknowledge: defineRoute({
    id: 'alarms.acknowledge',
    method: 'POST',
    path: '/api/alarms/:alarmId/acknowledge',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: true,
    attribution: 'FRESH_ON_SHARED',
    summary: 'Acknowledge a plant alarm: the action taken, a comment (GMP-critical), a deviation reference where required (ALARM.ACKNOWLEDGE; once)',
    params: alarmParams,
    body: withAttribution({
      actionTaken: z.string().trim().min(1).max(2000),
      comment: z.string().trim().min(1).max(2000).optional(),
      deviationRef: z.string().trim().min(1).max(64).optional(),
    }),
    response: PlantAlarmView,
  }),
};
