/**
 * Where a validator finding belongs in the document view (module C2): the document section (0-11), the path of the
 * subject in the content, and the procedure node to jump to. Pure; the web shows findings grouped by these sections
 * and jumps to the node (plan section 8).
 *
 * Sections of the document-first view (a paper batch record's order):
 *   0 Title and signatures           6 Parameters and limits (and acceptance schemes)
 *   1 Product, batch sizes, inputs   7 Calculations
 *   2 Markets and variants           8 Procedure (stage -> operation -> step)
 *   3 References                     9 Hold times and time constraints
 *   4 Bill of materials             10 Yields and reconciliation
 *   5 Equipment and rooms           11 Risk and verification (risk scale, reductions, golden cases)
 */
import type { FindingView, JustificationView } from '@ebmr/api-contract';
import { flow, type validator } from '@ebmr/recipe-core/pure';

export const DOCUMENT_SECTIONS: readonly { id: string; title: string }[] = [
  { id: '0', title: 'Title and signatures' },
  { id: '1', title: 'Product, batch sizes and header inputs' },
  { id: '2', title: 'Markets and variants' },
  { id: '3', title: 'References' },
  { id: '4', title: 'Bill of materials' },
  { id: '5', title: 'Equipment and rooms' },
  { id: '6', title: 'Parameters and limits' },
  { id: '7', title: 'Calculations' },
  { id: '8', title: 'Procedure' },
  { id: '9', title: 'Hold times and time constraints' },
  { id: '10', title: 'Yields and reconciliation' },
  { id: '11', title: 'Risk and verification' },
];

export interface FindingLocation {
  section: string;
  subjectPath: string[];
  nodeId: string | null;
}

/** Ancestor chains of every tree node (procedure body and embedded library elements). */
function nodePaths(content: flow.MbrContent): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const visit = (n: flow.FlowNode, trail: string[]): void => {
    const here = [...trail, n.id];
    if (!out.has(n.id)) out.set(n.id, here);
    for (const c of flow.childrenOf(n)) visit(c, here);
  };
  visit(content.procedure.body, ['procedure']);
  for (const e of content.library) visit(e.body, ['library', e.ref]);
  return out;
}

const RULE_SECTION_FOR_RECORD: Readonly<Record<string, string>> = {
  'GMP-HEADER': '1',
  'MKT-MINIMA': '2',
  'GMP-RISK': '11',
  'FLOW-LEVELS': '8',
  'GRAPH-START-END': '8',
  'TIME-CONSISTENT': '9',
};

/** The location of a finding in the content. */
export function locateFinding(content: flow.MbrContent, finding: Pick<validator.Finding, 'rule' | 'subject'>, paths = nodePaths(content)): FindingLocation {
  const s = finding.subject;
  if (s === '$') {
    const section = RULE_SECTION_FOR_RECORD[finding.rule] ?? (finding.rule.startsWith('TIME-') ? '9' : finding.rule.startsWith('FLOW-') || finding.rule.startsWith('GRAPH-') ? '8' : '0');
    return { section, subjectPath: [], nodeId: null };
  }
  const node = paths.get(s);
  if (node) return { section: '8', subjectPath: node, nodeId: node[0] === 'procedure' ? s : null };
  const lists: [string, string, readonly { id: string }[]][] = [
    ['6', 'parameters', content.parameters],
    ['7', 'calculations', content.calculations],
    ['4', 'bom', content.bom],
    ['3', 'references', content.references],
    ['9', 'intermediates', content.intermediates],
    ['9', 'timeConstraints', content.timeConstraints],
    ['10', 'yieldCheckpoints', content.yieldCheckpoints],
    ['6', 'acceptanceSchemes', content.acceptanceSchemes],
    ['11', 'riskReductions', content.riskReductions],
    ['11', 'goldenCases', content.goldenCases],
    ['1', 'inputs', content.inputs],
    ['1', 'batchSizes', content.header.batchSizes],
    ['2', 'variants', content.header.variants],
  ];
  for (const [section, list, items] of lists) if (items.some((i) => i.id === s)) return { section, subjectPath: [list, s], nodeId: null };
  return { section: '0', subjectPath: [s], nodeId: null };
}

/** The section of a parse problem, from the first member of its JSON path (e.g. "$.procedure.body..."). */
export function sectionOfPath(path: string): string {
  const first = /^\$\.?([A-Za-z]+)/.exec(path)?.[1] ?? '';
  const map: Record<string, string> = {
    header: '1',
    riskScale: '11',
    references: '3',
    library: '8',
    inputs: '1',
    bom: '4',
    intermediates: '9',
    parameters: '6',
    calculations: '7',
    yieldCheckpoints: '10',
    acceptanceSchemes: '6',
    timeConstraints: '9',
    riskReductions: '11',
    goldenCases: '11',
    procedure: '8',
  };
  return map[first] ?? '0';
}

/** A finding of the validator or of the definition check. */
export interface AnyFinding {
  key: string;
  rule: string;
  severity: 'ERROR' | 'WARNING' | 'INFO';
  controls: readonly string[];
  subject: string;
  message: string;
}

/** Findings as views, with their location and the justification in force for warnings (latest per key). */
export function findingViews(content: flow.MbrContent, findings: readonly AnyFinding[], justifications: ReadonlyMap<string, JustificationView>): FindingView[] {
  const paths = nodePaths(content);
  return findings.map((f) => {
    const loc = locateFinding(content, f, paths);
    return {
      key: f.key,
      rule: f.rule,
      severity: f.severity,
      controls: [...f.controls],
      section: loc.section,
      subjectPath: loc.subjectPath,
      nodeId: loc.nodeId,
      message: f.message,
      justification: f.severity === 'WARNING' ? (justifications.get(f.key) ?? null) : null,
    };
  });
}
