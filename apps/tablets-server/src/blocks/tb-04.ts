/**
 * TB-04@1 Wet granulation (high shear or fluid bed) with end point (tablets spec B.2 TB-04; Phase 3 slice 3b).
 * Controls IN-36 (a), IN-13, PR-08, PR-29, DI-31, DI-49.
 *
 * Process values go through G-06@1 (common.ts): the impeller and chopper setpoints read back, the power, torque and
 * product temperature collected from the granulator with their acceptance limits (PROCESS_VALUE_OUT_OF_LIMITS), alarms,
 * the interface loss and the recipe check; a value from the equipment stands on the claimed reading of the step's
 * device (tablets 0820), a value keyed by hand only under the MBR's fallback (flagged, two persons).
 *
 * The MBR's end point (endPoint) is one of:
 *   POWER or TORQUE  the end point is a usable ACTUAL of the end-point tag the step collected (END_POINT names it); a
 *                    value keyed by hand (manual end-point call) needs a reason and a second person;
 *   TIME             the massing time between MASSING_START and END_POINT at the server's times, never typed; an end
 *                    point before the minimum time is refused (TB04-ENDPOINT-EARLY).
 * An end point outside the MBR's range (min..max, or minTime..maxTime) raises ENDPOINT_OUT_OF_RANGE (the steps after it
 * wait for a deviation). When the MBR names an end-point item (a parameter the step records) the block computes it from
 * the END_POINT entry, so it is judged against the parameter's limit tiers (PR-08) and never typed (INV-25).
 *
 * Binder: each BINDER_ADDITION names the solution's PREPARED entry (TB-03) and the quantity; the database refuses an
 * addition once that solution's use-by has passed (database time) or that would use more than was prepared (tablets
 * 0850). The total added outside the MBR's range raises BINDER_QUANTITY_OUT_OF_RANGE at PERFORMED.
 *
 * Extra granulating fluid ("extra IPA"): only at a step the MBR places in an operator-choice branch (G-19) with
 * `extraFluid` (the maximum and the roles allowed); EXTRA_FLUID by another role is refused; beyond the maximum it raises
 * EXTRA_FLUID_OVER_MAXIMUM (a deviation).
 *
 * The database holds the same rules (tablets 0850).
 */
import { Dec } from '@ebmr/expr';
import { blocks } from '@ebmr/recipe-core/pure';
import {
  acceptProcessEntry,
  ancestorsOf,
  configError,
  DURATION,
  durationUs,
  ENTRY_ID,
  isProcessKind,
  isRecord,
  POSITIVE_QUANTITY,
  PROCESS_CONFIG_FIELDS,
  PROCESS_ENTRIES,
  PROCESS_EXCEPTION_RULES,
  processBeforePerform,
  processConfigProblems,
  processNominalEntries,
  problem,
  quantityOf,
  refuse,
  secondsText,
  sumOf,
  text,
  usableActual,
  type BlockVersion,
  type Config,
  type ConfigProblem,
  type EntryResult,
  type ExceptionDraft,
  type HandlerProblem,
  type HandlerView,
  type Entry,
  type JsonValue,
  type MbrContent,
  type PhaseNode,
} from './granulation/common.ts';
import { PROCESS_SUMMARIES, S } from './summaries.ts';

const CONTROLS = ['IN-36', 'IN-13', 'PR-08', 'PR-29', 'DI-31', 'DI-49'];
const TAG = /^[a-z][a-z0-9_]*(\.[a-zA-Z0-9_]+)+$/;

export interface EndPointConfig {
  criterion: 'POWER' | 'TORQUE' | 'TIME';
  tag?: string;
  min?: string;
  max?: string;
  minTime?: bigint;
  maxTime?: bigint;
  item?: string;
}

export function endPointOf(config: Config): EndPointConfig | undefined {
  const e = config['endPoint'];
  if (!isRecord(e)) return undefined;
  const minTime = durationUs(e['minTime']);
  const maxTime = durationUs(e['maxTime']);
  return {
    criterion: String(e['criterion']) as EndPointConfig['criterion'],
    ...(text(e['tag']) !== undefined ? { tag: text(e['tag']) as string } : {}),
    ...(text(e['min']) !== undefined ? { min: text(e['min']) as string } : {}),
    ...(text(e['max']) !== undefined ? { max: text(e['max']) as string } : {}),
    ...(minTime !== undefined ? { minTime } : {}),
    ...(maxTime !== undefined ? { maxTime } : {}),
    ...(text(e['item']) !== undefined ? { item: text(e['item']) as string } : {}),
  };
}

export function extraFluidOf(config: Config): { max: { value: string; unit: string }; roles: string[] } | undefined {
  const x = config['extraFluid'];
  const max = isRecord(x) ? quantityOf(x['max']) : undefined;
  return isRecord(x) && max ? { max, roles: Array.isArray(x['roles']) ? x['roles'].map(String) : [] } : undefined;
}

function binderRangeOf(config: Config): { min: string; max: string; unit: string } | undefined {
  const b = config['binder'];
  return isRecord(b) && typeof b['min'] === 'string' && typeof b['max'] === 'string' && typeof b['unit'] === 'string' ? { min: b['min'], max: b['max'], unit: b['unit'] } : undefined;
}

function within(value: string, min: string | undefined, max: string | undefined): boolean {
  const v = Dec.parse(value);
  return !(min !== undefined && v.lt(Dec.parse(min))) && !(max !== undefined && v.gt(Dec.parse(max)));
}

function outOfRange(view: HandlerView, what: string): ExceptionDraft {
  return {
    type: 'ENDPOINT_OUT_OF_RANGE',
    title: `The granulation end point of ${view.stepKey} (${what}) is outside the MBR's range: the steps after it wait for a deviation`,
    controls: ['IN-36', 'PR-08', 'PR-29'],
    severity: 'ACTION',
    category: 'OUT_OF_LIMIT',
    blocks: 'DOWNSTREAM',
    until: 'DEVIATION',
    deviationRequired: true,
  };
}

function acceptEndPoint(view: HandlerView, entry: Entry): EntryResult {
  const ep = endPointOf(view.config);
  if (!ep) return refuse('TB04-NO-ENDPOINT', `${view.phase.id} has no end point in its MBR`, ['IN-36']);
  if (view.entries('END_POINT').length > 0) return refuse('TB04-ENDPOINT-TWICE', `${view.stepKey} already records its end point`, ['IN-36', 'DI-29']);
  const reason = text(entry['reason']);
  if (ep.criterion === 'TIME') {
    const start = view.entries('MASSING_START')[0];
    if (!start) return refuse('TB04-NO-MASSING-START', `Start the wet massing of ${view.stepKey} first`, ['IN-36', 'IN-13']);
    if (entry['actual'] !== undefined) return refuse('TB04-ENDPOINT-VALUE', 'A time end point names no collected value', ['IN-36']);
    const elapsed = view.nowUs - start.recordedAt;
    if (ep.minTime !== undefined && elapsed < ep.minTime) {
      return refuse('TB04-ENDPOINT-EARLY', `The massing time of ${view.stepKey} (${secondsText(elapsed)} s) is below the MBR's minimum`, ['IN-36', 'IN-13']);
    }
    const ok = ep.maxTime === undefined || elapsed <= ep.maxTime;
    return {
      ok: true,
      data: { criterion: 'TIME', value: secondsText(elapsed), unit: 's', withinRange: ok, ...(reason !== undefined ? { reason } : {}), recordedBy: view.actor.id },
      ...(ok ? {} : { exceptions: [outOfRange(view, `${secondsText(elapsed)} s of massing`)] }),
    };
  }
  const id = text(entry['actual']);
  const actual = id === undefined ? undefined : usableActual(view, id);
  if (!actual || actual.data['tag'] !== ep.tag) {
    return refuse('TB04-ENDPOINT-VALUE', `The ${ep.criterion.toLowerCase()} end point of ${view.stepKey} names a usable collected value of ${ep.tag ?? '-'} of this step`, ['IN-36', 'DI-31']);
  }
  const manual = actual.data['source'] === 'MANUAL';
  if (manual && (reason === undefined || reason.trim() === '')) {
    return refuse('TB04-MANUAL-ENDPOINT', 'An end point called on a value keyed by hand needs a reason (and a second person)', ['IN-36', 'DI-32']);
  }
  const value = String(actual.data['value']);
  const ok = within(value, ep.min, ep.max);
  return {
    ok: true,
    data: { criterion: ep.criterion, actual: actual.id, value, unit: actual.data['unit'], withinRange: ok, ...(reason !== undefined ? { reason } : {}), recordedBy: view.actor.id },
    ...(manual ? { verificationRequired: true } : {}),
    ...(ok ? {} : { exceptions: [outOfRange(view, `${value} ${String(actual.data['unit'])}`)] }),
  };
}

function acceptBinder(view: HandlerView, entry: Entry): EntryResult {
  const q = quantityOf(entry['quantity']);
  const range = binderRangeOf(view.config);
  if (!q || (range && q.unit !== range.unit)) return refuse('TB04-BINDER-UNIT', `Binder is added in ${range?.unit ?? 'one unit'}`, ['IN-36', 'PR-29']);
  return { ok: true, data: { preparation: entry['preparation'], quantity: q, addedBy: view.actor.id } };
}

function acceptExtra(view: HandlerView, entry: Entry): EntryResult {
  const x = extraFluidOf(view.config);
  if (!x) return refuse('TB04-EXTRA-NOT-ALLOWED', `${view.phase.id} is not a step where the MBR allows extra granulating fluid`, ['IN-36', 'PR-29']);
  if (!view.actor.roles.some((r) => x.roles.includes(r))) {
    return refuse('TB04-EXTRA-ROLE', `Extra granulating fluid is added only by ${x.roles.join(' or ')}`, ['IN-36', 'PR-29']);
  }
  const q = quantityOf(entry['quantity']);
  if (!q || q.unit !== x.max.unit) return refuse('TB04-EXTRA-UNIT', `Extra fluid is recorded in ${x.max.unit}`, ['IN-36']);
  const total = sumOf([...view.entries('EXTRA_FLUID').map((e) => quantityOf(e.data['quantity']) ?? q), q]) ?? q;
  const ok = Dec.parse(total.value).lte(Dec.parse(x.max.value));
  return {
    ok: true,
    data: { quantity: q, reason: entry['reason'], withinMaximum: ok, addedBy: view.actor.id },
    ...(ok
      ? {}
      : {
          exceptions: [
            {
              type: 'EXTRA_FLUID_OVER_MAXIMUM',
              title: `Extra granulating fluid at ${view.stepKey} totals ${total.value} ${total.unit}, above the MBR's maximum of ${x.max.value} ${x.max.unit}: the steps after it wait for a deviation`,
              controls: ['IN-36', 'PR-29'],
              severity: 'ACTION',
              category: 'DEVIATION_OR_OVERRIDE',
              blocks: 'DOWNSTREAM',
              until: 'DEVIATION',
              deviationRequired: true,
            } satisfies ExceptionDraft,
          ],
        }),
  };
}

function beforePerform(view: HandlerView): HandlerProblem[] {
  const out = processBeforePerform(view);
  if (endPointOf(view.config) && view.entries('END_POINT').length === 0) out.push(problem('TB04-NO-ENDPOINT', `Record the end point of ${view.stepKey} first`, ['IN-36', 'PR-29']));
  if (extraFluidOf(view.config) && view.entries('EXTRA_FLUID').length === 0) out.push(problem('TB04-NO-EXTRA', `${view.stepKey} is the extra-fluid branch and records no extra fluid`, ['IN-36']));
  return out;
}

function onPerform(view: HandlerView): { exceptions?: ExceptionDraft[] } {
  const range = binderRangeOf(view.config);
  if (!range) return {};
  const total = sumOf(view.entries('BINDER_ADDITION').map((e) => quantityOf(e.data['quantity']) ?? { value: '0', unit: range.unit })) ?? { value: '0', unit: range.unit };
  return within(total.value, range.min, range.max)
    ? {}
    : {
        exceptions: [
          {
            type: 'BINDER_QUANTITY_OUT_OF_RANGE',
            title: `The binder added at ${view.stepKey} totals ${total.value} ${total.unit}, outside the MBR's range of ${range.min} to ${range.max} ${range.unit}: the steps after it wait for a deviation`,
            controls: ['IN-36', 'PR-08', 'PR-29'],
            severity: 'ACTION',
            category: 'OUT_OF_LIMIT',
            blocks: 'DOWNSTREAM',
            until: 'DEVIATION',
            deviationRequired: true,
          },
        ],
      };
}

function checkConfig(phase: PhaseNode, config: Readonly<Record<string, JsonValue>>, mbr: MbrContent): ConfigProblem[] {
  const out = processConfigProblems(phase, config, mbr);
  const ep = endPointOf(config);
  const x = extraFluidOf(config);
  if (!ep && !x) out.push(configError('TB04-NOTHING', `Granulation step ${phase.id} names neither an end point nor an extra-fluid addition`, ['IN-36']));
  if (ep) {
    if (ep.criterion === 'TIME') {
      if (ep.tag !== undefined || ep.min !== undefined || ep.max !== undefined || (ep.minTime === undefined && ep.maxTime === undefined)) {
        out.push(configError('TB04-ENDPOINT', `The time end point of ${phase.id} has a minimum or maximum massing time and no tag or value range`, ['IN-36']));
      }
      if (ep.minTime !== undefined && ep.maxTime !== undefined && ep.minTime > ep.maxTime) out.push(configError('TB04-ENDPOINT', `The massing time of ${phase.id} runs from more to less`, ['IN-36']));
    } else {
      const actual = blocks.actualsOf(config).find((a) => a.tag === ep.tag);
      if (!actual) out.push(configError('TB04-ENDPOINT-TAG', `The ${ep.criterion.toLowerCase()} end point of ${phase.id} reads ${ep.tag ?? 'no tag'}, which the step does not collect`, ['IN-36', 'DI-31']));
      if (ep.minTime !== undefined || ep.maxTime !== undefined || (ep.min === undefined && ep.max === undefined)) out.push(configError('TB04-ENDPOINT', `The end point of ${phase.id} has a value range and no massing time`, ['IN-36']));
      if (ep.min !== undefined && ep.max !== undefined && Dec.parse(ep.min).gt(Dec.parse(ep.max))) out.push(configError('TB04-ENDPOINT', `The end point range of ${phase.id} runs from ${ep.min} to ${ep.max}`, ['IN-36']));
    }
    if (ep.item !== undefined) {
      const p = mbr.parameters.find((q) => q.id === ep.item);
      const unit = ep.criterion === 'TIME' ? 's' : blocks.actualsOf(config).find((a) => a.tag === ep.tag)?.unit;
      if (!p || !phase.records.includes(ep.item) || p.valueType !== 'DECIMAL' || (p.readings ?? 1) !== 1 || p.unit !== unit) {
        out.push(configError('TB04-ENDPOINT-ITEM', `The end-point item ${ep.item} of ${phase.id} is a single decimal the step records, in ${unit ?? 'the tag unit'}`, ['IN-36', 'INV-25']));
      }
    }
  }
  if (x) {
    const branch = ancestorsOf(mbr, phase.id).some((n) => n.kind === 'alternative' && n.decision.mode === 'OPERATOR_CHOICE');
    if (!branch) out.push(configError('TB04-EXTRA-NOT-IN-BRANCH', `Extra granulating fluid at ${phase.id} is allowed only inside an operator-choice branch`, ['IN-36', 'DI-34']));
    if (x.roles.length === 0) out.push(configError('TB04-EXTRA-ROLE', `Extra granulating fluid at ${phase.id} names no authorised role`, ['IN-36']));
  }
  const b = binderRangeOf(config);
  if (b && Dec.parse(b.min).gt(Dec.parse(b.max))) out.push(configError('TB04-BINDER-RANGE', `The binder range of ${phase.id} runs from ${b.min} to ${b.max}`, ['IN-36']));
  return out;
}

/** The parameters TB-04 computes (the end-point item); the engine refuses typing them (INV-25). */
function computedItems(phase: PhaseNode): string[] {
  const ep = endPointOf(phase.config);
  return ep?.item !== undefined ? [ep.item] : [];
}

export const TB04: BlockVersion = {
  type: 'TB-04',
  version: '1',
  title: 'Wet granulation with end point',
  edition: 'tablets',
  aliases: { tablets: 'TB-04' },
  level: 'PHASE',
  controls: CONTROLS,
  configSchema: {
    type: 'object',
    description: 'Process values through G-06, the end point (power, torque or massing time), the binder range and the extra-fluid branch',
    fields: {
      ...PROCESS_CONFIG_FIELDS,
      granulator: { type: 'string', enum: ['HIGH_SHEAR', 'FLUID_BED'], description: 'High-shear mixer granulator or fluid-bed granulator' },
      endPoint: {
        type: 'object',
        optional: true,
        description: 'How the end point is called',
        fields: {
          criterion: { type: 'string', enum: ['POWER', 'TORQUE', 'TIME'], description: 'Power or torque from the equipment, or the massing time' },
          tag: { type: 'string', pattern: TAG, optional: true, description: 'The collected tag the end point reads (POWER, TORQUE)' },
          min: { type: 'decimal', optional: true, description: 'Lowest end-point value (POWER, TORQUE)' },
          max: { type: 'decimal', optional: true, description: 'Highest end-point value (POWER, TORQUE)' },
          minTime: { ...DURATION, optional: true, description: 'Minimum massing time (TIME)' },
          maxTime: { ...DURATION, optional: true, description: 'Maximum massing time (TIME)' },
          item: { type: 'string', optional: true, description: 'The parameter the step records that the block computes from the end point (judged against its limit tiers)' },
        },
      },
      binder: {
        type: 'object',
        optional: true,
        description: 'The approved range of the total binder added',
        fields: { min: { type: 'decimal', min: '0', description: 'Lowest total' }, max: { type: 'decimal', min: '0', description: 'Highest total' }, unit: { type: 'string', description: 'Unit' } },
      },
      extraFluid: {
        type: 'object',
        optional: true,
        description: 'Extra granulating fluid allowed at this step (an operator-choice branch): maximum and authorised roles',
        fields: { max: POSITIVE_QUANTITY, roles: { type: 'array', minItems: 1, maxItems: 10, description: 'Roles allowed to add it', items: { type: 'string', description: 'Role code' } } },
      },
    },
  },
  entrySummaries: {
    ...PROCESS_SUMMARIES,
    MASSING_START: () => 'Wet massing started',
    END_POINT: (d) =>
      `End point by ${S.words(d['criterion'])}: ${S.amount(d['value'], d['unit'])}${S.str(d['withinRange']) !== '' ? `, ${S.inRange(d['withinRange'])}` : ''}${S.str(d['reason']) !== '' ? ` (${S.str(d['reason'])})` : ''}`,
    BINDER_ADDITION: (d) => `Binder solution added: ${S.qty(d['quantity'])}`,
    EXTRA_FLUID: (d) =>
      `Extra granulating fluid added: ${S.qty(d['quantity'])} (${S.val(d['reason'])})${d['withinMaximum'] === false ? ', above the maximum' : d['withinMaximum'] === true ? ', within the maximum' : ''}`,
  },
  dataSchema: {
    entries: {
      ...PROCESS_ENTRIES,
      MASSING_START: { type: 'object', description: 'Wet massing starts (server time)', fields: {} },
      END_POINT: {
        type: 'object',
        description: 'The end point is called',
        fields: {
          actual: { type: 'string', pattern: ENTRY_ID, optional: true, description: 'The collected value the end point reads (POWER, TORQUE)' },
          reason: { type: 'string', optional: true, description: 'Why, for an end point called on a value keyed by hand' },
        },
      },
      BINDER_ADDITION: {
        type: 'object',
        description: 'Binder solution added',
        fields: { preparation: { type: 'string', pattern: ENTRY_ID, description: 'The PREPARED entry of the solution (TB-03)' }, quantity: POSITIVE_QUANTITY },
      },
      EXTRA_FLUID: {
        type: 'object',
        description: 'Extra granulating fluid added (operator-choice branch)',
        fields: { quantity: POSITIVE_QUANTITY, reason: { type: 'string', description: 'Why it was needed' } },
      },
    },
  },
  checkConfig,
  handler: {
    computedItems,
    acceptEntry: (view, entry) => {
      if (isProcessKind(entry.kind)) return acceptProcessEntry(view, entry);
      switch (entry.kind) {
        case 'MASSING_START':
          if (view.entries('MASSING_START').length > 0) return refuse('TB04-MASSING-TWICE', `${view.stepKey} already started its wet massing`, ['IN-36']);
          return { ok: true, data: { startedBy: view.actor.id } };
        case 'END_POINT':
          return acceptEndPoint(view, entry);
        case 'BINDER_ADDITION':
          return acceptBinder(view, entry);
        case 'EXTRA_FLUID':
          return acceptExtra(view, entry);
        default:
          return refuse('TB04-ENTRY', `${entry.kind} is not an entry of a granulation step`, ['IN-36']);
      }
    },
    computeItems: (view) => {
      const ep = endPointOf(view.config);
      const e = view.entries('END_POINT')[0];
      if (!ep?.item || !e) return [];
      return [{ item: ep.item, value: { kind: 'DECIMAL', value: String(e.data['value']), unit: String(e.data['unit']) }, entries: [e.id] }];
    },
    beforePerform,
    onPerform,
  },
  exceptionRules: [
    ...PROCESS_EXCEPTION_RULES,
    { type: 'ENDPOINT_OUT_OF_RANGE', category: 'OUT_OF_LIMIT', severity: 'ACTION', summary: 'A granulation end point outside the MBR range', controls: ['IN-36', 'PR-08', 'PR-29'] },
    { type: 'BINDER_QUANTITY_OUT_OF_RANGE', category: 'OUT_OF_LIMIT', severity: 'ACTION', summary: 'The total binder added outside the approved range', controls: ['IN-36', 'PR-08', 'PR-29'] },
    { type: 'EXTRA_FLUID_OVER_MAXIMUM', category: 'DEVIATION_OR_OVERRIDE', severity: 'ACTION', summary: 'Extra granulating fluid above the MBR maximum', controls: ['IN-36', 'PR-29'] },
  ],
  simulatorModel: {
    exceptionTypes: () => [...PROCESS_EXCEPTION_RULES.map((r) => r.type), 'ENDPOINT_OUT_OF_RANGE', 'BINDER_QUANTITY_OUT_OF_RANGE', 'EXTRA_FLUID_OVER_MAXIMUM'],
    // Nominal: G-06's values, then the end point on the first collected value of the end-point tag (or after the
    // massing time). The binder additions name a TB-03 preparation and are driven by the run, not by this model.
    nominalEntries: (input) => {
      const out = processNominalEntries(input);
      const ep = endPointOf(input.config);
      if (!ep) return out;
      if (ep.criterion === 'TIME') return [...out, { kind: 'MASSING_START' }];
      const at = out.findIndex((e) => e.kind === 'ACTUAL' && e['tag'] === ep.tag);
      return at < 0 ? out : [...out, { kind: 'END_POINT', actual: `EN-${at + 1}` }];
    },
  },
  goldenFixture: {
    description:
      'A high-shear granulation: impeller speed read back, power and product temperature collected from the granulator; the end point called on the power value (4.20 kW, range 3.80 to 4.60 kW) and computed into the end-point item; performed and verified',
    controls: ['IN-36', 'PR-08', 'DI-31'],
    phase: {
      block: { type: 'TB-04', version: '1' },
      records: ['endPower'],
      config: {
        granulator: 'HIGH_SHEAR',
        setpoints: [{ tag: 'granulator.impeller_rpm', value: '150', unit: 'rpm', tolerance: '5' }],
        actuals: [
          { tag: 'granulator.power_kW', unit: 'kW', min: '1.00', max: '6.00' },
          { tag: 'granulator.product_temp_C', unit: 'degC', max: '40.0' },
        ],
        maxAgeSeconds: 3600,
        endPoint: { criterion: 'POWER', tag: 'granulator.power_kW', min: '3.80', max: '4.60', item: 'endPower' },
      },
      system: { kind: 'PLC', ref: 'SYS-RMG', recipe: 'RCP-GRAN', recipeVersion: '3' },
    },
    parameters: [
      {
        id: 'endPower',
        name: 'Granulation end-point power',
        valueType: 'DECIMAL',
        unit: 'kW',
        precision: { kind: 'DECIMALS', digits: 2 },
        role: 'PROCESS_ENDPOINT',
        criticality: 'CRITICAL',
        riskClass: 'HIGH',
        capture: 'AUTOMATION',
        limits: { unit: 'kW', ranges: [{ tier: 'INTERNAL_ACTION', low: { value: '3.80', inclusive: true }, high: { value: '4.60', inclusive: true }, rounding: 'USP_HALF_UP_AT_LIMIT_DECIMALS', source: { kind: 'VALIDATION_REPORT', ref: 'VR' } }] },
      },
    ],
    script: [
      { entry: { kind: 'RECIPE_CHECK', recipe: 'RCP-GRAN', recipeVersion: '3' } },
      { entry: { kind: 'SETPOINT_READBACK', tag: 'granulator.impeller_rpm', value: '150', unit: 'rpm', source: 'EQUIPMENT', readingId: '00000000-0000-4000-8000-000000000011', quality: 'GOOD', receivedAtUs: '1790582400000000' } },
      { entry: { kind: 'ACTUAL', tag: 'granulator.product_temp_C', value: '31.5', unit: 'degC', source: 'EQUIPMENT', readingId: '00000000-0000-4000-8000-000000000012', quality: 'GOOD', receivedAtUs: '1790582400000000' } },
      { entry: { kind: 'ACTUAL', tag: 'granulator.power_kW', value: '4.20', unit: 'kW', source: 'EQUIPMENT', readingId: '00000000-0000-4000-8000-000000000013', quality: 'GOOD', receivedAtUs: '1790582400000000' } },
      { entry: { kind: 'END_POINT', actual: 'EN-4' } },
    ],
    expect: { exceptions: [], values: { endPower: '4.20' }, status: 'COMPLETED' },
  },
  tests: ['apps/tablets-server/test/blocks/granulation/blocks.test.ts', 'apps/tablets-server/test/blocks/granulation/db-guards.test.ts'],
};
