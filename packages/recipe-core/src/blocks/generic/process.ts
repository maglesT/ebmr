/**
 * Generic process blocks, version 1 (outline 6.6; tablets spec K-12, K-15, K-24): G-12 sampling, G-15
 * timer, hold time and transfer, G-24 reprocessing / rework gate (version 2, on the database's facts: reprocessing.ts).
 */
import { Dec } from '@ebmr/expr';
import { durationToMicros } from '../../flow/decimal.ts';
import type { BlockVersion, ExceptionDraft, HandlerProblem, HandlerView } from '../contract.ts';
import { convert, micros, problem, QUANTITY_SCHEMA, SKIPPABLE } from './common.ts';
import { G24V2 } from './reprocessing.ts';
import * as S from '../summary.ts';

// ---------------------------------------------------------------------------------------------
// G-12 Sampling

interface PlanItem {
  point: string;
  purpose: string;
  units: number;
}

/** The sampling plan: the phase's declared plan, else locations x replicates from the configuration. */
export function samplingPlan(view: Pick<HandlerView, 'phase' | 'config'>): PlanItem[] {
  if (view.phase.sampling && view.phase.sampling.length > 0) return view.phase.sampling.map((s) => ({ point: s.point, purpose: s.purpose, units: s.units }));
  const locations = typeof view.config['locations'] === 'number' ? view.config['locations'] : undefined;
  const replicates = typeof view.config['replicates'] === 'number' ? view.config['replicates'] : 1;
  const purpose = typeof view.config['purpose'] === 'string' ? view.config['purpose'] : 'SAMPLE';
  if (locations === undefined) return [];
  return Array.from({ length: locations }, (_, i) => ({ point: `L${i + 1}`, purpose, units: replicates }));
}

export const G12: BlockVersion = {
  type: 'G-12',
  version: '1',
  title: 'Sampling',
  edition: 'generic',
  aliases: { tablets: 'K-12', injectables: 'KB-09' },
  level: 'PHASE',
  controls: ['PR-29', 'PR-44', 'IN-20', 'IN-32'],
  configSchema: {
    type: 'object',
    description: 'Samples from a plan (the phase sampling plan, or locations x replicates), with system-generated ids and labels',
    fields: {
      locations: { type: 'integer', min: 1, max: 500, optional: true, description: 'Sampling locations (e.g. blend uniformity thief positions)' },
      replicates: { type: 'integer', min: 1, max: 100, optional: true, description: 'Samples per location' },
      purpose: { type: 'string', optional: true, description: 'What the samples are for (test id)' },
      skippable: SKIPPABLE,
    },
  },
  entrySummaries: {
    SAMPLE: (d) => `Sampled ${S.count(d['units'], 'unit')} at ${S.val(d['point'])} for ${S.val(d['purpose'])}${S.str(d['container']) !== '' ? `, from container ${S.str(d['container'])}` : ''}`,
  },
  dataSchema: {
    entries: {
      SAMPLE: {
        type: 'object',
        description: 'One sample taken',
        fields: {
          point: { type: 'string', description: 'Sampling point or location' },
          purpose: { type: 'string', description: 'Test the sample is for' },
          units: { type: 'integer', min: 1, max: 100000, description: 'Units or containers taken' },
          container: { type: 'string', optional: true, description: 'Source container' },
        },
      },
    },
  },
  handler: {
    acceptEntry: (view, entry) => {
      const plan = samplingPlan(view);
      if (plan.length > 0 && !plan.some((p) => p.point === entry['point'] && p.purpose === entry['purpose'])) {
        return { ok: false, problems: [problem('G12-NOT-PLANNED', `Sampling point ${String(entry['point'])} for ${String(entry['purpose'])} is not in the plan of ${view.phase.id}`, ['PR-29'])] };
      }
      const n = view.entries('SAMPLE').length + 1;
      const sampleId = `${view.batch.batchNumber}/${view.phase.id}${view.subLot ? `/${view.subLot}` : ''}/S${n}`;
      // Label content (IN-20(d)): material, batch, container, sample number, sampler and date.
      return {
        ok: true,
        data: { sampleId, point: entry['point'], purpose: entry['purpose'], units: entry['units'], ...(entry['container'] ? { container: entry['container'] } : {}), label: { product: view.batch.productCode, batch: view.batch.batchNumber, sample: sampleId, sampler: view.actor.id, takenAtUs: view.nowUs.toString() } },
      };
    },
    onPerform: (view) => {
      const plan = samplingPlan(view);
      const taken = view.entries('SAMPLE');
      const out: ExceptionDraft[] = [];
      for (const p of plan) {
        const got = taken.filter((e) => e.data['point'] === p.point && e.data['purpose'] === p.purpose).reduce((sum, e) => sum + Number(e.data['units']), 0);
        if (got < p.units) {
          out.push({
            type: 'SAMPLING_SHORTFALL',
            title: `Sampling at ${p.point} for ${p.purpose} took ${got} of the ${p.units} units the plan requires (${view.stepKey}); the steps after it wait for a deviation`,
            controls: ['PR-29', 'PR-44'],
            severity: 'ACTION',
            category: 'OUT_OF_LIMIT',
            blocks: 'DOWNSTREAM',
            until: 'DEVIATION',
            deviationRequired: true,
          });
        }
      }
      return { exceptions: out };
    },
    meanings: { perform: ['SAMPLE_TAKEN'] },
  },
  exceptionRules: [{ type: 'SAMPLING_SHORTFALL', category: 'OUT_OF_LIMIT', severity: 'ACTION', summary: 'Fewer units sampled than the plan requires', controls: ['PR-29', 'PR-44'] }],
  simulatorModel: {
    exceptionTypes: () => ['SAMPLING_SHORTFALL'],
    nominalEntries: ({ phase, config }) => samplingPlan({ phase, config }).map((p) => ({ kind: 'SAMPLE', point: p.point, purpose: p.purpose, units: p.units })),
  },
  goldenFixture: {
    description: 'A plan of 2 locations x 3 units with one location short: a sampling-shortfall exception (PR-29 catalog test)',
    phase: { block: { type: 'G-12', version: '1' }, config: { locations: 2, replicates: 3, purpose: 'BU' } },
    script: [{ entry: { kind: 'SAMPLE', point: 'L1', purpose: 'BU', units: 3 } }, { entry: { kind: 'SAMPLE', point: 'L2', purpose: 'BU', units: 2 } }],
    expect: { exceptions: ['SAMPLING_SHORTFALL'], status: 'COMPLETED' },
  },
  tests: ['packages/recipe-core/test/blocks/golden.test.ts'],
};

// ---------------------------------------------------------------------------------------------
// G-15 Timer, hold time and transfer

export const G15: BlockVersion = {
  type: 'G-15',
  version: '1',
  title: 'Timer, hold time, transfer',
  edition: 'generic',
  aliases: { tablets: 'K-15', injectables: 'KB-10' },
  level: 'PHASE',
  controls: ['PR-30', 'IN-13', 'IN-15', 'INV-20'],
  configSchema: {
    type: 'object',
    description: 'Timers are the MBR time constraints (engine); this step records a material transfer when configured',
    fields: { transfer: { type: 'boolean', optional: true, default: false, description: 'Record issued-by and received-by for a transfer (two different persons)' }, skippable: SKIPPABLE },
  },
  entrySummaries: {
    TRANSFER_ISSUED: (d, c) => `Transfer issued: ${S.nameOrText(c, d['material'])}${d['quantity'] ? `, ${S.qty(d['quantity'])}` : ''}`,
    TRANSFER_RECEIVED: (d, c) => `Transfer received: ${S.nameOrText(c, d['material'])}`,
  },
  dataSchema: {
    entries: {
      TRANSFER_ISSUED: { type: 'object', description: 'Material handed over', fields: { material: { type: 'string', description: 'What is transferred' }, quantity: { ...QUANTITY_SCHEMA, optional: true } } },
      TRANSFER_RECEIVED: { type: 'object', description: 'Material received', fields: { material: { type: 'string', description: 'What is received' } } },
    },
  },
  handler: {
    acceptEntry: (view, entry) => ({ ok: true, data: { ...entry, by: view.actor.id } }),
    beforePerform: (view) => {
      if (view.config['transfer'] !== true) return [];
      const issued = view.entries('TRANSFER_ISSUED');
      const received = view.entries('TRANSFER_RECEIVED');
      if (issued.length === 0 || received.length === 0) return [problem('G15-TRANSFER', 'A transfer records who issued and who received the material', ['IN-15', 'PR-30'])];
      if (issued.every((i) => received.every((r) => r.enteredBy === i.enteredBy))) return [problem('G15-TRANSFER', 'Issued by and received by must be different persons', ['IN-15'])];
      return [];
    },
  },
  exceptionRules: [
    { type: 'TIME_MAX_BREACH', category: 'TIME_LIMIT', severity: 'ACTION', summary: 'Maximum duration exceeded', controls: ['INV-20', 'PR-30'] },
    { type: 'TIME_MIN_BREACH', category: 'TIME_LIMIT', severity: 'ACTION', summary: 'Automatic event before its minimum', controls: ['INV-20'] },
  ],
  simulatorModel: { exceptionTypes: () => ['TIME_MAX_BREACH'], nominalEntries: ({ config }) => (config['transfer'] === true ? [{ kind: 'TRANSFER_ISSUED', material: 'MATERIAL' }] : []) },
  goldenFixture: {
    description: 'A hold step with a 10-30 min timer: signing performed after 12 min is on time',
    phase: { block: { type: 'G-15', version: '1' }, config: {} },
    timeConstraints: [
      { id: 'TC-HOLD', name: 'Hold before use', kind: 'TIMER', from: { node: 'p', event: 'START' }, to: { node: 'p', event: 'END' }, min: { value: '10', unit: 'min' }, max: { value: '30', unit: 'min' }, source: { kind: 'VALIDATION_REPORT', ref: 'VR' }, breach: 'EXCEPTION', pauses: 'INCLUDED' },
    ],
    script: [{ advanceUs: 12n * 60_000_000n }],
    expect: { exceptions: [], status: 'COMPLETED' },
  },
  tests: ['packages/recipe-core/test/blocks/golden.test.ts', 'packages/recipe-core/test/engine/time.test.ts'],
};

// ---------------------------------------------------------------------------------------------
// G-24 Reprocessing / rework gate

function sumQuantity(view: HandlerView, unit: string, extra?: { value: string; unit: string }): string | undefined {
  let total = Dec.ZERO;
  const all = [...view.entries('SOURCE_ADDITION').map((e) => e.data['quantity'] as { value: string; unit: string }), ...(extra ? [extra] : [])];
  for (const q of all) {
    const c = convert(view, q.value, q.unit, unit);
    if (c === undefined) return undefined;
    total = total.plus(Dec.parse(c));
  }
  return total.toString();
}

export const G24: BlockVersion = {
  type: 'G-24',
  version: '1',
  title: 'Reprocessing / rework gate',
  edition: 'generic',
  aliases: { tablets: 'K-24', injectables: 'KB-18' },
  level: 'PHASE',
  controls: ['PR-47', 'IN-18', 'IN-19'],
  configSchema: { type: 'object', description: 'Case and limits come from the phase reprocessing declaration (outline 5.2.9)', fields: {} },
  entrySummaries: {
    SOURCE_ADDITION: (d) =>
      `Added ${S.qty(d['quantity'])} from batch ${S.val(d['sourceBatch'])} of ${S.val(d['productCode'])}${d['containsRecovered'] === true ? ', which itself contains recovered material' : ''}`,
  },
  dataSchema: {
    startData: {
      type: 'object',
      description: 'Prior authorisation before execution: QCU approval citing an investigation and a risk evaluation',
      fields: {
        investigationRef: { type: 'string', description: 'Investigation or deviation the reprocessing answers' },
        riskEvaluationRef: { type: 'string', description: 'Risk evaluation (including shelf life for recovery)' },
        authorisationRef: { type: 'string', description: 'QCU authorisation record (its signature is verified by the kernel)' },
        authorisedBy: { type: 'string', description: 'Person id of the QCU approver' },
      },
    },
    entries: {
      SOURCE_ADDITION: {
        type: 'object',
        description: 'Material added from an earlier batch (recovery or reprocessing addition)',
        fields: {
          sourceBatch: { type: 'string', description: 'Source batch number' },
          productCode: { type: 'string', description: 'Product of the source batch' },
          quantity: QUANTITY_SCHEMA,
          manufacturedAtUs: { type: 'string', pattern: /^[0-9]{1,20}$/, description: 'Manufacture instant of the source (epoch microseconds)' },
          containsRecovered: { type: 'boolean', optional: true, description: 'The source itself contains recovered material (chained recovery is blocked)' },
        },
      },
    },
  },
  checkConfig: (phase) =>
    phase.reprocessing === undefined ? [{ code: 'G24-NO-CASE', severity: 'ERROR', message: `Reprocessing step ${phase.id} declares no case (whole-batch reprocessing, reprocessing addition, recovery)`, controls: ['PR-47', 'IN-19'] }] : [],
  handler: {
    beforeStart: (view, data) => {
      if (view.phase.reprocessing?.case === 'VALIDATED_RETREATMENT') return [];
      if (!data) return [problem('G24-NOT-AUTHORISED', `${view.phase.id} needs prior QCU authorisation citing an investigation and a risk evaluation before it starts`, ['PR-47', 'IN-19'])];
      if (data['authorisedBy'] === view.actor.id) return [problem('G24-SELF-AUTHORISED', 'The reprocessing is authorised by the quality unit, not by the person who performs it', ['PR-47'])];
      return [];
    },
    acceptEntry: (view, entry) => {
      const rp = view.phase.reprocessing;
      const problems: HandlerProblem[] = [];
      if (!rp || (rp.case !== 'RECOVERY' && rp.case !== 'REPROCESSING_ADDITION')) {
        return { ok: false, problems: [problem('G24-NO-ADDITION', `${view.phase.id} is not a recovery or reprocessing-addition step`, ['PR-47'])] };
      }
      if (entry['productCode'] !== view.batch.productCode) problems.push(problem('G24-OTHER-PRODUCT', `Material of product ${String(entry['productCode'])} cannot be added to a batch of ${view.batch.productCode}`, ['PR-47', 'IN-19']));
      if (entry['containsRecovered'] === true) problems.push(problem('G24-CHAINED', `Batch ${String(entry['sourceBatch'])} itself contains recovered material: chained recovery is blocked`, ['IN-19', 'PR-47']));
      const made = micros(entry['manufacturedAtUs']);
      const maxAge = rp.maxAge ? durationToMicros(rp.maxAge.value, rp.maxAge.unit) : undefined;
      if (made !== undefined && maxAge !== undefined && view.nowUs - made > maxAge) problems.push(problem('G24-TOO-OLD', `Batch ${String(entry['sourceBatch'])} is older than the MBR maximum of ${rp.maxAge?.value ?? ''} ${rp.maxAge?.unit ?? ''}`, ['IN-19', 'PR-47']));
      const sources = new Set([...view.entries('SOURCE_ADDITION').map((e) => String(e.data['sourceBatch'])), String(entry['sourceBatch'])]);
      if (rp.maxSourceBatches !== undefined && sources.size > rp.maxSourceBatches) problems.push(problem('G24-TOO-MANY-SOURCES', `At most ${rp.maxSourceBatches} source batches may be added`, ['IN-19']));
      if (rp.maxPercent !== undefined) {
        const size = view.mbr.header.batchSizes[0]?.quantity;
        const total = size ? sumQuantity(view, size.unit, entry['quantity'] as { value: string; unit: string }) : undefined;
        if (size && total !== undefined && Dec.parse(total).times(Dec.HUNDRED).gt(Dec.parse(size.value).times(Dec.parse(rp.maxPercent)))) {
          problems.push(problem('G24-TOO-MUCH', `The added material would exceed ${rp.maxPercent} % of the batch size`, ['IN-19', 'PR-47']));
        }
      }
      if (problems.length > 0) return { ok: false, problems };
      return { ok: true, data: { ...entry, case: rp.case } };
    },
    onPerform: (view) => ({
      exceptions: [
        {
          type: 'QC_ADDITIONAL_TESTING_DECISION',
          title: `${view.stepKey} added reprocessed or recovered material: QC must record a decision on additional testing before release`,
          controls: ['PR-47', 'IN-19'],
          severity: 'ALERT',
          category: 'DEVIATION_OR_OVERRIDE',
          blocks: 'NONE',
          releaseBlocking: true,
        },
      ],
    }),
  },
  exceptionRules: [{ type: 'QC_ADDITIONAL_TESTING_DECISION', category: 'DEVIATION_OR_OVERRIDE', severity: 'ALERT', summary: 'A QC decision on additional testing is required before release', controls: ['PR-47', 'IN-19'] }],
  simulatorModel: { exceptionTypes: () => ['QC_ADDITIONAL_TESTING_DECISION'], nominalEntries: () => [] },
  goldenFixture: {
    description: 'A recovery addition of 1.0 kg from an in-date batch of the same product, authorised beforehand; QC is flagged to decide on extra testing',
    phase: { block: { type: 'G-24', version: '1' }, config: {}, reprocessing: { case: 'RECOVERY', maxPercent: '3', maxAge: { value: '90', unit: 'd' }, maxSourceBatches: 2 } },
    script: [
      { startData: { investigationRef: 'INV-7', riskEvaluationRef: 'RA-9', authorisationRef: 'AUTH-3', authorisedBy: 'QA-1' } },
      { entry: { kind: 'SOURCE_ADDITION', sourceBatch: 'B-OLD', productCode: 'P', quantity: { value: '0.02', unit: 'kg' }, manufacturedAtUs: '1790000000000000' } },
    ],
    expect: { exceptions: ['QC_ADDITIONAL_TESTING_DECISION'], status: 'COMPLETED' },
  },
  tests: ['packages/recipe-core/test/blocks/golden.test.ts', 'packages/recipe-core/test/blocks/process.test.ts'],
};

export const PROCESS_BLOCKS: readonly BlockVersion[] = [G12, G15, G24, G24V2];
