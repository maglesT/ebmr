/**
 * Sanity checks of the product's values for one use of a library block (decision 0026 points 2 and 3; PR-03, PR-08).
 *
 * The formulation fills the definition's slots. The software checks that every required slot is filled, that no
 * unknown slot is given, that each limit is a well-formed tiered limit (lower below upper, tiers nested: PR-08) in a
 * unit that converts to the field's unit, that a target lies inside its limits, and that counts and intervals are
 * positive. A product limit looser than the block's reference limit is a WARNING that a written reason clears (O-5).
 */
import { compareDecimal, isDecimalLiteral } from '../flow/decimal.ts';
import type { ExpressionService } from '../flow/expression-port.ts';
import type { LimitRange, LimitSpec } from '../limits/model.ts';
import { checkLimitSpec } from '../limits/nesting.ts';
import { commensurable, slotsOf } from './check-definition.ts';
import { definitionHash } from './hash.ts';
import type { BlockDefinition, BlockUse, LibraryProblem, Slot } from './model.ts';

const WHOLE = /^[1-9][0-9]{0,6}$/;

function err(code: string, path: string, message: string, controls: string[] = ['PR-03']): LibraryProblem {
  return { code, severity: 'ERROR', path, message, controls };
}

/** Checks a block use against its definition. Errors refuse the formulation; warnings need a written reason. */
export function checkBlockUse(def: BlockDefinition, use: BlockUse, expr: ExpressionService): LibraryProblem[] {
  const out: LibraryProblem[] = [];
  if (use.block.code !== def.code || use.block.version !== def.version) {
    return [err('LIB-USE-BLOCK', 'block', `The use names ${use.block.code}@${use.block.version} but was checked against ${def.code}@${def.version}`)];
  }
  const slots = slotsOf(def);
  const byKind = (kind: Slot['kind']): Map<string, Slot> => new Map(slots.filter((s) => s.kind === kind).map((s) => [s.name, s]));
  const limitSlots = byKind('LIMIT');
  const classSlots = byKind('EQUIPMENT_CLASS');
  const countSlots = byKind('COUNT');
  const intervalSlots = byKind('INTERVAL');
  const bomSlots = byKind('BOM_LINE');
  const stepSlots = byKind('STEP_VALUE');
  if (use.block.hash !== undefined && use.block.hash !== definitionHash(def)) {
    out.push(err('LIB-USE-HASH', 'block.hash', `${def.code}@${def.version} does not match the content the formulation pinned; the library item changed [PR-05, DI-10]`, ['PR-05', 'DI-10']));
  }

  const unknown = (given: Record<string, unknown> | undefined, known: Map<string, Slot>, what: string, key: string): void => {
    for (const name of Object.keys(given ?? {})) if (!known.has(name)) out.push(err('LIB-USE-UNKNOWN-SLOT', `${key}.${name}`, `${def.code} has no ${what} slot ${name}`));
  };
  unknown(use.limits, limitSlots, 'limit', 'limits');
  unknown(use.targets, limitSlots, 'limit', 'targets');
  unknown(use.justifications, limitSlots, 'limit', 'justifications');
  unknown(use.marketRules, limitSlots, 'limit', 'marketRules');
  for (const [slot, rule] of Object.entries(use.marketRules ?? {})) {
    if (use.limits?.[slot] === undefined) out.push(err('LIB-USE-MARKET-RULE', `marketRules.${slot}`, `${def.title}: ${slot} is bound to market rule ${rule.key} but has no limits`, ['PR-08']));
  }
  unknown(use.equipmentClasses, classSlots, 'equipment class', 'equipmentClasses');
  unknown(use.counts, countSlots, 'count', 'counts');
  unknown(use.intervals, intervalSlots, 'interval', 'intervals');
  unknown(use.bomLines, bomSlots, 'formula line', 'bomLines');
  unknown(use.stepValues, stepSlots, 'earlier-step value', 'stepValues');
  for (const slot of bomSlots.values()) {
    const v = use.bomLines?.[slot.name];
    if (typeof v !== 'string' || v.trim() === '') out.push(err('LIB-USE-BOM-LINE', `bomLines.${slot.name}`, `${def.title}: name the formula line ${slot.owner} reads`, ['DI-33']));
  }
  for (const slot of stepSlots.values()) {
    const v = use.stepValues?.[slot.name];
    if (!v || typeof v.step !== 'string' || v.step.trim() === '' || typeof v.field !== 'string' || v.field.trim() === '') out.push(err('LIB-USE-STEP-VALUE', `stepValues.${slot.name}`, `${def.title}: name the earlier step and field ${slot.owner} reads`, ['DI-33']));
  }

  for (const slot of limitSlots.values()) {
    const spec = use.limits?.[slot.name];
    const at = `limits.${slot.name}`;
    if (spec === undefined) {
      if (slot.required) out.push(err('LIB-USE-LIMIT-MISSING', at, `${def.title}: ${slot.owner} is a CPP or IPC and needs limits [PR-03, PR-08]`, ['PR-03', 'PR-08']));
      if (use.targets?.[slot.name] !== undefined) out.push(err('LIB-USE-TARGET', `targets.${slot.name}`, `${def.title}: a target for ${slot.name} needs limits too`, ['PR-08']));
      continue;
    }
    out.push(...checkLimit(def, slot, spec, at, expr));
    const target = use.targets?.[slot.name];
    if (target !== undefined) out.push(...checkTarget(def, slot, spec, target));
    out.push(...checkAgainstReference(def, slot, spec, use.justifications?.[slot.name], expr));
  }

  for (const slot of classSlots.values()) {
    const v = use.equipmentClasses?.[slot.name];
    if (typeof v !== 'string' || v.trim() === '') out.push(err('LIB-USE-EQUIPMENT-CLASS', `equipmentClasses.${slot.name}`, `${def.title}: name the equipment class for ${slot.owner}`, ['PR-03']));
  }
  for (const slot of countSlots.values()) {
    const v = use.counts?.[slot.name];
    if (v === undefined) out.push(err('LIB-USE-COUNT', `counts.${slot.name}`, `${def.title}: give the number for ${slot.name} (${slot.owner})`));
    else if (typeof v !== 'string' || !WHOLE.test(v)) out.push(err('LIB-USE-COUNT', `counts.${slot.name}`, `${def.title}: ${slot.name} must be a whole number of 1 or more, written as text (e.g. "20")`));
  }
  for (const slot of intervalSlots.values()) {
    const v = use.intervals?.[slot.name];
    const at = `intervals.${slot.name}`;
    if (v === undefined) out.push(err('LIB-USE-INTERVAL', at, `${def.title}: give the interval for ${slot.name} (e.g. every 30 min)`, ['PR-29']));
    else if (!isDecimalLiteral(v.value) || compareDecimal(v.value, '0') <= 0) out.push(err('LIB-USE-INTERVAL', at, `${def.title}: the interval ${String(v.value)} must be a decimal above zero`, ['PR-29']));
    else if (!expr.unit(v.unit).ok || !commensurable(expr, v.unit, 's')) out.push(err('LIB-USE-INTERVAL', at, `${def.title}: the interval is a time, not ${JSON.stringify(v.unit)}`, ['PR-29']));
  }

  out.push(...checkPoints(def, use, expr));
  return out;
}

function checkLimit(def: BlockDefinition, slot: Slot, spec: LimitSpec, at: string, expr: ExpressionService): LibraryProblem[] {
  const out: LibraryProblem[] = [];
  if (!expr.unit(spec.unit).ok) return [err('LIB-USE-LIMIT-UNIT', `${at}.unit`, `${def.title}: ${JSON.stringify(spec.unit)} is not a unit`, ['PR-08'])];
  // S4: a limit is written in its field's unit, so the database compares in one unit (recipe-core 1810).
  if (slot.unit !== undefined && spec.unit !== slot.unit) {
    const converts = commensurable(expr, spec.unit, slot.unit);
    out.push(err('LIB-USE-LIMIT-UNIT', `${at}.unit`, `${def.title}: the limit for ${slot.owner} is in ${spec.unit}; write it in the field's unit ${slot.unit}${converts ? '' : ' (the two do not convert)'} [PR-08]`, ['PR-08']));
  }
  for (const p of checkLimitSpec(spec)) out.push(err(`LIB-USE-LIMIT-${p.code}`, at, `${def.title}, ${slot.owner}: ${p.message} [PR-08]`, ['PR-08']));
  return out;
}

/** The innermost tier present: ALERT inside INTERNAL_ACTION inside REGISTERED/VALIDATED. */
function innermost(spec: LimitSpec): LimitRange | undefined {
  for (const tier of ['ALERT', 'INTERNAL_ACTION', 'REGISTERED', 'VALIDATED'] as const) {
    const r = spec.ranges.find((x) => x.tier === tier);
    if (r) return r;
  }
  return undefined;
}

function checkTarget(def: BlockDefinition, slot: Slot, spec: LimitSpec, target: string): LibraryProblem[] {
  const at = `targets.${slot.name}`;
  if (!isDecimalLiteral(target)) return [err('LIB-USE-TARGET', at, `${def.title}: the target ${JSON.stringify(target)} is not a decimal`, ['PR-08'])];
  const r = innermost(spec);
  if (!r) return [];
  const lowOk = !r.low || !isDecimalLiteral(r.low.value) || (r.low.inclusive ? compareDecimal(target, r.low.value) >= 0 : compareDecimal(target, r.low.value) > 0);
  const highOk = !r.high || !isDecimalLiteral(r.high.value) || (r.high.inclusive ? compareDecimal(target, r.high.value) <= 0 : compareDecimal(target, r.high.value) < 0);
  if (lowOk && highOk) return [];
  return [err('LIB-USE-TARGET', at, `${def.title}: the target ${target} ${spec.unit} for ${slot.owner} is outside its own limits [PR-08]`, ['PR-08'])];
}

/** O-5: a product limit looser than the block's reference limit is allowed with a written reason. */
function checkAgainstReference(def: BlockDefinition, slot: Slot, spec: LimitSpec, justification: string | undefined, expr: ExpressionService): LibraryProblem[] {
  const ref = def.referenceLimits?.[slot.name];
  if (!ref || !commensurable(expr, ref.unit, spec.unit)) return [];
  const outer = spec.ranges.filter((r) => r.tier === 'REGISTERED' || r.tier === 'VALIDATED' || r.tier === 'INTERNAL_ACTION');
  if (outer.length === 0) return [];
  const toSpec = (v: string): string | undefined => expr.convert(v, ref.unit, spec.unit);
  const refLow = ref.low !== undefined ? toSpec(ref.low) : undefined;
  const refHigh = ref.high !== undefined ? toSpec(ref.high) : undefined;
  const looser: string[] = [];
  for (const r of outer) {
    if (refLow !== undefined && (r.low === undefined || (isDecimalLiteral(r.low.value) && compareDecimal(r.low.value, refLow) < 0))) looser.push(`lower ${r.low?.value ?? 'none'} below ${refLow}`);
    if (refHigh !== undefined && (r.high === undefined || (isDecimalLiteral(r.high.value) && compareDecimal(r.high.value, refHigh) > 0))) looser.push(`upper ${r.high?.value ?? 'none'} above ${refHigh}`);
  }
  if (looser.length === 0) return [];
  if (typeof justification === 'string' && justification.trim() !== '') return [];
  return [
    {
      code: 'LIB-USE-LOOSER-THAN-REFERENCE',
      severity: 'WARNING',
      path: `limits.${slot.name}`,
      message: `${def.title}: the limit for ${slot.owner} is looser than the reference (${[...new Set(looser)].join('; ')} ${spec.unit}; ${ref.note}); record a reason [PR-08, IN-33]`,
      controls: ['PR-08', 'IN-33'],
    },
  ];
}

function checkPoints(def: BlockDefinition, use: BlockUse, expr: ExpressionService): LibraryProblem[] {
  const out: LibraryProblem[] = [];
  const perPoint = new Map<string, { unit: string }>();
  for (const s of def.sections) for (const f of s.fields) if (f.type === 'TEST_RESULT' && f.perPoint === true) perPoint.set(f.id, { unit: f.unit });
  for (const field of Object.keys(use.points ?? {})) if (!perPoint.has(field)) out.push(err('LIB-USE-POINTS', `points.${field}`, `${def.title}: ${field} is not a test with time points or stages`));
  for (const [field, { unit }] of perPoint) {
    const points = use.points?.[field] ?? [];
    const at = `points.${field}`;
    if (points.length === 0) {
      out.push(err('LIB-USE-POINTS', at, `${def.title}: ${field} needs at least one time point or stage, each with its limits [PR-03]`));
      continue;
    }
    const ids = new Set<string>();
    points.forEach((p, i) => {
      if (typeof p.id !== 'string' || p.id.trim() === '' || ids.has(p.id)) out.push(err('LIB-USE-POINTS', `${at}[${i}].id`, `${def.title}: each point of ${field} needs its own id`));
      ids.add(p.id);
      out.push(...checkLimit(def, { name: `${field}.${p.id}`, kind: 'LIMIT', owner: `${field} at ${p.label}`, unit, required: true }, p.limits, `${at}[${i}].limits`, expr));
    });
  }
  return out;
}
