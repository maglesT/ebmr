/**
 * Feature `master-data` (Phase 3 slice 6a, GMP): the company formulation library (decision 0006 part 1; D-S6-3, D-S6-4)
 * over recipe-core 0640. A steward records a formula and writes DRAFT versions of its per-unit composition; the database
 * computes every batch quantity (INV-25); a second person approves a version with FORMULA_APPROVED (signable action
 * MASTER_DATA_APPROVE). Reads run as the person's own command: the database serves a composition only to a reader holding
 * FORMULA.READ and stores the evaluation (DI-13, INV-26).
 */
import { routes, type FormulaSummaryView, type FormulaVersionView, type SignableAction } from '@ebmr/api-contract';
import { withCommand } from '@ebmr/kernel';
import { formula } from '@ebmr/recipe-core';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import type { AppContext } from '../../platform/context.ts';
import { withIdempotentActorCommand } from '../../platform/db/commands.ts';
import { bindRoutes } from '../../platform/http/bind.ts';
import type { SignableActionHandler, SignableActionRegistry } from '../../platform/ports.ts';
import { compact, peopleOf, personRef } from '../common/people.ts';
import { dbActHandler } from '../esig/db-acts.ts';

type MasterDataApprove = Extract<SignableAction, { kind: 'MASTER_DATA_APPROVE' }>;

export function formulaApproveHandler(app: AppContext): SignableActionHandler<MasterDataApprove> {
  return dbActHandler<MasterDataApprove>(app, {
    kind: 'MASTER_DATA_APPROVE',
    aggregateTypes: ['formula_version'],
    target: (a) => ({ aggregateType: 'formula_version', aggregateId: a.versionId, meaning: 'FORMULA_APPROVED', expectedState: 'DRAFT' }),
    async apply(client, _ctx, a, signatureId) {
      await formula.approveFormulaVersion(client, a.versionId, signatureId);
      return { versionId: a.versionId, state: 'APPROVED' };
    },
  });
}

export function registerSignableActions(registry: SignableActionRegistry, app: AppContext): void {
  if (app.installation === 'GMP') registry.register(formulaApproveHandler(app));
}

async function productNames(db: Pick<pg.Pool, 'query'>): Promise<Map<string, string>> {
  const { rows } = await db.query<{ k: string; name: string }>(
    "select distinct on (p.product_code, p.strength) p.product_code || '|' || p.strength as k, p.product_name as name from site.erp_product p order by p.product_code, p.strength, p.received_at desc, p.id desc",
  );
  return new Map(rows.map((r) => [r.k, r.name]));
}

/** The views of what the database answered (formula.readFormulas), people and product names read once. */
export async function formulaViews(app: AppContext, db: Pick<pg.Pool, 'query'>, read: formula.FormulaRead[]): Promise<{ summary: FormulaSummaryView; versions: FormulaVersionView[]; readable: boolean }[]> {
  const names = await productNames(db);
  const people = await peopleOf(db, read.flatMap((f) => f.versions.flatMap((v) => [v.authoredBy, v.approvedBy])));
  return read.map((f) => {
    const approved = [...f.versions].reverse().find((v) => v.state === 'APPROVED');
    return {
      readable: f.compositionReadable,
      summary: {
        formulaId: f.formulaId,
        productCode: f.productCode,
        strength: f.strength,
        productName: names.get(`${f.productCode}|${f.strength}`) ?? null,
        batchSizeUnits: f.batchSizeUnits,
        latestVersion: f.versions.length === 0 ? 0 : Math.max(...f.versions.map((v) => v.versionNumber)),
        approvedVersion: approved?.versionNumber ?? null,
      },
      versions: f.versions.map((v) => ({
        versionId: v.versionId,
        formulaId: f.formulaId,
        versionNumber: v.versionNumber,
        state: v.state,
        changeReason: v.changeReason,
        lines: v.lines,
        authoredBy: personRef(people, v.authoredBy, 'AUTHOR'),
        authoredAt: app.formatInstant(v.authoredUs),
        approvedBy: v.approvedBy ? personRef(people, v.approvedBy, 'APPROVER') : null,
        approvedAt: v.approvedUs ? app.formatInstant(v.approvedUs) : null,
        signable: { aggregateType: 'formula_version', aggregateId: v.versionId },
      })),
    };
  });
}

export function plugin(scope: FastifyInstance, app: AppContext): Promise<void> {
  const pool = app.pools.app;
  const readAs = <T>(actor: Parameters<typeof withCommand>[1], work: (c: pg.PoolClient) => Promise<T>) => withCommand(pool, actor, work);
  const one = async (actor: Parameters<typeof withCommand>[1], formulaId: string) => {
    const f = (await formulaViews(app, pool, await readAs(actor, (c) => formula.readFormulas(c, formulaId))))[0];
    if (!f) throw new Error(`formula ${formulaId} was not read back`);
    return f;
  };
  bindRoutes(scope, app, routes.masterData, {
    formulas: async ({ requireSession, actor }) => {
      requireSession();
      return { formulas: (await formulaViews(app, pool, await readAs(actor(), (c) => formula.readFormulas(c)))).map((f) => f.summary) };
    },
    createFormula: async ({ body, requireSession, actor, idempotencyKey, requestHash }) => {
      requireSession();
      const out = await withIdempotentActorCommand(pool, actor(), idempotencyKey ?? '', requestHash, (c) => formula.createFormula(c, body));
      return (await one(actor(), out.result)).summary;
    },
    formula: async ({ params, requireSession, actor }) => {
      requireSession();
      const f = await one(actor(), params.formulaId);
      return { formula: f.summary, versions: f.versions, compositionReadable: f.readable };
    },
    addFormulaVersion: async ({ params, body, requireSession, actor, idempotencyKey, requestHash }) => {
      requireSession();
      const out = await withIdempotentActorCommand(pool, actor(), idempotencyKey ?? '', requestHash, (c) =>
        formula.addFormulaVersion(c, params.formulaId, { changeReason: body.changeReason, lines: body.lines.map((l) => compact(l) as formula.FormulaLineInput) }),
      );
      const v = (await one(actor(), params.formulaId)).versions.find((x) => x.versionId === out.result);
      if (!v) throw new Error('the new formula version was not read back');
      return v;
    },
  });
  return Promise.resolve();
}
