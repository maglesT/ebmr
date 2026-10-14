/**
 * Namespace `capa` (Phase 6 slice 6a, builder B, GMP): the CAPA register (IN-01 (d), PR-51; site services 0925,
 * recipe-core 0952; D-P6a-6).
 *
 *  - With the built-in register (QMS_STATUS STAND_IN) QA raises a CAPA from its source (a deviation-lite record, an
 *    OOS, a complaint, a PQR, a self-inspection or a management review) with an owner, a due date and an effectiveness
 *    check; the check's due date is computed by the database (scheduled day plus the period), and a check without a
 *    result is OVERDUE from the day after it. The CAPA is linked to deviations both ways and, when it needs a master
 *    change, to the MBR version it waits for; QA other than its initiator closes it (signable action CAPA_ACT CLOSE,
 *    meaning CAPA_CLOSED), refused while it is not implemented, a check has no result or was not effective, or the master
 *    version is not effective (PR-51).
 *  - With a QMS (MIRROR) the rows are mirrors of the QMS's CAPAs with their version token (origin QMS); every write
 *    here is refused (EBMR-CAPA-002): the CAPA is changed in the QMS.
 *
 * Signed act (signable action CAPA_ACT, signable.ts), aggregate `capa`:
 *    capa <capa id>   CAPA_CLOSED (QA, never the initiator), state IMPLEMENTED   site.close_capa
 */
import { z } from 'zod';
import { Uuid, withAttribution } from '../common.ts';
import { defineRoute } from '../route.ts';

const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'a calendar date (YYYY-MM-DD)');

export const CapaSourceKind = z.enum(['DEVIATION', 'OOS', 'COMPLAINT', 'PQR', 'SELF_INSPECTION', 'MANAGEMENT_REVIEW']);
export const CapaState = z.enum(['OPEN', 'IMPLEMENTED', 'EFFECTIVENESS_CHECK', 'CLOSED', 'CANCELLED']);
export const CapaCheckStatus = z.enum(['OPEN', 'OVERDUE', 'DONE']);

export const CapaCheckView = z.strictObject({
  checkId: Uuid,
  criteria: z.string(),
  periodDays: z.number().int().positive(),
  scheduledOn: IsoDate,
  /** Computed by the database: the scheduling day plus the period. */
  dueOn: IsoDate,
  status: CapaCheckStatus,
  effective: z.boolean().nullable(),
  evidence: z.string().nullable(),
});

export const CapaSummaryView = z.strictObject({
  capaId: Uuid,
  ref: z.string(),
  origin: z.enum(['STAND_IN', 'QMS']),
  title: z.string(),
  sourceKind: CapaSourceKind.nullable(),
  sourceRef: z.string().nullable(),
  ownerPersonId: Uuid.nullable(),
  ownerName: z.string().nullable(),
  dueOn: IsoDate.nullable(),
  state: CapaState,
  overdue: z.boolean(),
  /** The QMS's version token of a mirror row, else null. */
  versionToken: z.string().nullable(),
  /** Effectiveness checks OVERDUE today. */
  overdueChecks: z.number().int().nonnegative(),
  needsMasterChange: z.boolean(),
});
export type CapaSummaryView = z.infer<typeof CapaSummaryView>;

export const CapaView = CapaSummaryView.extend({
  description: z.string().nullable(),
  raisedBy: z.string(),
  qmsEffectivenessDueOn: IsoDate.nullable(),
  deviations: z.array(z.strictObject({ deviationId: Uuid, ref: z.string(), state: z.string(), batches: z.array(z.string()) })),
  masterVersions: z.array(z.strictObject({ versionId: Uuid, label: z.string(), effective: z.boolean() })),
  checks: z.array(CapaCheckView),
  events: z.array(z.strictObject({ event: z.enum(['IMPLEMENTED', 'CLOSED', 'CANCELLED']), note: z.string().nullable(), by: z.string() })),
  qmsHistory: z.array(z.strictObject({ status: z.string(), versionToken: z.string(), messageId: Uuid })),
  /** Why QA cannot close it now (the database's words), null when it may close. */
  closeProblem: z.string().nullable(),
  /** The CAPA_CLOSED signature's record. */
  signable: z.strictObject({ aggregateType: z.literal('capa'), aggregateId: Uuid, meaning: z.literal('CAPA_CLOSED'), expectedState: z.literal('IMPLEMENTED') }),
});
export type CapaView = z.infer<typeof CapaView>;

const capaParams = z.strictObject({ capaId: Uuid });

export const capa = {
  register: defineRoute({
    id: 'capa.register',
    method: 'GET',
    path: '/api/capa',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: false,
    summary: 'The CAPA register: open first, with overdue CAPAs and checks flagged (IN-01 (d) ageing report)',
    query: z.strictObject({ state: CapaState.optional(), overdue: z.enum(['true']).optional() }),
    response: z.strictObject({ mode: z.enum(['STAND_IN', 'MIRROR']), capas: z.array(CapaSummaryView) }),
  }),
  detail: defineRoute({
    id: 'capa.detail',
    method: 'GET',
    path: '/api/capa/:capaId',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: false,
    summary: 'One CAPA: its source, deviations, master version, effectiveness checks, events, QMS history and why it cannot close yet',
    params: capaParams,
    response: CapaView,
  }),
  raise: defineRoute({
    id: 'capa.raise',
    method: 'POST',
    path: '/api/capa',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: true,
    attribution: 'FRESH_ON_SHARED',
    summary: 'Raise a CAPA from its source with an owner, a due date and an effectiveness check (CAPA.RECORD; STAND_IN only)',
    body: withAttribution({
      title: z.string().trim().min(1).max(500),
      description: z.string().trim().min(1).max(4000).optional(),
      sourceKind: CapaSourceKind,
      sourceRef: z.string().trim().min(1).max(128).optional(),
      deviationId: Uuid.optional(),
      ownerPersonId: Uuid,
      dueOn: IsoDate,
      needsMasterChange: z.boolean(),
      effectivenessCheck: z.strictObject({ criteria: z.string().trim().min(1).max(2000), periodDays: z.number().int().min(1).max(1095) }),
    }),
    response: CapaView,
  }),
  linkDeviation: defineRoute({
    id: 'capa.linkDeviation',
    method: 'POST',
    path: '/api/capa/:capaId/deviations',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: true,
    attribution: 'FRESH_ON_SHARED',
    summary: 'Link a deviation-lite record to the CAPA (PR-51: links both ways)',
    params: capaParams,
    body: withAttribution({ deviationId: Uuid }),
    response: CapaView,
  }),
  linkMasterVersion: defineRoute({
    id: 'capa.linkMasterVersion',
    method: 'POST',
    path: '/api/capa/:capaId/master-versions',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: true,
    attribution: 'FRESH_ON_SHARED',
    summary: 'Name the MBR version a CAPA that needs a master change waits for (PR-51)',
    params: capaParams,
    body: withAttribution({ versionId: Uuid }),
    response: CapaView,
  }),
  implement: defineRoute({
    id: 'capa.implement',
    method: 'POST',
    path: '/api/capa/:capaId/implementation',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: true,
    attribution: 'FRESH_ON_SHARED',
    summary: 'Record that the CAPA\'s actions are implemented, with what was done',
    params: capaParams,
    body: withAttribution({ note: z.string().trim().min(1).max(4000) }),
    response: CapaView,
  }),
  scheduleCheck: defineRoute({
    id: 'capa.scheduleCheck',
    method: 'POST',
    path: '/api/capa/:capaId/checks',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: true,
    attribution: 'FRESH_ON_SHARED',
    summary: 'Schedule another effectiveness check (due date computed by the database)',
    params: capaParams,
    body: withAttribution({ criteria: z.string().trim().min(1).max(2000), periodDays: z.number().int().min(1).max(1095) }),
    response: CapaView,
  }),
  recordEffectiveness: defineRoute({
    id: 'capa.recordEffectiveness',
    method: 'POST',
    path: '/api/capa/:capaId/checks/:checkId/result',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: true,
    attribution: 'FRESH_ON_SHARED',
    summary: 'Record an effectiveness check\'s result: effective or not, and the evidence',
    params: z.strictObject({ capaId: Uuid, checkId: Uuid }),
    body: withAttribution({ effective: z.boolean(), evidence: z.string().trim().min(1).max(4000) }),
    response: CapaView,
  }),
  cancel: defineRoute({
    id: 'capa.cancel',
    method: 'POST',
    path: '/api/capa/:capaId/cancellation',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: true,
    attribution: 'FRESH_ON_SHARED',
    summary: 'Cancel the CAPA with QA\'s own reason (never by its initiator)',
    params: capaParams,
    body: withAttribution({ reason: z.string().trim().min(1).max(2000) }),
    response: CapaView,
  }),
} as const;
