/**
 * Validates the control register: JSON schema, unique IDs, the expected ID set, that every requirement row a
 * control cites exists, that every test a control lists exists in the file it names (review F15), and that a
 * control's clauses are its catalog test word for word, each proven by listed tests or deferred to a later phase
 * (review F14). Whether the listed tests ran and passed is the trace's check (trace.ts), after the tests have run.
 */
import { readFileSync } from 'node:fs';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { loadControls, loadRequirements, ROOT, SCHEMA_FILE, type ControlRecord } from './register.ts';
import { missingListedTests, type DeclaredTest } from './test-index.ts';
import { firstUnsorted } from './sync.ts';

export const EXPECTED_COUNTS = { DI: 53, PR: 61, ST: 79, IN: 53 } as const;

/** Text compared word for word: runs of white space count as one space. */
export const words = (s: string): string => s.replace(/\s+/g, ' ').trim();

/** The problems with a control's clauses and deferred scope (review F14). */
export function clauseErrors(c: ControlRecord): string[] {
  const errors: string[] = [];
  for (const d of c.deferred_scope ?? []) {
    if (d.phase <= c.target_phase) errors.push(`${c.id}: deferred scope "${d.scope}" is deferred to phase ${d.phase}, not after the control's target phase ${c.target_phase}`);
  }
  const clauses = c.clauses ?? [];
  if (c.clauses && words(clauses.map((k) => k.clause).join(' ')) !== words(c.catalog_test)) {
    errors.push(`${c.id}: the clauses are not its catalog test word for word, in order (no clause may be left out or reworded)`);
  }
  const listed = new Set(c.tests);
  clauses.forEach((k, i) => {
    for (const t of k.tests ?? []) if (!listed.has(t)) errors.push(`${c.id}: clause ${i + 1} names a test that is not in its tests list: "${t}"`);
    if (k.deferred && k.deferred.phase <= c.target_phase) {
      errors.push(`${c.id}: clause ${i + 1} is deferred to phase ${k.deferred.phase}, not after the control's target phase ${c.target_phase}`);
    }
  });
  const deferred = clauses.filter((k) => k.deferred).length + (c.deferred_scope?.length ?? 0);
  if (deferred > 0 && c.build_status !== 'SPECIFIED') {
    errors.push(`${c.id}: build_status ${c.build_status} while ${deferred} part(s) of it (catalog-test clauses or scope) are deferred to a later phase`);
  }
  return errors;
}

export function validateRegister(controls: ControlRecord[] = loadControls(), rows = loadRequirements(), root = ROOT): string[] {
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
  const declared = new Map<string, DeclaredTest[] | null>();
  for (const c of controls) {
    for (const n of c.requirement_rows) if (!rowNumbers.has(n)) errors.push(`${c.id}: cites unknown requirement row n${n}`);
    if (c.expert_decision.status === 'MODIFY' && !c.expert_decision.comment) errors.push(`${c.id}: MODIFY decision needs a comment`);
    const unsorted = Array.isArray(c.tests) ? firstUnsorted(c.tests) : -1;
    if (unsorted >= 0) errors.push(`${c.id}: its tests list is not sorted at entry ${unsorted + 1} ("${c.tests[unsorted]}"); run pnpm register:sort-tests`);
    for (const m of missingListedTests(c.tests, root, declared)) errors.push(`${c.id}: lists a test that does not exist (${m.reason}): "${m.entry}"`);
    errors.push(...clauseErrors(c));
  }
  return errors;
}
