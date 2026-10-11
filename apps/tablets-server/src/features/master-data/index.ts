/**
 * Feature `master-data` (Phase 3 slice 6a, GMP): the company formulation library (decision 0006 part 1; D-S6-3, D-S6-4)
 * over recipe-core 0640. A steward records a formula and writes DRAFT versions of its per-unit composition; the database
 * computes every batch quantity (INV-25); a second person approves a version with FORMULA_APPROVED (signable action
 * MASTER_DATA_APPROVE). Reads are the session's (tablets 1041, no command, so a shop-floor terminal needs no tap): the
 * database serves a composition only to a reader whose role holds FORMULA.READ (DI-13).
 */
import { routes, type FormulaSummaryView, type FormulaVersionView, type SignableAction } from '@ebmr/api-contract';
import { formula } from '@ebmr/recipe-core';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import type { AppContext } from '../../platform/context.ts';
import { withIdempotentActorCommand } from '../../platform/db/commands.ts';
import { bindRoutes, withoutAttribution } from '../../platform/http/bind.ts';
import type { SignableActionHandler, SignableActionRegistry } from '../../platform/ports.ts';
import { compact, peopleOf, personRef } from '../common/people.ts';
import { dbActHandler } from '../esig/db-acts.ts';

/** The body without its badge-tap attribution (a FRESH_ON_SHARED route's, INV-40): the database gets the command's own members. */
const bare = <T extends object>(body: T): Omit<T, 'attribution'> => withoutAttribution(body) as unknown as Omit<T, 'attribution'>;

type MasterDataApprove = Extract<SignableAction, { kind: 'MASTER_DATA_APPROVE' }>;

/** A received ERP master version is confirmed over aggregate erp_master:<PRODUCT|MATERIAL>/<version> (site-services 0802). */
const ERP_KIND = { ERP_PRODUCT: 'PRODUCT', ERP_MATERIAL: 'MATERIAL' } as const;

/**
 * MASTER_DATA_APPROVE: a formula version (FORMULA_APPROVED, recipe-core 0640), or a received ERP product or material
 * master version (ERP_MASTER_CONFIRMED by QA, site.confirm_erp_master, site-services 0802). The database decides.
 */
export function formulaApproveHandler(app: AppContext): SignableActionHandler<MasterDataApprove> {
  return dbActHandler<MasterDataApprove>(app, {
    kind: 'MASTER_DATA_APPROVE',
    aggregateTypes: ['formula_version', 'erp_master'],
    target: (a) =>
      a.masterKind === 'FORMULA'
        ? { aggregateType: 'formula_version', aggregateId: a.versionId, meaning: 'FORMULA_APPROVED', expectedState: 'DRAFT' }
        : { aggregateType: 'erp_master', aggregateId: `${ERP_KIND[a.masterKind]}/${a.versionId}`, meaning: 'ERP_MASTER_CONFIRMED', expectedState: 'PENDING' },
    async apply(client, _ctx, a, signatureId) {
      if (a.masterKind === 'FORMULA') {
        await formula.approveFormulaVersion(client, a.versionId, signatureId);
        return { versionId: a.versionId, state: 'APPROVED' };
      }
      await client.query('select site.confirm_erp_master($1, $2, $3)', [ERP_KIND[a.masterKind], a.versionId, signatureId]);
      return { versionId: a.versionId, state: 'EFFECTIVE' };
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

/** The formulas (or one) as the session behind the request reads them (tablets 1041: no command; FORMULA.READ by its role). */
async function readFor(pool: pg.Pool, tokenHash: string, formulaId?: string): Promise<formula.FormulaRead[]> {
  const { rows } = await pool.query<{ r: formula.FormulaRead[] }>('select tab.formula_read($1, $2) as r', [tokenHash, formulaId ?? null]);
  return rows[0]?.r ?? [];
}

export function plugin(scope: FastifyInstance, app: AppContext): Promise<void> {
  const pool = app.pools.app;
  const one = async (tokenHash: string, formulaId: string) => {
    const f = (await formulaViews(app, pool, await readFor(pool, tokenHash, formulaId)))[0];
    if (!f) throw new Error(`formula ${formulaId} was not read back`);
    return f;
  };
  bindRoutes(scope, app, routes.masterData, {
    formulas: async ({ requireSession }) => {
      const s = requireSession();
      return { formulas: (await formulaViews(app, pool, await readFor(pool, s.tokenHash))).map((f) => f.summary) };
    },
    createFormula: async ({ body, requireSession, actor, idempotencyKey, requestHash }) => {
      const s = requireSession();
      const out = await withIdempotentActorCommand(pool, actor(), idempotencyKey ?? '', requestHash, (c) => formula.createFormula(c, bare(body)));
      return (await one(s.tokenHash, out.result)).summary;
    },
    formula: async ({ params, requireSession }) => {
      const s = requireSession();
      const f = await one(s.tokenHash, params.formulaId);
      return { formula: f.summary, versions: f.versions, compositionReadable: f.readable };
    },
    addFormulaVersion: async ({ params, body, requireSession, actor, idempotencyKey, requestHash }) => {
      const s = requireSession();
      const out = await withIdempotentActorCommand(pool, actor(), idempotencyKey ?? '', requestHash, (c) =>
        formula.addFormulaVersion(c, params.formulaId, { changeReason: body.changeReason, lines: body.lines.map((l) => compact(l) as formula.FormulaLineInput) }),
      );
      const v = (await one(s.tokenHash, params.formulaId)).versions.find((x) => x.versionId === out.result);
      if (!v) throw new Error('the new formula version was not read back');
      return v;
    },
  });
  return Promise.resolve();
}
