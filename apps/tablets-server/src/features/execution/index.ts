/**
 * Feature `execution` (module C3; sandbox only; Phase 2 apps plan sections 7 and 9): test packages, TEST-
 * batches, the step screen, the work queue, commands, the timeline, replay and lots, plus the ENGINE_COMMAND
 * signable action, the time sweeper and the demo seed of test lots.
 *
 * Every write is one kernel command (withIdempotentActorCommand, the badge tap consumed on shared terminals,
 * INV-40): the batch is locked and the trusted time taken (INV-16), engine roles come from stored authority
 * evaluations (INV-26), the client intent is resolved into an engine command by the server (lots, readings,
 * containers), the pure engine decides, and recipe.append_execution re-checks and records the result, refusals
 * included (DI-34). A refused command answers 422 (409 when stale) after its refusal is committed; any other
 * failure rolls the whole command back, so nothing partial is ever kept.
 */
import { randomUUID } from 'node:crypto';
import { routes, type ClientIntent, type Refusal, type ReplayReportView } from '@ebmr/api-contract';
import type { z } from 'zod';
import type { commands } from '@ebmr/kernel';
import { execution, type engine } from '@ebmr/recipe-core';
import type { FastifyInstance } from 'fastify';
import type { ResolvedSession } from '../../platform/auth/session.ts';
import type { AppContext } from '../../platform/context.ts';
import { dbNowUs, withIdempotentActorCommand } from '../../platform/db/commands.ts';
import { bindRoutes } from '../../platform/http/bind.ts';
import { HttpRefusal } from '../../platform/http/refusal.ts';
import type { SignableActionRegistry } from '../../platform/ports.ts';
import { EXECUTION_GUIDANCE, engineRefusal } from './guidance.ts';
import { dataValueOf, resolveClientIntent } from './intents.ts';
import { lotView, resolveLot } from './lots.ts';
import { checkIssue, issueForm, packageToImport, packageView, packageViews } from './packages.ts';
import { displayRoles, engineActor, engineRoles } from './roles.ts';
import { loadPackage, loadRowFacts, notFound, preloadRuns, runCache, runContext, defineForSandbox, type Db } from './runs.ts';
import { engineCommandHandler } from './signable.ts';
import { startSweeper } from './sweeper.ts';
import { runSummary, runView, stepScreen, timeline, workQueueItems, type ViewContext, type ViewerInfo } from './views.ts';

export const guidance = EXECUTION_GUIDANCE;
export { seed } from './seed.ts';

export function registerSignableActions(registry: SignableActionRegistry, app: AppContext): void {
  registry.register(engineCommandHandler(app));
}

function viewerOf(s: ResolvedSession | null): ViewerInfo | null {
  return s ? { personId: s.personId, legalName: s.legalName, loginName: s.loginName, roleCode: s.roleCode, deviceClass: s.deviceClass, roomCode: s.roomCode } : null;
}

/** Everything a view of one run needs, read now (and the run cache refreshed). */
export async function viewContextFor(app: AppContext, db: Db, runId: string, s: ResolvedSession | null): Promise<ViewContext> {
  const run = await runContext(db, runId);
  const stored = await execution.loadState(db, runId);
  if (!stored) throw notFound('test run');
  runCache(app).set(runId, { def: run.def, state: stored.state });
  const viewer = viewerOf(s);
  return {
    app,
    db,
    run,
    state: stored.state,
    nowUs: await dbNowUs(db),
    rows: await loadRowFacts(db, runId),
    session: viewer,
    viewer: { id: viewer?.personId ?? 'VIEWER', kind: 'PERSON', roles: await displayRoles(app, db, viewer?.roleCode ?? null) },
  };
}

async function activeRunIds(db: Db): Promise<string[]> {
  const { rows } = await db.query<{ id: string }>(
    "select b.id from recipe.batch_execution b join recipe.execution_state s on s.batch_id = b.id where s.status in ('ISSUED', 'IN_PROGRESS', 'ON_HOLD') order by b.issued_at",
  );
  return rows.map((r) => r.id);
}

/** The step a plain intent acts on (for the response's step view). */
function stepKeyOf(intent: ClientIntent): string | undefined {
  return 'stepKey' in intent ? intent.stepKey : undefined;
}

type CommandWork = { refused: { status: number; refusal: Refusal } } | { accepted: { version: number } };

export async function plugin(scope: FastifyInstance, app: AppContext): Promise<void> {
  const pool = app.pools.app;
  await preloadRuns(app, pool).catch((e: unknown) => scope.log.warn({ err: e instanceof Error ? e.message : String(e) }, 'the run cache could not be preloaded'));
  const sweeper = startSweeper(app, scope.log);
  if (sweeper) scope.addHook('onClose', async () => sweeper.stop());

  bindRoutes(scope, app, routes.execution, {
    testPackages: async ({ requireSession }) => {
      requireSession();
      return { packages: await packageViews(app) };
    },

    importPackage: async ({ params, requireSession, actor, idempotencyKey, requestHash }) => {
      requireSession();
      const pkg = await packageToImport(app, params.packageId);
      await withIdempotentActorCommand(pool, actor(), idempotencyKey ?? '', requestHash, async (client) => {
        const r = await execution.importTestPackage(client, pkg, `${pkg.packageHash}.json`);
        return { packageHash: r.packageHash };
      });
      const imported = await loadPackage(pool, pkg.packageHash);
      if (!imported) throw notFound('test package');
      return packageView(app, null, imported);
    },

    issueForm: async ({ params, requireSession }) => {
      requireSession();
      const pkg = await loadPackage(pool, params.packageId);
      if (!pkg) throw notFound('imported test package');
      return issueForm(pkg, defineForSandbox(pkg.packageHash, pkg.content, pkg.justifications));
    },

    issue: async ({ body, requireSession, actor, idempotencyKey, requestHash }) => {
      const s = requireSession();
      const pkg = await loadPackage(pool, body.packageId);
      if (!pkg) throw notFound('imported test package');
      const def = defineForSandbox(pkg.packageHash, pkg.content, pkg.justifications);
      const a = actor();
      const inputs: Record<string, { value: engine.DataValue; source: string }> = {};
      for (const [id, v] of Object.entries(body.inputs)) {
        const declared = def.mbr.inputs.find((i) => i.id === id);
        inputs[id] = { value: dataValueOf(v), source: declared?.source === 'MASTER_DATA' ? `Master data, entered at issue by ${s.loginName}` : `Batch header, entered at issue by ${s.loginName}` };
      }
      const request = {
        batchSize: body.batchSize,
        marketSet: [...new Set(body.markets)],
        purpose: 'VALIDATION' as const,
        variants: { ...body.variants },
        inputs,
        issuedBy: engineActor(a.personId, []),
      };
      checkIssue(def, request, await dbNowUs(pool));
      const out = await withIdempotentActorCommand(pool, a, idempotencyKey ?? '', requestHash, async (client) => {
        const roles = await engineRoles(client);
        const batchId = randomUUID();
        const r = await execution.issueBatch(client, { def, batchId, packageHash: pkg.packageHash, request: { ...request, issuedBy: engineActor(a.personId, roles) }, evidence: { packageHash: pkg.packageHash } });
        return { runId: batchId, batchNumber: r.batchNumber };
      });
      return runView(await viewContextFor(app, pool, out.result.runId, s));
    },

    runs: async ({ requireSession }) => {
      requireSession();
      const { rows } = await pool.query<{ id: string }>('select id from recipe.batch_execution order by issued_at desc limit 200');
      const out = [];
      for (const r of rows) {
        const run = await runContext(pool, r.id);
        const st = await execution.loadState(pool, r.id);
        if (st) out.push(runSummary({ app, run, state: st.state }));
      }
      return { runs: out };
    },

    run: async ({ params, requireSession }) => runView(await viewContextFor(app, pool, params.runId, requireSession())),

    step: async ({ params, requireSession }) => stepScreen(await viewContextFor(app, pool, params.runId, requireSession()), params.stepKey),

    workQueue: async ({ requireSession }) => {
      const s = requireSession();
      const items = [];
      for (const id of await activeRunIds(pool)) items.push(...workQueueItems(await viewContextFor(app, pool, id, s), s.roomCode));
      return { items };
    },

    timeline: async ({ params, requireSession }) => {
      requireSession();
      await runContext(pool, params.runId);
      return { entries: timeline(app, await loadRowFacts(pool, params.runId)) };
    },

    verifyReplay: async ({ params, requireSession }) => {
      requireSession();
      const run = await runContext(pool, params.runId);
      const report = await execution.replayExecution(pool, run.def, params.runId);
      const d = report.firstDifference;
      const view: z.infer<typeof ReplayReportView> = {
        runId: params.runId,
        identical: report.identical,
        rows: report.rows,
        firstDifference: d
          ? { seq: d.seq.toString(), field: d.field, expected: d.expected, actual: d.actual }
          : report.contentProblems.length > 0
            ? { seq: String(report.rows), field: 'content', expected: 'the stored signable content is the content of the replayed state', actual: report.contentProblems.join('; ') }
            : null,
        invariantViolations: report.invariantViolations,
        checkedAt: app.formatInstant(await dbNowUs(pool)),
      };
      return view;
    },

    lot: async ({ params, requireSession }) => {
      requireSession();
      const l = await resolveLot(pool, params.code);
      if (!l) throw notFound('lot');
      return lotView(l, (us) => app.formatInstant(us));
    },

    command: async ({ params, body, requireSession, actor, idempotencyKey, requestHash }) => {
      const s = requireSession();
      const a = actor();
      const run = await runContext(pool, params.runId);
      const out = await withIdempotentActorCommand(pool, a, idempotencyKey ?? '', requestHash, async (client) => {
        const tx = await execution.ExecutionTx.open(client, run.def, params.runId);
        const roles = await engineRoles(client);
        const resolved = await resolveClientIntent(
          { client, app, def: run.def, state: tx.state, room: s.roomCode, actor: engineActor(a.personId, roles), commandId: randomUUID(), expectedVersion: body.expectedVersion },
          body.intent,
        );
        const r = await tx.command(resolved.command, roles, { ...resolved.evidence, ...(idempotencyKey ? { idempotencyKey } : {}) });
        runCache(app).set(params.runId, { def: run.def, state: tx.state });
        const work: CommandWork = r.accepted ? { accepted: { version: tx.state.version } } : { refused: engineRefusal(app.guidance, r.refusal ?? { code: 'ENG-REFUSED', message: 'Refused', controls: ['DI-34'] }) };
        return work as unknown as commands.JsonValue;
      });
      const work = out.result as unknown as CommandWork;
      if ('refused' in work) throw new HttpRefusal(work.refused.status, work.refused.refusal, work.refused.status === 409);
      const vc = await viewContextFor(app, pool, params.runId, s);
      const key = body.viewStepKey ?? stepKeyOf(body.intent);
      return { accepted: true as const, version: vc.state.version, step: key !== undefined && vc.state.steps[key] ? await stepScreen(vc, key) : null };
    },
  });
}
