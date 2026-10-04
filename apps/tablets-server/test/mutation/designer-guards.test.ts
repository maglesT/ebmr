/**
 * The designer's database guards, rule by rule (SQL mutation group "designer-guards": tablets 0150 and 0280,
 * recipe-core 0324). These tests close the gaps the SQL mutation run (tools/sql-mutation) found in the group's tests
 * (test/designer/references.test.ts, justification-binding.test.ts, market-set.test.ts, roles.test.ts and
 * test/execution/db-guards-content-roles.test.ts):
 *   - tab.designer_actor: a designer record written outside a validated command is refused (EBMR-TAB-150), whoever
 *     writes it;
 *   - tab.reference_document_guard: each rule of the body's shape on its own (the format, its version, the known
 *     members; EBMR-TAB-151), and each column that must be exactly what the body says, on its own (kind, code, version,
 *     title, effective date; EBMR-TAB-151);
 *   - tab.record_reference_document: an effective date that is not YYYY-MM-DD (EBMR-TAB-151);
 *   - tab.retire_reference_document: an unknown document (EBMR-TAB-153), a date before the document took effect or none
 *     (EBMR-TAB-154), and a retirement on the very day it took effect;
 *   - tab.record_designer_justification (both forms) and tab.designer_justification_guard: an unknown version
 *     (EBMR-RCP-020), a version without content (EBMR-TAB-155), a justification written for other content or for none
 *     (EBMR-TAB-156, with its own reason), and the form that names no content (the owner's only) binding the row to the
 *     latest revision;
 *   - tab.validator_justification_guard: the justification in force for a finding key is the latest of that key on that
 *     version, not the version's latest of another key nor another version's of the same key;
 *   - recipe.content_nodes and recipe.content_role_problem: which members hold child nodes, a phase checked by one person
 *     only (no performer), and the chooser roles of a decision only a person makes.
 * The product's writers are called with the application role's own credentials (ADR 0012), as the designer's server
 * does. What only the table owner can write (a reference document whose columns are not taken from its body, a version
 * row without its content, a call of the writer that names no content) is written as ebmr_owner, the owner of every
 * table and SECURITY DEFINER function here, in a transaction rolled back at the end; a test that needs no command
 * writes outside one. The private functions of recipe-core 0324 are called as the superuser, as the module tests do.
 *
 * Controls: DI-04, DI-14, IN-02, PR-03, PR-14, PR-45; invariant INV-26.
 */
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { canonicalJson, sha256Hex } from '@ebmr/expr';
import { identity, toDbContext, withCommand, type ActorContext } from '@ebmr/kernel';
import type { VersionView } from '@ebmr/api-contract';
import { lifecycle } from '@ebmr/recipe-core';
import type { flow } from '@ebmr/recipe-core/pure';
import { openPersonaSession } from '@ebmr/test-kit';
import { loadValidationContext } from '../../src/features/designer/adapters/expressions.ts';
import { DEMO_NOTICE } from '../../src/features/designer/reference-catalogue.ts';
import type { TestBrowser, TestServer } from '../support/harness.ts';
import { createFamily, edited, findPhase, saveContent, startDesignerServer, stewardActor, valueOf } from '../designer/support.ts';

let server: TestServer;
let author: TestBrowser;
let steward: ActorContext;
let authorActor: ActorContext;

beforeAll(async () => {
  server = await startDesignerServer();
  author = await server.asPersona('author');
  steward = await stewardActor(server);
  authorActor = { ...(await openPersonaSession(server.db, server.seed, 'author')), reasonCode: 'TEST', reasonText: 'designer guard test' };
}, 180_000);
afterAll(async () => {
  await server?.close();
});

type Json = Record<string, unknown>;
const ZERO = '00000000-0000-0000-0000-000000000000';
const hashOf = (body: unknown): string => sha256Hex(canonicalJson(body));

/** How a statement ended: 'ok', or the SQLSTATE and message of its refusal. */
interface Outcome {
  state: string;
  message: string;
}
async function outcomeOf(p: Promise<unknown>): Promise<Outcome> {
  try {
    await p;
    return { state: 'ok', message: '' };
  } catch (e) {
    const err = e as { code?: string; message?: string };
    return { state: err.code ?? '?', message: err.message ?? String(e) };
  }
}

/** A refusal raised by a guard (SQLSTATE P0001) with exactly this message. */
const refused = (message: string | RegExp) => ({ state: 'P0001', message: typeof message === 'string' ? message : expect.stringMatching(message) as unknown as string });

/** One statement in the owner's transaction, under a savepoint, so a refusal leaves the transaction usable. */
async function attempt(c: pg.PoolClient, sql: string, args: unknown[] = []): Promise<Outcome> {
  await c.query('savepoint attempt');
  const r = await outcomeOf(c.query(sql, args));
  await c.query(r.state === 'ok' ? 'release savepoint attempt' : 'rollback to savepoint attempt');
  return r;
}

/**
 * Work as ebmr_owner, the owner of the designer tables and of every SECURITY DEFINER function here, in a transaction
 * that is rolled back at the end: in the command of `actor`, or outside any command when `actor` is null.
 */
async function asOwner<T>(actor: ActorContext | null, work: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await server.db.admin.connect();
  try {
    await c.query('begin');
    if (actor) await c.query('select kernel.begin_command($1::jsonb)', [JSON.stringify(toDbContext(actor))]);
    await c.query('set local role ebmr_owner');
    return await work(c);
  } finally {
    await c.query('rollback');
    c.release();
  }
}

async function countOf(sql: string, args: unknown[]): Promise<number> {
  const { rows } = await server.db.admin.query<{ n: string }>(`select count(*)::text as n from (${sql}) x`, args);
  return Number(rows[0]?.n);
}

// ---------------------------------------------------------------------------------------------------------------------
// Reference documents (tablets 0150; DI-04, DI-14)
// ---------------------------------------------------------------------------------------------------------------------

/** A reference document body, ebmr.reference-document version 1, as the DMS stand-in stores it. */
function body(code: string, over: Json = {}): Json {
  return {
    format: 'ebmr.reference-document',
    formatVersion: 1,
    kind: 'SOP',
    code,
    version: '1',
    title: `Kill-test SOP ${code}`,
    effectiveFrom: '2024-03-01',
    summary: 'designer guard test',
    notice: DEMO_NOTICE,
    ...over,
  };
}

/** The steward records a body through the product's writer (with its own hash unless one is given). */
const recordReference = (content: unknown, hash = hashOf(content)) =>
  withCommand(server.db.app, steward, async (c) => (await c.query<{ id: string }>('select tab.record_reference_document($1::jsonb, $2) as id', [JSON.stringify(content), hash])).rows[0]?.id as string);

const referenceRows = (code: string) => countOf('select 1 from tab.reference_document where code = $1', [code]);

/** The owner's insert of a reference document row, its columns given separately from its body. */
const INSERT_REFERENCE = `insert into tab.reference_document (kind, code, version, title, content, content_hash, effective_from, recorded_by_person, recorded_by_account, recorded_role)
  values ($1, $2, $3, $4, $5::jsonb, $6, $7::date, '${ZERO}', '${ZERO}', '') returning recorded_by_person, recorded_by_account, recorded_role`;

const SHAPE = 'A reference document body is an ebmr.reference-document version 1 object with known members only (DI-04). [EBMR-TAB-151]';
const COLUMNS = 'The kind, code, version, title and effective date of a reference document must be exactly those in its body (DI-04). [EBMR-TAB-151]';

describe('the reference-document register (tab.reference_document; DI-04, PR-03)', () => {
  it('[DI-14][DI-04] a reference document or its retirement written outside a validated command is refused (EBMR-TAB-150), even by the owner, and nothing is recorded', async () => {
    const content = body('SOP-KT-NOCMD');
    const outcomes = await asOwner(null, async (c) => [
      await attempt(c, INSERT_REFERENCE, ['SOP', 'SOP-KT-NOCMD', '1', content['title'], JSON.stringify(content), hashOf(content), '2024-03-01']),
      await attempt(c, `insert into tab.reference_document_retirement (document_id, status, effective_from, reason, recorded_by_person, recorded_by_account, recorded_role)
                        select id, 'RETIRED', '2030-01-01', 'outside a command', '${ZERO}', '${ZERO}', '' from tab.reference_document limit 1`),
    ]);
    const message = 'No validated command: designer records are written only inside a command started with kernel.begin_command (DI-14). [EBMR-TAB-150]';
    expect(outcomes).toEqual([refused(message), refused(message)]);
    // Control: the same row in the steward's command is recorded, attributed to the steward whatever the row said.
    const inCommand = await asOwner(steward, async (c) =>
      (await c.query<Json>(INSERT_REFERENCE, ['SOP', 'SOP-KT-NOCMD', '1', content['title'], JSON.stringify(content), hashOf(content), '2024-03-01'])).rows,
    );
    expect(inCommand).toEqual([{ recorded_by_person: steward.personId, recorded_by_account: steward.accountId, recorded_role: steward.roleCode }]);
    expect(await referenceRows('SOP-KT-NOCMD')).toBe(0);
  });

  it('[DI-04][PR-03] a body that is not ebmr.reference-document version 1 with known members only is refused by the steward\'s writer, each rule on its own (EBMR-TAB-151)', async () => {
    const cases: [string, Json][] = [
      ['another format, version 1, known members', body('SOP-KT-FMT', { format: 'ebmr.other-document' })],
      ['format version 2', body('SOP-KT-FV2', { formatVersion: 2 })],
      ['format version "1" as text', body('SOP-KT-FVS', { formatVersion: '1' })],
      ['an unknown member', body('SOP-KT-MEMBER', { author: 'someone' })],
    ];
    for (const [what, content] of cases) {
      // The hash is the body's own, so nothing but the shape is wrong.
      expect(await outcomeOf(recordReference(content)), what).toEqual(refused(SHAPE));
      expect(await referenceRows(content['code'] as string), what).toBe(0);
    }
    // Control: the well-formed body is recorded, with the hash of its canonical JSON.
    const ok = body('SOP-KT-SHAPE-OK');
    const id = await recordReference(ok);
    const { rows } = await server.db.admin.query('select kind, code, version, title, effective_from::text as effective_from, content_hash from tab.reference_document where id = $1', [id]);
    expect(rows).toEqual([{ kind: 'SOP', code: 'SOP-KT-SHAPE-OK', version: '1', title: ok['title'], effective_from: '2024-03-01', content_hash: hashOf(ok) }]);
  });

  it('[DI-04] a row whose kind, code, version, title or effective date is not exactly its body\'s is refused, each column on its own (EBMR-TAB-151), whoever writes it', async () => {
    // The steward's writer takes every column from the body, so only the owner can write such a row.
    const content = body('SOP-KT-COLS');
    const exact = ['SOP', 'SOP-KT-COLS', '1', content['title'] as string, JSON.stringify(content), hashOf(content), '2024-03-01'];
    const differing: [string, number, string][] = [
      ['kind', 0, 'MATERIAL'],
      ['code', 1, 'SOP-KT-COLS-X'],
      ['version', 2, '2'],
      ['title', 3, 'Another title'],
      ['effective date', 6, '2024-03-02'],
    ];
    const outcomes = await asOwner(steward, async (c) => {
      const out: Record<string, Outcome> = {};
      for (const [what, i, value] of differing) out[what] = await attempt(c, INSERT_REFERENCE, exact.map((x, j) => (j === i ? value : x)));
      out['exact'] = await attempt(c, INSERT_REFERENCE, exact);
      return out;
    });
    expect(outcomes).toEqual({
      kind: refused(COLUMNS),
      code: refused(COLUMNS),
      version: refused(COLUMNS),
      title: refused(COLUMNS),
      'effective date': refused(COLUMNS),
      exact: { state: 'ok', message: '' },
    });
  });

  it('[DI-04] the steward\'s writer refuses a body whose effective date is missing or not YYYY-MM-DD, before anything is written (EBMR-TAB-151)', async () => {
    const message = 'A reference document needs its effective date as YYYY-MM-DD (DI-04). [EBMR-TAB-151]';
    const missing = body('SOP-KT-NODATE');
    delete missing['effectiveFrom'];
    const cases: [string, Json][] = [
      ['no effective date', missing],
      ['2024/03/01', body('SOP-KT-SLASH', { effectiveFrom: '2024/03/01' })],
      ['20240301 as a number', body('SOP-KT-NUMBER', { effectiveFrom: 20240301 })],
    ];
    for (const [what, content] of cases) {
      expect(await outcomeOf(recordReference(content)), what).toEqual(refused(message));
      expect(await referenceRows(content['code'] as string), what).toBe(0);
    }
  });

  it('[DI-04] a retirement names a recorded document (EBMR-TAB-153) and a date no earlier than the day it took effect (EBMR-TAB-154); on that very day it is recorded', async () => {
    const doc = await recordReference(body('SOP-KT-RETIRE', { effectiveFrom: '2025-02-10' }));
    const retire = (id: string, date: string | null, status = 'RETIRED') =>
      withCommand(server.db.app, steward, async (c) => (await c.query<{ id: string }>('select tab.retire_reference_document($1, $2, $3::date, $4) as id', [id, status, date, 'kill test'])).rows[0]?.id);
    const retirements = (id: string) => countOf('select 1 from tab.reference_document_retirement where document_id = $1', [id]);

    const unknown = randomUUID();
    expect(await outcomeOf(retire(unknown, '2025-02-10'))).toEqual(refused(`Unknown reference document ${unknown}. [EBMR-TAB-153]`));
    expect(await retirements(unknown)).toBe(0);

    const early = 'A document cannot be retired or withdrawn before the date it took effect (DI-04). [EBMR-TAB-154]';
    expect(await outcomeOf(retire(doc, '2025-02-09'))).toEqual(refused(early));
    expect(await outcomeOf(retire(doc, null, 'WITHDRAWN'))).toEqual(refused(early));
    expect(await retirements(doc)).toBe(0);

    const id = await retire(doc, '2025-02-10', 'WITHDRAWN');
    const { rows } = await server.db.admin.query(
      'select document_id, status, effective_from::text as effective_from, reason, recorded_by_person, recorded_role from tab.reference_document_retirement where id = $1',
      [id],
    );
    expect(rows).toEqual([{ document_id: doc, status: 'WITHDRAWN', effective_from: '2025-02-10', reason: 'kill test', recorded_by_person: steward.personId, recorded_role: steward.roleCode }]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Warning justifications (tablets 0150, 0280; IN-02, DI-04, PR-03)
// ---------------------------------------------------------------------------------------------------------------------

const KEY = 'G07-TOLERANCE-MISSING@p-disp-exc';
const OTHER_KEY = 'DATA-SINGLE-WRITER@pX';

const justify = (versionId: string, key: string, text: string, contentHash: string | null) =>
  identity.withGuardedCommand(server.db.app, authorActor, async (c) =>
    (await c.query<{ r: { id: string; revision: number; content_hash: string } }>('select tab.record_designer_justification($1, $2, $3, $4) as r', [versionId, key, text, contentHash])).rows[0]?.r,
  );
const justifications = (versionId: string) => countOf('select 1 from tab.designer_justification where version_id = $1', [versionId]);

/** A new version (revision 1) and its revision 2 (the excipient tolerance removed), as the author saved them. */
async function twoRevisions(familyCode: string, quantity: string): Promise<{ v1: VersionView; v2: VersionView }> {
  const v1 = await createFamily(author, { familyCode, batchSizes: [{ quantity, unit: 'kg' }] });
  const v2 = valueOf(await saveContent(author, v1, edited(v1, (c) => (findPhase(c, 'p-disp-exc').config = {})), 'excipient tolerance removed'));
  return { v1, v2 };
}

describe('warning justifications are recorded for the version and content they name (IN-02, DI-04)', () => {
  it('[IN-02][DI-04] a justification of an unknown version is refused as such (EBMR-RCP-020), whichever form of the writer is called, while other versions exist', async () => {
    // The version named is checked, not whether any version exists: one is created first.
    await createFamily(author, { familyCode: 'PCM500-KT-OTHER', batchSizes: [{ quantity: '60.500', unit: 'kg' }] });
    expect(await countOf('select 1 from recipe.mbr_version', [])).toBeGreaterThan(0);
    const unknown = randomUUID();
    const message = `Unknown MBR version ${unknown} (EBMR-RCP-020)`;
    expect(await outcomeOf(justify(unknown, KEY, 'for no version', 'a'.repeat(64)))).toEqual(refused(message));
    // The form that names no content is the owner's only (0280 revoked it from the application role).
    const owner = await asOwner(authorActor, (c) => attempt(c, 'select tab.record_designer_justification($1, $2, $3)', [unknown, KEY, 'for no version']));
    expect(owner).toEqual(refused(message));
    expect(await justifications(unknown)).toBe(0);
  });

  it('[IN-02][DI-04] a justification written for content that is no longer the saved one, or for none, is refused with that reason (EBMR-TAB-156) and not recorded', async () => {
    const { v1, v2 } = await twoRevisions('PCM500-KT-STALE', '61.000');
    expect(v2.revision).toBe(2);
    const stale = await outcomeOf(justify(v1.versionId, KEY, 'written for revision 1', v1.contentHash));
    expect(stale).toEqual(
      refused(
        `The justification was written for content ${v1.contentHash.slice(0, 12)}, but the version was saved again (revision 2, content ${v2.contentHash.slice(0, 12)}); a justification answers the warning of the content it was written for, so it was not recorded (IN-02, DI-04). [EBMR-TAB-156]`,
      ),
    );
    const none = await outcomeOf(justify(v1.versionId, KEY, 'written for no content', null));
    expect(none).toEqual(
      refused(
        `The justification was written for content (none), but the version was saved again (revision 2, content ${v2.contentHash.slice(0, 12)}); a justification answers the warning of the content it was written for, so it was not recorded (IN-02, DI-04). [EBMR-TAB-156]`,
      ),
    );
    expect(await justifications(v1.versionId)).toBe(0);
    // Control: written for the saved content, it is recorded against revision 2 and its hash.
    expect(await justify(v1.versionId, KEY, 'written for revision 2', v2.contentHash)).toEqual(expect.objectContaining({ revision: 2, content_hash: v2.contentHash }));
  });

  it('[IN-02][DI-04] a version without content has nothing to justify (EBMR-TAB-155): the writer and the table refuse, whoever writes', async () => {
    // A version row without its content exists only where the owner writes one (recipe.insert_version writes both).
    const v = await createFamily(author, { familyCode: 'PCM500-KT-BARE', batchSizes: [{ quantity: '62.000', unit: 'kg' }] });
    const outcomes = await asOwner(authorActor, async (c) => {
      const bare = (
        await c.query<{ id: string }>(
          `insert into recipe.mbr_version (family_id, version_number, author_person, author_account)
           select family_id, version_number + 1, '${ZERO}', '${ZERO}' from recipe.mbr_version where id = $1 returning id`,
          [v.versionId],
        )
      ).rows[0]?.id as string;
      const message = `MBR version ${bare} has no content to justify. [EBMR-TAB-155]`;
      return {
        message,
        writer: await attempt(c, 'select tab.record_designer_justification($1, $2, $3, $4)', [bare, KEY, 'no content', v.contentHash]),
        ownerForm: await attempt(c, 'select tab.record_designer_justification($1, $2, $3)', [bare, KEY, 'no content']),
        insert: await attempt(
          c,
          `insert into tab.designer_justification (version_id, finding_key, text, content_revision, content_hash, person_id, account_id, role_code)
           values ($1, $2, 'no content', 1, $3, '${ZERO}', '${ZERO}', '')`,
          [bare, KEY, v.contentHash],
        ),
        rows: Number((await c.query<{ n: string }>('select count(*)::text as n from tab.designer_justification where version_id = $1', [bare])).rows[0]?.n),
      };
    });
    expect(outcomes).toEqual({ message: outcomes.message, writer: refused(outcomes.message), ownerForm: refused(outcomes.message), insert: refused(outcomes.message), rows: 0 });
  });

  it('[IN-02][DI-04] the form that names no content (the owner\'s only) records the justification against the version\'s latest revision and hash', async () => {
    const { v1, v2 } = await twoRevisions('PCM500-KT-OWNER', '63.000');
    const r = await asOwner(authorActor, async (c) => {
      const out = (await c.query<{ r: { id: string; revision: number; content_hash: string } }>('select tab.record_designer_justification($1, $2, $3) as r', [v1.versionId, KEY, 'owner form'])).rows[0]?.r;
      const row = (await c.query('select version_id, finding_key, text, content_revision, content_hash, person_id, role_code from tab.designer_justification where id = $1', [out?.id])).rows;
      return { out, row };
    });
    expect(r.out).toEqual({ id: expect.any(String) as unknown, revision: 2, content_hash: v2.contentHash });
    expect(r.row).toEqual([
      { version_id: v1.versionId, finding_key: KEY, text: 'owner form', content_revision: 2, content_hash: v2.contentHash, person_id: authorActor.personId, role_code: authorActor.roleCode },
    ]);
  });

  it('[IN-02][DI-04] VALIDATOR evidence holds a justification to the latest one of its own key on its own version: not another key\'s later one, nor another version\'s', async () => {
    const vA = await createFamily(author, { familyCode: 'PCM500-KT-EVA', batchSizes: [{ quantity: '64.000', unit: 'kg' }] });
    const vB = await createFamily(author, { familyCode: 'PCM500-KT-EVB', batchSizes: [{ quantity: '65.000', unit: 'kg' }] });
    const textA1 = 'Checked at reconciliation (key 1, version A).';
    const textA2 = 'Recorded in the room log (key 2, version A).';
    await justify(vA.versionId, KEY, textA1, vA.contentHash);
    await justify(vA.versionId, OTHER_KEY, textA2, vA.contentHash);
    const mbr = vA.content as unknown as flow.MbrContent;
    const report = lifecycle.createVerificationPort((await loadValidationContext(server.db.app, mbr)).context).validate(mbr);
    expect(report.errors).toBe(0);
    const by = authorActor.personId;
    const evidence = (carried: { key: string; text: string; by: string }[]) =>
      identity.withGuardedCommand(server.db.app, authorActor, (c) => lifecycle.recordEvidence(c, vA.versionId, 'VALIDATOR', lifecycle.validatorEvidence(report, carried)));

    // KEY's justification stays in force although OTHER_KEY's was recorded after it on the same version.
    const first = await evidence([{ key: KEY, text: textA1, by }]);
    expect({ result: first.result, problems: first.problems }).toEqual({ result: 'PASS', problems: [] });
    // Another version's later justification under the same key does not displace version A's.
    await justify(vB.versionId, KEY, 'Checked at reconciliation (key 1, version B).', vB.contentHash);
    const both = await evidence([
      { key: KEY, text: textA1, by },
      { key: OTHER_KEY, text: textA2, by },
    ]);
    expect({ result: both.result, problems: both.problems }).toEqual({ result: 'PASS', problems: [] });
    // Control: version B's text carried for version A is not in force there.
    const foreign = await evidence([{ key: KEY, text: 'Checked at reconciliation (key 1, version B).', by }]);
    expect(foreign.result).toBe('FAIL');
    expect(foreign.problems.join(' ')).toMatch(/justifications not recorded for this content \(revision 1\): G07-TOLERANCE-MISSING@p-disp-exc/);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Roles named by MBR content (recipe-core 0324; PR-45, INV-26, PR-14)
// ---------------------------------------------------------------------------------------------------------------------

const phase = (id: string, extra: Json = {}): Json => ({ kind: 'phase', id, ...extra });

async function nodeIds(content: unknown): Promise<string[]> {
  const { rows } = await server.db.admin.query<{ id: string }>("select n ->> 'id' as id from recipe.content_nodes($1::jsonb) n order by 1", [JSON.stringify(content)]);
  return rows.map((r) => r.id);
}

async function roleProblem(content: unknown): Promise<string | null> {
  const { rows } = await server.db.admin.query<{ p: string | null }>('select recipe.content_role_problem($1::jsonb) as p', [JSON.stringify(content)]);
  return rows[0]?.p ?? null;
}

describe('the roles MBR content names (recipe-core 0324; PR-45, INV-26, PR-14)', () => {
  it('[PR-45][INV-26] the flow nodes are reached only through the members that hold child nodes: a sequence\'s children, a parallel or alternative branch\'s body', async () => {
    const procedure = (children: unknown[]) => ({ procedure: { body: { kind: 'stage', id: 'S', body: { kind: 'sequence', id: 'Q', children } } } });
    const content = {
      ...procedure([
        // A phase carrying members of the same names (the parser refuses unknown members): not child lists.
        phase('P1', { children: [phase('X-CHILD')], branches: [{ id: 'b', body: phase('X-BRANCH') }] }),
        { kind: 'parallel', id: 'PAR', branches: [{ id: 'b1', body: phase('P2') }, { id: 'b2' }] },
        { kind: 'alternative', id: 'ALT', branches: [{ id: 'b1', body: { kind: 'operation', id: 'O', body: phase('P3') } }] },
        { kind: 'loop', id: 'L', body: phase('P4') },
        { kind: 'replicate', id: 'R', body: phase('P5') },
      ]),
      library: [{ ref: 'LIB', body: phase('LP') }, { ref: 'LIB-EMPTY' }],
    };
    expect(await nodeIds(content)).toEqual(['ALT', 'L', 'LP', 'O', 'P1', 'P2', 'P3', 'P4', 'P5', 'PAR', 'Q', 'R', 'S']);
    // A child list that is not an array holds no nodes (and is no error).
    const notArrays = procedure([
      { kind: 'sequence', id: 'Q-OBJ', children: phase('X-OBJ') },
      { kind: 'parallel', id: 'PAR-OBJ', branches: { id: 'b', body: phase('X-OBJ2') } },
      { kind: 'alternative', id: 'ALT-TEXT', branches: 'b' },
    ]);
    expect(await nodeIds(notArrays)).toEqual(['ALT-TEXT', 'PAR-OBJ', 'Q', 'Q-OBJ', 'S']);
  });

  it('[PR-14][INV-26] a phase checked by one person only (no performer: an automated step, S5a) names no performer, so its content is stored', async () => {
    const v = await createFamily(author, { familyCode: 'PCM500-KT-S5A', batchSizes: [{ quantity: '66.000', unit: 'kg' }] });
    const content = JSON.parse(JSON.stringify(v.content)) as flow.MbrContent;
    findPhase(content, 'p-disp-bal').signatures = { check: { meaning: 'VERIFIED', role: 'PRODUCTION_VERIFIER' } };
    expect(await roleProblem(content)).toBeNull();
    const saved = await identity.withGuardedCommand(server.db.app, authorActor, (c) =>
      c.query<{ r: { revision: number } }>('select recipe.save_content($1, $2::jsonb, $3, $4) as r', [v.versionId, JSON.stringify(content), hashOf(content), 'automated balance check']),
    );
    expect(saved.rows[0]?.r.revision).toBe(2);
    // Control: a performer it does name is checked.
    findPhase(content, 'p-disp-bal').signatures = { perform: { role: 'OPERATOR' }, check: { meaning: 'VERIFIED', role: 'PRODUCTION_VERIFIER' } };
    expect(await roleProblem(content)).toMatch(/^the performer of p-disp-bal is "OPERATOR", which is not an engine role a session can carry/);
  });

  it('[PR-45][INV-26] only a decision a person makes (OPERATOR_CHOICE of an alternative) names roles allowed to choose; a decision by data or a decision member elsewhere names nobody', async () => {
    const procedure = (node: Json) => ({ procedure: { body: { kind: 'sequence', id: 'Q', children: [node] } } });
    const branches = [{ id: 'b1', name: 'One', body: phase('P1') }, { id: 'b2', name: 'Two' }];
    // An alternative decided by recorded data: the engine never lets a person choose (ENG-DECISION-MODE).
    expect(await roleProblem(procedure({ kind: 'alternative', id: 'ALT-DATA', decision: { mode: 'DATA', roles: ['SHIFT_SUPERVISOR'] }, branches }))).toBeNull();
    // A parallel construct carrying a decision member: all its branches run; nobody chooses.
    expect(await roleProblem(procedure({ kind: 'parallel', id: 'PAR', decision: { mode: 'OPERATOR_CHOICE', roles: ['SHIFT_SUPERVISOR'] }, branches }))).toBeNull();
    // Control: the operator's choice of an alternative names its roles, and an unknown one is refused.
    expect(await roleProblem(procedure({ kind: 'alternative', id: 'ALT-OP', decision: { mode: 'OPERATOR_CHOICE', roles: ['SHIFT_SUPERVISOR'], reasonRequired: true }, branches }))).toMatch(
      /^a role allowed to choose a branch of ALT-OP is "SHIFT_SUPERVISOR", which is not an engine role/,
    );
  });
});
