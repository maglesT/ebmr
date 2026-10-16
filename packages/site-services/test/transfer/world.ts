/**
 * Two installations in one test run (Phase 6 slice 6i; kernel 1220, site services 0980, 0981, recipe-core 1090, 1091):
 * each a database of its own, with its installation identity and Ed25519 key, the other registered as its trusted peer
 * (proposed by the system administrator, approved by QA's signature), and the seed rule tables published.
 *
 * The private keys stand in for each server's key file (D-P6i-0-8): the test seals what the database built, exactly as
 * the server does. The intermediate lot is received, tested and released for further processing through the real acts
 * of the lot tests' world (lots/support.ts: the ERP's material master, QC's approved specification and result, QA's
 * signed decision). Fixtures, not proofs (superuser, triggers off): the destination's consumption, finished lot and
 * shipment (each event's own act is proven where it is built).
 */
import { createHash, generateKeyPairSync, randomUUID, sign, type KeyObject } from 'node:crypto';
import { withCommand } from '../../../kernel/src/db/command.ts';
import type { SeededActor } from '../../../kernel/test/identity/seed.ts';
import { publishSeedTables } from '../../../kernel/test/market/helpers.ts';
import { createTestDatabase, signerActor, signFor, type TestDatabase } from '../helpers.ts';
import { seedCast, World, type Cast } from '../lots/support.ts';

export const TAG = randomUUID().slice(0, 4).toUpperCase();
let serial = 0;
export const unique = (prefix: string): string => `${prefix}${TAG}${(serial++).toString().padStart(3, '0')}`;

export async function refusal(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return '';
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

export type Purpose = 'transfer-package' | 'federation-request' | 'federation-answer';

/** What a seal signs (kernel 1220 platform.seal_message): the purpose and the SHA-256 hex of the payload's UTF-8. */
export function sealOf(key: KeyObject, purpose: Purpose, payload: string): string {
  const message = Buffer.from(`ebmr.${purpose}.v1|${createHash('sha256').update(payload, 'utf8').digest('hex')}`, 'utf8');
  return sign(null, message, key).toString('base64');
}

export function rawPublicKey(key: KeyObject): string {
  const x = key.export({ format: 'jwk' }).x;
  if (!x) throw new Error('not an Ed25519 key');
  return Buffer.from(x, 'base64url').toString('base64');
}

export interface Row {
  nodeKind: string;
  nodeId: string;
  parentKind: string | null;
  parentId: string | null;
  edgeKind: string | null;
  depth: number;
}

export class Installation {
  admin!: SeededActor;
  qa!: SeededActor;
  stores!: SeededActor;
  ap!: SeededActor;
  cast!: Cast;
  w!: World;
  readonly key: KeyObject;
  readonly publicKey: string;

  private constructor(
    readonly db: TestDatabase,
    readonly code: string,
  ) {
    const pair = generateKeyPairSync('ed25519');
    this.key = pair.privateKey;
    this.publicKey = rawPublicKey(pair.publicKey);
  }

  static async create(code: string): Promise<Installation> {
    const i = new Installation(await createTestDatabase(), code);
    i.cast = await seedCast(i.db);
    i.w = new World(i.db, i.cast);
    i.admin = i.cast.admin;
    i.qa = i.cast.qa;
    i.stores = i.cast.warehouse;
    i.ap = await signerActor(i.db, 'AUTHORISED_PERSON');
    await i.run(i.admin, "select platform.set_installation_identity($1, 'SITE-1', 'TABLETS', $2) as r", [code, i.publicKey]);
    await publishSeedTables(i.db);
    return i;
  }

  async run<T>(actor: SeededActor, sql: string, params: unknown[] = [], reason = 'inter-site transfer test'): Promise<T> {
    return withCommand(this.db.app, { ...actor, correlationId: randomUUID(), reasonCode: 'TEST', reasonText: reason }, async (c) =>
      (await c.query<{ r: T }>(sql, params)).rows[0]?.r as T);
  }

  /** Superuser writes with triggers off (fixtures only). */
  async fixture(sql: string, params: unknown[] = []): Promise<void> {
    const c = await this.db.admin.connect();
    try {
      await c.query('begin');
      await c.query('set local session_replication_role = replica');
      await c.query(sql, params);
      await c.query('commit');
    } catch (error) {
      await c.query('rollback');
      throw error;
    } finally {
      c.release();
    }
  }

  /** The lot machine's initial state of a fixture lot, created as the receiving act creates it (a command as the superuser). */
  async quarantine(lot: string): Promise<void> {
    await withCommand(this.db.admin, { ...this.stores, correlationId: randomUUID() }, (c) => c.query("select platform.create_aggregate_state('material_lot', 'material_lot', $1)", [lot]));
  }

  /** A reservation row written straight into the table (the superuser in a command, the trigger on): the guard is every writer's. */
  async bypassReservation(lot: string): Promise<unknown> {
    return withCommand(this.db.admin, { ...this.stores, correlationId: randomUUID() }, (c) => c.query(
      `insert into site.lot_reservation (lot_id, batch_id, batch_number, edition, quantity, unit, expires_at, lot_state_version, reserved_by_person, reserved_by_account)
       values ($1, gen_random_uuid(), 'B-1', 'TABLETS', 1, 'kg', now() + interval '1 hour', 1, $2, $3)`, [lot, this.stores.personId, this.stores.accountId]));
  }

  async scalar<T>(sql: string, params: unknown[] = []): Promise<T> {
    return (await this.db.admin.query<{ v: T }>(sql, params)).rows[0]?.v as T;
  }

  /** Registers `peer` as trusted: proposed by the administrator, approved by QA's PEER_INSTALLATION_APPROVED. */
  async trust(peer: Installation, baseUrl = 'http://127.0.0.1:1'): Promise<string> {
    const id = await this.propose(peer.code, peer.publicKey, baseUrl);
    await this.approvePeer(id);
    return id;
  }

  async propose(code: string, publicKey: string, baseUrl = 'http://127.0.0.1:1'): Promise<string> {
    return this.run<string>(this.admin, 'select platform.propose_peer_installation($1::jsonb) as r', [
      JSON.stringify({ installationCode: code, siteCode: 'SITE-1', edition: 'TABLETS', baseUrl, publicKey }),
    ]);
  }

  async approvePeer(id: string, by: SeededActor = this.qa): Promise<void> {
    const sig = await signFor(this.db, by, { type: 'peer_installation', id }, 'PEER_INSTALLATION_APPROVED', 'PROPOSED');
    await this.run(by, 'select platform.approve_peer_installation($1, $2) as r', [id, sig]);
  }

  async version(lot: string): Promise<string> {
    return this.scalar<string>("select version::text as v from platform.aggregate_state where aggregate_type = 'material_lot' and aggregate_id = $1", [lot]);
  }

  async state(lot: string): Promise<string> {
    return this.scalar<string>('select site.lot_state($1) as v', [lot]);
  }

  /** An intermediate lot received, tested and released for further processing by QA at this site (real acts). */
  async releasedIntermediate(quantity = '500', over: { expiresAt?: string; retestAt?: string } = {}): Promise<{ id: string; code: string }> {
    const code = unique('INT-');
    const lot = await this.w.receive('INTERMEDIATE', { lotCode: code, materialCode: unique('GRAN'), materialName: 'Paracetamol granules 500 mg', quantity, unit: 'kg',
                                                      expiresAt: over.expiresAt ?? '2030-01-01T00:00:00Z', retestAt: over.retestAt ?? '2029-01-01T00:00:00Z' });
    await this.releaseForFurtherProcessing(lot.lotId);
    return { id: lot.lotId, code };
  }

  /** QA's signed RELEASE_FOR_FURTHER_PROCESSING of a lot at this site (proposed, signed, decided). */
  async releaseForFurtherProcessing(lot: string): Promise<void> {
    const sig = await this.w.decide(this.qa, lot, 'RELEASE_FOR_FURTHER_PROCESSING', 'QUARANTINE');
    await this.run(this.qa, "select site.change_lot_status($1, 'RELEASE_FOR_FURTHER_PROCESSING', $2::bigint, $3)::text as r", [lot, await this.version(lot), sig],
      'granules meet their intermediate specification');
  }

  /** What the receiving site's QC needs before its own release: the material master, its specification and a passing result. */
  async locallyTested(lot: string): Promise<void> {
    const code = await this.scalar<string>('select material_code as v from site.material_lot where id = $1', [lot]);
    await this.w.material(code, 'Paracetamol granules 500 mg', 'INTERMEDIATE');
    await this.w.specification(code);
    await this.w.passingResult(lot);
  }

  /** Builds and seals a package as the server does (one command): the database's payload, this installation's seal. */
  async ship(lot: string, to: Installation | string, quantity = '100', extra: Record<string, unknown> = {}): Promise<{ packageId: string; packageNo: string; payload: string; seal: string }> {
    const destination = typeof to === 'string' ? to : to.code;
    return withCommand(this.db.app, { ...this.stores, correlationId: randomUUID(), reasonCode: 'TEST', reasonText: 'ship' }, async (c) => {
      const p = (await c.query<{ r: { packageId: string; packageNo: string; payload: string } }>('select site.prepare_transfer_package($1, $2::jsonb) as r', [
        lot, JSON.stringify({ destination, quantity, ...extra }),
      ])).rows[0]!.r;
      const seal = sealOf(this.key, 'transfer-package', p.payload);
      await c.query('select site.seal_transfer_package($1, $2)', [p.packageId, seal]);
      return { ...p, seal };
    });
  }

  async receive(payload: string, seal: string): Promise<{ outcome: string; receiptId?: string; lotId?: string; lotCode?: string; reason?: string; kind?: string; alarmId?: string }> {
    return this.run(this.stores, 'select site.import_transfer_package($1, $2) as r', [payload, seal]);
  }

  async decide(receipt: string, decision: 'ACCEPTED' | 'REFUSED', reason: string | null = null, by: SeededActor = this.qa): Promise<string> {
    const sig = await signFor(this.db, by, { type: 'transfer_receipt', id: receipt }, `TRANSFER_RECEIPT_${decision}`, 'RECEIVED');
    return this.run(by, 'select site.decide_transfer_receipt($1, $2, $3, $4) as r', [receipt, decision, sig, reason]);
  }

  /** Batch `batch` consumed lot `lot`, packed into finished lot `finished`, shipped to a consignee (fixtures). */
  async downstream(lot: string): Promise<{ batch: string; batchNumber: string; finished: string; shipment: string; consignee: string }> {
    const ids = { batch: randomUUID(), finished: randomUUID(), shipment: randomUUID() };
    const number = unique('B');
    const consignee = unique('CUST-');
    const who = randomUUID();
    await this.fixture(
      `with b as (insert into recipe.batch_allocation_link (batch_id, allocation_id, batch_number, person_id, account_id, correlation_id)
                  values ($1, gen_random_uuid(), $4, $7, $7, $7) returning batch_id),
            c as (insert into site.lot_consumption (lot_id, reservation_id, batch_id, batch_number, edition, material_code, quantity, unit, quantity_before, quantity_after,
                                                    market_set, identity_basis, consumed_by_person, consumed_by_account, xact_id)
                  values ($5, gen_random_uuid(), $1, $4, 'TABLETS', 'GRAN-500', 10, 'kg', 100, 90, '{IN}', 'INTERMEDIATE', $7, $7, 1) returning id),
            l as (insert into site.material_lot (id, site_code, lot_code, material_code, material_name, material_kind, received_quantity, unit, expires_at,
                                                 received_by_person, received_by_account, correlation_id)
                  values ($2, 'SITE-1', $4, 'PCM-500', 'Paracetamol tablets 500 mg', 'FINISHED', 1000, 'units', '2029-01-01T00:00:00Z', $7, $7, $7) returning id),
            fl as (insert into site.finished_lot (lot_id, batch_id, batch_number, edition, product_code, strength, markets, posted_by_person, posted_by_account)
                   values ($2, $1, $4, 'TABLETS', 'PCM-500', '500 mg', '{IN}', $7, $7) returning lot_id)
       insert into site.erp_shipment (id, shipment_no, lot_id, market, consignee_code, consignee_name, consignee_address, quantity, unit, quarantine, manufacturer_state,
                                      disposition_state, erp_reference, shipped_at, lot_code, product_name, strength, recorded_by_person, recorded_by_account, correlation_id)
       values ($3, $6, $2, 'IN', $8, 'Goa Distributors', '4 Harbour Road, Panaji', 400, 'units', false, 'RELEASED', 'RELEASED', 'DN-1', now(), $4,
               'Paracetamol tablets 500 mg', '500 mg', $7, $7, $7)`,
      [ids.batch, ids.finished, ids.shipment, number, lot, unique('SH-'), who, consignee],
    );
    await this.quarantine(ids.finished);
    return { ...ids, batchNumber: number, consignee };
  }

  async trace(kind: string, id: string, direction: 'FORWARD' | 'BACKWARD'): Promise<Row[]> {
    return (await this.db.app.query<Row>(
      `select node_kind as "nodeKind", node_id::text as "nodeId", parent_kind as "parentKind", parent_id::text as "parentId", edge_kind as "edgeKind", depth
         from recipe.genealogy($1, $2, $3, null)`,
      [kind, id, direction],
    )).rows;
  }

  /**
   * The asking side of a federated query, as the server runs it: the request this database issues, sealed with this
   * key, answered by `peer`'s database (the answer sealed with `peer`'s key), recorded here. Returns the record result.
   */
  async ask(peer: Installation, transfer: string, direction: 'FORWARD' | 'BACKWARD', asOfUs: string | null = null): Promise<{ ok: boolean; excerptId?: string; reason?: string; nonce: string; answer: { ok: boolean; payload?: string; reason?: string } }> {
    const req = (await this.db.app.query<{ r: { nonce: string; request: string } }>('select recipe.issue_federated_request($1, $2, $3, site.us_instant($4)) as r', [peer.code, transfer, direction, asOfUs])).rows[0]!.r;
    const answer = (await peer.db.app.query<{ r: { ok: boolean; payload?: string; reason?: string } }>('select recipe.answer_federated_genealogy($1, $2) as r', [
      req.request, sealOf(this.key, 'federation-request', req.request),
    ])).rows[0]!.r;
    if (!answer.ok || !answer.payload) {
      await this.db.app.query("select recipe.record_federation_failure($1, 'REFUSED', $2)", [req.nonce, answer.reason ?? 'refused']);
      return { ok: false, ...(answer.reason ? { reason: answer.reason } : {}), nonce: req.nonce, answer };
    }
    const rec = (await this.db.app.query<{ r: { ok: boolean; excerptId?: string; reason?: string } }>('select recipe.record_federated_excerpt($1, $2, $3) as r', [
      req.nonce, answer.payload, sealOf(peer.key, 'federation-answer', answer.payload),
    ])).rows[0]!.r;
    return { ...rec, nonce: req.nonce, answer };
  }

  async drop(): Promise<void> {
    await this.db.drop();
  }
}
