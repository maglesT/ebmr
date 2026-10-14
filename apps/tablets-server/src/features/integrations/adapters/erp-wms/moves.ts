/**
 * The WMS asks before a move (PR-46 clause 2; site services 0911): the adapter fetches the open questions
 * (GET <endpoint>/move-requests -> {requests: [{requestId, lotNumber, toLocationKind}]}) and answers each
 * (POST <endpoint>/move-requests/<id>/answer {allowed, problem}) with site.location_move_problem of the lot at the
 * adapter's site. A lot the site does not hold, or a kind the rule does not know, is answered "not allowed". A move the
 * WMS made anyway arrives later as wms.stock_move and raises the alarm and the exception (D-P6a-7).
 */
import { exchange, type AdapterWorker, type FetchFn } from '../framework.ts';

interface MoveRequest {
  requestId: string;
  lotNumber: string;
  toLocationKind: string;
}

export async function answerMoveQuestions(worker: AdapterWorker, endpoint: string, opts: { timeoutMs?: number; fetchFn?: FetchFn } = {}): Promise<number> {
  const base = endpoint.replace(/\/$/, '');
  const fetchFn = opts.fetchFn ?? (globalThis.fetch as unknown as FetchFn);
  const timeoutMs = opts.timeoutMs ?? 2000;
  const r = await exchange(fetchFn, `${base}/move-requests`, timeoutMs);
  const requests = ((r.body as { requests?: MoveRequest[] } | null)?.requests ?? []).filter(
    (q) => typeof q.requestId === 'string' && /^[A-Za-z0-9-]{1,64}$/.test(q.requestId) && typeof q.lotNumber === 'string' && typeof q.toLocationKind === 'string',
  );
  let answered = 0;
  for (const q of requests) {
    const problem = await worker.command(async (c) => {
      const lot = await c.query<{ id: string }>('select l.id from site.material_lot l where l.site_code = site.actor_site() and l.lot_code = $1', [q.lotNumber]);
      const id = lot.rows[0]?.id;
      if (!id) return `the eBMR holds no lot ${q.lotNumber} at this site`;
      try {
        await c.query('savepoint q');
        const p = await c.query<{ p: string | null }>('select site.location_move_problem($1, $2) as p', [id, q.toLocationKind]);
        await c.query('release savepoint q');
        return p.rows[0]?.p ?? null;
      } catch (e) {
        await c.query('rollback to savepoint q');
        return e instanceof Error ? e.message : String(e);
      }
    });
    await exchange(fetchFn, `${base}/move-requests/${q.requestId}/answer`, timeoutMs, { method: 'POST', body: { allowed: problem === null, problem } });
    answered += 1;
  }
  return answered;
}
