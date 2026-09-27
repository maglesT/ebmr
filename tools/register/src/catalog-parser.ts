/**
 * Parses the control catalogs (docs/regulatory/control-catalogs/*.md) into structured controls.
 *
 * The four catalogs were written by different authors and use slightly different field layouts
 * ("**Covers:**", "- Covers:", "- **Covers:**", India's "**Edition:** both. **Type:** ..."), so the
 * parser recognises a fixed set of labels in any of those forms.
 */

export interface ParsedControl {
  id: string;
  title: string;
  part: 'A' | 'B' | 'C' | 'D';
  group: string;
  fields: Record<string, string>;
}

const CONTROL_HEADING = /^(#{3,4})\s+((?:DI|PR|ST|IN)-\d+)\s*[:\-–—]?\s*(.*)$/;
const HEADING = /^(#{1,4})\s+(.*)$/;
const LABELS = [
  'Covers', 'Types', 'Type', 'Behaviour', 'Behavior', 'Citations', 'Jurisdiction', 'Test', 'Verify',
  'Theme', 'Scope', 'Process scope', 'Edition', 'Verification', 'Relation to FDA/EU', 'FDA vs EU',
  'Notes', 'Note', 'Defaults', 'Default',
];
const LABEL_LINE = new RegExp(
  '^(\\s*)(?:[-*]\\s+)?(?:\\*\\*)?(' + LABELS.map((l) => l.replace(/[/]/g, '\\/')).join('|') +
    ')(\\s*\\([^)]*\\))?(?:\\*\\*)?\\s*:\\s*(?:\\*\\*)?\\s*(.*)$',
);

/** Normalise the label spelling variants to one key. */
const CANONICAL: Record<string, string> = {
  Types: 'Type', Behavior: 'Behaviour', Verify: 'Test', 'FDA vs EU': 'Jurisdiction',
  'Relation to FDA/EU': 'Jurisdiction', Note: 'Notes', Default: 'Defaults', 'Process scope': 'Scope',
};

export function parseFields(lines: string[]): Record<string, string> {
  const fields: Record<string, string[]> = {};
  let current: string | undefined;
  let base = 0;
  const push = (key: string, value: string): void => {
    (fields[key] ??= []).push(value);
  };
  for (const line of lines) {
    const m = LABEL_LINE.exec(line);
    const indent = m?.[1]?.length ?? 0;
    if (m && (current === undefined || indent <= base)) {
      let label = CANONICAL[m[2] ?? ''] ?? m[2] ?? '';
      const qualifier = m[3]?.trim();
      let rest = qualifier ? `${qualifier} ${m[4] ?? ''}`.trim() : (m[4] ?? '');
      if (label === 'Edition' && rest.includes('**Type:**')) {
        const [edition, type] = rest.split('**Type:**', 2) as [string, string];
        push('Edition', edition.trim().replace(/\.$/, ''));
        label = 'Type';
        rest = type.trim();
      }
      current = label;
      base = indent;
      push(current, rest);
    } else if (current !== undefined) {
      const lead = line.length - line.trimStart().length;
      push(current, lead >= base + 2 ? line.slice(base + 2) : line.trimStart());
    } else if (line.trim()) {
      push('Notes', line);
    }
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(fields)) out[k] = v.join('\n').trim();
  return out;
}

export function parseCatalog(markdown: string, part: ParsedControl['part']): ParsedControl[] {
  const controls: ParsedControl[] = [];
  let group = '';
  let current: { id: string; title: string; group: string; body: string[] } | undefined;
  const close = (): void => {
    while (current && current.body.length && /^\s*(---+)?\s*$/.test(current.body[current.body.length - 1] ?? '')) current.body.pop();
    if (current) controls.push({ id: current.id, title: current.title, part, group: current.group, fields: parseFields(current.body) });
    current = undefined;
  };
  for (const line of markdown.split('\n')) {
    const c = CONTROL_HEADING.exec(line);
    if (c) {
      close();
      current = { id: c[2] ?? '', title: (c[3] ?? '').trim(), group, body: [] };
      continue;
    }
    const h = HEADING.exec(line);
    if (h && (h[1]?.length ?? 0) <= 3) {
      close();
      if ((h[1]?.length ?? 0) >= 2) group = (h[2] ?? '').trim();
      continue;
    }
    current?.body.push(line);
  }
  close();
  return controls;
}

/** Row numbers (n123) referenced in a Covers field. */
export function coveredRows(covers: string | undefined): number[] {
  return [...(covers ?? '').matchAll(/\bn(\d+)\b/g)].map((m) => Number(m[1]));
}

export type ControlType = 'ENFORCED' | 'CONFIGURABLE' | 'DESIGN_CHOICE';

export function controlTypes(typeField: string | undefined): ControlType[] {
  const t = (typeField ?? '').toUpperCase();
  const out: ControlType[] = [];
  if (t.includes('ENFORCED')) out.push('ENFORCED');
  if (t.includes('CONFIGURABLE')) out.push('CONFIGURABLE');
  if (t.includes('DESIGN-CHOICE') || t.includes('DESIGN CHOICE') || t.includes('DESIGN_CHOICE')) out.push('DESIGN_CHOICE');
  return out;
}

export type Edition = 'tablets' | 'injectables';

export function editionsOf(control: ParsedControl): Edition[] {
  if (control.part === 'C') return ['injectables'];
  const ed = (control.fields['Edition'] ?? '').toLowerCase();
  if (control.part === 'D' && ed) {
    if (ed.includes('tablet') && !ed.includes('inject')) return ['tablets'];
    if (ed.includes('inject') && !ed.includes('tablet')) return ['injectables'];
    return ['tablets', 'injectables'];
  }
  const tagT = /\[T[\],]|\[T\]/.test(control.title);
  const tagI = /\[I[\],]|\[I\]/.test(control.title);
  if (tagT && !tagI) return ['tablets'];
  if (tagI && !tagT) return ['injectables'];
  return ['tablets', 'injectables'];
}
