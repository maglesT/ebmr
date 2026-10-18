/**
 * Test world for the full export, the readability sample and the periodic evaluation pack (Phase 7 slice 7b-2; kernel
 * 1335, 1336). Closed records are made through the real acts: incidents raised by a system account and closed by QA, DI
 * investigations opened by the CSV / DI lead and closed with QA's DI_INVESTIGATION_CLOSED signature, sealed with the
 * test HMAC key or a DEMO-ONLY Ed25519 key. The reporting path is a superuser session in the role ebmr_report (only its
 * rights), as the reporting views test reads it.
 */
import { randomUUID } from 'node:crypto';
import { withCommand, type ActorContext } from '../../src/db/command.ts';
import { registerSealKey } from '../../src/esig/catalogue.ts';
import { generateEd25519SealKey, type Ed25519SealKey, type SealKeyProvider } from '../../src/esig/keys.ts';
import { contentForSigning, createChallenge, sign } from '../../src/esig/signing.ts';
import { authenticate } from '../../src/identity/authentication.ts';
import { closeIncident, raiseIncident, startIncidentInvestigation } from '../../src/records/incidents.ts';
import { closeDiInvestigation, openDiInvestigation } from '../../src/records/investigations.ts';
import type { ReportReader } from '../../src/records/evaluation-pack.ts';
import { ensureSealKey, testSealKey } from '../esig/helpers.ts';
import { seedAdministration, seedAuthn, type SeededActor } from '../identity/seed.ts';
import type { TestDatabase } from '../support/db.ts';
import { again, signerActor, testActor } from './helpers.ts';

export class ExportWorld {
  private constructor(
    readonly db: TestDatabase,
    /** CSV / DI lead: RECORD.EXPORT, VALIDATION.MANAGE (exports, opens investigations, generates the pack). */
    readonly lead: SeededActor,
    /** QA reviewer who signs (closes investigations, signs off packs). */
    readonly qa: SeededActor,
    readonly gateway: ActorContext,
    readonly subject: ActorContext,
    readonly edKey: Ed25519SealKey,
  ) {}

  static async create(db: TestDatabase): Promise<ExportWorld> {
    await ensureSealKey(db);
    const edKey = generateEd25519SealKey(`test-ed25519-${randomUUID().slice(0, 8)}`);
    const { admin } = await seedAdministration(db);
    await withCommand(db.app, { ...admin, correlationId: randomUUID(), reasonCode: 'TEST_SETUP', reasonText: 'register a DEMO-ONLY Ed25519 seal key' }, (c) =>
      registerSealKey(c, { keyId: edKey.keyId, algorithm: 'ED25519', publicKeyPem: edKey.publicKeyPem }, 'DEMO-ONLY Ed25519 seal key (full export tests)'),
    );
    const lead = await signerActor(db, 'CSV_DI_LEAD', 'CSV and DI lead');
    const qa = await signerActor(db, 'QA_REVIEWER', 'Head of QA');
    const gateway = await testActor(db, { source: 'SYSTEM', roleCode: 'SYSTEM', legalName: 'site gateway (balance adapter)' });
    const subject = await testActor(db, { roleCode: 'OPERATOR', legalName: 'Operator in scope' });
    return new ExportWorld(db, lead, qa, gateway, subject, edKey);
  }

  /** The reporting path: the superuser's session takes the role ebmr_report, and with it only its rights. */
  readonly report: ReportReader = {
    query: async <R extends Record<string, unknown>>(sql: string, params: unknown[] = []) => {
      const c = await this.db.admin.connect();
      try {
        await c.query('begin');
        await c.query('set local role ebmr_report');
        const r = await c.query<R>(sql, params);
        await c.query('rollback');
        return { rows: r.rows };
      } catch (e) {
        await c.query('rollback');
        throw e;
      } finally {
        c.release();
      }
    },
  };

  /** A signature through the production flow, sealed with `key` (default the test HMAC key). */
  async sign(signer: SeededActor, aggregate: { type: string; id: string }, meaning: string, expectedState: string | null, key: SealKeyProvider = testSealKey): Promise<string> {
    const content = await contentForSigning(this.db.app, aggregate.type, aggregate.id);
    const challenge = await withCommand(this.db.app, again(signer), (c) =>
      createChallenge(c, { aggregateType: aggregate.type, aggregateId: aggregate.id, contentVersion: content.contentVersion ?? '1', meaning, clientContentHash: content.contentHash ?? '' }),
    );
    const ev = await authenticate(seedAuthn(this.db), {
      method: 'PASSWORD',
      identifier: signer.seed.loginName,
      secret: signer.seed.password,
      deviceFingerprint: signer.seed.deviceFingerprint,
      purpose: 'SIGNATURE',
      challengeId: challenge.challengeId,
    });
    return (await withCommand(this.db.app, again(signer), (c) => sign(c, { challengeId: challenge.challengeId, authEventId: ev.authEventId, expectedState }, key))).signatureId;
  }

  async openIncident(title: string): Promise<string> {
    return withCommand(this.db.app, again(this.gateway), (c) =>
      raiseIncident(c, { source: 'INTERFACE_FAILURE', type: 'BALANCE_INTERFACE_LOST', severity: 'MINOR', title, description: 'No heartbeat from the balance adapter for 30 s.' }),
    );
  }

  async closedIncident(title: string): Promise<string> {
    const id = await this.openIncident(title);
    await withCommand(this.db.app, again(this.qa), (c) => startIncidentInvestigation(c, id));
    await withCommand(this.db.app, again(this.qa), (c) => closeIncident(c, id, { summary: 'adapter restarted, weighing repeated' }));
    return id;
  }

  async openInvestigation(): Promise<string> {
    const from = (await this.db.app.query<{ t: Date }>("select clock_timestamp() - interval '1 hour' as t")).rows[0]?.t as Date;
    const to = (await this.db.app.query<{ t: Date }>('select clock_timestamp() as t')).rows[0]?.t as Date;
    return withCommand(this.db.app, again(this.lead), (c) =>
      openDiInvestigation(c, { subjectPersonId: this.subject.personId, windowFrom: from, windowTo: to, concern: 'entries before the printout', qmsReference: `QMS-INV-${randomUUID().slice(0, 6)}` }),
    );
  }

  /** A DI investigation closed with QA's signature sealed with `key` (default the test HMAC key). */
  async closedInvestigation(key: SealKeyProvider = testSealKey): Promise<{ id: string; signatureId: string }> {
    const id = await this.openInvestigation();
    const signatureId = await this.sign(this.qa, { type: 'di_investigation', id }, 'DI_INVESTIGATION_CLOSED', 'OPEN', key);
    await withCommand(this.db.app, again(this.qa), (c) => closeDiInvestigation(c, id, { conclusion: 'no falsification', remediation: 'refresher training', approvalSignatureId: signatureId }));
    return { id, signatureId };
  }

  /** The database clock now, as an ISO text. */
  async now(): Promise<string> {
    return (await this.db.app.query<{ t: string }>(`select to_char(clock_timestamp() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as t from pg_sleep(0.002)`)).rows[0]?.t as string;
  }
}
