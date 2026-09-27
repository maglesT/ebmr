/**
 * Test helpers for the market-profile engine. Every actor comes from testActor (coordination rule:
 * the lead will make it seed a real identity once the identity module is in place).
 */
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import type { ActorContext } from '../../src/db/command.ts';
import { withCommand } from '../../src/db/command.ts';
import { readRuleTableFile, syncRuleTables, type SyncOutcome } from '../../src/market/loader.ts';
import type { RuleTableCode, RuleTableDocument } from '../../src/market/types.ts';
import { actor } from '../support/actors.ts';
import type { TestDatabase } from '../support/db.ts';

export function testActor(db: TestDatabase, overrides: Partial<ActorContext> = {}): Promise<ActorContext> {
  return Promise.resolve(actor(overrides));
}

export const RULE_TABLE_ROOT = new URL('../../../../compliance/rule-tables/', import.meta.url).pathname;

export function seedDocument(table: RuleTableCode): RuleTableDocument {
  return readRuleTableFile(`${RULE_TABLE_ROOT}${table}/${table}.v1.yaml`).document;
}

/** Publish the seed rule tables from compliance/rule-tables. */
export async function publishSeedTables(db: TestDatabase): Promise<Map<RuleTableCode, string>> {
  const outcomes: SyncOutcome[] = await syncRuleTables(db.app, await testActor(db, { roleCode: 'REGULATORY_SIGNER' }), RULE_TABLE_ROOT);
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
  return publishDocumentAs(db, await testActor(db, { roleCode: 'REGULATORY_SIGNER' }), doc, change);
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
  });
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
