/**
 * The read-only view a block handler gets of one step instance (block contract, outline 6.6).
 */
import type { HandlerView } from '../blocks/contract.ts';
import type { StepDef } from './definition.ts';
import { ctxKey, type Tx } from './tx.ts';
import type { StepInstance } from './types.ts';
import { effectivePoint, pointsOf, resolveAt } from './values.ts';

export function makeView(tx: Tx, step: StepDef, inst: StepInstance): HandlerView {
  const phase = step.node;
  if (phase.kind !== 'phase') throw new Error(`${step.id} is not a phase`);
  const s = tx.s;
  const def = tx.def;
  const reps = inst.frames.map((f, i) => ({ f, i })).filter((x) => def.replicates.has(x.f.construct));
  const inner = reps[reps.length - 1];
  const subLot = inner ? s.subLots[`${inner.f.construct}@${ctxKey(inst.frames.slice(0, inner.i + 1))}`]?.id : undefined;
  return {
    phase,
    config: step.config,
    stepKey: inst.key,
    frames: inst.frames,
    subLot,
    nowUs: tx.now,
    startedAtUs: inst.startedAt,
    actor: tx.actor ?? { id: 'SYSTEM', kind: 'SYSTEM', roles: [] },
    batch: { batchId: s.header.batchId, batchNumber: s.header.batchNumber, productCode: def.mbr.header.product.code, marketSet: s.header.marketSet, batchSize: s.header.batchSize },
    mbr: def.mbr,
    expr: def.expr,
    entries: (kind) => Object.values(s.entries).filter((e) => e.stepKey === inst.key && (kind === undefined || e.kind === kind)).sort((a, b) => a.recordedSeq - b.recordedSeq),
    points: (item) => pointsOf(s, inst.key, item),
    effective: (item) => {
      const own = effectivePoint(s, inst.key, item);
      if (own?.value) return own.value;
      const r = resolveAt(def, s, item, inst.frames);
      return r.ok ? r.resolved.value : undefined;
    },
    target: (item) => inst.targets[item]?.value,
    containers: () => Object.values(s.containers),
    parameter: (id) => def.analysis.parameters.get(id),
  };
}
