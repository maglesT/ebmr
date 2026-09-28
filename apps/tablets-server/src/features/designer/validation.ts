/**
 * The designer's validation (module C2; decision D10: on the server in A1): the static validator with the real
 * reference and market adapters, plus the execution-definition check, gated together (zero errors, every warning
 * justified). No writes. The report stays bound to the content hash (DI-04).
 */
import type pg from 'pg';
import { canonicalJson, sha256Hex } from '@ebmr/expr';
import type { ValidationReportView } from '@ebmr/api-contract';
import { flow, validator } from '@ebmr/recipe-core/pure';
import type { AppContext } from '../../platform/context.ts';
import { loadValidationContext, type LoadedContext } from './adapters/expressions.ts';
import { combinedGate, definitionFindings, type CombinedGate, type DefinitionFinding } from './definition.ts';
import { findingViews, sectionOfPath, type AnyFinding } from './findings.ts';
import { nowInstant } from './views.ts';
import type { JustificationView } from './wire.ts';

type Db = pg.Pool | pg.PoolClient;

export interface DesignerAnalysis {
  mbr: flow.MbrContent;
  loaded: LoadedContext;
  report: validator.ValidationReport;
  definition: DefinitionFinding[];
  gate: CombinedGate;
  findings: AnyFinding[];
}

/** Validator and definition check of parsed content, with the justifications in force. */
export async function analyse(db: Db, mbr: flow.MbrContent, justifications: readonly validator.WarningJustification[]): Promise<DesignerAnalysis> {
  const loaded = await loadValidationContext(db, mbr);
  const report = validator.validateMbr(mbr, loaded.context);
  const definition = definitionFindings(mbr);
  return { mbr, loaded, report, definition, gate: combinedGate(report, definition, justifications), findings: [...report.findings, ...definition] };
}

/** The view of an analysis. */
export async function reportView(db: Db, app: AppContext, a: DesignerAnalysis, justifications: ReadonlyMap<string, JustificationView>): Promise<ValidationReportView> {
  return {
    contentHash: a.report.contentHash,
    validatedAt: await nowInstant(db, app),
    gate: { passed: a.gate.passed, errors: a.gate.errors, warnings: a.gate.warnings, unjustifiedWarnings: a.gate.unjustifiedWarnings },
    findings: findingViews(a.mbr, a.findings, justifications),
  };
}

/** Content that does not parse: every problem as an error at its place (the gate fails; nothing is validated further). */
export async function parseFailureView(db: Db, app: AppContext, content: unknown, problems: readonly flow.ParseProblem[]): Promise<ValidationReportView> {
  return {
    contentHash: sha256Hex(canonicalJson(content)),
    validatedAt: await nowInstant(db, app),
    gate: { passed: false, errors: problems.length, warnings: 0, unjustifiedWarnings: 0 },
    findings: problems.map((p, i) => ({
      key: `FLOW-PARSE@${p.path || `$${i}`}`,
      rule: 'FLOW-PARSE',
      severity: 'ERROR' as const,
      controls: ['PR-03'],
      section: sectionOfPath(p.path),
      subjectPath: [p.path],
      nodeId: null,
      message: `${p.message} at ${p.path} (FLOW-PARSE; PR-03)`,
      justification: null,
    })),
  };
}
