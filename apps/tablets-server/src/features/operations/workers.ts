/**
 * The server's background workers on the operations and integration health screens (Phase 7 slice 7g-4; decision 0025
 * point 2; kernel 1376): each integration adapter's worker and the analytics runner, started, stopped or restarted by a
 * person with PLATFORM.OPERATE (the system administrator) and the reason, recorded in platform.operations_act (audited)
 * with its outcome. An adapter that may not start (EBMR-INT-034 on its transport, a STAND_IN system, no configuration)
 * is recorded REFUSED with why, and the screen shows the refusal; nothing starts.
 */
import type { WorkersView, WorkerView } from '@ebmr/api-contract';
import type { AppContext } from '../../platform/context.ts';
import { refusal } from '../../platform/http/refusal.ts';

export const ANALYTICS_WORKER = 'ANALYTICS';

export async function workerViews(app: AppContext): Promise<WorkerView[]> {
  const adapters = (await app.operations.adapters?.list()) ?? [];
  const out: WorkerView[] = adapters.map((a) => ({ kind: 'ADAPTER', code: a.code, sourceSystem: a.system, running: a.running, state: a.state, problem: a.problem }));
  const runner = app.operations.analytics;
  if (runner) {
    const running = runner.running();
    out.push({ kind: 'ANALYTICS', code: ANALYTICS_WORKER, sourceSystem: null, running, state: running ? 'RUNNING' : 'STOPPED', problem: null });
  }
  return out;
}

export async function workersView(app: AppContext): Promise<WorkersView> {
  const { rows } = await app.pools.app.query<{ act: string; target: string; outcome: 'DONE' | 'REFUSED'; detail: string | null; reason: string; by: string; us: string }>(
    `select o.act, o.target, o.outcome, o.detail, o.reason, coalesce(p.legal_name, '(unknown)') as by,
            (extract(epoch from o.recorded_at) * 1000000)::bigint::text as us
       from platform.operations_act o left join iam.person p on p.id = o.person_id
      order by o.recorded_at desc, o.id limit 20`,
  );
  return {
    workers: await workerViews(app),
    acts: rows.map((r) => ({ act: r.act, target: r.target, outcome: r.outcome, detail: r.detail, reason: r.reason, by: r.by, at: app.formatInstant(r.us) })),
  };
}

export const noSuchWorker = (code: string) =>
  refusal(404, {
    code: 'NO_SUCH_WORKER',
    kind: 'INVALID_INPUT',
    whatHappened: `This server runs no background worker ${code}.`,
    why: 'Workers are the integration adapters registered as ACTIVE (GMP) and the analytics runner (GMP with EBMR_ANALYTICS on).',
    controls: ['DI-31'],
    whatYouCanDo: ['Reload the list of workers.'],
  });

export const workerRefused = (code: string, why: string) =>
  refusal(409, {
    code: 'WORKER_REFUSED',
    kind: 'NOT_ALLOWED',
    whatHappened: `The worker ${code} was not started. The refusal is recorded.`,
    why,
    controls: ['DI-31'],
    whatYouCanDo: ['Read the reason; fix the configuration it names, then start the worker again.'],
    whoCanHelp: ['The system administrator (integrations)'],
  });

/**
 * Does `action` on worker `code` and says what happened: null when done, or why it was refused (an adapter that may
 * not start). Stop and the stop half of a restart always succeed.
 */
export async function controlWorker(app: AppContext, code: string, action: 'START' | 'STOP' | 'RESTART'): Promise<string | null> {
  if (code === ANALYTICS_WORKER) {
    const runner = app.operations.analytics;
    if (!runner) throw noSuchWorker(code);
    if (action !== 'START') await runner.stop();
    if (action !== 'STOP' && !(await runner.start())) {
      return 'the analytics runner did not start: its database connection is not the analytics role alone (DI-51; check EBMR_DB_ANALYTICS_URL)';
    }
    return null;
  }
  const adapters = app.operations.adapters;
  if (!adapters || !(await adapters.list()).some((a) => a.code === code)) throw noSuchWorker(code);
  if (action !== 'START') await adapters.stop(code);
  if (action !== 'STOP') return adapters.start(code);
  return null;
}

export async function workerView(app: AppContext, code: string): Promise<WorkerView> {
  const w = (await workerViews(app)).find((x) => x.code === code);
  if (!w) throw noSuchWorker(code);
  return w;
}
