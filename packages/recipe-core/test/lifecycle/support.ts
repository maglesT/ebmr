/**
 * Test support for the MBR life cycle (module A3): a cast of real, seeded identities (identity module
 * seed), real e-signatures (esig helpers), fixture content from the flow model's tablet fixtures, and
 * helpers that drive a version through the real machine (kernel state engine, recipe guards).
 *
 * Verification evidence: the real verification port (flow validator + simulator) is used where a
 * test is about verification; elsewhere `stubEvidence` records reports shaped exactly as the port's,
 * so the database logic is exercised quickly. The database cannot tell them apart, which is the
 * documented limit of evidence produced outside it (README "What the database cannot check").
 */
import { randomBytes } from 'node:crypto';
import type pg from 'pg';
import { withCommand, type ActorContext } from '../../../kernel/src/db/command.ts';
import { canonicalJson, sha256Hex } from '../../../kernel/src/esig/canonical.ts';
import { decideRoleGrant, requestRoleGrant } from '../../../kernel/src/identity/admin.ts';
import { challengeFor, run, signatureAuth, signWith } from '../../../kernel/test/esig/helpers.ts';
import { seedActor, seedAdministration, withReason, type SeededActor } from '../../../kernel/test/identity/seed.ts';
import type { TestDatabase } from '../../../kernel/test/support/db.ts';
import { mbrContentHash } from '../../src/flow/canonical.ts';
import type { MbrContent } from '../../src/flow/model.ts';
import * as lc from '../../src/lifecycle/index.ts';
import { clone, context, loadFixture, type FixtureName } from '../flow/support.ts';

export { clone, loadFixture };

export interface Cast {
  author: SeededActor;
  coAuthor: SeededActor;
  checker: SeededActor;
  checker2: SeededActor;
  qa: SeededActor;
  qa2: SeededActor;
  regulatory: SeededActor;
  issuer: SeededActor;
}

export async function seedCast(db: TestDatabase): Promise<Cast> {
  const author = await seedActor(db, { roleCode: 'MBR_AUTHOR', legalName: 'Asha Author' });
  const coAuthor = await seedActor(db, { roleCode: 'MBR_AUTHOR', legalName: 'Chetan Co-author' });
  const checker = await seedActor(db, { roleCode: 'MBR_CHECKER', legalName: 'Kiran Checker' });
  const checker2 = await seedActor(db, { roleCode: 'MBR_CHECKER', legalName: 'Kavya Checker' });
  const qa = await seedActor(db, { roleCode: 'QA_MBR_APPROVER', legalName: 'Quinn QA' });
  const qa2 = await seedActor(db, { roleCode: 'QA_MBR_APPROVER', legalName: 'Qadir QA' });
  const regulatory = await seedActor(db, { roleCode: 'REGULATORY_SIGNER', legalName: 'Radha Regulatory' });
  const issuer = await seedActor(db, { roleCode: 'BATCH_ISSUER', legalName: 'Ishaan Issuer' });
  return { author, coAuthor, checker, checker2, qa, qa2, regulatory, issuer };
}

/** Grants the same account a second role (approved by the process owner) and returns a context in it. */
export async function withSecondRole(db: TestDatabase, actor: SeededActor, roleCode: string): Promise<SeededActor> {
  const { admin, owner } = await seedAdministration(db);
  const grantId = await withCommand(db.app, withReason(admin), (c) => requestRoleGrant(c, { accountId: actor.accountId, roleCode, scope: {}, reason: 'test: second role' }));
  await withCommand(db.app, withReason(owner), (c) => decideRoleGrant(c, grantId, true, 'approved for test'));
  return { ...actor, roleCode };
}

export const reason = (text: string): Partial<ActorContext> => ({ reasonCode: 'TEST', reasonText: text });

// ---------------------------------------------------------------------------------------------
// Content
// ---------------------------------------------------------------------------------------------

let serial = 0;
/** A fixture with its own family: family code and product code get a unique suffix; markets optional. */
export function uniqueContent(name: FixtureName = 'tablet-blister-packaging', markets?: string[]): MbrContent {
  const m = clone(loadFixture(name));
  const tag = `${randomBytes(3).toString('hex')}${(serial++).toString(36)}`;
  m.header.family = `${m.header.family}-${tag}`.slice(0, 60);
  m.header.product = { ...m.header.product, code: `${m.header.product.code}-${tag}` };
  if (markets) m.header.marketSet = markets;
  return m;
}

export const BATCH_SIZE: Record<FixtureName, string> = { 'tablet-blister-packaging': 'PO-20K', 'tablet-granulation-compression': 'BS-200K' };

/** Evidence reports shaped exactly like the verification port's, for fast database tests. */
export function stubEvidence(content: MbrContent, authorPersonId: string) {
  const contentHash = mbrContentHash(content);
  const validation = { validatorVersion: '1.0.0', contentHash, edition: content.header.edition, rules: [], findings: [], errors: 0, warnings: 0 };
  const sealed = {
    kind: 'FULL',
    contentHash,
    validator: { version: '1.0.0', errors: 0, warnings: 0, justifiedWarnings: [], passed: true, reportHash: sha256Hex(canonicalJson(validation)) },
    simulation: { version: '1.0.0', reportHash: 'b'.repeat(64), passed: true, exactPaths: '1', boundHit: false },
    languageVersion: '1',
    verdict: 'VERIFIED',
    reasons: [],
  };
  return {
    validator: { validation, justifications: [] },
    verification: { ...sealed, evidenceHash: sha256Hex(canonicalJson(sealed)) },
    testVectors: { contentHash, simulatorVersion: '1.0.0', goldenCases: [{ id: 'G-1/calc', status: 'PASS' }], boundaryVectors: 4, confirmedBy: authorPersonId },
    sandbox: { contentHash, runId: `SBX-${randomBytes(4).toString('hex')}`, sandbox: 'ebmr_sandbox_tablets', coverage: { steps: '100%' }, passed: true },
  };
}

/** The real verification port over the flow model's validator and simulator (no market minima). */
export const realPort = lc.createVerificationPort(context());

// ---------------------------------------------------------------------------------------------
// The world: database, cast and helpers that drive the real machine
// ---------------------------------------------------------------------------------------------

export interface PrepareOptions {
  evidence?: 'stub' | 'real' | 'none';
  changeRecord?: boolean;
  /** Validation link on the change record (default true). */
  validationLink?: boolean;
  risk?: boolean;
  effectiveFrom?: string | null;
  reviewDue?: string | null;
}

export class World {
  /** Phase 4 slice 6a: authorise() also gives the product its licence and export permissions (licenceFor); off to test the gates. */
  autoLicence = true;

  constructor(
    readonly db: TestDatabase,
    readonly cast: Cast,
  ) {}

  run<T>(actor: SeededActor, work: (c: pg.PoolClient) => Promise<T>, extra: Partial<ActorContext> = {}): Promise<T> {
    return run(this.db, actor, work, extra);
  }

  /** Challenge, authenticate and sign in the signer's own session; returns the signature id. */
  async sign(signer: SeededActor, aggregateType: string, aggregateId: string, meaning: string, expectedState: string | null): Promise<string> {
    const ch = await challengeFor(this.db, signer, aggregateId, { meaning, aggregateType });
    const ev = await signatureAuth(this.db, signer, signer, ch.challengeId);
    return (await signWith(this.db, signer, ch.challengeId, ev, { expectedState })).signatureId;
  }

  signVersion(signer: SeededActor, versionId: string, meaning: 'PREPARED' | 'CHECKED' | 'APPROVED', expectedState: string): Promise<string> {
    return this.sign(signer, 'mbr_version', versionId, meaning, expectedState);
  }

  async state(versionId: string): Promise<{ state: string; version: number }> {
    const s = await lc.versionState(this.db.app, versionId);
    if (!s) throw new Error(`version ${versionId} has no state`);
    return { state: s.state, version: s.version };
  }

  async newFamily(content: MbrContent, actor: SeededActor = this.cast.author): Promise<string> {
    return this.run(actor, (c) => lc.defineFamily(c, lc.familyOf(content)));
  }

  async newVersion(content: MbrContent, actor: SeededActor = this.cast.author): Promise<lc.VersionRef & { familyId: string }> {
    const familyId = await this.newFamily(content, actor);
    const ref = await this.run(actor, (c) => lc.createVersion(c, familyId, content, 'new master'));
    return { ...ref, familyId };
  }

  async changeRecord(opts: { processImpacting?: boolean; validationRef?: string | null; regulatory?: { market: string; category: string; reference?: string }[] } = {}): Promise<string> {
    const number = `CC-${randomBytes(4).toString('hex')}`;
    return this.run(this.cast.qa, async (c) => {
      const id = await lc.recordChangeRecord(c, {
        number,
        title: 'Test change',
        changeClass: 'MAJOR',
        processImpacting: opts.processImpacting ?? true,
        ...(opts.validationRef === null ? {} : { validationRef: opts.validationRef ?? `PV-${number}` }),
      });
      for (const r of opts.regulatory ?? []) await lc.addChangeRegulatory(c, id, r.market, r.category, r.reference);
      return id;
    });
  }

  async riskAssessment(): Promise<string> {
    return this.run(this.cast.qa, (c) =>
      lc.recordRiskAssessment(c, { code: `RA-${randomBytes(4).toString('hex')}`, version: '1', title: 'Process risk assessment', riskClass: 'MEDIUM', rationaleRef: 'QRM-REPORT-1' }),
    );
  }

  async recordEvidence(versionId: string, content: MbrContent, mode: 'stub' | 'real', actor: SeededActor = this.cast.author): Promise<void> {
    if (mode === 'stub') {
      const e = stubEvidence(content, actor.personId);
      await this.run(actor, async (c) => {
        await lc.recordEvidence(c, versionId, 'VALIDATOR', e.validator);
        await lc.recordEvidence(c, versionId, 'VERIFICATION', e.verification);
        await lc.recordEvidence(c, versionId, 'TEST_VECTORS', e.testVectors);
        await lc.recordEvidence(c, versionId, 'SANDBOX_RUN', e.sandbox);
      });
      return;
    }
    const v = realPort.verify(content, []);
    await this.run(actor, async (c) => {
      await lc.recordEvidence(c, versionId, 'VALIDATOR', lc.validatorEvidence(v.report, []));
      await lc.recordEvidence(c, versionId, 'VERIFICATION', v.evidence);
      await lc.recordEvidence(c, versionId, 'TEST_VECTORS', lc.testVectorEvidence(v.simulation, actor.personId));
      await lc.recordEvidence(c, versionId, 'SANDBOX_RUN', lc.sandboxRunEvidence(content, { runId: `SBX-${randomBytes(4).toString('hex')}`, sandbox: 'ebmr_sandbox_tablets', coverage: { steps: '100%' }, passed: true }));
    });
  }

  /** Everything a draft needs before verification and approval (each part can be left out). */
  async prepare(versionId: string, content: MbrContent, opts: PrepareOptions = {}): Promise<{ changeRecordId?: string; riskAssessmentId?: string }> {
    const out: { changeRecordId?: string; riskAssessmentId?: string } = {};
    if (opts.changeRecord ?? true) out.changeRecordId = await this.changeRecord(opts.validationLink === false ? { validationRef: null } : {});
    if (opts.risk ?? true) out.riskAssessmentId = await this.riskAssessment();
    // A draft-attribute edit carries the author's own reason, both halves (EBMR-AUDIT-002; migration 0250).
    await this.run(
      this.cast.author,
      async (c) => {
        await lc.setDraftAttributes(c, versionId, {
          ...(out.changeRecordId ? { changeRecordId: out.changeRecordId } : {}),
          effectiveFrom: opts.effectiveFrom === undefined ? '2026-01-01T00:00:00Z' : opts.effectiveFrom,
          reviewDue: opts.reviewDue === undefined ? '2027-12-31' : opts.reviewDue,
        });
        if (out.riskAssessmentId) await lc.linkRiskAssessment(c, versionId, out.riskAssessmentId);
      },
      reason('draft attributes set for the test'),
    );
    const evidence = opts.evidence ?? 'stub';
    if (evidence !== 'none') await this.recordEvidence(versionId, content, evidence);
    return out;
  }

  async startVerification(versionId: string, actor: SeededActor = this.cast.author): Promise<void> {
    const s = await this.state(versionId);
    await this.run(actor, (c) => lc.startVerification(c, versionId, s.version));
  }

  async submit(versionId: string, signer: SeededActor = this.cast.author): Promise<string> {
    const sig = await this.signVersion(signer, versionId, 'PREPARED', 'IN_VERIFICATION');
    const s = await this.state(versionId);
    await this.run(signer, (c) => lc.submitVersion(c, versionId, s.version, sig));
    return sig;
  }

  async check(versionId: string, signer: SeededActor = this.cast.checker): Promise<string> {
    const sig = await this.signVersion(signer, versionId, 'CHECKED', 'SUBMITTED');
    const s = await this.state(versionId);
    await this.run(signer, (c) => lc.checkVersion(c, versionId, s.version, sig));
    return sig;
  }

  /** The regulatory-conformity sign-off of the version (PR-04), unless a valid one exists. */
  async regulatoryConfirm(versionId: string, signer: SeededActor = this.cast.regulatory): Promise<void> {
    const { rows } = await this.db.app.query<{ n: string }>(
      "select count(*)::text as n from esig.signature s where s.aggregate_ref = 'mbr_version:' || $1 and s.meaning_code = 'REGULATORY_CONFIRMED' and (esig.signature_state(s.id) ->> 'valid')::boolean",
      [versionId],
    );
    if (rows[0]?.n !== '0') return;
    await this.sign(signer, 'mbr_version', versionId, 'REGULATORY_CONFIRMED', (await this.state(versionId)).state);
  }

  async approve(versionId: string, signer: SeededActor = this.cast.qa): Promise<string> {
    await this.regulatoryConfirm(versionId);
    const sig = await this.signVersion(signer, versionId, 'APPROVED', 'CHECKED');
    const s = await this.state(versionId);
    await this.run(signer, (c) => lc.approveVersion(c, versionId, s.version, sig));
    return sig;
  }

  /** A new family whose first version is prepared and approved. */
  async approvedVersion(content: MbrContent, opts: PrepareOptions = {}): Promise<lc.VersionRef & { familyId: string }> {
    const v = await this.newVersion(content);
    await this.prepare(v.versionId, content, opts);
    await this.startVerification(v.versionId);
    await this.submit(v.versionId);
    await this.check(v.versionId);
    await this.approve(v.versionId);
    return { ...v, state: 'APPROVED' };
  }

  /** Derives the next version, applies `edit` to its content, prepares and approves it. */
  async approvedSuccessor(from: string, edit: (m: MbrContent) => void, opts: PrepareOptions & { regulatory?: { market: string; category: string; reference?: string }[] } = {}): Promise<lc.VersionRef & { content: MbrContent }> {
    const ref = await this.run(this.cast.author, (c) => lc.deriveVersion(c, from, 'change under test'));
    const content = (await lc.loadContent(this.db.app, ref.versionId)).content;
    edit(content);
    await this.run(this.cast.author, (c) => lc.saveContent(c, ref.versionId, content, 'edited'));
    // validationLink false: a change the owner classifies as not process-impacting, with no validation link (PR-06).
    const cr = await this.changeRecord({ ...(opts.regulatory ? { regulatory: opts.regulatory } : {}), ...(opts.validationLink === false ? { validationRef: null, processImpacting: false } : {}) });
    const ra = await this.riskAssessment();
    await this.run(
      this.cast.author,
      async (c) => {
        await lc.setDraftAttributes(c, ref.versionId, { changeRecordId: cr, effectiveFrom: opts.effectiveFrom ?? '2026-01-01T00:00:00Z', reviewDue: opts.reviewDue ?? '2027-12-31' });
        await lc.linkRiskAssessment(c, ref.versionId, ra);
      },
      reason('draft attributes of the successor set for the test'),
    );
    await this.recordEvidence(ref.versionId, content, opts.evidence === 'real' ? 'real' : 'stub');
    await this.startVerification(ref.versionId);
    await this.submit(ref.versionId);
    await this.check(ref.versionId);
    await this.approve(ref.versionId);
    return { ...ref, state: 'APPROVED', content };
  }

  /**
   * Proposes, signs (QA + regulatory) and activates a market authorisation. The activation carries the QA person's own
   * reason, both halves (EBMR-AUDIT-002; migration 0290).
   */
  async authorise(def: lc.MarketAuthorisationDefinition, qa: SeededActor = this.cast.qa, regulatory: SeededActor = this.cast.regulatory): Promise<lc.ActivationResult> {
    const id = await this.run(qa, (c) => lc.proposeMarketAuthorisation(c, def));
    const qaSig = await this.sign(qa, lc.MARKET_AUTHORISATION_AGGREGATE, id, 'MBR_MARKET_AUTHORISED', 'PROPOSED');
    const regSig = await this.sign(regulatory, lc.MARKET_AUTHORISATION_AGGREGATE, id, 'REGULATORY_CONFIRMED', 'PROPOSED');
    const activated = await this.run(qa, (c) => lc.activateMarketAuthorisation(c, id, qaSig, regSig), reason(`${def.market}: market authorised for the test`));
    if (this.autoLicence) await this.licenceFor(def.versionId, def.market);
    return activated;
  }

  /**
   * Phase 4 slice 6a (site services 0885): what an authorised product needs before a GMP batch of it is issued at the
   * seed site (D-6-1, D-6-2): a manufacturing licence (Form 25) endorsing its product and strength, recorded by the
   * regulatory signer and approved by QA under LICENCE_APPROVED, and for an export market an export permission approved
   * under EXPORT_PERMISSION_APPROVED. Through the real commands; nothing is written when they already hold.
   */
  async licenceFor(versionId: string, market: string, site = 'SITE-1'): Promise<void> {
    const { rows } = await this.db.app.query<{ product_code: string; strength: string }>(
      'select f.product_code, f.strength from recipe.mbr_version v join recipe.mbr_family f on f.id = v.family_id where v.id = $1',
      [versionId],
    );
    const p = rows[0];
    if (!p || !/^[A-Z0-9][A-Z0-9._-]{0,63}$/.test(p.product_code)) return;
    const problem = async (sql: string, args: unknown[]): Promise<string | null> => (await this.db.app.query<{ r: string | null }>(sql, args)).rows[0]?.r ?? null;
    if (await problem('select site.licence_problem($1, $2, $3, clock_timestamp()) as r', [site, p.product_code, p.strength])) {
      const id = await this.run(this.cast.regulatory, async (c) =>
        (await c.query<{ r: string }>('select site.record_manufacturing_licence($1::jsonb) as r', [JSON.stringify({
          licenceKind: 'MANUFACTURING', form: '25', licenceNumber: `MFG-25-${randomBytes(5).toString('hex').toUpperCase()}`, holderName: 'Test Pharma Ltd',
          holderAddress: 'Plot 1, Test Industrial Area, Pune 411019', validFrom: '2020-01-01T00:00:00Z', products: [{ productCode: p.product_code, strength: p.strength }],
        })])).rows[0]!.r,
      );
      const sig = await this.sign(this.cast.qa, 'manufacturing_licence', id, 'LICENCE_APPROVED', 'DRAFT');
      await this.run(this.cast.qa, (c) => c.query('select site.approve_manufacturing_licence($1, $2)', [id, sig]));
    }
    if (market !== 'IN' && (await problem('select site.export_permission_problem($1, $2, $3, $4, clock_timestamp()) as r', [site, p.product_code, p.strength, market]))) {
      const id = await this.run(this.cast.regulatory, async (c) =>
        (await c.query<{ r: string }>('select site.record_export_permission($1::jsonb) as r', [JSON.stringify({
          productCode: p.product_code, strength: p.strength, destination: market, permissionNumber: `NOC-${randomBytes(5).toString('hex').toUpperCase()}`,
          issuingAuthority: 'State Licensing Authority (test)', validFrom: '2020-01-01T00:00:00Z', validUntil: '2099-01-01T00:00:00Z',
        })])).rows[0]!.r,
      );
      const sig = await this.sign(this.cast.qa, 'export_permission', id, 'EXPORT_PERMISSION_APPROVED', 'DRAFT');
      await this.run(this.cast.qa, (c) => c.query('select site.approve_export_permission($1, $2)', [id, sig]));
    }
  }

  async issue(familyId: string, markets: string[], scope: lc.IssueScope, versionId?: string): Promise<lc.IssueResult & { batchNumber: string }> {
    const batchNumber = `B${randomBytes(4).toString('hex').toUpperCase()}`;
    const batchId = await this.run(this.cast.issuer, (c) => lc.createStubBatch(c, { batchNumber, familyId, markets, site: scope.site, line: scope.line, batchSize: scope.batch_size }));
    // Issuing carries the issuer's own reason, both halves (EBMR-AUDIT-002; migration 0250).
    const r = await this.run(this.cast.issuer, (c) => lc.issueStubBatch(c, batchId, versionId), reason('batch issued for the test'));
    return { ...r, batchNumber };
  }

  async planBatch(familyId: string, markets: string[], scope: lc.IssueScope): Promise<string> {
    const batchNumber = `B${randomBytes(4).toString('hex').toUpperCase()}`;
    return this.run(this.cast.issuer, (c) => lc.createStubBatch(c, { batchNumber, familyId, markets, site: scope.site, line: scope.line, batchSize: scope.batch_size }));
  }

  async violations(): Promise<lc.InvariantViolation[]> {
    return lc.invariantViolations(this.db.app);
  }
}

export const cell = (site: string, line: string, batchSize: string): lc.ScopeCell => ({ site, line, batch_size: batchSize });
export const scope = (site: string, line: string, batchSize: string): lc.IssueScope => ({ site, line, batch_size: batchSize });
