/**
 * Feature `master-data` (Phase 3 slice 6a, GMP): the company formulation library (decision 0006 part 1; D-S6-3, D-S6-4)
 * over recipe-core 0640. A steward records a formula and writes DRAFT versions of its per-unit composition; the database
 * computes every batch quantity (INV-25); a second person approves a version with FORMULA_APPROVED (signable action
 * MASTER_DATA_APPROVE). Reads are the session's (tablets 1041, no command, so a shop-floor terminal needs no tap): the
 * database serves a composition only to a reader whose role holds FORMULA.READ (DI-13).
 */
import { routes, type FormulaSummaryView, type FormulaTargetView, type FormulaVersionView, type SignableAction } from '@ebmr/api-contract';
import { flow, formula } from '@ebmr/recipe-core';
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

/** Each product's latest name and, when its master states one, its dosage form (C2), by "code|strength". */
export async function productNames(db: Pick<pg.Pool, 'query'>): Promise<Map<string, { name: string; dosageForm: string | null }>> {
  const { rows } = await db.query<{ k: string; name: string; dosage: string | null }>(
    `select distinct on (p.product_code, p.strength) p.product_code || '|' || p.strength as k, p.product_name as name,
            (select e.attributes ->> 'dosageForm' from site.master_entry e where e.version_id = p.id) as dosage
       from site.erp_product p order by p.product_code, p.strength, p.received_at desc, p.id desc`,
  );
  return new Map(rows.map((r) => [r.k, { name: r.name, dosageForm: r.dosage }]));
}

/** The targets of formula versions (recipe-core 1535), by version id. */
export async function targetsOf(db: Pick<pg.Pool, 'query'>, versionIds: readonly string[]): Promise<Map<string, FormulaTargetView>> {
  if (versionIds.length === 0) return new Map();
  const { rows } = await db.query<{ id: string; t: FormulaTargetView | null }>('select v.id::text as id, recipe.formula_target_of(v.id) as t from unnest($1::uuid[]) v(id)', [versionIds]);
  return new Map(rows.filter((r) => r.t !== null).map((r) => [r.id, r.t as FormulaTargetView]));
}

/** The views of what the database answered (formula.readFormulas), people and product names read once. */
export async function formulaViews(app: AppContext, db: Pick<pg.Pool, 'query'>, read: formula.FormulaRead[]): Promise<{ summary: FormulaSummaryView; versions: FormulaVersionView[]; readable: boolean }[]> {
  const names = await productNames(db);
  const people = await peopleOf(db, read.flatMap((f) => f.versions.flatMap((v) => [v.authoredBy, v.approvedBy])));
  const targets = await targetsOf(db, read.flatMap((f) => f.versions.map((v) => v.versionId)));
  return read.map((f) => {
    const approved = [...f.versions].reverse().find((v) => v.state === 'APPROVED');
    return {
      readable: f.compositionReadable,
      summary: {
        formulaId: f.formulaId,
        productCode: f.productCode,
        strength: f.strength,
        productName: names.get(`${f.productCode}|${f.strength}`)?.name ?? null,
        ...(names.get(`${f.productCode}|${f.strength}`)?.dosageForm ? { dosageForm: names.get(`${f.productCode}|${f.strength}`)?.dosageForm ?? '' } : {}),
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
        target: targets.get(v.versionId) ?? null,
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
      // Capsules C6b (recipe-core 1875): the unit form from the product's dosage form, as the designer reads it (core's on
      // the platform build, the product master's otherwise); a capsule may give its shell's excipients per batch.
      const summary = (await one(s.tokenHash, params.formulaId)).summary;
      const stated = app.platform.master ? ((await app.platform.master.read('product', { code: summary.productCode }))?.dosageForm ?? null) : (summary.dosageForm ?? null);
      const unitForm = flow.isCapsuleForm(stated) ? ({ unitForm: 'CAPSULE' } as const) : {};
      const out = await withIdempotentActorCommand(pool, actor(), idempotencyKey ?? '', requestHash, async (c) => {
        const id = await formula.addFormulaVersion(c, params.formulaId, { changeReason: body.changeReason, lines: body.lines.map((l) => compact(l) as formula.FormulaLineInput), ...unitForm });
        // Slice 7j (recipe-core 1535): the target with the composition, in the same transaction.
        if (body.target) await formula.setFormulaTarget(c, id, body.target);
        return id;
      });
      const v = (await one(s.tokenHash, params.formulaId)).versions.find((x) => x.versionId === out.result);
      if (!v) throw new Error('the new formula version was not read back');
      return v;
    },
    // Slice 7j (R4, D-7j-1; site-services 1530): masters entered on screen wait for QA's confirmation.
    enterMaterial: async ({ body, actor, idempotencyKey, requestHash }) => {
      const out = await withIdempotentActorCommand(pool, actor(), idempotencyKey ?? '', requestHash, async (c) => {
        const { rows } = await c.query<{ id: string }>('select site.enter_material_master($1) as id', [compact(bare(body))]);
        return rows[0]?.id ?? '';
      });
      return { masterKind: 'MATERIAL' as const, key: body.materialCode, versionId: out.result, state: 'PENDING' as const };
    },
    enterProduct: async ({ body, actor, idempotencyKey, requestHash }) => {
      const out = await withIdempotentActorCommand(pool, actor(), idempotencyKey ?? '', requestHash, async (c) => {
        const { rows } = await c.query<{ id: string }>('select site.enter_product_master($1) as id', [compact(bare(body))]);
        return rows[0]?.id ?? '';
      });
      return { masterKind: 'PRODUCT' as const, key: `${body.productCode}|${body.strength}`, versionId: out.result, state: 'PENDING' as const };
    },
  });
  return Promise.resolve();
}
