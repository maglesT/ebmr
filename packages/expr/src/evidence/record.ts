/**
 * Evaluation with evidence (DI-33; ADR 0005 decision 8; INV-25).
 *
 * evaluate() returns an immutable EvaluationRecord: expression text and canonical form, language
 * version, program hash, every input read (value, unit, tag, source reference, or the hash of the
 * record that computed it), every unit conversion with its exact factor, every acceptance-table
 * lookup, the full-precision output and a content hash.
 *
 * verifyEvaluationRecord() recomputes a record from its recorded inputs: a stored derived value that
 * was typed or altered does not verify (INV-25: derived values are computed, never typed).
 * recalculate() produces the result after an input correction as a NEW record that names the
 * record it supersedes, the reason and each corrected input; the earlier record is never changed,
 * so both results are kept with their reasons (DI-33 catalog test). Where it is stored, who
 * verifies and signs it, and which SOP cases allow a recalculation are the engine's (Phase 3).
 */
import { UNIT_TABLE } from '../units/unit-table.generated.ts';
import { EVALUATION_RECORD_SCHEMA, EXPR_LANGUAGE_VERSION } from '../version.ts';
import type { CompiledExpression } from '../lang/compile.ts';
import { ExprEvaluationError } from '../lang/errors.ts';
import { recordHashValid, runProgram, type EvaluationOutcome, type InputValue, type InputValues } from '../lang/evaluator.ts';
import type { AcceptanceTableCatalog } from '../library/acceptance-tables.ts';
import { canonicalJson, contentHashOf } from './hash.ts';
import type { EvaluationRecord, RecordedCorrection, RecordedInput, RecordedOutput, Supersedes } from './record-types.ts';

export interface EvaluateOptions {
  /** Acceptance tables for table_lookup() (the versions must match those the program was checked with). */
  readonly tables?: AcceptanceTableCatalog;
}

export type EvaluationResult = { ok: true; record: EvaluationRecord } | { ok: false; error: ExprEvaluationError };

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}

function recordedOutput(outcome: EvaluationOutcome): RecordedOutput {
  const v = outcome.value;
  if (v.kind === 'boolean') return { kind: 'boolean', value: v.value ? 'true' : 'false' };
  return { kind: 'quantity', value: v.value.toString(), unit: v.unit.code, tag: v.tag ?? 'none' };
}

function buildRecord(program: CompiledExpression, outcome: EvaluationOutcome, supersedes?: Supersedes): EvaluationRecord {
  const body: Omit<EvaluationRecord, 'contentHash'> = {
    schema: EVALUATION_RECORD_SCHEMA,
    languageVersion: program.languageVersion,
    unitTable: { version: UNIT_TABLE.tableVersion, ucumLhc: UNIT_TABLE.ucumLhcVersion },
    ...(program.name === undefined ? {} : { calculation: program.name }),
    expression: program.source,
    canonical: program.canonical,
    programHash: program.programHash,
    inputs: outcome.inputs,
    conversions: outcome.conversions,
    tableLookups: outcome.tableLookups,
    output: recordedOutput(outcome),
    ...(supersedes === undefined ? {} : { supersedes }),
  };
  // Round-trip through JSON so the record is plain data (no class instances) before hashing.
  const plain = JSON.parse(JSON.stringify(body)) as Omit<EvaluationRecord, 'contentHash'>;
  return deepFreeze({ ...plain, contentHash: contentHashOf(plain) });
}

/** Evaluates a compiled expression and returns its evidence record. Throws ExprEvaluationError. */
export function evaluate(program: CompiledExpression, inputs: InputValues, options: EvaluateOptions = {}): EvaluationRecord {
  if (program.languageVersion !== EXPR_LANGUAGE_VERSION) {
    throw new Error(`the program was compiled by expression-language ${program.languageVersion}; this is ${EXPR_LANGUAGE_VERSION} (use the versioned handler, ADR 0010)`);
  }
  return buildRecord(program, runProgram(program.core, inputs, options.tables ?? {}));
}

/** Like evaluate(), but returns evaluation errors as data. */
export function tryEvaluate(program: CompiledExpression, inputs: InputValues, options: EvaluateOptions = {}): EvaluationResult {
  try {
    return { ok: true, record: evaluate(program, inputs, options) };
  } catch (e) {
    if (e instanceof ExprEvaluationError) return { ok: false, error: e };
    throw e;
  }
}

/** Input values rebuilt from a record's recorded inputs (derived inputs need their records). */
export function inputsFromRecord(record: EvaluationRecord, derived: Readonly<Record<string, EvaluationRecord>> = {}): InputValues {
  const out: Record<string, InputValue> = {};
  for (const i of record.inputs) {
    if (i.derivedFrom !== undefined) {
      const d = derived[i.derivedFrom];
      if (d !== undefined) out[i.path] = { derived: d };
      continue;
    }
    const tag = i.tag === undefined ? {} : { tag: i.tag };
    const unit = i.unit === undefined ? {} : { unit: i.unit };
    switch (i.kind) {
      case 'quantity':
        out[i.path] = { value: i.value ?? '', ...unit, ...tag, source: i.source };
        break;
      case 'series':
        out[i.path] = { values: i.values ?? [], ...unit, ...tag, source: i.source };
        break;
      case 'instant':
        out[i.path] = { instant: i.value ?? '', source: i.source };
        break;
      case 'boolean':
        out[i.path] = { boolean: i.value === 'true', source: i.source };
        break;
      case 'category':
        out[i.path] = { category: i.value ?? '', source: i.source };
        break;
      case 'text':
        out[i.path] = { text: i.value ?? '', source: i.source };
        break;
    }
  }
  return out;
}

export interface RecordVerification {
  readonly ok: boolean;
  readonly problems: readonly string[];
}

/**
 * Proves a stored result was computed by this program from its recorded inputs: the content hash
 * verifies, the program hash matches, and re-evaluation gives the identical record body (INV-25).
 */
export function verifyEvaluationRecord(
  program: CompiledExpression,
  record: EvaluationRecord,
  options: EvaluateOptions & { readonly derived?: Readonly<Record<string, EvaluationRecord>> } = {},
): RecordVerification {
  const problems: string[] = [];
  if (!recordHashValid(record)) problems.push('the record does not match its content hash: it was changed after it was computed');
  if (record.programHash !== program.programHash) problems.push('the record was not computed by this version of the calculation (program hash differs)');
  if (record.languageVersion !== program.languageVersion) problems.push(`the record was computed by expression-language ${record.languageVersion}`);
  const missingDerived = record.inputs.filter((i) => i.derivedFrom !== undefined && options.derived?.[i.derivedFrom] === undefined);
  if (missingDerived.length > 0) {
    problems.push(`cannot recompute: the computed inputs ${missingDerived.map((i) => i.path).join(', ')} were not supplied`);
  } else if (problems.length === 0 || record.programHash === program.programHash) {
    const again = tryEvaluate(program, inputsFromRecord(record, options.derived), options);
    if (!again.ok) {
      problems.push(`recomputing from the recorded inputs fails: ${again.error.message}`);
    } else {
      const expected = { ...again.record, supersedes: record.supersedes, contentHash: undefined };
      const actual = { ...record, contentHash: undefined };
      if (canonicalJson(JSON.parse(JSON.stringify(expected)) as unknown) !== canonicalJson(JSON.parse(JSON.stringify(actual)) as unknown)) {
        if (again.record.output.value !== record.output.value || again.record.output.unit !== record.output.unit) {
          problems.push(`the recorded result ${record.output.value} ${record.output.unit ?? ''} differs from the recomputed ${again.record.output.value} ${again.record.output.unit ?? ''}: a derived value must be computed, never typed (INV-25)`.replace(/ +/g, ' '));
        } else {
          problems.push('the recorded evidence (conversions, lookups or inputs) differs from a recomputation');
        }
      }
    }
  }
  return { ok: problems.length === 0, problems };
}

function sameInput(a: RecordedInput | undefined, b: RecordedInput | undefined): boolean {
  return canonicalJson(a ?? null) === canonicalJson(b ?? null);
}

/**
 * Recalculates after an input correction. `inputs` is the full, corrected input set. The result is
 * a new record that supersedes `previous` (by content hash) with the reason and the corrected
 * inputs; `previous` itself is never changed. Refused when no input changed, when no reason is
 * given, or when the calculation (program) is not the one that produced `previous`.
 */
export function recalculate(program: CompiledExpression, previous: EvaluationRecord, inputs: InputValues, reason: string, options: EvaluateOptions = {}): EvaluationRecord {
  if (typeof reason !== 'string' || reason.trim().length === 0) throw new Error('A recalculation needs a reason (DI-33)');
  if (!recordHashValid(previous)) throw new Error('The earlier result does not verify against its content hash; it cannot be superseded');
  if (previous.programHash !== program.programHash) throw new Error('The earlier result was computed by another version of the calculation; a recalculation uses the same formula version (DI-33)');
  const outcome = runProgram(program.core, inputs, options.tables ?? {});
  const before = new Map(previous.inputs.map((i) => [i.path, i]));
  const after = new Map(outcome.inputs.map((i) => [i.path, i]));
  const corrections: RecordedCorrection[] = [];
  for (const path of [...new Set([...before.keys(), ...after.keys()])].sort()) {
    const p = before.get(path);
    const c = after.get(path);
    if (c !== undefined && !sameInput(p, c)) corrections.push({ path, previous: p ?? null, corrected: c });
  }
  if (corrections.length === 0) throw new Error('No input changed: a recalculation is made only after an input correction (DI-33)');
  return buildRecord(program, outcome, { contentHash: previous.contentHash, reason: reason.trim(), corrections });
}
