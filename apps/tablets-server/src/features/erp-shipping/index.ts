/**
 * Feature `erp-shipping` (Phase 4 slice 4b, GMP): the ERP stub's shipping interlock (contract ns/qp-shipping.ts; site
 * services 0870; INV-42, IN-05 (a)). The ERP asks before it ships (site.shipment_problems) and records the shipment
 * through site.erp_record_shipment; the database refuses any shipment the interlock does not let through, whoever
 * writes it. Like the ERP import (feature quality), the ERP authenticates with its own service identity (SERVICE_KEY on
 * its host terminal, DEMO stub); the session ends after the request.
 */
import { routes, type ShipmentView } from '@ebmr/api-contract';
import { commands, identity, type ActorContext } from '@ebmr/kernel';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import type { AppContext } from '../../platform/context.ts';
import { bindRoutes } from '../../platform/http/bind.ts';
import { withScopedCommand } from '../../platform/db/commands.ts';
import { usOf } from '../common/people.ts';

type Db = Pick<pg.Pool, 'query'>;

/** Runs `work` as the ERP interface's service identity; the session ends afterwards. A refusal answers as a kernel error. */
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
    return await withScopedCommand(app.pools.app, actor, work);
  } catch (error) {
    throw commands.asKernelError(error);
  } finally {
    await identity.endSession(app.pools.app, s.sessionId);
  }
}

async function shipments(app: AppContext, db: Db, where: string, param: string): Promise<ShipmentView[]> {
  const { rows } = await db.query<{
    id: string; shipment_no: string; lot_id: string; market: ShipmentView['market']; consignee_code: string; consignee_name: string; quantity: string; unit: string;
    quarantine: boolean; manufacturer_state: string; disposition_state: string; eu_importer_id: string | null; erp_reference: string; us: string;
  }>(
    `select s.id, s.shipment_no, s.lot_id, s.market, s.consignee_code, s.consignee_name, s.quantity::text as quantity, s.unit, s.quarantine, s.manufacturer_state,
            s.disposition_state, s.eu_importer_id, s.erp_reference, ${usOf('s.recorded_at')} as us
       from site.erp_shipment s where ${where} = $1 order by s.recorded_at, s.id`,
    [param],
  );
  return rows.map((r) => ({
    shipmentId: r.id, shipmentNo: r.shipment_no, lotId: r.lot_id, market: r.market, consigneeCode: r.consignee_code, consigneeName: r.consignee_name,
    quantity: r.quantity, unit: r.unit, quarantine: r.quarantine, manufacturerState: r.manufacturer_state, dispositionState: r.disposition_state,
    euImporterId: r.eu_importer_id, erpReference: r.erp_reference, recordedAt: app.formatInstant(r.us),
  }));
}

export function plugin(scope: FastifyInstance, app: AppContext): Promise<void> {
  const pool = app.pools.app;
  bindRoutes(scope, app, routes.erpShipping, {
    check: async ({ body }) => {
      const s = body.shipment;
      const problems = await asErp(app, body, async (c) =>
        (await c.query<{ p: string[] }>('select site.shipment_problems($1, $2, $3, $4, $5::numeric, $6) as p', [s.lotId, s.market, s.consigneeCode, s.quarantine, s.quantity, s.unit])).rows[0]?.p ?? [],
      );
      return { allowed: problems.length === 0, problems };
    },
    record: async ({ body }) => {
      const id = await asErp(app, body, async (c) => (await c.query<{ id: string }>('select site.erp_record_shipment($1::jsonb) as id', [JSON.stringify(body.shipment)])).rows[0]?.id ?? '');
      const view = (await shipments(app, pool, 's.id::text', id))[0];
      if (!view) throw new Error('the recorded shipment was not found');
      return view;
    },
    lot: async ({ params, requireSession }) => {
      requireSession();
      return { shipments: await shipments(app, pool, 's.lot_id::text', params.lotId) };
    },
  });
  return Promise.resolve();
}
