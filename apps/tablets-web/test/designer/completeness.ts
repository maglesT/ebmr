/**
 * Completeness of the designer document (review F44): walks every member of parsed MBR content and says where in the
 * rendered document its value must appear, and in what words. A leaf is a string, number or boolean of the content
 * (and the member names of its free maps: market predicates, golden-case values, library-call bindings, step
 * configuration). Each leaf is looked for in its own place: a listed item in its element `mbr-item-<id>`, a procedure
 * node in the elements carrying `data-node="<id>"` (its row and, for a stage, its section 5 block), the header in
 * sections 0 to 2. The expected words are written here independently of the component, so the test does not repeat
 * the code it checks.
 *
 * Not checked, by design: `kind` of a procedure node (the row type says it), the ids of procedure nodes and branches
 * (they address rows; the document names steps by number and name) and sequences (the document order is the sequence).
 */
import type { flow } from '@ebmr/recipe-core/pure';

/** Which part of the content a leaf belongs to; each fix of the review covers its own parts. */
export type Area = 'record' | 'step' | 'config' | 'construct' | 'library';

export interface Leaf {
  area: Area;
  path: string;
  /** CSS selector of the place(s) whose text must hold the value. */
  scope: string;
  /** Any of these, compared case-insensitively on whitespace-normalised text. */
  any: readonly (string | RegExp)[];
}

const ROUNDING: Readonly<Record<string, string>> = { USP_HALF_UP_AT_LIMIT_DECIMALS: 'USP, half up at the limit decimals', PH_EUR_SIG_FIGS: 'Ph. Eur., significant figures' };

const COMPARISON = { low: { true: 'at least', false: 'more than' }, high: { true: 'at most', false: 'less than' } } as const;

const BOOLEAN_WORDS: Readonly<Record<string, { true: RegExp; false: RegExp }>> = {
  significant: { true: /significant step/i, false: /not significant/i },
  destructive: { true: /(?<!not )destructive/i, false: /not destructive/i },
  finalOutput: { true: /(?<!not a )final output/i, false: /not a final output/i },
  otherwise: { true: /otherwise/i, false: /otherwise/i },
  reasonRequired: { true: /with a reason/i, false: /without a reason/i },
};

/** Members whose keys are data (free maps): each key must appear too. */
const FREE_MAPS = new Set(['predicates', 'inputs', 'expected', 'config', 'bind']);

const NODE_KINDS = new Set(['stage', 'operation', 'phase', 'sequence', 'parallel', 'alternative', 'loop', 'replicate', 'holdPoint', 'libraryCall']);

function stringForms(s: string): string[] {
  return [s, s.toLowerCase().replace(/_/g, ' '), s.toLowerCase().replace(/_/g, '-')];
}

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

const isNode = (v: unknown): v is flow.FlowNode => isObject(v) && typeof v['kind'] === 'string' && NODE_KINDS.has(v['kind']) && typeof v['id'] === 'string';

function areaOfNode(n: flow.FlowNode): Area {
  if (n.kind === 'stage' || n.kind === 'operation' || n.kind === 'phase' || n.kind === 'holdPoint' || n.kind === 'sequence') return 'step';
  if (n.kind === 'libraryCall') return 'library';
  return 'construct';
}

/** Every leaf of the content with the place and words it must have in the document. */
export function documentLeaves(c: flow.MbrContent): Leaf[] {
  const out: Leaf[] = [];
  const push = (area: Area, path: string, scope: string, any: readonly (string | RegExp)[]): void => {
    out.push({ area, path, scope, any });
  };

  const visit = (v: unknown, path: string, key: string, area: Area, scope: string, parentKey: string): void => {
    if (typeof v === 'string') {
      if (key === 'rounding') push(area, path, scope, [ROUNDING[v] ?? v]);
      else push(area, path, scope, stringForms(v));
      return;
    }
    if (typeof v === 'number') {
      push(area, path, scope, [String(v)]);
      return;
    }
    if (typeof v === 'boolean') {
      const words = BOOLEAN_WORDS[key];
      if (words) push(area, path, scope, [v ? words.true : words.false]);
      else if (parentKey === 'predicates' || key === 'bool') push(area, path, scope, [v ? 'yes' : 'no']);
      else throw new Error(`completeness: no words for the boolean ${path}`);
      return;
    }
    if (Array.isArray(v)) {
      v.forEach((x, i) => {
        visit(x, `${path}[${i}]`, key, area, scope, parentKey);
      });
      return;
    }
    if (!isObject(v)) return;
    if (isNode(v)) {
      visitNode(v, path, area === 'library' ? 'library' : areaOfNode(v), area === 'library' ? '#mbr-section-8' : `[data-node="${v.id}"]`);
      return;
    }
    // A limit bound: its comparison in words with the value as written.
    if ((key === 'low' || key === 'high') && typeof v['value'] === 'string' && typeof v['inclusive'] === 'boolean') {
      push(area, path, scope, [`${COMPARISON[key][v['inclusive'] ? 'true' : 'false']} ${v['value']}`]);
      return;
    }
    const inner: Area = key === 'config' && area === 'step' ? 'config' : area;
    for (const [k, x] of Object.entries(v)) {
      // The member names of a free map are data; inside a step's configuration every member name is.
      if (FREE_MAPS.has(key) || inner === 'config') push(inner, `${path}.${k} (name)`, scope, [k]);
      visit(x, `${path}.${k}`, k, inner, scope, key);
    }
  };

  const visitNode = (n: flow.FlowNode, path: string, area: Area, scope: string): void => {
    for (const [k, x] of Object.entries(n)) {
      if (k === 'kind' || k === 'id' || k === 'children' || k === 'body') continue;
      if (k === 'branches' && Array.isArray(x)) {
        x.forEach((b: Record<string, unknown>, i) => {
          for (const [bk, bx] of Object.entries(b)) {
            if (bk === 'id' || bk === 'body') continue;
            visit(bx, `${path}.branches[${i}].${bk}`, bk, area, scope, 'branches');
          }
        });
        continue;
      }
      visit(x, `${path}.${k}`, k, area, scope, '');
    }
    const childArea = (child: flow.FlowNode): Area => (area === 'library' ? 'library' : areaOfNode(child));
    const childScope = (child: flow.FlowNode): string => (area === 'library' ? '#mbr-section-8' : `[data-node="${child.id}"]`);
    const kids: flow.FlowNode[] =
      n.kind === 'sequence' ? n.children : n.kind === 'parallel' ? n.branches.map((b) => b.body) : n.kind === 'alternative' ? n.branches.flatMap((b) => (b.body ? [b.body] : [])) : 'body' in n ? [n.body] : [];
    kids.forEach((child, i) => {
      visitNode(child, `${path}/${child.id || i}`, childArea(child), childScope(child));
    });
  };

  const item = (id: string): string => `[id="mbr-item-${id}"]`;
  visit(c.format, '$.format', 'format', 'record', '#mbr-section-0', '');
  visit(c.formatVersion, '$.formatVersion', 'formatVersion', 'record', '#mbr-section-0', '');
  for (const [k, x] of Object.entries(c.header)) {
    if (k === 'batchSizes' || k === 'variants') {
      (x as { id: string }[]).forEach((b, i) => {
        visit(b, `$.header.${k}[${i}]`, `${k}[]`, 'record', item(b.id), '');
      });
    } else visit(x, `$.header.${k}`, k, 'record', '#mbr-section-0, #mbr-section-1, #mbr-section-2', 'header');
  }
  visit(c.riskScale, '$.riskScale', 'riskScale', 'record', '#mbr-section-11', '');
  const lists = ['references', 'inputs', 'bom', 'intermediates', 'parameters', 'calculations', 'yieldCheckpoints', 'acceptanceSchemes', 'timeConstraints', 'riskReductions', 'goldenCases'] as const;
  for (const list of lists) {
    (c[list] as { id: string }[]).forEach((x, i) => {
      visit(x, `$.${list}[${i}]`, `${list}[]`, 'record', item(x.id), '');
    });
  }
  visit(c.procedure.id, '$.procedure.id', 'id', 'record', '#mbr-section-8', '');
  visit(c.procedure.name, '$.procedure.name', 'name', 'record', '#mbr-section-8', '');
  visitNode(c.procedure.body, '$.procedure.body', areaOfNode(c.procedure.body), `[data-node="${c.procedure.body.id}"]`);
  c.library.forEach((e, i) => {
    visit(e.ref, `$.library[${i}].ref`, 'ref', 'library', '#mbr-section-8', '');
    visit(e.level, `$.library[${i}].level`, 'level', 'library', '#mbr-section-8', '');
    visit(e.symbols, `$.library[${i}].symbols`, 'symbols', 'library', '#mbr-section-8', '');
    visitNode(e.body, `$.library[${i}].body`, 'library', '#mbr-section-8');
  });
  return out;
}

const norm = (s: string): string => s.replace(/\s+/g, ' ').trim();

/** The leaves of the given areas that are not in their place in the rendered document, as readable lines. */
export function missingLeaves(container: HTMLElement, leaves: readonly Leaf[], areas: readonly Area[]): string[] {
  const texts = new Map<string, string | null>();
  const textOf = (scope: string): string | null => {
    if (!texts.has(scope)) {
      const els = [...container.querySelectorAll(scope)];
      texts.set(scope, els.length === 0 ? null : norm(els.map((e) => e.textContent ?? '').join(' | ')));
    }
    return texts.get(scope) ?? null;
  };
  const out: string[] = [];
  for (const l of leaves) {
    if (!areas.includes(l.area)) continue;
    const t = textOf(l.scope);
    if (t === null) {
      out.push(`${l.path}: no element ${l.scope}`);
      continue;
    }
    const lower = t.toLowerCase();
    const found = l.any.some((a) => (typeof a === 'string' ? lower.includes(norm(a).toLowerCase()) : a.test(t)));
    if (!found) out.push(`${l.path}: none of ${JSON.stringify(l.any.map(String))} in ${l.scope}`);
  }
  return out;
}
