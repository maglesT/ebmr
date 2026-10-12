/**
 * Client intents are resolved by the server into engine commands (Phase 2 apps plan section 4, "Client
 * commands are not engine commands"; section 7, "Command flow"). The browser says what the person did; the
 * server supplies every fact the browser must not:
 *  - the actor and the engine roles (stored authority evaluations, INV-26);
 *  - lot facts from the lot register of this installation (PR-18), by code: tab.sandbox_lot's TEST- lots in the
 *    sandbox, the site's material lots (site.material_lot, at the batch's site) in GMP (tablets 0801);
 *  - weights from the scale readings claimed by id through the DeviceReadingPort (source DEVICE with the
 *    raw line and time trust set here, DI-32), or, when no scale of the step's room is online, the values keyed
 *    by hand at a terminal of that room (source MANUAL: the block flags the entry and forces a second person,
 *    PR-20), with the balance read (the one the operator names, else the room's only scale, else MANUAL) and
 *    the statuses of the room's scales that opened the fallback (review finding P50). For a command from a screen
 *    that shows another version of the run, which the engine refuses (ENG-STALE), the readings are named with every
 *    check of the command's claims, made together, but not used, so the refusal is recorded and they stay usable for
 *    the resend (F58, F58.1);
 *  - container ids (prefixed by the batch number, under this installation's lot-number rule: TEST- in the sandbox, never
 *    TEST- in GMP) and the batch read from a scanned container label;
 *  - the source of a recorded value: the server cannot attest a scan made on the terminal, so a value is a
 *    hand entry (MANUAL, with the hand-entry rules of DI-30) unless the server captured it itself; a SCAN claim
 *    for a parameter the MBR does not scan, and a photo or printout hash that names no stored attachment, are
 *    refused (review findings P34, P58);
 *  - the room: a step whose stage names rooms is started and recorded only from a terminal of one of those
 *    rooms, and its scale readings are claimed for that room (DI-20, the stricter reading of plan section 7's
 *    "kiosk's room"; review finding P36);
 *  - the command id, and the signature of a signed intent (from the ceremony only).
 * A refusal here (unknown lot, a reading that cannot be claimed, both readings and manual values, a scan or an
 * attachment the server cannot attest, a terminal outside the step's room) is thrown, so the command
 * transaction rolls back with nothing written; a refusal by the engine is persisted (a stale screen's too). The
 * database refuses the same sources and rooms again (recipe-core 0285_evidence_source, 0300), and a hand-keyed
 * weighing beside an online scale of the room, from a terminal of no room or naming a balance that is not an active
 * instrument of the room, checked inside the command's transaction (tablets 0310, EBMR-EXE-074).
 */
import type pg from 'pg';
import { sandbox } from '@ebmr/kernel';
import { engine, type flow } from '@ebmr/recipe-core';
import { type ClientDataSource, type ClientEntry, type ClientIntent, type DataValueWire, type Refusal, type SignedIntent } from '@ebmr/api-contract';
import type { AppContext } from '../../platform/context.ts';
import type { ClaimedReading } from '../../platform/ports.ts';
import { HttpRefusal, refusal } from '../../platform/http/refusal.ts';
import { resolveBlockEntry } from './block-entries.ts';
import { lotForEngine, resolveLot } from './lots.ts';
import { tb01Consumption, tb01FefoCheck, tb01Lots } from './tb01.ts';

/**
 * Maximum age of a scale reading at database time the server asks for (plan section 10, default 120 s). The database
 * applies the lesser of this and its platform setting device.reading_max_age_s (tablets 0360), so a site that tightens
 * the setting gets the tighter maximum, and no caller can ask for older readings.
 */
export const READING_MAX_AGE_US = 120_000_000n;

export type JsonRecord = Record<string, unknown>;

// ---------------------------------------------------------------------------------------------
// Step keys

/** `<step>@<construct>=<index>/<construct>=<index>`: the step id and its frames (construct ids never contain '='). */
export function parseStepKey(key: string): { step: string; context: flow.Frame[] } {
  const at = key.indexOf('@');
  if (at <= 0) throw badKey(key);
  const step = key.slice(0, at);
  let rest = key.slice(at + 1);
  const context: flow.Frame[] = [];
  while (rest.length > 0) {
    const m = /^([^=]+)=(0|[1-9][0-9]{0,8})(?:\/(.*))?$/s.exec(rest);
    if (!m) throw badKey(key);
    context.push({ construct: m[1] ?? '', index: Number(m[2]) });
    rest = m[3] ?? '';
  }
  return { step, context };
}

function badKey(key: string): Error {
  return refusal(400, {
    code: 'SCHEMA',
    kind: 'INVALID_INPUT',
    whatHappened: 'The step named in the request is not in the expected form.',
    why: `${key.slice(0, 80)} is not <step>@<context>.`,
    controls: ['DI-34'],
    whatYouCanDo: ['Reload the screen and try again.'],
  });
}

/** Step id and frames of a step instance: the stored instance, else the key as written. */
export function stepTarget(state: engine.BatchState, key: string): { step: string; context: flow.Frame[] } {
  const inst = state.steps[key];
  return inst ? { step: inst.step, context: [...inst.frames] } : parseStepKey(key);
}

// ---------------------------------------------------------------------------------------------
// Values

export function dataValueOf(v: DataValueWire): engine.DataValue {
  switch (v.kind) {
    case 'INSTANT':
      return { kind: 'INSTANT', us: BigInt(v.us) };
    case 'SERIES':
      return { kind: 'SERIES', values: [...v.values], unit: v.unit };
    default:
      return { ...v };
  }
}

export function wireOf(v: engine.DataValue): DataValueWire {
  switch (v.kind) {
    case 'INSTANT':
      return { kind: 'INSTANT', us: v.us.toString() };
    case 'SERIES':
      return { kind: 'SERIES', values: [...v.values], unit: v.unit };
    case 'DECIMAL':
      return { kind: 'DECIMAL', value: v.value, unit: v.unit };
    case 'COUNT':
      return { kind: 'COUNT', value: v.value };
    case 'BOOLEAN':
      return { kind: 'BOOLEAN', value: v.value };
    case 'CATEGORY':
      return { kind: 'CATEGORY', value: v.value };
    case 'TEXT':
      return { kind: 'TEXT', value: v.value };
  }
}

// ---------------------------------------------------------------------------------------------
// Refusals of the resolution (nothing is written)

function refuse(code: string, whatHappened: string, why: string, controls: string[], whatYouCanDo: string[], status = 422): Error {
  return refusal(status, { code, kind: 'INVALID_INPUT', whatHappened, why, controls, whatYouCanDo, whoCanHelp: ['The shift supervisor'] });
}

// ---------------------------------------------------------------------------------------------
// Resolution

export interface IntentContext {
  client: pg.PoolClient;
  /**
   * Whether the command uses the scale readings it names (claims them). False for a command from a screen that shows
   * another version of the run than the run's: the engine refuses it (ENG-STALE) before it looks at anything, and its
   * refused row names the readings without using them (evidence.namedReadings; tablets 0500).
   */
  useReadings: boolean;
  app: AppContext;
  def: engine.BatchDefinition;
  state: engine.BatchState;
  /** The room of the session's terminal (null for a terminal registered to no room, such as an office PC; DI-20). */
  room: string | null;
  actor: engine.Actor;
  commandId: string;
  expectedVersion: number;
}

export interface ResolvedCommand {
  command: engine.Command;
  /** What the server resolved (reading ids and raw lines, lot facts, manual path): stored with the row. */
  evidence: JsonRecord;
}

interface Weights {
  gross: string;
  tare: string;
  unit: string;
  balance: string;
  source: 'DEVICE' | 'MANUAL';
  occurredAt?: engine.OccurredAt;
  evidence: JsonRecord;
}

// ---------------------------------------------------------------------------------------------
// Room of the step (DI-20)

/** The rooms the stage of `step` is bound to; empty when the step is unknown or its stage names no room. */
export function stepRooms(def: engine.BatchDefinition, step: string): readonly string[] {
  const stage = def.steps.get(step)?.stage;
  return (stage === undefined ? undefined : def.stages.get(stage)?.binding.rooms) ?? [];
}

/**
 * Why a terminal in `room` may not start, record, sign as performed or verify `step` (DI-20), or null when it may: the
 * step's stage names no room, or `room` is one of them. Data of a step whose stage names rooms is accepted only from a
 * terminal of one of those rooms, and readings only from a scale of that room (DI-32); a terminal of another room, or
 * one registered to no room such as an office PC, is refused. The database refuses the same rows (recipe-core 0285,
 * 0300); the server says so before anything is written, and before a signature's PIN is asked for.
 */
export function stepRoomRefusal(def: engine.BatchDefinition, step: string, room: string | null): Refusal | null {
  const rooms = stepRooms(def, step);
  if (rooms.length === 0 || (room !== null && rooms.includes(room))) return null;
  const stage = def.steps.get(step)?.stage ?? '?';
  const where = room === null ? 'registered to no room' : `in room ${room}`;
  return {
    code: 'EBMR-EXE-123',
    kind: 'NOT_ALLOWED',
    whatHappened: `This terminal is ${where}, but this step is done in ${rooms.join(' or ')}. Nothing was saved.`,
    why: `This terminal is ${where}; step ${step} belongs to stage ${stage}, which is bound to ${rooms.join(', ')}. The data of a step is accepted only from a terminal and a scale of the step's room.`,
    controls: ['DI-20', 'PR-23'],
    whatYouCanDo: [`Go to the terminal in ${rooms.join(' or ')} and do the step there.`],
    whoCanHelp: ['The shift supervisor'],
  };
}

/** The same, in the words a greyed action of the step screen shows (null when the terminal may act on the step). */
export function stepRoomReason(def: engine.BatchDefinition, step: string, room: string | null): string | null {
  const r = stepRoomRefusal(def, step, room);
  if (!r) return null;
  const rooms = stepRooms(def, step).join(' or ');
  return `This terminal is ${room === null ? 'registered to no room' : `in room ${room}`}, but this step is done in ${rooms}: go to the terminal in ${rooms} (${r.code}; ${r.controls.join(', ')})`;
}

/**
 * The room a step command is accepted from, and the room its scale readings are claimed for (DI-20): the terminal's
 * own room, once stepRoomRefusal accepts it; a refusal is thrown before anything is written.
 */
export function roomOfStep(ctx: IntentContext, step: string): string | null {
  const r = stepRoomRefusal(ctx.def, step, ctx.room);
  if (r) throw new HttpRefusal(422, r);
  return ctx.room;
}

// ---------------------------------------------------------------------------------------------
// Source of a recorded value (DI-30, DI-32)

const CAPTURED: Readonly<Record<string, string>> = {
  MANUAL: 'keyed by hand',
  DEVICE: 'captured from a device',
  AUTOMATION: 'captured from the automation system',
  LIMS: 'taken from LIMS',
};

/**
 * The engine source of a value the browser sends, with what the server stores about it. The server has no proof
 * of a scan made on the terminal (the request carries the code as typed or read by a keyboard scanner, nothing a
 * device signed), so a scan is never objective evidence here:
 *  - SCAN for a parameter the MBR does not capture by scanning is refused (the claim contradicts the MBR);
 *  - SCAN for a scanned parameter is a hand entry: MANUAL, so the engine flags the fallback, raises the exception
 *    and asks for the second person (DI-30, PR-14); the code is kept with the row as what the terminal said;
 *  - a photo or printout hash is refused: no attachment store exists, so the hash names nothing the server holds.
 */
export function dataSourceOf(def: engine.BatchDefinition, item: string, source: ClientDataSource): { source: engine.DataSource; evidence: JsonRecord } {
  if (source.mode === 'SCAN') {
    const capture = def.analysis.parameters.get(item)?.capture;
    if (capture !== 'SCAN') {
      const how = capture === undefined ? 'not a parameter this MBR scans' : `${CAPTURED[capture] ?? capture.toLowerCase()} in this MBR, not scanned`;
      throw refuse(
        'EBMR-EXE-121',
        `The value was sent as scanned, but ${item} is ${how}. Nothing was saved.`,
        `${item} is ${how}; a value the terminal only says was scanned is not objective evidence, and the server cannot attest a scan made on the terminal.`,
        ['DI-30', 'DI-32', 'PR-14'],
        ['Enter the value as the screen asks; a critical value keyed by hand is checked by a second person.'],
      );
    }
    return { source: { mode: 'MANUAL' }, evidence: { unattestedScan: { code: source.code, recordedAs: 'MANUAL' } } };
  }
  if (source.evidence !== undefined) {
    throw refuse(
      'EBMR-EXE-122',
      'A photo or printout cannot be attached to a value on this installation yet: the hash names no stored attachment. Nothing was saved.',
      `The ${source.evidence.kind.toLowerCase()} hash ${source.evidence.sha256.slice(0, 12)}... names no stored attachment, so it is not evidence of the value.`,
      ['DI-30', 'DI-32'],
      ['Enter the value without an attachment; a critical value keyed by hand is checked by a second person.'],
    );
  }
  return { source: { mode: 'MANUAL' }, evidence: {} };
}

// ---------------------------------------------------------------------------------------------
// Weights

/** Hand-keyed tare and gross, with the balance the operator names (optional; a scale of the step's room). */
interface ManualWeights {
  tare: string;
  gross: string;
  unit: string;
  deviceCode?: string | undefined;
}

/**
 * The manual two-person path (PR-20, DI-30): open only at a terminal of a room, while no scale of that room is online.
 * The balance recorded is the one the operator names (a scale of the room), else the room's only scale, else MANUAL
 * (the server cannot know which of several the operator read); the statuses of the room's scales that opened the
 * fallback are stored with the row. The database checks the room, the statuses and the balance again inside the
 * command's transaction, serialised with the room's heartbeats (tablets 0310), so a scale that comes online after this
 * read, or a writer that skips it, is refused there. It is stricter than this read: a scale counts as unusable there
 * only once that has stood for the 10 s heartbeat window, with no report since that it is ONLINE, no heartbeat of its
 * gateway received and not recorded, and no answer of its gateway's API (tablets 0340, 0350).
 */
async function manualWeights(ctx: IntentContext, room: string | null, manual: ManualWeights): Promise<Weights> {
  if (room === null) {
    throw refuse(
      'EBMR-EXE-074',
      'Weights can be keyed by hand only at a terminal of the room where the weighing is done. Nothing was saved.',
      'This terminal is registered to no room, so the server cannot tell whether a scale where the weighing is done is online; keying by hand is the fallback only when no scale of the room is online (PR-20).',
      ['DI-20', 'DI-30', 'PR-20'],
      ['Do the weighing at the terminal of the room where the scale stands.'],
    );
  }
  const scales = await ctx.app.deviceReadings.scales(room);
  const online = scales.find((s) => s.status === 'ONLINE');
  if (online) {
    throw refuse('EBMR-EXE-074', 'A scale of this room is online, so the weights are captured from it. Nothing was saved.', `${online.deviceCode} is online in room ${room}; keying by hand is the fallback only when no scale of the room is online (PR-20).`, ['DI-30', 'PR-20'], ['Capture tare and gross from the scale.']);
  }
  const declared = manual.deviceCode;
  // The balance read is a scale of the room behind the gateway, or a balance of the room the gateway does not serve (an
  // active instrument of the room in the device registry, as the database's gate reads it: tablets 0310, 0710).
  const unserved =
    declared !== undefined &&
    !scales.some((s) => s.deviceCode === declared) &&
    (
      await ctx.client.query<{ ok: boolean }>(
        "select exists (select 1 from iam.device d where d.code = $1 and d.device_class = 'INSTRUMENT' and d.status = 'ACTIVE' and d.room_code = $2) as ok",
        [declared, room],
      )
    ).rows[0]?.ok === true;
  if (declared !== undefined && !scales.some((s) => s.deviceCode === declared) && !unserved) {
    throw refuse(
      'EBMR-EXE-074',
      `${declared.slice(0, 64)} is not a scale of room ${room}. Nothing was saved.`,
      `A weight keyed by hand names the balance of the room that was read; the scales of room ${room} are ${scales.map((s) => s.deviceCode).join(', ') || 'none'}.`,
      ['DI-20', 'DI-30'],
      ['Name the balance you read, or leave it empty.'],
    );
  }
  const only = scales.length === 1 ? scales[0]?.deviceCode : undefined;
  const balance = declared ?? only ?? 'MANUAL';
  return {
    gross: manual.gross,
    tare: manual.tare,
    unit: manual.unit,
    balance,
    source: 'MANUAL',
    evidence: {
      manual: {
        room,
        balance,
        declaredBalance: declared ?? null,
        scales: scales.map((s) => ({ deviceCode: s.deviceCode, status: s.status, lastHeartbeatUs: s.lastHeartbeat?.us ?? null })),
      },
    },
  };
}

/**
 * Tare and gross: claimed readings of a scale in `room` (the step's room, DI-20), or values keyed by hand. A command
 * that uses no reading (ctx.useReadings false: a stale screen) gets the same facts after the same checks, made together
 * as the claims make them, nothing is used, and the readings are listed as named (evidence.namedReadings), not as used
 * (evidence.readings).
 */
async function weights(ctx: IntentContext, room: string | null, e: { tareReadingId?: string | undefined; grossReadingId?: string | undefined; manual?: ManualWeights | undefined }): Promise<Weights> {
  const readings = e.tareReadingId !== undefined || e.grossReadingId !== undefined;
  if (e.manual && readings) {
    throw refuse('EBMR-EXE-073', 'Send the weights either from the scale or keyed by hand, not both. Nothing was saved.', 'The request carries scale readings and hand-keyed values; a weight from the scale is never replaced by a typed one.', ['DI-30', 'DI-32'], ['Capture tare and gross again from the scale.']);
  }
  if (e.manual) return manualWeights(ctx, room, e.manual);
  if (e.tareReadingId === undefined || e.grossReadingId === undefined) {
    throw refuse('EBMR-EXE-075', 'Capture both the tare and the gross weight. Nothing was saved.', 'A container weighing needs a tare and a gross reading from the scale (or both keyed by hand when the scale is offline).', ['DI-30', 'PR-19'], ['Capture the missing weight, then save.']);
  }
  const port = ctx.app.deviceReadings;
  let tare: ClaimedReading | undefined;
  let gross: ClaimedReading | undefined;
  if (ctx.useReadings) {
    [tare] = await port.claim(ctx.client, { readingIds: [e.tareReadingId], room, maxAgeUs: READING_MAX_AGE_US, purpose: 'TARE' });
    [gross] = await port.claim(ctx.client, { readingIds: [e.grossReadingId], room, maxAgeUs: READING_MAX_AGE_US, purpose: 'GROSS' });
  } else {
    // The same claims, made together and undone: a pair the claims above refuse (one reading named as both, EBMR-DEV-105)
    // is refused the same way, before anything is written (F58.1; tablets 0510).
    [tare, gross] = await port.peekWeighing(ctx.client, { tareReadingId: e.tareReadingId, grossReadingId: e.grossReadingId, room, maxAgeUs: READING_MAX_AGE_US });
  }
  if (!tare || !gross) throw refuse('EBMR-EXE-075', 'A scale reading could not be used. Nothing was saved.', 'The scale reading was not returned by the claim.', ['DI-32'], ['Capture the weights again.']);
  if (tare.unit !== gross.unit || tare.deviceCode !== gross.deviceCode) {
    throw refuse('EBMR-EXE-076', 'Tare and gross must come from the same scale, in the same unit. Nothing was saved.', `Tare ${tare.value} ${tare.unit} on ${tare.deviceCode}; gross ${gross.value} ${gross.unit} on ${gross.deviceCode}.`, ['DI-30', 'PR-19'], ['Capture both weights on the same scale.']);
  }
  const reading = (purpose: string, r: typeof tare) => ({ purpose, readingId: r.readingId, deviceCode: r.deviceCode, value: r.value, unit: r.unit, raw: r.raw, sourceTimeUs: r.sourceTimeUs === null ? null : r.sourceTimeUs.toString(), trust: r.trust });
  return {
    gross: gross.value,
    tare: tare.value,
    unit: gross.unit,
    balance: gross.deviceCode,
    source: 'DEVICE',
    ...(gross.sourceTimeUs !== null ? { occurredAt: { us: gross.sourceTimeUs, trust: gross.trust } } : {}),
    evidence: { [ctx.useReadings ? 'readings' : 'namedReadings']: [reading('TARE', tare), reading('GROSS', gross)] },
  };
}

/**
 * A container id of this batch: `<batch number>/C<n>`, or a requested one of that form, under the lot-number rule of the
 * installation (TEST- in the sandbox, never TEST- in GMP; DI-05).
 */
export function containerId(state: engine.BatchState, requested: string | undefined, installation: 'GMP' | 'SANDBOX' = 'SANDBOX'): string {
  const batch = state.header.batchNumber;
  if (requested !== undefined) {
    const problem = sandbox.identifierProblem(installation, 'LOT_NUMBER', requested);
    if (!requested.startsWith(`${batch}/`) || problem !== null || state.containers[requested] !== undefined) {
      throw refuse(
        'EBMR-EXE-077',
        'This container id cannot be used. Nothing was saved.',
        `${requested.slice(0, 64)} ${state.containers[requested] !== undefined ? 'is already a container of this batch' : `is not a container id of batch ${batch} (<batch number>/<id>, ${installation === 'SANDBOX' ? 'TEST- lot-number rules' : 'the lot-number rules of this installation'})`}.`,
        ['DI-05', 'PR-21'],
        ['Leave the container id empty: the system gives the next one.'],
      );
    }
    return requested;
  }
  let n = Object.keys(state.containers).length + 1;
  while (state.containers[`${batch}/C${n}`] !== undefined) n += 1;
  return `${batch}/C${n}`;
}

/** The word a line clearance records as its previous batch when nothing was processed in the area before (G-10). */
export const NO_PREVIOUS_BATCH = 'NONE';

/**
 * DI-05: an identifier an entry records is one of this installation: a test identifier (TEST-...) in a test run, never a
 * real GMP one, and a real one in a GMP batch, never a TEST- one; refused before anything is written (the database
 * refuses the row too: tablets 0370 and 0801, EBMR-EXE-078).
 */
function requireOwnIdentifier(installation: 'GMP' | 'SANDBOX', kind: 'BATCH_NUMBER' | 'LOT_NUMBER', value: string, what: string): void {
  const problem = sandbox.identifierProblem(installation, kind, value);
  if (problem !== null) {
    throw refuse(
      problem.code,
      `This ${what} cannot be recorded in ${installation === 'SANDBOX' ? 'a test run' : 'a GMP batch'}. Nothing was saved.`,
      problem.message,
      ['DI-05'],
      [
        installation === 'SANDBOX'
          ? `Enter the test ${kind === 'BATCH_NUMBER' ? 'batch number' : 'lot or container'} shown on the test record (it starts with TEST-).`
          : `Enter the ${kind === 'BATCH_NUMBER' ? 'batch number' : 'lot or container'} shown on the GMP label; test identifiers (TEST-) belong to the sandbox only.`,
      ],
    );
  }
}

/** The batch printed on a container label: the part of the code before its first '/'. */
export function labelBatch(code: string): string {
  const i = code.indexOf('/');
  return i > 0 ? code.slice(0, i) : code;
}

async function resolveEntry(ctx: IntentContext, room: string | null, e: ClientEntry, target?: { step: string; context: flow.Frame[] }, stepKey = ''): Promise<{ entry: JsonRecord & { kind: string }; occurredAt?: engine.OccurredAt; evidence: JsonRecord }> {
  const tb01 = target !== undefined && ctx.def.steps.get(target.step)?.block?.type === 'TB-01';
  switch (e.kind) {
    case 'POTENCY_CALCULATION': {
      if (ctx.app.installation === 'GMP') for (const l of e.lots) requireOwnIdentifier('GMP', 'LOT_NUMBER', l.lotCode, 'lot');
      const lots = await tb01Lots(ctx.client, ctx.state.header.batchId, e.lots, ctx.app.installation);
      // The lots and the result ids are in the entry itself (resultId); the row's evidence keeps nothing more.
      return { entry: { kind: 'POTENCY_CALCULATION', lots: lots.entry }, evidence: {} };
    }
    case 'CONTAINER_WEIGHING': {
      const installation = ctx.app.installation;
      // GMP: a TEST- lot is named as such before the register is read (the sandbox answers an unknown lot below).
      if (installation === 'GMP') requireOwnIdentifier(installation, 'LOT_NUMBER', e.lotCode, 'lot');
      const lot = await resolveLot(ctx.client, e.lotCode, ctx.state.header.batchId);
      if (!lot) {
        throw refuse(
          'EBMR-EXE-072',
          `Lot ${e.lotCode.slice(0, 64)} is not known on this installation. Nothing was saved.`,
          installation === 'SANDBOX'
            ? 'Only registered TEST- lots can be dispensed in a test run; the lot status comes from the lot register, never from the terminal (PR-18).'
            : "Only material lots received into this site's lot register can be dispensed in a GMP batch; the lot status comes from the register, never from the terminal (PR-18).",
          ['PR-18', 'DI-05'],
          ['Scan the lot label again, or ask for the lot to be registered.'],
        );
      }
      if (e.fefoReason !== undefined && !tb01) {
        throw refuse('EBMR-EXE-244', 'A stock-rotation reason is recorded only at a potency-adjusted dispensing step. Nothing was saved.', 'This step does not record a reason for the lot it dispenses.', ['PR-18'], ['Leave the reason empty.']);
      }
      if (tb01 && target) await tb01FefoCheck(ctx, target, e.bomLine, lot, e.fefoReason);
      const w = await weights(ctx, room, e);
      const container = containerId(ctx.state, e.container, installation);
      const entry: JsonRecord & { kind: string } = {
        kind: 'CONTAINER_WEIGHING', item: e.item, bomLine: e.bomLine, container, lot: lotForEngine(lot), gross: w.gross, tare: w.tare, unit: w.unit, balance: w.balance, source: w.source,
        ...(e.fefoReason !== undefined ? { fefoReason: e.fefoReason } : {}),
      };
      // GMP: the dispensed net is consumed from the batch's reservation of the lot in this command (INV-13, INV-14),
      // once the engine is known to accept the entry (a refused entry is recorded and must consume nothing).
      // A G-07 weighing of a lot is consumed the same way (the database pairs it with its consumption, tablets 1093).
      const g07 = target !== undefined && ctx.def.steps.get(target.step)?.block?.type === 'G-07';
      const consumption = (tb01 || g07) && target && installation === 'GMP' && ctx.useReadings ? await tb01Consumption(ctx, target, entry, lot, tb01) : undefined;
      return {
        entry: consumption && tb01 ? { ...entry, consumption: consumption.id } : entry,
        ...(w.occurredAt ? { occurredAt: w.occurredAt } : {}),
        evidence: { ...w.evidence, lot: { code: lot.lotCode, material: lot.materialCode, status: lot.status } },
      };
    }
    case 'OUTPUT_CONTAINER': {
      const w = await weights(ctx, room, e);
      const container = containerId(ctx.state, e.container, ctx.app.installation);
      return {
        entry: { kind: 'OUTPUT_CONTAINER', intermediate: e.intermediate, container, gross: w.gross, tare: w.tare, unit: w.unit, balance: w.balance, source: w.source },
        ...(w.occurredAt ? { occurredAt: w.occurredAt } : {}),
        evidence: w.evidence,
      };
    }
    case 'CHARGE_CONTAINER':
      requireOwnIdentifier(ctx.app.installation, 'LOT_NUMBER', e.containerCode, 'container label');
      requireOwnIdentifier(ctx.app.installation, 'BATCH_NUMBER', labelBatch(e.containerCode), 'container label');
      return { entry: { kind: 'CHARGE_CONTAINER', container: e.containerCode, scannedBatch: labelBatch(e.containerCode) }, evidence: { scanned: e.containerCode } };
    case 'CLEARANCE_CHECK':
      return { entry: { kind: 'CLEARANCE_CHECK', answers: e.answers.map((a) => ({ id: a.id, answer: a.answer })) }, evidence: {} };
    case 'PREVIOUS_BATCH':
      if (e.batchNumber !== NO_PREVIOUS_BATCH) requireOwnIdentifier(ctx.app.installation, 'BATCH_NUMBER', e.batchNumber, 'previous batch number');
      return { entry: { kind: 'PREVIOUS_BATCH', product: e.product, batchNumber: e.batchNumber }, evidence: {} };
    case 'EQUIPMENT_STATUS':
      return { entry: { kind: 'EQUIPMENT_STATUS', equipmentRef: e.equipmentRef, labelId: e.labelId, answers: e.answers.map((a) => ({ id: a.id, answer: a.answer })) }, evidence: {} };
    case 'ACKNOWLEDGE':
      return { entry: { kind: 'ACKNOWLEDGE', mode: e.mode }, evidence: {} };
    case 'BLOCK_ENTRY': {
      // D-S6-2: the block's own entry schema (engine) and the database's guards decide; the server refuses the members
      // it fills and fills those it reads from the database (block-entries.ts).
      const block = target ? ctx.def.steps.get(target.step)?.block : undefined;
      const entry = await resolveBlockEntry({ client: ctx.client, batchId: ctx.state.header.batchId, stepKey, ...(target ? { step: target.step } : {}), block }, e.entryKind, e.data);
      return { entry, evidence: {} };
    }
  }
}

/**
 * The approval of an act proposed on batch `batchId` (aggregate batch_act): the latest valid signature of `meaning` on it,
 * with the engine roles of the role its signer signed in. Refused when there is none (nothing is written).
 */
export async function actApproval(client: pg.PoolClient, batchId: string, actId: string, meaning: string): Promise<engine.Approval> {
  if (!actId.startsWith(`${batchId}:act@`)) {
    throw refuse('EBMR-API-ACT-OTHER-BATCH', 'The approval named belongs to another batch. Nothing was saved.', `Act ${actId} was not proposed on this batch.`, ['DI-24', 'DI-29'], ['Ask for the approval on this batch.']);
  }
  const { rows } = await client.query<{ signature_id: string; signer_person: string; manifestation: Record<string, unknown>; valid: boolean }>(
    'select * from tab.signatures_of($1, $2)',
    ['batch_act', actId],
  );
  const sig = [...rows].reverse().find((r) => r.valid && (r.manifestation['meaning_code'] ?? r.manifestation['meaning']) === meaning);
  if (!sig) {
    throw refuse('EBMR-API-ACT-NOT-APPROVED', `The act has no ${meaning} approval yet. Nothing was saved.`, `A void needs QA's approval of the act as proposed (S28).`, ['DI-24', 'DI-29'], ['Ask QA to approve the act, then send it again.']);
  }
  const role = typeof sig.manifestation['role_code'] === 'string' ? sig.manifestation['role_code'] : '';
  const { rows: map } = await client.query<{ engine_role: string }>('select engine_role from tab.engine_role_map where kernel_role = $1 order by engine_role', [role]);
  return { approver: { id: sig.signer_person, kind: 'PERSON', roles: map.map((m) => m.engine_role) }, signature: { id: sig.signature_id, meaning, signer: sig.signer_person } };
}

/** The engine command of a plain client intent (claims readings and reads lots in the command's transaction). */
export async function resolveClientIntent(ctx: IntentContext, intent: ClientIntent): Promise<ResolvedCommand> {
  const base = { commandId: ctx.commandId, actor: ctx.actor, expectedVersion: ctx.expectedVersion };
  switch (intent.type) {
    case 'START_STEP': {
      const t = stepTarget(ctx.state, intent.stepKey);
      roomOfStep(ctx, t.step);
      return { command: { ...base, type: 'START_STEP', step: t.step, context: t.context }, evidence: {} };
    }
    case 'RECORD_DATA': {
      const t = stepTarget(ctx.state, intent.stepKey);
      roomOfStep(ctx, t.step);
      const s = dataSourceOf(ctx.def, intent.item, intent.source);
      return {
        command: { ...base, type: 'RECORD_DATA', step: t.step, context: t.context, item: intent.item, value: dataValueOf(intent.value), source: s.source, ...(intent.reason !== undefined ? { reason: intent.reason } : {}) },
        evidence: s.evidence,
      };
    }
    case 'RECORD_ENTRY': {
      const t = stepTarget(ctx.state, intent.stepKey);
      const r = await resolveEntry(ctx, roomOfStep(ctx, t.step), intent.entry, t, intent.stepKey);
      return { command: { ...base, type: 'RECORD_ENTRY', step: t.step, context: t.context, entry: r.entry, ...(r.occurredAt ? { occurredAt: r.occurredAt } : {}) }, evidence: r.evidence };
    }
    case 'RAISE_EXCEPTION': {
      const t = intent.stepKey !== undefined ? stepTarget(ctx.state, intent.stepKey) : undefined;
      return { command: { ...base, type: 'RAISE_EXCEPTION', ...(t ? { step: t.step, context: t.context } : {}), description: intent.description, severity: intent.severity }, evidence: {} };
    }
    case 'ATTACH_DEVIATION':
      return { command: { ...base, type: 'ATTACH_DEVIATION', exception: intent.exception, deviationRef: intent.deviationRef }, evidence: {} };
    case 'HOLD_BATCH':
      return { command: { ...base, type: 'HOLD_BATCH', holdType: intent.holdType, reason: intent.reason }, evidence: {} };
    case 'RELEASE_HOLD':
      return { command: { ...base, type: 'RELEASE_HOLD', hold: intent.hold, reason: intent.reason }, evidence: {} };
    case 'COMPLETE_LOOP_ITERATION': {
      // INV-19 (Phase 3 slice 6d): the iteration of the innermost loop the step instance runs in; the engine decides the
      // outcome from the exit condition (ENG-LOOP-CONTEXT when the step runs in no loop).
      const t = stepTarget(ctx.state, intent.stepKey);
      roomOfStep(ctx, t.step);
      const last = t.context[t.context.length - 1];
      return { command: { ...base, type: 'COMPLETE_LOOP_ITERATION', construct: last?.construct ?? '', context: t.context }, evidence: {} };
    }
    case 'CHOOSE_ALTERNATIVE': {
      // DI-34, PR-13 (Phase 3 slice 6d): the context is read with the step-key grammar; the engine decides the rest.
      const context = intent.context ? parseStepKey(`${intent.construct}@${intent.context}`).context : [];
      return { command: { ...base, type: 'CHOOSE_ALTERNATIVE', construct: intent.construct, context, branch: intent.branch, reason: intent.reason }, evidence: {} };
    }
    case 'VOID_ATTEMPT': {
      // DI-24, DI-29: a void keeps the attempt and carries the person's own reason; QA's approval (S28) is QA's
      // VOID_AUTHORISED signature on the act proposed first (POST /api/batches/:batchId/acts). The engine and the
      // database decide (EBMR-EXE-051, 052, 171, ESIG-070); the server only reads the approval's signature.
      const t = stepTarget(ctx.state, intent.stepKey);
      roomOfStep(ctx, t.step);
      const approval = intent.approvalActId ? await actApproval(ctx.client, ctx.state.header.batchId, intent.approvalActId, 'VOID_AUTHORISED') : undefined;
      return {
        command: {
          ...base,
          type: 'VOID_ATTEMPT',
          step: t.step,
          context: t.context,
          item: intent.item,
          reason: intent.reason,
          ...(intent.point !== undefined ? { point: intent.point } : {}),
          ...(approval ? { approval } : {}),
        },
        evidence: {},
      };
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Signed intents (the ENGINE_COMMAND signable action)

export interface SignedSubject {
  aggregateType: engine.AggregateType;
  /** Key inside the run (step key, stage key, exception id). */
  key: string;
  /** The signature target for prepareForSignature. */
  target: engine.SignatureTarget;
  /** The state esig.sign expects the record in (the state the engine requires for the command). */
  expectedState: string;
}

/** What a signed intent signs, without the run's state. */
export function signedSubject(state: engine.BatchState | undefined, intent: SignedIntent): SignedSubject {
  switch (intent.type) {
    case 'SIGN_PERFORMED': {
      const t = state ? stepTarget(state, intent.stepKey) : parseStepKey(intent.stepKey);
      return { aggregateType: 'batch_step', key: intent.stepKey, target: { type: 'SIGN_PERFORMED', step: t.step, context: t.context }, expectedState: 'IN_PROGRESS' };
    }
    case 'VERIFY':
      return { aggregateType: 'batch_step', key: intent.stepKey, target: { type: 'VERIFY' }, expectedState: 'AWAITING_VERIFICATION' };
    case 'DISPOSITION_HOLD_POINT':
      return { aggregateType: 'batch_step', key: intent.stepKey, target: { type: 'DISPOSITION_HOLD_POINT' }, expectedState: 'ENABLED' };
    case 'SIGN_OFF_STAGE':
      return { aggregateType: 'batch_stage', key: intent.stageKey, target: { type: 'SIGN_OFF_STAGE' }, expectedState: 'AWAITING_SIGN_OFF' };
    case 'DISPOSITION_EXCEPTION':
      return { aggregateType: 'batch_exception', key: intent.exception, target: { type: 'DISPOSITION_EXCEPTION' }, expectedState: 'OPEN' };
    case 'CORRECT_ENTRY':
      return { aggregateType: 'batch_point', key: intent.point, target: { type: 'CORRECT_ENTRY' }, expectedState: 'VALID' };
  }
}

/**
 * The meaning the engine requires for a signed intent at the database time `nowUs`: the block's PERFORMED meaning,
 * the check meaning of the step (re-verification, witness while one is possible, the block's own), the hold-point
 * decision's meaning, a stage sign-off or an exception disposition. Undefined when it depends on a state that is not
 * known (describe() without a cached run), or on the time when none is given (describe(): whether a check due as a
 * witness is still a witness or, the witness window having passed, the step's later review, engine 1.5.0, T12.LATE):
 * the command's transaction checks it then, at its trusted time. The meaning a VERIFY intent names is never used: the
 * check a step requires is the step's own, so asking for WITNESSED where the step requires another check is a meaning
 * mismatch (review finding P37).
 */
export function signedMeaning(def: engine.BatchDefinition | undefined, state: engine.BatchState | undefined, intent: SignedIntent, nowUs: bigint | undefined): string | undefined {
  switch (intent.type) {
    case 'SIGN_PERFORMED': {
      if (!def) return undefined;
      return engine.performMeaning(def, parseStepKey(intent.stepKey).step);
    }
    case 'VERIFY': {
      if (!def || !state) return undefined;
      const inst = state.steps[intent.stepKey];
      if (nowUs === undefined && engine.witnessDue(def, state, inst)) return undefined;
      return engine.checkMeaning(def, inst, inst?.step ?? parseStepKey(intent.stepKey).step, state, nowUs ?? 0n);
    }
    case 'DISPOSITION_HOLD_POINT':
      return engine.holdPointMeaning(intent.disposition);
    case 'SIGN_OFF_STAGE':
      return engine.MEANINGS.STAGE_SIGNED_OFF;
    case 'DISPOSITION_EXCEPTION':
      return engine.MEANINGS.EXCEPTION_DISPOSITIONED;
    case 'CORRECT_ENTRY':
      return engine.MEANINGS.CORRECTED;
  }
}

/** The engine command of a signed intent with a signature (the placeholder for the dry run, the real one to apply). */
export function signedCommand(
  state: engine.BatchState,
  intent: SignedIntent,
  actor: engine.Actor,
  signature: engine.SignatureRef,
  commandId: string,
  expectedVersion: number,
  approval?: engine.Approval,
): engine.Command {
  const base = { commandId, actor, expectedVersion };
  switch (intent.type) {
    case 'SIGN_PERFORMED': {
      const t = stepTarget(state, intent.stepKey);
      return { ...base, type: 'SIGN_PERFORMED', step: t.step, context: t.context, signature };
    }
    case 'VERIFY': {
      const t = stepTarget(state, intent.stepKey);
      return { ...base, type: 'VERIFY', step: t.step, context: t.context, signature };
    }
    case 'DISPOSITION_HOLD_POINT': {
      const t = stepTarget(state, intent.stepKey);
      return { ...base, type: 'DISPOSITION_HOLD_POINT', step: t.step, context: t.context, disposition: intent.disposition, ...(intent.comment !== undefined ? { comment: intent.comment } : {}), signature };
    }
    case 'SIGN_OFF_STAGE': {
      const frame = state.stages[intent.stageKey];
      const t = frame ? { step: frame.stage, context: [...frame.frames] } : parseStepKey(intent.stageKey);
      return { ...base, type: 'SIGN_OFF_STAGE', stage: t.step, context: t.context, signature };
    }
    case 'DISPOSITION_EXCEPTION':
      return { ...base, type: 'DISPOSITION_EXCEPTION', exception: intent.exception, outcome: intent.outcome, justification: intent.justification, signature };
    case 'CORRECT_ENTRY':
      return {
        ...base,
        type: 'CORRECT_ENTRY',
        point: intent.point,
        value: dataValueOf(intent.value),
        reason: intent.reason,
        signature,
        ...(intent.evidence ? { evidence: intent.evidence } : {}),
        ...(approval ? { approval } : {}),
      };
  }
}

/**
 * The approval a CORRECT_ENTRY names (Phase 4 slice 1a; S25, INV-41): the approver's valid CORRECTION_APPROVED signature on
 * the corrected data point (signable action CORRECTION_APPROVAL), with the engine roles of the role it was signed in. The
 * engine and the database decide whether it is the approval the correction needs (another person; QA for fail to pass and
 * for a loop reading that missed its endpoint).
 */
export async function correctionApproval(client: pg.PoolClient, batchId: string, point: string, signatureId: string): Promise<engine.Approval> {
  const { rows } = await client.query<{ signature_id: string; signer_person: string; manifestation: Record<string, unknown>; valid: boolean }>(
    'select * from tab.signatures_of($1, $2)',
    ['batch_point', `${batchId}:${point}`],
  );
  const sig = rows.find((r) => r.signature_id === signatureId && r.valid && (r.manifestation['meaning_code'] ?? r.manifestation['meaning']) === engine.MEANINGS.CORRECTION_APPROVED);
  if (!sig) {
    throw refuse('EBMR-API-CORRECTION-NOT-APPROVED', 'The approval named is not a valid approval of this correction. Nothing was saved.', `Signature ${signatureId} is not a valid CORRECTION_APPROVED signature on data point ${point}.`, ['DI-24', 'DI-30'], ['Ask for the approval of this correction, then send it again.']);
  }
  const role = typeof sig.manifestation['role_code'] === 'string' ? sig.manifestation['role_code'] : '';
  const { rows: map } = await client.query<{ engine_role: string }>('select engine_role from tab.engine_role_map where kernel_role = $1 order by engine_role', [role]);
  return { approver: { id: sig.signer_person, kind: 'PERSON', roles: map.map((m) => m.engine_role) }, signature: { id: sig.signature_id, meaning: engine.MEANINGS.CORRECTION_APPROVED, signer: sig.signer_person } };
}
