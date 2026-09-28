/**
 * Test helpers for the market-profile engine. Every actor comes from testActor (coordination rule:
 * the lead will make it seed a real identity once the identity module is in place).
 */
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import type { ActorContext } from '../../src/db/command.ts';
import { withCommand } from '../../src/db/command.ts';
import { contentForSigning, createChallenge, sign } from '../../src/esig/signing.ts';
import { authenticate } from '../../src/identity/authentication.ts';
import { readRuleTableFile, ruleCorrectionApprovalTarget, syncRuleTables, type SyncOutcome } from '../../src/market/loader.ts';
import { policyVersionApprovalTarget } from '../../src/market/policy.ts';
import { siteValuePreview, type ApprovalTarget, type SiteValueRequest } from '../../src/market/repository.ts';
import type { RuleTableCode, RuleTableDocument } from '../../src/market/types.ts';
import { ensureSealKey, testSealKey } from '../esig/helpers.ts';
import { seedActor, seedAuthn, type SeededActor } from '../identity/seed.ts';
import { seededTestActor } from '../support/seeded-actor.ts';
import type { TestDatabase } from '../support/db.ts';

export function testActor(db: TestDatabase, overrides: Partial<ActorContext> = {}): Promise<ActorContext> {
  return seededTestActor(db, overrides);
}

/**
 * The kernel roles that hold the market permissions (packages/kernel/sql/0700_authorization_catalogue.sql).
 * Every gated market function checks the permission of the role declared in the actor context (DI-17).
 */
export const MARKET_ROLES = {
  /** MARKET.RULE_TABLE_PUBLISH */
  publisher: 'MASTER_DATA_STEWARD',
  /** MARKET.RULE_TABLE_CORRECT (SOURCE_CORRECTION versions) */
  corrector: 'REGULATORY_SIGNER',
  /** MARKET.SITE_VALUE_SET */
  siteValues: 'MASTER_DATA_STEWARD',
  /** MARKET.POLICY_CHANGE (define a policy, set a policy version) */
  policy: 'QA_MBR_APPROVER',
  /** MARKET.POLICY_TIGHTEN_BATCH */
  tightening: 'QA_REVIEWER',
  /** BATCH.ISSUE (policies are pinned in the batch-issue transaction) */
  issuer: 'BATCH_ISSUER',
  /** MARKET.RULE_EVALUATE */
  evaluator: 'OPERATOR',
  /** MASTERDATA.CHANGE (the stub scope tables stand in for edition master data) */
  stubs: 'MASTER_DATA_STEWARD',
} as const;

export const RULE_TABLE_ROOT = new URL('../../../../compliance/rule-tables/', import.meta.url).pathname;

export function seedDocument(table: RuleTableCode): RuleTableDocument {
  return readRuleTableFile(`${RULE_TABLE_ROOT}${table}/${table}.v1.yaml`).document;
}

/** Publish the seed rule tables from compliance/rule-tables. */
export async function publishSeedTables(db: TestDatabase): Promise<Map<RuleTableCode, string>> {
  const outcomes: SyncOutcome[] = await syncRuleTables(db.app, await testActor(db, { roleCode: MARKET_ROLES.publisher }), RULE_TABLE_ROOT);
  return new Map(outcomes.map((o) => [o.table, o.versionId]));
}

/** Run SQL as the application role inside a command. */
export async function asApp<T>(db: TestDatabase, work: (c: pg.PoolClient) => Promise<T>, overrides: Partial<ActorContext> = {}): Promise<T> {
  return withCommand(db.app, await testActor(db, overrides), work);
}

export interface Published {
  versionId: string;
  loosening: unknown[];
  impactCount: number;
}

/** Publish a document through the SQL gate as the application role, under the given actor. */
export async function publishDocumentAs(db: TestDatabase, ctx: ActorContext, doc: unknown, change: Record<string, unknown> = {}): Promise<Published> {
  return withCommand(db.app, ctx, async (c) => {
    const { rows } = await c.query<{ r: Published }>('select market.publish_rule_table($1::jsonb, $2::jsonb) as r', [JSON.stringify(doc), JSON.stringify(change)]);
    return rows[0]?.r as Published;
  });
}

/** Publish a document through the SQL gate as the application role. */
export async function publishDocument(db: TestDatabase, doc: unknown, change: Record<string, unknown> = {}): Promise<Published> {
  const roleCode = (change as { kind?: unknown }).kind === 'SOURCE_CORRECTION' ? MARKET_ROLES.corrector : MARKET_ROLES.publisher;
  return publishDocumentAs(db, await testActor(db, { roleCode }), doc, change);
}

/** Register an extra rule table (superuser setup) so a test can publish its own documents. */
export async function createTestTable(db: TestDatabase, code: string): Promise<void> {
  await db.admin.query('insert into market.rule_table (code, key_prefix, title) values ($1, $2, $3)', [code, `${code}.`, `test table ${code}`]);
}

export interface StubWorld {
  siteId: string;
  tablet: string;
  injectable: string;
  picsInjectable: string;
  batch: { tabletIn: string; tabletAll: string; injectableIn: string; injectableAll: string; picsIn: string };
  line: { tablets: string; sterile: string; picsOnly: string };
  room: { sterile: string };
  equipment: { press: string };
  lot: string;
  person: string;
  pack: { tabletAllIn: string; tabletAllUs: string };
}

/**
 * The IN-52 stub world: one tablet and one injectable product, each with a batch for {IN} and one
 * for {IN, US, EU}; lines, rooms, equipment, a lot and a person for the union-of-markets scopes.
 */
export async function seedStubWorld(db: TestDatabase): Promise<StubWorld> {
  const tag = randomUUID().slice(0, 8);
  return asApp(db, async (c) => {
    const one = async (sql: string, params: unknown[]): Promise<string> => {
      const { rows } = await c.query<{ id: string }>(sql, params);
      return rows[0]?.id ?? '';
    };
    const siteId = await one('insert into market.stub_site (code, markets) values ($1, $2) returning id', [`SITE-${tag}`, ['IN']]);
    const tabletPred = { licenceForm: 'FORM_25', expiryLabelled: true, otcExpiryExempt: false };
    const injectablePred = { licenceForm: 'FORM_28', expiryLabelled: true, otcExpiryExempt: false };
    const product = (code: string, edition: string, markets: string[], pics: boolean, pred: object) =>
      one('insert into market.stub_product (code, edition, markets, pics_destination, predicates) values ($1, $2, $3, $4, $5) returning id', [
        `${code}-${tag}`,
        edition,
        markets,
        pics,
        JSON.stringify(pred),
      ]);
    const tablet = await product('ATORVA-10', 'tablets', ['IN', 'US', 'EU'], false, tabletPred);
    const injectable = await product('CEFTRI-1G', 'injectables', ['IN', 'US', 'EU'], false, injectablePred);
    const picsInjectable = await product('ONDAN-2ML', 'injectables', ['IN'], true, injectablePred);
    const batch = (no: string, productId: string, markets: string[]) =>
      one('insert into market.stub_batch (batch_number, product_id, site_id, markets) values ($1, $2, $3, $4) returning id', [`${no}-${tag}`, productId, siteId, markets]);
    const tabletIn = await batch('T-IN', tablet, ['IN']);
    const tabletAll = await batch('T-ALL', tablet, ['EU', 'IN', 'US']);
    const injectableIn = await batch('I-IN', injectable, ['IN']);
    const injectableAll = await batch('I-ALL', injectable, ['IN', 'US', 'EU']);
    const picsIn = await batch('P-IN', picsInjectable, ['IN']);
    const scope = (table: string, code: string, edition: string) =>
      one(`insert into market.${table} (code, site_id, edition) values ($1, $2, $3) returning id`, [`${code}-${tag}`, siteId, edition]);
    const lineTablets = await scope('stub_line', 'L-TAB', 'tablets');
    const lineSterile = await scope('stub_line', 'L-STE', 'injectables');
    const linePics = await scope('stub_line', 'L-PICS', 'injectables');
    const roomSterile = await scope('stub_room', 'R-FILL', 'injectables');
    const press = await scope('stub_equipment', 'PRESS-16', 'tablets');
    const qualify = (productId: string, kind: string, id: string) =>
      c.query('insert into market.stub_product_qualification (product_id, scope_kind, scope_id) values ($1, $2, $3)', [productId, kind, id]);
    await qualify(tablet, 'LINE', lineTablets);
    await qualify(tablet, 'EQUIPMENT', press);
    await qualify(injectable, 'LINE', lineSterile);
    await qualify(picsInjectable, 'LINE', lineSterile);
    await qualify(picsInjectable, 'LINE', linePics);
    await qualify(injectable, 'ROOM', roomSterile);
    const person = randomUUID();
    await c.query('insert into market.stub_person_qualification (person_id, scope_kind, scope_id) values ($1, $2, $3), ($1, $4, $5)', [
      person,
      'LINE',
      lineTablets,
      'ROOM',
      roomSterile,
    ]);
    const lot = await one('insert into market.stub_material_lot (code, site_id) values ($1, $2) returning id', [`LOT-${tag}`, siteId]);
    const pack = (code: string, batchId: string, destination: string) =>
      one('insert into market.stub_pack (code, batch_id, destination) values ($1, $2, $3) returning id', [`${code}-${tag}`, batchId, destination]);
    const tabletAllIn = await pack('PK-IN', tabletAll, 'IN');
    const tabletAllUs = await pack('PK-US', tabletAll, 'US');
    return {
      siteId,
      tablet,
      injectable,
      picsInjectable,
      batch: { tabletIn, tabletAll, injectableIn, injectableAll, picsIn },
      line: { tablets: lineTablets, sterile: lineSterile, picsOnly: linePics },
      room: { sterile: roomSterile },
      equipment: { press },
      lot,
      person,
      pack: { tabletAllIn, tabletAllUs },
    };
  }, { roleCode: MARKET_ROLES.stubs });
}

/** A small valid document for a test table, to be varied by each test. */
export function miniDocument(table: string, version = 1): Record<string, unknown> {
  return {
    table,
    version,
    change: { kind: version === 1 ? 'INITIAL' : 'UPDATE', description: `test table ${table} v${version}` },
    keys: [
      { key: `${table}.interval`, title: 'An interval', method: 'SMALLER_STRICTER', valueType: 'DECIMAL', unit: 'min', indiaGoverns: true },
      { key: `${table}.retention`, title: 'A retention', method: 'LARGER_STRICTER', valueType: 'DECIMAL', unit: 'mo', indiaGoverns: true },
    ],
    rows: [
      { ref: 'I.IN', key: `${table}.interval`, market: 'IN', value: '30', unit: 'min', floor: 'HARD', source: 'test source', verification: 'P', effectiveFrom: '2024-01-01' },
      { ref: 'I.EU', key: `${table}.interval`, market: 'EU', value: '20', unit: 'min', floor: 'HARD', source: 'test source', verification: 'CHK', effectiveFrom: '2024-01-01' },
      { ref: 'R.IN', key: `${table}.retention`, market: 'IN', value: '12', unit: 'mo', floor: 'HARD', source: 'test source', verification: 'P', effectiveFrom: '2024-01-01' },
      { ref: 'R.US', key: `${table}.retention`, market: 'US', value: '24', unit: 'mo', floor: 'GUIDANCE', source: 'test source', verification: 'CHK', effectiveFrom: '2024-01-01' },
    ],
  };
}

// ---------------------------------------------------------------------------------------------
// Approvals: real electronic signatures (0360_market_signatures.sql)
// ---------------------------------------------------------------------------------------------

/**
 * A quality-unit person who can sign market approvals (MBR.APPROVE or RECORD.QA_REVIEW). The actor
 * keeps the credentials the signer re-enters at every signing (DI-38).
 */
export function approverActor(db: TestDatabase, roleCode: 'QA_REVIEWER' | 'QA_MBR_APPROVER' = 'QA_REVIEWER'): Promise<SeededActor> {
  return seedActor(db, { roleCode });
}

/**
 * The signing flow as production runs it (esig README): the server's canonical content, a challenge
 * in the signer's own command, the signer's authentication for that challenge through the
 * authentication service, then sign and seal. Returns the signature id.
 */
export async function signApproval(db: TestDatabase, signer: SeededActor, target: ApprovalTarget, expectedState: string | null = 'PROPOSED'): Promise<string> {
  await ensureSealKey(db);
  const content = await contentForSigning(db.app, target.aggregateType, target.aggregateId);
  const challenge = await withCommand(db.app, { ...signer, correlationId: randomUUID() }, (c) =>
    createChallenge(c, {
      aggregateType: target.aggregateType,
      aggregateId: target.aggregateId,
      contentVersion: content.contentVersion ?? '1',
      meaning: target.meaning,
      clientContentHash: content.contentHash ?? '',
    }),
  );
  const ev = await authenticate(seedAuthn(db), {
    method: 'PASSWORD',
    identifier: signer.seed.loginName,
    secret: signer.seed.password,
    deviceFingerprint: signer.seed.deviceFingerprint,
    purpose: 'SIGNATURE',
    challengeId: challenge.challengeId,
  });
  const result = await withCommand(db.app, { ...signer, correlationId: randomUUID() }, (c) =>
    sign(c, { challengeId: challenge.challengeId, authEventId: ev.authEventId, expectedState }, testSealKey),
  );
  return result.signatureId;
}

/**
 * After the approved change is made, its approval signatures must still be valid and raise no
 * integrity problem (the signed content never changes, INV-09): returns each signature's status and
 * problems from esig.signature_state and esig.signature_problems.
 */
export async function approvalIntegrity(db: TestDatabase, signatureIds: string[]): Promise<{ status: string; problems: string[] }[]> {
  const { rows } = await db.admin.query<{ status: string; problems: string[] }>(
    `select esig.signature_state(s.id) ->> 'status' as status,
            coalesce((select array_agg(p) from esig.signature_problems(s.id) p), '{}') as problems
       from unnest($1::uuid[]) with ordinality as s(id, n) order by s.n`,
    [signatureIds],
  );
  return rows;
}

/**
 * A QA approval of a site-value loosening: the SITE_VALUE_LOOSENING_APPROVED signature of exactly the
 * loosening the request describes (market.site_value_preview names it). Returns the signature id to
 * pass as qaApprovalId.
 */
export async function approveSiteLoosening(
  db: TestDatabase,
  request: Omit<SiteValueRequest, 'qaApprovalId'>,
  approver?: SeededActor,
): Promise<string> {
  const preview = await siteValuePreview(db.app, request);
  if (!preview.approval) throw new Error(`not a loosening that can be approved: ${JSON.stringify(preview)}`);
  return signApproval(db, approver ?? (await approverActor(db)), preview.approval);
}

/**
 * The two QA approvals of a source correction: RULE_TABLE_CORRECTION_APPROVED signatures of exactly
 * this document by two different quality-unit persons. Returns the ids to pass as approvalSignatureIds.
 */
export async function approveSourceCorrection(db: TestDatabase, doc: unknown, approvers?: [SeededActor, SeededActor]): Promise<string[]> {
  const target = await ruleCorrectionApprovalTarget(db.app, doc as Record<string, unknown>);
  const [a, b] = approvers ?? [await approverActor(db, 'QA_REVIEWER'), await approverActor(db, 'QA_MBR_APPROVER')];
  return [await signApproval(db, a, target), await signApproval(db, b, target)];
}

/**
 * The approval of the next version of a policy at a position: a POLICY_LOOSENING_APPROVED signature
 * of that version by a quality-unit person other than its author. Returns the id to pass as approvalId.
 */
export async function approvePolicyVersion(db: TestDatabase, policy: string, position: string, approver?: SeededActor): Promise<string> {
  const target = await policyVersionApprovalTarget(db.app, policy, position);
  return signApproval(db, approver ?? (await approverActor(db)), target);
}
