/**
 * The nominal run of a catalogue item (decision 0026, S7 and S8): its example values in a one-step master, every
 * section recorded with values inside their limits, through the same engine and generic handler as any library block.
 */
import type { MbrContent } from '../../src/flow/model.ts';
import { libraryBlockType, libraryBlockVersion, nominalEntries, TIMER_STOP } from '../../src/library/index.ts';
import type { BlockDefinition, FieldDef } from '../../src/library/model.ts';
import { SEED_CATALOGUE, type SeedItem } from '../../src/library/seed/index.ts';
import { define, Run, T0, testRegistry } from '../engine/support.ts';
import { expr, mbrWith, phase } from '../flow/support.ts';

export function nominalRun(item: SeedItem): { exceptions: string[]; status: string | undefined } {
  return runItem(item, {}, false);
}

/**
 * A nominal run with some values of a section's entries changed (every entry of that section), to see the block judge
 * them. A step with an open exception cannot be signed as performed (ENG-BLOCKED): the run then stops there, as on the
 * floor, and its status says so.
 */
export function judgedRun(item: SeedItem, overrides: Readonly<Record<string, Readonly<Record<string, unknown>>>>): { exceptions: string[]; status: string | undefined } {
  return runItem(item, overrides, true);
}

function runItem(item: SeedItem, overrides: Readonly<Record<string, Readonly<Record<string, unknown>>>>, stopWhenBlocked: boolean): { exceptions: string[]; status: string | undefined } {
  const def = item.definition;
  const config = item.exampleUse as Record<string, unknown>;
  const lines = Object.values(item.exampleUse.bomLines ?? {});
  const inputs = Object.entries(item.exampleInputs ?? {});
  // S10: formula-line and batch-size inputs come from the master (BOM at the reference size, the batch's size), so the
  // example values are written there; the other inputs stay MBR inputs the phase reads.
  const ex = item.exampleInputs ?? {};
  const lineInputs = new Map((def.inputs ?? []).flatMap((i) => (i.kind === 'FORMULA_LINE' ? [[item.exampleUse.bomLines?.[i.slot], ex[i.id]] as const] : [])));
  const sizeInput = (def.inputs ?? []).find((i) => i.kind === 'BATCH_SIZE');
  const bom: MbrContent['bom'] = lines.map((id) => ({ id, material: `MAT-${id}`, role: 'ACTIVE', quantity: lineInputs.get(id) ?? { value: '10', unit: 'kg' } }));
  const p = phase('p', { block: { type: libraryBlockType(def.code), version: String(def.version) }, config: config as never, reads: inputs.map(([k]) => k) });
  const base = mbrWith({ kind: 'sequence', id: 'ops', children: [p, phase('after')] }, {
    bom,
    inputs: inputs.map(([id, v]) => ({ id, name: id, source: 'MASTER_DATA' as const, valueType: 'DECIMAL' as const, unit: v.unit })),
  });
  const size = sizeInput ? ex[sizeInput.id] : undefined;
  const mbr: MbrContent = size ? { ...base, header: { ...base.header, batchSizes: [{ id: 'BS', quantity: size }] } } : base;
  const d = define(mbr, { registry: testRegistry().extend(libraryBlockVersion(def, expr)) });
  const values = Object.fromEntries(inputs.map(([k, v]) => [k, { value: { kind: 'DECIMAL' as const, value: v.value, unit: v.unit }, source: 'seed example' }]));
  const batch = Run.issue(d, { inputs: values }, T0);
  batch.start('p');
  const entries = nominalEntries(def, config as never, mbr).map((e) => (overrides[e.kind] ? { ...e, ...overrides[e.kind] } : e));
  // A nominal run keeps its in-process checks on time while a timer runs (R3-ENG-4: the gap from the last round to the
  // step's end is held too): the hour before a timer stops is spent in 10-minute stretches, each closed by a round of
  // every per-interval section (the catalogue's intervals are 15 minutes or more).
  const rounds = entries.filter((e) => def.sections.some((s) => s.id === e.kind && s.repeat?.kind === 'PER_INTERVAL'));
  for (const e of entries) {
    if (e.kind === TIMER_STOP) {
      for (let i = 0; i < 6; i++) {
        batch.minutes(10 - rounds.length);
        for (const r of rounds) {
          batch.entry('p', r);
          batch.minutes(1);
        }
      }
    }
    batch.entry('p', e);
    batch.minutes(1);
  }
  try {
    batch.perform('p');
  } catch (e) {
    if (!stopWhenBlocked || !(e instanceof Error && e.message.includes('ENG-BLOCKED'))) throw e;
    return { exceptions: batch.exceptions().map((x) => x.type), status: batch.status('p') };
  }
  if (batch.status('p') === 'AWAITING_VERIFICATION') batch.verify('p');
  return { exceptions: batch.exceptions().map((x) => x.type), status: batch.status('p') };
}

/** The catalogue item `code`. */
export function byCode(code: string): SeedItem {
  const item = SEED_CATALOGUE.find((s) => s.definition.code === code);
  if (!item) throw new Error(`no catalogue item ${code}`);
  return item;
}

/** The field `id` of a catalogue item. */
export function fieldOf(item: SeedItem, id: string): FieldDef {
  const f = item.definition.sections.flatMap((s) => s.fields).find((x) => x.id === id);
  if (!f) throw new Error(`no field ${id} in ${item.definition.code}`);
  return f;
}

/**
 * Runs step `stepId` of an issued batch with the nominal entries of `def` under `config` (as the nominal run above):
 * started, every section recorded, signed as performed and, when it has a check, verified. For masters of several
 * library steps (Capsules C4).
 */
export function runNominalStep(batch: Run, stepId: string, def: BlockDefinition, config: Record<string, unknown>, mbr: MbrContent): void {
  batch.start(stepId);
  const entries = nominalEntries(def, config as never, mbr);
  const rounds = entries.filter((e) => def.sections.some((s) => s.id === e.kind && s.repeat?.kind === 'PER_INTERVAL'));
  for (const e of entries) {
    if (e.kind === TIMER_STOP) {
      for (let i = 0; i < 6; i++) {
        batch.minutes(10 - rounds.length);
        for (const r of rounds) {
          batch.entry(stepId, r);
          batch.minutes(1);
        }
      }
    }
    batch.entry(stepId, e);
    batch.minutes(1);
  }
  batch.perform(stepId);
  if (batch.status(stepId) === 'AWAITING_VERIFICATION') batch.verify(stepId);
}
