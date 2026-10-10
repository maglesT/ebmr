/**
 * Shared pieces of the granulation-side Tablets edition blocks (Phase 3 slice 3b: TB-02, TB-03, TB-04, TB-05, TB-07;
 * tablets spec section B.2).
 *
 * Process values (setpoints read back, collected actuals with their acceptance limits, alarms, the interface loss and
 * the equipment recipe check) go through G-06@1 itself: a TB block that runs on interfaced equipment takes G-06's
 * configuration members and entry kinds unchanged and hands those entries to G-06's handler, so the engine, the database
 * (recipe-core 0520: the entry's data; tablets 0820: the claimed reading of the step's bound device, exactly as received)
 * and the gateway apply one rule set, never a copy. Durations are measured between entries at the server's times
 * (database time), never typed. GMP values are decimal text; instants are epoch microseconds (bigint).
 */
import { Dec } from '@ebmr/expr';
import { blocks, flow } from '@ebmr/recipe-core/pure';
import type { engine } from '@ebmr/recipe-core/pure';

export type BlockVersion = blocks.BlockVersion;
export type HandlerView = blocks.HandlerView;
export type HandlerProblem = blocks.HandlerProblem;
export type ExceptionDraft = blocks.ExceptionDraft;
export type ExceptionRule = blocks.ExceptionRule;
export type ConfigProblem = blocks.ConfigProblem;
export type ObjectSchema = blocks.ObjectSchema;
export type FieldSchema = blocks.FieldSchema;
export type EntryResult = blocks.EntryResult;
export type PhaseNode = flow.PhaseNode;
export type MbrContent = flow.MbrContent;
export type FlowNode = flow.FlowNode;
export type JsonValue = flow.JsonValue;
export type EntryRecord = engine.EntryRecord;
export type Entry = Readonly<Record<string, unknown>> & { readonly kind: string };
export type Config = Readonly<Record<string, unknown>>;

/** A refusal of a block rule: plain words first, then the rule code and its controls. */
export function problem(code: string, message: string, controls: string[]): HandlerProblem {
  return { code, message: `${message} (${code}; ${controls.join(', ')})`, controls };
}

export function refuse(code: string, message: string, controls: string[]): { ok: false; problems: HandlerProblem[] } {
  return { ok: false, problems: [problem(code, message, controls)] };
}

export function configError(code: string, message: string, controls: string[]): ConfigProblem {
  return { code, severity: 'ERROR', message, controls };
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export const text = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

// ---------------------------------------------------------------------------------------------
// Schema fragments

export const QUANTITY: ObjectSchema = {
  type: 'object',
  description: 'A quantity: decimal text and its unit',
  fields: { value: { type: 'decimal', description: 'Decimal written as text' }, unit: { type: 'string', description: 'UCUM unit' } },
};

export const POSITIVE_QUANTITY: ObjectSchema = {
  type: 'object',
  description: 'A positive quantity: decimal text and its unit',
  fields: { value: { type: 'decimal', min: '0', minExclusive: true, description: 'Decimal written as text, above zero' }, unit: { type: 'string', description: 'UCUM unit' } },
};

export const DURATION: ObjectSchema = {
  type: 'object',
  description: 'A duration: decimal text in ms, s, min, h or d',
  fields: { value: { type: 'decimal', min: '0', description: 'Decimal written as text' }, unit: { type: 'string', enum: ['ms', 's', 'min', 'h', 'd'], description: 'Time unit' } },
};

export const CODE = /^[A-Z0-9][A-Z0-9_-]{0,31}$/;
export const ENTRY_ID = /^EN-[1-9][0-9]{0,8}$/;

export interface Quantity {
  value: string;
  unit: string;
}

export function quantityOf(v: unknown): Quantity | undefined {
  return isRecord(v) && typeof v['value'] === 'string' && typeof v['unit'] === 'string' ? { value: v['value'], unit: v['unit'] } : undefined;
}

/** A configured duration in microseconds (undefined when absent or not a whole number of microseconds). */
export function durationUs(v: unknown): bigint | undefined {
  const q = quantityOf(v);
  return q ? flow.durationToMicros(q.value, q.unit) : undefined;
}

/** Exact sum of quantities of one unit (undefined when the units differ or the list is empty). */
export function sumOf(qs: readonly Quantity[]): Quantity | undefined {
  const unit = qs[0]?.unit;
  if (unit === undefined || qs.some((q) => q.unit !== unit)) return undefined;
  return { value: qs.reduce((acc, q) => acc.plus(Dec.parse(q.value)), Dec.ZERO).toString(), unit };
}

/** Seconds between two instants, exactly, written with six decimals (as the database writes them: tablets 0850). */
export function secondsText(us: bigint): string {
  return Dec.fromScaled(us, -6).toFixed(6, 'HALF_EVEN');
}

// ---------------------------------------------------------------------------------------------
// G-06 inside a TB block

const G06 = blocks.G06;
const G06_CONFIG = G06.configSchema as ObjectSchema;
const G06_DATA = G06.dataSchema as NonNullable<BlockVersion['dataSchema']>;

/** G-06's configuration members (setpoints, actuals, criticalAlarms, maxAgeSeconds, manualFallback), unchanged. */
export const PROCESS_CONFIG_FIELDS: Readonly<Record<string, FieldSchema>> = G06_CONFIG.fields;
/** G-06's entry kinds (SETPOINT_READBACK, ACTUAL, ALARM, ALARM_ACK, INTERFACE_LOSS, RECIPE_CHECK), unchanged. */
export const PROCESS_ENTRIES: Readonly<Record<string, ObjectSchema>> = G06_DATA.entries;
export const PROCESS_KINDS: readonly string[] = Object.keys(PROCESS_ENTRIES);
export const PROCESS_EXCEPTION_RULES: readonly ExceptionRule[] = G06.exceptionRules ?? [];
export const PROCESS_CONTROLS = G06.controls;

export function isProcessKind(kind: string): boolean {
  return PROCESS_KINDS.includes(kind);
}

/** A G-06 entry of the step, judged by G-06's handler. */
export function acceptProcessEntry(view: HandlerView, entry: Entry): EntryResult {
  const handler = G06.handler;
  if (!handler?.acceptEntry) throw new Error('G-06 has no entry handler');
  return handler.acceptEntry(view, entry);
}

/** G-06's completeness at PERFORMED: alarms acknowledged; read-backs, the recipe and every collected value present. */
export function processBeforePerform(view: HandlerView): HandlerProblem[] {
  return G06.handler?.beforePerform?.(view) ?? [];
}

/** G-06's configuration checks (duplicate tags, limits, the equipment recipe named when an interface is configured). */
export function processConfigProblems(phase: PhaseNode, config: Readonly<Record<string, JsonValue>>, mbr: MbrContent): ConfigProblem[] {
  return G06.checkConfig?.(phase, config, mbr) ?? [];
}

/** G-06's nominal entries (recipe check, read-backs, collected values). */
export function processNominalEntries(input: Parameters<NonNullable<BlockVersion['simulatorModel']>['nominalEntries']>[0]): (Record<string, unknown> & { kind: string })[] {
  return G06.simulatorModel?.nominalEntries(input) ?? [];
}

/** The value of a usable G-06 ACTUAL entry, by entry id, of the step. */
export function usableActual(view: HandlerView, id: string): EntryRecord | undefined {
  return view.entries('ACTUAL').find((e) => e.id === id && e.data['usable'] === true);
}

// ---------------------------------------------------------------------------------------------
// Where a phase sits in the MBR

function childrenOf(n: FlowNode): FlowNode[] {
  switch (n.kind) {
    case 'sequence':
      return n.children;
    case 'parallel':
      return n.branches.map((b) => b.body);
    case 'alternative':
      return n.branches.flatMap((b) => (b.body ? [b.body] : []));
    case 'stage':
    case 'operation':
    case 'loop':
    case 'replicate':
      return [n.body];
    default:
      return [];
  }
}

/** The nodes enclosing phase `id` in the procedure, outermost first (empty when it is not found). */
export function ancestorsOf(mbr: MbrContent, id: string): FlowNode[] {
  const path: FlowNode[] = [];
  const visit = (n: FlowNode): boolean => {
    if (n.id === id) return true;
    path.push(n);
    for (const c of childrenOf(n)) if (visit(c)) return true;
    path.pop();
    return false;
  };
  return visit(mbr.procedure.body) ? path : [];
}

/** Every phase of the procedure. */
export function phasesOf(mbr: MbrContent): PhaseNode[] {
  const out: PhaseNode[] = [];
  const visit = (n: FlowNode): void => {
    if (n.kind === 'phase') out.push(n);
    childrenOf(n).forEach(visit);
  };
  visit(mbr.procedure.body);
  return out;
}

/** Entries of the step of one kind, in the order recorded. */
export function entriesOf(view: HandlerView, kind: string): readonly EntryRecord[] {
  return view.entries(kind);
}

/** The time an entry was recorded (database time), and the time an earlier entry of `kind` was, if any. */
export function lastAt(view: HandlerView, kind: string): bigint | undefined {
  const e = view.entries(kind).at(-1);
  return e?.recordedAt;
}
