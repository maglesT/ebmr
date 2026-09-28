/**
 * Document-first MBR designer, GMP only (module C2; Phase 2 apps plan section 8; brief apps/M3-C2-designer.md).
 *
 * Routes (namespace `designer`, frozen contract 1.0.0; the platform answers 404 for them on the sandbox):
 *  - templates, families, version, palette, reference documents: reads;
 *  - createFamily: a family and its DRAFT version from a template (PR-01 discrete batch sizes, IN locked);
 *  - saveContent: a new revision of a DRAFT (baseRevision, 409 when stale; PR-06 DRAFT only);
 *  - validate: validator + definition check with the real adapters, no writes (D10);
 *  - simulate: the saved content in a worker thread with a timeout, SIMULATION watermark, no writes (DI-04, DI-05);
 *  - justify: a recorded justification of a current warning;
 *  - startVerification: lifecycle.validateAndStartVerification (evidence bound to the content hash, DI-04);
 *  - testPackage: the write-once exchange file for a sandbox test run, recorded on the version's audit chain (D5).
 * Every write runs as one idempotent command under the session's actor; the database checks permissions
 * (MBR.AUTHOR in the product scope) and refuses administrators (DI-17, DI-18). A2 registers MBR_TRANSITION.
 */
import type { FastifyInstance } from 'fastify';
import { sandbox } from '@ebmr/kernel';
import { routes } from '@ebmr/api-contract';
import { lifecycle } from '@ebmr/recipe-core';
import { flow } from '@ebmr/recipe-core/pure';
import type { AppContext } from '../../platform/context.ts';
import { dbNowUs, withIdempotentActorCommand } from '../../platform/db/commands.ts';
import { bindRoutes } from '../../platform/http/bind.ts';
import { refusal, type HttpRefusal } from '../../platform/http/refusal.ts';
import { siteToday } from './adapters/expressions.ts';
import { contentFromTemplate, FamilyInputError } from './family.ts';
import { DESIGNER_GUIDANCE } from './guidance.ts';
import { buildTestPackage, discardStaged, publishPackage, stagePackage, type StagedPackage } from './package-export.ts';
import { paletteBlocks } from './palette.ts';
import { DEFAULT_SIMULATION_TIMEOUT_MS, simulateInWorker, simulationReportView } from './simulation.ts';
import { TEMPLATES, stepCount } from './templates/index.ts';
import type { TemplateView } from './wire.ts';
import { analyse, parseFailureView, reportView, type DesignerAnalysis } from './validation.ts';
import {
  familyViews,
  justificationsOf,
  justificationViews,
  latestContent,
  nowInstant,
  personRef,
  referenceDocumentViews,
  requireHead,
  versionLabel,
  versionView,
  warningJustifications,
} from './views.ts';

export { seed } from './seed.ts';
export const guidance = DESIGNER_GUIDANCE;

/** Test hook: the simulation timeout (ms). */
export const designerSettings = { simulationTimeoutMs: DEFAULT_SIMULATION_TIMEOUT_MS };

function stale(current: number, base: number): HttpRefusal {
  return refusal(
    409,
    {
      code: 'DESIGNER_STALE',
      kind: 'STALE',
      whatHappened: 'Someone saved this version after you opened it; your change was not saved.',
      why: `You edited revision ${base}; the saved revision is now ${current}.`,
      controls: ['PR-06', 'DI-04'],
      whatYouCanDo: ['Reload the version to see the latest revision, then make your change again. Your unsaved draft stays in this browser until you discard it.'],
      whoCanHelp: ['The MBR author who saved the newer revision'],
      details: { currentRevision: String(current), baseRevision: String(base) },
    },
    true,
  );
}

function notDraft(state: string, what: string): HttpRefusal {
  return refusal(422, {
    code: 'EBMR-RCP-021',
    kind: 'NOT_ALLOWED',
    whatHappened: `This version is ${state}: ${what} only in DRAFT.`,
    why: 'An MBR version under verification, approved or retired never changes (PR-06).',
    controls: ['PR-06'],
    whatYouCanDo: ['Open the DRAFT version of this family, or derive a new version from the approved one.'],
    whoCanHelp: ['The QA MBR approver'],
  });
}

function gateFailed(a: DesignerAnalysis, what: string): HttpRefusal {
  const first = a.findings.filter((f) => f.severity === 'ERROR').slice(0, 5).map((f) => f.message);
  return refusal(422, {
    code: 'DESIGNER_GATE_FAILED',
    kind: 'NOT_ALLOWED',
    whatHappened: `The version cannot ${what}: the checks did not pass (${a.gate.errors} errors, ${a.gate.unjustifiedWarnings} warnings without a justification).`,
    why: first.length > 0 ? first.join(' | ') : 'Every warning needs a recorded justification.',
    controls: ['PR-03', 'IN-02', 'DI-04'],
    whatYouCanDo: ['Open the findings panel, fix every error and justify every remaining warning, save, then try again.'],
    whoCanHelp: ['The MBR author responsible for the family'],
  });
}

function parseRefusal(problems: readonly flow.ParseProblem[]): HttpRefusal {
  return refusal(422, {
    code: 'EBMR-RCP-029',
    kind: 'INVALID_INPUT',
    whatHappened: 'The content is not a well-formed master batch record, so it was not saved.',
    why: problems
      .slice(0, 5)
      .map((p) => `${p.path}: ${p.message}`)
      .join('; '),
    controls: ['PR-03'],
    whatYouCanDo: ['Undo the last change, or reload the saved revision.'],
  });
}

async function uniqueViolationAsConflict<T>(work: () => Promise<T>, what: string): Promise<T> {
  try {
    return await work();
  } catch (error) {
    const pgCode = (error as { code?: string; cause?: { code?: string } }).code ?? (error as { cause?: { code?: string } }).cause?.code;
    if (pgCode === '23505') {
      throw refusal(409, {
        code: 'DESIGNER_FAMILY_EXISTS',
        kind: 'NOT_ALLOWED',
        whatHappened: `${what} already exists.`,
        why: 'One MBR family per family code, and per product, strength, dosage form and batch-size set, so there is never a twin master (INV-17).',
        controls: ['PR-01', 'PR-05'],
        whatYouCanDo: ['Open the existing family in the library, or choose another family code or batch-size set.'],
      });
    }
    throw error;
  }
}

function requireKey(ctx: { idempotencyKey: string | null }): string {
  if (!ctx.idempotencyKey) throw new Error('the platform admitted a mutating request without an idempotency key');
  return ctx.idempotencyKey;
}

export function plugin(scope: FastifyInstance, app: AppContext): Promise<void> {
  const pool = app.pools.app;
  const palette = paletteBlocks();

  const templateViews: TemplateView[] = [...TEMPLATES.values()].map((t) => ({
    templateId: t.templateId,
    title: t.title,
    description: t.description,
    product: { code: t.content.header.product.code, name: t.content.header.product.name, strength: t.content.header.product.strength },
    markets: [...t.content.header.marketSet],
    steps: stepCount(t.content),
  }));

  bindRoutes(scope, app, routes.designer, {
    templates: () => Promise.resolve({ templates: templateViews }),

    families: async () => ({ families: await familyViews(pool, app) }),

    async createFamily(ctx) {
      const { body } = ctx;
      const template = TEMPLATES.get(body.templateId);
      if (!template) {
        throw refusal(422, {
          code: 'DESIGNER_TEMPLATE_UNKNOWN',
          kind: 'INVALID_INPUT',
          whatHappened: 'There is no such template.',
          why: `Template ${body.templateId} is not offered on this installation.`,
          whatYouCanDo: ['Choose one of the listed templates.'],
        });
      }
      let content: flow.MbrContent;
      try {
        content = contentFromTemplate(template, { familyCode: body.familyCode, product: body.product, batchSizes: body.batchSizes, markets: body.markets });
      } catch (error) {
        if (!(error instanceof FamilyInputError)) throw error;
        throw refusal(422, {
          code: error.code,
          kind: 'INVALID_INPUT',
          whatHappened: 'The family was not created.',
          why: error.message,
          controls: error.controls,
          whatYouCanDo: ['Correct the entry and create the family again.'],
        });
      }
      const actor = ctx.actor();
      const { result } = await uniqueViolationAsConflict(
        () =>
          withIdempotentActorCommand(pool, actor, requireKey(ctx), ctx.requestHash, async (c) => {
            const familyId = await lifecycle.defineFamily(c, lifecycle.familyOf(content));
            const v = await lifecycle.createVersion(c, familyId, content, `Created from template ${template.templateId}`);
            return { versionId: v.versionId };
          }),
        `An MBR family ${body.familyCode} or one for the same product, strength and batch sizes`,
      );
      return versionView(pool, app, result.versionId);
    },

    version: (ctx) => versionView(pool, app, ctx.params.versionId),

    async saveContent(ctx) {
      const id = ctx.params.versionId;
      const head = await requireHead(pool, id);
      if (head.state !== 'DRAFT') throw notDraft(head.state, 'content changes');
      const parsed = flow.parseMbr(ctx.body.content);
      if (!parsed.ok) throw parseRefusal(parsed.problems);
      const current = await latestContent(pool, id);
      if (current.revision !== ctx.body.baseRevision) throw stale(current.revision, ctx.body.baseRevision);
      if (flow.mbrContentHash(parsed.mbr) === current.contentHash) {
        throw refusal(422, {
          code: 'DESIGNER_NO_CHANGE',
          kind: 'INVALID_INPUT',
          whatHappened: `Nothing changed since revision ${current.revision}, so no new revision was saved.`,
          why: 'A revision without a change would only void the evidence gathered on this content.',
          controls: ['DI-04'],
          whatYouCanDo: ['Make a change first.'],
        });
      }
      const base = ctx.body.baseRevision;
      await withIdempotentActorCommand(pool, ctx.actor(), requireKey(ctx), ctx.requestHash, async (c) => {
        const r = await lifecycle.saveContent(c, id, parsed.mbr, ctx.body.note);
        if (r.revision !== base + 1) throw stale(r.revision - 1, base);
        return { revision: r.revision, contentHash: r.contentHash };
      });
      return versionView(pool, app, id);
    },

    async validate(ctx) {
      const versionId = ctx.body.versionId;
      if (versionId) await requireHead(pool, versionId);
      const parsed = flow.parseMbr(ctx.body.content);
      if (!parsed.ok) return parseFailureView(pool, app, ctx.body.content, parsed.problems);
      const stored = versionId ? await justificationsOf(pool, versionId) : [];
      const a = await analyse(pool, parsed.mbr, warningJustifications(stored));
      return reportView(pool, app, a, await justificationViews(pool, app, stored));
    },

    async simulate(ctx) {
      const id = ctx.params.versionId;
      await requireHead(pool, id);
      const saved = await latestContent(pool, id);
      const parsed = flow.parseMbr(saved.content);
      if (!parsed.ok) throw parseRefusal(parsed.problems);
      const a = await analyse(pool, parsed.mbr, []);
      const outcome = await simulateInWorker(
        { content: saved.content, asOf: a.loaded.asOf, references: a.loaded.references, minimaRequest: a.loaded.minimaRequest, minima: a.loaded.minima },
        designerSettings.simulationTimeoutMs,
      );
      if (!outcome.ok) {
        const timeout = 'timeout' in outcome;
        if (!timeout) ctx.request.log.error({ versionId: id, problem: outcome.message }, 'designer simulation failed');
        throw refusal(422, {
          code: timeout ? 'SIMULATION_TIMEOUT' : 'SIMULATION_FAILED',
          kind: 'NOT_ENABLED',
          whatHappened: timeout ? 'The simulation took too long and was stopped. Nothing was recorded.' : 'The simulation could not run. Nothing was recorded.',
          why: outcome.message,
          controls: ['DI-04'],
          whatYouCanDo: timeout ? ['Lower the maximum loop iterations or replicate counts, then simulate again.'] : ['Fix the errors in the findings panel, save, then simulate again.'],
          whoCanHelp: ['The system administrator, if it happens again'],
        });
      }
      return simulationReportView(outcome.report, await nowInstant(pool, app));
    },

    async justify(ctx) {
      const id = ctx.params.versionId;
      const head = await requireHead(pool, id);
      if (head.state !== 'DRAFT') throw notDraft(head.state, 'warnings can be justified');
      const saved = await latestContent(pool, id);
      const parsed = flow.parseMbr(saved.content);
      if (!parsed.ok) throw parseRefusal(parsed.problems);
      const a = await analyse(pool, parsed.mbr, []);
      const f = a.findings.find((x) => x.key === ctx.body.findingKey);
      if (!f || f.severity !== 'WARNING') {
        throw refusal(422, {
          code: f ? 'DESIGNER_NOT_A_WARNING' : 'DESIGNER_NOT_A_FINDING',
          kind: 'INVALID_INPUT',
          whatHappened: f ? 'Only a warning can be justified; an error must be fixed.' : 'This finding is not reported for the saved content.',
          why: f ? `${ctx.body.findingKey} is an ${f.severity.toLowerCase()}.` : `The saved revision ${saved.revision} has no finding ${ctx.body.findingKey}; save your changes first.`,
          controls: ['PR-03', 'IN-02'],
          whatYouCanDo: f ? ['Fix the error in the document.'] : ['Save the version, validate again and justify the warnings it reports.'],
        });
      }
      await withIdempotentActorCommand(pool, ctx.actor(), requireKey(ctx), ctx.requestHash, async (c) => {
        const { rows } = await c.query<{ r: { id: string } }>('select tab.record_designer_justification($1, $2, $3) as r', [id, ctx.body.findingKey, ctx.body.text]);
        return { id: rows[0]?.r.id ?? null };
      });
      return versionView(pool, app, id);
    },

    async startVerification(ctx) {
      const id = ctx.params.versionId;
      const head = await requireHead(pool, id);
      if (head.state !== 'DRAFT') throw notDraft(head.state, 'verification can be started');
      const saved = await latestContent(pool, id);
      if (saved.revision !== ctx.body.baseRevision) throw stale(saved.revision, ctx.body.baseRevision);
      const parsed = flow.parseMbr(saved.content);
      if (!parsed.ok) throw parseRefusal(parsed.problems);
      const justs = warningJustifications(await justificationsOf(pool, id));
      const a = await analyse(pool, parsed.mbr, justs);
      // The execution definition must hold before the static evidence is recorded; the validator's own verdict is
      // stored as evidence either way (a failed attempt stays on record) and only a PASS moves the version.
      const justified = new Set(justs.map((j) => j.key));
      if (a.definition.some((f) => f.severity === 'ERROR' || (f.severity === 'WARNING' && !justified.has(f.key)))) throw gateFailed(a, 'enter verification');
      const port = lifecycle.createVerificationPort(a.loaded.context);
      const base = ctx.body.baseRevision;
      const { result } = await withIdempotentActorCommand(pool, ctx.actor(), requireKey(ctx), ctx.requestHash, async (c) => {
        const cur = await lifecycle.loadContent(c, id);
        if (cur.revision !== base) throw stale(cur.revision, base);
        const st = await lifecycle.versionState(c, id);
        if (!st) throw notDraft('unknown', 'verification can be started');
        const r = await lifecycle.validateAndStartVerification(c, id, st.version, port, justs);
        return { result: r.evidence.result, problems: r.evidence.problems, moved: r.transition !== undefined };
      });
      if (result.result !== 'PASS' || !result.moved) throw gateFailed(a, 'enter verification');
      return versionView(pool, app, id);
    },

    async testPackage(ctx) {
      const id = ctx.params.versionId;
      const head = await requireHead(pool, id);
      const saved = await latestContent(pool, id);
      const parsed = flow.parseMbr(saved.content);
      if (!parsed.ok) throw parseRefusal(parsed.problems);
      const stored = await justificationsOf(pool, id);
      const justs = warningJustifications(stored);
      const a = await analyse(pool, parsed.mbr, justs);
      if (!a.gate.passed) throw gateFailed(a, 'be sent to the sandbox');
      const actor = ctx.actor();
      let staged: StagedPackage | undefined;
      let published: { packageHash: string; fileName: string; stagedPath: string; finalPath: string };
      try {
        const { result } = await withIdempotentActorCommand(pool, actor, requireKey(ctx), ctx.requestHash, async (c) => {
          const cur = await latestContent(c, id);
          if (cur.contentHash !== saved.contentHash || cur.revision !== saved.revision) throw stale(cur.revision, saved.revision);
          const stamp = await sandbox.readInstallationStamp(c);
          sandbox.assertGmpOrigin(stamp, 'An MBR test package');
          const nowUs = await dbNowUs(c);
          const exporter = await personRef(c, actor.personId, actor.accountId, actor.roleCode);
          const pkg = buildTestPackage(
            {
              source: stamp,
              family: { familyId: head.familyId, familyCode: head.familyCode, product: head.product },
              version: { versionId: id, number: versionLabel(head.versionNumber), revision: saved.revision, state: head.state },
              content: parsed.mbr,
              justifications: justs,
              exporter: { personId: exporter.personId, legalName: exporter.legalName, loginName: exporter.loginName },
              exportedAtUs: nowUs.toString(),
            },
            saved.contentHash,
          );
          staged = await stagePackage(app.config.exchangeDir, pkg);
          await c.query('select tab.record_test_package_export($1, $2, $3, $4, $5, $6::bigint)', [id, saved.revision, saved.contentHash, pkg.packageHash, staged.fileName, nowUs.toString()]);
          return { packageHash: pkg.packageHash, fileName: staged.fileName, stagedPath: staged.stagedPath, finalPath: staged.finalPath };
        });
        published = result;
        await publishPackage(result);
      } catch (error) {
        await discardStaged(staged);
        throw error;
      }
      const base = app.config.otherInstallationUrl;
      return {
        packageId: published.packageHash,
        packageHash: published.packageHash,
        fileName: published.fileName,
        sandboxUrl: base ? `${base.replace(/\/$/, '')}/test-packages?package=${published.packageHash}` : '',
      };
    },

    palette: () => Promise.resolve({ blocks: palette }),

    referenceDocuments: async () => ({ documents: await referenceDocumentViews(pool, await siteToday(pool)) }),
  });
  return Promise.resolve();
}
