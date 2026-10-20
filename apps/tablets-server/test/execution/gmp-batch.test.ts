/**
 * Batch execution on the GMP installation (Phase 3 slice 2b item 3; recipe-core 0500 to 0503, tablets 0800 and 0801):
 * a GMP server plans a batch from an effective MBR version (number from the site's register, pin, control recipe), the
 * issuer signs its issue content ISSUED through the ceremony and the batch is issued in that command; an operator runs
 * its first step on a kiosk of the step's room; its views carry no watermark, while the sandbox's test runs keep TEST,
 * NOT GMP. The DI-05 boundary that remains: test packages are not served on GMP, TEST- lots are refused on GMP and real
 * lots in the sandbox, and the GMP batch plan does not exist in the sandbox.
 *
 * The effective MBR version is made through the real life cycle (recipe-core lifecycle helpers: create, evidence,
 * submit, check, approve, market authorisation) by the GMP personas of the seed, with real e-signatures.
 */
import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { sha256Hex } from '@ebmr/expr';
import { engine, execution, flow } from '@ebmr/recipe-core';
import { routes, type SignatureCredentials } from '@ebmr/api-contract';
import { openPersonaSession, openServiceSession } from '@ebmr/test-kit';
import { esig, toDbContext, withCommand } from '@ebmr/kernel';
import { cmd, signatureAuth } from '../../../../packages/kernel/test/esig/helpers.ts';
import type { SeededActor } from '../../../../packages/kernel/test/identity/seed.ts';
import type { TestDatabase } from '../../../../packages/kernel/test/support/db.ts';
import { cell, reason, World, type Cast } from '../../../../packages/recipe-core/test/lifecycle/support.ts';
import { postOrder } from '../../../../packages/recipe-core/test/lifecycle/gmp-support.ts';
import type { TestBrowser, TestServer } from '../support/harness.ts';
import { recordContentForSigning } from '../../src/features/esig/content.ts';
import { engineActor } from '../../src/features/execution/roles.ts';
import { defineForGmp, loadControlRecipe } from '../../src/features/execution/runs.ts';
import { messageOf } from './db-guards-support.ts';
import { personaIn, startSigningServer } from '../esig/support.ts';
import { dcMini, importAndIssue, refusalOf, RunDriver, startExecServer, valueOf, writePackage, type ExecServer } from './support.ts';

type Json = Record<string, unknown>;

const SITE = 'SITE-1';
const LINE = 'L1';
const BATCH_SIZE = 'BS-100K';
const INPUTS = { tabletsPerBatch: { kind: 'COUNT' as const, value: '100000' } };

let gmp: ExecServer;
let sbx: ExecServer;
let world: World;
let familyId: string;
let gmpMbr: flow.MbrContent;

/** The life-cycle helpers, with their signatures sealed by the server's own seal key (the installation is bootstrapped). */
class GmpWorld extends World {
  constructor(
    db: TestDatabase,
    cast: Cast,
    private readonly key: esig.SealKeyProvider,
  ) {
    super(db, cast);
  }

  override async sign(signer: SeededActor, aggregateType: string, aggregateId: string, meaning: string, expectedState: string | null): Promise<string> {
    // The content as this installation reads it (tablets 0410: the application role reads it through tab.*).
    const content = await recordContentForSigning(this.db.app, aggregateType, aggregateId);
    const ch = await withCommand(this.db.app, await cmd(this.db, signer), (c) =>
      esig.createChallenge(c, { aggregateType, aggregateId, contentVersion: content.contentVersion ?? '1', meaning, clientContentHash: content.contentHash ?? '' }),
    );
    const authEventId = await signatureAuth(this.db, signer, signer, ch.challengeId);
    const r = await withCommand(this.db.app, await cmd(this.db, signer), (c) => esig.sign(c, { challengeId: ch.challengeId, authEventId, expectedState }, this.key));
    return r.signatureId;
  }

  /** The regulatory sign-off of a new version (none exists yet; the application role reads no signature table here). */
  override async regulatoryConfirm(versionId: string, signer: SeededActor = this.cast.regulatory): Promise<void> {
    await this.sign(signer, 'mbr_version', versionId, 'REGULATORY_CONFIRMED', (await this.state(versionId)).state);
  }
}

/** A persona of the GMP seed as the recipe-core life-cycle helpers take an actor (a session on its home terminal). */
async function actorOf(server: TestServer, key: string): Promise<SeededActor> {
  const p = personaIn(server, key);
  const s = await openPersonaSession(server.db, server.seed, key);
  return { ...s, seed: { loginName: p.loginName, password: p.password, deviceFingerprint: s.fingerprint, deviceClass: 'PERSONAL', grantId: '', identityVerificationId: '' } };
}

/** dc-mini as a GMP master: its own family and an upper-case product code, without G-09 and G-10 version 1 (D-S2b-2). */
function gmpContent(): flow.MbrContent {
  const m = JSON.parse(JSON.stringify(dcMini())) as Json;
  const tag = randomUUID().slice(0, 6).toUpperCase();
  const header = m['header'] as Json;
  header['family'] = `${String(header['family'])}-${tag}`;
  header['product'] = { ...(header['product'] as Json), code: `${String((header['product'] as Json)['code'])}-${tag}` };
  const strip = (n: unknown): unknown => {
    if (Array.isArray(n)) return n.filter((x) => !['G-09', 'G-10'].includes(String(((x as Json | null)?.['block'] as Json | undefined)?.['type']))).map(strip);
    if (n && typeof n === 'object') return Object.fromEntries(Object.entries(n).map(([k, v]) => [k, strip(v)]));
    return n;
  };
  const parsed = flow.parseMbr(strip(m));
  if (!parsed.ok) throw new Error(`the GMP master does not parse: ${JSON.stringify(parsed.problems.slice(0, 3))}`);
  return parsed.mbr;
}

beforeAll(async () => {
  const ledgerDir = mkdtempSync(join(tmpdir(), 'ebmr-gmp-ledger-'));
  const server = await startSigningServer('GMP', { stub: false, env: { EBMR_NUMBER_LEDGER_FILE: join(ledgerDir, 'numbers.ledger.jsonl') } });
  gmp = Object.assign(server, { exchangeDir: ledgerDir });
  sbx = await startExecServer();
  const db: TestDatabase = { name: gmp.database, admin: gmp.db.admin, app: gmp.db.app, drop: () => Promise.resolve() };
  const key = gmp.built.ctx.sealKey;
  if (!key) throw new Error('the GMP server has no seal key');
  const author = await actorOf(gmp, 'author');
  const checker = await actorOf(gmp, 'checker');
  const qa = await actorOf(gmp, 'approver');
  const regulatory = await actorOf(gmp, 'regulatory');
  const issuer = await actorOf(gmp, 'issuer');
  const cast: Cast = { author, coAuthor: author, checker, checker2: checker, qa, qa2: qa, regulatory, issuer };
  world = new GmpWorld(db, cast, key);
  const content = gmpContent();
  const v = await world.approvedVersion(content);
  await world.authorise({ versionId: v.versionId, market: 'IN', kind: 'CURRENT', cells: [cell(SITE, LINE, BATCH_SIZE)], regulatoryBasis: 'IN: registration on file' });
  const steward = await actorOf(gmp, 'steward');
  await world.run(steward, (c) =>
    c.query('select site.define_batch_number_rule($1::jsonb)', [
      JSON.stringify({ rule_code: `G-${randomUUID().slice(0, 8).toUpperCase()}`, site_code: SITE, product_code: content.header.product.code, batch_kind: 'PROCESSING', format: 'G{YY}{SEQ:5}', site_zone: 'Asia/Kolkata', reason: 'Numbering SOP-QA-017 rev 3' }),
    ]),
    reason('numbering rule for the test'),
  );
  familyId = v.familyId;
  gmpMbr = content;
}, 600_000);

afterAll(async () => {
  await Promise.all([gmp?.close(), sbx?.close()]);
});

const passwordOf = (server: TestServer, key: string): SignatureCredentials => ({ kind: 'PASSWORD', loginName: personaIn(server, key).loginName, password: personaIn(server, key).password });

/** The issuer's ceremony on a planned batch: preview, challenge, password, sign (GMP_BATCH_ISSUE). */
async function signIssue(issuer: TestBrowser, batchId: string, opts: { reason?: { code: string; text: string } } = {}) {
  const content = valueOf(await issuer.call(routes.esig.content, { query: { aggregateType: 'batch_issue', aggregateId: batchId, intent: 'ISSUED' } }));
  const action = { kind: 'GMP_BATCH_ISSUE' as const, batchId, reason: opts.reason ?? { code: 'PRODUCTION_PLAN', text: 'Issued for the October production plan' }, variants: {}, inputs: INPUTS };
  const body = { aggregateType: 'batch_issue', aggregateId: batchId, contentVersion: content.contentVersion, meaning: 'ISSUED', clientContentHash: sha256Hex(content.canonicalText), action };
  const challenge = valueOf(await issuer.call(routes.esig.createChallenge, { body }));
  const signBody = { challengeId: challenge.challengeId, credentials: passwordOf(gmp, 'issuer'), action };
  const proof = await issuer.proof('POST', '/api/esig/sign', signBody);
  return { content, result: await issuer.call(routes.esig.sign, { body: { ...signBody, proof } }) };
}

async function planned(issuer: TestBrowser) {
  // The ERP order the server plans the batch against (D-S5-4; recipe-core 0602).
  await postOrder(gmp.db.app, await openServiceSession(gmp.db, gmp.seed, 'erpInterface'), gmpMbr, BATCH_SIZE);
  return valueOf(await issuer.call(routes.execution.planBatch, { body: { familyId, markets: ['IN'], site: SITE, line: LINE, batchSize: BATCH_SIZE } }));
}

describe('GMP batches on the GMP installation (slice 2b)', () => {
  it('G2 (slice 7i, P7H-4): a processing batch planned from the second of two open orders is linked to that order; an unknown order or one that planned a batch already is refused by the database', async () => {
    const issuer = await gmp.asPersona('issuer');
    const erp = await openServiceSession(gmp.db, gmp.seed, 'erpInterface');
    const first = await postOrder(gmp.db.app, erp, gmpMbr, BATCH_SIZE);
    const second = await postOrder(gmp.db.app, erp, gmpMbr, BATCH_SIZE);
    const body = { familyId, markets: ['IN'], site: SITE, line: LINE, batchSize: BATCH_SIZE };
    expect(refusalOf(await issuer.call(routes.execution.planBatch, { body: { ...body, erpOrder: 'PO-NOT-THERE' } }))).toMatchObject({ code: 'EBMR-EXE-605', why: expect.stringMatching(/ERP order PO-NOT-THERE is not in the ERP stub/) as unknown });
    const plannedOnSecond = valueOf(await issuer.call(routes.execution.planBatch, { body: { ...body, erpOrder: second } }));
    const cards = valueOf(await issuer.call(routes.planning.orders)).orders;
    expect(cards.find((o) => o.orderNo === second)?.batches.map((b) => b.batchNumber)).toEqual([plannedOnSecond.batchNumber]);
    expect(cards.find((o) => o.orderNo === first)?.batches ?? []).toEqual([]);
    const { rows } = await gmp.db.admin.query<{ order_no: string }>('select order_no from recipe.batch_erp_order where batch_id = $1', [plannedOnSecond.batchId]);
    expect(rows.map((r) => r.order_no)).toEqual([second]);
    expect(refusalOf(await issuer.call(routes.execution.planBatch, { body: { ...body, erpOrder: second } }))).toMatchObject({ code: 'EBMR-EXE-605', why: expect.stringMatching(/planned a batch already/) as unknown });
    // The first order stays open and is planned when named.
    const plannedOnFirst = valueOf(await issuer.call(routes.execution.planBatch, { body: { ...body, erpOrder: first } }));
    expect((await gmp.db.admin.query<{ order_no: string }>('select order_no from recipe.batch_erp_order where batch_id = $1', [plannedOnFirst.batchId])).rows[0]?.order_no).toBe(first);
  }, 120_000);

  it('[DI-05][INV-18][INV-01][INV-02] a GMP server plans a batch from the effective MBR version with a register number, issues it under the issuer\'s ISSUED signature with the issuer\'s reason, and an operator runs its first step; no view carries a watermark', async () => {
    const issuer = await gmp.asPersona('issuer');
    const plan = await planned(issuer);
    expect(plan.batchNumber).toMatch(/^G\d{2}\d{5}$/);
    expect(plan.markets).toEqual(['IN']);
    expect(plan.inputs.map((i) => i.id)).toEqual(['tabletsPerBatch']);

    const { content, result } = await signIssue(issuer, plan.batchId);
    expect(content.canonicalText).toContain(plan.batchNumber);
    if (!result.ok) throw new Error(`the issue was refused: ${JSON.stringify(refusalOf(result))}`);
    expect(result.value.result).toEqual({ runId: plan.batchId, batchNumber: plan.batchNumber });

    // The record: a GMP batch of the control recipe, ISSUE evidence empty, issued under that signature with the reason.
    const { rows } = await gmp.db.admin.query<{ installation: string; purpose: string; package_hash: string | null; control_recipe_id: string; evidence: Json; status: string }>(
      `select b.installation, b.purpose, b.package_hash, b.control_recipe_id::text, c.evidence, sb.status
         from recipe.batch_execution b join recipe.execution_command c on c.batch_id = b.id and c.kind = 'ISSUE'
         join recipe.stub_batch sb on sb.id = b.id where b.id = $1`,
      [plan.batchId],
    );
    expect(rows[0]).toMatchObject({ installation: 'GMP', purpose: 'GMP_BATCH', package_hash: null, control_recipe_id: plan.controlRecipeId, evidence: {}, status: 'ISSUED' });

    const operator = await gmp.asPersona('operator1');
    const d = new RunDriver(gmp, plan.batchId, { issuer, operator1: operator });
    const run = await d.runView('operator1');
    expect(run.header).toMatchObject({ batchNumber: plan.batchNumber, status: 'ISSUED', watermark: null, mbr: { versionNumber: plan.versionNumber, contentHash: plan.contentHash } });

    // The first step (G-09 and G-10 version 1 stay sandbox-only): the operator's commands are accepted end to end, and
    // their evidence carries no test package (recipe-core 0335 row_evidence_problem).
    await d.ok('operator1', { type: 'START_STEP', stepKey: 'p-disp-sop@' });
    const recorded = await d.ok('operator1', { type: 'RECORD_ENTRY', stepKey: 'p-disp-sop@', entry: { kind: 'ACKNOWLEDGE', mode: 'READ' } });
    expect(recorded.step?.run.watermark).toBeNull();
    const signed = await d.signed('operator1', { type: 'SIGN_PERFORMED', stepKey: 'p-disp-sop@' });
    expect(signed.manifestation).toBeDefined();
    const step = await d.stepView('operator1', 'p-disp-sop@');
    expect(step.run.watermark).toBeNull();
    const { rows: cmds } = await gmp.db.admin.query<{ command_type: string; accepted: boolean; evidence: Json }>(
      "select command_type, accepted, evidence from recipe.execution_command where batch_id = $1 and kind = 'COMMAND' order by seq",
      [plan.batchId],
    );
    expect(cmds.map((c) => [c.command_type, c.accepted])).toEqual([
      ['START_STEP', true],
      ['RECORD_ENTRY', true],
      ['SIGN_PERFORMED', true],
    ]);
    for (const c of cmds) expect(c.evidence).not.toHaveProperty('packageHash');
    const replay = valueOf(await issuer.call(routes.batches.verifyReplay, { params: { batchId: plan.batchId }, body: {} }));
    expect(replay.identical).toBe(true);
    const violations = await gmp.db.app.query<{ problem: string }>('select problem from recipe.execution_violations()');
    expect(violations.rows).toEqual([]);
  }, 300_000);

  it('[DI-35][INV-10] the issue needs the issuer\'s own reason and every header input; a refused dry run signs nothing and leaves the batch planned', async () => {
    const issuer = await gmp.asPersona('issuer');
    const plan = await planned(issuer);
    const content = valueOf(await issuer.call(routes.esig.content, { query: { aggregateType: 'batch_issue', aggregateId: plan.batchId, intent: 'ISSUED' } }));
    const action = { kind: 'GMP_BATCH_ISSUE' as const, batchId: plan.batchId, reason: { code: 'PRODUCTION_PLAN', text: 'Issued for the plan' }, variants: {}, inputs: {} };
    const body = { aggregateType: 'batch_issue', aggregateId: plan.batchId, contentVersion: content.contentVersion, meaning: 'ISSUED', clientContentHash: sha256Hex(content.canonicalText), action };
    const challenge = valueOf(await issuer.call(routes.esig.createChallenge, { body }));
    const signBody = { challengeId: challenge.challengeId, credentials: passwordOf(gmp, 'issuer'), action };
    const r = await issuer.call(routes.esig.sign, { body: { ...signBody, proof: await issuer.proof('POST', '/api/esig/sign', signBody) } });
    expect(refusalOf(r)?.code).toBe('EBMR-EXE-085');
    const { rows } = await gmp.db.admin.query<{ status: string; sigs: string }>(
      "select b.status, (select count(*) from esig.signature s where s.aggregate_ref = 'batch_issue:' || b.id::text)::text as sigs from recipe.stub_batch b where b.id = $1",
      [plan.batchId],
    );
    expect(rows[0]).toEqual({ status: 'PLANNED', sigs: '0' });
    // A reason of white space only is no reason (the contract refuses it before anything runs).
    const blank = await signIssue(issuer, plan.batchId, { reason: { code: 'PRODUCTION_PLAN', text: '   ' } }).catch((e: unknown) => ({ result: { ok: false as const, error: e } }));
    expect(blank.result.ok).toBe(false);
  }, 300_000);

  it('[DI-14][DI-35][INV-26][INV-01][DI-34] the database refuses a forged GMP issue, each with its own refusal: another number, a policy that does not hash as stated, a request of another person, another market set, a signature that is none, role evidence that is malformed or not behind a stored evaluation, a state that is not the initial one; the honest issue then succeeds', async () => {
    const plan = await planned(await gmp.asPersona('issuer'));
    const issuer = world.cast.issuer;
    const sig = await world.sign(issuer, 'batch_issue', plan.batchId, 'ISSUED', 'PLANNED');
    const source = await loadControlRecipe(gmp.db.admin, plan.controlRecipeId);
    if (!source) throw new Error('SETUP: the control recipe cannot be read');
    const def = defineForGmp(source);
    const other = personaIn(gmp, 'operator1').personId;
    const json = (p: unknown[], i: number): Json => JSON.parse(String(p[i])) as Json;
    /** The issue through the server's own code, the parameters of recipe.issue_gmp_execution changed by `forge`. */
    const issueAs = (forge?: (p: unknown[]) => void, signatureId = sig): Promise<string> =>
      messageOf(
        world.run(
          issuer,
          async (c) => {
            const client = {
              query: (text: string, params?: unknown[]) => {
                const p = params ? [...params] : [];
                if (forge && text.includes('recipe.issue_gmp_execution')) forge(p);
                return c.query(text, p);
              },
            };
            await execution.issueGmpBatch(client as unknown as typeof c, {
              batchId: plan.batchId,
              signatureId,
              define: () => def,
              request: { variants: {}, inputs: { tabletsPerBatch: { value: { kind: 'COUNT', value: '100000' }, source: 'kill test' } }, issuedBy: engineActor(issuer.personId, []) },
            });
          },
          reason('a forged issue for the test'),
        ),
      );
    const request = (edit: (r: Json) => void) => (p: unknown[]) => {
      const r = json(p, 3);
      edit(r);
      p[3] = JSON.stringify(r);
    };
    const state = (edit: (s: Json) => void) => (p: unknown[]) => {
      const s = json(p, 9);
      edit(s);
      p[9] = JSON.stringify(s);
      p[10] = engine.hashJson(s as engine.JsonValue);
    };
    const outcomes = {
      number: await issueAs((p) => void (p[2] = 'G2699999')),
      policyHash: await issueAs((p) => void (p[5] = 'e'.repeat(64))),
      person: await issueAs(request((r) => void ((r['issuedBy'] as Json)['id'] = other))),
      markets: await issueAs(request((r) => void (r['marketSet'] = ['IN', 'US']))),
      signature: await issueAs(undefined, randomUUID()),
      rolesNotAList: await issueAs(request((r) => void ((r['issuedBy'] as Json)['roles'] = 'QA'))),
      roleWithoutEvaluation: await issueAs(request((r) => void ((r['issuedBy'] as Json)['roles'] = ['QA']))),
      stateMovedOn: await issueAs(state((s) => void (s['version'] = 1))),
    };
    expect(outcomes.number).toMatch(/\[EBMR-EXE-012\]/);
    expect(outcomes.policyHash).toMatch(/does not hash to its stated hash .*\[EBMR-EXE-014\]/);
    expect(outcomes.person).toMatch(/names another person, batch or number .*\[EBMR-EXE-015\]/);
    expect(outcomes.markets).toMatch(/\[EBMR-EXE-194\]/);
    expect(outcomes.signature).toMatch(/is issued only under the issuer's valid ISSUED signature .*\[EBMR-EXE-193\]/);
    expect(outcomes.rolesNotAList).toMatch(/role evidence of the command is malformed .*\[EBMR-EXE-035\]/);
    expect(outcomes.roleWithoutEvaluation).toMatch(/without a stored authority evaluation .*\[EBMR-EXE-037\]/);
    expect(outcomes.stateMovedOn).toMatch(/not the engine's initial state of this request .*\[EBMR-EXE-030\]/);
    const status = async () => (await gmp.db.admin.query<{ s: string }>('select status as s from recipe.stub_batch where id = $1', [plan.batchId])).rows[0]?.s;
    expect(await status()).toBe('PLANNED');
    expect(await issueAs()).toBe('ok');
    expect(await status()).toBe('ISSUED');

    // Past every command, as the owner in the issuer's command (rolled back): the issued record is never updated; a GMP
    // record without its control recipe is never inserted; a number is linked only to a planned batch not yet pinned.
    const owner = async (text: string, params: unknown[]): Promise<string> => {
      const c = await gmp.db.admin.connect();
      try {
        await c.query('begin');
        await c.query('select kernel.begin_command($1::jsonb)', [JSON.stringify(toDbContext({ ...(await cmd(world.db, issuer)), ...reason('a write past the commands') }))]);
        return await messageOf(c.query(text, params));
      } finally {
        await c.query('rollback');
        c.release();
      }
    };
    expect(await owner('update recipe.batch_execution set issue_signature_id = gen_random_uuid() where id = $1', [plan.batchId])).toMatch(/EBMR-AUDIT-004 recipe.batch_execution is insert-only/);
    expect(
      await owner(
        `insert into recipe.batch_execution (id, batch_number, content_hash, installation, purpose, engine_version, registry_fingerprint, policy, policy_hash, issue_request,
                                             market_set, batch_size, site_code, site_zone, issued_at_us, issued_by_person, issued_by_account, correlation_id)
         values (gen_random_uuid(), 'G2600001', repeat('a', 64), 'GMP', 'GMP_BATCH', '1', repeat('c', 64), '{}', repeat('d', 64), '{}', '{IN}', $1, $2, 'Asia/Kolkata', 0,
                 gen_random_uuid(), gen_random_uuid(), gen_random_uuid())`,
        [BATCH_SIZE, SITE],
      ),
    ).toMatch(/GMP batch G2600001 cannot be recorded: .*\[EBMR-EXE-19\d\]/);
    expect(
      await owner(
        'insert into recipe.batch_allocation_link (batch_id, allocation_id, batch_number, person_id, account_id, correlation_id) values ($1, gen_random_uuid(), $2, gen_random_uuid(), gen_random_uuid(), gen_random_uuid())',
        [plan.batchId, 'G2600002'],
      ),
    ).toMatch(/linked to a planned batch before it is pinned, once .*\[EBMR-EXE-191\]/);
  }, 300_000);

  it('[INV-01][INV-27][IN-18] a GMP batch is planned with its id and an existing MBR family, and a batch number only from an allocation of the register', async () => {
    const prepare = (batch: string | null, def: unknown): Promise<string> =>
      messageOf(world.run(world.cast.issuer, (c) => c.query('select recipe.prepare_gmp_issue($1, $2::jsonb) as r', [batch, JSON.stringify(def)]), reason('planning for the test')));
    const scope = { markets: ['IN'], site: SITE, line: LINE, batchSize: BATCH_SIZE };
    const named = /planned with its id and its MBR family, market set and scope .*\[EBMR-EXE-192\]/;
    expect(await prepare(null, { familyId, ...scope })).toMatch(named);
    expect(await prepare(randomUUID(), [familyId])).toMatch(named);
    expect(await prepare(randomUUID(), { familyId: 'FAM-1', ...scope })).toMatch(named);
    expect(await prepare(randomUUID(), { familyId: randomUUID(), ...scope })).toMatch(/There is no MBR family .*\[EBMR-EXE-192\]/);
    expect(await prepare(randomUUID(), { familyId, ...scope, allocationId: 'ALLOC-1' })).toMatch(/names no allocation of the site's register .*\[EBMR-EXE-191\]/);
    expect(await prepare(randomUUID(), { familyId, ...scope, allocationId: randomUUID() })).toMatch(/is not in the site's batch-number register .*\[EBMR-EXE-191\]/);
  }, 120_000);

  it('[DI-05][INV-18] TEST- lots are refused on GMP and real lots in the sandbox; a lot of the site register is read with its register status on GMP', async () => {
    const issuer = await gmp.asPersona('issuer');
    const onGmp = await issuer.call(routes.execution.lot, { params: { code: 'TEST-L26-0101' } });
    expect(refusalOf(onGmp)?.code).toBe('EBMR-SBX-021');
    const sbxIssuer = await sbx.asPersona('issuer');
    expect(valueOf(await sbxIssuer.call(routes.execution.lot, { params: { code: 'TEST-L26-0101' } })).lotCode).toBe('TEST-L26-0101');
    const realInSandbox = await sbxIssuer.call(routes.execution.lot, { params: { code: 'L26-0101' } });
    expect(realInSandbox.ok).toBe(false);
    expect(refusalOf(realInSandbox)?.code).toBe('EXE_NOT_FOUND');

    // A quarantined lot of the site's register (written by the owner for this read test): QUARANTINE, never RELEASED.
    const lotId = randomUUID();
    const c = await gmp.db.admin.connect();
    try {
      await c.query('begin');
      await c.query('set local session_replication_role = replica');
      await c.query(
        `insert into site.material_lot (id, site_code, lot_code, material_code, material_name, material_kind, received_quantity, unit, expires_at, received_by_person, received_by_account, correlation_id)
         values ($1, $2, 'L26-0101', 'PCM-API', 'Paracetamol', 'API', 100, 'kg', now() + interval '400 days', gen_random_uuid(), gen_random_uuid(), gen_random_uuid())`,
        [lotId, SITE],
      );
      await c.query(
        "insert into platform.aggregate_state (aggregate_type, aggregate_id, machine_code, machine_version, state, version) values ('material_lot', $1, 'material_lot', 1, 'QUARANTINE', 1)",
        [lotId],
      );
      await c.query('commit');
    } finally {
      c.release();
    }
    const lot = valueOf(await issuer.call(routes.execution.lot, { params: { code: 'L26-0101' } }));
    expect(lot).toMatchObject({ lotCode: 'L26-0101', material: { code: 'PCM-API', name: 'Paracetamol' }, status: 'QUARANTINE', identityTested: false });
    expect(lot.expiry).not.toBeNull();
  }, 300_000);

  it('[DI-05][INV-18] the sandbox keeps the TEST, NOT GMP watermark on every view of a test run, and test packages are not served on GMP', async () => {
    const issuer = await sbx.asPersona('issuer');
    const runId = await importAndIssue(sbx, issuer, writePackage(sbx, dcMini()));
    const run = valueOf(await issuer.call(routes.execution.run, { params: { runId } }));
    expect(run.header.watermark).toMatchObject({ text: 'TEST, NOT GMP', source: 'SANDBOX_TEST_RUN', control: 'DI-05' });
    const gmpIssuer = await gmp.asPersona('issuer');
    for (const route of [routes.execution.testPackages, routes.execution.issueForm]) {
      const res = await gmpIssuer.inject({ method: 'GET', url: route.path.replace(':packageId', 'a'.repeat(64)) });
      expect(res.statusCode, route.id).toBe(404);
    }
    const imported = await gmpIssuer.inject({ method: 'POST', url: `/api/test-packages/${'a'.repeat(64)}/import`, payload: '{}', headers: { 'content-type': 'application/json' } });
    expect(imported.statusCode).toBe(404);
    // And the GMP batch plan does not exist in the sandbox.
    const planInSandbox = await issuer.inject({ method: 'POST', url: '/api/batches', payload: JSON.stringify({ familyId, markets: ['IN'], site: SITE, line: LINE, batchSize: BATCH_SIZE }), headers: { 'content-type': 'application/json' } });
    expect(planInSandbox.statusCode).toBe(404);
  }, 300_000);
});

/**
 * A qualification (training) requirement limited to one product applies to the step work and step signatures of
 * batches of that product only (Phase 6 exit review 6jc-R16; recipe-core 1100, tablets 1100). The batch's product is
 * part of the scope the command's engine roles, its permission and its signatures are evaluated in. A requirement
 * without a product limit still applies to every batch, and a stale or missing qualification source still fails closed.
 * The requirements and qualifications are arranged by the superuser with triggers off, as test arrangement.
 */
describe('a product-limited qualification requirement applies to batches of that product only (6jc-R16)', () => {
  const STEP = 'p-disp-sop@';
  const tag = () => randomUUID().slice(0, 8).toUpperCase();

  async function asOwner<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
    const c = await gmp.db.admin.connect();
    try {
      await c.query('begin');
      await c.query('set local session_replication_role = replica');
      const r = await fn(c);
      await c.query('commit');
      return r;
    } catch (e) {
      await c.query('rollback');
      throw e;
    } finally {
      c.release();
    }
  }

  /** A new qualification type required of the OPERATOR role, limited to `scope`; returns its code and requirement id. */
  async function requirement(scope: { product?: string }): Promise<{ code: string; id: string }> {
    const code = `SOP-R16-${tag()}`;
    const recorder = personaIn(gmp, 'approver').personId;
    const id = await asOwner(async (c) => {
      await c.query('insert into iam.qualification_type (code, name, description) values ($1, $2, $3)', [code, `Training ${code}`, 'Test training (6jc-R16)']);
      const { rows } = await c.query<{ id: string }>(
        `insert into iam.qualification_requirement (qualification_code, role_code, scope_product, reason, created_by_person)
         values ($1, 'OPERATOR', $2, 'Training required for the test (6jc-R16)', $3) returning id::text as id`,
        [code, scope.product ?? null, recorder],
      );
      return rows[0]!.id;
    });
    return { code, id };
  }

  async function endRequirement(id: string): Promise<void> {
    await asOwner((c) => c.query('update iam.qualification_requirement set effective_to = clock_timestamp() where id = $1', [id]));
  }

  async function qualify(code: string, source: 'INTERNAL' | 'LMS'): Promise<void> {
    const op = personaIn(gmp, 'operator1').personId;
    const by = (await gmp.db.admin.query<{ person_id: string; id: string }>('select a.person_id::text, a.id::text from iam.account a where a.login_name = $1', [personaIn(gmp, 'approver').loginName])).rows[0]!;
    await asOwner((c) =>
      c.query(
        `insert into iam.person_qualification (person_id, qualification_code, source_code, valid_from, recorded_by_person, recorded_by_account)
         values ($1, $2, $3, now() - interval '1 day', $4, $5)`,
        [op, code, source, by.person_id, by.id],
      ),
    );
  }

  async function issued(): Promise<{ batchId: string; driver: RunDriver }> {
    const issuer = await gmp.asPersona('issuer');
    const plan = await planned(issuer);
    const { result } = await signIssue(issuer, plan.batchId);
    if (!result.ok) throw new Error(`SETUP: the issue was refused: ${JSON.stringify(refusalOf(result))}`);
    return { batchId: plan.batchId, driver: new RunDriver(gmp, plan.batchId, { issuer, operator1: await gmp.asPersona('operator1') }) };
  }

  /** The step signature's own authority check, past the server: STEP.SIGN_PERFORMED in the scope the batch_step provider gives. */
  async function signatureCheck(batchId: string): Promise<{ allowed: boolean; reasons: string[]; scope: Json }> {
    const op = personaIn(gmp, 'operator1');
    const { rows } = await gmp.db.admin.query<{ r: { allowed: boolean; reasons: string[]; scope: Json } }>(
      `select iam.evaluate_authority($1, (select id from iam.account where login_name = $3),
                                     'STEP.SIGN_PERFORMED', esig.provide('batch_step', $2) -> 'scope', null, 'OPERATOR') as r`,
      [op.personId, `${batchId}:${STEP}`, op.loginName],
    );
    return rows[0]!.r;
  }

  /** The batch issued and its first step started and recorded by operator1 (before the requirement under test, when `early` is false). */
  async function recorded(): Promise<{ batchId: string; driver: RunDriver }> {
    const r = await issued();
    await r.driver.ok('operator1', { type: 'START_STEP', stepKey: STEP });
    await r.driver.ok('operator1', { type: 'RECORD_ENTRY', stepKey: STEP, entry: { kind: 'ACKNOWLEDGE', mode: 'READ' } });
    return r;
  }

  const scopeOfBatch = () => ({ site: SITE, product: gmpMbr.header.product.code });

  it('[IN-04][DI-21][INV-26][DI-17] a requirement limited to another product does not apply: the operator starts, records and signs PERFORMED on this product\'s batch, and the signature\'s evaluation names the batch\'s product', async () => {
    const req = await requirement({ product: `OTHER-${tag()}` });
    try {
      const { batchId, driver } = await recorded();
      expect(await signatureCheck(batchId)).toMatchObject({ allowed: true, reasons: [], scope: scopeOfBatch() });
      const signed = await driver.signed('operator1', { type: 'SIGN_PERFORMED', stepKey: STEP });
      expect(signed.manifestation).toBeDefined();
      const { rows } = await gmp.db.admin.query<{ scope: Json; allowed: boolean }>(
        `select e.scope, e.allowed from esig.signature s join iam.authority_evaluation e on e.id = s.authority_evaluation_id
          where s.aggregate_ref = 'batch_step:' || $1::text`,
        [`${batchId}:${STEP}`],
      );
      expect(rows).toEqual([{ scope: scopeOfBatch(), allowed: true }]);
    } finally {
      await endRequirement(req.id);
    }
  }, 300_000);

  it('[IN-04][DI-21][INV-26] a requirement limited to this batch\'s product applies: the unqualified operator is refused the step signature, and once qualified signs', async () => {
    const { batchId, driver } = await recorded();
    const req = await requirement({ product: gmpMbr.header.product.code });
    try {
      expect(await signatureCheck(batchId)).toMatchObject({ allowed: false, reasons: [`MISSING_QUALIFICATION:${req.code}`], scope: scopeOfBatch() });
      const refused = await driver.sign('operator1', { type: 'SIGN_PERFORMED', stepKey: STEP });
      expect(refused.result.ok).toBe(false);
      expect(JSON.stringify(refusalOf(refused.result))).toContain(`MISSING_QUALIFICATION:${req.code}`);
      await qualify(req.code, 'INTERNAL');
      expect(await signatureCheck(batchId)).toMatchObject({ allowed: true, reasons: [] });
      expect((await driver.signed('operator1', { type: 'SIGN_PERFORMED', stepKey: STEP })).manifestation).toBeDefined();
    } finally {
      await endRequirement(req.id);
    }
  }, 300_000);

  it('[IN-04][DI-21][INV-26] a requirement without a product limit still applies to every batch of the site', async () => {
    const { batchId, driver } = await recorded();
    const req = await requirement({});
    try {
      expect(await signatureCheck(batchId)).toMatchObject({ allowed: false, reasons: [`MISSING_QUALIFICATION:${req.code}`], scope: scopeOfBatch() });
      const refused = await driver.sign('operator1', { type: 'SIGN_PERFORMED', stepKey: STEP });
      expect(refused.result.ok).toBe(false);
      expect(JSON.stringify(refusalOf(refused.result))).toContain(`MISSING_QUALIFICATION:${req.code}`);
    } finally {
      await endRequirement(req.id);
    }
  }, 300_000);

  it('[DI-31][IN-04][INV-26] a requirement limited to this batch\'s product, held only from a stale LMS mirror, is still refused (STALE_QUALIFICATION_SOURCE)', async () => {
    const { batchId, driver } = await recorded();
    const req = await requirement({ product: gmpMbr.header.product.code });
    const before = (await gmp.db.admin.query<{ last_synced_at: Date }>("select last_synced_at from iam.mirror_heartbeat where source_code = 'LMS'")).rows[0]?.last_synced_at;
    try {
      await asOwner((c) => c.query("update iam.mirror_heartbeat set last_synced_at = now() - interval '30 days' where source_code = 'LMS'"));
      await qualify(req.code, 'LMS');
      expect(await signatureCheck(batchId)).toMatchObject({ allowed: false, reasons: [`STALE_QUALIFICATION_SOURCE:${req.code}`], scope: scopeOfBatch() });
      const refused = await driver.sign('operator1', { type: 'SIGN_PERFORMED', stepKey: STEP });
      expect(refused.result.ok).toBe(false);
      expect(JSON.stringify(refusalOf(refused.result))).toContain(`STALE_QUALIFICATION_SOURCE:${req.code}`);
    } finally {
      await endRequirement(req.id);
      if (before) await asOwner((c) => c.query("update iam.mirror_heartbeat set last_synced_at = $1 where source_code = 'LMS'", [before]));
    }
  }, 300_000);

  it('[DI-31] F-6jb-2: the stale-mirror refusal names the mirror, its age and the system owner to call', async () => {
    const { batchId, driver } = await recorded();
    const req = await requirement({ product: gmpMbr.header.product.code });
    const before = (await gmp.db.admin.query<{ last_synced_at: Date }>("select last_synced_at from iam.mirror_heartbeat where source_code = 'LMS'")).rows[0]?.last_synced_at;
    try {
      await asOwner((c) => c.query("insert into iam.mirror_heartbeat (source_code, last_synced_at) values ('LMS', now() - interval '30 days') on conflict (source_code) do update set last_synced_at = excluded.last_synced_at"));
      await qualify(req.code, 'LMS');
      expect((await signatureCheck(batchId)).reasons).toEqual([`STALE_QUALIFICATION_SOURCE:${req.code}`]);
      const refused = await driver.sign('operator1', { type: 'SIGN_PERFORMED', stepKey: STEP });
      expect(refused.result.ok).toBe(false);
      const r = refusalOf(refused.result) as unknown as { why: string; whoCanHelp: string[]; whatYouCanDo: string[]; details?: Record<string, string> };
      expect(r.why).toContain(`STALE_QUALIFICATION_SOURCE:${req.code}`);
      expect(r.why).toMatch(/the LMS qualification heartbeat is stale: last synchronised \d+ s ago, more than its bound of \d+ s; call the LMS system owner/);
      expect(r.details).toMatchObject({ staleMirror: 'LMS qualification heartbeat', systemOwner: 'the LMS system owner' });
      expect(BigInt(r.details?.['staleMirrorAgeSeconds'] ?? '0')).toBeGreaterThanOrEqual(2_592_000n);
      expect(r.whoCanHelp[0]).toBe('The LMS system owner');
      expect(r.whatYouCanDo[0]).toMatch(/^Call the LMS system owner/);
    } finally {
      await endRequirement(req.id);
      await asOwner((c) => (before ? c.query("update iam.mirror_heartbeat set last_synced_at = $1 where source_code = 'LMS'", [before]) : c.query("delete from iam.mirror_heartbeat where source_code = 'LMS'")));
    }
  }, 300_000);
});
