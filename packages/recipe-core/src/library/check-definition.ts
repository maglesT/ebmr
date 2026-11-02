/**
 * Sanity checks of a library block definition (decision 0026 point 3; PR-03 typed fields, PR-08 limits).
 *
 * These are the checks the software owns: the form is well made (identifiers, types, units, options, calculations
 * that check and never form a cycle, repeats that can end, at least a PERFORMED signature, and limit slots on every
 * critical field). Whether the block is the right process for a product is the author's and QA's responsibility,
 * so nothing here judges the process itself.
 */
import { compareDecimal, isDecimalLiteral } from '../flow/decimal.ts';
import type { ExpressionService, ExprType } from '../flow/expression-port.ts';
import {
  BLOCK_CATEGORIES,
  EQUIPMENT_KINDS,
  FIELD_TYPES,
  LIBRARY_ROLES,
  SIGNATURE_MEANINGS,
  TEST_STATISTICS,
  type BlockDefinition,
  type ExternalInput,
  type FieldDef,
  type LibraryProblem,
  type SectionDef,
  type Slot,
} from './model.ts';

const CODE = /^[A-Z][A-Z0-9-]{1,39}$/;
const IDENT = /^[a-z][A-Za-z0-9_]{0,39}$/;
const SLOT = /^[a-z][A-Za-z0-9_]{0,39}$/;
/** Members an entry carries besides its fields (the kind, server-filled facts, calculated values, timers). */
const RESERVED_IDS = ['kind', 'lots', 'equipment', 'computed', 'field', 'duration'];

/** True when two UCUM units measure the same kind of quantity (a value converts exactly between them). */
export function commensurable(expr: ExpressionService, a: string, b: string): boolean {
  return expr.convert('1', a, b) !== undefined;
}

function err(code: string, path: string, message: string, controls: string[] = ['PR-03']): LibraryProblem {
  return { code, severity: 'ERROR', path, message, controls };
}

/** The value type a field gives to a calculation, or undefined when a calculation cannot read it. */
function exprTypeOf(f: FieldDef): ExprType | undefined {
  switch (f.type) {
    case 'NUMBER':
    case 'WEIGHING':
    case 'CALC':
      return { kind: 'DECIMAL', unit: f.unit };
    case 'TIMER':
      return { kind: 'DECIMAL', unit: f.durationUnit ?? 'min' };
    case 'TEST_RESULT':
      return { kind: 'SERIES', of: { kind: 'DECIMAL', unit: f.unit } };
    case 'YES_NO':
      return { kind: 'BOOLEAN' };
    case 'CHOICE':
      return { kind: 'CATEGORY', values: f.options };
    case 'TEXT':
      return { kind: 'TEXT' };
    case 'DATE_TIME':
      return { kind: 'INSTANT' };
    default:
      return undefined;
  }
}

function repeats(s: SectionDef): boolean {
  return s.repeat !== undefined && s.repeat.kind !== 'ONCE';
}

/** The slots a definition exposes to the formulation, in definition order. */
export function slotsOf(def: BlockDefinition): Slot[] {
  const slots: Slot[] = [];
  for (const i of def.inputs ?? []) {
    if (i.kind === 'FORMULA_LINE') slots.push({ name: i.slot, kind: 'BOM_LINE', owner: i.id, required: true });
    if (i.kind === 'STEP_VALUE') slots.push({ name: i.slot, kind: 'STEP_VALUE', owner: i.id, required: true });
  }
  for (const s of def.sections ?? []) {
    const r = s.repeat;
    if (r?.kind === 'COUNT') slots.push({ name: r.countSlot, kind: 'COUNT', owner: s.id, required: true });
    if (r?.kind === 'PER_INTERVAL') slots.push({ name: r.intervalSlot, kind: 'INTERVAL', owner: s.id, required: true });
    if (r?.kind === 'UNTIL_PASS' && r.maxRepeatsSlot !== undefined) slots.push({ name: r.maxRepeatsSlot, kind: 'COUNT', owner: s.id, required: true });
    for (const f of s.fields ?? []) {
      switch (f.type) {
        case 'NUMBER':
        case 'WEIGHING':
        case 'CALC':
          if (f.limitSlot !== undefined) slots.push({ name: f.limitSlot, kind: 'LIMIT', owner: f.id, unit: f.unit, required: f.type !== 'WEIGHING' && f.critical === true });
          break;
        case 'TIMER':
          if (f.limitSlot !== undefined) slots.push({ name: f.limitSlot, kind: 'LIMIT', owner: f.id, unit: f.durationUnit ?? 'min', required: f.critical === true });
          break;
        case 'EQUIPMENT':
          slots.push({ name: f.classSlot, kind: 'EQUIPMENT_CLASS', owner: f.id, required: true });
          break;
        case 'MATERIAL_LOT':
          if (f.bomLineSlot !== undefined) slots.push({ name: f.bomLineSlot, kind: 'BOM_LINE', owner: f.id, required: true });
          break;
        case 'SAMPLE':
          slots.push({ name: f.unitsSlot, kind: 'COUNT', owner: f.id, required: true });
          break;
        case 'TEST_RESULT':
          slots.push({ name: f.replicatesSlot, kind: 'COUNT', owner: f.id, required: true });
          // A per-point result takes its limits from each point instead of from the statistic slots.
          for (const st of f.statistics ?? []) slots.push({ name: st.limitSlot, kind: 'LIMIT', owner: f.id, unit: st.statistic === 'RSD' ? '%' : f.unit, required: f.perPoint !== true });
          break;
        default:
          break;
      }
    }
  }
  return slots;
}

/** Checks a block definition. An empty list means the definition may be submitted for QA approval. */
export function checkBlockDefinition(def: BlockDefinition, expr: ExpressionService): LibraryProblem[] {
  const problems: LibraryProblem[] = [];
  if (typeof def.code !== 'string' || !CODE.test(def.code)) problems.push(err('LIB-CODE', 'code', `The block code ${JSON.stringify(def.code)} must be upper-case letters, digits and hyphens (2 to 40 characters)`));
  if (!Number.isInteger(def.version) || def.version < 1) problems.push(err('LIB-VERSION', 'version', 'The version must be a whole number of 1 or more [PR-05]', ['PR-05']));
  if (typeof def.title !== 'string' || def.title.trim() === '') problems.push(err('LIB-TITLE', 'title', 'The block needs a title'));
  if (!(BLOCK_CATEGORIES as readonly string[]).includes(def.category)) problems.push(err('LIB-CATEGORY', 'category', `Unknown category ${JSON.stringify(def.category)}`));
  if (def.roles !== undefined && (!Array.isArray(def.roles) || def.roles.length === 0 || def.roles.some((r) => !(LIBRARY_ROLES as readonly string[]).includes(r)))) {
    problems.push(err('LIB-ROLES', 'roles', `Roles are one or more of ${LIBRARY_ROLES.join(', ')}`));
  }
  if (!Array.isArray(def.sections) || def.sections.length === 0) {
    problems.push(err('LIB-NO-FIELDS', 'sections', 'The block has no sections; a form needs at least one field'));
    return problems.concat(checkSignatures(def));
  }

  problems.push(...checkInputs(def, expr));
  const inputIds = new Set((def.inputs ?? []).map((i) => i.id));

  // Field ids are unique across the whole definition (and apart from the input ids): calculations and limits refer to them.
  const seen = new Map<string, { field: FieldDef; section: SectionDef; index: number }>();
  let order = 0;
  let fieldCount = 0;
  const sectionIds = new Set<string>();
  def.sections.forEach((s, si) => {
    const sp = `sections[${si}]`;
    if (typeof s.id !== 'string' || !IDENT.test(s.id)) problems.push(err('LIB-SECTION-ID', `${sp}.id`, `Section id ${JSON.stringify(s.id)} must start with a lower-case letter and use letters, digits or underscores`));
    else if (sectionIds.has(s.id)) problems.push(err('LIB-SECTION-ID', `${sp}.id`, `Section id ${s.id} is used twice`));
    sectionIds.add(s.id);
    if (typeof s.title !== 'string' || s.title.trim() === '') problems.push(err('LIB-SECTION-TITLE', `${sp}.title`, 'Every section needs a title'));
    (s.fields ?? []).forEach((f, fi) => {
      fieldCount += 1;
      const fp = `${sp}.fields[${fi}]`;
      problems.push(...checkField(f, fp, expr, repeats(s)));
      if (typeof f.id === 'string' && IDENT.test(f.id)) {
        if (seen.has(f.id) || inputIds.has(f.id)) problems.push(err('LIB-FIELD-ID', `${fp}.id`, `Field id ${f.id} is used twice; each field and input needs its own id`));
        else {
          if (f.showWhen !== undefined) problems.push(...checkShowWhen(f, fp, seen));
          if (f.type === 'CALC') problems.push(...checkCalc(f, fp, s, seen, def.inputs ?? [], expr));
          seen.set(f.id, { field: f, section: s, index: order });
        }
      }
      order += 1;
    });
    problems.push(...checkRepeat(s, sp));
  });
  if (fieldCount === 0) problems.push(err('LIB-NO-FIELDS', 'sections', 'The block has no fields; a form needs at least one'));

  // An UNTIL_PASS repeat ends only on a field with a pass/fail meaning in the same section.
  def.sections.forEach((s, si) => {
    const r = s.repeat;
    if (r?.kind !== 'UNTIL_PASS') return;
    const target = (s.fields ?? []).find((f) => f.id === r.untilField);
    if (!target) {
      problems.push(err('LIB-REPEAT-UNTIL', `sections[${si}].repeat.untilField`, `The repeat of section ${s.id} waits for a field that is not in that section`));
      return;
    }
    const decides = (target.type === 'YES_NO' && target.expected !== undefined) || ('limitSlot' in target && target.limitSlot !== undefined);
    if (target.showWhen !== undefined) problems.push(err('LIB-REPEAT-UNTIL', `sections[${si}].repeat.untilField`, `The repeat of section ${s.id} waits for field ${target.id}, which is shown only under a condition, so it might never be recorded [INV-20]`, ['PR-03', 'INV-20']));
    if (!decides) problems.push(err('LIB-REPEAT-UNTIL', `sections[${si}].repeat.untilField`, `The repeat of section ${s.id} can never end: field ${target.id} has neither limits nor an expected answer [INV-20]`, ['PR-03', 'INV-20']));
  });

  // Slot names are unique: the formulation fills each slot once.
  const slotNames = new Map<string, string>();
  for (const slot of slotsOf(def)) {
    if (typeof slot.name !== 'string' || !SLOT.test(slot.name)) {
      problems.push(err('LIB-SLOT-NAME', slot.owner, `Slot name ${JSON.stringify(slot.name)} of ${slot.owner} must start with a lower-case letter and use letters, digits or underscores`));
      continue;
    }
    const prev = slotNames.get(slot.name);
    if (prev !== undefined) problems.push(err('LIB-SLOT-DUPLICATE', slot.owner, `Slot ${slot.name} is used by both ${prev} and ${slot.owner}; each slot is filled once`));
    slotNames.set(slot.name, slot.owner);
  }

  problems.push(...checkReferenceLimits(def, expr));
  problems.push(...checkSignatures(def));
  return problems;
}

function checkField(f: FieldDef, fp: string, expr: ExpressionService, inRepeat: boolean): LibraryProblem[] {
  const out: LibraryProblem[] = [];
  if (!(FIELD_TYPES as readonly string[]).includes((f as { type: string }).type)) {
    return [err('LIB-FIELD-TYPE', `${fp}.type`, `Unknown field type ${JSON.stringify((f as { type: string }).type)}; the field types are ${FIELD_TYPES.join(', ')}`)];
  }
  if (typeof f.id !== 'string' || !IDENT.test(f.id)) out.push(err('LIB-FIELD-ID', `${fp}.id`, `Field id ${JSON.stringify(f.id)} must start with a lower-case letter and use letters, digits or underscores`));
  else if (RESERVED_IDS.includes(f.id)) out.push(err('LIB-FIELD-RESERVED', `${fp}.id`, `Field id ${f.id} is a name the entry itself uses (${RESERVED_IDS.join(', ')}); choose another`));
  if (typeof f.label !== 'string' || f.label.trim() === '') out.push(err('LIB-FIELD-LABEL', `${fp}.label`, `Field ${String(f.id)} needs a label the operator reads`));
  const unitOk = (unit: unknown, at: string): boolean => {
    if (typeof unit !== 'string') {
      out.push(err('LIB-FIELD-UNIT', at, `Field ${f.id} needs a unit (UCUM code, "1" for a plain number)`));
      return false;
    }
    const u = expr.unit(unit);
    if (!u.ok) out.push(err('LIB-FIELD-UNIT', at, `Field ${f.id}: ${JSON.stringify(unit)} is not a unit (${u.message})`));
    return u.ok;
  };
  const criticalNeedsLimit = (critical: boolean | undefined, limitSlot: string | undefined): void => {
    if (critical === true && limitSlot === undefined) out.push(err('LIB-CRITICAL-NO-LIMIT', `${fp}.limitSlot`, `Field ${f.id} is a CPP or IPC but has no limit slot; every CPP and IPC has limits [PR-03, PR-08]`, ['PR-03', 'PR-08']));
  };
  switch (f.type) {
    case 'NUMBER':
      unitOk(f.unit, `${fp}.unit`);
      if (f.decimals !== undefined && (!Number.isInteger(f.decimals) || f.decimals < 0 || f.decimals > 12)) out.push(err('LIB-FIELD-DECIMALS', `${fp}.decimals`, `Field ${f.id}: decimals must be a whole number from 0 to 12`));
      criticalNeedsLimit(f.critical, f.limitSlot);
      break;
    case 'CALC':
      unitOk(f.unit, `${fp}.unit`);
      criticalNeedsLimit(f.critical, f.limitSlot);
      if (f.required === false) out.push(err('LIB-CALC-REQUIRED', `${fp}.required`, `Field ${f.id} is calculated; it is never typed, so it cannot be optional or required [INV-25]`, ['INV-25']));
      break;
    case 'TIMER': {
      const unit = f.durationUnit ?? 'min';
      if (inRepeat) out.push(err('LIB-TIMER-REPEAT', fp, `Field ${f.id}: a timer runs once per step, so it cannot sit in a repeating section`));
      if (unitOk(unit, `${fp}.durationUnit`) && !commensurable(expr, unit, 's')) out.push(err('LIB-FIELD-UNIT', `${fp}.durationUnit`, `Field ${f.id}: a timer is measured in a time unit, not ${unit}`));
      criticalNeedsLimit(f.critical, f.limitSlot);
      break;
    }
    case 'WEIGHING':
      if (unitOk(f.unit, `${fp}.unit`) && !commensurable(expr, f.unit, 'g')) out.push(err('LIB-FIELD-UNIT', `${fp}.unit`, `Field ${f.id}: a weighing is in a mass unit, not ${f.unit}`));
      break;
    case 'TEXT':
      if (f.pattern !== undefined) {
        try {
          new RegExp(f.pattern, 'u');
        } catch {
          out.push(err('LIB-FIELD-PATTERN', `${fp}.pattern`, `Field ${f.id}: the pattern is not a valid regular expression`));
        }
      }
      if (f.maxLength !== undefined && (!Number.isInteger(f.maxLength) || f.maxLength < 1 || f.maxLength > 4000)) out.push(err('LIB-FIELD-LENGTH', `${fp}.maxLength`, `Field ${f.id}: the maximum length must be from 1 to 4000 characters`));
      break;
    case 'YES_NO':
      if (f.expected !== undefined && typeof f.expected !== 'boolean') out.push(err('LIB-FIELD-EXPECTED', `${fp}.expected`, `Field ${f.id}: the expected answer is yes or no`));
      break;
    case 'CHOICE': {
      const opts = Array.isArray(f.options) ? f.options : [];
      if (opts.length < 2) out.push(err('LIB-CHOICE-OPTIONS', `${fp}.options`, `Field ${f.id} needs at least two options`));
      if (opts.some((o) => typeof o !== 'string' || o.trim() === '')) out.push(err('LIB-CHOICE-OPTIONS', `${fp}.options`, `Field ${f.id}: every option needs text`));
      if (new Set(opts).size !== opts.length) out.push(err('LIB-CHOICE-OPTIONS', `${fp}.options`, `Field ${f.id}: an option is listed twice`));
      const bad = f.notAllowed ?? [];
      for (const b of bad) if (!opts.includes(b)) out.push(err('LIB-CHOICE-NOT-ALLOWED', `${fp}.notAllowed`, `Field ${f.id}: "${b}" is marked not allowed but is not one of the options`));
      if (opts.length > 0 && bad.length > 0 && opts.every((o) => bad.includes(o))) out.push(err('LIB-CHOICE-NOT-ALLOWED', `${fp}.notAllowed`, `Field ${f.id}: every option is not allowed, so no answer can pass`));
      break;
    }
    case 'EQUIPMENT':
      if (!(EQUIPMENT_KINDS as readonly string[]).includes(f.kind)) out.push(err('LIB-EQUIPMENT-KIND', `${fp}.kind`, `Field ${f.id}: unknown equipment kind ${JSON.stringify(f.kind)}`));
      break;
    case 'CONTAINER':
      if (f.action !== 'REGISTER' && f.action !== 'CONSUME') out.push(err('LIB-CONTAINER-ACTION', `${fp}.action`, `Field ${f.id}: a container is registered or consumed`));
      break;
    case 'TEST_RESULT': {
      unitOk(f.unit, `${fp}.unit`);
      const stats = Array.isArray(f.statistics) ? f.statistics : [];
      if (stats.length === 0) out.push(err('LIB-TEST-NO-LIMIT', `${fp}.statistics`, `Test ${f.id} judges no statistic; a test result needs at least one statistic with limits [PR-03, PR-29]`, ['PR-03', 'PR-29']));
      const names = stats.map((s) => s.statistic);
      for (const s of stats) if (!(TEST_STATISTICS as readonly string[]).includes(s.statistic)) out.push(err('LIB-TEST-STATISTIC', `${fp}.statistics`, `Test ${f.id}: unknown statistic ${JSON.stringify(s.statistic)}`));
      if (new Set(names).size !== names.length) out.push(err('LIB-TEST-STATISTIC', `${fp}.statistics`, `Test ${f.id}: a statistic is listed twice`));
      break;
    }
    default:
      break;
  }
  return out;
}

const INPUT_KINDS = ['FORMULA_LINE', 'BATCH_SIZE', 'LOT_ASSAY', 'STEP_VALUE'];

/** External inputs: known kind, identifier, label, unit; a lot assay names a lot or weighing field of this block. */
function checkInputs(def: BlockDefinition, expr: ExpressionService): LibraryProblem[] {
  const out: LibraryProblem[] = [];
  const ids = new Set<string>();
  const fields = new Map(def.sections.flatMap((s) => s.fields ?? []).map((f) => [f.id, f]));
  (def.inputs ?? []).forEach((i, n) => {
    const at = `inputs[${n}]`;
    if (!INPUT_KINDS.includes(i.kind)) {
      out.push(err('LIB-INPUT-KIND', `${at}.kind`, `Unknown input kind ${JSON.stringify(i.kind)}; it is one of ${INPUT_KINDS.join(', ')}`, ['DI-33']));
      return;
    }
    if (typeof i.id !== 'string' || !IDENT.test(i.id)) out.push(err('LIB-INPUT-ID', `${at}.id`, `Input id ${JSON.stringify(i.id)} must start with a lower-case letter and use letters, digits or underscores`, ['DI-33']));
    else if (ids.has(i.id)) out.push(err('LIB-INPUT-ID', `${at}.id`, `Input id ${i.id} is used twice`, ['DI-33']));
    ids.add(i.id);
    if (typeof i.label !== 'string' || i.label.trim() === '') out.push(err('LIB-INPUT-LABEL', `${at}.label`, `Input ${i.id} needs a label`, ['DI-33']));
    const u = typeof i.unit === 'string' ? expr.unit(i.unit) : { ok: false as const, message: 'no unit' };
    if (!u.ok) out.push(err('LIB-INPUT-UNIT', `${at}.unit`, `Input ${i.id}: ${JSON.stringify(i.unit)} is not a unit`, ['DI-33']));
    if (i.kind === 'LOT_ASSAY') {
      const lot = fields.get(i.lotField);
      if (!lot || (lot.type !== 'MATERIAL_LOT' && lot.type !== 'WEIGHING')) out.push(err('LIB-INPUT-LOT', `${at}.lotField`, `Input ${i.id} reads the assay of the lot in ${JSON.stringify(i.lotField)}, which is not a material lot or weighing field of this block`, ['DI-33']));
    }
  });
  return out;
}

/** A condition refers to an earlier yes/no or choice field and to one of its answers. */
function checkShowWhen(f: FieldDef, fp: string, earlier: ReadonlyMap<string, { field: FieldDef }>): LibraryProblem[] {
  const w = f.showWhen;
  if (w === undefined) return [];
  const on = earlier.get(w.field)?.field;
  const at = `${fp}.showWhen`;
  if (!on) return [err('LIB-SHOW-WHEN', at, `Field ${f.id} is shown when ${JSON.stringify(w.field)} has an answer, but no earlier field has that id`)];
  if (on.type === 'YES_NO') return typeof w.equals === 'boolean' ? [] : [err('LIB-SHOW-WHEN', at, `Field ${f.id}: ${on.id} is a yes/no field, so the condition is yes or no`)];
  if (on.type === 'CHOICE') return typeof w.equals === 'string' && on.options.includes(w.equals) ? [] : [err('LIB-SHOW-WHEN', at, `Field ${f.id}: ${JSON.stringify(w.equals)} is not an option of ${on.id}`)];
  return [err('LIB-SHOW-WHEN', at, `Field ${f.id} depends on ${on.id}, which is not a yes/no or choice field`)];
}

function sameCondition(a: FieldDef['showWhen'], b: FieldDef['showWhen']): boolean {
  return a === undefined ? b === undefined : b !== undefined && a.field === b.field && a.equals === b.equals;
}

function checkCalc(f: FieldDef & { type: 'CALC' }, fp: string, section: SectionDef, earlier: ReadonlyMap<string, { field: FieldDef; section: SectionDef }>, external: readonly ExternalInput[], expr: ExpressionService): LibraryProblem[] {
  if (typeof f.expression !== 'string' || f.expression.trim() === '') return [err('LIB-CALC-EXPRESSION', `${fp}.expression`, `Field ${f.id} is calculated but has no formula`, ['PR-03', 'DI-33'])];
  if (typeof f.unit !== 'string' || !expr.unit(f.unit).ok) return [];
  // Only fields declared earlier are inputs, so a calculation can never read itself or a later calculation (no cycles).
  const inputs = new Map<string, ExprType>();
  for (const i of external) if (typeof i.unit === 'string' && expr.unit(i.unit).ok) inputs.set(i.id, { kind: 'DECIMAL', unit: i.unit });
  for (const [id, { field, section: from }] of earlier) {
    const t = exprTypeOf(field);
    if (t === undefined) continue;
    if (from !== section && repeats(from)) {
      if (t.kind === 'SERIES') continue;
      inputs.set(id, { kind: 'SERIES', of: t });
    } else inputs.set(id, t);
  }
  const c = expr.check(f.expression, inputs, { role: 'CALCULATION', output: { kind: 'DECIMAL', unit: f.unit } });
  // A calculation may read a conditional field only under the same condition: otherwise its input may never exist.
  const conditional = c.reads
    .filter((r) => { const src = earlier.get(r)?.field; return src !== undefined && src.showWhen !== undefined && !sameCondition(src.showWhen, f.showWhen); })
    .map((r) => err('LIB-CALC-CONDITIONAL', `${fp}.expression`, `Field ${f.id} reads ${r}, which is shown only under a condition that ${f.id} does not share [DI-33]`, ['DI-33']));
  return conditional.concat(c.problems.map((p) => ({
    code: 'LIB-CALC-EXPRESSION',
    severity: p.severity,
    path: `${fp}.expression`,
    message: `Field ${f.id}: ${p.message} (a calculation reads fields declared before it) [DI-33]`,
    controls: ['DI-33'],
  })));
}

function checkRepeat(s: SectionDef, sp: string): LibraryProblem[] {
  const r = s.repeat;
  if (r === undefined) return [];
  const kinds = ['ONCE', 'COUNT', 'PER_CONTAINER', 'PER_INTERVAL', 'UNTIL_PASS'];
  if (!kinds.includes(r.kind)) return [err('LIB-REPEAT-KIND', `${sp}.repeat.kind`, `Unknown repeat ${JSON.stringify(r.kind)}; it is one of ${kinds.join(', ')}`)];
  if (r.kind === 'UNTIL_PASS' && r.maxRepeatsSlot === undefined) {
    return [{ code: 'LIB-REPEAT-NO-MAX', severity: 'WARNING', path: `${sp}.repeat`, message: `Section ${s.id} repeats until a value passes, with no maximum number of repeats; give the formulation a maximum, or record why none is needed`, controls: ['INV-20'] }];
  }
  return [];
}

function checkReferenceLimits(def: BlockDefinition, expr: ExpressionService): LibraryProblem[] {
  const out: LibraryProblem[] = [];
  const limitSlots = new Map(slotsOf(def).filter((s) => s.kind === 'LIMIT').map((s) => [s.name, s]));
  for (const [name, ref] of Object.entries(def.referenceLimits ?? {})) {
    const at = `referenceLimits.${name}`;
    const slot = limitSlots.get(name);
    if (!slot) {
      out.push(err('LIB-REFERENCE-SLOT', at, `Reference limit ${name} names no limit slot of this block`, ['PR-08']));
      continue;
    }
    if (typeof ref.note !== 'string' || ref.note.trim() === '') out.push(err('LIB-REFERENCE-NOTE', at, `Reference limit ${name} needs a note saying where it comes from (e.g. the pharmacopoeia general chapter) [IN-33]`, ['IN-33']));
    if (ref.low === undefined && ref.high === undefined) out.push(err('LIB-REFERENCE-BOUND', at, `Reference limit ${name} has neither a lower nor an upper value`, ['PR-08']));
    for (const v of [ref.low, ref.high]) if (v !== undefined && !isDecimalLiteral(v)) out.push(err('LIB-REFERENCE-BOUND', at, `Reference limit ${name}: ${JSON.stringify(v)} is not a decimal`, ['PR-08']));
    if (ref.low !== undefined && ref.high !== undefined && isDecimalLiteral(ref.low) && isDecimalLiteral(ref.high) && compareDecimal(ref.low, ref.high) > 0) {
      out.push(err('LIB-REFERENCE-BOUND', at, `Reference limit ${name}: the lower value ${ref.low} is above the upper value ${ref.high}`, ['PR-08']));
    }
    if (slot.unit !== undefined && (!expr.unit(ref.unit).ok || !commensurable(expr, ref.unit, slot.unit))) {
      out.push(err('LIB-REFERENCE-UNIT', at, `Reference limit ${name} is in ${JSON.stringify(ref.unit)}, which does not convert to the field's unit ${slot.unit}`, ['PR-08']));
    }
  }
  return out;
}

function checkSignatures(def: BlockDefinition): LibraryProblem[] {
  const out: LibraryProblem[] = [];
  const sigs = Array.isArray(def.signatures) ? def.signatures : [];
  if (!sigs.some((s) => s.meaning === 'PERFORMED')) out.push(err('LIB-SIGNATURE-PERFORMED', 'signatures', 'The block needs a PERFORMED signature: every step is attributed to the person who did it [DI-35, ST-33]', ['DI-35', 'ST-33']));
  const meanings = new Set<string>();
  sigs.forEach((s, i) => {
    if (!(SIGNATURE_MEANINGS as readonly string[]).includes(s.meaning)) out.push(err('LIB-SIGNATURE-MEANING', `signatures[${i}].meaning`, `Unknown signature meaning ${JSON.stringify(s.meaning)}`, ['DI-35']));
    else if (meanings.has(s.meaning)) out.push(err('LIB-SIGNATURE-MEANING', `signatures[${i}].meaning`, `The ${s.meaning} signature is listed twice`, ['DI-35']));
    meanings.add(s.meaning);
    if (typeof s.role !== 'string' || s.role.trim() === '') out.push(err('LIB-SIGNATURE-ROLE', `signatures[${i}].role`, `The ${s.meaning} signature needs a role that may sign`, ['DI-35']));
  });
  return out;
}
