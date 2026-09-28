/**
 * Content between the typed model and the wire (module C2). The contract carries MBR content as a loose JSON object
 * (flow.parseMbr checks it on both sides); these helpers convert without copying and parse what the server sends.
 */
import type { MbrContentWire } from '@ebmr/api-contract';
import { flow } from '@ebmr/recipe-core/pure';

export const asWire = (content: flow.MbrContent): MbrContentWire => content as unknown as MbrContentWire;

/** Parses content from the server; throws with the parser's problems (never expected for saved content). */
export function fromWire(content: MbrContentWire): flow.MbrContent {
  const parsed = flow.parseMbr(content);
  if (!parsed.ok) throw new Error(`The saved content is not well formed: ${parsed.problems.map((p) => `${p.path}: ${p.message}`).join('; ')}`);
  return parsed.mbr;
}
