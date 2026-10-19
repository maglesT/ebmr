/**
 * Feature `quality` (Phase 3 slice 5a, GMP): deviation-lite, LIMS-lite lot results and the ERP stub's import (slice 5
 * plan D-S5-1 to D-S5-4). Each route runs the person's own command (or the ERP interface's) through the site-services
 * definers; every rule is the database's (site services 0730 to 0752). Signed acts are not here yet (see the contract).
 *
 * The ERP import is authenticated by the ERP interface's own service identity (SERVICE_KEY on its host terminal, as the
 * sweeper's session is opened), runs as that identity (source INTEGRATION, role ERP_INTERFACE) and ends the session.
 */
import { routes, type DeviationView, type ErpCatalogue, type LotResultView } from '@ebmr/api-contract';
import { identity, withCommand, type ActorContext } from '@ebmr/kernel';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import type { AppContext } from '../../platform/context.ts';
import { withIdempotentActorCommand } from '../../platform/db/commands.ts';
import { bindRoutes } from '../../platform/http/bind.ts';
import { refusal } from '../../platform/http/refusal.ts';
import type { SignableActionRegistry } from '../../platform/ports.ts';
import { peopleOf, personRef, usOf } from '../common/people.ts';
import { deviationHandlers } from './deviation.ts';
import { lotDestructionWitnessHandler, receiptHandlers } from './receipt.ts';
import { deviationIds, erpMaterials, erpOrders, erpPending, erpProducts, extraTesting, lots } from './reads.ts';
import { reprocessingAuthorisations, reprocessingRequests, residueContainers } from './reprocessing.ts';
import { lotDecisionHandler, qualityActHandler, reprocessingActHandler } from './signables.ts';

export function registerSignableActions(registry: SignableActionRegistry, app: AppContext): void {
  if (app.installation !== 'GMP') return;
  registry.register(qualityActHandler(app));
  registry.register(lotDecisionHandler(app));
  registry.register(reprocessingActHandler(app));
  // Phase 7 slice 7g (WP4): the witness's signature on a recorded lot destruction (receipt.ts).
  registry.register(lotDestructionWitnessHandler(app));
}

type Db = Pick<pg.Pool, 'query'>;


async function deviationView(db: Db, deviationId: string): Promise<DeviationView> {
  const { rows } = await db.query<{ id: string; ref: string; kind: DeviationView['kind']; title: string; classification: DeviationView['classification']; state: DeviationView['state'] }>(
    'select d.id, d.ref, d.kind, d.title, d.classification, site.deviation_state(d.id) as state from site.deviation d where d.id = $1',
    [deviationId],
  );
  const d = rows[0];
  if (!d) throw Object.assign(new Error('EBMR-SITE-302 unknown deviation-lite record'), { statusCode: 404 });
  const links = await db.query<{ subject_kind: 'BATCH' | 'LOT' | 'CONTAINER'; subject_ref: string; batch_number: string | null }>(
    'select subject_kind, subject_ref, batch_number from site.deviation_link where deviation_id = $1 order by linked_at, id',
    [deviationId],
  );
  return {
    deviationId: d.id,
    ref: d.ref,
    kind: d.kind,
    title: d.title,
    classification: d.classification,
    state: d.state,
    links: links.rows.map((l) => ({ subjectKind: l.subject_kind, subjectRef: l.subject_ref, batchNumber: l.batch_number })),
  };
}

async function lotResults(db: Db, lotId: string): Promise<LotResultView[]> {
  const { rows } = await db.query<{
    id: string; test_code: string; purpose: 'RELEASE' | 'RETEST'; value: string; unit: string; lower: string | null; upper: string | null; verdict: 'PASS' | 'FAIL';
    state: 'RECORDED' | 'APPROVED' | 'REVISED';
  }>(
    `select r.id, r.test_code, r.purpose, r.result_value::text as value, r.unit, r.lower_limit::text as lower, r.upper_limit::text as upper, r.verdict,
            site.lot_test_state(r.id) as state
       from site.lot_test_result r where r.lot_id = $1 order by r.recorded_at, r.id`,
    [lotId],
  );
  return rows.map((r) => ({
    resultId: r.id, testCode: r.test_code, purpose: r.purpose, value: r.value, unit: r.unit, lowerLimit: r.lower, upperLimit: r.upper, verdict: r.verdict, state: r.state,
  }));
}

/** Runs `work` as the ERP interface's service identity; the session ends afterwards. */
async function asErp<T>(app: AppContext, c: { loginName: string; serviceKey: string; fingerprint: string }, work: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const ev = await identity.authenticate(app.pools.authn, { method: 'SERVICE_KEY', identifier: c.loginName, secret: c.serviceKey, deviceFingerprint: c.fingerprint, purpose: 'LOGIN' });
  const s = await identity.openSession(app.pools.app, ev.authEventId, c.fingerprint);
  try {
    const { rows } = await app.pools.app.query<{ person_id: string; account_id: string; legal_name: string }>(
      'select a.person_id, a.id as account_id, p.legal_name from iam.account a join iam.person p on p.id = a.person_id where a.login_name = $1',
      [c.loginName],
    );
    const who = rows[0];
    if (!who) throw new Error(`the account ${c.loginName} does not exist`);
    const actor: ActorContext = {
      personId: who.person_id, accountId: who.account_id, roleCode: 'ERP_INTERFACE', sessionId: s.sessionId, deviceId: s.deviceId, source: 'INTEGRATION',
      siteZone: app.siteZone.current(), legalName: who.legal_name, correlationId: crypto.randomUUID(),
    };
    return await withCommand(app.pools.app, actor, work);
  } finally {
    await identity.endSession(app.pools.app, s.sessionId);
  }
}

async function importCatalogue(client: pg.PoolClient, catalogue: ErpCatalogue): Promise<{ products: number; materials: number; orders: number }> {
  for (const p of catalogue.products) await client.query('select site.erp_receive_product($1::jsonb)', [JSON.stringify(p)]);
  for (const m of catalogue.materials) await client.query('select site.erp_receive_material($1::jsonb)', [JSON.stringify(m)]);
  for (const o of catalogue.orders) await client.query('select site.erp_receive_order($1::jsonb)', [JSON.stringify(o)]);
  return { products: catalogue.products.length, materials: catalogue.materials.length, orders: catalogue.orders.length };
}

export function plugin(scope: FastifyInstance, app: AppContext): Promise<void> {
  const pool = app.pools.app;
  bindRoutes(
    scope,
    app,
    routes.quality,
    {
      ...deviationHandlers(pool),
      // Phase 6 slice 6a builder A: receipt, the receipt record and the approved-manufacturer register (receipt.ts).
      ...receiptHandlers(app, pool),
      raiseDeviation: async ({ body, actor, idempotencyKey, requestHash }) => {
        const d = body;
        const out = await withIdempotentActorCommand(pool, actor(), idempotencyKey ?? '', requestHash, async (c) => {
          const { rows } = await c.query<{ r: { deviationId: string } }>('select site.raise_deviation($1::jsonb) as r', [JSON.stringify(d)]);
          return rows[0]?.r.deviationId ?? '';
        });
        return deviationView(pool, out.result);
      },
      deviation: async ({ params }) => deviationView(pool, params.deviationId),
      linkDeviation: async ({ params, body, actor, idempotencyKey, requestHash }) => {
        await withIdempotentActorCommand(pool, actor(), idempotencyKey ?? '', requestHash, async (c) => {
          await c.query('select site.link_deviation($1, $2, $3)', [params.deviationId, body.subjectKind, body.subjectId]);
          return null;
        });
        return deviationView(pool, params.deviationId);
      },
      startInvestigation: async ({ params, body, actor, idempotencyKey, requestHash }) => {
        // QA's classification starts the investigation (IN-02; site services 0821).
        await withIdempotentActorCommand(pool, actor(), idempotencyKey ?? '', requestHash, async (c) => {
          await c.query('select site.start_deviation_investigation($1, $2::jsonb)', [params.deviationId, JSON.stringify(body)]);
          return null;
        });
        return deviationView(pool, params.deviationId);
      },
      recordFinding: async ({ params, body, actor, idempotencyKey, requestHash }) => {
        const f = body;
        await withIdempotentActorCommand(pool, actor(), idempotencyKey ?? '', requestHash, async (c) => {
          await c.query('select site.record_deviation_finding($1, $2::jsonb)', [params.deviationId, JSON.stringify(f)]);
          return null;
        });
        return deviationView(pool, params.deviationId);
      },
      cancelDeviation: async ({ params, body, actor, idempotencyKey, requestHash }) => {
        await withIdempotentActorCommand(pool, actor(), idempotencyKey ?? '', requestHash, async (c) => {
          await c.query('select site.cancel_deviation($1, $2)', [params.deviationId, body.reason]);
          return null;
        });
        return deviationView(pool, params.deviationId);
      },
      recordLotResult: async ({ params, body, actor, idempotencyKey, requestHash }) => {
        const r = body;
        const out = await withIdempotentActorCommand(pool, actor(), idempotencyKey ?? '', requestHash, async (c) => {
          const { rows } = await c.query<{ r: { resultId: string } }>('select site.record_lot_test_result($1, $2::jsonb) as r', [params.lotId, JSON.stringify(r)]);
          return rows[0]?.r.resultId ?? '';
        });
        const view = (await lotResults(pool, params.lotId)).find((x) => x.resultId === out.result);
        if (!view) throw new Error('the recorded result was not found');
        return view;
      },
      lotResults: async ({ params }) => ({ results: await lotResults(pool, params.lotId) }),
      erpImport: async ({ body }) => asErp(app, body, (c) => importCatalogue(c, body.catalogue)),
      deviations: async ({ query, requireSession }) => {
        requireSession();
        const out = [];
        for (const id of await deviationIds(pool, query)) out.push(await deviationView(pool, id));
        return { deviations: out };
      },
      registerEvidenceDocument: async ({ body, requireSession, actor, idempotencyKey, requestHash }) => {
        requireSession();
        const bytes = Buffer.from(body.contentBase64, 'base64');
        if (bytes.length === 0 || bytes.length > 4_194_304) {
          throw refusal(422, { code: 'EBMR-API-DOCUMENT-SIZE', kind: 'INVALID_INPUT', whatHappened: 'The document is empty or larger than 4 MB. Nothing was stored.', why: `It has ${String(bytes.length)} bytes.`, whatYouCanDo: ['Attach a document of at most 4 MB.'] });
        }
        // The database stores the bytes and computes their SHA-256 and size (site services 0823): nothing is self-attested.
        const out = await withIdempotentActorCommand(pool, actor(), idempotencyKey ?? '', requestHash, async (c) => {
          const { rows } = await c.query<{ r: string }>('select site.store_evidence_document($1::jsonb, $2)::text as r', [
            JSON.stringify({ mediaType: body.mediaType, title: body.title }),
            bytes,
          ]);
          return rows[0]?.r ?? '';
        });
        const { rows } = await pool.query<{ id: string; title: string; media_type: string; size_bytes: string; sha256: string; by: string; us: string }>(
          `select d.id, d.title, d.media_type, d.size_bytes::text as size_bytes, d.sha256, d.uploaded_by_person as by, ${usOf('d.uploaded_at')} as us from site.evidence_document d where d.id = $1`,
          [out.result],
        );
        const d = rows[0];
        if (!d) throw new Error('the registered document was not found');
        const people = await peopleOf(pool, [d.by]);
        return { documentId: d.id, title: d.title, mediaType: d.media_type, sizeBytes: d.size_bytes, sha256: d.sha256, uploadedBy: personRef(people, d.by, 'UPLOADER'), uploadedAt: app.formatInstant(d.us) };
      },
      extraTesting: async ({ params, requireSession }) => {
        requireSession();
        return extraTesting(app, pool, params.batchId);
      },
      erpOrders: async ({ requireSession }) => {
        requireSession();
        return { orders: await erpOrders(app, pool) };
      },
      erpProducts: async ({ requireSession }) => {
        requireSession();
        return { products: await erpProducts(pool) };
      },
      erpMaterials: async ({ requireSession }) => {
        requireSession();
        return { materials: await erpMaterials(pool) };
      },
      erpPending: async ({ requireSession }) => {
        requireSession();
        return { pending: await erpPending(app, pool) };
      },
      lots: async ({ query, requireSession }) => {
        requireSession();
        return { lots: await lots(app, pool, query) };
      },
      receiveLot: async ({ body, requireSession, actor, idempotencyKey, requestHash }) => {
        requireSession();
        const out = await withIdempotentActorCommand(pool, actor(), idempotencyKey ?? '', requestHash, async (c) => {
          const { rows } = await c.query<{ r: { lot_id: string } }>('select site.receive_lot($1::jsonb) as r', [
            JSON.stringify({ materialCode: body.materialCode, lotCode: body.lotCode, supplier: body.supplier, supplierLot: body.supplierLot, quantity: body.quantity, expiresAt: body.expiresAt, ...(body.retestAt ? { retestAt: body.retestAt } : {}) }),
          ]);
          return rows[0]?.r.lot_id ?? '';
        });
        const view = (await lots(app, pool, { lotId: out.result }))[0];
        if (!view) throw new Error('the received lot was not found');
        return view;
      },
      reprocessingRequests: async ({ requireSession }) => {
        requireSession();
        return { requests: await reprocessingRequests(app, pool) };
      },
      reprocessingAuthorisations: async ({ query, requireSession }) => {
        requireSession();
        return { authorisations: await reprocessingAuthorisations(app, pool, query.batchId) };
      },
      residues: async ({ query, requireSession }) => {
        requireSession();
        return { containers: await residueContainers(app, pool, query.product) };
      },
    },
    { rateLimits: { erpImport: { max: 30, timeWindow: '1 minute' } } },
  );
  return Promise.resolve();
}
