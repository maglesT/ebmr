/**
 * Assembling a formulation (master record) from library blocks (decision 0026, slice S9): a library step is a phase
 * naming LIB-<code>@<version>, with the product's values as its configuration and the content hash of the approved
 * version pinned in it; the master carries the snapshot of that version once (blockDefinitions). The database checks
 * the snapshot against the approved library when the master is approved (recipe-core 1810, EBMR-LIB-021).
 */
import type { JsonValue, MbrContent, PhaseNode } from '../flow/model.ts';
import { libraryBlockType } from './block-version.ts';
import { definitionHash } from './hash.ts';
import type { BlockDefinition } from './model.ts';

/** A new library step: the block's title as its name, the hash pinned, performer and checker from the block's signatures. */
export function libraryPhase(def: BlockDefinition, id: string, riskClass: string): PhaseNode {
  const perform = def.signatures.find((s) => s.meaning === 'PERFORMED');
  const check = def.signatures.find((s) => s.meaning === 'VERIFIED' || s.meaning === 'CHECKED');
  return {
    kind: 'phase',
    id,
    name: def.title,
    block: { type: libraryBlockType(def.code), version: String(def.version) },
    config: { hash: definitionHash(def) },
    records: [],
    computes: [],
    // A formula-line or batch-size input is read from the master's own BOM and batch size when the step runs
    // (scaling.ts), and an earlier-step value from the step it names (STEP_VALUE), so neither is a value the master
    // declares (demo finding D-1; Injectables I-1c).
    reads: (def.inputs ?? []).filter((i) => i.kind !== 'FORMULA_LINE' && i.kind !== 'BATCH_SIZE' && i.kind !== 'STEP_VALUE').map((i) => i.id),
    consumes: [],
    produces: [],
    uses: [],
    equipment: [],
    signatures: { perform: { role: perform?.role ?? 'PRODUCTION_OPERATOR' }, ...(check ? { check: { meaning: 'VERIFIED', role: check.role } } : {}) },
    significant: check !== undefined,
    riskClass,
  };
}

/**
 * The master's snapshots with `def` added (unchanged when it already carries that version). A different snapshot of the
 * same code@version is refused: one master carries one content per version (PR-05).
 */
export function withSnapshot(content: Pick<MbrContent, 'blockDefinitions'>, def: BlockDefinition): { [key: string]: JsonValue }[] {
  const list = [...(content.blockDefinitions ?? [])];
  const same = list.find((d) => d['code'] === def.code && d['version'] === def.version);
  if (same) {
    if (definitionHash(same as unknown as BlockDefinition) !== definitionHash(def)) throw new Error(`${def.code}@${String(def.version)} is already carried with other content`);
    return list;
  }
  list.push(structuredClone(def) as unknown as { [key: string]: JsonValue });
  return list;
}
