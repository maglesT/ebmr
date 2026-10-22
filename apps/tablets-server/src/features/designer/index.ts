/**
 * Document-first MBR designer, GMP only (module C2; Phase 2 apps plan section 8; brief apps/M3-C2-designer.md).
 *
 * Routes (namespace `designer`, frozen contract 1.0.0; the platform answers 404 for them on the sandbox):
 *  - templates, families, version, palette, reference documents: reads;
 *  - createFamily: a family and its DRAFT version from a template (PR-01 discrete batch sizes, IN locked);
 *  - saveContent: a new revision of a DRAFT (baseRevision, 409 when stale; PR-06 DRAFT only);
 *  - validate: validator + definition check with the real adapters, no writes (D10); a bounded number at once per
 *    process and a rate per session (review P18);
 *  - simulate: the saved content in a worker thread with a timeout, SIMULATION watermark, no writes (DI-04, DI-05);
 *    MBR roles only, a bounded number at once per process and a rate per session (review P18);
 *  - justify: a recorded justification of a warning of the saved revision the author was shown (baseRevision and
 *    contentHash, 409 when stale), bound to that content (IN-02, DI-04);
 *  - startVerification: lifecycle.validateAndStartVerification (evidence bound to the content hash, DI-04);
 *  - testPackage: the write-once exchange file for a sandbox test run, recorded on the version's audit chain (D5);
 *    recorded only once the inbox proved it takes the file and no earlier recorded export is left unpublished (one
 *    export at a time passes that gate), and a recorded export always gets its file (published after the commit; a
 *    resend, the next export or a restart completes it; review P14, P65). A file is published, or counted as
 *    published, only when it holds exactly the recorded package.
 * justify, startVerification and testPackage analyse the saved content first: they are for the MBR author only (the
 * database requires MBR.AUTHOR for each), take one of the validation slots and have a rate per session, all before
 * any analysis runs (review P18).
 * Every write runs as one idempotent command under the session's actor; the database checks permissions
 * (MBR.AUTHOR in the product scope) and refuses administrators (DI-17, DI-18). MBR_TRANSITION is registered in
 * signables.ts (Phase 3 slice 6d).
 */
import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import { sandbox } from '@ebmr/kernel';
import { routes, type VersionView } from '@ebmr/api-contract';
import { formula, lifecycle } from '@ebmr/recipe-core';
import { flow, simulator } from '@ebmr/recipe-core/pure';
import type { AppContext } from '../../platform/context.ts';
import { dbNowUs, withIdempotentActorCommand } from '../../platform/db/commands.ts';
import { bindRoutes, type HandlerContext } from '../../platform/http/bind.ts';
import { refusal, type HttpRefusal } from '../../platform/http/refusal.ts';
import { siteToday } from './adapters/expressions.ts';
import { marketSetProblem } from './adapters/market-minima.ts';
import { contentFromTemplate, FamilyInputError, KNOWN_MARKETS } from './family.ts';
import { compositionGate, withFormulaBom } from './formula-choice.ts';
import { DESIGNER_GUIDANCE } from './guidance.ts';
import { hazardContext, NoContainedAreaError, withContainment } from './hazard.ts';
import { slotPool } from './limits.ts';
import { masterRecordHandlers } from './master-records.ts';

export { registerSignableActions } from './signables.ts';
import {
  buildTestPackage,
  discardStaged,
  exportIsRecorded,
  InboxUnavailableError,
  proveInboxLinkable,
  publishPackage,
  publishRecordedStaged,
  stagePackage,
  surelyRolledBack,
  type Reconciliation,
  type RecordedExport,
  type StagedPackage,
} from './package-export.ts';
import { paletteBlocks } from './palette.ts';
import { targetsOf } from '../master-data/index.ts';
import { contentFromFormula } from './from-formula.ts';
import { materialMasters } from './material-refs.ts';
import { acquireSimulationSlot, DEFAULT_MAX_CONCURRENT_SIMULATIONS, DEFAULT_SIMULATION_TIMEOUT_MS, simulateInWorker, simulationReportView } from './simulation.ts';
import { TEMPLATES, stepCount } from './templates/index.ts';
import type { TemplateView } from './wire.ts';
import { analyse, parseFailureView, reportView, type DesignerAnalysis } from './validation.ts';
import {
  familyViews,
  justificationsInForceOf,
  justificationViews,
  latestContent,
  nowInstant,
  personRef,
  referenceDocumentViews,
  requireHead,
  versionLabel,
  versionView,
  warningJustifications,
  type SavedContent,
  type StoredJustification,
} from './views.ts';

export { seed } from './seed.ts';
export const guidance = DESIGNER_GUIDANCE;

/**
 * How many validations of MBR content one server process runs at once (review P18): each parses the posted content
 * (up to the 2 MB body limit), loads the references and minima and runs the validator and the definition check.
 */
export const DEFAULT_MAX_CONCURRENT_VALIDATIONS = 8;

/** Test hooks: the simulation timeout (ms) and how many simulations and validations the process runs at once. */
export const designerSettings = {
  simulationTimeoutMs: DEFAULT_SIMULATION_TIMEOUT_MS,
  maxConcurrentSimulations: DEFAULT_MAX_CONCURRENT_SIMULATIONS,
  maxConcurrentValidations: DEFAULT_MAX_CONCURRENT_VALIDATIONS,
};

/** Who may simulate: the MBR roles (author, independent checker, QA MBR approver); simulating writes nothing. */
export const SIMULATION_ROLES = ['MBR_AUTHOR', 'MBR_CHECKER', 'QA_MBR_APPROVER'] as const;
/**
 * Who may justify, start verification and export a test package: the MBR author, the only role holding MBR.AUTHOR,
 * which the database requires for each of them. Checked before the saved content is analysed (review P18).
 */
export const AUTHOR_ROLES = ['MBR_AUTHOR'] as const;
/** Simulations one session may start per minute (review P18). */
export const SIMULATION_RATE_LIMIT = { max: 20, timeWindow: '1 minute', by: 'SESSION' } as const;
/**
 * Validations one session may ask for per minute (review P18). The editor validates 600 ms after the last change,
 * so one editing session asks for at most 100 a minute.
 */
export const VALIDATION_RATE_LIMIT = { max: 120, timeWindow: '1 minute', by: 'SESSION' } as const;
/**
 * Justifications, starts of verification and test-package exports one session may ask for per minute, each (review
 * P18): each analyses the saved content first. An author records them one at a time, from a dialog.
 */
export const DESIGNER_COMMAND_RATE_LIMIT = { max: 30, timeWindow: '1 minute', by: 'SESSION' } as const;

const acquireValidationSlot = slotPool();

/** The transaction advisory lock that lets one test-package export at a time through the inbox gate (review P14). */
const TEST_PACKAGE_INBOX_LOCK = 'tab.mbr_test_package_export:inbox';

/** What waited for a slot: a simulation, a validation of edited content, or a command that checks the saved content. */
type BusyWork = 'simulation' | 'validation' | 'command';

function busy(what: BusyWork, max: number): HttpRefusal {
  const simulation = what === 'simulation';
  const kind = simulation ? 'simulation' : 'validation';
  return refusal(
    503,
    {
      code: simulation ? 'SIMULATION_BUSY' : 'VALIDATION_BUSY',
      kind: 'NOT_ENABLED',
      whatHappened:
        what === 'command'
          ? 'The version was not checked, and nothing was recorded: the server is already running as many validations as it runs at once.'
          : `The ${kind} was not started: the server is already running as many ${kind}s as it runs at once. Nothing was recorded.`,
      why: `At most ${max} ${kind}s run at the same time, so that they never slow down the GMP work of other people.`,
      controls: ['DI-05'],
      whatYouCanDo: [
        simulation ? 'Wait a moment and simulate again.' : what === 'validation' ? 'Wait a moment; the next change you make is checked again.' : 'Wait a moment and send it again from the same dialog.',
      ],
      whoCanHelp: ['The system administrator, if it keeps happening'],
    },
    true,
  );
}

/**
 * Runs `work` (an analysis of MBR content on the main thread) in one of the process's validation slots (review P18):
 * when all designerSettings.maxConcurrentValidations are taken, 503 VALIDATION_BUSY and nothing is started.
 */
async function inValidationSlot<T>(what: Exclude<BusyWork, 'simulation'>, work: () => Promise<T>): Promise<T> {
  const max = designerSettings.maxConcurrentValidations;
  const release = acquireValidationSlot(max);
  if (!release) throw busy(what, max);
  try {
    return await work();
  } finally {
    release();
  }
}

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

/** A justification written for a revision that is no longer the saved one (IN-02, DI-04). */
function staleJustification(current: number, base: number): HttpRefusal {
  return refusal(
    409,
    {
      code: 'DESIGNER_STALE',
      kind: 'STALE',
      whatHappened: 'The justification was not recorded: the version was saved again after you saw this warning.',
      why:
        current === base
          ? `You justified a warning of revision ${base}, but the content hash you named is not that of the saved revision ${current}; a justification answers only the warning of the content it was written for.`
          : `You justified a warning of revision ${base}; the saved revision is now ${current}, and a justification answers only the warning of the content it was written for.`,
      controls: ['IN-02', 'DI-04'],
      whatYouCanDo: ['Reload the version, check its findings again and justify the warnings the saved revision reports.'],
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

/** The export is recorded (committed) but its file is not in the sandbox inbox yet: never "nothing was saved". */
function notPublished(packageHash: string, error: unknown): HttpRefusal {
  return refusal(
    503,
    {
      code: 'TEST_PACKAGE_NOT_PUBLISHED',
      kind: 'NOT_ENABLED',
      whatHappened: `The export of test package ${packageHash.slice(0, 12)} is recorded on the version's audit trail, but its file could not be placed in the sandbox inbox yet.`,
      why: error instanceof Error ? error.message : String(error),
      controls: ['DI-05', 'DI-04'],
      whatYouCanDo: [
        'Send it again from the same dialog: the same package is placed in the inbox and no second export is recorded.',
        'No other test package is exported on this installation until this one is in the inbox; it is also placed there when the server restarts. If it keeps failing, ask the system administrator (operations guide: test-package exchange).',
      ],
      whoCanHelp: ['The system administrator'],
      details: { packageHash },
    },
    true,
  );
}

/** The inbox does not take the hard link that publishes a package: nothing is recorded (review P14). */
function inboxUnavailable(error: unknown): HttpRefusal {
  return refusal(
    503,
    {
      code: 'TEST_PACKAGE_INBOX_UNAVAILABLE',
      kind: 'NOT_SAVED',
      whatHappened: 'The test package was not exported: the sandbox inbox cannot take the package file. Nothing was recorded.',
      why: error instanceof Error ? error.message : String(error),
      controls: ['DI-05', 'DI-04'],
      whatYouCanDo: ['Ask the system administrator to check the exchange directory (it must allow hard links and writes), then send the version again.'],
      whoCanHelp: ['The system administrator'],
    },
    true,
  );
}

/** An earlier recorded export has not reached the inbox and cannot be placed there now: nothing new is recorded. */
function inboxBehind(problems: readonly string[]): HttpRefusal {
  return refusal(
    503,
    {
      code: 'TEST_PACKAGE_INBOX_BEHIND',
      kind: 'NOT_SAVED',
      whatHappened: 'The test package was not exported: an earlier recorded export has not reached the sandbox inbox yet and could not be placed there now. Nothing was recorded.',
      why: problems.slice(0, 3).join(' | '),
      controls: ['DI-05', 'DI-04'],
      whatYouCanDo: [
        'If the exchange directory had only a passing fault, try again in a moment: the earlier package is placed in the inbox first.',
        'If it keeps failing, no test package can be exported until the system administrator has resolved the earlier one, as the operations guide (test-package exchange) describes.',
      ],
      whoCanHelp: ['The system administrator'],
    },
    true,
  );
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

/**
 * The analysis of a version's saved content with the justifications in force for exactly that content (IN-02,
 * DI-04), and the ones that answer a warning the analysis reports: only those go into evidence and packages.
 */
/**
 * The designer's simulation of `content` for the verification evidence (slice 7h, decision D-P7R-16): in its worker, in
 * one of the process's simulation slots and with its timeout, as the Simulation tab runs it. A simulation that cannot
 * run refuses the start of the verification; nothing is recorded.
 */
async function simulateForEvidence(a: DesignerAnalysis, content: unknown): Promise<simulator.SimulationReport> {
  const max = designerSettings.maxConcurrentSimulations;
  const release = acquireSimulationSlot(max);
  if (!release) throw busy('simulation', max);
  try {
    const outcome = await simulateInWorker(
      { content, asOf: a.loaded.asOf, references: a.loaded.references, minimaRequest: a.loaded.minimaRequest, minima: a.loaded.minima, engineRoles: a.loaded.engineRoles, checkers: a.loaded.checkers },
      designerSettings.simulationTimeoutMs,
    );
    if (outcome.ok) return outcome.report;
    const timeout = 'timeout' in outcome;
    throw refusal(422, {
      code: timeout ? 'SIMULATION_TIMEOUT' : 'SIMULATION_FAILED',
      kind: 'NOT_ENABLED',
      whatHappened: `The simulation for the verification evidence ${timeout ? 'took too long and was stopped' : 'could not run'}. The verification was not started; nothing was recorded.`,
      why: outcome.message,
      controls: ['DI-04'],
      whatYouCanDo: timeout ? ['Lower the maximum loop iterations or replicate counts, then start the verification again.'] : ['Fix the errors in the findings panel, save, then start the verification again.'],
      whoCanHelp: ['The system administrator, if it happens again'],
    });
  } finally {
    release();
  }
}

async function analyseSaved(
  db: Parameters<typeof analyse>[0],
  versionId: string,
  saved: SavedContent,
  mbr: flow.MbrContent,
): Promise<{ a: DesignerAnalysis; justifications: ReturnType<typeof warningJustifications> }> {
  const inForce = await justificationsInForceOf(db, versionId, saved);
  const a = await analyse(db, mbr, warningJustifications(inForce));
  const warnings = new Set(a.findings.filter((f) => f.severity === 'WARNING').map((f) => f.key));
  return { a, justifications: warningJustifications(inForce.filter((j) => warnings.has(j.key))) };
}

function requireKey(ctx: { idempotencyKey: string | null }): string {
  if (!ctx.idempotencyKey) throw new Error('the platform admitted a mutating request without an idempotency key');
  return ctx.idempotencyKey;
}

export async function plugin(scope: FastifyInstance, app: AppContext): Promise<void> {
  const pool = app.pools.app;
  const palette = paletteBlocks();

  /** Logs what a publish of the staged packages of recorded exports did. */
  const logReconciliation = (log: FastifyBaseLogger, r: Reconciliation): void => {
    if (r.published.length > 0) log.warn({ published: r.published }, 'designer: published test packages of recorded exports that had not reached the sandbox inbox');
    if (r.problems.length > 0) log.error({ problems: r.problems }, 'designer: recorded test packages that could not be published');
  };
  // At start-up, the staged packages of recorded exports are published (a publish cut off by a stop or a crash).
  try {
    logReconciliation(scope.log, await publishRecordedStaged(pool, app.config.exchangeDir));
  } catch (error) {
    scope.log.error({ err: error }, 'designer: the staged test packages could not be checked');
  }

  const templateViews: TemplateView[] = [...TEMPLATES.values()].map((t) => ({
    templateId: t.templateId,
    title: t.title,
    description: t.description,
    product: { code: t.content.header.product.code, name: t.content.header.product.name, strength: t.content.header.product.strength },
    batchSizes: t.content.header.batchSizes.map((b) => ({ quantity: b.quantity.value, unit: b.quantity.unit })),
    markets: [...t.content.header.marketSet],
    steps: stepCount(t.content),
  }));

  type CreateFamilyCtx = HandlerContext<typeof routes.designer.createFamily>;
  const familyRefusal = (error: FamilyInputError): Error =>
    refusal(422, {
      code: error.code,
      kind: 'INVALID_INPUT',
      whatHappened: 'The family was not created.',
      why: error.message,
      controls: error.controls,
      whatYouCanDo: ['Correct the entry and create the family again.'],
    });
  /** Slice 7j (R4; D-7j-5): a new family from an approved formula, without a template (from-formula.ts). */
  const createFromFormula = async (ctx: CreateFamilyCtx): Promise<VersionView> => {
    const { body } = ctx;
    const start = body.start ?? 'SKELETON';
    if (!body.formulaVersionId) {
      throw refusal(422, {
        code: 'DESIGNER_FORMULA_REQUIRED',
        kind: 'INVALID_INPUT',
        whatHappened: 'The family was not created.',
        why: 'A master without a template starts from an approved formula: choose the product first.',
        controls: ['INV-25', 'PR-01'],
        whatYouCanDo: ['Choose a product with an approved formula, or choose a template.'],
      });
    }
    const formulaVersionId = body.formulaVersionId;
    const copySource = start === 'COPY' ? await copySourceOf(body.copyOfVersionId) : undefined;
    const base = TEMPLATES.get('dc-mini');
    if (!base) throw new Error('the dc-mini skeleton source is missing');
    const actor = ctx.actor();
    const { result } = await uniqueViolationAsConflict(
      () =>
        withIdempotentActorCommand(pool, actor, requireKey(ctx), ctx.requestHash, async (c) => {
          const chosen = await formula.formulaVersionForMbr(c, formulaVersionId);
          const target = await formula.formulaTargetOf(c, formulaVersionId);
          const { rows } = await c.query<{ name: string | null; dosage: string | null }>(
            `select p.product_name as name, (select e.attributes ->> 'dosageForm' from site.master_entry e where e.version_id = p.id) as dosage
               from site.erp_master_effect x join site.erp_product p on p.id = x.version_id
              where x.master_kind = 'PRODUCT' and x.master_key = $1 || '|' || $2 order by x.effective_at desc, x.id desc limit 1`,
            [chosen.productCode, chosen.strength],
          );
          const materials = await materialMasters(c, chosen.lines.map((l) => l.materialCode));
          let content: flow.MbrContent;
          try {
            content = contentFromFormula(
              base,
              { chosen, target, product: { name: rows[0]?.name ?? body.product.name, dosageForm: rows[0]?.dosage ?? 'Tablet' }, materials },
              { familyCode: body.familyCode, markets: body.markets, start },
              copySource,
              TEMPLATES.get('gb-t-01')?.content.references.find((r) => r.id === 'SYS-EBMR-TIME'),
            );
          } catch (error) {
            if (error instanceof FamilyInputError) throw familyRefusal(error);
            throw error;
          }
          const hazard = await hazardContext(c, content.header.product.code);
          let contained: flow.MbrContent;
          try {
            contained = withContainment(content, hazard);
          } catch (error) {
            if (!(error instanceof NoContainedAreaError)) throw error;
            throw refusal(422, {
              code: 'DESIGNER_NO_CONTAINED_AREA',
              kind: 'NOT_ALLOWED',
              whatHappened: 'The family was not created.',
              why: `The product is classed ${error.classes.join(', ')}, and no room or line is dedicated and contained for that class with a second QA person's approval.`,
              controls: ['IN-27'],
              whatYouCanDo: ['Ask QA to record and approve the dedication of a contained room or line for the class first.'],
            });
          }
          const familyId = await lifecycle.defineFamily(c, lifecycle.familyOf(contained));
          const how = start === 'COPY' ? `a copy of master version ${body.copyOfVersionId ?? ''}` : start === 'BLANK' ? 'a blank master' : 'the required skeleton';
          const v = await lifecycle.createVersion(c, familyId, contained, `Created from formula ${chosen.productCode} ${chosen.strength} version ${String(chosen.versionNumber)} as ${how}, without a template`);
          await formula.pinFormula(c, v.versionId, chosen.versionId);
          return { versionId: v.versionId };
        }),
      `An MBR family ${body.familyCode} or one for the same product, strength and batch sizes`,
    );
    return versionView(pool, app, result.versionId);
  };
  /** The content of the approved master version to copy (COPY): an APPROVED or EFFECTIVE version only. */
  const copySourceOf = async (versionId: string | undefined): Promise<flow.MbrContent> => {
    const head = versionId ? await requireHead(pool, versionId) : null;
    if (!head || !['APPROVED', 'EFFECTIVE'].includes(head.state)) {
      throw refusal(422, {
        code: 'DESIGNER_COPY_NOT_APPROVED',
        kind: 'INVALID_INPUT',
        whatHappened: 'The family was not created.',
        why: 'Only an approved master version can be copied.',
        controls: ['PR-06'],
        whatYouCanDo: ['Choose an approved master version to copy.'],
      });
    }
    return (await latestContent(pool, head.versionId)).content;
  };

  bindRoutes(scope, app, routes.designer, {
    // Phase 3 slice 6a-0: "Choose a product" arrives with slice 6a.
    // "Choose a product" (decision 0006): the approved formula's BOM with its computed quantities (FORMULA.READ, DI-13).
    formulaChoice: async (ctx) => {
      const s = ctx.requireSession();
      const q = ctx.query;
      // The session's read (tablets 1041): FORMULA.READ by its role, no command (a shop-floor terminal needs no tap).
      const { rows } = await pool.query<{ r: formula.FormulaChoice }>('select tab.formula_choice($1, $2, $3, $4::numeric) as r', [s.tokenHash, q.product, q.strength, q.batchSize]);
      const c = rows[0]?.r;
      if (!c) throw new Error('no formula choice was read');
      const target = (await targetsOf(pool, [c.versionId])).get(c.versionId) ?? null;
      return { formulaId: c.formulaId, versionId: c.versionId, versionNumber: c.versionNumber, productCode: c.productCode, strength: c.strength, batchSizeUnits: c.batchSizeUnits, bom: c.lines, target };
    },
    templates: () => Promise.resolve({ templates: templateViews }),

    families: async () => ({ families: await familyViews(pool, app) }),

    async createFamily(ctx) {
      const { body } = ctx;
      // Slice 7j (R4, D-7j-5): without a template, the master starts from the approved formula.
      if (body.templateId === undefined) return createFromFormula(ctx);
      const templateId = body.templateId;
      const template = TEMPLATES.get(templateId);
      if (!template) {
        throw refusal(422, {
          code: 'DESIGNER_TEMPLATE_UNKNOWN',
          kind: 'INVALID_INPUT',
          whatHappened: 'There is no such template.',
          why: `Template ${templateId} is not offered on this installation.`,
          whatYouCanDo: ['Choose one of the listed templates.'],
        });
      }
      let content: flow.MbrContent;
      try {
        content = contentFromTemplate(template, { familyCode: body.familyCode, product: body.product, batchSizes: body.batchSizes ?? [], markets: body.markets });
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
            // "Choose a product" (decision 0006): the BOM quantities from the approved formula version (FORMULA.READ in the
            // database), and the pin, which the database checks against the content (EBMR-FRM-019, INV-25).
            const chosen = body.formulaVersionId ? await formula.formulaVersionForMbr(c, body.formulaVersionId) : null;
            const withBom = chosen ? withFormulaBom(content, chosen) : content;
            // IN-27 (Phase 6 slice 6f): a hazardous product's MBR gets the PPE and decontamination steps and only contained areas.
            const hazard = await hazardContext(c, withBom.header.product.code);
            let contained: flow.MbrContent;
            try {
              contained = withContainment(withBom, hazard);
            } catch (error) {
              if (!(error instanceof NoContainedAreaError)) throw error;
              throw refusal(422, {
                code: 'DESIGNER_NO_CONTAINED_AREA',
                kind: 'NOT_ALLOWED',
                whatHappened: 'The family was not created.',
                why: `The product is classed ${error.classes.join(', ')}, and no room or line is dedicated and contained for that class with a second QA person's approval.`,
                controls: ['IN-27'],
                whatYouCanDo: ['Ask QA to record and approve the dedication of a contained room or line for the class first.'],
                whoCanHelp: ['QA (hazard classes and area dedications)'],
              });
            }
            const familyId = await lifecycle.defineFamily(c, lifecycle.familyOf(contained));
            const v = await lifecycle.createVersion(c, familyId, contained, `Created from template ${template.templateId}${chosen ? ` with formula ${chosen.productCode} ${chosen.strength} version ${String(chosen.versionNumber)}` : ''}${hazard.classes.length > 0 ? `; ${hazard.classes.join(', ')} product: protective equipment and decontamination steps added, contained areas only (IN-27)` : ''}`);
            if (chosen) await formula.pinFormula(c, v.versionId, chosen.versionId);
            return { versionId: v.versionId };
          }),
        `An MBR family ${body.familyCode} or one for the same product, strength and batch sizes`,
      );
      return versionView(pool, app, result.versionId);
    },

    version: async (ctx) => {
      // DI-13: an MBR whose composition comes from the formulation library opens only for a reader holding FORMULA.READ.
      await compositionGate(pool, ctx.requireSession().tokenHash, ctx.params.versionId);
      return versionView(pool, app, ctx.params.versionId);
    },

    async saveContent(ctx) {
      const id = ctx.params.versionId;
      const head = await requireHead(pool, id);
      if (head.state !== 'DRAFT') throw notDraft(head.state, 'content changes');
      const parsed = flow.parseMbr(ctx.body.content);
      if (!parsed.ok) throw parseRefusal(parsed.problems);
      const current = await latestContent(pool, id);
      if (current.revision !== ctx.body.baseRevision) throw stale(current.revision, ctx.body.baseRevision);
      // As createFamily: only markets the market engine knows, each once, India always (INV-28, IN-52, INV-34).
      // The database refuses such content too (EBMR-TAB-165); this answer only says it plainly first.
      const marketProblem = await marketSetProblem(pool, parsed.mbr.header.marketSet);
      if (marketProblem) {
        throw refusal(422, {
          code: 'DESIGNER_MARKETS',
          kind: 'INVALID_INPUT',
          whatHappened: 'The revision was not saved: its market set is not one the market engine accepts.',
          why: marketProblem,
          controls: ['IN-52', 'INV-34', 'INV-28'],
          whatYouCanDo: [`List only the markets ${KNOWN_MARKETS.join(', ')}, each once, with India (IN) always in the set.`],
          whoCanHelp: ['The QA MBR approver, if the product is to be made for another market'],
        });
      }
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
      // A bounded number at once in the process and a rate per session (bindRoutes below): each validation parses
      // posted content and runs the validator and the definition check on the main thread (review P18).
      return inValidationSlot('validation', async () => {
        const versionId = ctx.body.versionId;
        if (versionId) await requireHead(pool, versionId);
        const parsed = flow.parseMbr(ctx.body.content);
        if (!parsed.ok) return await parseFailureView(pool, app, ctx.body.content, parsed.problems);
        // A justification counts only for the content it was written for: the version's saved revision, validated
        // unchanged. Unsaved edits are a new revision to be, whose warnings nobody has justified yet (IN-02, DI-04).
        let inForce: StoredJustification[] = [];
        if (versionId) {
          const saved = await latestContent(pool, versionId);
          if (flow.mbrContentHash(parsed.mbr) === saved.contentHash) inForce = await justificationsInForceOf(pool, versionId, saved);
        }
        const a = await analyse(pool, parsed.mbr, warningJustifications(inForce));
        return await reportView(pool, app, a, await justificationViews(pool, app, inForce));
      });
    },

    async simulate(ctx) {
      // MBR roles only, a bounded number at once in the process, and a per-session rate (bindRoutes below): each
      // simulation validates on the main thread and runs a worker with a large heap (review P18).
      ctx.requireRole(...SIMULATION_ROLES);
      const id = ctx.params.versionId;
      await requireHead(pool, id);
      const max = designerSettings.maxConcurrentSimulations;
      const release = acquireSimulationSlot(max);
      if (!release) throw busy('simulation', max);
      try {
        const saved = await latestContent(pool, id);
        const parsed = flow.parseMbr(saved.content);
        if (!parsed.ok) throw parseRefusal(parsed.problems);
        const a = await analyse(pool, parsed.mbr, []);
        const outcome = await simulateInWorker(
          { content: saved.content, asOf: a.loaded.asOf, references: a.loaded.references, minimaRequest: a.loaded.minimaRequest, minima: a.loaded.minima, engineRoles: a.loaded.engineRoles, checkers: a.loaded.checkers },
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
      } finally {
        release();
      }
    },

    async justify(ctx) {
      // The author only (the database requires MBR.AUTHOR), before the saved content is analysed (review P18).
      ctx.requireRole(...AUTHOR_ROLES);
      const id = ctx.params.versionId;
      const head = await requireHead(pool, id);
      if (head.state !== 'DRAFT') throw notDraft(head.state, 'warnings can be justified');
      const saved = await latestContent(pool, id);
      // The justification answers the warning of the saved revision its author was shown: refused when that is no
      // longer the saved content (IN-02, DI-04; review P15, P59).
      if (saved.revision !== ctx.body.baseRevision || saved.contentHash !== ctx.body.contentHash) throw staleJustification(saved.revision, ctx.body.baseRevision);
      const a = await inValidationSlot('command', async () => {
        const parsed = flow.parseMbr(saved.content);
        if (!parsed.ok) throw parseRefusal(parsed.problems);
        return analyse(pool, parsed.mbr, []);
      });
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
        // Bound to the content the author was shown: the database records it only while that is still the saved
        // content (EBMR-TAB-156 when a save came in after the check above).
        const { rows } = await c.query<{ r: { id: string } }>('select tab.record_designer_justification($1, $2, $3, $4) as r', [
          id,
          ctx.body.findingKey,
          ctx.body.text,
          ctx.body.contentHash,
        ]);
        return { id: rows[0]?.r.id ?? null };
      });
      return versionView(pool, app, id);
    },

    async startVerification(ctx) {
      // The author only (the database requires MBR.AUTHOR), before the saved content is analysed (review P18).
      ctx.requireRole(...AUTHOR_ROLES);
      const id = ctx.params.versionId;
      const head = await requireHead(pool, id);
      if (head.state !== 'DRAFT') throw notDraft(head.state, 'verification can be started');
      const saved = await latestContent(pool, id);
      if (saved.revision !== ctx.body.baseRevision) throw stale(saved.revision, ctx.body.baseRevision);
      // The slot covers the command too: it runs the validator again on the content it reads (review P18).
      await inValidationSlot('command', async () => {
        const parsed = flow.parseMbr(saved.content);
        if (!parsed.ok) throw parseRefusal(parsed.problems);
        const { a, justifications: justs } = await analyseSaved(pool, id, saved, parsed.mbr);
        // The execution definition must hold before the static evidence is recorded; the validator's own verdict is
        // stored as evidence either way (a failed attempt stays on record) and only a PASS moves the version.
        const justified = new Set(justs.map((j) => j.key));
        if (a.definition.some((f) => f.severity === 'ERROR' || (f.severity === 'WARNING' && !justified.has(f.key)))) throw gateFailed(a, 'enter verification');
        const port = lifecycle.createVerificationPort(a.loaded.context);
        const base = ctx.body.baseRevision;
        // Slice 7h (decision D-P7R-16): the designer's simulation of this content runs first (in its worker, with its
        // timeout and slot), so its sealed verification evidence and the generated test vectors are recorded with the
        // validator report when the author starts the verification; nothing of it is typed in by hand.
        const simulation = await simulateForEvidence(a, saved.content);
        const actor = ctx.actor();
        const { result } = await withIdempotentActorCommand(pool, actor, requireKey(ctx), ctx.requestHash, async (c) => {
          const cur = await lifecycle.loadContent(c, id);
          if (cur.revision !== base) throw stale(cur.revision, base);
          const st = await lifecycle.versionState(c, id);
          if (!st) throw notDraft('unknown', 'verification can be started');
          const r = await lifecycle.validateAndStartVerification(c, id, st.version, port, justs);
          if (r.transition !== undefined) {
            // The same content the validator just passed (read in this command); the database recomputes the seal and
            // decides PASS or FAIL for each (DI-04). Starting the verification is the author's confirmation of the vectors.
            const report = port.validate(cur.content);
            await lifecycle.recordEvidence(c, id, 'VERIFICATION', simulator.buildVerificationEvidence(cur.content, report, justs, simulation));
            await lifecycle.recordEvidence(c, id, 'TEST_VECTORS', lifecycle.testVectorEvidence(simulation, actor.personId));
          }
          return { result: r.evidence.result, problems: r.evidence.problems, moved: r.transition !== undefined };
        });
        if (result.result !== 'PASS' || !result.moved) throw gateFailed(a, 'enter verification');
      });
      return versionView(pool, app, id);
    },

    async testPackage(ctx) {
      // The author only (the database requires MBR.AUTHOR), before the saved content is analysed (review P18).
      ctx.requireRole(...AUTHOR_ROLES);
      const id = ctx.params.versionId;
      const head = await requireHead(pool, id);
      const saved = await latestContent(pool, id);
      // The slot covers the analysis only: the export command below may wait for another export (the inbox lock).
      const { mbr, justs } = await inValidationSlot('command', async () => {
        const parsed = flow.parseMbr(saved.content);
        if (!parsed.ok) throw parseRefusal(parsed.problems);
        const { a, justifications } = await analyseSaved(pool, id, saved, parsed.mbr);
        if (!a.gate.passed) throw gateFailed(a, 'be sent to the sandbox');
        return { mbr: parsed.mbr, justs: justifications };
      });
      const actor = ctx.actor();
      const log = ctx.request.log;
      let staged: StagedPackage | undefined;
      // Set once the export is recorded inside the command (the command's work is done; its commit follows).
      let prepared: RecordedExport | undefined;
      let recorded: RecordedExport;
      try {
        const { result } = await withIdempotentActorCommand(pool, actor, requireKey(ctx), ctx.requestHash, async (c) => {
          // One export at a time passes the gate below and records: a concurrent export waits here until this one
          // has committed, and then sees it (with its staged file) as a recorded export (DI-05; review P14).
          await c.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [TEST_PACKAGE_INBOX_LOCK]);
          // A recorded export whose file has not reached the inbox is published first; while one cannot be, no new
          // export is recorded, so exports never pile up on the audit trail without their files (DI-05; review P14).
          const earlier = await publishRecordedStaged(c, app.config.exchangeDir);
          logReconciliation(log, earlier);
          if (earlier.problems.length > 0) throw inboxBehind(earlier.problems);
          const cur = await latestContent(c, id);
          if (cur.contentHash !== saved.contentHash || cur.revision !== saved.revision) throw stale(cur.revision, saved.revision);
          const stamp = await sandbox.readInstallationStamp(c);
          sandbox.assertGmpOrigin(stamp, 'An MBR test package');
          const nowUs = await dbNowUs(c);
          const exporter = await personRef(c, actor.personId, actor.accountId, actor.roleCode);
          const pkg = buildTestPackage(
            {
              source: stamp,
              // The product as the content names it: the sandbox refuses a package whose family metadata is not the
              // content's header (F03); the family's own product name may differ from the content's.
              family: { familyId: head.familyId, familyCode: head.familyCode, product: { code: mbr.header.product.code, name: mbr.header.product.name, strength: mbr.header.product.strength } },
              version: { versionId: id, number: versionLabel(head.versionNumber), revision: saved.revision, state: head.state },
              content: mbr,
              justifications: justs,
              exporter: { personId: exporter.personId, legalName: exporter.legalName, loginName: exporter.loginName },
              exportedAtUs: nowUs.toString(),
            },
            saved.contentHash,
          );
          const s = await stagePackage(app.config.exchangeDir, pkg);
          staged = s;
          // Before anything is recorded, the inbox must take the hard link that publishes the package; on a share
          // without hard links nothing is recorded, however often the export is tried.
          try {
            await proveInboxLinkable(s);
          } catch (error) {
            if (error instanceof InboxUnavailableError) throw inboxUnavailable(error);
            throw error;
          }
          await c.query('select tab.record_test_package_export($1, $2, $3, $4, $5, $6::bigint)', [id, saved.revision, saved.contentHash, pkg.packageHash, s.fileName, nowUs.toString()]);
          // The stored result keeps the file text, so a resend with this key can publish the recorded package even
          // when its staged file is gone.
          const r = { packageHash: pkg.packageHash, fileName: s.fileName, stagedPath: s.stagedPath, finalPath: s.finalPath, fileText: s.fileText };
          prepared = r;
          return r;
        });
        recorded = result;
      } catch (error) {
        if (!prepared) {
          // The command's work failed, so the command never committed: its staged file goes, never published.
          await discardStaged(staged);
          throw error;
        }
        // The work was done and the error came with or after the commit, which may have happened (an answer lost
        // with the connection). The database says whether the export is recorded; its staged file goes only when
        // the export surely is not, and is published when it is.
        const committed = await exportIsRecorded(pool, prepared.packageHash).catch(() => null);
        if (committed !== true) {
          if (committed === false && surelyRolledBack(error)) await discardStaged(staged);
          else log.error({ versionId: id, packageHash: prepared.packageHash, err: error }, 'designer: the test package export may be recorded; its staged file is kept and published once it shows as recorded');
          throw error;
        }
        log.warn({ versionId: id, packageHash: prepared.packageHash, err: error }, 'designer: the test package export committed although its command reported an error; its package is published');
        recorded = prepared;
      }
      // The export is recorded (committed): from here its staged file is never removed unpublished.
      try {
        const published = await publishPackage(recorded);
        if (published.restaged === 'ALTERED') {
          log.error({ versionId: id, packageHash: recorded.packageHash, stagedPath: recorded.stagedPath }, 'designer: the staged file of a recorded test package was not that package (changed on disk); the package was published from the text its command stored');
        }
      } catch (error) {
        log.error({ versionId: id, packageHash: recorded.packageHash, err: error }, 'designer test package recorded but not published');
        throw notPublished(recorded.packageHash, error);
      }
      const base = app.config.otherInstallationUrl;
      return {
        packageId: recorded.packageHash,
        packageHash: recorded.packageHash,
        fileName: recorded.fileName,
        sandboxUrl: base ? `${base.replace(/\/$/, '')}/test-packages?package=${recorded.packageHash}` : '',
      };
    },

    palette: () => Promise.resolve({ blocks: palette }),

    referenceDocuments: async () => ({ documents: await referenceDocumentViews(pool, await siteToday(pool)) }),
    // Phase 7 slice 7g-2 (decision 0025): market authorisations and labelling specimens (master-records.ts).
    ...masterRecordHandlers(app),
  }, {
    rateLimits: {
      simulate: SIMULATION_RATE_LIMIT,
      validate: VALIDATION_RATE_LIMIT,
      justify: DESIGNER_COMMAND_RATE_LIMIT,
      startVerification: DESIGNER_COMMAND_RATE_LIMIT,
      testPackage: DESIGNER_COMMAND_RATE_LIMIT,
    },
  });
}
