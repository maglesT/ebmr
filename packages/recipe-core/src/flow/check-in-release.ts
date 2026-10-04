/**
 * How the second person's check of a phase runs in this release where the MBR names a photo or printout as the
 * evidence of a critical value (Phase 2 exit follow-up T12.DOC; DI-30, PR-14, DI-35).
 *
 * The validator allows such a phase a later review (VERIFIED) because the photo or printout will be there to review the
 * value against (GMP-WITNESS). In this release no value typed by hand can carry an attachment (EBMR-EXE-122, until an
 * attachment store exists), so the engine and the database check the phase by a witness within the witness window after
 * the act (engine 1.4.0, recipe-core 0325; decision T12.1) and, once no witness is possible, by the later review with an
 * exception for QA (engine 1.5.0, recipe-core 0333; T12.2). The validator warns (GMP-WITNESS-NO-ATTACHMENT) and the
 * designer's document says so, from this one reading.
 *
 * Round 2 (T12.DOC): in this release every value a step records is typed by hand on the step screen, whatever capture
 * the MBR names (the server stores every RECORD_DATA value as a hand entry, a scanned code included; no device, LIMS or
 * automation value reaches a step), and the engine decides from how the value was entered, not from the MBR's capture
 * (guards.ts handEntriesWithoutDeclaredEvidence). So every such item counts, whatever its capture, except the items the
 * step's block computes from its entries (a weighing step's mass totals), which are never typed.
 */
import type { CaptureMode, Parameter, PhaseNode } from './model.ts';

/**
 * The items phase `p` records that are critical, typed by hand in this release (any item but those its block computes,
 * `computed`), and whose MBR parameter names a photo or a printout as their evidence, in the phase's order; `parameter`
 * looks an item up (an MBR's parameters, or the validator's analysis).
 */
export function handEntriesNamingAttachment(parameter: (id: string) => Parameter | undefined, p: Pick<PhaseNode, 'records'>, computed: readonly string[] = []): string[] {
  return p.records.filter((id) => {
    if (computed.includes(id)) return false;
    const par = parameter(id);
    return par !== undefined && par.criticality === 'CRITICAL' && (par.evidence === 'PHOTO' || par.evidence === 'PRINTOUT');
  });
}

/**
 * The items for which phase `p`'s check, a later review in the MBR (any check but WITNESSED), runs as a witness in this
 * release; empty when the phase has no check, the MBR already asks for the witness, or no such item is recorded.
 * `computed`: the items the phase's block computes from its entries (blocks `computedItemsOf`), never typed by hand.
 */
export function checkRunsAsWitness(parameter: (id: string) => Parameter | undefined, p: Pick<PhaseNode, 'records' | 'signatures'>, computed: readonly string[] = []): string[] {
  if (!p.signatures.check || p.signatures.check.meaning === 'WITNESSED') return [];
  return handEntriesNamingAttachment(parameter, p, computed);
}

/** Of `items`, those whose MBR names another capture than by hand, with that capture: typed by hand in this release all the same. */
export function capturedOtherwise(parameter: (id: string) => Parameter | undefined, items: readonly string[]): { id: string; capture: Exclude<CaptureMode, 'MANUAL'> }[] {
  const out: { id: string; capture: Exclude<CaptureMode, 'MANUAL'> }[] = [];
  for (const id of items) {
    const capture = parameter(id)?.capture;
    if (capture !== undefined && capture !== 'MANUAL') out.push({ id, capture });
  }
  return out;
}

/** How the MBR says a value is captured, in words ("from a device"). */
export const CAPTURE_WORDS: Readonly<Record<Exclude<CaptureMode, 'MANUAL'>, string>> = {
  DEVICE: 'from a device',
  SCAN: 'by scanning',
  LIMS: 'from LIMS',
  AUTOMATION: 'from the automation system',
};
