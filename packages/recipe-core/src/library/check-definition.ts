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
  BLOCK_MARKETS,
  LIBRARY_EDITIONS,
  fieldlessBlock,
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
// Names the entry itself uses, and `balance`: the database's weighing rules (tablets 0310 to 0710) take any entry with a
// `balance` member for a scale weighing and require its source (S11 finding).
const RESERVED_IDS = ['kind', 'lots', 'equipment', 'computed', 'field', 'duration', 'balance'];

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
      // R3-ENG-5: a loop's endpoint decides when the loop ends; without its limit every value would pass (INV-20).
      const loopEndpoint = r?.kind === 'UNTIL_PASS' && r.untilField === f.id;
      switch (f.type) {
        case 'NUMBER':
        case 'WEIGHING':
        case 'CALC':
          if (f.limitSlot !== undefined) slots.push({ name: f.limitSlot, kind: 'LIMIT', owner: f.id, unit: f.unit, required: loopEndpoint || (f.type !== 'WEIGHING' && f.critical === true) });
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
  if (def.edition !== undefined && !(LIBRARY_EDITIONS as readonly string[]).includes(def.edition)) problems.push(err('LIB-EDITION', 'edition', `The edition is one of ${LIBRARY_EDITIONS.join(', ')}`));
  if (def.markets !== undefined && (def.markets.length === 0 || new Set(def.markets).size !== def.markets.length || def.markets.some((m) => !(BLOCK_MARKETS as readonly string[]).includes(m)))) {
    problems.push(err('LIB-MARKETS', 'markets', `The markets are left out (every market) or name each of ${BLOCK_MARKETS.join(', ')} at most once`));
  }
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
          if (f.showWhen !== undefined) problems.push(...checkShowWhen(f, fp, s, seen));
          if (f.type === 'CALC') problems.push(...checkCalc(f, fp, s, seen, def.inputs ?? [], expr));
          seen.set(f.id, { field: f, section: s, index: order });
        }
      }
      order += 1;
    });
    problems.push(...checkRepeat(s, sp));
  });
  // An INSTRUCTION or SIGN_OFF block may hold no field: its PERFORMED signature is the record (R-flow item 5).
  if (fieldCount === 0 && !fieldlessBlock(def)) problems.push(err('LIB-NO-FIELDS', 'sections', 'The block has no fields; a form needs at least one, unless the block is an instruction or a sign-off (roles INSTRUCTION, SIGN_OFF)'));
  problems.push(...checkOptionalSections(def));
  problems.push(...checkApsReading(def));

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

/**
 * Optional sections (R-flow item 3). Kept, each for its reason: the step's processing record is a required section
 * (21 CFR 211.188(b): the batch record documents each significant step); a planned count, interval or loop is the
 * product's instruction, never an event, so its section stays required (an UNTIL_PASS loop must also run, INV-20).
 */
function checkOptionalSections(def: BlockDefinition): LibraryProblem[] {
  const out: LibraryProblem[] = [];
  def.sections.forEach((s, si) => {
    if (s.required === undefined || s.required === true) return;
    const at = `sections[${si}].required`;
    if (s.required !== false) out.push(err('LIB-SECTION-OPTIONAL', at, `Section ${s.id}: required is true or false`));
    else if (typeof s.when !== 'string' || s.when.trim() === '') out.push(err('LIB-SECTION-OPTIONAL', `sections[${si}].when`, `Section ${s.id} is optional; name the event that calls for it in "when" (e.g. an extra binder addition, an alarm, a rework) [PR-03]`, ['PR-03']));
    else if (s.repeat !== undefined && s.repeat.kind !== 'ONCE' && s.repeat.kind !== 'PER_CONTAINER') {
      out.push(err('LIB-SECTION-OPTIONAL', at, `Section ${s.id} repeats ${s.repeat.kind === 'UNTIL_PASS' ? 'until it passes' : s.repeat.kind === 'COUNT' ? 'a planned number of times' : 'at planned intervals'}; a planned check is part of the step's record, so it stays required [PR-03]`, ['PR-03']));
    } else {
      // A judged value (a CPP or IPC, a field with limits, a test result) in an event section is judged when it is
      // recorded, as anywhere else; no clause makes the section required for it, so the author is only warned to check
      // that the value is not a planned part of the step's record (lean review, lead, 10 November 2026).
      const judged = (s.fields ?? []).find((f) => ('critical' in f && f.critical === true) || ('limitSlot' in f && f.limitSlot !== undefined) || f.type === 'TEST_RESULT');
      if (judged) out.push({ ...err('LIB-SECTION-OPTIONAL', at, `Section ${s.id} is recorded only when its event happens and holds ${judged.id}, a value judged against limits: check that the value is not a planned part of the step's record [PR-03, PR-08]`, ['PR-03', 'PR-08']), severity: 'WARNING' });
    }
  });
  // 21 CFR 211.188(b): the record documents that each significant step was accomplished, so a block (other than a
  // fieldless instruction or sign-off) keeps at least one required section that records something.
  const hasFields = def.sections.some((s) => (s.fields ?? []).length > 0); // none at all is LIB-NO-FIELDS
  if (hasFields && !def.sections.some((s) => s.required !== false && (s.fields ?? []).length > 0)) {
    out.push(err('LIB-SECTION-OPTIONAL', 'sections', 'No required section records a field; the section that records the step itself stays required (21 CFR 211.188(b)) [PR-03]', ['PR-03']));
  }
  return out;
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
      // R-flow item 7: the flag is ignored (a calculation is never typed, and is always computed), so it only warns.
      if (f.required === false) out.push({ ...err('LIB-CALC-REQUIRED', `${fp}.required`, `Field ${f.id} is calculated; it is never typed and always computed, so "required: false" is ignored [INV-25]`, ['INV-25']), severity: 'WARNING' });
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

/**
 * A condition refers to an earlier yes/no or choice field of the same section and to one of its answers. The runtime
 * reads the condition from the entry being recorded (one section's record, block-version.ts `shown`), so a field of
 * another section is never there and the conditional field would never be asked (injectables I-1c, lead).
 */
function checkShowWhen(f: FieldDef, fp: string, section: SectionDef, earlier: ReadonlyMap<string, { field: FieldDef; section: SectionDef }>): LibraryProblem[] {
  const w = f.showWhen;
  if (w === undefined) return [];
  const found = earlier.get(w.field);
  const on = found?.field;
  const at = `${fp}.showWhen`;
  if (!on) return [err('LIB-SHOW-WHEN', at, `Field ${f.id} is shown when ${JSON.stringify(w.field)} has an answer, but no earlier field has that id`)];
  if (found.section !== section) return [err('LIB-SHOW-WHEN', at, `Field ${f.id} is shown when ${on.id} has an answer, but ${on.id} is in section ${found.section.id}; a condition reads a field of its own section, so ${f.id} would never be asked`)];
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
  // A typed date and time, and a timer, are values the runtime does not hand to a calculation (it has no instant value,
  // and a timer's duration is judged by the timer itself), so a calculation over one would be refused at every entry.
  // Refuse the definition instead, so that QA never approves a block that cannot run. A time limit is the timer's own
  // limit within a step, or the master's time constraint between steps (HOLD, PROCESS_WINDOW).
  const unreadable = c.reads
    .map((r) => ({ r, type: earlier.get(r)?.field.type }))
    .filter((x) => x.type === 'DATE_TIME' || x.type === 'TIMER')
    .map((x) => err(x.type === 'TIMER' ? 'LIB-CALC-TIMER' : 'LIB-CALC-DATE-TIME', `${fp}.expression`, x.type === 'TIMER'
      ? `Field ${f.id} reads the timer ${x.r}; a calculation cannot use a timer. Give the timer its own limit instead [DI-33]`
      : `Field ${f.id} reads the date and time ${x.r}; a calculation cannot use a typed date and time. Use a timer in the step, or a time constraint of the master between steps [DI-33]`, ['PR-03', 'DI-33']));
  if (unreadable.length > 0) return unreadable;
  // A calculation may read a conditional field only under the same condition: otherwise its input may never exist.
  const conditional = c.reads
    .filter((r) => { const src = earlier.get(r)?.field; return src !== undefined && src.showWhen !== undefined && !sameCondition(src.showWhen, f.showWhen); })
    .map((r) => err('LIB-CALC-CONDITIONAL', `${fp}.expression`, `Field ${f.id} reads ${r}, which is shown only under a condition that ${f.id} does not share [DI-33]`, ['DI-33']));
  // An optional section may never be recorded, so a calculation elsewhere cannot read it (engine need: no input, no value).
  for (const r of c.reads) {
    const from = earlier.get(r)?.section;
    if (from !== undefined && from !== section && from.required === false) {
      conditional.push(err('LIB-CALC-CONDITIONAL', `${fp}.expression`, `Field ${f.id} reads ${r} of the optional section ${from.id}, which may never be recorded [DI-33]`, ['DI-33']));
    }
  }
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
  if (!sigs.some((s) => s.meaning === 'PERFORMED')) out.push(err('LIB-SIGNATURE-PERFORMED', 'signatures', 'The block needs a PERFORMED signature: every step is attributed to the person who did it [PR-14, DI-35]', ['PR-14', 'DI-35']));
  const meanings = new Set<string>();
  sigs.forEach((s, i) => {
    if (!(SIGNATURE_MEANINGS as readonly string[]).includes(s.meaning)) out.push(err('LIB-SIGNATURE-MEANING', `signatures[${i}].meaning`, `Unknown signature meaning ${JSON.stringify(s.meaning)}`, ['DI-35']));
    else if (meanings.has(s.meaning)) out.push(err('LIB-SIGNATURE-MEANING', `signatures[${i}].meaning`, `The ${s.meaning} signature is listed twice`, ['DI-35']));
    meanings.add(s.meaning);
    if (typeof s.role !== 'string' || s.role.trim() === '') out.push(err('LIB-SIGNATURE-ROLE', `signatures[${i}].role`, `The ${s.meaning} signature needs a role that may sign`, ['DI-35']));
  });
  return out;
}

/**
 * ST-33 (tablets 1912): a block with the role APS_READING (the reading of a media fill) marks the count of contaminated
 * units on exactly one NUMBER field (`contaminatedCount`), in whole units (decimals 0), for the database reads the count
 * by that mark; the mark is refused on a block without the role (LIB-APS-READING).
 */
function checkApsReading(def: BlockDefinition): LibraryProblem[] {
  const out: LibraryProblem[] = [];
  const role = Array.isArray(def.roles) && def.roles.includes('APS_READING');
  const marked: { path: string; field: FieldDef }[] = [];
  def.sections.forEach((s, si) =>
    (s.fields ?? []).forEach((f, fi) => {
      if ((f as { contaminatedCount?: unknown }).contaminatedCount !== undefined) marked.push({ path: `sections[${si}].fields[${fi}].contaminatedCount`, field: f });
    }),
  );
  if (!role) {
    for (const { path, field } of marked) out.push(err('LIB-APS-READING', path, `Field ${field.id} marks the count of contaminated units, which only a block with the role APS_READING (a media-fill reading) carries [ST-33]`, ['ST-33']));
    return out;
  }
  if (marked.length !== 1) {
    out.push(err('LIB-APS-READING', 'roles', `A media-fill reading (role APS_READING) marks exactly one NUMBER field as the count of contaminated units (contaminatedCount); this block marks ${marked.length} [ST-33]`, ['ST-33']));
  }
  for (const { path, field } of marked) {
    if (field.type !== 'NUMBER' || field.contaminatedCount !== true) {
      out.push(err('LIB-APS-READING', path, `Field ${field.id}: the count of contaminated units is a NUMBER field marked contaminatedCount: true [ST-33]`, ['ST-33']));
    } else if (field.decimals !== 0) {
      out.push(err('LIB-APS-READING', path, `Field ${field.id}: the count of contaminated units is in whole units (decimals 0) [ST-33]`, ['ST-33']));
    }
  }
  return out;
}
