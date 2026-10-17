/**
 * The GB-T-01 world (Phase 3 slice 6d; D-S6-5, D-S6-6): a GMP installation made by the set-up CLI with every feature
 * seed (the shop-floor personas, the ERP catalogue and orders, the GB-T-01 lots tested and released), a GMP server on it
 * with the installation's own DEMO-ONLY seal key, and the master record made the way a site makes it:
 *  - the formula: the formulation steward records it and its version, the QA approver signs FORMULA_APPROVED (routes);
 *  - the MBR: the author creates the family from the gb-t-01 template with the approved formula version ("Choose a
 *    product", routes), the change record, risk assessment, draft attributes and the sandbox run's evidence are recorded
 *    in the database by their owners (no route records them in Phase 3: a residual), the author starts the verification
 *    (route), and the author, the checker, the regulatory reviewer and QA sign PREPARED, CHECKED, REGULATORY_CONFIRMED and
 *    APPROVED through the e-signature ceremony (MBR_TRANSITION);
 *  - the market authorisation (QA and regulatory signatures) and the batch-number rule, in the database by their owners
 *    (no route in Phase 3).
 * Every act runs as the persona, in its own session, through the application role; the database decides.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type pg from 'pg';
import { sha256Hex } from '@ebmr/expr';
import { lifecycle } from '@ebmr/recipe-core';
import { esig, identity, withCommand, type ActorContext } from '@ebmr/kernel';
import { routes, type FormulaLineInput, type SignableAction, type SignatureCredentials } from '@ebmr/api-contract';
import { dropDatabase, openPersonaSession, personaOf, terminalOf, type SiteSeed } from '@ebmr/test-kit';
import { setupInstallation } from '../../../src/cli/setup.ts';
import { recordContentForSigning } from '../../../src/features/esig/content.ts';
import { loadValidationContext } from '../../../src/features/designer/adapters/expressions.ts';
import { GBT01_PRODUCT } from '../../../src/features/execution/seed-gb-t-01.ts';
import type { RunReport } from '../../../src/analytics/runner.ts';
import { startServer, type TestBrowser, type TestServer } from '../../support/harness.ts';
import { probe, releaseMethodVersion } from '../../analytics/support.ts';
import { actorOfBrowser, refusalOf } from '../../esig/support.ts';

export const SITE = 'SITE-1';
export const LINE = 'L1';
export const BATCH_SIZE_ID = 'BS-200K';

/** The formula of GB-T-01 per tablet (README.md): the active stated as its base with the salt-to-base factor. */
export const GBT01_FORMULA_LINES: FormulaLineInput[] = [
  { lineId: 'api', materialCode: 'MAT-EXZ-NA', role: 'ACTIVE', basis: 'PER_UNIT', quantity: '250', saltFactor: '1.07318', potencyAdjusted: true, compensating: false },
  { lineId: 'mcc', materialCode: 'MAT-MCC-101', role: 'EXCIPIENT', basis: 'PER_UNIT', quantity: '40', potencyAdjusted: false, compensating: true },
  { lineId: 'lac', materialCode: 'MAT-LAC-MH', role: 'EXCIPIENT', basis: 'PER_UNIT', quantity: '70', potencyAdjusted: false, compensating: false },
  { lineId: 'pvp', materialCode: 'MAT-PVP-K30', role: 'EXCIPIENT', basis: 'PER_UNIT', quantity: '12', potencyAdjusted: false, compensating: false },
  { lineId: 'ipa', materialCode: 'MAT-IPA', role: 'PROCESSING_AID', basis: 'PER_BATCH', quantity: '2.400', potencyAdjusted: false, compensating: false },
  { lineId: 'ccs', materialCode: 'MAT-CCS', role: 'EXCIPIENT', basis: 'PER_UNIT', quantity: '12', potencyAdjusted: false, compensating: false },
  { lineId: 'sio', materialCode: 'MAT-SIO2', role: 'EXCIPIENT', basis: 'PER_UNIT', quantity: '2', potencyAdjusted: false, compensating: false },
  { lineId: 'mgs', materialCode: 'MAT-MGST', role: 'EXCIPIENT', basis: 'PER_UNIT', quantity: '4', potencyAdjusted: false, compensating: false },
  { lineId: 'fcs', materialCode: 'MAT-FCS-W', role: 'PROCESSING_AID', basis: 'PER_BATCH', quantity: '2.450', potencyAdjusted: false, compensating: false },
];

export interface GoldenWorld {
  server: TestServer;
  seed: SiteSeed;
  keysDir: string;
  /** Browsers of the office personas (and later the floor's), one session each. */
  b: Record<string, TestBrowser>;
  formulaVersionId: string;
  familyId: string;
  versionId: string;
  /** Signatures made while the master record was prepared (the formula and the MBR life cycle). */
  masterSignatures: number;
  /** Refused MBR_TRANSITION attempts (status and code), for the assertions. */
  masterChecks: Record<string, string>;
  /**
   * Phase 6A slice 6A-1 (DI-51): the analytics runner is on through the whole run (it polls every minute, at whatever
   * point of the scenario that falls); this looks once more for completed batches and runs every method version in
   * force on demand, as the probe method of the runner tests (it reads the batch facts and the critical values).
   */
  analytics(): Promise<RunReport[]>;
  close(): Promise<void>;
}

const password = (seed: SiteSeed, key: string): SignatureCredentials => ({ kind: 'PASSWORD', loginName: personaOf(seed, key).loginName, password: personaOf(seed, key).password });

/** The ceremony of a signable action by an office persona (describe, preview, challenge on the text shown, sign). */
export async function signOffice(seed: SiteSeed, b: TestBrowser, key: string, action: SignableAction) {
  const described = await b.call(routes.esig.describe, { body: { action } });
  if (!described.ok) return described;
  const d = described.value;
  const shown = await b.call(routes.esig.content, { query: { aggregateType: d.aggregateType, aggregateId: d.aggregateId, intent: d.meaning ?? '' } });
  if (!shown.ok) return shown;
  const preview = shown.value;
  const challenge = await b.call(routes.esig.createChallenge, {
    body: { aggregateType: d.aggregateType, aggregateId: d.aggregateId, contentVersion: preview.contentVersion, meaning: d.meaning ?? '', clientContentHash: sha256Hex(preview.canonicalText), action },
  });
  if (!challenge.ok) return challenge;
  const body = { challengeId: challenge.value.challengeId, credentials: password(seed, key), action };
  return b.call(routes.esig.sign, { body: { ...body, proof: await b.proof('POST', '/api/esig/sign', body) } });
}

/** A database command of persona `key` in the session of its browser `b` (with its own reason when one is needed). */
export async function asPersona<T>(server: TestServer, b: TestBrowser, key: string, work: (c: pg.PoolClient) => Promise<T>, reason?: { reasonCode: string; reasonText: string }): Promise<T> {
  const actor: ActorContext = await actorOfBrowser(server, b, key, reason ?? {});
  return withCommand(server.db.app, actor, work);
}

/**
 * A signature of an office persona on an aggregate no signable action covers in Phase 3 (the market authorisation): the
 * kernel's ceremony in the persona's own session, its password at its home terminal, sealed with the installation's key.
 */
export async function signDirect(
  server: TestServer,
  seed: SiteSeed,
  key: string,
  aggregateType: string,
  aggregateId: string,
  meaning: string,
  expectedState: string | null,
  /** A personal (office) terminal to sign at instead of the persona's home terminal (a kiosk persona's office PC). */
  terminalCode?: string,
): Promise<string> {
  const sealKey = server.built.ctx.sealKey;
  if (!sealKey) throw new Error('the GMP server has no seal key');
  const p = personaOf(seed, key);
  const t = terminalOf(seed, terminalCode ?? p.homeTerminal);
  const actor = { ...(await openPersonaSession(server.db, seed, key, terminalCode)), correlationId: randomUUID() };
  const content = await recordContentForSigning(server.db.app, aggregateType, aggregateId);
  const challenge = await withCommand(server.db.app, actor, (c) =>
    esig.createChallenge(c, { aggregateType, aggregateId, contentVersion: content.contentVersion ?? '1', meaning, clientContentHash: content.contentHash ?? '' }),
  );
  const ev = await identity.authenticate(server.db.authn, { method: 'PASSWORD', identifier: p.loginName, secret: p.password, deviceFingerprint: t.fingerprint, purpose: 'SIGNATURE', challengeId: challenge.challengeId });
  const signed = await withCommand(server.db.app, { ...actor, correlationId: randomUUID() }, (c) => esig.sign(c, { challengeId: challenge.challengeId, authEventId: ev.authEventId, expectedState }, sealKey));
  return signed.signatureId;
}

function ok<T>(r: { ok: true; value: T } | { ok: false; error: unknown }, what: string): T {
  if (!r.ok) throw new Error(`${what} was refused: ${JSON.stringify(refusalOf(r as never))}`);
  return r.value;
}

/** The installation, the server and the approved, authorised GB-T-01 master. */
export async function startGoldenWorld(): Promise<GoldenWorld> {
  const keysDir = mkdtempSync(join(tmpdir(), 'ebmr-gbt01-'));
  const database = `ebmr_gbt01_${randomBytes(4).toString('hex')}`;
  const seed = await setupInstallation({ installation: 'GMP', database, keysDir: join(keysDir, 'keys'), exchangeDir: join(keysDir, 'exchange'), personaSets: 1, recreate: true, log: () => undefined });
  let server: TestServer;
  try {
    server = await startServer('GMP', {
      prepared: { database, seed },
      paceDeviceNonces: true,
      env: { EBMR_SEAL_KEY_FILE: join(keysDir, 'keys', 'gmp-seal-key.json'), EBMR_NUMBER_LEDGER_FILE: join(keysDir, 'numbers.ledger.jsonl'), EBMR_ANALYTICS: 'on' },
      analytics: { implementations: [probe('SPC.IMR')], pollMs: 60_000 },
    });
    // A method version in force for the runner, as a release writes it.
    await releaseMethodVersion(server, 'SPC.IMR', 1);
  } catch (e) {
    await dropDatabase(database);
    throw e;
  }
  const b: Record<string, TestBrowser> = {};
  for (const k of ['steward', 'approver', 'author', 'checker', 'regulatory', 'issuer']) b[k] = await server.asPersona(k);
  const s = (k: string): TestBrowser => {
    const x = b[k];
    if (!x) throw new Error(`no browser for ${k}`);
    return x;
  };
  let signatures = 0;
  const sign = async (key: string, action: SignableAction, what: string) => {
    ok(await signOffice(seed, s(key), key, action), what);
    signatures += 1;
  };

  // The formula (decision 0006 part 1): recorded by the steward, approved by QA.
  const md = routes.masterData;
  const formulaId = ok(await s('steward').call(md.createFormula, { body: { productCode: GBT01_PRODUCT.productCode, strength: GBT01_PRODUCT.strength, batchSizeUnits: '200000' } }), 'the formula').formulaId;
  const fv = ok(await s('steward').call(md.addFormulaVersion, { params: { formulaId }, body: { changeReason: 'GB-T-01 formula (invented, decision 0006 part 3)', lines: GBT01_FORMULA_LINES } }), 'the formula version');
  await sign('approver', { kind: 'MASTER_DATA_APPROVE', masterKind: 'FORMULA', versionId: fv.versionId }, 'the formula approval');

  // The MBR from the template with the approved formula ("Choose a product").
  const created = ok(
    await s('author').call(routes.designer.createFamily, {
      body: {
        templateId: 'gb-t-01',
        familyCode: 'GBT01-250-WG',
        product: { code: GBT01_PRODUCT.productCode, name: 'Exemplazine tablets', strength: GBT01_PRODUCT.strength },
        batchSizes: [{ quantity: '81.659', unit: 'kg' }],
        markets: ['IN'],
        formulaVersionId: fv.versionId,
      },
    }),
    'the MBR family',
  );
  const versionId = created.versionId;
  const familyId = created.familyId;

  // What no Phase 3 route records: QA's change record and risk assessment, the author's draft attributes and the sandbox run.
  const qa = s('approver');
  const changeRecordId = await asPersona(server, qa, 'approver', (c) =>
    lifecycle.recordChangeRecord(c, { number: 'CC-GBT01-001', title: 'New product GB-T-01 (invented)', changeClass: 'MAJOR', processImpacting: true, validationRef: 'VR-GBT01' }),
  );
  const riskId = await asPersona(server, qa, 'approver', (c) =>
    lifecycle.recordRiskAssessment(c, { code: 'RA-GBT01-001', version: '1', title: 'GB-T-01 process risk assessment', riskClass: 'MEDIUM', rationaleRef: 'QRM-GBT01-IPC' }),
  );
  await asPersona(
    server,
    s('author'),
    'author',
    async (c) => {
      await lifecycle.setDraftAttributes(c, versionId, { changeRecordId, effectiveFrom: '2026-01-01T00:00:00Z', reviewDue: '2028-12-31' });
      await lifecycle.linkRiskAssessment(c, versionId, riskId);
    },
    { reasonCode: 'NEW_MASTER', reasonText: 'GB-T-01 master: change record, review date and risk assessment' },
  );
  const content = (await lifecycle.loadContent(server.db.app, versionId)).content;
  await asPersona(server, s('author'), 'author', (c) =>
    lifecycle.recordEvidence(c, versionId, 'SANDBOX_RUN', lifecycle.sandboxRunEvidence(content, { runId: 'SBX-GBT01-001', sandbox: 'ebmr_sandbox_tablets', coverage: { steps: '100%' }, passed: true })),
  );

  // Verification and the four signatures through the routes.
  const head = ok(await s('author').call(routes.designer.version, { params: { versionId } }), 'the version');
  const started = ok(await s('author').call(routes.designer.startVerification, { params: { versionId }, body: { baseRevision: head.revision } }), 'the start of the verification');
  // The author's full verification (simulation with coverage, test vectors confirmed) of the content now in verification:
  // no Phase 3 route records it (a residual); the real verification port of the designer, as the start's validator.
  const { context } = await loadValidationContext(server.db.app, content);
  const verification = lifecycle.createVerificationPort(context).verify(content, []);
  await asPersona(server, s('author'), 'author', (c) => lifecycle.recordVerification(c, versionId, verification, [], personaOf(seed, 'author').personId));
  const t = (transition: 'SUBMIT' | 'CHECK' | 'APPROVE' | 'REGULATORY_CONFIRM') => ({ kind: 'MBR_TRANSITION' as const, versionId, transition, baseRevision: started.revision });
  const outcome = (r: { ok: true } | { ok: false; error: unknown }): string => {
    if (r.ok) return 'ok';
    const x = refusalOf(r as never) as { status: number; code: string };
    return `${String(x.status)} ${x.code}`;
  };
  const checks: Record<string, string> = {};
  await sign('author', t('SUBMIT'), 'PREPARED');
  // Before the check: the approval is not due (the database refuses it in this state), and nothing is signed.
  checks['approveBeforeCheck'] = outcome(await signOffice(seed, s('approver'), 'approver', t('APPROVE')));
  await sign('checker', t('CHECK'), 'CHECKED');
  await sign('regulatory', t('REGULATORY_CONFIRM'), 'REGULATORY_CONFIRMED');
  // The author does not approve their own master; a revision other than the one reviewed answers 409.
  checks['approveByAuthor'] = outcome(await signOffice(seed, s('author'), 'author', t('APPROVE')));
  checks['approveStale'] = outcome(await signOffice(seed, s('approver'), 'approver', { ...t('APPROVE'), baseRevision: started.revision + 1 }));
  await sign('approver', t('APPROVE'), 'APPROVED');

  // The market authorisation for India at SITE-1, line L1, BS-200K; the batch-number rule of the product.
  const def: lifecycle.MarketAuthorisationDefinition = { versionId, market: 'IN', kind: 'CURRENT', cells: [{ site: SITE, line: LINE, batch_size: BATCH_SIZE_ID }], regulatoryBasis: 'IN: registration on file (invented product)' };
  const maId = await asPersona(server, qa, 'approver', (c) => lifecycle.proposeMarketAuthorisation(c, def));
  const qaSig = await signDirect(server, seed, 'approver', lifecycle.MARKET_AUTHORISATION_AGGREGATE, maId, 'MBR_MARKET_AUTHORISED', 'PROPOSED');
  const regSig = await signDirect(server, seed, 'regulatory', lifecycle.MARKET_AUTHORISATION_AGGREGATE, maId, 'REGULATORY_CONFIRMED', 'PROPOSED');
  signatures += 2;
  await asPersona(server, qa, 'approver', (c) => lifecycle.activateMarketAuthorisation(c, maId, qaSig, regSig), { reasonCode: 'MARKET_AUTHORISED', reasonText: 'IN: GB-T-01 authorised at SITE-1 L1' });
  await asPersona(
    server,
    s('steward'),
    'steward',
    (c) =>
      c.query('select site.define_batch_number_rule($1::jsonb)', [
        JSON.stringify({ rule_code: 'GBT01-PROC', site_code: SITE, product_code: GBT01_PRODUCT.productCode, batch_kind: 'PROCESSING', format: 'GBT{YY}{SEQ:4}', site_zone: 'Asia/Kolkata', reason: 'Numbering SOP-QA-017 rev 3' }),
      ]),
    { reasonCode: 'NEW_PRODUCT', reasonText: 'Batch numbering of GB-T-01' },
  );

  return {
    server,
    seed,
    keysDir,
    b,
    formulaVersionId: fv.versionId,
    familyId,
    versionId,
    masterSignatures: signatures,
    masterChecks: checks,
    async analytics() {
      const runner = server.built.analytics;
      if (!runner) throw new Error('the golden server runs without its analytics runner');
      await runner.tick();
      return runner.runAll('ON_DEMAND');
    },
    async close() {
      await server.close();
      rmSync(keysDir, { recursive: true, force: true });
    },
  };
}
