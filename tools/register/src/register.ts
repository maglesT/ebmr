/**
 * The control register as data (build outline 3.1, ADR 0009).
 *
 * compliance/controls/<ID>.yaml   one file per control (241 today)
 * compliance/requirements/requirements.jsonl   678 clause-level rows (n-numbers)
 * compliance/phase.yaml           the phase the repository is currently in
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import YAML from 'yaml';

export const ROOT = new URL('../../../', import.meta.url).pathname;
export const CONTROLS_DIR = join(ROOT, 'compliance/controls');
export const REQUIREMENTS_FILE = join(ROOT, 'compliance/requirements/requirements.jsonl');
export const SCHEMA_FILE = join(ROOT, 'compliance/schema/control.schema.json');
export const PHASE_FILE = join(ROOT, 'compliance/phase.yaml');

export type ExpertStatus = 'PENDING' | 'FOLLOW' | 'DONT_FOLLOW' | 'MODIFY';

/**
 * One clause of a control's catalog test (review F14): its words, in order, and either the listed tests that prove
 * it or the later phase it is deferred to, with the reason. The clauses of a control are its catalog_test, word for
 * word (validate.ts), so no clause can be left out; the trace refuses a due control whose clause has no passing test
 * and no deferral, and a deferral whose phase has started (trace.ts).
 */
export interface ClauseRecord {
  clause: string;
  tests?: string[];
  deferred?: { phase: number; reason: string };
}

/** A part of a control's behaviour beyond its catalog test that a later phase builds (e.g. DI-33 reprocessing). */
export interface DeferredScope {
  scope: string;
  phase: number;
  reason: string;
}

export interface ControlRecord {
  id: string;
  title: string;
  part: 'A' | 'B' | 'C' | 'D';
  group: string;
  editions: ('tablets' | 'injectables')[];
  type: ('ENFORCED' | 'CONFIGURABLE' | 'DESIGN_CHOICE')[];
  target_phase: number;
  target_phase_source: 'outline' | 'default';
  requirement_rows: number[];
  sources: string;
  behaviour: string;
  jurisdiction?: string;
  catalog_test: string;
  scope?: string;
  type_detail?: string;
  notes?: string;
  implemented_by: Record<string, string[]>;
  tests: string[];
  clauses?: ClauseRecord[];
  deferred_scope?: DeferredScope[];
  proposed_modify?: string;
  expert_decision: { status: ExpertStatus; pack_version: string; reviewer?: string; date?: string; comment?: string };
  build_status: 'SPECIFIED' | 'IMPLEMENTED' | 'VERIFIED';
}

export interface RequirementRow {
  n: number;
  rid: string;
  source: string;
  clause: string;
  jurisdiction: string;
  verified: 'primary' | 'secondary' | 'unverified';
  requirement: string;
}

export function loadControls(dir = CONTROLS_DIR): ControlRecord[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.yaml'))
    .sort()
    .map((f) => YAML.parse(readFileSync(join(dir, f), 'utf8')) as ControlRecord);
}

export function loadRequirements(file = REQUIREMENTS_FILE): RequirementRow[] {
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as RequirementRow);
}

export type EditionName = ControlRecord['editions'][number];
const EDITIONS: readonly EditionName[] = ['tablets', 'injectables'];

interface PhaseDoc {
  current_phase: number;
  editions?: unknown;
}

const readPhaseDoc = (file: string): PhaseDoc => YAML.parse(readFileSync(file, 'utf8')) as PhaseDoc;

export function currentPhase(file = PHASE_FILE): number {
  return readPhaseDoc(file).current_phase;
}

/**
 * The editions the trace gate covers (decision 0010): `editions` in phase.yaml, or both editions when it is absent. A
 * control is due only when one of its editions is in this list, so injectables-only controls stay out of the gate while
 * that edition is deferred; a control shared by both editions is always due. An empty list or an unknown edition is
 * refused, so a typo cannot switch the gate off.
 */
export function gateEditions(file = PHASE_FILE): EditionName[] {
  const listed = readPhaseDoc(file).editions;
  if (listed === undefined) return [...EDITIONS];
  if (!Array.isArray(listed) || listed.length === 0) throw new Error(`${file}: editions must be a non-empty list of ${EDITIONS.join(', ')}`);
  for (const e of listed) if (!EDITIONS.includes(e as EditionName)) throw new Error(`${file}: unknown edition ${String(e)} (known: ${EDITIONS.join(', ')})`);
  return [...new Set(listed as EditionName[])];
}

/** Whether a control belongs to an edition the gate covers (decision 0010). */
export const inGateEditions = (c: Pick<ControlRecord, 'editions'>, editions: readonly EditionName[]): boolean => c.editions.some((e) => editions.includes(e));
