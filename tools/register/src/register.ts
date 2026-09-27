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

export function currentPhase(file = PHASE_FILE): number {
  const doc = YAML.parse(readFileSync(file, 'utf8')) as { current_phase: number };
  return doc.current_phase;
}
