/**
 * The WMS asks before a move (PR-46 clause 2; site services 0911): the adapter fetches the open questions
 * (GET <endpoint>/move-requests -> {requests: [{requestId, lotNumber, toLocationKind}]}) and answers each
 * (POST <endpoint>/move-requests/<id>/answer {allowed, problem}) with site.wms_location_question (site services 0915:
 * the location rule of the lot at the adapter's site; a lot the site does not hold, or a kind the rule does not know, is
 * answered "not allowed" with the reason). A move the
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
  const fetchFn = opts.fetchFn ?? (globalThis.fetch);
  const timeoutMs = opts.timeoutMs ?? 2000;
  const r = await exchange(fetchFn, `${base}/move-requests`, timeoutMs);
  const requests = ((r.body as { requests?: MoveRequest[] } | null)?.requests ?? []).filter(
    (q) => typeof q.requestId === 'string' && /^[A-Za-z0-9-]{1,64}$/.test(q.requestId) && typeof q.lotNumber === 'string' && typeof q.toLocationKind === 'string',
  );
  let answered = 0;
  for (const q of requests) {
    const problem = await worker.command(async (c) =>
      (await c.query<{ p: string | null }>('select site.wms_location_question($1, $2) as p', [q.lotNumber, q.toLocationKind])).rows[0]?.p ?? null);
    await exchange(fetchFn, `${base}/move-requests/${q.requestId}/answer`, timeoutMs, { method: 'POST', body: { allowed: problem === null, problem } });
    answered += 1;
  }
  return answered;
}
