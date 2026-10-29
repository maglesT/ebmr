/**
 * Phase 7 slice 7u (owner report #20): the plain sentence a block gives for one of its entries, from the entry's stored
 * data, e.g. "End point by time: 31.6 s, within range" or "Recipe RCP-CF-RTW version 1 matches the master". A block
 * declares one function per entry kind next to its entry schemas (BlockVersion.entrySummaries); the step screens and the
 * whole batch record view show it. A sentence never shows an internal id (an entry, use, issue or occupancy id), raw
 * JSON, an item key or an upper-case code: an item key is shown by the name the master gives it (EntrySummaryContext
 * .name), a code value by its words.
 *
 * Text only: values stay the decimal text the entry stores (no JavaScript number).
 */
import { childrenOf, type FlowNode, type JsonValue, type MbrContent, type StageNode } from '../flow/model.ts';

/** What a summary may read besides the entry: the master and the step's configuration. */
export interface EntrySummaryContext {
  readonly mbr: MbrContent;
  readonly config: Readonly<Record<string, JsonValue>>;
  /**
   * The master's name of an item key: a parameter, calculation, intermediate, input, BOM line (its material), reference,
   * stage or stage equipment (its class). A key the master does not name is never shown as such ("an item the master
   * does not name").
   */
  name(key: unknown): string;
}

/** The sentence of one entry kind, from the entry's stored data. */
export type EntrySummary = (data: Readonly<Record<string, unknown>>, ctx: EntrySummaryContext) => string;

export const UNNAMED_ITEM = 'an item the master does not name';

/** A reference shown as people know it: "Title (CODE)", or its code. */
function referenceName(r: { code: string; title?: string | undefined }): string {
  return r.title && r.title !== r.code ? `${r.title} (${r.code})` : r.code;
}

export function entrySummaryContext(mbr: MbrContent, config: Readonly<Record<string, JsonValue>> = {}): EntrySummaryContext {
  return {
    mbr,
    config,
    name(key) {
      if (typeof key !== 'string' || key === '') return UNNAMED_ITEM;
      const named =
        mbr.parameters.find((p) => p.id === key)?.name ??
        mbr.calculations.find((c) => c.id === key)?.name ??
        mbr.intermediates.find((i) => i.id === key)?.name ??
        mbr.inputs.find((i) => i.id === key)?.name;
      if (named) return named;
      const line = mbr.bom.find((b) => b.id === key);
      if (line) return materialName(mbr, line.material);
      const ref = mbr.references.find((r) => r.id === key);
      if (ref) return referenceName(ref);
      for (const stage of stagesOf(mbr.procedure.body)) {
        if (stage.id === key) return stage.name;
        const eq = stage.binding.equipment.find((e) => e.ref === key);
        if (eq) return materialName(mbr, eq.equipmentClass);
      }
      return UNNAMED_ITEM;
    },
  };
}

function stagesOf(node: FlowNode): StageNode[] {
  const own = node.kind === 'stage' ? [node] : [];
  return [...own, ...childrenOf(node).flatMap(stagesOf)];
}

/** The master's name of a value that is an item key or free text as entered (a material, a BOM line or text). */
export function nameOrText(ctx: EntrySummaryContext, v: unknown): string {
  const n = ctx.name(v);
  return n !== UNNAMED_ITEM ? n : materialName(ctx.mbr, v);
}

/** The sentence's first letter in upper case. */
export function cap(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** A material as the master names it (a reference id or a material code); a code the master does not list is shown as read. */
export function materialName(mbr: MbrContent, material: unknown): string {
  if (typeof material !== 'string' || material === '') return 'a material';
  const ref = mbr.references.find((r) => r.id === material || r.code === material);
  return ref ? referenceName(ref) : material;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** A stored scalar as text ('' for anything else). */
export function str(v: unknown): string {
  return typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'bigint' || typeof v === 'boolean' ? String(v) : '';
}

/** A stored scalar, or a dash when absent. */
export function val(v: unknown): string {
  const s = str(v);
  return s === '' ? '-' : s;
}

/** A unit as people read it. */
export function unitText(u: unknown): string {
  const s = str(u);
  if (s === '{tbl}') return 'tablets';
  if (s === 'um') return 'µm';
  if (s === 'Cel') return '°C';
  const m = /^\{(.+)\}$/.exec(s);
  return m?.[1] ?? s;
}

/** A value with its unit: "12.5 kg". */
export function amount(value: unknown, unit: unknown): string {
  const u = unitText(unit);
  return u === '' ? val(value) : `${val(value)} ${u}`;
}

/** A stored quantity ({value, unit}) as "12.5 kg"; a dash when absent. */
export function qty(v: unknown): string {
  return isRecord(v) ? amount(v['value'], v['unit']) : '-';
}

/** A code value in words: "DOES_NOT_COMPLY" -> "does not comply". */
export function words(v: unknown): string {
  const s = str(v);
  return s === '' ? '-' : s.toLowerCase().replace(/_/g, ' ');
}

/** A test or check result in words. */
export function verdict(v: unknown): string {
  switch (str(v)) {
    case 'PASS':
    case 'PASSED':
      return 'passes';
    case 'FAIL':
    case 'FAILED':
      return 'fails';
    case 'ACCEPTED':
      return 'accepted';
    case 'REJECTED':
      return 'rejected';
    case 'SECOND_STAGE':
      return 'goes to the second stage';
    case 'REPEAT':
      return 'is repeated';
    case 'RETEST':
      return 'needs a retest';
    case 'BUFFER':
      return 'goes on to the buffer stage';
    case '':
      return 'recorded';
    default:
      return words(v);
  }
}

export const yesNo = (v: unknown): string => (v === true ? 'yes' : v === false ? 'no' : '-');

/** "within range" / "out of range" for a stored boolean (nothing when absent). */
export function inRange(v: unknown, yes = 'within range', no = 'out of range'): string {
  return v === true ? yes : v === false ? no : '';
}

/** Parts joined with commas, empty parts left out. */
export function join(...parts: (string | false | null | undefined)[]): string {
  return parts.filter((p): p is string => typeof p === 'string' && p !== '').join(', ');
}

/** A count with its noun: "1 tablet", "3 tablets". */
export function count(n: unknown, one: string, many = `${one}s`): string {
  const s = val(n);
  return `${s} ${s === '1' ? one : many}`;
}

/** The entries of a stored array (none when absent). */
export function list(v: unknown): unknown[] {
  return Array.isArray(v) ? (v as unknown[]) : [];
}

/** A stored object (empty when absent). */
export function rec(v: unknown): Record<string, unknown> {
  return isRecord(v) ? v : {};
}

/** "keyed by hand" for a value from the manual path (source or capture MANUAL). */
export function byHand(v: unknown): string {
  return v === 'MANUAL' ? 'keyed by hand' : '';
}

/** Counts by category ({MAJOR: "2", MINOR: "0"}) as "2 major, 0 minor"; "none" when all are absent. */
export function tally(v: unknown, noun = ''): string {
  const parts = Object.entries(rec(v)).filter(([, n]) => str(n) !== '').map(([k, n]) => `${str(n)} ${words(k)}${noun}`);
  return parts.length === 0 ? 'none' : parts.join(', ');
}
