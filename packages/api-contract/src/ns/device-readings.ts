/**
 * Process readings for the device-to-entry path (Phase 4 slice 1b, D-P4-10), part of namespace `devices`: the recent
 * readings the step's bound press or coater sent, which a SETPOINT_READBACK, ACTUAL or ALARM entry may stand on. The
 * entry names only the reading (BLOCK_ENTRY data {source: 'EQUIPMENT', readingId}); the server claims it in the entry's
 * command and copies tag, value, unit, quality and receipt time from the stored reading (tablets 0820 and 1111: the step's
 * bound device, within the step's window, each reading once).
 */
import { z } from 'zod';
import { DecimalString, Instant, PersonRef, Uuid, withAttribution } from '../common.ts';
import { StepKey } from '../intents.ts';
import { defineRoute } from '../route.ts';

export const ProcessReadingView = z.strictObject({
  readingId: Uuid,
  deviceCode: z.string(),
  kind: z.enum(['ACTUAL', 'SETPOINT_READBACK', 'ALARM', 'ALARM_CLEARED']),
  tag: z.string(),
  value: DecimalString,
  unit: z.string(),
  quality: z.string(),
  receivedAt: Instant,
  /** Whether an entry already stands on it (each reading is used once). */
  used: z.boolean(),
  /** Whether it is still inside the step's window (only such a reading can reach an entry). */
  current: z.boolean(),
});
export type ProcessReadingView = z.infer<typeof ProcessReadingView>;

/**
 * Phase 7 slice 7g (WP4, decision 0025): what a process step of a batch is bound to and what it may ask of its device:
 * the process device of the step (tab.step_device), the plant units it is bound to (plant.step_equipment), the units the
 * batch has in use, the active process devices, and the setpoints the MBR approves for the step with whether a download
 * of each still waits for the gateway (tab.setpoint_download). Every rule of the acts is the database's (tablets 0820,
 * 0870; recipe-core 0960).
 */
export const StepBindingsView = z.strictObject({
  batchId: Uuid,
  stepKey: StepKey,
  device: z.strictObject({ code: z.string(), boundBy: PersonRef, boundAt: Instant }).nullable(),
  equipment: z.array(z.strictObject({ code: z.string(), name: z.string(), boundBy: PersonRef, boundAt: Instant })),
  /** The plant units the batch has in use now (a step binds only one of these). */
  unitsInUse: z.array(z.strictObject({ code: z.string(), name: z.string() })),
  /** The active process devices of the site, each with the plant unit it is linked to. */
  devices: z.array(z.strictObject({ code: z.string(), equipmentKind: z.string(), unitCode: z.string().nullable() })),
  setpoints: z.array(z.strictObject({ tag: z.string(), value: DecimalString, unit: z.string(), waiting: z.boolean() })),
});
export type StepBindingsView = z.infer<typeof StepBindingsView>;

const stepTarget = { batchId: Uuid, stepKey: StepKey };

export const deviceReadings = {
  processReadings: defineRoute({
    id: 'devices.processReadings',
    method: 'GET',
    path: '/api/devices/process-readings',
    installation: 'ANY',
    auth: 'SESSION',
    mutating: false,
    summary: 'The latest readings of the process device a step of a batch is bound to (newest first, at most 50), for an entry from the equipment',
    query: z.strictObject({ batchId: Uuid, stepKey: z.string().min(1).max(200) }),
    response: z.strictObject({ deviceCode: z.string().nullable(), windowSeconds: z.number().int().nonnegative(), readings: z.array(ProcessReadingView) }),
  }),
  // Phase 7 slice 7g (WP4): the step's device and equipment bindings and the setpoint download.
  stepBindings: defineRoute({
    id: 'devices.stepBindings',
    method: 'GET',
    path: '/api/devices/step-bindings',
    installation: 'ANY',
    auth: 'SESSION',
    mutating: false,
    summary: 'The process device and plant units a step of a batch is bound to, the units in use and devices it may bind, and the MBR setpoints it may download',
    query: z.strictObject(stepTarget),
    response: StepBindingsView,
  }),
  bindStepDevice: defineRoute({
    id: 'devices.bindStepDevice',
    method: 'POST',
    path: '/api/devices/step-bindings/device',
    installation: 'ANY',
    auth: 'SESSION',
    mutating: true,
    attribution: 'FRESH_ON_SHARED',
    summary: 'Bind the process device of a step (STEP.EXECUTE): an active device linked to the plant unit of the step\'s equipment use, once per step',
    body: withAttribution({ ...stepTarget, deviceCode: z.string().trim().min(1).max(64) }),
    response: StepBindingsView,
  }),
  bindStepEquipment: defineRoute({
    id: 'devices.bindStepEquipment',
    method: 'POST',
    path: '/api/devices/step-bindings/equipment',
    installation: 'ANY',
    auth: 'SESSION',
    mutating: true,
    attribution: 'FRESH_ON_SHARED',
    summary: 'Bind a plant unit the batch has in use to a step (STEP.EXECUTE); the unit\'s alarms and series follow the step (DI-49)',
    body: withAttribution({ ...stepTarget, equipmentCode: z.string().trim().min(1).max(64) }),
    response: StepBindingsView,
  }),
  requestSetpointDownload: defineRoute({
    id: 'devices.requestSetpointDownload',
    method: 'POST',
    path: '/api/devices/setpoint-downloads',
    installation: 'ANY',
    auth: 'SESSION',
    mutating: true,
    attribution: 'FRESH_ON_SHARED',
    summary: 'Ask for an MBR setpoint of the step to be downloaded to its bound device (STEP.EXECUTE; the value is the MBR\'s, PR-14); the gateway fetches it and reads it back',
    body: withAttribution({ ...stepTarget, tag: z.string().trim().min(1).max(64) }),
    response: StepBindingsView,
  }),
} as const;
