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

type Db = Pick<pg.Pool, 'query'>;

/** Phase 3 slice 6a-0: routes fixed in the contract whose handlers arrive with slice 6a (501 until then). */
const notYet = (): Promise<never> =>
  Promise.reject(
    refusal(501, {
      code: 'NOT_IMPLEMENTED',
      kind: 'NOT_ENABLED',
      whatHappened: 'This function is not available yet.',
      why: 'It arrives with Phase 3 slice 6a.',
      whatYouCanDo: ['Use another path for now.'],
    }),
  );

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
      startInvestigation: async ({ params, actor, idempotencyKey, requestHash }) => {
        await withIdempotentActorCommand(pool, actor(), idempotencyKey ?? '', requestHash, async (c) => {
          await c.query('select site.start_deviation_investigation($1)', [params.deviationId]);
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
      deviations: notYet,
      registerEvidenceDocument: notYet,
      extraTesting: notYet,
      erpOrders: notYet,
      erpProducts: notYet,
      erpMaterials: notYet,
      lots: notYet,
      receiveLot: notYet,
    },
    { rateLimits: { erpImport: { max: 30, timeWindow: '1 minute' } } },
  );
  return Promise.resolve();
}
