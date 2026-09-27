/**
 * Validates the control register: JSON schema, unique IDs, the expected ID set, and that every
 * requirement row a control cites exists.
 */
import { readFileSync } from 'node:fs';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { loadControls, loadRequirements, SCHEMA_FILE, type ControlRecord } from './register.ts';

export const EXPECTED_COUNTS = { DI: 50, PR: 60, ST: 79, IN: 52 } as const;

export function validateRegister(controls: ControlRecord[] = loadControls(), rows = loadRequirements()): string[] {
  const errors: string[] = [];
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  const validate = ajv.compile(JSON.parse(readFileSync(SCHEMA_FILE, 'utf8')) as object);
  for (const c of controls) {
    const candidate: unknown = c;
    if (!validate(candidate)) {
      for (const e of validate.errors ?? []) errors.push(`${String(c.id)}: ${e.instancePath || '/'} ${e.message ?? ''}`);
    }
  }
  const seen = new Set<string>();
  for (const c of controls) {
    if (seen.has(c.id)) errors.push(`duplicate control id ${c.id}`);
    seen.add(c.id);
  }
  for (const [prefix, count] of Object.entries(EXPECTED_COUNTS)) {
    for (let i = 1; i <= count; i++) {
      const id = `${prefix}-${String(i).padStart(2, '0')}`;
      if (!seen.has(id)) errors.push(`missing control ${id}`);
    }
  }
  const rowNumbers = new Set(rows.map((r) => r.n));
  for (const c of controls) {
    for (const n of c.requirement_rows) if (!rowNumbers.has(n)) errors.push(`${c.id}: cites unknown requirement row n${n}`);
    if (c.expert_decision.status === 'MODIFY' && !c.expert_decision.comment) errors.push(`${c.id}: MODIFY decision needs a comment`);
  }
  return errors;
}
