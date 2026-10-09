/**
 * Canonical JSON and content hashes of MBR content (outline 5.2.1 "content hash computed"; 6.5
 * "every reference pinned by version and hash"; DI-04 evidence bound to the exact content).
 *
 * Uses the expression language's canonical JSON and SHA-256 (keys sorted by Unicode code point, no
 * insignificant white space, only safe integers as numbers), which follow the kernel's e-signature
 * rules byte for byte (test/integration/canonical-json.test.ts proves it, including the fixture MBRs),
 * so an MBR hash and a signature content hash over the same content always agree. expr runs in the
 * browser too, which keeps this folder free of the kernel (the `@ebmr/recipe-core/pure` subpath).
 */
import { canonicalJson as exprCanonicalJson, sha256Hex as exprSha256Hex } from '@ebmr/expr';
import type { FlowNode, LibraryElement, MbrContent } from './model.ts';

export const canonicalJson: (value: unknown) => string = exprCanonicalJson;
export const sha256Hex: (text: string) => string = exprSha256Hex;

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
