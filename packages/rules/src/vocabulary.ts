/**
 * The vocabulary of a rule (ADR 0023, decision 1): a typed tree that both backends give one meaning. The TypeScript
 * interpreter (interpret.ts) evaluates it; the SQL generator (a later PR) writes it as plain SQL over jsonb. So every node
 * here has an exact SQL reading, stated beside it, and nothing reads a clock, a sequence or a session.
 *
 * Values are JSON values as stored in jsonb, or ABSENT (a key that is not there: SQL NULL from `->`). A decimal is a JSON
 * string or number compared with the expression language's exact decimals (`Dec`), never a JavaScript number.
 */

/** Where a path starts: the rule's named inputs (a field's definition, an entry's values, the formulation's config). */
export type Root = string;

/** One step of a path: a fixed key, or a key computed by an expression (a field id read from the definition). */
export type Step = string | Node;

export type Node =
  /** A JSON literal. SQL: a jsonb literal. */
  | { op: 'lit'; value: string | boolean | null }
  /** The value at a path from a named input; ABSENT when any step is missing. SQL: `input -> step -> ...`. */
  | { op: 'path'; root: Root; steps: readonly Step[] }
  /** Whether a value is there (not ABSENT; JSON null is there). SQL: `x is not null`. */
  | { op: 'present'; of: Node }
  /** Equal, ABSENT counted as a value of its own (equal only to ABSENT). SQL: `a is not distinct from b` on jsonb. */
  | { op: 'same'; a: Node; b: Node }
  /** Exact decimal order; false when either side is ABSENT or not a decimal. SQL: `(a #>> '{}')::numeric < ...`. */
  | { op: 'lt' | 'lte' | 'gt' | 'gte'; a: Node; b: Node }
  /** Boolean logic over truth values (a value is true only when it is JSON true). SQL: and, or, not. */
  | { op: 'and' | 'or'; of: readonly Node[] }
  | { op: 'not'; of: Node }
  /** Whether a JSON array contains a value (false when either is ABSENT). SQL: `list @> jsonb_build_array(x)`. */
  | { op: 'in'; value: Node; list: Node };

/** A named predicate: a truth value of its inputs, with its own documentation and version. */
export interface Predicate {
  name: string;
  version: number;
  /** What it decides, in a sentence, and where the hand-written copies are (until they are replaced). */
  doc: string;
  inputs: readonly Root[];
  body: Node;
}

/** The exception a rule requires when its predicate holds. */
export interface Raise {
  type: string;
  severity: 'ACTION' | 'CRITICAL';
  category: string;
  controls: readonly string[];
}

/** A rule over the fields of a section: for each field where `applies` holds, `raise` when `breached` holds. */
export interface FieldRule {
  name: string;
  version: number;
  doc: string;
  /** Inputs: `field` (the field's definition), `values` (the entry's values), `config` (the formulation's config). */
  applies: Node;
  breached: Node;
  /** The exception required, chosen by the first `when` that holds (the last entry has no `when`). */
  raise: readonly { when?: Node; then: Raise }[];
}

export const lit = (value: string | boolean | null): Node => ({ op: 'lit', value });
export const path = (root: Root, ...steps: Step[]): Node => ({ op: 'path', root, steps });
export const present = (of: Node): Node => ({ op: 'present', of });
export const same = (a: Node, b: Node): Node => ({ op: 'same', a, b });
export const and = (...of: Node[]): Node => ({ op: 'and', of });
export const or = (...of: Node[]): Node => ({ op: 'or', of });
export const not = (of: Node): Node => ({ op: 'not', of });
