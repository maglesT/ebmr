/**
 * DEMO-ONLY: a GMP batch record ready for review (Phase 4 slice 1c; set-up CLI `--gmp-review-batch`). The Phase 4 demo
 * and the review e2e specs need a batch at EXECUTION_COMPLETE with entries, exceptions and an output container; the
 * e2e stack otherwise has no effective GMP master and no issued GMP batch. Never run on a production installation (the
 * set-up CLI refuses EBMR_ENV=production).
 *
 * Every act below is the seeded persona's own, through the real server built in-process on the database (buildApp,
 * driven through app.inject the way a browser drives it: session cookie, CSRF token, device proofs signed with the
 * terminal's DEMO-ONLY key, badge taps at the kiosks) and the e-signature ceremony with the persona's password or PIN:
 *  1. the GB-T-01 formula (steward) and its QA approval; the MBR family from the gb-t-01 template; QA's change record
 *     and risk assessment, the author's draft attributes, the sandbox run's evidence and the author's verification in
 *     the database by their owners (no route records them yet, as in the GB-T-01 golden world); PREPARED, CHECKED,
 *     REGULATORY_CONFIRMED and APPROVED through MBR_TRANSITION; the market authorisation (QA and regulatory) and the
 *     batch-number rule (steward);
 *  2. the issuer plans the batch against the oldest open GB-T-01 ERP order (posted by the GMP seed) and signs ISSUED;
 *  3. the dispensing booth DISP-1 and the press PRESS-01 in the plant lists (steward), DISP-1 cleaned and verified
 *     (technicians), cleared and verified at the kiosk, occupied for the stage; the first step (line clearance) is run:
 *     started, its occupancy entry, two alerts and one action exception raised by the operator, PERFORMED and VERIFIED;
 *     QA raises two deviation-lite records (one for the two alerts, one for the action exception), the supervisor
 *     attaches them, and QA on the floor dispositions each exception DEVIATION_RAISED;
 *  4. an output container of the batch at COMPRESSION on PRESS-01 is opened by the operator and left OPEN, and a failed
 *     in-process check on the press puts a hold on it (it is HELD once closed);
 *  5. DEMO SHORTCUT, never a GMP code path: the record's execution status is set to EXECUTION_COMPLETE by a superuser
 *     update (the remaining steps of the master are not run; the engine's completeness is proven by the golden batch).
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type pg from 'pg';
import { canonicalJson, sha256Hex } from '@ebmr/expr';
import { lifecycle } from '@ebmr/recipe-core';
import { esig, identity, withCommand, type ActorContext } from '@ebmr/kernel';
import { createApiClient, routes, type ApiClient, type ClientIntent, type DeviceProof, type FetchLike, type FormulaLineInput, type Result, type SignableAction, type SignedIntent } from '@ebmr/api-contract';
import { freshTap, openPersonaSession, openServiceSession, personaOf, signDeviceProof, terminalOf, type DatabaseHandle, type SiteSeed } from '@ebmr/test-kit';
import { buildApp, type BuiltApp } from '../app.ts';
import { parseConfig } from '../config.ts';
import { loadValidationContext } from '../features/designer/adapters/expressions.ts';
import { recordContentForSigning } from '../features/esig/content.ts';
import { GBT01_PRODUCT } from '../features/execution/seed-gb-t-01.ts';
import { PACK_SIZE_ID, PACK_TYPE, packagingMasterContent } from './packaging-master.ts';
import { newSessionToken, tokenHash } from '../platform/auth/session.ts';

const ORIGIN = 'http://localhost:3001';
const SITE = 'SITE-1';
const LINE = 'L1';
const BATCH_SIZE_ID = 'BS-200K';

/** The GB-T-01 formula per tablet (as the golden world records it). */
const FORMULA_LINES: FormulaLineInput[] = [
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

export interface ReviewBatchSeedOptions {
  database: string;
  keysDir: string;
  exchangeDir: string;
  seed: SiteSeed;
  db: DatabaseHandle;
  log: (message: string) => void;
  /** Also build the packaging-order demo (Phase 4 slice 2c; set-up CLI --gmp-packaging): see step 6. */
  packaging?: boolean;
}

/** DEMO-ONLY data of the packaging-order demo (step 6). */
export interface PackagingSeed {
  /** The open ERP order of the packaging master, not yet planned. */
  orderNo: string;
  familyCode: string;
  packType: string;
  line: string;
  /** The second GB-T-01 batch, issued, released for packing by the DEMO SHORTCUT, with usable containers. */
  parentBatchId: string;
  parentBatchNumber: string;
  containers: string[];
}

export interface ReviewBatchSeed {
  batchId: string;
  batchNumber: string;
  /** The OPEN output container on PRESS-01 with a pending hold (HELD once closed). */
  containerId: string;
  containerLabel: string;
  packaging?: PackagingSeed;
  /** The release demo (step 7, with --gmp-packaging): a finished lot in quarantine, NOT_READY. */
  release?: ReleaseSeed;
}

/** DEMO-ONLY data of the release demo (step 7). */
export interface ReleaseSeed {
  lotId: string;
  lotCode: string;
  /** The packaging order the lot was posted from (its record marked complete by the DEMO SHORTCUT). */
  orderBatchId: string;
  orderBatchNumber: string;
}

interface Browser {
  key: string;
  terminal: string;
  kiosk: boolean;
  actor: ActorContext & { deviceId: string };
  api: ApiClient;
  proof(method: string, path: string, body: Record<string, unknown>): Promise<DeviceProof>;
}

function value<T>(r: Result<T>, what: string): T {
  if (r.ok) return r.value;
  const e = r.error;
  throw new Error(`${what} was refused: ${e.kind === 'REFUSAL' ? `${String(e.status)} ${e.envelope.refusal.code}: ${e.envelope.refusal.whatHappened} ${e.envelope.refusal.why}` : JSON.stringify(e)}`);
}

function parseSetCookie(header: string | string[] | undefined, jar: Map<string, string>): void {
  for (const line of header === undefined ? [] : Array.isArray(header) ? header : [header]) {
    const [pair = ''] = line.split(';');
    const i = pair.indexOf('=');
    if (i <= 0) continue;
    const v = pair.slice(i + 1).trim();
    if (v === '' || /max-age=0/i.test(line)) jar.delete(pair.slice(0, i).trim());
    else jar.set(pair.slice(0, i).trim(), v);
  }
}

const DEMO_DATABASE = /(_demo$|_e2e_[a-z0-9]+$)/;

/** Refuses unless the database is named as a demo or E2E one and carries the tab.demo_installation mark. */
export async function assertDemoInstallation(db: DatabaseHandle, database: string): Promise<void> {
  const marked = (await db.admin.query<{ m: boolean }>('select exists (select 1 from tab.demo_installation) as m')).rows[0]?.m === true;
  if (!DEMO_DATABASE.test(database) || !marked) {
    throw new Error(`the DEMO-ONLY seed refuses database ${database}: it is not a marked demo installation (tab.demo_installation)`);
  }
}

/** Builds a GMP batch record ready for review on an installation the set-up CLI has just seeded. */
export async function seedReviewBatch(opts: ReviewBatchSeedOptions): Promise<ReviewBatchSeed> {
  const { db, log } = opts;
  // DEMO-ONLY (slice 2 review): the shortcuts below run only on a database the set-up marked as a demo installation.
  await assertDemoInstallation(db, opts.database);
  const admin = new URL(process.env['EBMR_PG_ADMIN_URL'] ?? 'postgres://ebmr_dev:ebmr_dev@localhost:5432/postgres');
  const env = parseConfig(
    {
      EBMR_INSTALLATION: 'GMP',
      EBMR_DATABASE: opts.database,
      EBMR_PG_HOST: admin.hostname,
      EBMR_PG_PORT: admin.port === '' ? '5432' : admin.port,
      EBMR_PUBLIC_ORIGIN: ORIGIN,
      EBMR_ENV: 'development',
      EBMR_LOG_LEVEL: 'silent',
      EBMR_SEAL_KEY_FILE: join(opts.keysDir, 'gmp-seal-key.json'),
      EBMR_SECRETS_FILE: join(opts.keysDir, 'gmp-secrets.json'),
      EBMR_EXCHANGE_DIR: opts.exchangeDir,
      EBMR_NUMBER_LEDGER_FILE: join(opts.keysDir, 'gmp-numbers.ledger.jsonl'),
    },
    () => randomBytes(32).toString('hex'),
  );
  const built: BuiltApp = await buildApp(env, { pools: { app: db.app, authn: db.authn, close: () => Promise.resolve() } });
  try {
    return await run(built, opts, log);
  } finally {
    await built.close();
  }
}

async function run(built: BuiltApp, opts: ReviewBatchSeedOptions, log: (m: string) => void): Promise<ReviewBatchSeed> {
  const { seed, db } = opts;
  const app = built.app;
  const sealKey = built.ctx.sealKey;
  if (!sealKey) throw new Error('the GMP server has no seal key');
  const cookie = built.ctx.config.cookies.session;

  /** A browser of persona `key` at `terminal` (default: its home terminal), signed in through the kernel. */
  const browserOf = async (key: string, terminal?: string): Promise<Browser> => {
    const p = personaOf(seed, key);
    const code = terminal ?? p.homeTerminal;
    const t = terminalOf(seed, code);
    const actor = await openPersonaSession(db, seed, key, code);
    const token = newSessionToken();
    await db.app.query('select tab.bind_session($1, $2, $3)', [actor.sessionId, tokenHash(token), p.roleCode]);
    const jar = new Map<string, string>([[cookie, token]]);
    const held: { csrf?: string } = {};
    let lastNonce: string | undefined;
    const fetchLike: FetchLike = async (url, init) => {
      const res = await app.inject({
        method: init.method as 'GET',
        url,
        headers: { ...init.headers, cookie: [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ') },
        ...(init.body !== undefined ? { payload: init.body } : {}),
      });
      parseSetCookie(res.headers['set-cookie'], jar);
      return { status: res.statusCode, headers: { get: (n: string) => (res.headers[n.toLowerCase()] as string | undefined) ?? null }, text: () => Promise.resolve(res.body) };
    };
    const api = createApiClient({ fetch: fetchLike, installation: () => 'GMP', csrfToken: () => held.csrf, headers: () => ({ origin: ORIGIN, 'sec-fetch-site': 'same-origin' }) });
    held.csrf = value(await api.call(routes.session.get), `the session of ${key}`).csrfToken;
    const kiosk = t.deviceClass === 'SHARED' || t.deviceClass === 'GRADE_A_B';
    return {
      key,
      terminal: code,
      kiosk,
      actor,
      api,
      async proof(method, path, body) {
        const k = t.key;
        if (!k) throw new Error(`terminal ${code} has no browser key`);
        const n = value(await api.call(routes.session.deviceNonce, { body: { spki: k.publicKeySpki, ...(lastNonce !== undefined ? { lastNonce } : {}) } }), 'a device nonce');
        lastNonce = n.nonce;
        return { spki: k.publicKeySpki, nonce: n.nonce, sig: signDeviceProof(k, `${n.nonce}|${method.toUpperCase()}|${path}|${sha256Hex(canonicalJson(body))}`) };
      },
    };
  };
  const tapOf = async (b: Browser, path: string, body: Record<string, unknown>) => {
    const p = personaOf(seed, b.key);
    if (!p.badgeUid) throw new Error(`${b.key} has no badge`);
    return { method: 'BADGE_TAP' as const, badgeUid: p.badgeUid, proof: await b.proof('POST', path, body) };
  };
  const credentialsOf = (b: Browser) => {
    const p = personaOf(seed, b.key);
    return b.kiosk && p.pin ? { kind: 'PIN' as const, pin: p.pin } : { kind: 'PASSWORD' as const, loginName: p.loginName, password: p.password };
  };
  /** The ceremony of a signable action (describe, preview, challenge, sign); a kiosk challenge is tapped. */
  const sign = async (b: Browser, action: SignableAction, what: string, subject?: { aggregateType: string; aggregateId: string; meaning: string; intent?: string }) => {
    const d = subject ?? value(await b.api.call(routes.esig.describe, { body: { action } }), `the description of ${what}`);
    const meaning = d.meaning ?? '';
    const preview = value(await b.api.call(routes.esig.content, { query: { aggregateType: d.aggregateType, aggregateId: d.aggregateId, intent: subject?.intent ?? meaning } }), `the content of ${what}`);
    const body = { aggregateType: d.aggregateType, aggregateId: d.aggregateId, contentVersion: preview.contentVersion, meaning, clientContentHash: sha256Hex(preview.canonicalText), action };
    const challenge = value(await b.api.call(routes.esig.createChallenge, { body, ...(b.kiosk ? { attribution: await tapOf(b, '/api/esig/challenges', body) } : {}) }), `the challenge of ${what}`);
    const signBody = { challengeId: challenge.challengeId, credentials: credentialsOf(b), action };
    return value(await b.api.call(routes.esig.sign, { body: { ...signBody, proof: await b.proof('POST', '/api/esig/sign', signBody) } }), what);
  };
  /** A database command of the browser's persona in its own session (a fresh tap at a kiosk). */
  const dbAs = async <T>(b: Browser, sql: string, params: unknown[], reason?: { reasonCode: string; reasonText: string }): Promise<T> => {
    const actor: ActorContext = {
      ...b.actor,
      correlationId: randomUUID(),
      ...(b.kiosk ? { authEventId: await freshTap(db, seed, b.key, b.terminal) } : {}),
      ...(reason ?? {}),
    };
    return withCommand(db.app, actor, async (c: pg.PoolClient) => (await c.query<{ r: T }>(sql, params)).rows[0]?.r as T);
  };
  /** A signature on an aggregate no signable action covers yet (the market authorisation), in the persona's session. */
  const signDirect = async (b: Browser, aggregateType: string, aggregateId: string, meaning: string, expectedState: string): Promise<string> => {
    const p = personaOf(seed, b.key);
    const content = await recordContentForSigning(db.app, aggregateType, aggregateId);
    const challenge = await withCommand(db.app, { ...b.actor, correlationId: randomUUID() }, (c) =>
      esig.createChallenge(c, { aggregateType, aggregateId, contentVersion: content.contentVersion ?? '1', meaning, clientContentHash: content.contentHash ?? '' }),
    );
    const ev = await identity.authenticate(db.authn, { method: 'PASSWORD', identifier: p.loginName, secret: p.password, deviceFingerprint: terminalOf(seed, b.terminal).fingerprint, purpose: 'SIGNATURE', challengeId: challenge.challengeId });
    return (await withCommand(db.app, { ...b.actor, correlationId: randomUUID() }, (c) => esig.sign(c, { challengeId: challenge.challengeId, authEventId: ev.authEventId, expectedState }, sealKey))).signatureId;
  };

  const office: Record<string, Browser> = {};
  for (const k of ['steward', 'approver', 'author', 'checker', 'regulatory', 'issuer', 'technician1', 'technician2']) office[k] = await browserOf(k);
  const o = (k: string): Browser => {
    const b = office[k];
    if (!b) throw new Error(`no browser for ${k}`);
    return b;
  };

  // 1. The formula, the master record, its market authorisation and the batch-number rule.
  log('review batch: the GB-T-01 formula and master record');
  const md = routes.masterData;
  const tag = randomBytes(2).toString('hex').toUpperCase();
  const formulaId = value(await o('steward').api.call(md.createFormula, { body: { productCode: GBT01_PRODUCT.productCode, strength: GBT01_PRODUCT.strength, batchSizeUnits: '200000' } }), 'the formula').formulaId;
  const fv = value(await o('steward').api.call(md.addFormulaVersion, { params: { formulaId }, body: { changeReason: 'GB-T-01 formula (invented, decision 0006 part 3)', lines: FORMULA_LINES } }), 'the formula version');
  await sign(o('approver'), { kind: 'MASTER_DATA_APPROVE', masterKind: 'FORMULA', versionId: fv.versionId }, 'the formula approval');
  const created = value(
    await o('author').api.call(routes.designer.createFamily, {
      body: {
        templateId: 'gb-t-01',
        familyCode: `GBT01-250-WG-${tag}`,
        product: { code: GBT01_PRODUCT.productCode, name: 'Exemplazine tablets', strength: GBT01_PRODUCT.strength },
        batchSizes: [{ quantity: '81.659', unit: 'kg' }],
        markets: ['IN'],
        formulaVersionId: fv.versionId,
      },
    }),
    'the MBR family',
  );
  const versionId = created.versionId;
  const cr = await withCommand(db.app, { ...o('approver').actor, correlationId: randomUUID() }, (c) =>
    lifecycle.recordChangeRecord(c, { number: `CC-GBT01-${tag}`, title: 'New product GB-T-01 (invented)', changeClass: 'MAJOR', processImpacting: true, validationRef: 'VR-GBT01' }),
  );
  const ra = await withCommand(db.app, { ...o('approver').actor, correlationId: randomUUID() }, (c) =>
    lifecycle.recordRiskAssessment(c, { code: `RA-GBT01-${tag}`, version: '1', title: 'GB-T-01 process risk assessment', riskClass: 'MEDIUM', rationaleRef: 'QRM-GBT01-IPC' }),
  );
  await withCommand(db.app, { ...o('author').actor, correlationId: randomUUID(), reasonCode: 'NEW_MASTER', reasonText: 'GB-T-01 master: change record, review date and risk assessment' }, async (c) => {
    await lifecycle.setDraftAttributes(c, versionId, { changeRecordId: cr, effectiveFrom: '2026-01-01T00:00:00Z', reviewDue: '2028-12-31' });
    await lifecycle.linkRiskAssessment(c, versionId, ra);
  });
  const content = (await lifecycle.loadContent(db.app, versionId)).content;
  await withCommand(db.app, { ...o('author').actor, correlationId: randomUUID() }, (c) =>
    lifecycle.recordEvidence(c, versionId, 'SANDBOX_RUN', lifecycle.sandboxRunEvidence(content, { runId: `SBX-GBT01-${tag}`, sandbox: 'ebmr_sandbox_tablets', coverage: { steps: '100%' }, passed: true })),
  );
  const head = value(await o('author').api.call(routes.designer.version, { params: { versionId } }), 'the version');
  const started = value(await o('author').api.call(routes.designer.startVerification, { params: { versionId }, body: { baseRevision: head.revision } }), 'the start of the verification');
  const { context } = await loadValidationContext(db.app, content);
  const verification = lifecycle.createVerificationPort(context).verify(content, []);
  await withCommand(db.app, { ...o('author').actor, correlationId: randomUUID() }, (c) => lifecycle.recordVerification(c, versionId, verification, [], personaOf(seed, 'author').personId));
  const t = (transition: 'SUBMIT' | 'CHECK' | 'APPROVE' | 'REGULATORY_CONFIRM') => ({ kind: 'MBR_TRANSITION' as const, versionId, transition, baseRevision: started.revision });
  await sign(o('author'), t('SUBMIT'), 'PREPARED');
  await sign(o('checker'), t('CHECK'), 'CHECKED');
  await sign(o('regulatory'), t('REGULATORY_CONFIRM'), 'REGULATORY_CONFIRMED');
  await sign(o('approver'), t('APPROVE'), 'APPROVED');
  const def: lifecycle.MarketAuthorisationDefinition = { versionId, market: 'IN', kind: 'CURRENT', cells: [{ site: SITE, line: LINE, batch_size: BATCH_SIZE_ID }], regulatoryBasis: 'IN: registration on file (invented product)' };
  const maId = await withCommand(db.app, { ...o('approver').actor, correlationId: randomUUID() }, (c) => lifecycle.proposeMarketAuthorisation(c, def));
  const qaSig = await signDirect(o('approver'), lifecycle.MARKET_AUTHORISATION_AGGREGATE, maId, 'MBR_MARKET_AUTHORISED', 'PROPOSED');
  const regSig = await signDirect(o('regulatory'), lifecycle.MARKET_AUTHORISATION_AGGREGATE, maId, 'REGULATORY_CONFIRMED', 'PROPOSED');
  await withCommand(db.app, { ...o('approver').actor, correlationId: randomUUID(), reasonCode: 'MARKET_AUTHORISED', reasonText: 'IN: GB-T-01 authorised at SITE-1 L1' }, (c) => lifecycle.activateMarketAuthorisation(c, maId, qaSig, regSig));
  await dbAs(
    o('steward'),
    'select site.define_batch_number_rule($1::jsonb) as r',
    [JSON.stringify({ rule_code: `GBT01-PROC-${tag}`, site_code: SITE, product_code: GBT01_PRODUCT.productCode, batch_kind: 'PROCESSING', format: 'GBT{YY}{SEQ:4}', site_zone: 'Asia/Kolkata', reason: 'Numbering SOP-QA-017 rev 3' })],
    { reasonCode: 'NEW_PRODUCT', reasonText: 'Batch numbering of GB-T-01' },
  );

  // 2. Plan and issue.
  log('review batch: plan and issue');
  const planned = value(await o('issuer').api.call(routes.execution.planBatch, { body: { familyId: created.familyId, markets: ['IN'], site: SITE, line: LINE, batchSize: BATCH_SIZE_ID } }), 'the plan');
  const batchId = planned.batchId;
  await sign(o('issuer'), { kind: 'GMP_BATCH_ISSUE', batchId, reason: { code: 'PRODUCTION_PLAN', text: 'Issued for the production plan' }, variants: {}, inputs: { tabletsPerBatch: { kind: 'COUNT', value: '200000' } } }, 'the issue');

  // 3. The plant the first step stands on, and the first step.
  log('review batch: the dispensing booth, its clearance and the first step');
  const st = o('steward').api;
  const p = routes.plant;
  await dbAs(o('steward'), 'select plant.define_product($1::jsonb) as r', [JSON.stringify({ code: GBT01_PRODUCT.productCode, name: GBT01_PRODUCT.productName, highlyPotent: false })], {
    reasonCode: 'NEW_PRODUCT',
    reasonText: 'GB-T-01 in the plant product list',
  });
  value(await st.call(p.defineArea, { body: { code: 'DISP-1', kind: 'ROOM', name: 'Room DISP-1' } }), 'room DISP-1');
  value(await st.call(p.defineArea, { body: { code: 'COMP-1', kind: 'ROOM', name: 'Room COMP-1' } }), 'room COMP-1');
  value(await st.call(p.defineEquipmentClass, { body: { code: 'EQC-PRESS-GBT', kind: 'PROCESS', description: 'Double-rotary press, 45 stations', cleanHold: '72 hours', dirtyHold: '48 hours' } }), 'class EQC-PRESS-GBT');
  value(await st.call(p.defineEquipment, { body: { code: 'PRESS-01', name: 'Double-rotary press, 45 stations', classCode: 'EQC-PRESS-GBT', areaCode: 'COMP-1' } }), 'unit PRESS-01');
  const cleaning = value(await o('technician1').api.call(p.startCleaning, { body: { target: 'AREA', code: 'DISP-1', level: 'MAJOR', method: 'MANUAL' } }), 'the cleaning of DISP-1');
  value(await o('technician1').api.call(p.completeCleaning, { params: { id: cleaning.cleaningId }, body: {} }), 'the completion of the cleaning of DISP-1');
  await sign(o('technician2'), { kind: 'PLANT_VERIFY', act: 'CLEANING', id: cleaning.cleaningId }, 'the verification of the cleaning of DISP-1');

  const operator = await browserOf('operator2', 'KIOSK-DISP-1');
  const verifier = await browserOf('verifier1', 'KIOSK-DISP-1');
  const qa = await browserOf('qa1', 'KIOSK-DISP-1');
  const clearanceBody = { areaCode: 'DISP-1', type: 'PRODUCT_CHANGE' as const, batchId, result: 'PASSED' as const };
  const clearance = value(await operator.api.call(p.recordClearance, { body: clearanceBody, attribution: await tapOf(operator, '/api/plant/clearances', clearanceBody) }), 'the clearance of DISP-1');
  await sign(verifier, { kind: 'PLANT_VERIFY', act: 'CLEARANCE', id: clearance.clearanceId }, 'the verification of the clearance of DISP-1');
  const occupancy = await dbAs<string>(operator, 'select plant.start_area_occupancy($1, $2, $3) as r', ['DISP-1', batchId, 'S-DISP']);

  const version = async (b: Browser) => value(await b.api.call(routes.batches.batch, { params: { batchId } }), 'the batch').header.version;
  const command = async (b: Browser, intent: ClientIntent, what: string) => {
    const body = { expectedVersion: await version(b), intent };
    const path = `/api/batches/${batchId}/commands`;
    return value(await b.api.call(routes.batches.command, { params: { batchId }, body, ...(b.kiosk ? { attribution: await tapOf(b, path, body) } : {}) }), what);
  };
  const signed = async (b: Browser, intent: SignedIntent, subject: { aggregateType: string; aggregateId: string; meaning: string; intent?: string }, what: string) =>
    sign(b, { kind: 'ENGINE_COMMAND', runId: batchId, expectedVersion: await version(b), intent }, what, subject);

  const stepKey = 'p-disp-clear@';
  await command(operator, { type: 'START_STEP', stepKey }, 'the start of the line clearance');
  await command(operator, { type: 'RECORD_ENTRY', stepKey, entry: { kind: 'BLOCK_ENTRY', entryKind: 'AREA_OCCUPANCY', data: { areaCode: 'DISP-1', occupancyId: occupancy } } }, 'the occupancy entry');
  await command(operator, { type: 'RAISE_EXCEPTION', stepKey, description: 'Label of the previous product found on the booth door; removed and destroyed', severity: 'ALERT' }, 'the first alert');
  await command(operator, { type: 'RAISE_EXCEPTION', stepKey, description: 'Booth differential pressure briefly read 8 Pa (alert limit 10 Pa)', severity: 'ALERT' }, 'the second alert');
  // An action exception of the batch (no step): it needs a deviation, which QA raises and links (deviation-lite).
  await command(operator, { type: 'RAISE_EXCEPTION', description: 'Booth HEPA filter certificate found one day past its date; re-certified before dispensing', severity: 'ACTION' }, 'the action exception');
  const stepView = value(await operator.api.call(routes.batches.step, { params: { batchId, stepKey } }), 'the step');
  const perform = stepView.actions.find((a) => a.action === 'SIGN_PERFORMED');
  await signed(operator, { type: 'SIGN_PERFORMED', stepKey }, { aggregateType: 'batch_step', aggregateId: `${batchId}:${stepKey}`, meaning: perform?.meaning ?? 'PERFORMED' }, 'PERFORMED');
  const checkView = value(await verifier.api.call(routes.batches.step, { params: { batchId, stepKey } }), 'the step');
  const check = checkView.actions.find((a) => a.action === 'VERIFY' || a.action === 'WITNESS');
  if (check) await signed(verifier, { type: 'VERIFY', stepKey, meaning: 'VERIFIED' }, { aggregateType: 'batch_step', aggregateId: `${batchId}:${stepKey}`, meaning: check.meaning ?? 'VERIFIED' }, 'VERIFIED');
  // Each exception gets a deviation-lite record linked to the batch and attached by the supervisor (QA, who
  // dispositions, has entered nothing in the record: INV-03): one for the two booth alerts (so review may accept them
  // together, PR-52) and one for the action exception; QA then dispositions each DEVIATION_RAISED.
  const investigator = await browserOf('qaInvestigator');
  const supervisor = await browserOf('supervisor1', 'KIOSK-DISP-1');
  const deviation = async (title: string, rationale: string) => {
    const dev = value(await investigator.api.call(routes.quality.raiseDeviation, { body: { kind: 'DEVIATION', title: `${title} (batch ${planned.batchNumber})`, classification: 'MINOR', riskRationale: rationale } }), 'the deviation');
    value(await investigator.api.call(routes.quality.linkDeviation, { params: { deviationId: dev.deviationId }, body: { subjectKind: 'BATCH', subjectId: batchId } }), 'the deviation link');
    return dev.ref;
  };
  const booth = await deviation('Booth DISP-1 found not ready at line clearance', 'Both findings corrected at the booth before any material was handled; no product exposure.');
  const hepa = await deviation('HEPA certificate past its date at DISP-1', 'Filter integrity re-certified before any material was handled; no product exposure.');
  const run = value(await qa.api.call(routes.batches.batch, { params: { batchId } }), 'the batch');
  for (const e of run.exceptions.filter((x) => x.status === 'OPEN')) {
    const ref = e.severity === 'ALERT' ? booth : hepa;
    await command(supervisor, { type: 'ATTACH_DEVIATION', exception: e.exceptionId, deviationRef: ref }, `the deviation attached to ${e.exceptionId}`);
    const justification = `Deviation ${ref} raised and linked; the investigation decides the impact.`;
    const preview = `EXCEPTION_DISPOSITIONED|${Buffer.from(JSON.stringify({ outcome: 'DEVIATION_RAISED', justification }), 'utf8').toString('base64url')}`;
    await signed(qa, { type: 'DISPOSITION_EXCEPTION', exception: e.exceptionId, outcome: 'DEVIATION_RAISED', justification }, { aggregateType: 'batch_exception', aggregateId: `${batchId}:${e.exceptionId}`, meaning: 'EXCEPTION_DISPOSITIONED', intent: preview }, `the disposition of ${e.exceptionId}`);
  }

  // 4. An output container on the press, left open, and a failed in-process check that holds it.
  log('review batch: an output container with a pending hold');
  const press = await browserOf('operator2', 'KIOSK-COMP-1');
  const openBody = { batchId, stage: 'COMPRESSION', unit: 'kg' as const, press: 'PRESS-01' };
  const container = value(await press.api.call(routes.containers.open, { body: openBody, attribution: await tapOf(press, '/api/containers', openBody) }), 'the output container');
  await dbAs(press, "select plant.record_ipc_check($1, 'PRESS-01', null, 'FAIL', $2) as r", [batchId, 'SEED:p-disp-clear@:1 weight check out of limits']);

  // 5. DEMO SHORTCUT (never a GMP code path): the record is marked complete by a superuser update, so it can be reviewed
  //    without running the rest of the master here.
  log('review batch: DEMO SHORTCUT, execution status set to EXECUTION_COMPLETE by the superuser');
  await db.admin.query("update recipe.execution_state set status = 'EXECUTION_COMPLETE' where batch_id = $1", [batchId]);
  log(`review batch ${planned.batchNumber} (${batchId}) is ready for review; container ${container.label} is open with a pending hold`);
  const out: ReviewBatchSeed = { batchId, batchNumber: planned.batchNumber, containerId: container.containerId, containerLabel: container.label };
  if (!opts.packaging) return out;

  // 6. The packaging-order demo (Phase 4 slice 2c): a packaging master of GB-T-01 (pack type ALU-PVC-BLISTER, with its
  //    TB-24 step), approved and authorised like the processing master, its numbering rule and an open ERP order; a
  //    second GB-T-01 batch issued from the second ERP order, with two output containers opened, closed with a typed net
  //    and verified by a second person (usable for packing); its release for packing by the DEMO SHORTCUT below.
  log('packaging demo: the packaging master of GB-T-01');
  const packCode = `GBT01-BL10-${tag}`;
  const packContent = packagingMasterContent(packCode);
  const packFamily = await withCommand(db.app, { ...o('author').actor, correlationId: randomUUID() }, (c) => lifecycle.defineFamily(c, lifecycle.familyOf(packContent)));
  const packVersion = (
    await withCommand(db.app, { ...o('author').actor, correlationId: randomUUID() }, (c) => lifecycle.createVersion(c, packFamily, packContent, 'Packaging master of GB-T-01 (DEMO-ONLY)'))
  ).versionId;
  const packCr = await withCommand(db.app, { ...o('approver').actor, correlationId: randomUUID() }, (c) =>
    lifecycle.recordChangeRecord(c, { number: `CC-GBT01-PK-${tag}`, title: 'New pack GB-T-01 Alu-PVC blister (invented)', changeClass: 'MAJOR', processImpacting: true, validationRef: 'VR-GBT01-PK' }),
  );
  await withCommand(db.app, { ...o('author').actor, correlationId: randomUUID(), reasonCode: 'NEW_MASTER', reasonText: 'GB-T-01 packaging master: change record, review date and risk assessment' }, async (c) => {
    await lifecycle.setDraftAttributes(c, packVersion, { changeRecordId: packCr, effectiveFrom: '2026-01-01T00:00:00Z', reviewDue: '2028-12-31' });
    await lifecycle.linkRiskAssessment(c, packVersion, ra);
  });
  const packStored = (await lifecycle.loadContent(db.app, packVersion)).content;
  await withCommand(db.app, { ...o('author').actor, correlationId: randomUUID() }, (c) =>
    lifecycle.recordEvidence(c, packVersion, 'SANDBOX_RUN', lifecycle.sandboxRunEvidence(packStored, { runId: `SBX-GBT01-PK-${tag}`, sandbox: 'ebmr_sandbox_tablets', coverage: { steps: '100%' }, passed: true })),
  );
  const packHead = value(await o('author').api.call(routes.designer.version, { params: { versionId: packVersion } }), 'the packaging version');
  const packStarted = value(await o('author').api.call(routes.designer.startVerification, { params: { versionId: packVersion }, body: { baseRevision: packHead.revision } }), 'the start of the packaging verification');
  const packContext = (await loadValidationContext(db.app, packStored)).context;
  const packVerification = lifecycle.createVerificationPort(packContext).verify(packStored, []);
  await withCommand(db.app, { ...o('author').actor, correlationId: randomUUID() }, (c) => lifecycle.recordVerification(c, packVersion, packVerification, [], personaOf(seed, 'author').personId));
  const pt = (transition: 'SUBMIT' | 'CHECK' | 'APPROVE' | 'REGULATORY_CONFIRM') => ({ kind: 'MBR_TRANSITION' as const, versionId: packVersion, transition, baseRevision: packStarted.revision });
  await sign(o('author'), pt('SUBMIT'), 'PREPARED (packaging)');
  await sign(o('checker'), pt('CHECK'), 'CHECKED (packaging)');
  await sign(o('regulatory'), pt('REGULATORY_CONFIRM'), 'REGULATORY_CONFIRMED (packaging)');
  await sign(o('approver'), pt('APPROVE'), 'APPROVED (packaging)');
  const packDef: lifecycle.MarketAuthorisationDefinition = { versionId: packVersion, market: 'IN', kind: 'CURRENT', cells: [{ site: SITE, line: LINE, batch_size: PACK_SIZE_ID }], regulatoryBasis: 'IN: registration on file (invented product)' };
  const packMa = await withCommand(db.app, { ...o('approver').actor, correlationId: randomUUID() }, (c) => lifecycle.proposeMarketAuthorisation(c, packDef));
  const packQa = await signDirect(o('approver'), lifecycle.MARKET_AUTHORISATION_AGGREGATE, packMa, 'MBR_MARKET_AUTHORISED', 'PROPOSED');
  const packReg = await signDirect(o('regulatory'), lifecycle.MARKET_AUTHORISATION_AGGREGATE, packMa, 'REGULATORY_CONFIRMED', 'PROPOSED');
  await withCommand(db.app, { ...o('approver').actor, correlationId: randomUUID(), reasonCode: 'MARKET_AUTHORISED', reasonText: 'IN: GB-T-01 Alu-PVC blister authorised at SITE-1 L1' }, (c) =>
    lifecycle.activateMarketAuthorisation(c, packMa, packQa, packReg),
  );
  await dbAs(
    o('steward'),
    'select site.define_batch_number_rule($1::jsonb) as r',
    [JSON.stringify({ rule_code: `GBT01-PACK-${tag}`, site_code: SITE, product_code: GBT01_PRODUCT.productCode, batch_kind: 'PACKAGING', format: '{PARENT}/P{SEQ:2}', site_zone: 'Asia/Kolkata', reason: 'Numbering SOP-QA-017 rev 3' })],
    { reasonCode: 'NEW_PRODUCT', reasonText: 'Packaging numbering of GB-T-01' },
  );
  const packSize = packContent.header.batchSizes.find((b) => b.id === PACK_SIZE_ID);
  if (!packSize) throw new Error(`the packaging master has no batch size ${PACK_SIZE_ID}`);
  const erp = await openServiceSession(db, seed, 'erpInterface');
  /** An open ERP order of the packaging master. */
  const postPackOrder = async (no: string): Promise<string> => {
    await withCommand(db.app, { ...erp, correlationId: randomUUID() }, (c) =>
      c.query('select site.erp_receive_order($1::jsonb)', [
        JSON.stringify({
          orderNo: no,
          siteCode: SITE,
          productCode: GBT01_PRODUCT.productCode,
          strength: GBT01_PRODUCT.strength,
          batchSize: packSize.quantity.value,
          batchSizeUnit: packSize.quantity.unit,
          bom: packContent.bom.map((b) => ({ materialCode: b.material, quantity: b.quantity.value, unit: b.quantity.unit })),
          erpReference: `SAP-PP-${no}`,
        }),
      ]),
    );
    return no;
  };
  const orderNo = await postPackOrder(`PO-GBT01-PK-${tag}`);

  log('packaging demo: a second GB-T-01 batch with two usable containers');
  const second = value(await o('issuer').api.call(routes.execution.planBatch, { body: { familyId: created.familyId, markets: ['IN'], site: SITE, line: LINE, batchSize: BATCH_SIZE_ID } }), 'the plan of the second batch');
  await sign(
    o('issuer'),
    { kind: 'GMP_BATCH_ISSUE', batchId: second.batchId, reason: { code: 'PRODUCTION_PLAN', text: 'Issued for the production plan' }, variants: {}, inputs: { tabletsPerBatch: { kind: 'COUNT', value: '200000' } } },
    'the issue of the second batch',
  );
  const checker = await browserOf('verifier1', 'KIOSK-COMP-1');
  const labels: string[] = [];
  for (const net of ['40.500', '40.250']) {
    const body = { batchId: second.batchId, stage: 'COMPRESSION', unit: 'kg' as const };
    const opened = value(await press.api.call(routes.containers.open, { body, attribution: await tapOf(press, '/api/containers', body) }), 'a container of the second batch');
    const closeBody = { expectedVersion: opened.version, typed: { net } };
    const closePath = `/api/containers/${opened.containerId}/close`;
    value(await press.api.call(routes.containers.close, { params: { containerId: opened.containerId }, body: closeBody, attribution: await tapOf(press, closePath, closeBody) }), `the close of ${opened.label}`);
    await sign(checker, { kind: 'CONTAINER_ACT', act: 'VERIFY_CLOSE', containerId: opened.containerId }, `the verification of ${opened.label}`);
    labels.push(opened.label);
  }
  // DEMO SHORTCUT (never a GMP code path): the second batch's hold point H-PACK ("bulk released for packing") is set
  // APPROVED in its stored state by a superuser update, as QA's hold-point disposition would leave it, so its bulk can be
  // issued to a packaging order without running the rest of the master here (GB-T-01 runs it for real in the golden batch).
  // The state guards refuse a step the token has not reached, so the update runs with the triggers off (replica), as the
  // recipe-core bulk-issue tests arrange it.
  log('packaging demo: DEMO SHORTCUT, H-PACK of the second batch set APPROVED by the superuser (triggers off)');
  await assertDemoInstallation(db, opts.database);
  const shortcut = await db.admin.connect();
  try {
    await shortcut.query('begin');
    await shortcut.query("set local session_replication_role = 'replica'");
    await shortcut.query("update recipe.execution_state set state = jsonb_set(state, '{steps,H-PACK@}', $2::jsonb) where batch_id = $1", [
      second.batchId,
      JSON.stringify({ key: 'H-PACK@', step: 'H-PACK', status: 'COMPLETED', disposition: { value: 'APPROVED', positive: true }, signatures: [{ id: randomUUID(), meaning: 'QA_HOLD_POINT', role: 'HOLD_POINT', valid: true }], demoShortcut: true }),
    ]);
    await shortcut.query('commit');
  } catch (e) {
    await shortcut.query('rollback');
    throw e;
  } finally {
    shortcut.release();
  }
  log(`packaging demo: order ${orderNo} of ${packCode} open; batch ${second.batchNumber} released for packing with containers ${labels.join(', ')}`);

  // 7. The release demo (Phase 4 slice 3c): a finished lot in quarantine for the release cockpit. A packaging order of the
  //    review batch is planned against its own ERP order and issued by the issuer through the ceremony; DEMO SHORTCUT, as
  //    in step 5, its record is marked complete by a superuser update (its packing steps are not run here); the
  //    warehouse posts its finished lot through the edition's definer. The lot is NOT_READY (its records are not
  //    reviewed and the packing items are red), so the cockpit shows red and green items and the AP may reject it.
  log('release demo: a packaging order of the review batch and its finished lot');
  const releaseOrderNo = await postPackOrder(`PO-GBT01-PK2-${tag}`);
  const order = value(
    await o('issuer').api.call(routes.planning.planPackagingOrder, { body: { familyId: packFamily, markets: ['IN'], site: SITE, line: LINE, batchSize: PACK_SIZE_ID, erpOrder: releaseOrderNo, parentBatchId: batchId } }),
    'the plan of the release demo packaging order',
  );
  await sign(
    o('issuer'),
    { kind: 'GMP_BATCH_ISSUE', batchId: order.batchId, reason: { code: 'PACKING_PLAN', text: `Packaging order of batch ${planned.batchNumber} for the India market` }, variants: {}, inputs: { tabletsPerBatch: { kind: 'COUNT', value: '100000' } } },
    'the issue of the release demo packaging order',
  );
  log('release demo: DEMO SHORTCUT, the packaging order set EXECUTION_COMPLETE by the superuser');
  await assertDemoInstallation(db, opts.database);
  await db.admin.query("update recipe.execution_state set status = 'EXECUTION_COMPLETE' where batch_id = $1", [order.batchId]);
  const stores = await browserOf('stores');
  const lotId = await dbAs<string>(stores, 'select tab.post_finished_lot($1, $2, $3) as r', [order.batchId, '1000', 'packs'], { reasonCode: 'PACKING_COMPLETE', reasonText: 'Finished packs of the packaging order posted' });
  const lotCode = (await db.app.query<{ c: string }>('select lot_code as c from site.material_lot where id = $1', [lotId])).rows[0]?.c ?? '';
  log(`release demo: finished lot ${lotCode} (${lotId}) of packaging order ${order.batchNumber} in quarantine`);
  return {
    ...out,
    packaging: { orderNo, familyCode: packCode, packType: PACK_TYPE, line: LINE, parentBatchId: second.batchId, parentBatchNumber: second.batchNumber, containers: labels },
    release: { lotId, lotCode, orderBatchId: order.batchId, orderBatchNumber: order.batchNumber },
  };
}
