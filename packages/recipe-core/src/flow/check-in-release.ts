/**
 * How the second person's check of a phase runs in this release where the MBR names a photo or printout as the
 * evidence of a critical value typed by hand (Phase 2 exit follow-up T12.DOC; DI-30, PR-14, DI-35).
 *
 * The validator allows such a phase a later review (VERIFIED) because the photo or printout will be there to review the
 * value against (GMP-WITNESS). In this release no value typed by hand can carry an attachment (EBMR-EXE-122, until an
 * attachment store exists), so the engine and the database check the phase by a witness within the witness window after
 * the act (engine 1.4.0, recipe-core 0325; decision T12.1) and, once no witness is possible, by the later review with an
 * exception for QA (engine 1.5.0, recipe-core 0333; T12.2). The validator warns (GMP-WITNESS-NO-ATTACHMENT) and the
 * designer's document says so, from this one reading.
 */
import type { Parameter, PhaseNode } from './model.ts';

/**
 * The items phase `p` records that are critical, typed by hand, and whose MBR parameter names a photo or a printout as
 * their evidence, in the phase's order; `parameter` looks an item up (an MBR's parameters, or the validator's analysis).
 */
export function handEntriesNamingAttachment(parameter: (id: string) => Parameter | undefined, p: Pick<PhaseNode, 'records'>): string[] {
  return p.records.filter((id) => {
    const par = parameter(id);
    return par !== undefined && par.criticality === 'CRITICAL' && par.capture === 'MANUAL' && (par.evidence === 'PHOTO' || par.evidence === 'PRINTOUT');
  });
}

/**
 * The items for which phase `p`'s check, a later review in the MBR (any check but WITNESSED), runs as a witness in this
 * release; empty when the phase has no check, the MBR already asks for the witness, or no such item is recorded.
 */
export function checkRunsAsWitness(parameter: (id: string) => Parameter | undefined, p: Pick<PhaseNode, 'records' | 'signatures'>): string[] {
  if (!p.signatures.check || p.signatures.check.meaning === 'WITNESSED') return [];
  return handEntriesNamingAttachment(parameter, p);
}
