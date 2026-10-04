/**
 * Plain words for members of MBR content in the document view (module C2; review F44). Every value is shown as the
 * content holds it (decimal text as written, never rounded); codes are shown in lower case with their meaning.
 */
import { PINNED_POLICY_ROLES, ROLE_TITLES } from '@ebmr/api-contract';
import { blocks, flow } from '@ebmr/recipe-core/pure';

type Content = flow.MbrContent;

/** A code in lower case with spaces, e.g. PROCESS_PARAMETER -> "process parameter". */
export const humanize = (code: string): string => code.toLowerCase().replace(/_/g, ' ');

/** The name of a data item (parameter, calculation, input) followed by its id, or the id alone. */
export function itemLabel(c: Content, id: string): string {
  const name = c.parameters.find((p) => p.id === id)?.name ?? c.calculations.find((x) => x.id === id)?.name ?? c.inputs.find((x) => x.id === id)?.name;
  return name ? `${name} (${id})` : id;
}

/** A pinned reference as "CODE vVERSION: title (id)", or the id alone when the content does not list it. */
export function referenceLabel(c: Content, id: string): string {
  const r = c.references.find((x) => x.id === id);
  return r ? `${r.code} v${r.version}${r.title ? `: ${r.title}` : ''} (${id})` : id;
}

export const ROUNDING_WORDS: Readonly<Record<string, string>> = {
  USP_HALF_UP_AT_LIMIT_DECIMALS: 'USP, half up at the limit decimals',
  PH_EUR_SIG_FIGS: 'Ph. Eur., significant figures',
};

export const roundingWords = (r: string): string => ROUNDING_WORDS[r] ?? humanize(r);

export function sourceWords(s: { kind: string; ref: string }): string {
  return `${humanize(s.kind)} ${s.ref}`;
}

export function quantityWords(q: { value: string; unit: string } | undefined): string {
  return q ? `${q.value} ${q.unit}` : '—';
}

/** A market rule a limit or time bound must not be looser than (outline 3.3.5). */
export function marketRuleWords(m: { key: string; bound: 'LOW' | 'HIGH' }): string {
  return `not looser than market rule ${m.key} (${m.bound === 'LOW' ? 'low' : 'high'} bound, as the market engine resolves it for this market set)`;
}

export function actionBreachWords(mode: string | undefined): string {
  if (mode === undefined) return 'an internal action breach stops the dependent step until a deviation is opened (the default)';
  return mode === 'CONTINUE_CURRENT_STEP_WITH_DEVIATION'
    ? 'an internal action breach lets the current step continue with a deviation raised (continue current step with deviation)'
    : 'an internal action breach stops the dependent step until a deviation is opened (stop dependent step)';
}

export const yesNo = (b: boolean): string => (b ? 'yes' : 'no');

/** A golden-case value: decimal text with its unit, yes/no, a category, or a series. */
export function goldenValueText(v: flow.GoldenValue): string {
  if ('value' in v) return `${v.value}${v.unit ? ` ${v.unit}` : ''}`;
  if ('bool' in v) return yesNo(v.bool);
  if ('category' in v) return v.category;
  return `${v.series.join(', ')}${v.unit ? ` ${v.unit}` : ''} (series of ${v.series.length})`;
}

/** A time-constraint event: the start or end of a numbered step, or an event outside the record. */
export function eventWords(numbering: flow.MbrNumbering, e: flow.EventRef): string {
  if (!flow.isNodeEvent(e)) return `${e.description} (outside this record, ${e.external})`;
  const n = numbering.byId.get(e.node);
  return `${e.event === 'START' ? 'start' : 'end'} of ${n ? `${n.number} ${n.name} (${e.node})` : e.node}`;
}

/** A sampling need of an acceptance criterion or an IPC step (units are a count, not a GMP value). */
export function samplingWords(x: { point: string; purpose: string; units: number; destructive: boolean }): string {
  return `at ${x.point}: ${x.units} units for ${x.purpose}, ${x.destructive ? 'destructive' : 'not destructive'}`;
}

/**
 * How the second person's check of phase `n` runs in this release, when that differs from the check the MBR names (Phase
 * 2 exit follow-up T12.DOC; DI-30, PR-14, DI-35): a later review of a critical value typed by hand from a printout or
 * photo runs as a timed witness, because no printout or photo can be attached in this release (the validator warns,
 * GMP-WITNESS-NO-ATTACHMENT). Whatever capture the MBR names (device, scan, LIMS, automation), every value a step records
 * is typed by hand in this release, which the words then say (round 2). Round 3: where the MBR names no check at all, the
 * engine still asks for a second person for such a value, from the fallback verifier roles, as the witness and then the
 * later review; the words say so. Null when the check runs as the MBR names it.
 */
export function checkInThisRelease(c: Content, n: flow.PhaseNode): string | null {
  const parameter = (id: string) => c.parameters.find((p) => p.id === id);
  // Round 2: whatever capture the MBR names, a value is typed by hand in this release; a quantity the block computes from
  // its weighings is not typed at all (blocks computedItemsOf, as the validator reads it).
  const items = flow.checkRunsAsWitness(parameter, n, blocks.computedItemsOf(n, c));
  if (items.length === 0) return null;
  const otherwise = flow.capturedOtherwise(parameter, items);
  const typed = otherwise.length === 0 ? '' : `every value is typed by hand on the step screen, whatever capture the MBR names (${otherwise.map((x) => `${itemLabel(c, x.id)}: ${flow.CAPTURE_WORDS[x.capture]}`).join('; ')}), and `;
  const named = n.signatures.check ? 'In this release this check runs as a witness (witnessed)' : 'The MBR names no check, but in this release the step is checked all the same, as a witness (witnessed)';
  const who = n.signatures.check
    ? 'the second person'
    : `a second person who holds ${orWords(PINNED_POLICY_ROLES.fallbackVerifierRoles.map((r) => ROLE_TITLES[r] ?? r))}, the roles that check a step whose MBR names no check,`;
  return `${named}: ${typed}no printout or photo can be attached to ${items.map((id) => itemLabel(c, id)).join(', ')}, so ${who} watches the entry within 5 minutes of the performed signature and before the run moves on; after that, the later review completes the step and records an exception for QA (GMP-WITNESS-NO-ATTACHMENT).`;
}

/** "a", "a or b", "a, b or c". */
function orWords(parts: readonly string[]): string {
  return parts.length <= 1 ? parts.join('') : `${parts.slice(0, -1).join(', ')} or ${parts[parts.length - 1] ?? ''}`;
}

/**
 * The "Checked by" cell of a phase's row: the role and the check the MBR names, and how it runs in this release; where
 * the MBR names no check but the step is checked all the same in this release (round 3), how it is.
 */
export function checkWords(c: Content, n: flow.PhaseNode, roleTitle: (role: string | undefined) => string): string {
  const check = n.signatures.check;
  const runs = checkInThisRelease(c, n);
  if (!check) return runs ?? '—';
  const named = `${roleTitle(check.role)} (${check.meaning.toLowerCase()})`;
  return runs === null ? named : `${named}. ${runs}`;
}
