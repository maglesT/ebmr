/**
 * The ERP/WMS adapter (Phase 6 slice 6a, builder A; DI-31, PR-17, PR-46; D-P6a-2): two feeds of the ERP_WMS system, each
 * its own registered adapter instance (D-P6a-0-7), on the worker framework (../framework.ts), started
 * with the server by ../start.ts.
 *
 *   ERP feed  erp.production_order, erp.material_master, erp.product_master, erp.shipment; keeps ERP_ITEM_MASTER fresh;
 *             after each cycle delivers the outbound queue (erp.stock_block, erp.lot_status, erp.goods_issue, erp.yield;
 *             site services 0912) to the ERP: retried with back-off per message, never dropped (./outbound.ts).
 *   WMS feed  wms.goods_receipt, wms.stock_move, wms.lot_status; keeps ERP_LOT_STATUS and WMS_STOCK fresh; after each
 *             cycle answers the WMS's questions before a move with site.location_move_problem (PR-46, ./moves.ts).
 *
 * Both receive through site.erp_wms_receive (site services 0913): platform.accept_inbound_detail and the domain command
 * in one transaction. The adapter's account holds ERP_WMS_INTERFACE (0914).
 */
import { ERP_WMS, type AdapterTransportOptions, type InboundEnvelope } from '@ebmr/integration-sdk/adapter';
import type { ActorContext } from '@ebmr/kernel';
import type pg from 'pg';
import { AdapterWorker, httpFeedClient, workerOptions, type AdapterDefinition, type AdapterWorkerOptions, type FetchFn, type ReceiveResult } from '../framework.ts';
import { mtlsFetch } from '../transport.ts';
import { answerMoveQuestions } from './moves.ts';
import { OutboundDelivery } from './outbound.ts';

/** The role of the ERP/WMS adapter's account (site services 0914). */
export const ERP_WMS_ROLE = 'ERP_WMS_INTERFACE';
/** The SERVER terminals of the two feeds in the service-keys file (each entry also names its endpoint). */
export const ERP_WMS_TERMINALS = { ERP: 'SRV-ERP-ADAPTER-01', WMS: 'SRV-WMS-ADAPTER-01' } as const;
export type ErpWmsFeed = keyof typeof ERP_WMS_TERMINALS;

export const MIRROR_CLASSES: Readonly<Record<ErpWmsFeed, readonly string[]>> = {
  ERP: ['ERP_ITEM_MASTER'],
  WMS: ['ERP_LOT_STATUS', 'WMS_STOCK'],
};

async function receive(client: pg.PoolClient, envelope: InboundEnvelope): Promise<ReceiveResult> {
  const { rows } = await client.query<{ r: ReceiveResult }>('select site.erp_wms_receive($1::jsonb) as r', [JSON.stringify(envelope)]);
  const r = rows[0]?.r;
  if (!r) throw new Error('site.erp_wms_receive returned nothing');
  return r;
}

export interface ErpWmsOptions extends AdapterTransportOptions {
  /** The feed's base URL (the simulator: http://host:port/erp/v1 or /wms/v1). */
  endpoint: string;
  timeoutMs?: number;
  fetchFn?: FetchFn;
  pageSize?: number;
  /** The database clock and the reconciliation schedule (framework.ts; tests inject them). */
  nowUs?: () => Promise<bigint>;
  reconcile?: Exclude<AdapterWorkerOptions['reconcile'], undefined>;
}

/** The worker of one ERP/WMS feed, registered as adapter `code`. */
export function erpWmsWorker(pool: pg.Pool, code: string, feed: ErpWmsFeed, openActor: () => Promise<ActorContext>, opts: ErpWmsOptions): AdapterWorker {
  // Slice 7a: mutual TLS when the adapter has its TLS files (./transport.ts).
  const fetchFn = opts.fetchFn ?? (opts.tls ? mtlsFetch(opts.tls) : undefined);
  const fetchOpts = { ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}), ...(fetchFn ? { fetchFn } : {}) };
  const outbound = feed === 'ERP' ? new OutboundDelivery(opts.endpoint, fetchOpts) : null;
  const def: AdapterDefinition = {
    code,
    system: 'ERP_WMS',
    contract: ERP_WMS,
    mirrorClasses: MIRROR_CLASSES[feed],
    receive,
    afterCycle: async (w) => {
      if (outbound) await outbound.deliver(w);
      else await answerMoveQuestions(w, opts.endpoint, fetchOpts);
    },
  };
  return new AdapterWorker(pool, def, httpFeedClient(opts.endpoint, fetchOpts), openActor, workerOptions(opts));
}
