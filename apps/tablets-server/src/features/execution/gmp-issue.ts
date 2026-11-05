/**
 * The GMP batch issue on the GMP installation (module C3; Phase 3 slice 2b item 1; recipe-core 0500, 0501):
 *
 *  1. plan (route execution.planBatch, one command): recipe.prepare_gmp_issue selects the MBR version effective now for
 *     the batch's markets and scope (INV-01, INV-28, PR-04, the authorisation cells), allocates the batch number from the
 *     site's register (BATCH_NUMBER.ALLOCATE; a protected counter, so a command that finds no ceiling left reserves the
 *     next block in the external ledger first and runs again: kernel continuity, INV-27), and writes the planned batch,
 *     its link to the number, the pin and the control recipe (INV-02). BATCH.ISSUE at the site and product.
 *  2. sign and issue (signable action GMP_BATCH_ISSUE, through C1's ceremony): the issuer previews the batch_issue
 *     content the kernel computes (tablets 0800), signs it ISSUED, and in the same command the batch is issued:
 *     recipe.begin_gmp_issue (trusted time, the control recipe), the engine's issue of the control recipe's MBR content
 *     defined for GMP (no SANDBOX_ONLY block: DI-05, INV-18), recipe.issue_gmp_execution (the issuer's own valid ISSUED
 *     signature, the ISSUE row). The command carries the issuer's own reason, both halves, from the action
 *     (EBMR-AUDIT-002). The dry run checks what can be checked before the seal (the batch still PLANNED, the definition,
 *     every header input) and signs nothing on a refusal. In the same command the market policies in force are pinned for
 *     the batch (market.pin_policies_for_batch; INV-47; slice 7g WP3).
 * The evidence of the ISSUE row is empty (no test package; recipe-core 0335 row_evidence_problem). Test packages stay
 * sandbox-only (the import routes are not bound here), and the database refuses all of this in the sandbox
 * (EBMR-SBX-010).
 */
import { randomUUID } from 'node:crypto';
import { continuity, market, type ActorContext, type commands } from '@ebmr/kernel';
import { execution, type engine, type flow } from '@ebmr/recipe-core';
import type { PlannedBatchView, SignableAction } from '@ebmr/api-contract';
import type { AppContext } from '../../platform/context.ts';
import { dbNowUs, withIdempotentActorCommand } from '../../platform/db/commands.ts';
import { HttpRefusal, refusal } from '../../platform/http/refusal.ts';
import type { DryRunOutcome, SignableActionHandler } from '../../platform/ports.ts';
import { kernelContent, recordContentForSigning, type EsigSignableContext } from '../esig/content.ts';
import { dataValueOf } from './intents.ts';
import { inputExpectations, unconfirmedCounts, type CountProblem } from './issue-expectations.ts';
import { checkIssue } from './packages.ts';
import { engineActor, engineRoles } from './roles.ts';
import { defineForGmp, loadControlRecipe, type ControlRecipeSource, type Db } from './runs.ts';

type IssueAction = Extract<SignableAction, { kind: 'GMP_BATCH_ISSUE' }>;

export interface PlanInput {
  familyId: string;
  markets: string[];
  site: string;
  line: string;
  batchSize: string;
  /**
   * The ERP production order the batch is planned against (D-S5-4). When the request names none, the oldest open order
   * of the family's product and strength for this site and batch size is taken; the database matches its BOM with the
   * pinned MBR either way (recipe-core 0602).
   */
  erpOrder?: string;
  /** A packaging order (record kind PACKAGING): the issued processing batch it packs (D-S4-2; Phase 4 slice 2c route). */
  parentBatch?: string;
  /**
   * Phase 7 slice 7g (WP4; PR-47, IN-19): a whole-batch reprocessing batch on a REPROCESSING master, planned with the
   * quality unit's authorised request through recipe.prepare_reprocessing_issue (recipe-core 0624), which checks the
   * request (authorised by the QCU, a concluded investigation, a stored risk evaluation, the product's permission, used
   * once) before the GMP plan and links the parent batches.
   */
  reprocessingRequest?: string;
}

/** recipe.prepare_reprocessing_issue's answer read as the GMP plan's (it adds the parents and the request). */
async function prepareReprocessingIssue(client: Db, batchId: string, plan: PlanInput & { erpOrder: string }): Promise<execution.PlannedGmpBatch> {
  const { rows } = await client.query<{ r: Record<string, unknown> }>('select recipe.prepare_reprocessing_issue($1, $2::jsonb) as r', [batchId, JSON.stringify(plan)]);
  const r = rows[0]?.r ?? {};
  const str = (k: string): string => {
    const v = r[k];
    return typeof v === 'string' ? v : v === undefined || v === null ? '' : JSON.stringify(v);
  };
  return {
    batchId: str('batch_id'),
    batchNumber: str('batch_number'),
    allocationId: str('allocation_id'),
    pinId: str('pin_id'),
    versionId: str('version_id'),
    versionNumber: Number(str('version_number')),
    contentHash: str('content_hash'),
    rule: str('rule'),
    markets: Array.isArray(r['markets']) ? (r['markets'] as unknown[]).map(String) : [],
    controlRecipeId: str('control_recipe_id'),
    snapshotHash: str('snapshot_hash'),
    erpOrder: str('erp_order'),
  };
}

/** The external ledger of protected numbers (EBMR_NUMBER_LEDGER_FILE; DEMO-ONLY file, write-once storage in production). */
function ledgerOf(app: AppContext): continuity.ExternalLedger {
  if (!app.config.numberLedgerFile) {
    throw refusal(503, {
      code: 'NUMBERING_NOT_CONFIGURED',
      kind: 'NOT_ENABLED',
      whatHappened: 'Batch numbers cannot be given on this installation: no external ledger of protected numbers is configured. Nothing was saved.',
      why: 'A batch number comes from a protected counter whose blocks are written to an external ledger first, so that no number is ever reused, even after a restore (INV-27; EBMR_NUMBER_LEDGER_FILE).',
      controls: ['INV-27'],
      whatYouCanDo: ['Stop and report it.'],
      whoCanHelp: ['The system administrator'],
    });
  }
  return new continuity.FileLedger(app.config.numberLedgerFile, { database: app.config.database });
}

const reservationOf = (e: unknown): string | null =>
  continuity.counterNeedingReservation(e) ?? (e instanceof Error ? continuity.counterNeedingReservation(e.cause) : null);

/** The planned batch's view: what was planned, and what the issue asks for (the MBR's variants and header inputs). */
function plannedView(planned: execution.PlannedGmpBatch, plan: PlanInput, def: engine.BatchDefinition): PlannedBatchView {
  const h = def.mbr.header;
  const expectations = inputExpectations(def.mbr, plan.batchSize);
  return {
    batchId: planned.batchId,
    batchNumber: planned.batchNumber,
    familyCode: h.family,
    product: { code: h.product.code, name: h.product.name, strength: h.product.strength },
    versionNumber: String(planned.versionNumber),
    contentHash: planned.contentHash,
    markets: planned.markets,
    site: plan.site,
    line: plan.line,
    batchSize: plan.batchSize,
    controlRecipeId: planned.controlRecipeId,
    variants: h.variants.map((v) => ({ id: v.id, name: v.id, options: [...v.values] })),
    inputs: def.mbr.inputs.map((i: flow.ExternalInput) => {
      const expected = expectations.get(i.id);
      return { id: i.id, name: i.name, valueType: i.valueType, unit: i.unit ?? null, source: i.source, required: true, ...(expected ? { expected } : {}) };
    }),
  };
}

/**
 * R3.1 (D-7k-1): the refusal of an issue whose tablet count is further from the master's than the tolerance and was not
 * confirmed with the issuer's reason.
 */
function countRefusal(batchNumber: string, problems: readonly CountProblem[]): HttpRefusal {
  const p = problems[0] as CountProblem;
  if (p.malformed) {
    return new HttpRefusal(422, {
      code: 'EBMR-EXE-700',
      kind: 'NOT_ALLOWED',
      whatHappened: `${p.name} "${p.entered}" is not a whole number of ${p.unit}s. Nothing was signed or issued.`,
      why: `For batch ${batchNumber} the master gives ${p.expected.value} (${p.expected.basis}); a ${p.unit} count is entered as a whole number so it can be checked against it.`,
      controls: ['PR-04', 'DI-24'],
      whatYouCanDo: [`Enter ${p.name} as a whole number, without exponent or decimal point.`],
      whoCanHelp: ['Production planning'],
    }, false);
  }
  return new HttpRefusal(422, {
    code: 'EBMR-EXE-700',
    kind: 'NOT_ALLOWED',
    whatHappened: `${p.name} ${p.entered} is ${p.deviation} % away from the ${p.expected.value} the master gives. Nothing was signed or issued.`,
    why: `For batch ${batchNumber} the master gives ${p.expected.value} (${p.expected.basis}); a value more than ${p.expected.tolerancePercent} % away is issued only with your reason why it differs.`,
    controls: ['PR-04', 'DI-24'],
    whatYouCanDo: [`Correct ${p.name} to the batch's real count, or confirm ${p.entered} with your reason why it differs from the master.`],
    whoCanHelp: ['Production planning'],
  }, false);
}

/**
 * Plans a GMP batch as `actor` (one idempotent command; a protected counter without a ceiling reserves its next block
 * first, then the command runs again under the same key, as kernel withProtectedNumbers does).
 */
export async function planGmpBatch(app: AppContext, actor: ActorContext, key: string, requestHash: string, plan: PlanInput): Promise<PlannedBatchView> {
  const pool = app.pools.app;
  const batchId = randomUUID();
  for (let attempt = 1; ; attempt += 1) {
    try {
      const out = await withIdempotentActorCommand(pool, actor, key, requestHash, async (client) => {
        const erpOrder = plan.erpOrder ?? (await openErpOrder(client, plan));
        const planned = plan.reprocessingRequest !== undefined ? await prepareReprocessingIssue(client, batchId, { ...plan, erpOrder }) : await execution.prepareGmpIssue(client, batchId, { ...plan, erpOrder });
        return planned as unknown as commands.JsonValue;
      });
      const planned = out.result as unknown as execution.PlannedGmpBatch;
      const source = await loadControlRecipe(pool, planned.controlRecipeId);
      if (!source) throw new Error(`the control recipe ${planned.controlRecipeId} of the planned batch was not found`);
      return plannedView(planned, plan, defineForGmp(source));
    } catch (error) {
      const counter = reservationOf(error);
      if (counter === null || attempt >= 3) throw error;
      await continuity.reserveCounterBlock(pool, actor, ledgerOf(app), counter);
    }
  }
}

/** The oldest open ERP order for the plan's family, site and batch size ('' when there is none: the database refuses). */
async function openErpOrder(client: Db, plan: PlanInput): Promise<string> {
  const { rows } = await client.query<{ o: string | null }>('select recipe.open_erp_order_for($1, $2, $3) as o', [plan.familyId, plan.site, plan.batchSize]);
  return rows[0]?.o ?? '';
}

function refused(status: number, code: string, whatHappened: string, why: string, controls: string[], whatYouCanDo: string[]): DryRunOutcome {
  return { accepted: false, status, refusal: { code, kind: status === 409 ? 'STALE' : 'NOT_ALLOWED', whatHappened, why, controls, whatYouCanDo, whoCanHelp: [] } };
}

interface PlannedRow {
  status: string;
  batch_number: string;
  batch_size: string;
  markets: string[];
  control_recipe_id: string | null;
}

async function plannedRow(db: Db, batchId: string): Promise<PlannedRow | undefined> {
  const { rows } = await db.query<PlannedRow>(
    `select b.status, b.batch_number, b.batch_size, b.markets, cr.id as control_recipe_id
       from recipe.stub_batch b left join recipe.control_recipe cr on cr.batch_id = b.id
      where b.id = $1 and exists (select 1 from recipe.batch_allocation_link l where l.batch_id = b.id)`,
    [batchId],
  );
  return rows[0];
}

/** The header inputs of the issue with the source the record names (as the sandbox's issue names them). */
function inputsOf(def: engine.BatchDefinition, a: IssueAction, loginName: string): Record<string, { value: engine.DataValue; source: string }> {
  const inputs: Record<string, { value: engine.DataValue; source: string }> = {};
  for (const [id, v] of Object.entries(a.inputs)) {
    const declared = def.mbr.inputs.find((i) => i.id === id);
    const base = declared?.source === 'MASTER_DATA' ? `Master data, entered at issue by ${loginName}` : `Batch header, entered at issue by ${loginName}`;
    // R3.1 (D-7k-1): the issuer's reason for a value away from the master's stays with the value in the record.
    const confirmed = a.inputConfirmations?.[id]?.trim();
    inputs[id] = { value: dataValueOf(v), source: confirmed ? `${base}; differs from the master's value: ${confirmed}` : base };
  }
  return inputs;
}

async function loginNameOf(db: Db, accountId: string): Promise<string> {
  const { rows } = await db.query<{ login_name: string }>('select login_name from iam.account where id = $1', [accountId]);
  return rows[0]?.login_name ?? accountId;
}

export function gmpIssueHandler(app: AppContext): SignableActionHandler<IssueAction> {
  return {
    kind: 'GMP_BATCH_ISSUE',
    aggregateTypes: ['batch_issue'],
    describe: (a) => ({ aggregateType: 'batch_issue', aggregateId: a.batchId, meaning: 'ISSUED', expectedState: 'PLANNED' }),
    reasonOf: (a) => ({ reasonCode: a.reason.code, reasonText: a.reason.text }),
    previewContent: (ctx, query) => kernelContent(app.pools.app, (ctx as Partial<EsigSignableContext>).tokenHash ?? '', query),
    async prepareForChallenge(client, _ctx, a) {
      const c = await recordContentForSigning(client, 'batch_issue', a.batchId);
      return { contentVersion: c.contentVersion ?? '0', contentHash: c.contentHash ?? '', changed: false };
    },
    async dryRun(client, ctx, a) {
      const row = await plannedRow(client, a.batchId);
      if (!row || !row.control_recipe_id) {
        return refused(404, 'EBMR-EXE-192', 'There is no GMP batch planned with this id. Nothing was signed.', `Batch ${a.batchId} was not planned from an effective MBR version.`, ['INV-01', 'DI-05'], ['Plan the batch first.']);
      }
      if (row.status !== 'PLANNED') {
        return refused(409, 'EBMR-EXE-197', 'This batch is issued already; a batch is issued once. Nothing was signed.', `Batch ${row.batch_number} is ${row.status}.`, ['DI-34'], ['Reload the list of batches.']);
      }
      const source: ControlRecipeSource | undefined = await loadControlRecipe(client, row.control_recipe_id);
      if (!source) return refused(422, 'EBMR-EXE-192', 'The control recipe of this batch cannot be read. Nothing was signed.', `Batch ${row.batch_number} has no readable control recipe.`, ['INV-02'], ['Stop and report it.']);
      const def = defineForGmp(source);
      const counts = unconfirmedCounts(def.mbr, row.batch_size, a.inputs, a.inputConfirmations);
      if (counts.length > 0) {
        const r = countRefusal(row.batch_number, counts);
        return { accepted: false, status: r.status, refusal: r.refusal };
      }
      try {
        checkIssue(
          def,
          { batchSize: row.batch_size, marketSet: row.markets, variants: { ...a.variants }, inputs: inputsOf(def, a, await loginNameOf(client, ctx.actor.accountId)), issuedBy: engineActor(ctx.actor.personId, []) },
          await dbNowUs(client),
          row.batch_number,
        );
      } catch (e) {
        if (e instanceof HttpRefusal) return { accepted: false, status: e.status, refusal: e.refusal };
        throw e;
      }
      const c = await recordContentForSigning(client, 'batch_issue', a.batchId);
      return { accepted: true, contentHash: c.contentHash ?? '', contentVersion: c.contentVersion ?? '0' };
    },
    async apply(client, ctx, a, signature) {
      const row = await plannedRow(client, a.batchId);
      const source = row?.control_recipe_id ? await loadControlRecipe(client, row.control_recipe_id) : undefined;
      if (!row || !source) throw new Error(`batch ${a.batchId} is no longer a planned GMP batch`);
      const def = defineForGmp(source);
      const counts = unconfirmedCounts(def.mbr, row.batch_size, a.inputs, a.inputConfirmations);
      if (counts.length > 0) throw countRefusal(row.batch_number, counts);
      const roles = await engineRoles(client);
      const r = await execution.issueGmpBatch(client, {
        batchId: a.batchId,
        signatureId: signature.signatureId,
        define: () => def,
        request: { variants: { ...a.variants }, inputs: inputsOf(def, a, await loginNameOf(client, ctx.actor.accountId)), issuedBy: engineActor(ctx.actor.personId, roles) },
      });
      // The market policies in force now are pinned for the batch in the same command (kernel 0350; INV-47): afterwards
      // only a tightening reaches it, never a loosening (slice 7g WP3; no other path of the GMP issue pinned them).
      await market.pinPoliciesForBatch(client, a.batchId);
      return { runId: a.batchId, batchNumber: r.batchNumber };
    },
  };
}
