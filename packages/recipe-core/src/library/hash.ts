/**
 * Content hash of a library block definition (review addition 4): the formulation pins `code@version` with this hash
 * when it is approved, and batches inherit the pin. Canonical JSON (sorted keys) so the hash does not depend on key
 * order; the same function the MBR content hash uses.
 */
import { canonicalJson, sha256Hex } from '@ebmr/expr';
import type { BlockDefinition } from './model.ts';

export function definitionHash(def: BlockDefinition): string {
  return sha256Hex(canonicalJson(def));
}
