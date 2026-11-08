/**
 * Test support for the A2 module (flow, validator, limits, simulator): fixture loading, a ready
 * validation context over the real expression language, tree helpers and a minimal MBR builder.
 */
import { readFileSync } from 'node:fs';
import { genericBlockCatalog } from '../../src/flow/blocks.ts';
import { createExprService } from '../../src/flow/expr-adapter.ts';
import { childrenOf, type FlowNode, type MbrContent, type PhaseNode } from '../../src/flow/model.ts';
import { parseMbr } from '../../src/flow/parse.ts';
import type { Rule } from '../../src/validator/rule-kit.ts';
import type { Finding, MarketMinimaPort, ReferenceStatus, RoleVocabularyPort, ValidationContext, ValidationReport } from '../../src/validator/types.ts';
import { RuleRegistry, validateMbr } from '../../src/validator/validate.ts';

export type FixtureName = 'tablet-granulation-compression' | 'tablet-blister-packaging';

const FIXTURES = new URL('../fixtures/', import.meta.url);

export function fixtureJson(name: FixtureName): unknown {
  return JSON.parse(readFileSync(new URL(`${name}.mbr.json`, FIXTURES), 'utf8'));
}

export function loadFixture(name: FixtureName): MbrContent {
  const r = parseMbr(fixtureJson(name));
  if (!r.ok) throw new Error(`fixture ${name} does not parse: ${JSON.stringify(r.problems)}`);
  return r.mbr;
}

/** One shared expression service (it caches compiled programs). */
export const expr = createExprService();

export const noMinima: MarketMinimaPort = { minima: () => [] };

/**
 * The role vocabulary of these tests' installation: the tablets engine roles plus the short roles the test masters
 * use (phase() performs as OPERATOR and checks as VERIFIER). The server supplies the installation's own vocabulary
 * from the database, which refuses to store content naming any other role (sql 0324). Its checker roles (T12.DOC round
 * 4) are the tablets ones as delivered (a witness by PRODUCTION_VERIFIER or QA, a later review by PRODUCTION_VERIFIER;
 * apps/tablets-server test execution/witness-without-printout ties them to the database) plus the short VERIFIER.
 */
export const TEST_ROLES: RoleVocabularyPort = {
  engineRoles: ['PRODUCTION_OPERATOR', 'DISPENSER', 'PRODUCTION_VERIFIER', 'PRODUCTION_SUPERVISOR', 'STAGE_RESPONSIBLE', 'HEAD_OF_PRODUCTION', 'QA', 'QA_REVIEWER', 'OPERATOR', 'VERIFIER', 'SUP', 'SUPERVISOR'],
  checkers: { witness: ['PRODUCTION_VERIFIER', 'QA', 'VERIFIER'], review: ['PRODUCTION_VERIFIER', 'VERIFIER'] },
};

export function context(overrides: Partial<ValidationContext> = {}, statuses: Record<string, ReferenceStatus> = {}): ValidationContext {
  return {
    expressions: expr,
    blocks: genericBlockCatalog,
    references: { status: (r) => statuses[r.id] ?? 'EFFECTIVE' },
    market: noMinima,
    roles: TEST_ROLES,
    asOf: '2026-09-28',
    ...overrides,
  };
}

export function validate(mbr: MbrContent, overrides: Partial<ValidationContext> = {}, registry?: RuleRegistry): ValidationReport {
  return validateMbr(mbr, context(overrides), registry);
}

export function registryOf(...groups: readonly (readonly Rule[])[]): RuleRegistry {
  return new RuleRegistry(groups.flat());
}

export function errors(report: ValidationReport): Finding[] {
  return report.findings.filter((f) => f.severity === 'ERROR');
}

export function rulesOf(findings: readonly Finding[]): string[] {
  return [...new Set(findings.map((f) => f.rule))].sort();
}

export function clone<T>(value: T): T {
  return structuredClone(value);
}

/** Finds a node in the procedure (or a library element body) by id. */
export function findNode(mbr: MbrContent, id: string): FlowNode {
  let found: FlowNode | undefined;
  const visit = (n: FlowNode): void => {
    if (n.id === id) found = n;
    childrenOf(n).forEach(visit);
  };
  visit(mbr.procedure.body);
  for (const e of mbr.library) visit(e.body);
  if (!found) throw new Error(`no node ${id}`);
  return found;
}

export function findPhase(mbr: MbrContent, id: string): PhaseNode {
  const n = findNode(mbr, id);
  if (n.kind !== 'phase') throw new Error(`${id} is a ${n.kind}`);
  return n;
}

/** Removes the node with `id` from whatever sequence holds it. */
export function removeNode(mbr: MbrContent, id: string): void {
  const visit = (n: FlowNode): void => {
    if (n.kind === 'sequence') n.children = n.children.filter((c) => c.id !== id);
    childrenOf(n).forEach(visit);
  };
  visit(mbr.procedure.body);
}

/** A phase with sensible defaults (G-04 parameter record, performer and verifier). */
export function phase(id: string, extra: Partial<PhaseNode> = {}): PhaseNode {
  return {
    kind: 'phase',
    id,
    name: `Step ${id}`,
    block: { type: 'G-04', version: '1' },
    config: {},
    records: [],
    computes: [],
    reads: [],
    consumes: [],
    produces: [],
    uses: [],
    equipment: [],
    signatures: { perform: { role: 'OPERATOR' }, check: { meaning: 'VERIFIED', role: 'VERIFIER' } },
    significant: false,
    riskClass: 'LOW',
    ...extra,
  };
}

/** An operation-level body wrapped in procedure -> stage -> operation, with empty item lists. */
export function mbrWith(operationBody: FlowNode, extra: Partial<MbrContent> = {}): MbrContent {
  return {
    format: 'ebmr.mbr-content',
    formatVersion: 1,
    header: {
      family: 'TEST',
      title: 'Test MBR',
      edition: 'tablets',
      recordKind: 'PROCESSING',
      product: { code: 'P', name: 'Product', strength: '1 mg', dosageForm: 'Tablet' },
      batchSizes: [{ id: 'BS', quantity: { value: '1', unit: 'kg' } }],
      marketSet: ['IN'],
      predicates: {},
      variants: [],
    },
    riskScale: { ref: 'RSK', classes: ['LOW', 'HIGH'] },
    references: [{ id: 'RSK', kind: 'RISK_SCALE', code: 'RSK', version: '1', hash: 'a'.repeat(64) }],
    library: [],
    inputs: [],
    bom: [],
    intermediates: [],
    parameters: [],
    calculations: [],
    yieldCheckpoints: [],
    acceptanceSchemes: [],
    timeConstraints: [],
    riskReductions: [],
    goldenCases: [],
    procedure: {
      id: 'PROC',
      name: 'Procedure',
      body: {
        kind: 'sequence',
        id: 'proc-seq',
        children: [
          {
            kind: 'stage',
            id: 'S',
            name: 'Stage',
            binding: { rooms: [], equipment: [] },
            purpose: 'NON_MATERIAL',
            responsibleRole: 'HEAD_OF_PRODUCTION',
            body: { kind: 'operation', id: 'O', name: 'Operation', body: operationBody },
          },
        ],
      },
    },
    ...extra,
  };
}

/** A process-endpoint parameter for loop tests. */
export function endpoint(id: string, role: 'PROCESS_ENDPOINT' | 'ACCEPTANCE_TEST' = 'PROCESS_ENDPOINT'): MbrContent['parameters'][number] {
  return {
    id,
    name: `Endpoint ${id}`,
    valueType: 'DECIMAL',
    unit: '%',
    precision: { kind: 'DECIMALS', digits: 1 },
    role,
    criticality: 'CRITICAL',
    riskClass: 'HIGH',
    capture: 'DEVICE',
    limits: { unit: '%', ranges: [{ tier: 'VALIDATED', low: { value: '0.0', inclusive: true }, high: { value: '5.0', inclusive: true }, rounding: 'USP_HALF_UP_AT_LIMIT_DECIMALS', source: { kind: 'VALIDATION_REPORT', ref: 'VR' } }] },
  };
}

/**
 * The content with every operation dissolved into its parent, its body in its place (R-flow item 1, ADR 0004 decision 1
 * amended: the operation level is optional).
 */
export function withoutOperations(mbr: MbrContent): MbrContent {
  const out = clone(mbr);
  const lift = (n: FlowNode): FlowNode => (n.kind === 'operation' ? lift(n.body) : n);
  const visit = (n: FlowNode): void => {
    if (n.kind === 'sequence') n.children = n.children.map(lift);
    if (n.kind === 'stage' || n.kind === 'loop' || n.kind === 'operation') n.body = lift(n.body);
    if (n.kind === 'parallel' || n.kind === 'alternative') for (const b of n.branches) if (b.body) b.body = lift(b.body);
    childrenOf(n).forEach(visit);
  };
  visit(out.procedure.body);
  return out;
}
