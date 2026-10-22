/**
 * Feature `operations` (Phase 7 slice 7g-4; decision 0025 point 2: nobody types a command to use the system): the
 * first-run set-up, demo and test data, backups, the background workers and the simulators' test console, on both
 * installations (contract ns/operations.ts). Every rule is the database's: the set-up's token and its single use
 * (kernel 1375), PLATFORM.OPERATE and CONTINUITY.BACKUP_RUN/READ (kernel 1376), the refusal of the demo conveniences on
 * a GMP installation that is not a demo one (tablets 1485, asked before anything is done). See setup.ts, demo.ts,
 * backups.ts, workers.ts and simulators.ts.
 */
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { routes, type ContinuityAlarmView, type DemoView, type SimulatorsView } from '@ebmr/api-contract';
import type { FastifyInstance } from 'fastify';
import type { ActorContext } from '@ebmr/kernel';
import type { AppContext } from '../../platform/context.ts';
import type { SignableActionRegistry } from '../../platform/ports.ts';
import { withActorCommand, withIdempotentActorCommand } from '../../platform/db/commands.ts';
import { bindRoutes } from '../../platform/http/bind.ts';
import { refusal } from '../../platform/http/refusal.ts';
import { assertBackupRunnable, backupFile, backupsView, requestedRun, runRequestedBackup } from './backups.ts';
import { credentialCardView } from './credential-card.ts';
import { DemoJobs, recreateInstallation } from './demo.ts';
import { orderTemplates, postProductionOrder, prepareProductionOrder } from './erp-orders.ts';
import { assertDrillRunnable, DRILL_REASON, DrillJobs, drillsView, runHardeningCheck, startRestoreDrill, startUpgradeDrill } from './drills.ts';
import { OPERATIONS_GUIDANCE } from './guidance.ts';
import { completeRestore, recordRestoreEvent, RESTORE_REASON, restoreApproveHandler, restoreView, secureIdentifiers } from './restore.ts';
import { runSetup, setupState } from './setup.ts';
import { SimulatorManager, SimulatorRefusal } from './simulators.ts';
import { ANALYTICS_WORKER, controlWorker, workerRefused, workersView, workerView } from './workers.ts';

export const guidance = OPERATIONS_GUIDANCE;

/** Slice 7g work package 2: the second person's approval of a restore (RESTORE_APPROVE), on both installations. */
export function registerSignableActions(registry: SignableActionRegistry, app: AppContext): void {
  registry.register(restoreApproveHandler(app));
}

/** The roles that read the continuity alarms: those who acknowledge them or read the backups (kernel 0600, 1376). */
const ALARM_READERS = ['SYSTEM_ADMINISTRATOR', 'PROCESS_OWNER', 'QA_REVIEWER'] as const;

/** The continuity alarms, open first, newest first within each (the last 100), or the one alarm `alarmId`. */
async function alarmViews(app: AppContext, alarmId?: string): Promise<ContinuityAlarmView[]> {
  const { rows } = await app.pools.app.query<{ id: string; code: string; severity: ContinuityAlarmView['severity']; subject: string; details: unknown; us: string; ack: { by: string; comment: string; us: string } | null }>(
    `select a.id, a.alarm_code as code, a.severity, a.subject, a.details, (extract(epoch from a.recorded_at) * 1000000)::bigint::text as us,
            (select jsonb_build_object('by', coalesce(p.legal_name, '(unknown)'), 'comment', k.comment, 'us', (extract(epoch from k.recorded_at) * 1000000)::bigint::text)
               from continuity.alarm_acknowledgement k left join iam.person p on p.id = k.acknowledged_by_person_id where k.alarm_id = a.id) as ack
       from continuity.alarm a
      where $1::uuid is null or a.id = $1::uuid
      order by (exists (select 1 from continuity.alarm_acknowledgement k where k.alarm_id = a.id)), a.recorded_at desc, a.id limit 100`,
    [alarmId ?? null],
  );
  return rows.map((r) => ({
    alarmId: r.id, code: r.code, severity: r.severity, subject: r.subject, details: JSON.stringify(r.details ?? {}), raisedAt: app.formatInstant(r.us),
    acknowledgement: r.ack ? { by: r.ack.by, comment: r.ack.comment, at: app.formatInstant(r.ack.us) } : null,
  }));
}

/** The first-run set-up's rate limit per address (the token is long and single-use; this keeps guessing slow too). */
export const SETUP_RATE_LIMIT = { max: 10, timeWindow: '1 minute' } as const;

const DEMO_NAME = /(_demo$|_e2e_[a-z0-9]+$)/;

const demoNotPossible = (why: string) =>
  refusal(409, {
    code: 'DEMO_NOT_POSSIBLE',
    kind: 'NOT_ENABLED',
    whatHappened: 'Nothing was done.',
    why,
    controls: ['DI-05'],
    whoCanHelp: ['The system administrator'],
  });

const wrongConfirmation = (database: string) =>
  refusal(422, {
    code: 'CONFIRM_DATABASE',
    kind: 'INVALID_INPUT',
    whatHappened: 'Nothing was done: the database name typed to confirm does not match.',
    why: `Everything in ${database} is lost; type its name exactly to confirm.`,
    controls: ['DI-05'],
    whatYouCanDo: [`Type ${database} to confirm.`],
  });

const simulatorRefused = (why: string) =>
  refusal(409, {
    code: 'SIMULATOR_REFUSED',
    kind: 'NOT_ALLOWED',
    whatHappened: 'The simulator did not do it.',
    why,
    controls: ['DI-05'],
    whatYouCanDo: ['Read the reason; start the simulator, or pick a fault it knows.'],
  });

/** Why the demo conveniences do not run here, as the database says it (EBMR-OPS-010), or null. */
async function demoProblem(app: AppContext): Promise<string | null> {
  const { rows } = await app.pools.app.query<{ p: string | null }>('select tab.demo_conveniences_problem() as p');
  return rows[0]?.p ?? null;
}

async function demoView(app: AppContext, jobs: DemoJobs, tokenHash: string): Promise<DemoView> {
  const problem = await demoProblem(app);
  const lacks = app.config.adminUrl && app.operations.demoTooling ? null : 'This server has no administration connection (EBMR_PG_ADMIN_URL), so it cannot recreate its database.';
  const { rows } = await app.pools.app.query<{ c: DemoView['contents']; demo: boolean }>('select tab.installation_contents($1) as c, tab.is_demo_installation() as demo', [tokenHash]);
  const row = rows[0];
  return {
    allowed: problem === null && lacks === null,
    refusal: problem ?? lacks,
    installation: app.installation,
    demo: row?.demo === true,
    database: app.config.database,
    reviewBatchAllowed: app.installation === 'GMP' && DEMO_NAME.test(app.config.database),
    contents: row?.c ?? { persons: '0', accounts: '0', devices: '0', batches: '0', signatures: '0', auditEntries: '0' },
    job: jobs.view(),
  };
}

async function simulatorsView(app: AppContext, sims: SimulatorManager): Promise<SimulatorsView> {
  const problem = await demoProblem(app);
  return {
    allowed: problem === null,
    refusal: problem,
    simulators: problem === null ? await sims.list() : [],
    // R5 (slice 7k): the ERP simulator's production orders, on a demo GMP installation.
    ...(problem === null && app.installation === 'GMP' ? { orderTemplates: orderTemplates() } : {}),
  };
}

export function plugin(scope: FastifyInstance, app: AppContext): Promise<void> {
  const pool = app.pools.app;
  const jobs = new DemoJobs();
  const drillJobs = new DrillJobs();
  const sims = new SimulatorManager(join(app.config.exchangeDir, 'simulators'));
  scope.addHook('onClose', async () => {
    await sims.stopAll();
    await jobs.settled(120_000);
    await drillJobs.settled(120_000);
  });

  /** Records a demo convenience (tablets 1485: refused on GMP unless a demo installation, then PLATFORM.OPERATE). */
  /** True when the request was a resend of one already recorded (its effect is not done again). */
  const recordDemoAct = async (ctx: { actor: () => ActorContext; idempotencyKey: string | null; requestHash: string }, act: string, target: string, reason: string): Promise<boolean> => {
    const { replayed } = await withIdempotentActorCommand(pool, ctx.actor(), ctx.idempotencyKey ?? '', ctx.requestHash, async (c) => {
      await c.query('select tab.record_demo_act($1, $2, $3)', [act, target, reason]);
      return act;
    });
    return replayed;
  };

  const startJob = (kind: 'LOAD' | 'RESET', opts: { reviewBatch: boolean; packaging: boolean; setupToken?: string }, who: string, reason: string) => {
    if (jobs.running()) throw demoNotPossible('A demo load or reset is already running.');
    app.log.warn({ kind, database: app.config.database, by: who, reason }, 'OPERATIONS: the installation is recreated from the operations screen (demo data)');
    return jobs.start(kind, (step) => recreateInstallation(app, { kind, ...opts }, step));
  };

  const assertDemoPossible = async (confirm: string): Promise<void> => {
    // The database's refusal on a GMP installation first (EBMR-OPS-010): it says why whatever else is missing.
    const problem = await demoProblem(app);
    if (problem) throw refusal(403, { code: 'EBMR-OPS-010', kind: 'NOT_ALLOWED', whatHappened: 'This is refused on a GMP installation. Nothing was done.', why: problem.replace(/^EBMR-OPS-010\s*/, ''), controls: ['DI-05'], whoCanHelp: ['The system administrator'] });
    if (confirm !== app.config.database) throw wrongConfirmation(app.config.database);
    if (!app.config.adminUrl || !app.operations.demoTooling) throw demoNotPossible('This server has no administration connection (EBMR_PG_ADMIN_URL), so it cannot recreate its database.');
    if (jobs.running()) throw demoNotPossible('A demo load or reset is already running.');
  };

  /**
   * A drill request (continuity.request_drill: CONTINUITY.BACKUP_RUN; an upgrade drill refused on a GMP installation,
   * EBMR-OPS-041), then whether this server can run it: a refusal of either records nothing.
   */
  const requestDrillChecked = async (who: ActorContext, kind: 'RESTORE' | 'UPGRADE', reason: string, sourceDatabase: string | null): Promise<string> =>
    withActorCommand(pool, who, async (c) => {
      const { rows } = await c.query<{ id: string }>('select continuity.request_drill($1, $2, $3)::text as id', [kind, reason, sourceDatabase]);
      assertDrillRunnable(app, drillJobs, kind);
      return rows[0]?.id ?? '';
    });

  bindRoutes(
    scope,
    app,
    routes.operations,
    {
      setupState: () => setupState(app),
      setup: ({ body }) => runSetup(app, body),
      demo: async ({ requireSession }) => {
        const s = requireSession();
        return demoView(app, jobs, s.tokenHash);
      },
      demoLoad: async (ctx) => {
        const s = ctx.requireSession();
        await assertDemoPossible(ctx.body.confirmDatabase);
        if ((ctx.body.reviewBatch || ctx.body.packaging) && !(app.installation === 'GMP' && DEMO_NAME.test(app.config.database))) {
          throw demoNotPossible('The GMP review batch and packaging order are built on a GMP demo installation only.');
        }
        if (!app.config.keysDir) throw demoNotPossible('This server has no keys directory for the DEMO-ONLY keys (EBMR_KEYS_DIR or EBMR_DEMO_KEYS_FILE).');
        if (await recordDemoAct(ctx, 'DEMO_LOAD', app.config.database, ctx.body.reason)) return { job: jobs.view() };
        return { job: startJob('LOAD', { reviewBatch: ctx.body.reviewBatch, packaging: ctx.body.packaging }, s.loginName, ctx.body.reason) };
      },
      demoReset: async (ctx) => {
        const s = ctx.requireSession();
        await assertDemoPossible(ctx.body.confirmDatabase);
        if (await recordDemoAct(ctx, 'DEMO_RESET', app.config.database, ctx.body.reason)) throw demoNotPossible('This reset was already started (the request was sent twice); its set-up token was shown once.');
        // A one-time set-up token for the clean installation (stored as its SHA-256 once the database exists).
        const setupToken = randomBytes(32).toString('base64url');
        return { job: startJob('RESET', { reviewBatch: false, packaging: false, setupToken }, s.loginName, ctx.body.reason), setupToken };
      },
      demoJob: () => Promise.resolve(jobs.view()),
      backups: async ({ requireSession }) => backupsView(app, requireSession().tokenHash),
      runBackup: async ({ body, actor, idempotencyKey, requestHash }) => {
        const { result: requestId, replayed } = await withIdempotentActorCommand(pool, actor(), idempotencyKey ?? '', requestHash, async (c) => {
          const { rows } = await c.query<{ id: string }>('select continuity.request_backup($1, $2)::text as id', [body.reason, body.tier]);
          // Inside the request's transaction: a refused backup (not configured, retention grade) records no request.
          assertBackupRunnable(app, body.tier);
          return rows[0]?.id ?? '';
        });
        // A resend of the same request does not take a second backup: it answers the run of the first.
        const outcome = replayed ? await requestedRun(app, requestId) : await runRequestedBackup(app, requestId, body.tier);
        return { requestId, run: outcome.run, error: outcome.error };
      },
      backupFile: async ({ params, actor }) => {
        await withActorCommand(pool, actor(), (c) => c.query('select continuity.record_backup_download($1)', [params.backupId]));
        return backupFile(app, params.backupId);
      },
      workers: async ({ requireSession }) => {
        requireSession();
        return workersView(app);
      },
      controlWorker: async ({ params, body, actor, idempotencyKey, requestHash }) => {
        const kind = params.code === ANALYTICS_WORKER ? 'ANALYTICS' : 'ADAPTER';
        const act = `${kind}_${body.action}`;
        const { result: refused } = await withIdempotentActorCommand(pool, actor(), idempotencyKey ?? '', requestHash, async (c) => {
          // PLATFORM.OPERATE before anything is started or stopped (kernel 1376).
          await c.query("select iam.require_permission('PLATFORM.OPERATE', '{}'::jsonb)");
          const why = await controlWorker(app, params.code, body.action);
          await c.query('select platform.record_operations_act($1, $2, $3, $4, $5)', [act, params.code, body.reason, why === null ? 'DONE' : 'REFUSED', why]);
          return why;
        });
        if (refused !== null) throw workerRefused(params.code, refused);
        return workerView(app, params.code);
      },
      simulators: async ({ requireSession }) => {
        requireSession();
        return simulatorsView(app, sims);
      },
      controlSimulator: async (ctx) => {
        await recordDemoAct(ctx, ctx.body.action === 'START' ? 'SIMULATOR_START' : 'SIMULATOR_STOP', ctx.params.simulator, ctx.body.reason);
        try {
          return ctx.body.action === 'START' ? await sims.start(ctx.params.simulator) : await sims.stop(ctx.params.simulator);
        } catch (e) {
          if (e instanceof SimulatorRefusal) throw simulatorRefused(e.message);
          throw e;
        }
      },
      credentialCard: ({ requireSession }) => {
        requireSession();
        return Promise.resolve(credentialCardView(app));
      },
      sendProductionOrder: async (ctx) => {
        // On an installation that refuses demo conveniences the database's refusal (EBMR-OPS-010) comes first.
        if ((await demoProblem(app)) !== null) await recordDemoAct(ctx, 'ERP_ORDER_SENT', `${ctx.body.productCode}:${ctx.body.kind}`, ctx.body.reason);
        const prepared = prepareProductionOrder(app, ctx.body.productCode, ctx.body.kind, ctx.idempotencyKey);
        // A resend of a request already recorded (its idempotency key) answers the same order and posts nothing again.
        const replayed = await recordDemoAct(ctx, 'ERP_ORDER_SENT', `${ctx.body.productCode}:${ctx.body.kind}`, ctx.body.reason);
        return replayed ? prepared.view : postProductionOrder(app, prepared);
      },
      simulatorFault: async (ctx) => {
        await recordDemoAct(ctx, ctx.body.on ? 'SIMULATOR_FAULT_ON' : 'SIMULATOR_FAULT_OFF', `${ctx.params.simulator}:${ctx.body.fault}`, ctx.body.reason);
        try {
          return await sims.setFault(ctx.params.simulator, ctx.body.fault, ctx.body.on);
        } catch (e) {
          if (e instanceof SimulatorRefusal) throw simulatorRefused(e.message);
          throw e;
        }
      },
      alarms: async ({ requireRole }) => {
        requireRole(...ALARM_READERS);
        return { alarms: await alarmViews(app) };
      },
      acknowledgeAlarm: async ({ params, body, actor, idempotencyKey, requestHash }) => {
        await withIdempotentActorCommand(pool, actor({ reasonCode: 'ALARM_ACKNOWLEDGEMENT', reasonText: body.comment }), idempotencyKey ?? '', requestHash, async (c) => {
          await c.query('select continuity.acknowledge_alarm($1, $2)', [params.alarmId, body.comment]);
          return params.alarmId;
        });
        const [a] = await alarmViews(app, params.alarmId);
        if (!a) throw refusal(404, { code: 'EBMR-API-NOT-FOUND', kind: 'STALE', whatHappened: 'The alarm was not found.', why: `No alarm ${params.alarmId}.`, whatYouCanDo: ['Reload the alarms.'] });
        return a;
      },
      restore: async ({ requireSession }) => restoreView(app, requireSession().tokenHash),
      secureIdentifiers: async ({ body, actor, idempotencyKey, requestHash }) => ({
        moves: await secureIdentifiers(app, actor({ reasonCode: RESTORE_REASON, reasonText: body.reason }), { idempotencyKey, requestHash }),
      }),
      recordRestoreEvent: async ({ body, actor, requireSession, idempotencyKey, requestHash }) =>
        recordRestoreEvent(app, actor({ reasonCode: RESTORE_REASON, reasonText: body.reason }), requireSession().tokenHash, body, { idempotencyKey, requestHash }),
      completeRestore: async ({ params, body, actor, requireSession, idempotencyKey, requestHash }) =>
        completeRestore(app, actor({ reasonCode: RESTORE_REASON, reasonText: body.reason }), requireSession().tokenHash, params.restoreEventId, { idempotencyKey, requestHash }),
      drills: async ({ requireSession }) => drillsView(app, drillJobs, requireSession().tokenHash),
      runRestoreDrill: async ({ body, actor }) => {
        // The database's right first (a person without it is refused for that), then what the server lacks.
        const requestId = await requestDrillChecked(actor({ reasonCode: DRILL_REASON, reasonText: body.reason }), 'RESTORE', body.reason, null);
        return { requestId, job: startRestoreDrill(app, drillJobs, requestId) };
      },
      runUpgradeDrill: async ({ body, actor }) => {
        const requestId = await requestDrillChecked(actor({ reasonCode: DRILL_REASON, reasonText: body.reason }), 'UPGRADE', body.reason, body.sourceDatabase);
        return { requestId, job: startUpgradeDrill(app, drillJobs, requestId, body.sourceDatabase, body.fromRelease) };
      },
      runHardeningCheck: async ({ body, actor, requireSession }) => {
        // PLATFORM.OPERATE before anything runs (kernel 1376); the check's record needs it again.
        await withActorCommand(pool, actor(), (c) => c.query("select iam.require_permission('PLATFORM.OPERATE', '{}'::jsonb)"));
        return runHardeningCheck(app, actor({ reasonCode: 'HARDENING_CHECK', reasonText: body.reason }), requireSession().tokenHash, body.reason, body.allowedPorts);
      },
    },
    { rateLimits: { setup: SETUP_RATE_LIMIT } },
  );
  return Promise.resolve();
}
