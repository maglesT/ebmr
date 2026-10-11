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
import { sha256Hex } from '@ebmr/expr';
import { flow } from '@ebmr/recipe-core';
import { routes, type SignatureCredentials } from '@ebmr/api-contract';
import { openPersonaSession, openServiceSession } from '@ebmr/test-kit';
import { esig, withCommand } from '@ebmr/kernel';
import { cmd, signatureAuth } from '../../../../packages/kernel/test/esig/helpers.ts';
import type { SeededActor } from '../../../../packages/kernel/test/identity/seed.ts';
import type { TestDatabase } from '../../../../packages/kernel/test/support/db.ts';
import { cell, reason, World, type Cast } from '../../../../packages/recipe-core/test/lifecycle/support.ts';
import { postOrder } from '../../../../packages/recipe-core/test/lifecycle/gmp-support.ts';
import type { TestBrowser, TestServer } from '../support/harness.ts';
import { recordContentForSigning } from '../../src/features/esig/content.ts';
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
