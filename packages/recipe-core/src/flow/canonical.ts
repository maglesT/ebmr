/**
 * Canonical JSON and content hashes of MBR content (outline 5.2.1 "content hash computed"; 6.5
 * "every reference pinned by version and hash"; DI-04 evidence bound to the exact content).
 *
 * Reuses the kernel's e-signature canonical JSON rules (esig.canonicalJson: keys sorted by Unicode
 * code point, no insignificant white space, only safe integers as numbers), so an MBR hash and a
 * signature content hash over the same content always agree.
 */
import { esig } from '@ebmr/kernel';
import type { FlowNode, LibraryElement, MbrContent } from './model.ts';

export const canonicalJson: (value: unknown) => string = esig.canonicalJson;
export const sha256Hex: (text: string) => string = esig.sha256Hex;

/** SHA-256 (hex) of the canonical JSON of the whole content. */
export function mbrContentHash(mbr: MbrContent): string {
  return sha256Hex(canonicalJson(mbr));
}

/** Hash that pins a library element snapshot: level, symbols and body (the `ref` only says where it is filed). */
export function libraryElementHash(element: Pick<LibraryElement, 'level' | 'symbols' | 'body'>): string {
  return sha256Hex(canonicalJson({ level: element.level, symbols: element.symbols, body: element.body }));
}

/** Hash of any flow subtree (used by the diff to recognise unchanged fragments). */
export function flowNodeHash(node: FlowNode): string {
  return sha256Hex(canonicalJson(node));
}
