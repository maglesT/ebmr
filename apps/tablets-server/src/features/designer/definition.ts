/**
 * The execution-definition check of the designer (module C2). Besides the static validator, the author sees what the
 * sandbox import will find when it defines the batch (C3: engine.defineBatch with installation SANDBOX): block
 * configurations outside their schema, cross-field block checks (e.g. a dispensing target without a tolerance, a
 * warning that needs a recorded justification), steps nobody verifies, calculations that do not compile. The same
 * justifications serve both (key `${code}@${subject}`); the test package carries them to the import.
 *
 * A GMP definition refuses the SANDBOX_ONLY block versions (G-09@1, G-10@1) until Phase 3; that is shown as
 * information on those steps, never hidden.
 */
import { engine, type validator } from '@ebmr/recipe-core/pure';
import type { flow , blocks} from '@ebmr/recipe-core/pure';
import { EXPRESSIONS } from './adapters/expressions.ts';
import { tabletsBlockCatalog, tabletsBlockRegistry } from '../edition-blocks.ts';

export const BLOCK_REGISTRY: blocks.BlockRegistry = tabletsBlockRegistry();

const NEEDS_JUSTIFICATION = '; this warning needs a recorded justification';

export interface DefinitionFinding extends Omit<validator.Finding, 'severity'> {
  severity: 'ERROR' | 'WARNING' | 'INFO';
}

function problemsOf(mbr: flow.MbrContent, installation: 'SANDBOX' | 'GMP'): engine.DefinitionProblem[] {
  try {
    engine.defineBatch(mbr, { registry: BLOCK_REGISTRY, catalog: tabletsBlockCatalog, expressions: EXPRESSIONS, installation, justifications: [] });
    return [];
  } catch (error) {
    if (error instanceof engine.EngineDefinitionError) return error.problems;
    return [{ code: 'ENG-DEF-FAILED', severity: 'ERROR', subject: '$', message: `The batch definition could not be checked (${error instanceof Error ? error.message : String(error)})`, controls: ['DI-34'], key: 'ENG-DEF-FAILED@$' }];
  }
}

const finding = (p: engine.DefinitionProblem, severity: DefinitionFinding['severity'], text: string): DefinitionFinding => ({
  rule: p.code,
  controls: [...p.controls],
  severity,
  subject: p.subject,
  message: `${text} (${p.code}; ${p.controls.join(', ') || 'DI-34'})`,
  key: p.key,
});

/**
 * Definition findings, independent of justifications: errors, and warnings as WARNING (the gate decides whether
 * each is justified). Plus INFO for steps a GMP batch would refuse (SANDBOX_ONLY versions).
 */
export function definitionFindings(mbr: flow.MbrContent): DefinitionFinding[] {
  const out: DefinitionFinding[] = [];
  for (const p of problemsOf(mbr, 'SANDBOX')) {
    if (p.message.endsWith(NEEDS_JUSTIFICATION)) out.push(finding(p, 'WARNING', p.message.slice(0, -NEEDS_JUSTIFICATION.length)));
    else out.push(finding(p, 'ERROR', p.message));
  }
  if (!out.some((f) => f.severity === 'ERROR')) {
    for (const p of problemsOf(mbr, 'GMP')) {
      if (p.code === 'ENG-DEF-SANDBOX-ONLY') out.push(finding(p, 'INFO', p.message));
    }
  }
  return out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

export interface CombinedGate {
  passed: boolean;
  errors: number;
  warnings: number;
  unjustifiedWarnings: number;
}

/** Validator gate and definition findings together: zero errors, every warning justified. */
export function combinedGate(report: validator.ValidationReport, definition: readonly DefinitionFinding[], justifications: readonly validator.WarningJustification[]): CombinedGate {
  const justified = new Set(justifications.filter((j) => j.text.trim() !== '' && j.by.trim() !== '').map((j) => j.key));
  const defErrors = definition.filter((f) => f.severity === 'ERROR').length;
  const defWarnings = definition.filter((f) => f.severity === 'WARNING');
  const vWarnings = report.findings.filter((f) => f.severity === 'WARNING');
  const unjustified = [...vWarnings, ...defWarnings].filter((f) => !justified.has(f.key)).length;
  const errors = report.errors + defErrors;
  return { passed: errors === 0 && unjustified === 0, errors, warnings: vWarnings.length + defWarnings.length, unjustifiedWarnings: unjustified };
}
