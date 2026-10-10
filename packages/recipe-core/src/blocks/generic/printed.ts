/**
 * Generic block G-21@1, printed materials, coding, challenges and serialisation (outline 6.6 G-21; tablets spec K-19,
 * K-20, K-21; outline 5.2.8 L-29 and the integration table L-53; Phase 3 slice 4a).
 *
 * One block, several parts, each present when the step's configuration names it:
 *   * printed items (K-19): each item names its material, the artwork version per market, the issue rule (batch need and
 *     allowance) and the counting method, its unit and its reconciliation limits. An ISSUE takes a released lot of the
 *     item's material that carries the artwork version the master names for the pack's markets (those of the batch it
 *     names one for; India is in every market set), scanned at the line (the scanned version is the lot's); the issued total never exceeds the rule. A RECONCILIATION of every item
 *     always runs (INV-32, IN-17: there is no waiver), computed here from what was issued: unexplained = issued - (used
 *     + set-up waste + damaged + coded destroyed + uncoded returned + specimens); outside the item's limits it raises a
 *     release-blocking exception that waits for a deviation. Coded surplus is destroyed at the witnessed G-23 step the
 *     configuration names (the database holds that step to the quantities), never returned (PR-40, IN-22).
 *   * printing and challenges (K-20): the variable data is the record's (the tablets server releases the print job);
 *     each printer's first print is approved (FIRST_PRINT), each inspection device (reader, vision, checkweigher,
 *     missing-leaflet detector) is challenged at its triggers and interval. A failed challenge, or one taken after its
 *     interval ran out, raises an exception that stops the step until QA decides; the database holds the output made
 *     since the last good challenge (IN-22 (b), PR-37).
 *   * serialisation (K-21, L-53): the record keeps the pool id and counts of the L3 system per market, never unit
 *     serials; the pool's reconciliation closes with zero unexplained before the step can be performed (PR-42).
 *
 * The step is never skippable (its configuration has no such member). The database repeats every rule (recipe-core
 * 0580 and 0581; the lots, jobs, events and pools the entries stand on are the edition's, tablets 0950 to 0952).
 */
import { Dec } from '@ebmr/expr';
import { durationToMicros } from '../../flow/decimal.ts';
import type { MbrContent, PhaseNode } from '../../flow/model.ts';
import type { JsonValue } from '../../flow/model.ts';
import type { BlockVersion, ConfigProblem, EntryResult, ExceptionDraft, HandlerProblem, HandlerView } from '../contract.ts';
import type { FieldSchema, ObjectSchema } from '../schema.ts';
import { CORE_VALUE_RULES, EPOCH_MICROS, micros, problem, QUANTITY_SCHEMA } from './common.ts';

const CODE = /^[A-Z0-9][A-Z0-9_-]{0,31}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const COUNT = /^(0|[1-9][0-9]{0,17})$/;

export const COUNTING_METHODS = ['ROLL_COUNTER', 'WEIGH_COUNT', 'MANUAL_COUNT', 'LENGTH', 'MASS'] as const;
export const DEVICE_KINDS = ['PRINTER', 'READER', 'VISION', 'CHECKWEIGHER', 'LEAFLET_DETECTOR'] as const;
export const CHALLENGE_TRIGGERS = ['START', 'INTERVAL', 'STOPPAGE', 'REEL_CHANGE', 'END'] as const;
/** The parts of a reconciliation, in the order the balance adds them. */
export const RECONCILIATION_PARTS = ['used', 'setupWaste', 'damaged', 'codedDestroyed', 'uncodedReturned', 'specimens'] as const;

const DURATION: ObjectSchema = {
  type: 'object',
  description: 'A duration: decimal text and a time unit (ms, s, min, h, d)',
  fields: { value: { type: 'decimal', description: 'Decimal written as text', min: '0', minExclusive: true }, unit: { type: 'string', enum: ['ms', 's', 'min', 'h', 'd'], description: 'Time unit' } },
};

const ITEM_SCHEMA: ObjectSchema = {
  type: 'object',
  description: 'One printed packaging item (foil, carton, leaflet, label, shipper label)',
  fields: {
    id: { type: 'string', pattern: CODE, description: 'Item id within the step' },
    material: { type: 'string', description: 'Material code of the printed item' },
    artwork: { type: 'record', values: { type: 'string', description: 'Artwork version' }, description: 'The artwork version the master names, per market' },
    unit: { type: 'string', description: 'UCUM unit the item is issued and reconciled in (e.g. 1 for units, m for foil by length)' },
    issue: {
      type: 'object',
      description: 'Issue quantity rule: the batch need plus an allowance',
      fields: {
        need: { type: 'decimal', min: '0', minExclusive: true, description: 'Quantity the batch needs' },
        allowancePercent: { type: 'decimal', min: '0', description: 'Allowance above the need, in percent' },
      },
    },
    counting: { type: 'string', enum: COUNTING_METHODS, description: 'Counting method (a manual count is verified by a second person)' },
    limits: {
      type: 'object',
      description: 'Reconciliation limits (preset, narrow): the unexplained difference may not exceed them',
      fields: {
        maxUnexplained: { type: 'decimal', min: '0', optional: true, description: 'Largest unexplained difference, in the item unit' },
        maxUnexplainedPercent: { type: 'decimal', min: '0', optional: true, description: 'Largest unexplained difference, in percent of the issued quantity' },
      },
    },
    coded: { type: 'boolean', optional: true, default: false, description: 'The item is printed with batch data on the line (coded surplus is only destroyed)' },
  },
};

const DEVICE_SCHEMA: ObjectSchema = {
  type: 'object',
  description: 'A printer, coder or inspection device of the line',
  fields: {
    id: { type: 'string', pattern: CODE, description: 'Device id within the step' },
    kind: { type: 'string', enum: DEVICE_KINDS, description: 'What the device is' },
    serial: { type: 'string', pattern: /^[!#-~]{1,32}$/, optional: true, description: 'Serial the site gateway reports (its results come from the gateway, never keyed)' },
    every: { ...DURATION, optional: true, description: 'Challenge interval (an inspection device)' },
    triggers: { type: 'array', items: { type: 'string', enum: CHALLENGE_TRIGGERS, description: 'Challenge trigger' }, optional: true, description: 'When the device is challenged (default START and END)' },
  },
};

const MARKET_CODES: ObjectSchema = {
  type: 'object',
  description: 'Variable data of one market from the master (the record supplies batch and dates)',
  fields: {
    gtin: { type: 'string', pattern: /^[0-9]{14}$/, optional: true, description: 'GTIN-14' },
    ndc: { type: 'string', pattern: /^[0-9-]{11,14}$/, optional: true, description: 'US NDC with hyphens' },
    mrp: { type: 'boolean', optional: true, default: false, description: 'The pack shows the maximum retail price (India-domestic packs)' },
  },
};

const CONFIG_SCHEMA: ObjectSchema = {
  type: 'object',
  description: 'Printed packaging materials, printing and challenges, serialisation',
  fields: {
    items: { type: 'array', items: ITEM_SCHEMA, optional: true, description: 'Printed items issued and reconciled at this step' },
    destructionStep: { type: 'string', optional: true, description: 'The witnessed G-23 step where coded surplus is destroyed' },
    devices: { type: 'array', items: DEVICE_SCHEMA, optional: true, description: 'Printers and inspection devices of the line' },
    unit: { type: 'string', pattern: CODE, optional: true, description: 'Plant unit (PROCESS) of the line the output containers are opened on; its holds follow the challenges' },
    firstPrintRole: { type: 'string', optional: true, description: 'Role that approves the first print (default QA)' },
    shelfLifeMonths: { type: 'integer', min: 1, max: 120, optional: true, description: 'Shelf life in months (expiry date of the printed data)' },
    markets: { type: 'record', values: MARKET_CODES, optional: true, description: 'Variable data per market' },
    serialisation: {
      type: 'object',
      optional: true,
      description: 'Serialisation by the L3 system: pool ids and counts are recorded, never unit serials',
      fields: { markets: { type: 'array', minItems: 1, items: { type: 'string', description: 'Market' }, description: 'Markets whose packs are serialised' } },
    },
  },
};

const PRINTED_LOT_SCHEMA: ObjectSchema = {
  type: 'object',
  description: 'The printed-material lot as the site register holds it at the moment of issue',
  fields: {
    id: { type: 'string', description: 'Lot number' },
    material: { type: 'string', description: 'Material code' },
    status: { type: 'string', enum: ['RELEASED', 'QUARANTINE', 'ON_TEST', 'REJECTED', 'ON_HOLD', 'RECALLED', 'RETURNED', 'EXPIRED'], description: 'Material status' },
    artwork: { type: 'string', description: 'Artwork version the lot was received and released with' },
    expiresAtUs: { ...EPOCH_MICROS, optional: true },
  },
};

const DECIMAL_COUNT = (description: string): FieldSchema => ({ type: 'decimal', min: '0', description });

const DATA_SCHEMA = {
  entries: {
    ISSUE: {
      type: 'object',
      description: 'Printed material issued to the line from a released lot, its artwork scanned',
      fields: {
        item: { type: 'string', description: 'Item id' },
        lot: PRINTED_LOT_SCHEMA,
        scannedArtwork: { type: 'string', description: 'Artwork version read from the lot label at the line' },
        quantity: QUANTITY_SCHEMA,
      },
    },
    RECONCILIATION: {
      type: 'object',
      description: 'The reconciliation of one item (the balance is computed, never typed)',
      fields: {
        item: { type: 'string', description: 'Item id' },
        used: DECIMAL_COUNT('Used on good output'),
        setupWaste: DECIMAL_COUNT('Set-up waste'),
        damaged: DECIMAL_COUNT('Damaged'),
        codedDestroyed: DECIMAL_COUNT('Coded and destroyed'),
        uncodedReturned: DECIMAL_COUNT('Uncoded and returned'),
        specimens: DECIMAL_COUNT('Specimens kept with the record'),
      },
    },
    FIRST_PRINT: {
      type: 'object',
      description: 'The first-print approval of a printer\'s job',
      fields: {
        device: { type: 'string', description: 'Printer id' },
        job: { type: 'string', pattern: /^[!-~]{1,64}$/, description: 'Print job id (released by the server)' },
        approved: { type: 'boolean', description: 'The first print matches the job and the artwork' },
        specimen: { type: 'string', pattern: SHA256, optional: true, description: 'SHA-256 of the specimen image' },
      },
    },
    CHALLENGE: {
      type: 'object',
      description: 'A challenge of an inspection device with a known-bad test unit',
      fields: {
        device: { type: 'string', description: 'Device id' },
        trigger: { type: 'string', enum: CHALLENGE_TRIGGERS, description: 'Why it is challenged now' },
        result: { type: 'string', enum: ['PASS', 'FAIL'], description: 'PASS: the device rejected the test unit as it must' },
        event: { type: 'string', pattern: UUID, optional: true, description: 'The gateway event with the result (a gateway device)' },
      },
    },
    SERIAL_POOL: {
      type: 'object',
      description: 'A serial pool the L3 system issued for this packaging order and market',
      fields: {
        poolId: { type: 'string', pattern: /^[!-~]{1,64}$/, description: 'Pool id of the L3 system' },
        market: { type: 'string', description: 'Market' },
        gtin: { type: 'string', pattern: /^[0-9]{14}$/, description: 'GTIN the pool is for' },
        quantity: { type: 'string', pattern: COUNT, description: 'Serials in the pool' },
      },
    },
    SERIAL_RECONCILIATION: {
      type: 'object',
      description: 'The L3 report of a pool: counts by end state and its hash',
      fields: {
        poolId: { type: 'string', pattern: /^[!-~]{1,64}$/, description: 'Pool id' },
        commissioned: { type: 'string', pattern: COUNT, description: 'Commissioned' },
        decommissioned: { type: 'string', pattern: COUNT, description: 'Decommissioned' },
        destroyed: { type: 'string', pattern: COUNT, description: 'Destroyed' },
        samples: { type: 'string', pattern: COUNT, description: 'Samples' },
        unusedReturned: { type: 'string', pattern: COUNT, description: 'Unused, returned to the pool' },
        unexplained: { type: 'string', pattern: COUNT, description: 'Unexplained' },
        reportHash: { type: 'string', pattern: SHA256, description: 'SHA-256 of the L3 report' },
      },
    },
  } satisfies Record<string, ObjectSchema>,
};

// ---------------------------------------------------------------------------------------------
// Configuration readers

export interface PrintedItem {
  id: string;
  material: string;
  artwork: Readonly<Record<string, string>>;
  unit: string;
  need: string;
  allowancePercent: string;
  counting: string;
  maxUnexplained?: string;
  maxUnexplainedPercent?: string;
  coded: boolean;
}

export interface LineDevice {
  id: string;
  kind: string;
  serial?: string;
  every?: { value: string; unit: string };
  triggers: string[];
}

const obj = (v: unknown): Record<string, unknown> => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

export function printedItems(config: Readonly<Record<string, unknown>>): PrintedItem[] {
  return arr(config['items']).map((x) => {
    const i = obj(x);
    const issue = obj(i['issue']);
    const limits = obj(i['limits']);
    const artwork = Object.fromEntries(Object.entries(obj(i['artwork'])).filter((e): e is [string, string] => typeof e[1] === 'string'));
    return {
      id: String(i['id']),
      material: String(i['material']),
      artwork,
      unit: String(i['unit']),
      need: String(issue['need']),
      allowancePercent: String(issue['allowancePercent']),
      counting: String(i['counting']),
      ...(str(limits['maxUnexplained']) !== undefined ? { maxUnexplained: str(limits['maxUnexplained']) as string } : {}),
      ...(str(limits['maxUnexplainedPercent']) !== undefined ? { maxUnexplainedPercent: str(limits['maxUnexplainedPercent']) as string } : {}),
      coded: i['coded'] === true,
    };
  });
}

export function lineDevices(config: Readonly<Record<string, unknown>>): LineDevice[] {
  return arr(config['devices']).map((x) => {
    const d = obj(x);
    const every = obj(d['every']);
    const triggers = Array.isArray(d['triggers']) ? (d['triggers'] as unknown[]).map(String) : ['START', 'END'];
    return {
      id: String(d['id']),
      kind: String(d['kind']),
      ...(str(d['serial']) !== undefined ? { serial: str(d['serial']) as string } : {}),
      ...(str(every['value']) !== undefined && str(every['unit']) !== undefined ? { every: { value: str(every['value']) as string, unit: str(every['unit']) as string } } : {}),
      triggers,
    };
  });
}

export function serialisedMarkets(config: Readonly<Record<string, unknown>>): string[] {
  return arr(obj(config['serialisation'])['markets']).map(String);
}

function marketCodes(config: Readonly<Record<string, unknown>>, market: string): Record<string, unknown> {
  return obj(obj(config['markets'])[market]);
}

/** Whether a GTIN-14 carries its GS1 check digit (mod 10, weights 3 and 1 from the right). */
export function gtinValid(gtin: string): boolean {
  if (!/^[0-9]{14}$/.test(gtin)) return false;
  let sum = 0;
  for (let i = 0; i < 13; i += 1) sum += (gtin.charCodeAt(12 - i) - 48) * (i % 2 === 0 ? 3 : 1);
  return (10 - (sum % 10)) % 10 === gtin.charCodeAt(13) - 48;
}

/** The scale of decimal text as written ("1.50": 2). */
function scaleOf(text: string): number {
  const p = text.indexOf('.');
  return p < 0 ? 0 : text.length - p - 1;
}

/** Exact text of `d` at `scale` digits (as PostgreSQL's numeric writes a sum or difference of values of that scale). */
function atScale(d: Dec, scale: number): string {
  return d.toFixed(scale, 'HALF_EVEN');
}

/** The issued total of item `item` at the step and its scale ('0' when nothing was issued). */
export function issuedOf(view: HandlerView, item: string): { total: Dec; text: string } {
  const values = view.entries('ISSUE').filter((e) => e.data['item'] === item).map((e) => String(obj(e.data['quantity'])['value']));
  const total = values.reduce((a, v) => a.plus(Dec.parse(v)), Dec.ZERO);
  return { total, text: values.length === 0 ? '0' : atScale(total, Math.max(...values.map(scaleOf))) };
}

/** Whether |unexplained| is within the item's limits (exact; the percent limit is read against the issued total). */
export function withinLimits(item: PrintedItem, issued: Dec, unexplained: Dec): boolean {
  const u = unexplained.abs();
  if (item.maxUnexplained !== undefined && u.gt(Dec.parse(item.maxUnexplained))) return false;
  if (item.maxUnexplainedPercent !== undefined && u.times(Dec.HUNDRED).gt(Dec.parse(item.maxUnexplainedPercent).times(issued))) return false;
  return true;
}

/** The last passing challenge of device `device` at the step (its recording instant), if any. */
function lastPass(view: HandlerView, device: string): bigint | undefined {
  let at: bigint | undefined;
  for (const e of view.entries('CHALLENGE')) if (e.data['device'] === device && e.data['result'] === 'PASS' && (at === undefined || e.recordedAt > at)) at = e.recordedAt;
  return at;
}

function challengeDraft(view: HandlerView, type: 'CHALLENGE_FAILED' | 'CHALLENGE_MISSED', device: string): ExceptionDraft {
  return {
    type,
    title:
      type === 'CHALLENGE_FAILED'
        ? `The challenge of ${device} at ${view.stepKey} failed: the step stops and the output since the last good challenge is held until QA decides`
        : `${device} at ${view.stepKey} was not challenged within its interval: the step stops and the output since the last good challenge is held until QA decides`,
    controls: ['IN-22', 'PR-37'],
    severity: 'ACTION',
    category: 'DEVIATION_OR_OVERRIDE',
    blocks: 'STEP_AND_DOWNSTREAM',
    until: 'DISPOSITION',
    qaOnly: true,
    item: device,
  };
}

// ---------------------------------------------------------------------------------------------
// Entries

function acceptIssue(view: HandlerView, entry: Readonly<Record<string, unknown>>): EntryResult {
  const id = String(entry['item']);
  const item = printedItems(view.config).find((i) => i.id === id);
  if (!item) return { ok: false, problems: [problem('G21-ITEM', `${id} is not a printed item of ${view.phase.id}`, ['PR-33'])] };
  if (view.entries('RECONCILIATION').some((e) => e.data['item'] === id)) {
    return { ok: false, problems: [problem('G21-RECONCILED', `${id} is reconciled already: nothing more is issued at this step`, ['PR-39', 'IN-17'])] };
  }
  const lot = obj(entry['lot']);
  const quantity = obj(entry['quantity']);
  const out: HandlerProblem[] = [];
  if (lot['status'] !== 'RELEASED') out.push(problem('G21-LOT-STATUS', `Lot ${String(lot['id'])} is ${String(lot['status']).toLowerCase()}: printed material is issued only from released lots`, ['PR-32', 'PR-33']));
  const exp = micros(lot['expiresAtUs']);
  if (exp !== undefined && exp <= view.nowUs) out.push(problem('G21-LOT-EXPIRED', `Lot ${String(lot['id'])} is past its expiry date`, ['PR-32']));
  if (lot['material'] !== item.material) out.push(problem('G21-MATERIAL', `Lot ${String(lot['id'])} is ${String(lot['material'])}, not ${item.material}`, ['PR-33']));
  if (entry['scannedArtwork'] !== lot['artwork']) {
    out.push(problem('G21-SCAN', `The label scanned at the line reads artwork ${String(entry['scannedArtwork'])}, but lot ${String(lot['id'])} carries ${String(lot['artwork'])}`, ['PR-33']));
  }
  // The pack's markets: those of the batch the master names an artwork for (India is in every market set, an export
  // pack carries the destination's artwork); each names the lot's.
  const named = view.batch.marketSet.filter((m) => item.artwork[m] !== undefined);
  const wrong = named.filter((m) => item.artwork[m] !== lot['artwork']);
  if (named.length === 0) {
    out.push(problem('G21-ARTWORK', `The master names no artwork of ${id} for ${view.batch.marketSet.join(', ')}`, ['PR-32', 'PR-33']));
  } else if (wrong.length > 0) {
    out.push(problem('G21-ARTWORK', `Lot ${String(lot['id'])} carries artwork ${String(lot['artwork'])}; the master names ${wrong.map((m) => `${item.artwork[m] ?? 'none'} for ${m}`).join(', ')}`, ['PR-32', 'PR-33']));
  }
  if (quantity['unit'] !== item.unit) out.push(problem('G21-UNIT', `${id} is issued in ${item.unit}, not ${String(quantity['unit'])}`, ['PR-33']));
  const q = Dec.parse(String(quantity['value']));
  if (!q.isPositive()) out.push(problem('G21-QUANTITY', `An issue of ${id} is a positive quantity`, ['PR-33']));
  if (out.length > 0) return { ok: false, problems: out };
  const total = issuedOf(view, id).total.plus(q);
  if (total.times(Dec.HUNDRED).gt(Dec.parse(item.need).times(Dec.HUNDRED.plus(Dec.parse(item.allowancePercent))))) {
    return { ok: false, problems: [problem('G21-OVER-ISSUE', `${id} would be issued ${total.toString()} ${item.unit}, above the rule of ${item.need} ${item.unit} plus ${item.allowancePercent} %`, ['PR-33', 'IN-17'])] };
  }
  return {
    ok: true,
    data: { item: id, lot: { ...lot }, artwork: entry['scannedArtwork'], quantity: { value: quantity['value'], unit: quantity['unit'] }, counting: item.counting, issuedBy: view.actor.id },
    ...(item.counting === 'MANUAL_COUNT' ? { verificationRequired: true } : {}),
  };
}

function acceptReconciliation(view: HandlerView, entry: Readonly<Record<string, unknown>>): EntryResult {
  const id = String(entry['item']);
  const item = printedItems(view.config).find((i) => i.id === id);
  if (!item) return { ok: false, problems: [problem('G21-ITEM', `${id} is not a printed item of ${view.phase.id}`, ['PR-39'])] };
  if (view.entries('RECONCILIATION').some((e) => e.data['item'] === id)) {
    return { ok: false, problems: [problem('G21-RECONCILED-TWICE', `${id} is reconciled already at this step`, ['PR-39', 'IN-17'])] };
  }
  if (!item.coded && !Dec.parse(String(entry['codedDestroyed'])).isZero()) {
    return { ok: false, problems: [problem('G21-NOT-CODED', `${id} is not printed on the line, so none of it is coded`, ['PR-39', 'PR-40'])] };
  }
  const issued = issuedOf(view, id);
  const parts = RECONCILIATION_PARTS.map((p) => String(entry[p]));
  const accounted = parts.reduce((a, v) => a.plus(Dec.parse(v)), Dec.ZERO);
  const scale = Math.max(scaleOf(issued.text), ...parts.map(scaleOf));
  const unexplained = issued.total.minus(accounted);
  const ok = withinLimits(item, issued.total, unexplained);
  const data: Record<string, unknown> = { item: id };
  for (const p of RECONCILIATION_PARTS) data[p] = entry[p];
  Object.assign(data, { unit: item.unit, issued: issued.text, unexplained: atScale(unexplained, scale), withinLimits: ok, reconciledBy: view.actor.id });
  const exceptions: ExceptionDraft[] = ok
    ? []
    : [
        {
          type: 'PRINTED_RECONCILIATION',
          title: `The reconciliation of ${id} at ${view.stepKey} leaves ${atScale(unexplained, scale)} ${item.unit} unexplained of ${issued.text} issued, outside its limits: an investigation is needed and release is blocked`,
          controls: ['PR-39', 'IN-17', 'INV-32'],
          severity: 'ACTION',
          category: 'OUT_OF_LIMIT',
          blocks: 'DOWNSTREAM',
          until: 'DEVIATION',
          deviationRequired: true,
          releaseBlocking: true,
          item: id,
        },
      ];
  return { ok: true, data, ...(exceptions.length > 0 ? { exceptions } : {}) };
}

function acceptFirstPrint(view: HandlerView, entry: Readonly<Record<string, unknown>>): EntryResult {
  const device = lineDevices(view.config).find((d) => d.id === entry['device']);
  if (!device || device.kind !== 'PRINTER') return { ok: false, problems: [problem('G21-DEVICE', `${String(entry['device'])} is not a printer of ${view.phase.id}`, ['PR-36'])] };
  const role = str(view.config['firstPrintRole']) ?? 'QA';
  if (view.actor.kind === 'PERSON' && !view.actor.roles.includes(role)) {
    return { ok: false, problems: [problem('G21-APPROVER', `The first print is approved by ${role}`, ['PR-36', 'IN-16'])] };
  }
  return {
    ok: true,
    data: { device: device.id, job: entry['job'], approved: entry['approved'] === true, ...(typeof entry['specimen'] === 'string' ? { specimen: entry['specimen'] } : {}), approvedBy: view.actor.id },
  };
}

function acceptChallenge(view: HandlerView, entry: Readonly<Record<string, unknown>>): EntryResult {
  const device = lineDevices(view.config).find((d) => d.id === entry['device']);
  if (!device || device.kind === 'PRINTER') return { ok: false, problems: [problem('G21-DEVICE', `${String(entry['device'])} is not an inspection device of ${view.phase.id}`, ['IN-22'])] };
  if (device.serial !== undefined && typeof entry['event'] !== 'string') {
    return { ok: false, problems: [problem('G21-EVENT', `${device.id} reports through the gateway: its challenge names the gateway's result`, ['IN-22', 'DI-31'])] };
  }
  if (device.serial === undefined && typeof entry['event'] === 'string') {
    return { ok: false, problems: [problem('G21-EVENT', `${device.id} has no gateway link: its challenge names no gateway result`, ['IN-22', 'DI-31'])] };
  }
  const last = lastPass(view, device.id);
  const every = device.every ? durationToMicros(device.every.value, device.every.unit) : undefined;
  const missed = last !== undefined && every !== undefined && view.nowUs - last > every;
  const exceptions: ExceptionDraft[] = [];
  if (missed) exceptions.push(challengeDraft(view, 'CHALLENGE_MISSED', device.id));
  if (entry['result'] === 'FAIL') exceptions.push(challengeDraft(view, 'CHALLENGE_FAILED', device.id));
  return {
    ok: true,
    data: { device: device.id, trigger: entry['trigger'], result: entry['result'], ...(typeof entry['event'] === 'string' ? { event: entry['event'] } : {}), missed, challengedBy: view.actor.id },
    ...(device.serial === undefined ? { verificationRequired: true } : {}),
    ...(exceptions.length > 0 ? { exceptions } : {}),
  };
}

function acceptSerialPool(view: HandlerView, entry: Readonly<Record<string, unknown>>): EntryResult {
  const market = String(entry['market']);
  if (!serialisedMarkets(view.config).includes(market) || !view.batch.marketSet.includes(market)) {
    return { ok: false, problems: [problem('G21-MARKET', `${market} is not a serialised market of ${view.phase.id} and this batch`, ['PR-42'])] };
  }
  if (marketCodes(view.config, market)['gtin'] !== entry['gtin']) {
    return { ok: false, problems: [problem('G21-GTIN', `The pool is for GTIN ${String(entry['gtin'])}, not the master's for ${market}`, ['PR-42'])] };
  }
  if (view.entries('SERIAL_POOL').some((e) => e.data['market'] === market || e.data['poolId'] === entry['poolId'])) {
    return { ok: false, problems: [problem('G21-POOL-TWICE', `${market} has its pool at this step already`, ['PR-42'])] };
  }
  return { ok: true, data: { poolId: entry['poolId'], market, gtin: entry['gtin'], quantity: entry['quantity'], recordedBy: view.actor.id } };
}

function acceptSerialReconciliation(view: HandlerView, entry: Readonly<Record<string, unknown>>): EntryResult {
  const pool = view.entries('SERIAL_POOL').find((e) => e.data['poolId'] === entry['poolId']);
  if (!pool) return { ok: false, problems: [problem('G21-POOL-UNKNOWN', `${String(entry['poolId'])} is no serial pool of this step`, ['PR-42'])] };
  const counts = ['commissioned', 'decommissioned', 'destroyed', 'samples', 'unusedReturned'].map((k) => BigInt(String(entry[k])));
  const unexplained = BigInt(String(entry['unexplained']));
  const closed = unexplained === 0n && counts.reduce((a, b) => a + b, 0n) === BigInt(String(pool.data['quantity']));
  const data: Record<string, unknown> = { poolId: entry['poolId'] };
  for (const k of ['commissioned', 'decommissioned', 'destroyed', 'samples', 'unusedReturned', 'unexplained', 'reportHash']) data[k] = entry[k];
  Object.assign(data, { quantity: pool.data['quantity'], closed, reconciledBy: view.actor.id });
  const exceptions: ExceptionDraft[] = closed
    ? []
    : [
        {
          type: 'SERIAL_RECONCILIATION_OPEN',
          title: `Serial pool ${String(entry['poolId'])} at ${view.stepKey} does not close: ${String(entry['unexplained'])} unexplained of ${String(pool.data['quantity'])}; the packaging order cannot complete and release is blocked`,
          controls: ['PR-42', 'PR-39'],
          severity: 'ACTION',
          category: 'OUT_OF_LIMIT',
          blocks: 'NONE',
          deviationRequired: true,
          releaseBlocking: true,
          item: String(entry['poolId']),
        },
      ];
  return { ok: true, data, ...(exceptions.length > 0 ? { exceptions } : {}) };
}

// ---------------------------------------------------------------------------------------------
// Configuration checks

function checkConfig(phase: PhaseNode, config: Readonly<Record<string, JsonValue>>, mbr: MbrContent): ConfigProblem[] {
  const out: ConfigProblem[] = [];
  const err = (code: string, message: string, controls: string[]): void => void out.push({ code, severity: 'ERROR', message, controls });
  const items = printedItems(config);
  const devices = lineDevices(config);
  const dup = (ids: string[]) => ids.filter((x, i) => ids.indexOf(x) !== i);
  if (dup(items.map((i) => i.id)).length > 0) err('G21-DUPLICATE', `${phase.id} names printed item ${dup(items.map((i) => i.id)).join(', ')} twice`, ['PR-33']);
  if (dup(devices.map((d) => d.id)).length > 0) err('G21-DUPLICATE', `${phase.id} names device ${dup(devices.map((d) => d.id)).join(', ')} twice`, ['IN-22']);
  for (const i of items) {
    if (i.maxUnexplained === undefined && i.maxUnexplainedPercent === undefined) {
      err('G21-NO-LIMITS', `Printed item ${i.id} of ${phase.id} has no reconciliation limits: a packaging master is approved only with them`, ['PR-39', 'IN-17', 'INV-32']);
    }
    const markets = Object.keys(i.artwork);
    const foreign = markets.filter((m) => !mbr.header.marketSet.includes(m));
    if (markets.length === 0 || foreign.length > 0) {
      err('G21-ARTWORK-MARKET', `Printed item ${i.id} of ${phase.id} names ${markets.length === 0 ? 'no artwork version' : `artwork for ${foreign.join(', ')}, outside the master's markets`}`, ['PR-32', 'PR-33']);
    }
  }
  if (items.some((i) => i.coded)) {
    const dest = str(config['destructionStep']);
    if (dest === undefined) err('G21-DESTRUCTION-STEP', `${phase.id} codes printed items on the line but names no G-23 step where coded surplus is destroyed`, ['PR-40', 'IN-22']);
  }
  for (const d of devices) {
    if (d.kind !== 'PRINTER' && d.every !== undefined && durationToMicros(d.every.value, d.every.unit) === undefined) {
      err('G21-INTERVAL', `The challenge interval of ${d.id} is not a whole number of microseconds`, ['IN-22']);
    }
  }
  if (devices.some((d) => d.kind !== 'PRINTER') && str(config['unit']) === undefined) {
    err('G21-NO-UNIT', `${phase.id} challenges inspection devices but names no plant unit of the line, so a failed challenge could hold nothing`, ['IN-22', 'PR-37']);
  }
  for (const [m, codes] of Object.entries(obj(config['markets']))) {
    const gtin = obj(codes)['gtin'];
    if (typeof gtin === 'string' && !gtinValid(gtin)) err('G21-GTIN-CHECK', `The GTIN of ${m} at ${phase.id} has a wrong check digit`, ['PR-42', 'IN-31']);
  }
  for (const m of serialisedMarkets(config)) {
    if (typeof marketCodes(config, m)['gtin'] !== 'string') err('G21-SERIAL-GTIN', `${phase.id} serialises ${m} but names no GTIN for it`, ['PR-42']);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// The block

export const G21: BlockVersion = {
  type: 'G-21',
  version: '1',
  title: 'Printed materials, coding, challenges, serialisation',
  edition: 'generic',
  aliases: { tablets: 'K-19..K-21', injectables: 'KB-17' },
  level: 'PHASE',
  controls: ['PR-32', 'PR-33', 'PR-36', 'PR-37', 'PR-39', 'PR-40', 'PR-42', 'IN-16', 'IN-17', 'IN-22', 'IN-31', 'INV-32'],
  configSchema: CONFIG_SCHEMA,
  dataSchema: DATA_SCHEMA,
  checkConfig,
  handler: {
    acceptEntry: (view, entry) => {
      switch (entry.kind) {
        case 'ISSUE':
          return acceptIssue(view, entry);
        case 'RECONCILIATION':
          return acceptReconciliation(view, entry);
        case 'FIRST_PRINT':
          return acceptFirstPrint(view, entry);
        case 'CHALLENGE':
          return acceptChallenge(view, entry);
        case 'SERIAL_POOL':
          return acceptSerialPool(view, entry);
        case 'SERIAL_RECONCILIATION':
          return acceptSerialReconciliation(view, entry);
        default:
          return { ok: false, problems: [problem('G21-ENTRY', `${entry.kind} is not an entry of a printed-materials step`, ['PR-33'])] };
      }
    },
    beforePerform: (view) => {
      const out: HandlerProblem[] = [];
      const open = printedItems(view.config).filter((i) => !view.entries('RECONCILIATION').some((e) => e.data['item'] === i.id)).map((i) => i.id);
      if (open.length > 0) out.push(problem('G21-NOT-RECONCILED', `Reconcile ${open.join(', ')} first: the reconciliation always runs`, ['PR-39', 'IN-17', 'INV-32']));
      for (const d of lineDevices(view.config)) {
        if (d.kind === 'PRINTER') {
          if (!view.entries('FIRST_PRINT').some((e) => e.data['device'] === d.id && e.data['approved'] === true)) out.push(problem('G21-NO-FIRST-PRINT', `The first print of ${d.id} is not approved`, ['PR-36', 'IN-16']));
          continue;
        }
        const mine = view.entries('CHALLENGE').filter((e) => e.data['device'] === d.id);
        for (const t of d.triggers.filter((x) => x === 'START' || x === 'END')) {
          if (!mine.some((e) => e.data['trigger'] === t && e.data['result'] === 'PASS')) out.push(problem('G21-CHALLENGE-DUE', `${d.id} has no passing ${t.toLowerCase()} challenge`, ['IN-22', 'PR-37']));
        }
        const last = lastPass(view, d.id);
        const every = d.every ? durationToMicros(d.every.value, d.every.unit) : undefined;
        if (last !== undefined && every !== undefined && view.nowUs - last > every) out.push(problem('G21-CHALLENGE-DUE', `${d.id} is due for a challenge`, ['IN-22', 'PR-37']));
      }
      const pools = view.entries('SERIAL_POOL');
      for (const m of serialisedMarkets(view.config).filter((x) => view.batch.marketSet.includes(x))) {
        if (!pools.some((p) => p.data['market'] === m)) out.push(problem('G21-NO-POOL', `${m} has no serial pool`, ['PR-42']));
      }
      for (const p of pools) {
        const recs = view.entries('SERIAL_RECONCILIATION').filter((e) => e.data['poolId'] === p.data['poolId']);
        if (recs[recs.length - 1]?.data['closed'] !== true) out.push(problem('G21-SERIALS-OPEN', `Serial pool ${String(p.data['poolId'])} is not reconciled with zero unexplained`, ['PR-42']));
      }
      return out;
    },
  },
  exceptionRules: [
    ...CORE_VALUE_RULES,
    { type: 'PRINTED_RECONCILIATION', category: 'OUT_OF_LIMIT', severity: 'ACTION', summary: 'A printed-material balance outside its limits (investigation; release blocked)', controls: ['PR-39', 'IN-17', 'INV-32'] },
    { type: 'CHALLENGE_FAILED', category: 'DEVIATION_OR_OVERRIDE', severity: 'ACTION', summary: 'An inspection device failed its challenge; the output since the last good one is held', controls: ['IN-22', 'PR-37'] },
    { type: 'CHALLENGE_MISSED', category: 'DEVIATION_OR_OVERRIDE', severity: 'ACTION', summary: 'An inspection device was not challenged within its interval; the output since the last good one is held', controls: ['IN-22', 'PR-37'] },
    { type: 'SERIAL_RECONCILIATION_OPEN', category: 'OUT_OF_LIMIT', severity: 'ACTION', summary: 'A serial pool that does not close with zero unexplained (release blocked)', controls: ['PR-42'] },
  ],
  simulatorModel: {
    exceptionTypes: () => ['PRINTED_RECONCILIATION', 'CHALLENGE_FAILED', 'CHALLENGE_MISSED', 'SERIAL_RECONCILIATION_OPEN'],
    // The nominal path: each item issued at its need from a released lot with the master's artwork and reconciled
    // exactly; each printer's first print approved; each inspection device challenged at start and end; each serialised
    // market's pool commissioned whole.
    nominalEntries: ({ config, mbr }) => {
      const out: (Record<string, unknown> & { kind: string })[] = [];
      const market = mbr.header.marketSet[0] ?? 'IN';
      const evt = (i: number): string => `00000000-0000-4000-8000-${(0x2100 + i).toString(16).padStart(12, '0')}`;
      for (const i of printedItems(config)) {
        const art = i.artwork[market] ?? '';
        out.push({ kind: 'ISSUE', item: i.id, lot: { id: `LOT-${i.id}`, material: i.material, status: 'RELEASED', artwork: art }, scannedArtwork: art, quantity: { value: i.need, unit: i.unit } });
      }
      lineDevices(config).forEach((d, n) => {
        if (d.kind === 'PRINTER') out.push({ kind: 'FIRST_PRINT', device: d.id, job: `JOB-${d.id}`, approved: true });
        else for (const t of ['START', 'END']) out.push({ kind: 'CHALLENGE', device: d.id, trigger: t, result: 'PASS', ...(d.serial ? { event: evt(n * 2 + (t === 'END' ? 1 : 0)) } : {}) });
      });
      for (const i of printedItems(config)) out.push({ kind: 'RECONCILIATION', item: i.id, used: i.need, setupWaste: '0', damaged: '0', codedDestroyed: '0', uncodedReturned: '0', specimens: '0' });
      for (const m of serialisedMarkets(config).filter((x) => mbr.header.marketSet.includes(x))) {
        const gtin = str(marketCodes(config, m)['gtin']) ?? '';
        out.push({ kind: 'SERIAL_POOL', poolId: `POOL-${m}`, market: m, gtin, quantity: '1000' });
        out.push({ kind: 'SERIAL_RECONCILIATION', poolId: `POOL-${m}`, commissioned: '1000', decommissioned: '0', destroyed: '0', samples: '0', unusedReturned: '0', unexplained: '0', reportHash: '0'.repeat(64) });
      }
      return out;
    },
  },
  goldenFixture: {
    description:
      'Cartons issued by manual count (two persons) from a released lot with the master artwork and reconciled with 12 unexplained against a limit of 0 (release-blocking exception); the printer\'s first print approved; the vision system challenged at start and end; a serial pool reconciled with zero unexplained',
    controls: ['PR-33', 'PR-36', 'PR-37', 'PR-39', 'PR-42', 'IN-17', 'IN-22', 'INV-32'],
    phase: {
      block: { type: 'G-21', version: '1' },
      config: {
        items: [{ id: 'CARTON', material: 'MAT-CTN-10', artwork: { IN: 'ART-7' }, unit: '1', issue: { need: '1000', allowancePercent: '2' }, counting: 'MANUAL_COUNT', limits: { maxUnexplained: '0' }, coded: true }],
        destructionStep: 'after',
        devices: [
          { id: 'CODER', kind: 'PRINTER', serial: 'PRN-01' },
          { id: 'CAM', kind: 'VISION', serial: 'VIS-01', every: { value: '30', unit: 'min' } },
        ],
        unit: 'LINE-1',
        firstPrintRole: 'OPERATOR',
        markets: { IN: { gtin: '08901234567890', mrp: true } },
        serialisation: { markets: ['IN'] },
      },
    },
    script: [
      { entry: { kind: 'ISSUE', item: 'CARTON', lot: { id: 'CTN-LOT-1', material: 'MAT-CTN-10', status: 'RELEASED', artwork: 'ART-7' }, scannedArtwork: 'ART-7', quantity: { value: '1020', unit: '1' } } },
      { entry: { kind: 'FIRST_PRINT', device: 'CODER', job: 'PJ-1', approved: true } },
      { entry: { kind: 'CHALLENGE', device: 'CAM', trigger: 'START', result: 'PASS', event: '00000000-0000-4000-8000-000000002102' } },
      { entry: { kind: 'SERIAL_POOL', poolId: 'POOL-IN-1', market: 'IN', gtin: '08901234567890', quantity: '1000' } },
      { entry: { kind: 'CHALLENGE', device: 'CAM', trigger: 'END', result: 'PASS', event: '00000000-0000-4000-8000-000000002103' } },
      { entry: { kind: 'RECONCILIATION', item: 'CARTON', used: '990', setupWaste: '6', damaged: '2', codedDestroyed: '5', uncodedReturned: '0', specimens: '5' } },
      { entry: { kind: 'SERIAL_RECONCILIATION', poolId: 'POOL-IN-1', commissioned: '990', decommissioned: '2', destroyed: '5', samples: '3', unusedReturned: '0', unexplained: '0', reportHash: 'a'.repeat(64) } },
    ],
    expect: { exceptions: ['PRINTED_RECONCILIATION'], status: 'COMPLETED' },
  },
  tests: ['packages/recipe-core/test/blocks/golden.test.ts', 'packages/recipe-core/test/blocks/printed.test.ts'],
};

export const PRINTED_BLOCKS: readonly BlockVersion[] = [G21];
