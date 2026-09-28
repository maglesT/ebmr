/**
 * Reserved identifiers (DI-05, INV-18): the TypeScript mirror of migration 0810, for screens that
 * check an entry before it is submitted. The database stays the authority; a test proves both give
 * the same answer for the same input, and that the pattern table equals RESERVED_PATTERNS.
 *
 * Sandbox batch numbers, lot numbers and person and device labels carry the reserved prefix TEST-.
 * - A GMP database refuses any identifier whose NFKC form, after leading ASCII white space, starts
 *   with the prefix in any letter case.
 * - A sandbox accepts only identifiers matching the kind's sandbox pattern (ASCII, prefix first), so
 *   a real GMP identifier is never reused there.
 * Every sandbox pattern begins with `^TEST-` and is ASCII, so the two sets are disjoint.
 */
import type { InstallationKind } from './installation.ts';

export const RESERVED_PREFIX = 'TEST-';

export type IdentifierKind = 'BATCH_NUMBER' | 'LOT_NUMBER' | 'PERSON_LABEL' | 'DEVICE_LABEL';
export const IDENTIFIER_KINDS: readonly IdentifierKind[] = ['BATCH_NUMBER', 'LOT_NUMBER', 'PERSON_LABEL', 'DEVICE_LABEL'];

export interface ReservedPattern {
  identifierKind: IdentifierKind;
  /** Noun used in messages. */
  label: string;
  reservedPrefix: string;
  /** Regular expression (valid in PostgreSQL and JavaScript) matched against the ASCII-upper-cased value. */
  sandboxPattern: string;
  example: string;
  description: string;
}

export const RESERVED_PATTERNS: Readonly<Record<IdentifierKind, ReservedPattern>> = {
  BATCH_NUMBER: {
    identifierKind: 'BATCH_NUMBER',
    label: 'batch number',
    reservedPrefix: RESERVED_PREFIX,
    sandboxPattern: '^TEST-[A-Z0-9][A-Z0-9/.-]{0,26}$',
    example: 'TEST-B24-0001',
    description: 'Sandbox test-run and training batch numbers; at most 32 characters, within the site batch-number format.',
  },
  LOT_NUMBER: {
    identifierKind: 'LOT_NUMBER',
    label: 'lot number',
    reservedPrefix: RESERVED_PREFIX,
    sandboxPattern: '^TEST-[A-Z0-9][A-Z0-9/.-]{0,26}$',
    example: 'TEST-L24-0001',
    description: 'Sandbox material lots, containers and output lots; never a real lot number.',
  },
  PERSON_LABEL: {
    identifierKind: 'PERSON_LABEL',
    label: 'person label',
    reservedPrefix: RESERVED_PREFIX,
    sandboxPattern: "^TEST-[A-Z0-9][A-Z0-9 ._'-]{0,62}$",
    example: 'TEST-TRAINEE-01',
    description: 'Login names and displayed names of training and test persons, so a sandbox signature never shows a real name alone.',
  },
  DEVICE_LABEL: {
    identifierKind: 'DEVICE_LABEL',
    label: 'device label',
    reservedPrefix: RESERVED_PREFIX,
    sandboxPattern: '^TEST-[A-Z0-9][A-Z0-9._-]{0,57}$',
    example: 'TEST-SCALE-01',
    description: 'Codes of terminals, scales and instruments registered in the sandbox.',
  },
};

const compiled: Readonly<Record<IdentifierKind, RegExp>> = {
  BATCH_NUMBER: new RegExp(RESERVED_PATTERNS.BATCH_NUMBER.sandboxPattern),
  LOT_NUMBER: new RegExp(RESERVED_PATTERNS.LOT_NUMBER.sandboxPattern),
  PERSON_LABEL: new RegExp(RESERVED_PATTERNS.PERSON_LABEL.sandboxPattern),
  DEVICE_LABEL: new RegExp(RESERVED_PATTERNS.DEVICE_LABEL.sandboxPattern),
};

/** Upper-cases ASCII letters only (as sandbox.ascii_upper). */
export function asciiUpper(value: string): string {
  return value.replace(/[a-z]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 32));
}

/** Leading ASCII white space as PostgreSQL's ltrim(value, ' \t\n\v\f\r') removes it. */
const LEADING_ASCII_SPACE = /^[ \t\n\v\f\r]+/;

/** The first 64 characters (code points, as PostgreSQL's left()). */
const shown = (value: string): string => [...value].slice(0, 64).join('');

/** True when a GMP database refuses the value as a reserved test identifier. */
export function isReservedTestIdentifier(value: string, prefix: string = RESERVED_PREFIX): boolean {
  return asciiUpper(value.normalize('NFKC').replace(LEADING_ASCII_SPACE, '')).startsWith(prefix);
}

export type IdentifierProblemCode = 'EBMR-SBX-021' | 'EBMR-SBX-022';

export interface IdentifierProblem {
  code: IdentifierProblemCode;
  /** The same text the database raises. */
  message: string;
}

function isIdentifierKind(kind: string): kind is IdentifierKind {
  return (IDENTIFIER_KINDS as readonly string[]).includes(kind);
}

/** Why the value is not allowed in an installation of the given kind, or null when it is (a null value is not checked). */
export function identifierProblem(installation: InstallationKind, kind: IdentifierKind, value: string | null): IdentifierProblem | null {
  if (!isIdentifierKind(kind)) throw new Error(`Unknown identifier kind ${String(kind)}: no reserved test pattern is registered for it (DI-05). [EBMR-SBX-020]`);
  if (installation !== 'GMP' && installation !== 'SANDBOX') {
    throw new Error(`Unknown installation kind ${String(installation)}: expected GMP or SANDBOX (DI-05). [EBMR-SBX-020]`);
  }
  if (value === null) return null;
  const p = RESERVED_PATTERNS[kind];
  if (installation === 'GMP') {
    if (!isReservedTestIdentifier(value, p.reservedPrefix)) return null;
    return {
      code: 'EBMR-SBX-021',
      message: `"${shown(value)}" is a reserved test ${p.label} (prefix ${p.reservedPrefix}): a GMP database never accepts sandbox, training or simulation identifiers (DI-05, INV-18). [EBMR-SBX-021]`,
    };
  }
  if (compiled[kind].test(asciiUpper(value))) return null;
  return {
    code: 'EBMR-SBX-022',
    message: `"${shown(value)}" is not a test ${p.label}: in the sandbox every ${p.label} starts with ${p.reservedPrefix} (for example ${p.example}), so a real GMP identifier is never reused (DI-05). [EBMR-SBX-022]`,
  };
}

export class ReservedIdentifierError extends Error {
  readonly code: IdentifierProblemCode;
  constructor(problem: IdentifierProblem) {
    super(problem.message);
    this.name = 'ReservedIdentifierError';
    this.code = problem.code;
  }
}

export function assertIdentifierAllowed(installation: InstallationKind, kind: IdentifierKind, value: string | null): void {
  const problem = identifierProblem(installation, kind, value);
  if (problem) throw new ReservedIdentifierError(problem);
}

/**
 * Builds a sandbox identifier from a body, e.g. testIdentifier('BATCH_NUMBER', 'B24-0001') ->
 * 'TEST-B24-0001'. Throws when the result is not a valid sandbox identifier of that kind.
 */
export function testIdentifier(kind: IdentifierKind, body: string): string {
  const value = `${RESERVED_PREFIX}${body}`;
  assertIdentifierAllowed('SANDBOX', kind, value);
  return value;
}

/** INV-18 second half, as sandbox.batch_issue_problem_for: why a batch may not be issued, or null. */
export function batchIssueProblem(installation: InstallationKind, marketStates: readonly (string | null)[]): string | null {
  if (installation !== 'GMP' && installation !== 'SANDBOX') {
    throw new Error(`Unknown installation kind ${String(installation)}: expected GMP or SANDBOX (DI-05). [EBMR-SBX-020]`);
  }
  if (marketStates.length === 0) return 'A batch needs an MBR version and at least one market (INV-18). [EBMR-SBX-012]';
  if (installation === 'SANDBOX') return null;
  const bad = [...new Set(marketStates.filter((s) => s !== 'CURRENT' && s !== 'BRIDGING').map((s) => s ?? 'none'))].sort(compareC);
  if (bad.length === 0) return null;
  return `A GMP batch is issued only from an MBR version that is CURRENT or BRIDGING for every market of the batch; found ${bad.join(', ')}. Test runs of other versions belong in the sandbox (DI-05, INV-18). [EBMR-SBX-012]`;
}

/** Byte-wise (C collation) comparison, as the database orders these texts. */
function compareC(a: string, b: string): number {
  const x = Buffer.from(a, 'utf8');
  const y = Buffer.from(b, 'utf8');
  return Buffer.compare(x, y);
}
