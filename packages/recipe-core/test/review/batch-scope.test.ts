/**
 * The remaining batch acts are authorised in the batch's {site, product} scope (Phase 6 exit review 6jc-R16, the rest;
 * recipe-core 1217 and 1218; IN-04, DI-21, DI-17), as recipe-core 1100 did for step work and step signatures:
 *   * the GMP batch issue (recipe.prepare_gmp_issue, recipe.begin_gmp_issue, recipe.issue_gmp_execution): the issue
 *     command's permission at the actor's location with the order's product (the product of the MBR family planned);
 *   * the disposition proposals (recipe.propose_disposition, recipe.propose_hold_point_decision) and the proposal of an
 *     act for approval (recipe.propose_act): the command's permission at the actor's location with the batch's product;
 *   * the exception-register acts in review (recipe.review_exception, latest of 0601, 0713 and 0721).
 * Before, each checked the permission at the actor's location only. A request that names no product is matched by every
 * product-limited requirement (iam.requirement_applies fails closed), so a requirement limited to product A refused these
 * acts on every batch of the site. Now a requirement limited to another product no longer applies; one limited to this
 * product, or to none, applies as before, and a qualification held only from a stale mirror is still refused.
 *
 * As the application role through the real definers and seeded identities; each batch is issued from an effective
 * master as in the review tests. The requirements are test arrangement, put in force after the batch's set-up and ended
 * after each test.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withProtectedNumbers } from '../../../kernel/src/continuity/numbers.ts';
import { tempDir, tempLedger } from '../../../kernel/test/continuity/helpers.ts';
import { withCommand } from '../../../kernel/src/db/command.ts';
import { sign } from '../../../kernel/src/esig/signing.ts';
import { challengeFor, cmd, ensureSealKey, signatureAuth, testSealKey } from '../../../kernel/test/esig/helpers.ts';
import { permissionRequirement, qualify, underRequirement, withStaleLms, type Requirement } from '../../../kernel/test/identity/requirements.ts';
import { seedActor, seedServiceActor, type SeededActor } from '../../../kernel/test/identity/seed.ts';
import { createTestDatabase, type TestDatabase } from '../../../kernel/test/support/db.ts';
import { approveTestRelease } from '../../../kernel/test/support/validation.ts';
import type { Command } from '../../src/engine/index.ts';
import type { MbrContent } from '../../src/flow/model.ts';
import * as execution from '../../src/execution/index.ts';
import type * as lc from '../../src/lifecycle/index.ts';
import { define, FIXTURE_INPUTS, FIXTURE_JUSTIFICATIONS } from '../engine/support.ts';
import { gmpOrderFor } from '../lifecycle/gmp-support.ts';
import { cell, reason, seedCast, uniqueContent, World } from '../lifecycle/support.ts';

let db: TestDatabase;
let w: World;
let steward: SeededActor;
let operator: SeededActor;
let qaFloor: SeededActor;
let head: SeededActor;
let qaReviewer: SeededActor;
let erp: SeededActor;
let master: { familyId: string; content: MbrContent };
const dir = tempDir('batch-scope');
const ledger = tempLedger('batch-scope', dir.path);

const SITE = 'SITE-1';
const BS = 'BS-200K';
const FIXTURE = 'tablet-granulation-compression';
const other = () => `OTHER-${randomUUID().slice(0, 6).toUpperCase()}`;
type Json = Record<string, unknown>;

function without(content: unknown, types: readonly string[]): unknown {
  if (Array.isArray(content)) {
    return content.filter((x) => !(x && typeof x === 'object' && types.includes(String(((x as Json)['block'] as Json | undefined)?.['type'])))).map((x) => without(x, types));
  }
  if (content && typeof content === 'object') return Object.fromEntries(Object.entries(content).map(([k, v]) => [k, without(v, types)]));
  return content;
}

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'ok';
  } catch (e) {
    const m = /\b(EBMR-[A-Z]+-\d{3})\b/.exec(e instanceof Error ? e.message : String(e));
    return m?.[1] ?? (e instanceof Error ? e.message : String(e));
  }
}

async function messageOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'ok';
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

async function effective(): Promise<{ familyId: string; content: MbrContent }> {
  const m = uniqueContent(FIXTURE);
  m.header.product = { ...m.header.product, code: m.header.product.code.toUpperCase() };
  const content = without(m, ['G-09', 'G-10']) as MbrContent;
  const v = await w.approvedVersion(content);
  const auth: lc.MarketAuthorisationDefinition = { versionId: v.versionId, market: 'IN', kind: 'CURRENT', cells: [cell(SITE, 'L1', BS)], regulatoryBasis: 'IN: registration on file' };
  await w.authorise(auth);
  await w.run(steward, (c) =>
    c.query('select site.define_batch_number_rule($1::jsonb)', [
      JSON.stringify({ rule_code: `R-${randomUUID().slice(0, 8).toUpperCase()}`, site_code: SITE, product_code: content.header.product.code, batch_kind: 'PROCESSING', format: 'R{YY}{SEQ:5}', site_zone: 'Asia/Kolkata', reason: 'Numbering SOP-QA-017 rev 3' }),
    ]),
  );
  return { familyId: v.familyId, content };
}

const product = (): string => master.content.header.product.code;

/** The GMP batch planned from the effective master (recipe.prepare_gmp_issue). */
async function plan(batchId: string): Promise<void> {
  const erpOrder = await gmpOrderFor(db, erp, master.content, BS);
  await cmd(db, w.cast.issuer).then((ctx) =>
    withProtectedNumbers(db.app, ctx, ledger, (c) => execution.prepareGmpIssue(c, batchId, { familyId: master.familyId, markets: ['IN'], site: SITE, line: 'L1', batchSize: BS, erpOrder })),
  );
}

/** The planned batch signed ISSUED and issued (recipe.begin_gmp_issue, recipe.issue_gmp_execution). */
async function issue(batchId: string): Promise<void> {
  const signatureId = await w.sign(w.cast.issuer, 'batch_issue', batchId, 'ISSUED', 'PLANNED');
  await w.run(
    w.cast.issuer,
    (c) =>
      execution.issueGmpBatch(c, {
        batchId,
        signatureId,
        define: (x) => define(x, { installation: 'GMP', justifications: FIXTURE_JUSTIFICATIONS }),
        request: { inputs: FIXTURE_INPUTS[FIXTURE], issuedBy: { id: w.cast.issuer.personId, kind: 'PERSON', roles: [] } },
      }),
    reason('batch issued for the test'),
  );
}

async function issuedBatch(): Promise<string> {
  const batchId = randomUUID();
  await plan(batchId);
  await issue(batchId);
  return batchId;
}

const issuedStatus = async (batchId: string): Promise<string | undefined> =>
  (await db.app.query<{ s: string }>('select status as s from recipe.execution_state where batch_id = $1', [batchId])).rows[0]?.s;

async function run(who: SeededActor, batchId: string, command: Json, permission = 'STEP.EXECUTE', role = 'PRODUCTION_OPERATOR'): Promise<boolean> {
  return w.run(who, async (c) => {
    const tx = await execution.ExecutionTx.open(c, define(master.content, { installation: 'GMP', justifications: FIXTURE_JUSTIFICATIONS }), batchId);
    const { rows } = await c.query<{ id: string }>("select iam.require_permission($2, $1::jsonb) ->> 'evaluation_id' as id", [JSON.stringify({ site: SITE, area: 'DISP-01' }), permission]);
    const r = await tx.command({ ...command, commandId: randomUUID(), actor: { id: who.personId, kind: 'PERSON', roles: [role] } } as unknown as Command, [{ role, permission, evaluationId: rows[0]?.id ?? '' }]);
    return r.accepted;
  });
}

async function exceptionIds(batchId: string): Promise<string[]> {
  const { rows } = await db.admin.query<{ id: string }>('select exception_id as id from recipe.exception_register where batch_id = $1 order by exception_id', [batchId]);
  return rows.map((r) => r.id);
}

/** Raises an exception (no step) as the operator; returns its id. */
async function raise(batchId: string, description: string): Promise<string> {
  const before = await exceptionIds(batchId);
  expect(await run(operator, batchId, { type: 'RAISE_EXCEPTION', description, severity: 'ALERT' })).toBe(true);
  const id = (await exceptionIds(batchId)).find((x) => !before.includes(x));
  if (!id) throw new Error('no exception was raised');
  return id;
}

const JUSTIFICATION = 'No impact on the product: documentation only';
const propose = (batchId: string, exception: string, who: SeededActor = qaFloor) =>
  w.run(who, (c) => execution.proposeDisposition(c, batchId, exception, { outcome: 'NO_IMPACT', justification: JUSTIFICATION, deviationRef: null }));

/** The engine disposition of an exception by QA on the floor (EXCEPTION_DISPOSITIONED), signed in the command that records it. */
async function disposition(batchId: string, exception: string): Promise<void> {
  await propose(batchId, exception);
  await ensureSealKey(db);
  const ch = await challengeFor(db, qaFloor, `${batchId}:${exception}`, { meaning: 'EXCEPTION_DISPOSITIONED', aggregateType: 'batch_exception' });
  const ev = await signatureAuth(db, qaFloor, qaFloor, ch.challengeId);
  const accepted = await withCommand(db.app, await cmd(db, qaFloor), async (c) => {
    const s = await sign(c, { challengeId: ch.challengeId, authEventId: ev, expectedState: 'OPEN' }, testSealKey);
    const tx = await execution.ExecutionTx.open(c, define(master.content, { installation: 'GMP', justifications: FIXTURE_JUSTIFICATIONS }), batchId);
    const { rows } = await c.query<{ id: string }>("select iam.require_permission('QA.FLOOR_APPROVE', $1::jsonb) ->> 'evaluation_id' as id", [JSON.stringify({ site: SITE, area: 'DISP-01' })]);
    const r = await tx.command(
      { type: 'DISPOSITION_EXCEPTION', exception, outcome: 'NO_IMPACT', justification: JUSTIFICATION, signature: { id: s.signatureId, meaning: 'EXCEPTION_DISPOSITIONED', signer: qaFloor.personId }, commandId: randomUUID(), actor: { id: qaFloor.personId, kind: 'PERSON', roles: ['QA'] } } as unknown as Command,
      [{ role: 'QA', permission: 'QA.FLOOR_APPROVE', evaluationId: rows[0]?.id ?? '' }],
    );
    return r.accepted;
  });
  expect(accepted).toBe(true);
}

const proposals = async (batchId: string, exception: string): Promise<number> =>
  (await db.app.query('select 1 from recipe.execution_disposition_proposal where batch_id = $1 and exception_id = $2', [batchId, exception])).rowCount ?? 0;

// ---------------------------------------------------------------------------------------------------------------------
// Shared batches, built once before any requirement is in force.
// ---------------------------------------------------------------------------------------------------------------------

let running: string;
/** A completed, production-approved batch with dispositioned exceptions, each open to one query in QA review. */
let approved: { batchId: string; exceptions: string[] };

beforeAll(async () => {
  db = await createTestDatabase();
  // Slice 7c (DI-03, recipe-core 1250): a GMP batch is issued only on a release with an approved validation summary.
  await approveTestRelease(db);
  w = new World(db, await seedCast(db));
  steward = await seedActor(db, { roleCode: 'MASTER_DATA_STEWARD', legalName: 'Mira Steward' });
  operator = await seedActor(db, { roleCode: 'OPERATOR', legalName: 'Om Operator', roomCode: 'DISP-01' });
  qaFloor = await seedActor(db, { roleCode: 'QA_SHOP_FLOOR', legalName: 'Farah Floor-QA', roomCode: 'DISP-01' });
  head = await seedActor(db, { roleCode: 'HEAD_OF_PRODUCTION', legalName: 'Hari Head' });
  qaReviewer = await seedActor(db, { roleCode: 'QA_REVIEWER', legalName: 'Rhea Reviewer' });
  erp = await seedServiceActor(db, { kind: 'INTEGRATION', source: 'INTEGRATION', roleCode: 'ERP_INTERFACE', name: 'ERP interface' });
  master = await effective();
  running = await issuedBatch();
  const b = await issuedBatch();
  const exceptions: string[] = [];
  for (const n of [1, 2, 3, 4]) {
    const ex = await raise(b, `Label roll ${n} changed without a recorded check`);
    await disposition(b, ex);
    exceptions.push(ex);
  }
  await db.admin.query("update recipe.execution_state set status = 'EXECUTION_COMPLETE' where batch_id = $1", [b]);
  const state = (await db.app.query<{ s: string }>('select recipe.batch_review_state($1) as s', [b])).rows[0]!.s;
  const sig = await w.sign(head, 'batch_review', b, 'PRODUCTION_APPROVED', state);
  await w.run(head, (c) => c.query('select recipe.record_production_approval($1, $2)', [b, sig]));
  approved = { batchId: b, exceptions };
}, 900_000);

afterAll(async () => {
  await db.drop();
  dir.cleanup();
});

/** The four cases of one act: another product's requirement, this product's, one without a product, a stale source. */
interface ActCases {
  permission: string;
  who: () => SeededActor;
  /** Set-up made before the requirement is in force; returns what `act` needs. */
  arrange: () => Promise<string>;
  act: (subject: string) => Promise<unknown>;
  /** Checks the act took effect (or reached its own checks past the permission). */
  done: (subject: string, outcome: string) => Promise<void>;
}

async function anotherProduct(t: ActCases): Promise<void> {
  const subject = await t.arrange();
  const req = await permissionRequirement(db, t.permission, other());
  await underRequirement(db, req, async () => t.done(subject, await messageOf(t.act(subject))));
}

async function thisProduct(t: ActCases): Promise<void> {
  const subject = await t.arrange();
  const req = await permissionRequirement(db, t.permission, product());
  await underRequirement(db, req, async () => {
    const refused = await messageOf(t.act(subject));
    expect(refused).toMatch(new RegExp(`^EBMR-IAM-040 .*${t.permission.replace('.', '\\.')} in scope .*"product": "${product()}".*MISSING_QUALIFICATION:${req.code}`));
    await qualify(db, t.who().personId, req);
    await t.done(subject, await messageOf(t.act(subject)));
  });
}

async function noProduct(t: ActCases): Promise<void> {
  const subject = await t.arrange();
  const req = await permissionRequirement(db, t.permission);
  await underRequirement(db, req, async () => {
    expect(await messageOf(t.act(subject))).toMatch(new RegExp(`^EBMR-IAM-040 .*MISSING_QUALIFICATION:${req.code}`));
  });
}

async function staleSource(t: ActCases): Promise<void> {
  const subject = await t.arrange();
  const req: Requirement = await permissionRequirement(db, t.permission, product());
  await underRequirement(db, req, async () => {
    await qualify(db, t.who().personId, req, 'LMS');
    const refused = await withStaleLms(db, () => messageOf(t.act(subject)));
    expect(refused).toMatch(new RegExp(`^EBMR-IAM-040 .*STALE_QUALIFICATION_SOURCE:${req.code}`));
  });
}

// ---------------------------------------------------------------------------------------------------------------------

describe('the GMP batch issue in the order\'s product scope (6jc-R16)', () => {
  const t: ActCases = {
    permission: 'BATCH.ISSUE',
    who: () => w.cast.issuer,
    arrange: () => Promise.resolve(randomUUID()),
    act: async (batchId) => {
      await plan(batchId);
      await issue(batchId);
    },
    done: async (batchId, outcome) => {
      expect(outcome).toBe('ok');
      expect(await issuedStatus(batchId)).toBe('ISSUED');
    },
  };
  it('[IN-04][DI-21][DI-17] a product-limited requirement no longer refuses the batch issue on another product\'s batch', () => anotherProduct(t), 300_000);
  it('[IN-04][DI-21] the batch issue: this product\'s requirement still applies, and once qualified the issuer plans and issues', () => thisProduct(t), 300_000);
  it('[IN-04][DI-21] the batch issue: a requirement without a product limit still applies', () => noProduct(t), 300_000);
  it('[IN-04][DI-31] the batch issue: a stale qualification source is still refused', () => staleSource(t), 300_000);

  it('[IN-04][DI-17] the planned batch\'s issue checks the order\'s product in begin and issue too: a requirement limited to this product put in force after planning refuses the issue', async () => {
    const batchId = randomUUID();
    await plan(batchId);
    const req = await permissionRequirement(db, 'BATCH.ISSUE', product());
    await underRequirement(db, req, async () => {
      // The issue command's own check (begin) before the signature exists: past the server, as the application role.
      expect(await messageOf(w.run(w.cast.issuer, (c) => c.query('select recipe.begin_gmp_issue($1)', [batchId])))).toMatch(
        new RegExp(`^EBMR-IAM-040 .*BATCH\\.ISSUE in scope .*"product": "${product()}".*MISSING_QUALIFICATION:${req.code}`),
      );
    });
    await issue(batchId);
    expect(await issuedStatus(batchId)).toBe('ISSUED');
  }, 300_000);

  it('[IN-04][DI-21] the issue command\'s check asks for the first of its catalogued permissions the issuer holds, and refuses when the catalogue has no issue command', async () => {
    // The catalogue is insert-only and seeds ISSUE with BATCH.ISSUE alone, so this changes it past its triggers as the
    // superuser, in a transaction that is always rolled back (the probe error), and calls the check directly.
    const ctx = await cmd(db, w.cast.issuer);
    const PROBE = 'probe: rolled back';
    const withCatalogue = (perms: string[] | null) => messageOf(withCommand(db.admin, ctx, async (c) => {
      await c.query('set local session_replication_role = replica');
      if (perms) await c.query("update recipe.execution_command_permission set permissions = $1 where command_type = 'ISSUE'", [perms]);
      else await c.query("delete from recipe.execution_command_permission where command_type = 'ISSUE'");
      await c.query('set local session_replication_role = origin');
      await c.query('select recipe.require_issue_permission($1)', [product()]);
      throw new Error(PROBE);
    }));
    // A permission the issuer does not hold listed first: the one they hold is asked for, and passes.
    expect(await withCatalogue(['TEST.NOT_HELD', 'BATCH.ISSUE'])).toBe(PROBE);
    // None held: the first is asked for, and refused.
    expect(await withCatalogue(['TEST.NOT_HELD'])).toMatch(/^EBMR-IAM-040 .*TEST\.NOT_HELD/);
    // No issue command in the catalogue: refused with its own message.
    expect(await withCatalogue(null)).toMatch(/\[EBMR-EXE-003\]$/);
    // The catalogue is unchanged.
    const { rows } = await db.admin.query<{ p: string[] }>("select permissions as p from recipe.execution_command_permission where command_type = 'ISSUE'");
    expect(rows).toEqual([{ p: ['BATCH.ISSUE'] }]);
  }, 300_000);
});

describe('the disposition proposals and the act proposal in the batch\'s product scope (6jc-R16)', () => {
  const disposal: ActCases = {
    permission: 'QA.FLOOR_APPROVE',
    who: () => qaFloor,
    arrange: () => raise(running, `Gauge reading ${randomUUID().slice(0, 4)} taken late`),
    act: (ex) => propose(running, ex),
    done: async (ex, outcome) => {
      expect(outcome).toBe('ok');
      expect(await proposals(running, ex)).toBe(1);
    },
  };
  it('[IN-04][DI-21][PR-49] a product-limited requirement no longer refuses the disposition proposal on another product\'s batch', () => anotherProduct(disposal), 300_000);
  it('[IN-04][DI-21][PR-49] the disposition proposal: this product\'s requirement still applies, and once qualified QA proposes', () => thisProduct(disposal), 300_000);
  it('[IN-04][DI-21][PR-49] the disposition proposal: a requirement without a product limit still applies', () => noProduct(disposal), 300_000);
  it('[IN-04][DI-31][PR-49] the disposition proposal: a stale qualification source is still refused', () => staleSource(disposal), 300_000);

  // The hold point H-CORES@ is not reached on this batch: past the permission, the proposal stops at its own state check.
  const holdPoint: ActCases = {
    permission: 'QA.FLOOR_APPROVE',
    who: () => qaFloor,
    arrange: () => Promise.resolve('H-CORES@'),
    act: (step) => w.run(qaFloor, (c) => c.query('select recipe.propose_hold_point_decision($1, $2, $3::jsonb)', [running, step, JSON.stringify({ disposition: 'APPROVED', comment: null })])),
    done: (_step, outcome) => {
      expect(outcome).toMatch(/^(There is no hold point H-CORES@|Hold point H-CORES@ is not waiting for a decision) .*\[EBMR-EXE-084\]$/);
      return Promise.resolve();
    },
  };
  it('[IN-04][DI-21][PR-45] a product-limited requirement no longer refuses the hold-point decision proposal on another product\'s batch', () => anotherProduct(holdPoint), 300_000);
  it('[IN-04][DI-21][PR-45] the hold-point decision proposal: this product\'s requirement still applies', () => thisProduct(holdPoint), 300_000);
  it('[IN-04][DI-21][PR-45] the hold-point decision proposal: a requirement without a product limit still applies', () => noProduct(holdPoint), 300_000);
  it('[IN-04][DI-31][PR-45] the hold-point decision proposal: a stale qualification source is still refused', () => staleSource(holdPoint), 300_000);

  const actProposal: ActCases = {
    permission: 'STEP.EXECUTE',
    who: () => operator,
    arrange: () => Promise.resolve(randomUUID().slice(0, 8)),
    act: (n) => w.run(operator, (c) => c.query('select recipe.propose_act($1, $2::jsonb)', [running, JSON.stringify({ type: 'REQUEST_SKIP', stepKey: `p-${n}@`, reason: 'Line stopped', requestedBy: operator.personId })])),
    done: async (n, outcome) => {
      expect(outcome).toBe('ok');
      expect((await db.app.query("select 1 from recipe.execution_act_proposal where batch_id = $1 and act ->> 'stepKey' = $2", [running, `p-${n}@`])).rowCount).toBe(1);
    },
  };
  it('[IN-04][DI-21][DI-24] a product-limited requirement no longer refuses the proposal of an act for approval on another product\'s batch', () => anotherProduct(actProposal), 300_000);
  it('[IN-04][DI-21][DI-24] the proposal of an act for approval: this product\'s requirement still applies, and once qualified the operator proposes', () => thisProduct(actProposal), 300_000);
  it('[IN-04][DI-21][DI-24] the proposal of an act for approval: a requirement without a product limit still applies', () => noProduct(actProposal), 300_000);
  it('[IN-04][DI-31][DI-24] the proposal of an act for approval: a stale qualification source is still refused', () => staleSource(actProposal), 300_000);
});

describe('the exception-register acts in review in the batch\'s product scope (6jc-R16)', () => {
  let next = 0;
  const query: ActCases = {
    permission: 'RECORD.QA_REVIEW',
    who: () => qaReviewer,
    arrange: () => Promise.resolve(approved.exceptions[next++]!),
    act: (ex) => w.run(qaReviewer, (c) => c.query("select recipe.review_exception($1, $2, 'QUERIED', $3, null)", [approved.batchId, ex, 'Why was the roll check not recorded?'])),
    done: async (ex, outcome) => {
      expect(outcome).toBe('ok');
      expect((await db.app.query("select by_person::text as p from recipe.exception_register_act where batch_id = $1 and exception_id = $2 and act = 'QUERIED'", [approved.batchId, ex])).rows).toEqual([{ p: qaReviewer.personId }]);
    },
  };
  it('[IN-04][DI-21][DI-26] a product-limited requirement no longer refuses the exception review act on another product\'s batch', () => anotherProduct(query), 300_000);
  it('[IN-04][DI-21][DI-26] the exception review act: this product\'s requirement still applies, and once qualified QA queries', () => thisProduct(query), 300_000);
  it('[IN-04][DI-21][DI-26] the exception review act: a requirement without a product limit still applies', () => noProduct(query), 300_000);
  it('[IN-04][DI-31][DI-26] the exception review act: a stale qualification source is still refused', () => staleSource(query), 300_000);

  it('[DI-26] the review act\'s own checks are unchanged: an unknown act is refused before the permission, an unknown exception after it', async () => {
    expect(await codeOf(w.run(qaReviewer, (c) => c.query("select recipe.review_exception($1, 'NO-SUCH', 'CLOSED', 'x', null)", [approved.batchId])))).toBe('EBMR-EXE-164');
    expect(await codeOf(w.run(operator, (c) => c.query("select recipe.review_exception($1, 'NO-SUCH', 'QUERIED', 'x', null)", [approved.batchId])))).toBe('EBMR-IAM-040');
    expect(await codeOf(w.run(qaReviewer, (c) => c.query("select recipe.review_exception($1, 'NO-SUCH', 'QUERIED', 'x', null)", [approved.batchId])))).toBe('EBMR-EXE-164');
  });
});
