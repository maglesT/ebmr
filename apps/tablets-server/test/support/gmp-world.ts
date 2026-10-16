/**
 * A GMP server with an effective MBR (dc-mini as a GMP master, without G-09 and G-10 version 1), a batch-number rule and
 * the planning and issue of GMP batches through the routes (Phase 3 slice 6a; as execution/gmp-batch.test.ts sets them
 * up: the life cycle by the seed's personas with real e-signatures sealed by the server's own key).
 */
import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sha256Hex } from '@ebmr/expr';
import { flow } from '@ebmr/recipe-core';
import { routes, type PlannedBatchView, type SignatureCredentials } from '@ebmr/api-contract';
import { openPersonaSession, openServiceSession } from '@ebmr/test-kit';
import { esig, withCommand } from '@ebmr/kernel';
import { cmd, signatureAuth } from '../../../../packages/kernel/test/esig/helpers.ts';
import type { SeededActor } from '../../../../packages/kernel/test/identity/seed.ts';
import type { TestDatabase } from '../../../../packages/kernel/test/support/db.ts';
import { cell, reason, World, type Cast } from '../../../../packages/recipe-core/test/lifecycle/support.ts';
import { postOrder } from '../../../../packages/recipe-core/test/lifecycle/gmp-support.ts';
import { recordContentForSigning } from '../../src/features/esig/content.ts';
import { personaIn, startSigningServer, valueOf } from '../esig/support.ts';
import { dcMini, type ExecServer } from '../execution/support.ts';
import type { TestBrowser, TestServer } from './harness.ts';

type Json = Record<string, unknown>;

export const SITE = 'SITE-1';
export const LINE = 'L1';
export const BATCH_SIZE = 'BS-100K';
export const INPUTS = { tabletsPerBatch: { kind: 'COUNT' as const, value: '100000' } };

class GmpWorld extends World {
  constructor(
    db: TestDatabase,
    cast: Cast,
    private readonly key: esig.SealKeyProvider,
  ) {
    super(db, cast);
  }

  override async sign(signer: SeededActor, aggregateType: string, aggregateId: string, meaning: string, expectedState: string | null): Promise<string> {
    const content = await recordContentForSigning(this.db.app, aggregateType, aggregateId);
    const ch = await withCommand(this.db.app, await cmd(this.db, signer), (c) =>
      esig.createChallenge(c, { aggregateType, aggregateId, contentVersion: content.contentVersion ?? '1', meaning, clientContentHash: content.contentHash ?? '' }),
    );
    const authEventId = await signatureAuth(this.db, signer, signer, ch.challengeId);
    const r = await withCommand(this.db.app, await cmd(this.db, signer), (c) => esig.sign(c, { challengeId: ch.challengeId, authEventId, expectedState }, this.key));
    return r.signatureId;
  }

  override async regulatoryConfirm(versionId: string, signer: SeededActor = this.cast.regulatory): Promise<void> {
    await this.sign(signer, 'mbr_version', versionId, 'REGULATORY_CONFIRMED', (await this.state(versionId)).state);
  }
}

/** A seed persona as a kernel actor in its own session (for the database calls the routes do not make). */
export async function actorOf(server: TestServer, key: string): Promise<SeededActor> {
  const p = personaIn(server, key);
  const s = await openPersonaSession(server.db, server.seed, key);
  return { ...s, seed: { loginName: p.loginName, password: p.password, deviceFingerprint: s.fingerprint, deviceClass: 'PERSONAL', grantId: '', identityVerificationId: '' } };
}

/** dc-mini as a GMP master: its own family and an upper-case product code, without G-09 and G-10 version 1 (D-S2b-2). */
export function gmpContent(transform?: (m: Json) => void): flow.MbrContent {
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
  const stripped = strip(m) as Json;
  transform?.(stripped);
  const parsed = flow.parseMbr(stripped);
  if (!parsed.ok) throw new Error(`the GMP master does not parse: ${JSON.stringify(parsed.problems.slice(0, 3))}`);
  return parsed.mbr;
}

export interface GmpBatchWorld {
  gmp: ExecServer;
  familyId: string;
  content: flow.MbrContent;
  /** Plans a batch of the effective version (an ERP order posted first). */
  plan(issuer: TestBrowser): Promise<PlannedBatchView>;
  /** Plans and issues a batch (the issuer's ISSUED signature through the ceremony); its id. */
  issued(issuer: TestBrowser): Promise<string>;
  close(): Promise<void>;
}

/**
 * The MBR life cycle on a GMP server, as the application role in the seed personas' own sessions (author, checker, QA
 * approver, regulatory signer, issuer), with real signatures sealed by the server's key.
 */
export async function gmpLifecycleWorld(gmp: TestServer): Promise<World> {
  const db: TestDatabase = { name: gmp.database, admin: gmp.db.admin, app: gmp.db.app, drop: () => Promise.resolve() };
  const key = gmp.built.ctx.sealKey;
  if (!key) throw new Error('the GMP server has no seal key');
  const author = await actorOf(gmp, 'author');
  const checker = await actorOf(gmp, 'checker');
  const qa = await actorOf(gmp, 'approver');
  const regulatory = await actorOf(gmp, 'regulatory');
  const issuerActor = await actorOf(gmp, 'issuer');
  const cast: Cast = { author, coAuthor: author, checker, checker2: checker, qa, qa2: qa, regulatory, issuer: issuerActor };
  return new GmpWorld(db, cast, key);
}

export async function startGmpBatchWorld(content: flow.MbrContent = gmpContent(), env: Record<string, string> = {}): Promise<GmpBatchWorld> {
  const ledgerDir = mkdtempSync(join(tmpdir(), 'ebmr-gmp-ledger-'));
  const server = await startSigningServer('GMP', { stub: false, env: { ...env, EBMR_NUMBER_LEDGER_FILE: join(ledgerDir, 'numbers.ledger.jsonl') } });
  const gmp: ExecServer = Object.assign(server, { exchangeDir: ledgerDir });
  const world = await gmpLifecycleWorld(gmp);
  const v = await world.approvedVersion(content);
  await world.authorise({ versionId: v.versionId, market: 'IN', kind: 'CURRENT', cells: [cell(SITE, LINE, BATCH_SIZE)], regulatoryBasis: 'IN: registration on file' });
  const steward = await actorOf(gmp, 'steward');
  await world.run(steward, (c) =>
    c.query('select site.define_batch_number_rule($1::jsonb)', [
      JSON.stringify({ rule_code: `G-${randomUUID().slice(0, 8).toUpperCase()}`, site_code: SITE, product_code: content.header.product.code, batch_kind: 'PROCESSING', format: 'G{YY}{SEQ:5}', site_zone: 'Asia/Kolkata', reason: 'Numbering SOP-QA-017 rev 3' }),
    ]),
    reason('numbering rule for the test'),
  );
  const password = (k: string): SignatureCredentials => ({ kind: 'PASSWORD', loginName: personaIn(gmp, k).loginName, password: personaIn(gmp, k).password });
  const plan = async (issuer: TestBrowser) => {
    await postOrder(gmp.db.app, await openServiceSession(gmp.db, gmp.seed, 'erpInterface'), content, BATCH_SIZE);
    return valueOf(await issuer.call(routes.execution.planBatch, { body: { familyId: v.familyId, markets: ['IN'], site: SITE, line: LINE, batchSize: BATCH_SIZE } }));
  };
  return {
    gmp,
    familyId: v.familyId,
    content,
    plan,
    async issued(issuer) {
      const p = await plan(issuer);
      const preview = valueOf(await issuer.call(routes.esig.content, { query: { aggregateType: 'batch_issue', aggregateId: p.batchId, intent: 'ISSUED' } }));
      const action = { kind: 'GMP_BATCH_ISSUE' as const, batchId: p.batchId, reason: { code: 'PRODUCTION_PLAN', text: 'Issued for the plan' }, variants: {}, inputs: INPUTS };
      const challenge = valueOf(
        await issuer.call(routes.esig.createChallenge, {
          body: { aggregateType: 'batch_issue', aggregateId: p.batchId, contentVersion: preview.contentVersion, meaning: 'ISSUED', clientContentHash: sha256Hex(preview.canonicalText), action },
        }),
      );
      const body = { challengeId: challenge.challengeId, credentials: password('issuer'), action };
      valueOf(await issuer.call(routes.esig.sign, { body: { ...body, proof: await issuer.proof('POST', '/api/esig/sign', body) } }));
      return p.batchId;
    },
    close: () => gmp.close(),
  };
}
