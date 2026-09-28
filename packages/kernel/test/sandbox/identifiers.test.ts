/**
 * Reserved identifiers (DI-05, INV-18): sandbox identifiers carry the TEST- prefix, a GMP database
 * refuses them, and the sandbox refuses everything else, so a real batch or lot number is never
 * reused there. The TypeScript mirror and the database give the same answer for the same input.
 */
import fc from 'fast-check';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  IDENTIFIER_KINDS,
  RESERVED_PATTERNS,
  assertIdentifierAllowed,
  batchIssueProblem,
  identifierProblem,
  isReservedTestIdentifier,
  testIdentifier,
  type IdentifierKind,
} from '../../src/sandbox/identifiers.ts';
import type { InstallationKind } from '../../src/sandbox/installation.ts';
import { createTestDatabase, type TestDatabase } from '../support/db.ts';

// Characters chosen to reach both sides of every rule: ASCII letters in both cases, separators, ASCII
// and Unicode white space, full-width and circled look-alikes of the prefix (NFKC folds them), and
// characters whose case mappings differ between Unicode and ASCII. No NUL (PostgreSQL text cannot hold it).
const ALPHABET = [
  'T', 'E', 'S', 't', 'e', 's', 'B', 'L', 'x', '0', '1', '9', '-', '_', '/', '.', ' ', "'", '\t', '\n', '\u000b', '\f', '\r',
  ' ', '　', 'Ｔ', 'Ｅ', 'Ｓ', '－', 'ⓣ', 'Ⓔ', 'ⓢ', 'ſ', 'ß', 'é', 'İ', 'ı', 'ﬅ', 'K', 'Å', '😀', 'ट', '‐',
];
const PREFIXES = ['', 'TEST-', 'test-', 'Test-', ' TEST-', '\t test-', 'ＴＥＳＴ－', 'ⓉⒺⓈⓉ-', 'TEST_', 'TEST', 'TEST -', 'TES-', 'XTEST-'];
const anyText = fc
  .tuple(fc.constantFrom(...PREFIXES), fc.string({ unit: fc.constantFrom(...ALPHABET), maxLength: 16 }))
  .map(([p, body]) => p + body);
const kindArb = fc.constantFrom<IdentifierKind>(...IDENTIFIER_KINDS);
const installationArb = fc.constantFrom<InstallationKind>('GMP', 'SANDBOX');
/** Bodies that make a valid sandbox identifier of every kind. */
const sandboxBody = fc.stringMatching(/^[A-Z0-9][A-Z0-9-]{0,20}$/);

describe('reserved identifiers: the rules', () => {
  it('[DI-05] every registered example is a valid sandbox identifier and a GMP database refuses it', () => {
    for (const kind of IDENTIFIER_KINDS) {
      const { example } = RESERVED_PATTERNS[kind];
      expect(identifierProblem('SANDBOX', kind, example)).toBeNull();
      expect(identifierProblem('GMP', kind, example)?.code).toBe('EBMR-SBX-021');
    }
  });

  it('[DI-05][INV-18] property: no identifier of any kind is accepted by both a GMP database and the sandbox', () => {
    fc.assert(
      fc.property(kindArb, anyText, (kind, value) => {
        const gmp = identifierProblem('GMP', kind, value);
        const sandbox = identifierProblem('SANDBOX', kind, value);
        expect(gmp !== null || sandbox !== null).toBe(true);
      }),
      { numRuns: 3000 },
    );
  });

  it('[DI-05][INV-18] property: every identifier the sandbox builds is refused by a GMP database', () => {
    fc.assert(
      fc.property(kindArb, sandboxBody, (kind, body) => {
        const id = testIdentifier(kind, body);
        expect(id.startsWith('TEST-')).toBe(true);
        expect(identifierProblem('GMP', kind, id)?.code).toBe('EBMR-SBX-021');
        expect(identifierProblem('GMP', kind, id.toLowerCase())?.code).toBe('EBMR-SBX-021');
      }),
      { numRuns: 500 },
    );
  });

  it('[DI-05] a GMP database also refuses look-alikes of the prefix: any letter case, leading white space, full-width and circled letters', () => {
    for (const value of ['TEST-B24-0001', 'test-b24-0001', 'TeSt-x', '  TEST-1', '\t\nTEST-1', ' TEST-1', 'ＴＥＳＴ－Ｂ１', 'ⓉⒺⓈⓉ-1', 'TEST-']) {
      expect(isReservedTestIdentifier(value), value).toBe(true);
      expect(() => assertIdentifierAllowed('GMP', 'BATCH_NUMBER', value)).toThrow(/EBMR-SBX-021/);
    }
    // Only the reserved prefix is refused: ordinary names and codes that merely start with the word stay usable.
    for (const value of ['B24-0001', 'L2409-0017', 'Test operator 1a2b', 'TESTOSTERONE-01', 'TEST_1', 'TEST 1', 'TES-1', 'XTEST-1', 'T​EST-1']) {
      expect(isReservedTestIdentifier(value), value).toBe(false);
      expect(identifierProblem('GMP', 'BATCH_NUMBER', value)).toBeNull();
    }
  });

  it('[DI-05] catalog: reusing a real lot number in the sandbox is blocked; only reserved test numbers are accepted', () => {
    for (const real of ['L2409-0017', 'AR/24/0077', 'B24-0001', '24-0001', 'ＴＥＳＴ－L1', ' TEST-L1', 'TEST_L1', 'TEST-']) {
      const problem = identifierProblem('SANDBOX', 'LOT_NUMBER', real);
      expect(problem?.code, real).toBe('EBMR-SBX-022');
    }
    expect(identifierProblem('SANDBOX', 'LOT_NUMBER', 'L2409-0017')?.message).toBe(
      '"L2409-0017" is not a test lot number: in the sandbox every lot number starts with TEST- (for example TEST-L24-0001), so a real GMP identifier is never reused (DI-05). [EBMR-SBX-022]',
    );
    expect(identifierProblem('SANDBOX', 'LOT_NUMBER', 'TEST-L2409-0017')).toBeNull();
    expect(identifierProblem('SANDBOX', 'PERSON_LABEL', 'test-asha.rao')).toBeNull(); // login names are lower case
    expect(identifierProblem('SANDBOX', 'PERSON_LABEL', "TEST-Asha D'Souza")).toBeNull();
    expect(identifierProblem('SANDBOX', 'DEVICE_LABEL', 'TEST-SCALE-01')).toBeNull();
    // Sandbox batch numbers stay within the site register's 32-character format.
    expect(identifierProblem('SANDBOX', 'BATCH_NUMBER', `TEST-${'1'.repeat(27)}`)).toBeNull();
    expect(identifierProblem('SANDBOX', 'BATCH_NUMBER', `TEST-${'1'.repeat(28)}`)?.code).toBe('EBMR-SBX-022');
  });

  it('[DI-05] messages name the rule and the control; unknown kinds are refused, null values are not checked', () => {
    expect(identifierProblem('GMP', 'BATCH_NUMBER', 'TEST-B1')?.message).toBe(
      '"TEST-B1" is a reserved test batch number (prefix TEST-): a GMP database never accepts sandbox, training or simulation identifiers (DI-05, INV-18). [EBMR-SBX-021]',
    );
    expect(() => identifierProblem('GMP', 'SERIAL' as IdentifierKind, 'x')).toThrow(/EBMR-SBX-020/);
    expect(() => identifierProblem('TRAINING' as InstallationKind, 'LOT_NUMBER', 'x')).toThrow(/EBMR-SBX-020/);
    expect(identifierProblem('GMP', 'LOT_NUMBER', null)).toBeNull();
    expect(identifierProblem('SANDBOX', 'LOT_NUMBER', null)).toBeNull();
    expect(() => testIdentifier('BATCH_NUMBER', 'b 1')).toThrow(/EBMR-SBX-022/);
  });

  it('[INV-18] a GMP batch comes only from a version CURRENT or BRIDGING for every market; the sandbox may test-run any version', () => {
    expect(batchIssueProblem('GMP', ['CURRENT'])).toBeNull();
    expect(batchIssueProblem('GMP', ['CURRENT', 'BRIDGING'])).toBeNull();
    expect(batchIssueProblem('GMP', ['CURRENT', 'SUPERSEDED'])).toMatch(/found SUPERSEDED\..*\[EBMR-SBX-012\]$/);
    expect(batchIssueProblem('GMP', ['IN_VERIFICATION', null, 'APPROVED', 'IN_VERIFICATION'])).toMatch(/found APPROVED, IN_VERIFICATION, none\./);
    expect(batchIssueProblem('GMP', [])).toMatch(/EBMR-SBX-012/);
    expect(batchIssueProblem('SANDBOX', ['IN_VERIFICATION'])).toBeNull();
    expect(batchIssueProblem('SANDBOX', ['DRAFT', 'WITHDRAWN'])).toBeNull();
    expect(batchIssueProblem('SANDBOX', [])).toMatch(/EBMR-SBX-012/);
  });
});

describe('reserved identifiers: the database and the TypeScript mirror agree', () => {
  let db: TestDatabase;
  beforeAll(async () => {
    db = await createTestDatabase();
  });
  afterAll(async () => {
    await db.drop();
  });

  it('[DI-05] the pattern table holds exactly the patterns the screens use', async () => {
    const { rows } = await db.app.query<{
      identifier_kind: string;
      label: string;
      reserved_prefix: string;
      sandbox_pattern: string;
      example: string;
      description: string;
    }>('select * from sandbox.reserved_identifier_pattern order by identifier_kind');
    const fromDb = Object.fromEntries(
      rows.map((r) => [
        r.identifier_kind,
        { identifierKind: r.identifier_kind, label: r.label, reservedPrefix: r.reserved_prefix, sandboxPattern: r.sandbox_pattern, example: r.example, description: r.description },
      ]),
    );
    expect(fromDb).toEqual(RESERVED_PATTERNS);
  });

  it('[DI-05] the pattern table refuses a pattern that could overlap GMP identifiers (no prefix anchor, non-ASCII, example outside the pattern)', async () => {
    const insert = (pattern: string, example: string) =>
      db.admin.query(
        `insert into sandbox.reserved_identifier_pattern (identifier_kind, label, reserved_prefix, sandbox_pattern, example, description)
         values ('SAMPLE_ID', 'sample id', 'TEST-', $1, $2, 'probe')`,
        [pattern, example],
      );
    await expect(insert('^[A-Z0-9-]+$', 'TEST-1')).rejects.toThrow(/check constraint/);
    await expect(insert('^TEST-[A-ZÄ0-9]+$', 'TEST-1')).rejects.toThrow(/check constraint/);
    await expect(insert('^TEST-[0-9]+$', 'TEST-A')).rejects.toThrow(/check constraint/);
    await expect(db.app.query("delete from sandbox.reserved_identifier_pattern where identifier_kind = 'LOT_NUMBER'")).rejects.toThrow(/permission denied/);
  });

  it('[DI-05][INV-18] property: sandbox.identifier_problem_for gives the same answer and message as identifierProblem, for both installation kinds', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(anyText, { minLength: 1, maxLength: 30 }), async (values) => {
        const { rows } = await db.app.query<{ i: InstallationKind; k: IdentifierKind; ord: string; problem: string | null }>(
          `select i, k, u.ord::text as ord, sandbox.identifier_problem_for(i, k, u.v) as problem
             from unnest($1::text[]) with ordinality u(v, ord)
             cross join unnest(array['GMP', 'SANDBOX']) i
             cross join unnest($2::text[]) k`,
          [values, IDENTIFIER_KINDS],
        );
        expect(rows).toHaveLength(values.length * 2 * IDENTIFIER_KINDS.length);
        for (const r of rows) {
          const value = values[Number(r.ord) - 1] as string;
          expect(r.problem, `${r.i} ${r.k} ${JSON.stringify(value)}`).toBe(identifierProblem(r.i, r.k, value)?.message ?? null);
        }
      }),
      { numRuns: 40 },
    );
  });

  it('[INV-18] property: sandbox.batch_issue_problem_for equals batchIssueProblem', async () => {
    const state = fc.constantFrom('CURRENT', 'BRIDGING', 'SUPERSEDED', 'WITHDRAWN', 'IN_VERIFICATION', 'APPROVED', 'DRAFT', null);
    await fc.assert(
      fc.asyncProperty(installationArb, fc.array(state, { maxLength: 5 }), async (installation, states) => {
        const { rows } = await db.app.query<{ p: string | null }>('select sandbox.batch_issue_problem_for($1, $2::text[]) as p', [installation, states]);
        expect(rows[0]?.p).toBe(batchIssueProblem(installation, states));
      }),
      { numRuns: 60 },
    );
  });
});
