/**
 * A GMP database with records for the drills' tests, built from any migration set (the release candidate's, or the
 * Phase 6A exit's through release-manifest.ts): bootstrapped and seeded with the test-kit personas, a DEMO-ONLY HMAC seal
 * key registered, and records made by the database's own commands in the personas' own sessions (the MBR life cycle of
 * apps/tablets-server/test/support/gmp-world.ts, which drives the database without a server): a GMP master prepared,
 * checked, confirmed and approved with four e-signatures, authorised for India by QA and regulatory, its licence
 * approved, a batch-number rule, an ERP order, and a GMP batch planned and issued through the routes with the issuer's
 * signature (the server is built on the database for it and closed without dropping it).
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { routes } from '@ebmr/api-contract';
import { sha256Hex } from '@ebmr/expr';
import { esig, withCommand, type MigrationSource } from '@ebmr/kernel';
import { bootstrapInstallation, createGmpDatabase, dropDatabase, openDatabase, openServiceSession, passwordActor, personaOf, seedDemoSite, uniqueSuffix, type DatabaseHandle, type SiteSeed } from '@ebmr/test-kit';
import { postOrder } from '../../../packages/recipe-core/test/lifecycle/gmp-support.ts';
import { cell } from '../../../packages/recipe-core/test/lifecycle/support.ts';
import { actorOf, BATCH_SIZE, gmpContent, gmpLifecycleWorld, INPUTS, LINE, SITE } from '../../../apps/tablets-server/test/support/gmp-world.ts';
import { startServer, type TestServer } from '../../../apps/tablets-server/test/support/harness.ts';

export const SEAL_KEY_ID = 'drill-test-hmac-1';

export interface DrillDatabase {
  database: string;
  seed: SiteSeed;
  sealKey: esig.SealKeyProvider;
  sealKeyFile: string;
  /** The installation's external ledger of protected numbers (EBMR_NUMBER_LEDGER_FILE). */
  ledgerFile: string;
  versionId: string;
  familyId: string;
  batchId: string;
  drop(): Promise<void>;
}

const reasonOf = <T extends object>(ctx: T, text: string) => ({ ...ctx, reasonCode: 'TEST_SETUP', reasonText: text, correlationId: randomUUID() });

export async function buildDrillDatabase(sources: MigrationSource[], prefix = 'ebmr_drill'): Promise<DrillDatabase> {
  const database = `${prefix}_${uniqueSuffix()}`;
  await createGmpDatabase(database, sources);
  let db: DatabaseHandle | null = null;
  try {
    const boot = await bootstrapInstallation(database, 'GMP');
    db = openDatabase(database, 'GMP');
    const seed = await seedDemoSite(db, 'GMP', boot);
    const secret = randomBytes(32);
    const dir = mkdtempSync(join(tmpdir(), 'ebmr-drill-key-'));
    const sealKeyFile = join(dir, 'seal-key.json');
    writeFileSync(sealKeyFile, JSON.stringify({ keyId: SEAL_KEY_ID, algorithm: 'HMAC-SHA256', secret: secret.toString('base64'), label: 'DEMO-ONLY drill test seal key' }));
    const sealKey = esig.hmacSealKey(SEAL_KEY_ID, secret);
    const admin = await passwordActor(db, boot.admin, boot.admin.fingerprint);
    await withCommand(db.app, reasonOf(admin, 'register the DEMO-ONLY drill seal key'), (c) => esig.registerSealKey(c, sealKey, 'DEMO-ONLY drill test seal key (HMAC-SHA256)'));
    // The lifecycle world needs what a test server holds: the database, the seed and the seal key.
    const server = { database, db, seed, built: { ctx: { sealKey } } } as unknown as TestServer;
    const world = await gmpLifecycleWorld(server);
    const content = gmpContent();
    const v = await world.approvedVersion(content);
    await world.authorise({ versionId: v.versionId, market: 'IN', kind: 'CURRENT', cells: [cell(SITE, LINE, BATCH_SIZE)], regulatoryBasis: 'IN: registration on file' });
    const steward = await actorOf(server, 'steward');
    await world.run(steward, (c) =>
      c.query('select site.define_batch_number_rule($1::jsonb)', [
        JSON.stringify({ rule_code: `G-${randomUUID().slice(0, 8).toUpperCase()}`, site_code: SITE, product_code: content.header.product.code, batch_kind: 'PROCESSING', format: 'G{YY}{SEQ:5}', site_zone: 'Asia/Kolkata', reason: 'Numbering SOP-QA-017 rev 3' }),
      ]),
      reasonOf({}, 'numbering rule for the drill'),
    );
    await postOrder(db.app, await openServiceSession(db, seed, 'erpInterface'), content, BATCH_SIZE);
    const handle = db;
    db = null;
    await handle.close();
    // The GMP batch, planned and issued through the routes with the issuer's ISSUED signature (as gmp-world.ts issues it),
    // on a server built on the database; the server is closed without dropping the database.
    const ledgerFile = join(dir, 'numbers.ledger.jsonl');
    const server2 = await startServer('GMP', { prepared: { database, seed }, env: { EBMR_SEAL_KEY_FILE: sealKeyFile, EBMR_NUMBER_LEDGER_FILE: ledgerFile } });
    let batchId: string;
    try {
      const issuer = await server2.asPersona('issuer');
      const planned = await issuer.call(routes.execution.planBatch, { body: { familyId: v.familyId, markets: ['IN'], site: SITE, line: LINE, batchSize: BATCH_SIZE } });
      if (!planned.ok) throw new Error(`planBatch: ${JSON.stringify(planned.error)}`);
      batchId = planned.value.batchId;
      const preview = await issuer.call(routes.esig.content, { query: { aggregateType: 'batch_issue', aggregateId: batchId, intent: 'ISSUED' } });
      if (!preview.ok) throw new Error(`content: ${JSON.stringify(preview.error)}`);
      const action = { kind: 'GMP_BATCH_ISSUE' as const, batchId, reason: { code: 'PRODUCTION_PLAN', text: 'Issued for the plan' }, variants: {}, inputs: INPUTS };
      const challenge = await issuer.call(routes.esig.createChallenge, {
        body: { aggregateType: 'batch_issue', aggregateId: batchId, contentVersion: preview.value.contentVersion, meaning: 'ISSUED', clientContentHash: sha256Hex(preview.value.canonicalText), action },
      });
      if (!challenge.ok) throw new Error(`challenge: ${JSON.stringify(challenge.error)}`);
      const p = personaOf(seed, 'issuer');
      const body = { challengeId: challenge.value.challengeId, credentials: { kind: 'PASSWORD' as const, loginName: p.loginName, password: p.password }, action };
      const signed = await issuer.call(routes.esig.sign, { body: { ...body, proof: await issuer.proof('POST', '/api/esig/sign', body) } });
      if (!signed.ok) throw new Error(`sign: ${JSON.stringify(signed.error)}`);
    } finally {
      await server2.built.close();
      await server2.db.close();
    }
    return {
      database,
      seed,
      sealKey,
      sealKeyFile,
      ledgerFile,
      versionId: v.versionId,
      familyId: v.familyId,
      batchId,
      drop: () => dropDatabase(database),
    };
  } catch (error) {
    await db?.close();
    await dropDatabase(database);
    throw error;
  }
}
