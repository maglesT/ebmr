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
 *
 * Round 3 (T12.DOC): a phase whose MBR names no check at all is checked all the same. The engine asks for a second
 * person whenever a critical value is typed by hand (data.ts storePoint sets verificationRequired; a value whose MBR names
 * another capture, typed by hand, also raises MANUAL_ENTRY_FALLBACK), and for such a value whose MBR names a printout or
 * photo that check is the timed witness, then the later review with WITNESS_LATE (guards.ts checkMeanings), by a person
 * in the fallback verifier roles (steps.ts verify). So the reading covers a phase with no check as it covers a later
 * review, and the callers say which of the two the MBR names.
 *
 * Round 4 (T12.DOC): who gives such a check is not every person in the roles the check names. The engine asks for one of
 * those engine roles (the MBR's check role, else the policy's fallbackVerifierRoles), and the kernel signs a check only
 * in a role holding the check's permission: STEP.WITNESS for a witness, STEP.VERIFY for a later review (esig catalogue;
 * recipe.require_command_permission). Round 3 named every fallback verifier role, a production supervisor included, who
 * holds neither, and said QA (shop floor) gives the later review, which needs STEP.VERIFY. `checkersInRun` narrows the
 * roles the check names to those of the installation's `CheckerRoles` (read from the database: tab.engine_role_map and
 * the kernel role permissions), and the callers name those.
 */
import type { CaptureMode, Parameter, PhaseNode } from './model.ts';

/**
 * The engine roles of an installation in which a person may give each kind of second-person check (T12.DOC round 4): a
 * witness (WITNESSED) and a later review (VERIFIED, and every other check meaning, all of which need STEP.VERIFY). An
 * engine role counts when a kernel role carries it (tablets: tab.engine_role_map, through the permission named there) and
 * that kernel role also holds the check's permission (`CHECK_PERMISSIONS`).
 */
export interface CheckerRoles {
  witness: readonly string[];
  review: readonly string[];
}

/** The permission the kernel signs each kind of check with (esig catalogue WITNESSED and VERIFIED; recipe.require_command_permission). */
export const CHECK_PERMISSIONS: Readonly<Record<keyof CheckerRoles, string>> = { witness: 'STEP.WITNESS', review: 'STEP.VERIFY' };

/** Who may give a phase's check in the run, as the engine and the kernel decide it. */
export interface CheckersInRun {
  /** The engine roles the check names: the MBR's check role, else the engine policy's fallback verifier roles. */
  named: string[];
  /** Of `named`, those in which a person may witness (their kernel role holds STEP.WITNESS), in the same order. */
  witness: string[];
  /** Of `named`, those in which a person may give the later review (STEP.VERIFY), in the same order. */
  review: string[];
}

/**
 * Who may give phase `p`'s check in the run (T12.DOC round 4): of the roles the check names (the MBR's check role, else
 * `fallback`, the engine policy's fallbackVerifierRoles: steps.ts verify), those in which a person may witness and those in
 * which a person may give the later review in this installation (`checkers`).
 */
export function checkersInRun(p: Pick<PhaseNode, 'signatures'>, fallback: readonly string[], checkers: CheckerRoles): CheckersInRun {
  const named = p.signatures.check ? [p.signatures.check.role] : [...fallback];
  return { named, witness: named.filter((r) => checkers.witness.includes(r)), review: named.filter((r) => checkers.review.includes(r)) };
}

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
 * The items for which phase `p` is checked by a witness in this release although its MBR does not ask for one: its check
 * is a later review (VERIFIED), or the MBR names no check at all (round 3: the engine asks for a second person for every
 * critical value typed by hand, and for these items that check is the witness); empty when the MBR already asks for the
 * witness or no such item is recorded. `p.signatures.check` says which of the two the MBR names. `computed`: the items the
 * phase's block computes from its entries (blocks `computedItemsOf`), never typed by hand.
 */
export function checkRunsAsWitness(parameter: (id: string) => Parameter | undefined, p: Pick<PhaseNode, 'records' | 'signatures'>, computed: readonly string[] = []): string[] {
  if (p.signatures.check?.meaning === 'WITNESSED') return [];
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
