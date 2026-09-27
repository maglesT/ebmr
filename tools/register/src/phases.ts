/**
 * Target phase per control, read from the exit criteria in build outline section 11.
 * A control named in several phases takes the earliest one. Controls the outline does not
 * name get a default by part and edition, recorded as `target_phase_source: default`.
 */
import type { Edition, ParsedControl } from './catalog-parser.ts';

const ID_RANGE = /\b(DI|PR|ST|IN)-(\d{2})\s*(?:to|\.\.|–|-)\s*(?:\1-)?(\d{2})\b/g;
const ID_SINGLE = /\b(DI|PR|ST|IN)-(\d{2})\b/g;

export function idsInText(text: string): Set<string> {
  const ids = new Set<string>();
  let stripped = text;
  for (const m of text.matchAll(ID_RANGE)) {
    const [whole, prefix, from, to] = m as unknown as [string, string, string, string];
    for (let n = Number(from); n <= Number(to); n++) ids.add(`${prefix}-${String(n).padStart(2, '0')}`);
    stripped = stripped.replace(whole, ' ');
  }
  for (const m of stripped.matchAll(ID_SINGLE)) ids.add(`${m[1]}-${m[2]}`);
  return ids;
}

/** Parse "- **Phase N, ...** ... *Exit:* ..." bullets of outline section 11. */
export function phaseExitIds(outline: string): Map<number, Set<string>> {
  const section = outline.split(/^## 11\. /m)[1]?.split(/^## 12\. /m)[0] ?? '';
  const result = new Map<number, Set<string>>();
  for (const line of section.split('\n')) {
    const m = /^- \*\*Phase (\d)/.exec(line);
    if (!m) continue;
    const exit = line.split('*Exit:*')[1] ?? '';
    result.set(Number(m[1]), idsInText(exit));
  }
  return result;
}

export interface PhaseAssignment {
  phase: number;
  source: 'outline' | 'default';
}

export function assignPhase(control: ParsedControl, editions: Edition[], exits: Map<number, Set<string>>): PhaseAssignment {
  const named = [...exits.entries()].filter(([, ids]) => ids.has(control.id)).map(([p]) => p);
  if (named.length) return { phase: Math.min(...named), source: 'outline' };
  // "the tablet PR controls" (Phase 3) and "all ST-01..ST-79 and IN-40..IN-51" (Phase 5).
  const tabletsOnly = editions.length === 1 && editions[0] === 'tablets';
  const injectablesOnly = editions.length === 1 && editions[0] === 'injectables';
  if (control.part === 'C') return { phase: 5, source: 'default' };
  if (tabletsOnly) return { phase: 3, source: 'default' };
  if (injectablesOnly) return { phase: 5, source: 'default' };
  return { phase: 4, source: 'default' };
}
