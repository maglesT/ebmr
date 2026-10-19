/**
 * Feature `validation` (Phase 7 slice 7g-3, work package WP1; GMP; decision 0025: every act has a screen): binds contract
 * namespace `validation` (ns/validation.ts). Every rule is the database's: each route runs the database function of the
 * act as the person's own command, and that function checks the right (CONFIG.SYSTEM_DESCRIPTION, VALIDATION.MANAGE,
 * RECORD.EXPORT, RECORD.TYPE_DEFINE, RECORD.LEGAL_HOLD; kernel 1300, 1335, 1336, 1381, 0400 to 0440). The signed acts
 * are the signable actions VALIDATION_SUMMARY_APPROVE, EVALUATION_PACK_APPROVE and RECORDS_ACT (signables.ts).
 *
 *  - The full export runs as a background job of this server process (the operations job runner of slice 7g-4,
 *    DemoJobs, unchanged): one at a time, as the person who started it, into a new folder of EBMR_EXPORT_DIR; the kernel
 *    registers it with its SHA-256 (records/full-export.ts buildFullExport).
 *  - The periodic evaluation pack is generated through the reporting role ebmr_report (EBMR_DB_REPORT_URL), one
 *    connection for the run (records/evaluation-pack.ts runPeriodicEvaluation).
 *  - The evidence bundle, the validation pack and the IQ: evidence.ts.
 */
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import pg from 'pg';
import { routes } from '@ebmr/api-contract';
import { commands, records as kernelRecords } from '@ebmr/kernel';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../../platform/context.ts';
import { withActorCommand } from '../../platform/db/commands.ts';
import { bindRoutes } from '../../platform/http/bind.ts';
import { refusal } from '../../platform/http/refusal.ts';
import type { SignableActionRegistry } from '../../platform/ports.ts';
import { DemoJobs } from '../operations/demo.ts';
import { evidenceFile, evidenceView, runIqHere, shippedEvidence, summaryDocument } from './evidence.ts';
import {
  evaluationPacks,
  evaluationPackView,
  fullExportManifest,
  fullExportViews,
  holdsInForce,
  investigations,
  iqRecord,
  iqRecords,
  recordTypes,
  retentionLookup,
  runningRelease,
  summaryState,
  systemDescription,
} from './reads.ts';
import { evaluationPackHandler, recordsActHandler, validationSummaryHandler } from './signables.ts';

export function registerSignableActions(registry: SignableActionRegistry, app: AppContext): void {
  if (app.installation !== 'GMP') return;
  registry.register(validationSummaryHandler(app));
  registry.register(evaluationPackHandler(app));
  registry.register(recordsActHandler(app));
}

const notFound = (what: string) =>
  refusal(404, { code: 'NOT_FOUND', kind: 'NOT_ALLOWED', whatHappened: `${what} was not found.`, why: 'It does not exist, or not on this installation.', controls: [], whatYouCanDo: ['Reload the list.'] });

const notConfigured = (why: string, controls: string[]) =>
  refusal(503, { code: 'VALIDATION_NOT_CONFIGURED', kind: 'NOT_ENABLED', whatHappened: 'Nothing was done: this server is not set up for it.', why, controls, whoCanHelp: ['The system administrator'] });

const exportBusy = () =>
  refusal(409, { code: 'EXPORT_RUNNING', kind: 'STALE', whatHappened: 'No export was started: a full export is already running.', why: 'One full export runs at a time.', controls: ['DI-08'], whatYouCanDo: ['Wait until it has ended, then start another.'] });

/** The export job's view (the runner's kind is the demo runner's own and is not shown). */
function jobView(jobs: DemoJobs) {
  const v = jobs.view();
  return { state: v.state, step: v.step, error: v.error, elapsedSeconds: v.elapsedSeconds };
}

export function plugin(scope: FastifyInstance, app: AppContext): Promise<void> {
  const pool = app.pools.app;
  const exportJobs = new DemoJobs();
  scope.addHook('onClose', async () => {
    await exportJobs.settled(120_000);
  });

  bindRoutes(scope, app, routes.validation, {
    systemDescription: async ({ requireSession }) => {
      requireSession();
      return systemDescription(app, pool);
    },
    describeInterface: async ({ body, actor }) => {
      const ctx = { ...actor({ reasonCode: 'SYSTEM_DESCRIPTION', reasonText: body.reason }), changeRecord: body.changeRecord };
      await withActorCommand(pool, ctx, (c) =>
        c.query('select platform.describe_interface($1::jsonb)', [
          JSON.stringify({ adapterCode: body.adapterCode, sourceSystem: body.sourceSystem, endpointHost: body.endpointHost, transport: body.transport, signedFeed: body.signedFeed, status: body.status }),
        ]),
      );
      return systemDescription(app, pool);
    },
    summary: async ({ requireSession }) => {
      requireSession();
      const state = await summaryState(app, pool);
      const doc = summaryDocument(app, state.runningRelease);
      return { ...state, document: doc.document, documentProblem: doc.problem };
    },
    evidence: async ({ requireSession }) => {
      requireSession();
      return evidenceView(app, await runningRelease(pool));
    },
    evidenceFile: async ({ query, requireSession }) => {
      requireSession();
      return Promise.resolve(evidenceFile(app, query.path));
    },
    iqRecords: async ({ requireSession }) => {
      requireSession();
      const { problem } = shippedEvidence(app);
      return { records: await iqRecords(app, pool), configured: problem === null, problem };
    },
    runIq: async ({ body, actor }) => {
      const ctx = actor({ reasonCode: 'IQ_RUN', reasonText: body.reason });
      // The right first (VALIDATION.MANAGE, never an administrator), before anything is read.
      await withActorCommand(pool, ctx, async (c) => {
        await c.query('select iam.assert_not_administrator()');
        await c.query("select iam.require_permission('VALIDATION.MANAGE', '{}'::jsonb)");
      });
      const { evidence, problem } = shippedEvidence(app);
      if (!evidence) throw notConfigured(problem ?? 'No evidence bundle.', ['DI-03']);
      const client = await pool.connect();
      let run: { text: string; sha256: string };
      try {
        run = await runIqHere(app, scope, client, evidence);
      } finally {
        client.release();
      }
      const id = await withActorCommand(pool, ctx, async (c) => (await c.query<{ id: string }>('select platform.record_iq($1, $2, $3)::text as id', [run.text, run.sha256, evidence.sha256])).rows[0]?.id ?? '');
      const stored = await iqRecord(app, pool, id);
      if (!stored) throw notFound(`IQ record ${id}`);
      return stored.view;
    },
    iqRecordFile: async ({ params, requireSession }) => {
      requireSession();
      const stored = await iqRecord(app, pool, params.iqId);
      if (!stored) throw notFound(`IQ record ${params.iqId}`);
      return { iqId: params.iqId, recordSha256: stored.view.recordSha256, content: stored.record };
    },
    fullExports: async ({ requireSession }) => {
      requireSession();
      await exportJobs.settled(0);
      return { exports: await fullExportViews(app, pool), job: jobView(exportJobs), folder: app.config.validation.exportDir };
    },
    startFullExport: async ({ body, actor }) => {
      const ctx = actor({ reasonCode: 'FULL_EXPORT', reasonText: body.reason });
      // RECORD.EXPORT first, asked of the database before the job starts (the export's own command asks again).
      await withActorCommand(pool, ctx, async (c) => {
        await c.query("select iam.require_permission('RECORD.EXPORT', '{}'::jsonb)");
      });
      if (exportJobs.running()) throw exportBusy();
      const dir = join(app.config.validation.exportDir, `full-export-${randomUUID()}`);
      const job = exportJobs.start('LOAD', async (step) => {
        step('exporting the closed records');
        const done = await kernelRecords.buildFullExport(pool, { ...ctx, correlationId: randomUUID() }, dir);
        step(`registered ${done.exportId}`);
      });
      return { job: { state: job.state, step: job.step, error: job.error, elapsedSeconds: job.elapsedSeconds } };
    },
    fullExportManifest: async ({ params, requireSession }) => {
      requireSession();
      const m = await fullExportManifest(pool, params.exportId);
      if (!m) throw notFound(`Full export ${params.exportId}`);
      return m;
    },
    evaluationPacks: async ({ requireSession }) => {
      requireSession();
      return { packs: await evaluationPacks(app, pool) };
    },
    runEvaluationPack: async ({ body, actor }) => {
      const url = app.config.validation.reportUrl;
      if (!url) throw notConfigured('No reporting connection is configured (EBMR_DB_REPORT_URL, the login of the read-only role ebmr_report): the pack is read through it.', ['DI-11']);
      const ctx = actor({ reasonCode: 'PERIODIC_EVALUATION', reasonText: `periodic evaluation pack ${body.from} to ${body.to}` });
      const report = new pg.Pool({ connectionString: url, max: 1 });
      let packId: string;
      try {
        const reader = { query: <T extends pg.QueryResultRow>(sql: string, params: unknown[] = []) => report.query<T>(sql, params) };
        packId = (await kernelRecords.runPeriodicEvaluation(reader, pool, ctx, { from: body.from, to: body.to, seed: body.seed, ...(body.sampleSize ? { sampleSize: Number.parseInt(body.sampleSize, 10) } : {}) })).packId;
      } catch (error) {
        throw commands.asKernelError(error);
      } finally {
        await report.end();
      }
      const v = await evaluationPackView(app, pool, packId);
      if (!v) throw notFound(`Evaluation pack ${packId}`);
      return v;
    },
    evaluationPackFile: async ({ params, requireSession }) => {
      requireSession();
      const p = await kernelRecords.evaluationPack(pool, params.packId);
      if (!p) throw notFound(`Evaluation pack ${params.packId}`);
      return { packId: p.id, packSha256: p.packSha256, content: p.text };
    },
    recordTypes: async ({ requireSession }) => {
      requireSession();
      return { recordTypes: await recordTypes(app, pool) };
    },
    defineRecordType: async ({ body, actor }) => {
      const ctx = actor({ reasonCode: 'RECORD_TYPE_DEFINE', reasonText: body.reason });
      const version = await withActorCommand(pool, ctx, async (c) => (await c.query<{ v: string }>('select records.define_record_type($1::jsonb)::text as v', [JSON.stringify(body.definition)])).rows[0]?.v ?? '');
      const [v] = await recordTypes(app, pool, { code: body.definition.code, version });
      if (!v) throw notFound(`Record type ${body.definition.code} version ${version}`);
      return v;
    },
    retention: async ({ query, requireSession }) => retentionLookup(pool, requireSession().tokenHash, query.aggregateType, query.aggregateId),
    legalHolds: async ({ requireSession }) => ({ holds: await holdsInForce(app, pool, requireSession().tokenHash) }),
    placeLegalHold: async ({ body, actor, requireSession }) => {
      const ctx = actor({ reasonCode: 'LEGAL_HOLD', reasonText: body.reason });
      const id = await withActorCommand(pool, ctx, (c) => kernelRecords.placeLegalHold(c, body.aggregateType, body.aggregateId, body.reason, body.reference));
      const [h] = await holdsInForce(app, pool, requireSession().tokenHash, id);
      if (!h) throw notFound(`Legal hold ${id}`);
      return h;
    },
    releaseLegalHold: async ({ params, body, actor, requireSession }) => {
      const ctx = actor({ reasonCode: 'LEGAL_HOLD_RELEASE', reasonText: body.reason });
      await withActorCommand(pool, ctx, (c) => kernelRecords.releaseLegalHold(c, params.holdId, body.reason));
      return { holds: await holdsInForce(app, pool, requireSession().tokenHash) };
    },
    diInvestigations: async ({ requireSession }) => ({ investigations: await investigations(app, pool, requireSession().tokenHash) }),
    openDiInvestigation: async ({ body, actor, requireSession }) => {
      const ctx = actor({ reasonCode: 'DI_INVESTIGATION', reasonText: body.concern });
      const id = await withActorCommand(pool, ctx, async (c) =>
        (await c.query<{ id: string }>('select records.open_di_investigation($1, $2::timestamptz, $3::timestamptz, $4, $5, $6)::text as id', [
          body.subjectPersonId, body.windowFrom, body.windowTo, body.concern, body.investigatorPersonId ?? null, body.qmsReference ?? null,
        ])).rows[0]?.id ?? '',
      );
      const [v] = await investigations(app, pool, requireSession().tokenHash, id);
      if (!v) throw notFound(`Investigation ${id}`);
      return v;
    },
    linkDiInvestigation: async ({ params, body, actor, requireSession }) => {
      const ctx = actor({ reasonCode: 'DI_INVESTIGATION_LINK', reasonText: body.note });
      await withActorCommand(pool, ctx, (c) => kernelRecords.linkDiInvestigation(c, params.investigationId, body.aggregateType, body.aggregateId, body.note));
      const [v] = await investigations(app, pool, requireSession().tokenHash, params.investigationId);
      if (!v) throw notFound(`Investigation ${params.investigationId}`);
      return v;
    },
    refreshDiInvestigationScope: async ({ params, actor, requireSession }) => {
      const ctx = actor({ reasonCode: 'DI_INVESTIGATION_SCOPE', reasonText: 'the investigation scope read again' });
      const n = await withActorCommand(pool, ctx, async (c) => (await c.query<{ n: string }>('select records.refresh_di_investigation_scope($1)::text as n', [params.investigationId])).rows[0]?.n ?? '0');
      const [v] = await investigations(app, pool, requireSession().tokenHash, params.investigationId);
      if (!v) throw notFound(`Investigation ${params.investigationId}`);
      return { linked: n, investigation: v };
    },
  });
  return Promise.resolve();
}
