/**
 * Feature `execution` (module C3; Phase 2 apps plan sections 7 and 9; Phase 3 slice 2b): on both installations the step
 * screen, the work queue, commands, the timeline, replay and lots, the ENGINE_COMMAND signable action and the time
 * sweeper; in the sandbox test packages, TEST- batches and the demo seed of test lots; in GMP the batch planned from an
 * effective MBR version and its issue under the issuer's ISSUED signature (gmp-issue.ts, signable action
 * GMP_BATCH_ISSUE). Which routes exist is the contract's (routes of the other installation are not bound: DI-05, INV-18);
 * what a batch runs and how its views are watermarked follow the installation (runs.ts, views.ts).
 *
 * Every write is one kernel command (withIdempotentActorCommand, the badge tap consumed on shared terminals,
 * INV-40): the batch is locked and the trusted time taken (INV-16), engine roles come from stored authority
 * evaluations (INV-26), the client intent is resolved into an engine command by the server (lots, readings,
 * containers), the pure engine decides, and recipe.append_execution re-checks and records the result, refusals
 * included (DI-34). A refused command answers 422 (409 when stale) after its refusal is committed; a stale command
 * uses none of the scale readings it names (F58.1). Any other failure rolls the whole command back, so nothing partial
 * is ever kept.
 */
import { correctionApprovalHandler } from '../review/signables.ts';
import { randomUUID } from 'node:crypto';
import { routes, type ClientIntent, type CommandResultView, type ProposedActView, type Refusal, type ReplayReportView, type RunSummaryView, type SsccView } from '@ebmr/api-contract';
import type { z } from 'zod';
import { sandbox, type commands } from '@ebmr/kernel';
import { containers, engine, execution } from '@ebmr/recipe-core';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type pg from 'pg';
import type { ActorContext } from '@ebmr/kernel';
import type { ResolvedSession } from '../../platform/auth/session.ts';
import type { AppContext } from '../../platform/context.ts';
import { dbNowUs, withIdempotentActorCommand } from '../../platform/db/commands.ts';
import { bindRoutes, type Handlers } from '../../platform/http/bind.ts';
import { HttpRefusal, refusal } from '../../platform/http/refusal.ts';
import type { SignableActionRegistry } from '../../platform/ports.ts';
import { floorActHandlers } from './floor-acts.ts';
import { gmpIssueHandler, planGmpBatch } from './gmp-issue.ts';
import { EXECUTION_GUIDANCE, engineRefusal } from './guidance.ts';
import { dataValueOf, resolveClientIntent, stepTarget } from './intents.ts';
import { additionSources } from './addition-sources.ts';
import { stepPlantView } from './step-plant.ts';
import { peopleText } from './people-text.ts';
import { lotView, resolveLot } from './lots.ts';
import { checkIssue, issueForm, packageToImport, packageView, packageViews } from './packages.ts';
import { displayPermissions, displayRoles, engineActor, engineRoles } from './roles.ts';
import { loadPackage, loadRowFacts, notFound, preloadRuns, runCache, runContext, defineForSandbox, type Db } from './runs.ts';
import { actApprovalHandler } from './act-approval.ts';
import { engineCommandHandler } from './signable.ts';
import { startSweeper } from './sweeper.ts';
import { runSummary, runView, stepScreen, timeline, workQueueItems, type ViewContext, type ViewerInfo } from './views.ts';


export const guidance = EXECUTION_GUIDANCE;
export { seed } from './seed.ts';

export function registerSignableActions(registry: SignableActionRegistry, app: AppContext): void {
  registry.register(engineCommandHandler(app));
  // Phase 4 slice 1a: the approval a CORRECT_ENTRY names, on both installations (test runs correct entries too).
  registry.register(correctionApprovalHandler(app));
  if (app.installation === 'GMP') {
    registry.register(gmpIssueHandler(app));
    registry.register(actApprovalHandler(app));
  }
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
    permissions: await displayPermissions(app, db, viewer?.roleCode ?? null),
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

/**
 * The scale readings a resolved command claimed (its evidence.readings). They stay used once the command commits,
 * accepted or refused by the engine (tab.reading_use is written in the command's transaction; DI-32). A command from a
 * stale screen claims none: it lists the readings it names as evidence.namedReadings (F58.1).
 */
function readingsClaimed(evidence: Record<string, unknown>): string[] {
  const readings = evidence['readings'];
  if (!Array.isArray(readings)) return [];
  return readings.flatMap((r: unknown) => {
    const id = r !== null && typeof r === 'object' ? (r as { readingId?: unknown }).readingId : undefined;
    return typeof id === 'string' ? [id] : [];
  });
}

/**
 * An engine refusal committed with the command: it names the scale readings the command used (details.readingsUsed,
 * comma-separated), so a form drops exactly those and keeps captures that a refusal given before the command, or
 * thrown while it was resolved, never used (Phase 2 exit review F59; DI-32, PR-19).
 */
function withReadingsUsed(refusal: Refusal, used: readonly string[]): Refusal {
  return used.length === 0 ? refusal : { ...refusal, details: { ...(refusal.details ?? {}), readingsUsed: used.join(',') } };
}

/** The replay report of a run (verify-replay of a test run or of a GMP batch). */
async function replayReport(app: AppContext, pool: Db, runId: string): Promise<z.infer<typeof ReplayReportView>> {
  const run = await runContext(pool, runId);
  const report = await execution.replayExecution(pool, run.def, runId);
  const d = report.firstDifference;
  return {
    runId,
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
}

interface CommandRequest {
  runId: string;
  body: { expectedVersion: number; intent: ClientIntent; viewStepKey?: string | undefined };
  request: FastifyRequest;
  session: ResolvedSession;
  actor: ActorContext & { deviceId: string };
  idempotencyKey: string | null;
  requestHash: string;
}

/** One plain client intent on a run (test run or GMP batch): resolved, decided by the engine, recorded (DI-34). */
async function runCommand(app: AppContext, pool: Db & pg.Pool, c: CommandRequest): Promise<z.infer<typeof CommandResultView>> {
  const { runId, body, request, session: s, actor: a, idempotencyKey, requestHash } = c;
  const run = await runContext(pool, runId);
  const out = await withIdempotentActorCommand(pool, a, idempotencyKey ?? '', requestHash, async (client) => {
    const tx = await execution.ExecutionTx.open(client, run.def, runId);
    // A request from a screen that shows another version of the run is refused by the engine's first check
    // (ENG-STALE) and recorded like any refusal (DI-34): what was entered, the version the screen showed, the
    // refusal. It uses none of the scale readings it names (they are named, with every check of a claim, and stay
    // usable for the resend from the reloaded screen: Phase 2 exit review F58, F58.1; DI-32). The run's lock is
    // held from here on, so the version the engine compares is this one.
    const useReadings = body.expectedVersion === tx.state.version;
    const roles = await engineRoles(client, runId);
    const resolved = await resolveClientIntent(
      { client, app, def: run.def, state: tx.state, room: s.roomCode, actor: engineActor(a.personId, roles), commandId: randomUUID(), expectedVersion: body.expectedVersion, useReadings },
      body.intent,
    );
    const r = await tx.command(resolved.command, roles, { ...resolved.evidence, ...(idempotencyKey ? { idempotencyKey } : {}) });
    runCache(app).set(runId, { def: run.def, state: tx.state });
    const refused = r.accepted ? null : engineRefusal(app.guidance, r.refusal ?? { code: 'ENG-REFUSED', message: 'Refused', controls: ['DI-34'] });
    // The engine's reason as people read it (T4): the step by number and name, the person by name; the row keeps
    // the engine's own text.
    const said = refused ? { ...refused.refusal, why: peopleText({ def: run.def, person: (id) => (id === a.personId ? s.legalName : null) }, refused.refusal.why) } : null;
    const work: CommandWork = refused && said ? { refused: { status: refused.status, refusal: withReadingsUsed(said, readingsClaimed(resolved.evidence)) } } : { accepted: { version: tx.state.version } };
    return work as unknown as commands.JsonValue;
  });
  const work = out.result as unknown as CommandWork;
  if ('refused' in work) throw new HttpRefusal(work.refused.status, work.refused.refusal, work.refused.status === 409);
  // Committed: the answer says so whatever happens next. A step view that cannot be built now is left to the
  // screen, which reads the step again (step: null); it is never answered as a failure, which would say that
  // nothing was saved of an entry that is in the record (DI-34).
  const key = body.viewStepKey ?? stepKeyOf(body.intent);
  try {
    const vc = await viewContextFor(app, pool, runId, s);
    return { accepted: true as const, version: vc.state.version, step: key !== undefined && vc.state.steps[key] ? await stepScreen(vc, key) : null };
  } catch (error) {
    request.log.warn({ err: error, correlationId: String(request.id), runId }, 'the command was committed; its step view could not be built and is left to the screen to read again');
    return { accepted: true as const, version: work.accepted.version, step: null };
  }
}

/** Run summaries of the installation's batches (the sandbox's test runs, or the GMP batches), newest first. */
async function runSummaries(app: AppContext, pool: Db, status?: string): Promise<z.infer<typeof RunSummaryView>[]> {
  const { rows } = await pool.query<{ id: string }>(
    `select b.id from recipe.batch_execution b join recipe.execution_state s on s.batch_id = b.id
      where ($1::text is null or s.status = $1) order by b.issued_at desc limit 200`,
    [status ?? null],
  );
  const out = [];
  for (const r of rows) {
    const run = await runContext(pool, r.id);
    const st = await execution.loadState(pool, r.id);
    if (st) out.push(runSummary({ app, run, state: st.state }));
  }
  return out;
}

/** The SSCC register of a GMP batch: each SSCC the database issued (tab.sscc_issue) and the shipper entry naming it. */
async function ssccRegister(app: AppContext, pool: pg.Pool, batchId: string): Promise<{ batchNumber: string; ssccs: SsccView[] }> {
  const stored = await execution.loadState(pool, batchId);
  if (!stored) throw notFound('batch');
  const shippers = new Map<string, { packs: string; part: boolean }>();
  for (const e of Object.values(stored.state.entries)) {
    const sscc = e.data['sscc'];
    if (e.kind === 'SHIPPER' && typeof sscc === 'string') shippers.set(sscc, { packs: typeof e.data['packs'] === 'string' ? e.data['packs'] : '', part: e.data['part'] === true });
  }
  const { rows } = await pool.query<{ sscc: string; step_key: string; us: string; person_id: string; legal_name: string | null; login_name: string | null }>(
    `select s.sscc, s.step_key, (extract(epoch from s.issued_at) * 1000000)::numeric(20, 0)::text as us, s.person_id,
            (select p.legal_name from iam.person p where p.id = s.person_id) as legal_name, (select a.login_name from iam.account a where a.id = s.account_id) as login_name
       from tab.sscc_issue s where s.batch_id = $1 order by s.issued_at, s.serial_ref`,
    [batchId],
  );
  return {
    batchNumber: stored.state.header.batchNumber,
    ssccs: rows.map((r) => ({
      sscc: r.sscc,
      stepKey: r.step_key,
      issuedAt: app.formatInstant(r.us),
      issuedBy: { personId: r.person_id, legalName: r.legal_name ?? 'unknown person', loginName: r.login_name ?? 'unknown', role: 'OPERATOR' },
      shipper: shippers.get(r.sscc) ?? null,
    })),
  };
}

/** The GMP batch family (D-S6-1): the test-run handlers by batch id, and the GMP batch's own reads and acts. */
function gmpBatchHandlers(app: AppContext): Handlers<typeof routes.batches> {
  const pool = app.pools.app;
  return {
    list: async ({ query, requireSession }) => {
      requireSession();
      return { batches: await runSummaries(app, pool, query.status) };
    },
    batch: async ({ params, requireSession }) => runView(await viewContextFor(app, pool, params.batchId, requireSession())),
    step: async ({ params, requireSession }) => stepScreen(await viewContextFor(app, pool, params.batchId, requireSession()), params.stepKey),
    // Phase 7 slice 7h (WP-A): what the step screen offers its plant acts from (step-plant.ts).
    stepPlant: async ({ params, requireSession }) => stepPlantView(app, pool, params.batchId, params.stepKey, requireSession().personId),
    workQueue: async ({ params, requireSession }) => {
      const s = requireSession();
      return { items: workQueueItems(await viewContextFor(app, pool, params.batchId, s), s.roomCode) };
    },
    timeline: async ({ params, requireSession }) => {
      requireSession();
      const run = await runContext(pool, params.batchId);
      return { entries: timeline(app, await loadRowFacts(pool, params.batchId), run.def) };
    },
    command: async ({ params, body, request, requireSession, actor, idempotencyKey, requestHash }) =>
      runCommand(app, pool, { runId: params.batchId, body, request, session: requireSession(), actor: actor(), idempotencyKey, requestHash }),
    verifyReplay: async ({ params, requireSession }) => {
      requireSession();
      return replayReport(app, pool, params.batchId);
    },
    proposeAct: async ({ params, body, requireSession, actor, idempotencyKey, requestHash }) => {
      const s = requireSession();
      const a = actor();
      const i = body.intent;
      const out = await withIdempotentActorCommand(pool, a, idempotencyKey ?? '', requestHash, async (client) => {
        const stored = await execution.loadState(client, params.batchId);
        if (!stored) throw notFound('batch');
        const t = stepTarget(stored.state, i.stepKey);
        const command: engine.Command = {
          type: 'VOID_ATTEMPT',
          commandId: randomUUID(),
          actor: engineActor(a.personId, []),
          step: t.step,
          context: t.context,
          item: i.item,
          reason: i.reason,
          ...(i.point !== undefined ? { point: i.point } : {}),
        };
        const { rows } = await client.query<{ r: { aggregate_id: string } }>('select recipe.propose_act($1, $2) as r', [params.batchId, JSON.stringify(engine.approvedAct(command))]);
        return { actId: rows[0]?.r.aggregate_id ?? '', at: (await dbNowUs(client)).toString() };
      });
      const view: ProposedActView = {
        actId: out.result.actId,
        batchId: params.batchId,
        commandType: 'VOID_ATTEMPT',
        meaning: 'VOID_AUTHORISED',
        aggregateType: 'batch_act',
        proposedBy: { personId: s.personId, legalName: s.legalName, loginName: s.loginName, role: s.roleCode ?? '' },
        proposedAt: app.formatInstant(out.result.at),
      };
      return view;
    },
    sscc: async ({ params, requireSession }) => {
      requireSession();
      const r = await ssccRegister(app, pool, params.batchId);
      return { batchId: params.batchId, batchNumber: r.batchNumber, ssccs: r.ssccs };
    },
    issueSscc: async ({ params, requireSession, actor, idempotencyKey, requestHash }) => {
      requireSession();
      const out = await withIdempotentActorCommand(pool, actor(), idempotencyKey ?? '', requestHash, async (client) => {
        const { rows } = await client.query<{ r: { sscc: string } }>('select tab.issue_sscc($1, $2) as r', [params.batchId, params.stepKey]);
        return rows[0]?.r.sscc ?? '';
      });
      const view = (await ssccRegister(app, pool, params.batchId)).ssccs.find((x) => x.sscc === out.result);
      if (!view) throw new Error('the issued SSCC was not found');
      return view;
    },
    // Exit review HIGH-3 (recipe-core 0701): the database decides (packaging order, release for packing, usable containers).
    issueBulk: async ({ params, body, requireSession, actor, idempotencyKey, requestHash }) => {
      requireSession();
      const out = await withIdempotentActorCommand(pool, actor(), idempotencyKey ?? '', requestHash, (client) =>
        containers.issuePackagingBulk(client, params.batchId, body.labels),
      );
      return out.result;
    },
    additionSources: async ({ params, requireSession }) => {
      requireSession();
      const run = await runContext(pool, params.batchId);
      const stored = await execution.loadState(pool, params.batchId);
      if (!stored) throw notFound('batch');
      const t = stepTarget(stored.state, params.stepKey);
      const block = run.def.steps.get(t.step)?.block;
      const key = block ? `${block.type}@${block.version}` : '';
      if (key !== 'TB-08@1' && key !== 'G-24@2') {
        throw refusal(422, { code: 'EBMR-API-NOT-ADDITION', kind: 'INVALID_INPUT', whatHappened: 'This step takes no addition.', why: `Step ${params.stepKey} is a ${key || 'step without a block'}, not TB-08 or G-24@2.`, controls: ['PR-47'], whatYouCanDo: ['Open the addition step of the batch.'] });
      }
      return { stepKey: params.stepKey, block: key, sources: await additionSources(app, pool, params.batchId, t.step, run.def.mbr.header.product) };
    },
  };
}

export async function plugin(scope: FastifyInstance, app: AppContext): Promise<void> {
  const pool = app.pools.app;
  await preloadRuns(app, pool).catch((e: unknown) => scope.log.warn({ err: e instanceof Error ? e.message : String(e) }, 'the run cache could not be preloaded'));
  const sweeper = startSweeper(app, scope.log);
  if (sweeper) scope.addHook('onClose', async () => sweeper.stop());

  // Phase 3 slice 6 (D-S6-1): the GMP batch family over the same handlers as the sandbox's test runs (the contract
  // binds each family on its own installation only; the other answers 404).
  bindRoutes(scope, app, routes.batches, gmpBatchHandlers(app));
  bindRoutes(scope, app, routes.execution, {
    testPackages: async ({ requireSession }) => {
      requireSession();
      return { packages: await packageViews(app) };
    },

    importPackage: async ({ params, requireSession, actor, idempotencyKey, requestHash }) => {
      requireSession();
      const pkg = await packageToImport(app, params.packageId);
      await withIdempotentActorCommand(pool, actor(), idempotencyKey ?? '', requestHash, async (client) => {
        // The name of the inbox file read, never one computed from the package: the database checks it against the
        // package hash (DI-05, DI-37), so a renamed file is refused there too (Phase 2 exit review F16).
        const r = await execution.importTestPackage(client, pkg, `${params.packageId}.json`);
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

    planBatch: async ({ body, requireSession, actor, idempotencyKey, requestHash }) => {
      requireSession();
      return planGmpBatch(app, actor(), idempotencyKey ?? '', requestHash, {
        familyId: body.familyId,
        markets: [...new Set(body.markets)],
        site: body.site,
        line: body.line,
        batchSize: body.batchSize,
        // Phase 7 slice 7g (WP4; PR-47): a whole-batch reprocessing batch with the quality unit's authorised request.
        ...(body.reprocessingRequest !== undefined ? { reprocessingRequest: body.reprocessingRequest } : {}),
      });
    },

    // Phase 7 slice 7g (WP4): packaging batch data, its check, the print job, the detector challenge (floor-acts.ts).
    ...floorActHandlers(app),

    runs: async ({ requireSession }) => {
      requireSession();
      return { runs: await runSummaries(app, pool) };
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
      const run = await runContext(pool, params.runId);
      return { entries: timeline(app, await loadRowFacts(pool, params.runId), run.def) };
    },

    verifyReplay: async ({ params, requireSession }) => {
      requireSession();
      return replayReport(app, pool, params.runId);
    },

    lot: async ({ params, requireSession }) => {
      requireSession();
      // GMP: a TEST- lot is named as one of the sandbox, never looked up (DI-05); the sandbox knows only TEST- lots.
      const problem = app.installation === 'GMP' ? sandbox.identifierProblem('GMP', 'LOT_NUMBER', params.code) : null;
      if (problem) {
        throw refusal(422, { code: problem.code, kind: 'NOT_ALLOWED', whatHappened: 'This lot cannot be used in a GMP batch.', why: problem.message, controls: ['DI-05'], whatYouCanDo: ['Scan the lot label of a material lot of this site; test lots (TEST-) belong to the sandbox only.'] });
      }
      const l = await resolveLot(pool, params.code);
      if (!l) throw notFound('lot');
      return lotView(l, (us) => app.formatInstant(us));
    },

    command: async ({ params, body, request, requireSession, actor, idempotencyKey, requestHash }) =>
      runCommand(app, pool, { runId: params.runId, body, request, session: requireSession(), actor: actor(), idempotencyKey, requestHash }),
  });
}
