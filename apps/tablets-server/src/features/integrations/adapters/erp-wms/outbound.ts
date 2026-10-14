/**
 * Delivery of the ERP/WMS outbound queue (site services 0912) to the ERP (Phase 6 slice 6a, builder A; DI-31): the
 * adapter reads the pending messages (site.erp_outbound_pending), posts each to the ERP (POST <endpoint>/outbound
 * {messageId, topic, payload} -> {erpReference}; the ERP de-duplicates by messageId), and records the acknowledgment
 * (site.erp_outbound_delivered) or the failed attempt (site.erp_outbound_failed: the first raises a TRANSPORT alarm).
 * A failed message waits retryDelayMs(attempts) and is retried for ever; the messages of a lot keep their order (a later
 * message of a lot is not sent while an earlier one waits). Replaces the stub consumer of Phase 4 (0880) where an ERP
 * is connected.
 */
import { retryDelayMs } from '@ebmr/integration-sdk/adapter';
import { exchange, type AdapterWorker, type FetchFn } from '../framework.ts';

interface Pending {
  messageId: string;
  topic: string;
  lotId: string;
  payload: Record<string, unknown>;
  attempts: string;
}

export class OutboundDelivery {
  private readonly base: string;
  private readonly fetchFn: FetchFn;
  private readonly timeoutMs: number;
  /** When each failed message may be sent again (the worker's monotonic clock; not GMP data). */
  private readonly due = new Map<string, number>();

  constructor(endpoint: string, opts: { timeoutMs?: number; fetchFn?: FetchFn } = {}) {
    this.base = endpoint.replace(/\/$/, '');
    this.fetchFn = opts.fetchFn ?? (globalThis.fetch);
    this.timeoutMs = opts.timeoutMs ?? 2000;
  }

  /** One pass over the pending messages; returns how many the ERP acknowledged. */
  async deliver(worker: AdapterWorker, limit = 100): Promise<number> {
    const pending = await worker.command(async (c) => (await c.query<{ r: Pending[] }>('select site.erp_outbound_pending($1) as r', [limit])).rows[0]?.r ?? []);
    const heldLots = new Set<string>();
    let delivered = 0;
    for (const m of pending) {
      if (heldLots.has(m.lotId)) continue;
      const dueAt = this.due.get(m.messageId);
      if (dueAt !== undefined && performance.now() < dueAt) {
        heldLots.add(m.lotId);
        continue;
      }
      let reference: string | null = null;
      let error = '';
      try {
        const r = await exchange(this.fetchFn, `${this.base}/outbound`, this.timeoutMs, { method: 'POST', body: { messageId: m.messageId, topic: m.topic, payload: m.payload } });
        const ref = (r.body as { erpReference?: unknown } | null)?.erpReference;
        if (r.status === 200 && typeof ref === 'string' && /^[!-~]{1,128}$/.test(ref)) reference = ref;
        else error = `the ERP answered ${r.status.toString()} without a reference`;
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
      }
      if (reference) {
        await worker.command((c) => c.query('select site.erp_outbound_delivered($1, $2)', [m.messageId, reference]));
        this.due.delete(m.messageId);
        delivered += 1;
      } else {
        const attempt = await worker.command(async (c) => (await c.query<{ n: number }>('select site.erp_outbound_failed($1, $2) as n', [m.messageId, error])).rows[0]?.n ?? 1);
        this.due.set(m.messageId, performance.now() + retryDelayMs(Math.max(1, attempt)));
        heldLots.add(m.lotId);
      }
    }
    return delivered;
  }

  /** Makes every waiting message due now (tests and the console's "retry now"). */
  retryNow(): void {
    this.due.clear();
  }
}
