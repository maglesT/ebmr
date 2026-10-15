/**
 * Equipment data shared by the OPC UA and EMS contracts (Phase 6 slice 6b-0; DI-49, DI-32, DI-31; plan
 * docs/build-plan/phase-6/slice-6b-0-interfaces.md). Pure: zod and node:crypto only, no kernel import.
 *
 *  - Status quality: the source's status code kept as received (OPC UA StatusCode as 0xXXXXXXXX), read as GOOD,
 *    UNCERTAIN or BAD from its two severity bits.
 *  - Native samples: a value exactly as the source sent it (raw text, for example a Double written 1.25E1) with the
 *    decimal value the eBMR shows; the raw text must state the shown value exactly (DI-32: never rounded).
 *  - Series chunks: consecutive samples of one tag of one equipment or room, with a SHA-256 over a canonical text that
 *    the database recomputes (recipe-core 0960 plant.series_chunk_hash).
 *  - Alarm and equipment-event lifecycles: what a source reports (RAISED, CLEARED, SOURCE_ACKNOWLEDGED; state changes);
 *    the eBMR's own acknowledgment is a person's act in the eBMR, never the source's (DI-49).
 *  - Dynamic data references: how an entry, a review or a report names a stretch of native data.
 *
 * Every number travels as text; nothing here converts a GMP value to a JavaScript number.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { SourceCode, SourceText, SourceValue } from './contract.ts';
import { EpochMicrosText, Sha256Hex } from './envelope.ts';

// ---------------------------------------------------------------------------------------------------------------
// Status quality
// ---------------------------------------------------------------------------------------------------------------

/** A source status code as received: OPC UA StatusCode written 0x followed by eight upper-case hex digits. */
export const StatusCodeText = z.string().regex(/^0x[0-9A-F]{8}$/, 'a status code such as 0x00000000');
export type StatusCodeText = z.infer<typeof StatusCodeText>;

export const SAMPLE_QUALITIES = ['GOOD', 'UNCERTAIN', 'BAD'] as const;
export const SampleQuality = z.enum(SAMPLE_QUALITIES);
export type SampleQuality = z.infer<typeof SampleQuality>;

/** GOOD, UNCERTAIN or BAD from the two severity bits of a status code (OPC UA Part 4: 00 good, 01 uncertain, 1x bad). */
export function qualityOfStatus(code: StatusCodeText): SampleQuality {
  const top = code.charAt(2);
  if ('0123'.includes(top)) return 'GOOD';
  if ('4567'.includes(top)) return 'UNCERTAIN';
  return 'BAD';
}

// ---------------------------------------------------------------------------------------------------------------
// Raw values and the value shown
// ---------------------------------------------------------------------------------------------------------------

/** A numeric value as the source wrote it: decimal or exponent notation, at most 40 characters. */
export const RawNumberText = z.string().regex(/^[+-]?([0-9]+(\.[0-9]*)?|\.[0-9]+)([eE][+-]?[0-9]{1,3})?$/, 'a number as the source wrote it').max(40);
/** The decimal text the eBMR shows (no exponent, no plus sign). */
export const ShownDecimal = z.string().regex(/^-?(0|[1-9][0-9]*)(\.[0-9]+)?$/, 'decimal text such as 12.50');

/**
 * The canonical form of a number written in decimal or exponent notation: sign, digits without leading zeros, a point
 * only when there are fraction digits, no trailing fraction zeros, zero as "0". String arithmetic only (no float).
 * Null when the text is not a number.
 */
export function canonicalDecimal(text: string): string | null {
  const m = /^([+-]?)([0-9]*)(?:\.([0-9]*))?(?:[eE]([+-]?[0-9]{1,3}))?$/.exec(text);
  if (!m || (m[2] === '' && (m[3] ?? '') === '')) return null;
  const sign = m[1] === '-' ? '-' : '';
  let digits = `${m[2] ?? ''}${m[3] ?? ''}`;
  let point = (m[2] ?? '').length + Number.parseInt(m[4] ?? '0', 10);
  // Pad so that the point falls inside the digit string.
  if (point < 0) {
    digits = '0'.repeat(-point) + digits;
    point = 0;
  }
  if (point > digits.length) digits = digits + '0'.repeat(point - digits.length);
  const intPart = digits.slice(0, point).replace(/^0+/, '') || '0';
  const fracPart = digits.slice(point).replace(/0+$/, '');
  const body = fracPart === '' ? intPart : `${intPart}.${fracPart}`;
  return body === '0' ? '0' : `${sign}${body}`;
}

/**
 * Why `shown` is not exactly the value `raw` states (DI-32: the raw output must match the displayed value; a shown
 * value is never a rounding of the raw one), or null when it is.
 */
export function shownValueProblem(raw: string, shown: string): string | null {
  if (!RawNumberText.safeParse(raw).success) return `${raw} is not a number as a source writes it`;
  if (!ShownDecimal.safeParse(shown).success) return `${shown} is not decimal text`;
  if (canonicalDecimal(raw) !== canonicalDecimal(shown)) return `the shown value ${shown} is not the value ${raw} the device sent`;
  return null;
}

// ---------------------------------------------------------------------------------------------------------------
// Native samples and series chunks (plant.series)
// ---------------------------------------------------------------------------------------------------------------

/**
 * One sample in native form: the source's timestamp (and the source server's, when it has one), the raw value as text,
 * the decimal value shown (null when the status is BAD or the value is not a number), and the status code.
 */
export const NativeSample = z.strictObject({
  sourceTime: EpochMicrosText,
  serverTime: EpochMicrosText.nullable(),
  raw: z.string().min(1).max(64),
  value: ShownDecimal.nullable(),
  status: StatusCodeText,
});
export type NativeSample = z.infer<typeof NativeSample>;

/** Whose data a series, an alarm or an event is: a unit of plant.equipment or a room or line of plant.area. */
export const SUBJECT_KINDS = ['EQUIPMENT', 'AREA'] as const;
export const SubjectKind = z.enum(SUBJECT_KINDS);
export type SubjectKind = z.infer<typeof SubjectKind>;

/** A tag name: a released process tag (process/tags.ts) or an EMS room tag (systems/ems.ts). */
export const TagName = z.string().regex(/^[a-z][a-z0-9_]*(\.[a-zA-Z0-9_]+)+$/, 'a tag such as force.main_kN').max(64);

/** The most samples one chunk carries. */
export const SERIES_CHUNK_MAX_SAMPLES = 2000;

export const SeriesChunkV1 = z
  .strictObject({
    subjectKind: SubjectKind,
    subjectCode: SourceCode,
    tag: TagName,
    unit: SourceValue.shape.unit,
    /** The chunk's number in the feed of this subject and tag: 1, 2, 3, ... (a gap is visible). */
    chunkNo: z.string().regex(/^[1-9][0-9]{0,17}$/),
    samples: z.array(NativeSample).min(1).max(SERIES_CHUNK_MAX_SAMPLES),
    chunkHash: Sha256Hex,
  })
  .superRefine((c, ctx) => {
    let prev = -1n;
    c.samples.forEach((s, i) => {
      const t = BigInt(s.sourceTime);
      if (t <= prev) ctx.addIssue({ code: 'custom', path: ['samples', i, 'sourceTime'], message: 'source times increase within a chunk' });
      prev = t;
      if (s.value !== null) {
        const problem = shownValueProblem(s.raw, s.value);
        if (problem) ctx.addIssue({ code: 'custom', path: ['samples', i, 'value'], message: problem });
      }
    });
    if (c.chunkHash !== seriesChunkHash(c)) ctx.addIssue({ code: 'custom', path: ['chunkHash'], message: 'the chunk hash does not match its samples' });
  });
export type SeriesChunkV1 = z.infer<typeof SeriesChunkV1>;

/**
 * The canonical text of a chunk, hashed by the source and recomputed by the database: a header line
 * `subjectKind|subjectCode|tag|unit|chunkNo`, then one line per sample `sourceTime|serverTime|raw|value|status` (an empty
 * field for null), joined with `\n`, UTF-8.
 */
export function seriesChunkText(c: Pick<SeriesChunkV1, 'subjectKind' | 'subjectCode' | 'tag' | 'unit' | 'chunkNo' | 'samples'>): string {
  const head = [c.subjectKind, c.subjectCode, c.tag, c.unit, c.chunkNo].join('|');
  return [head, ...c.samples.map((s) => [s.sourceTime, s.serverTime ?? '', s.raw, s.value ?? '', s.status].join('|'))].join('\n');
}

export function seriesChunkHash(c: Pick<SeriesChunkV1, 'subjectKind' | 'subjectCode' | 'tag' | 'unit' | 'chunkNo' | 'samples'>): string {
  return createHash('sha256').update(seriesChunkText(c), 'utf8').digest('hex');
}

// ---------------------------------------------------------------------------------------------------------------
// Alarms and equipment events (plant.alarm, plant.equipment_state_event)
// ---------------------------------------------------------------------------------------------------------------

/**
 * What a source reports about one alarm occurrence (one raise to its clear). RAISED opens it in the eBMR; CLEARED and
 * SOURCE_ACKNOWLEDGED are later transitions of the same occurrence. The eBMR's acknowledgment with the action taken
 * (and a comment for a GMP-critical alarm) is a person's act in the eBMR (plant.acknowledge_alarm), never the source's.
 */
export const ALARM_TRANSITIONS = ['RAISED', 'CLEARED', 'SOURCE_ACKNOWLEDGED'] as const;
export const AlarmTransition = z.enum(ALARM_TRANSITIONS);
export type AlarmTransition = z.infer<typeof AlarmTransition>;

/** Which limit was crossed (STATE: a discrete condition such as a door open, a feed gap or a reject burst). */
export const LIMIT_KINDS = ['HIGH_HIGH', 'HIGH', 'LOW', 'LOW_LOW', 'DEVIATION', 'RATE', 'STATE'] as const;
export const LimitKind = z.enum(LIMIT_KINDS);
export type LimitKind = z.infer<typeof LimitKind>;

export const AlarmCode = z.string().regex(/^[A-Z][A-Z0-9_.-]{0,63}$/, 'an alarm code such as FORCE_MAIN_HIGH');

export const EquipmentAlarmV1 = z
  .strictObject({
    subjectKind: SubjectKind,
    subjectCode: SourceCode,
    /** The source's id of this occurrence (an OPC UA ConditionId with the raising EventId, an EMS alarm number). */
    occurrenceId: z.string().regex(/^[\x21-\x7E]{1,128}$/),
    transition: AlarmTransition,
    alarmCode: AlarmCode,
    /** The source's severity, 1 (lowest) to 1000 (OPC UA), as text; informative only (the GMP-critical flag is the eBMR's). */
    severity: z.string().regex(/^([1-9][0-9]{0,2}|1000)$/),
    tag: TagName.nullable(),
    value: SourceValue.nullable(),
    limit: SourceValue.nullable(),
    limitKind: LimitKind.nullable(),
    message: SourceText,
    occurredAt: EpochMicrosText,
  })
  .refine((a) => (a.limit === null) === (a.limitKind === null || a.limitKind === 'STATE'), { message: 'a limit is given exactly when a limit other than STATE was crossed', path: ['limit'] });
export type EquipmentAlarmV1 = z.infer<typeof EquipmentAlarmV1>;

export const EQUIPMENT_STATES = ['IDLE', 'RUNNING', 'HELD', 'STOPPED', 'FAULTED', 'MAINTENANCE'] as const;
export const EquipmentState = z.enum(EQUIPMENT_STATES);
export type EquipmentState = z.infer<typeof EquipmentState>;

/**
 * Equipment events a source reports (EU GMP Chapter 4 relevant events in the record): a state change, a recipe loaded
 * (with its version, compared with the MBR's), a recipe mismatch found by the source, a phase start or end, an
 * operator action at the panel, a fault.
 */
export const EQUIPMENT_EVENT_KINDS = ['STATE_CHANGED', 'RECIPE_LOADED', 'RECIPE_MISMATCH', 'PHASE_STARTED', 'PHASE_ENDED', 'OPERATOR_ACTION', 'FAULT'] as const;
export const EquipmentEventKind = z.enum(EQUIPMENT_EVENT_KINDS);
export type EquipmentEventKind = z.infer<typeof EquipmentEventKind>;

export const EquipmentEventV1 = z
  .strictObject({
    equipmentCode: SourceCode,
    /** The source's unique id of the event (an OPC UA EventId as hex). */
    eventId: z.string().regex(/^[\x21-\x7E]{1,128}$/),
    kind: EquipmentEventKind,
    state: EquipmentState.nullable(),
    recipeVersion: z.string().regex(/^[\x21-\x7E]{1,64}$/).nullable(),
    message: SourceText,
    occurredAt: EpochMicrosText,
  })
  .refine((e) => (e.kind === 'STATE_CHANGED') === (e.state !== null), { message: 'a state is given exactly with STATE_CHANGED', path: ['state'] })
  .refine((e) => !['RECIPE_LOADED', 'RECIPE_MISMATCH'].includes(e.kind) || e.recipeVersion !== null, { message: 'a recipe event names the recipe version', path: ['recipeVersion'] });
export type EquipmentEventV1 = z.infer<typeof EquipmentEventV1>;

// ---------------------------------------------------------------------------------------------------------------
// Dynamic data references
// ---------------------------------------------------------------------------------------------------------------

/**
 * A stretch of native data an entry, a review or a report refers to (DI-32: the native data, not a picture of them):
 * one tag of one subject over [from, to) of source time, optionally in a batch and step's context. The viewer reads it
 * back from plant.series (the equipment-data namespace).
 */
export const DynamicDataRef = z
  .strictObject({
    kind: z.literal('SERIES'),
    subjectKind: SubjectKind,
    subjectCode: SourceCode,
    tag: TagName,
    fromUs: EpochMicrosText,
    toUs: EpochMicrosText,
    batchId: z.uuid().nullable(),
    step: z.string().min(1).max(200).nullable(),
  })
  .refine((r) => BigInt(r.fromUs) < BigInt(r.toUs), { message: 'from is before to', path: ['toUs'] });
export type DynamicDataRef = z.infer<typeof DynamicDataRef>;
