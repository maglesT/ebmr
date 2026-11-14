/**
 * Feature `planning` (Phase 3 slice 6a, GMP): the open ERP production orders of the session's site, each with the MBR
 * version authorised now for its product, strength and batch size, or the plain reason none matches (recipe-core 0641), for a session whose role holds BATCH.ISSUE (tablets 1042, DI-17).
 * Read-only: the plan is POST /api/batches and the issue the GMP_BATCH_ISSUE signable action, each checked again by the
 * database (recipe.prepare_gmp_issue).
 *
 * Phase 4 slice 2c: packaging orders (recipe-core 0760 to 0762). A packaging order is planned with the processing batch
 * it packs (POST /api/planning/packaging-orders, the same idempotent planning command as POST /api/batches with the
 * parent batch: recipe.prepare_gmp_issue gives it the register's packaging number of that batch and refuses a master
 * without its edition's secondary packaging step, TB-24); the site's packaging orders and one order's bulk are read from
 * the database's own views (recipe.packaging_orders, recipe.packaging_order_bulk): every reason shown is the database's.
 * The bulk issue itself is POST /api/batches/:batchId/bulk (recipe.issue_packaging_bulk).
 */
import { routes, type BatchNumberRuleView, type BatchNumberView, type PackagingBulkView, type PackagingOrderView, type PlanningOrderView, type RetiredSerialRangeView } from '@ebmr/api-contract';
import type { ActorContext, commands } from '@ebmr/kernel';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import type { AppContext } from '../../platform/context.ts';
import { withIdempotentActorCommand } from '../../platform/db/commands.ts';
import { bindRoutes, type Handlers } from '../../platform/http/bind.ts';
import { peopleOf, personRef, usOf } from '../common/people.ts';
import { planGmpBatch } from '../execution/gmp-issue.ts';
import { notFound } from '../execution/runs.ts';

type Db = Pick<pg.Pool, 'query'>;

/**
 * Phase 7 slice 7g (WP4, decision 0025; IN-18): the batch-number register of a site (site.batch_number_register, site
 * services 0600), or the one number `allocationId`, in allocation order. Voided numbers stay listed.
 */
async function batchNumbers(db: Db, where: { site?: string; allocationId?: string }): Promise<BatchNumberView[]> {
  const { rows } = await db.query<Record<string, string | null>>(
    `select allocation_id::text, batch_number, site_code, edition, batch_kind, parent_batch_number, product_code, product_name, batch_size::text,
            batch_size_unit, allocation_date::text, source, rule_code, serial::text, external_reference, status, void_reason_code, void_reason_text
       from site.batch_number_register
      where ($1::text is null or site_code = $1) and ($2::uuid is null or allocation_id = $2)
      order by allocated_at, batch_number`,
    [where.site ?? null, where.allocationId ?? null],
  );
  return rows.map((r) => ({
    allocationId: r['allocation_id'] ?? '',
    batchNumber: r['batch_number'] ?? '',
    siteCode: r['site_code'] ?? '',
    edition: r['edition'] ?? '',
    batchKind: r['batch_kind'] as BatchNumberView['batchKind'],
    parentBatchNumber: r['parent_batch_number'] ?? null,
    productCode: r['product_code'] ?? '',
    productName: r['product_name'] ?? '',
    batchSize: r['batch_size'] ?? '0',
    batchSizeUnit: r['batch_size_unit'] ?? '',
    allocationDate: r['allocation_date'] ?? '',
    source: r['source'] as BatchNumberView['source'],
    ruleCode: r['rule_code'] ?? null,
    serial: r['serial'] ?? null,
    externalReference: r['external_reference'] ?? null,
    status: r['status'] as BatchNumberView['status'],
    voidReasonCode: r['void_reason_code'] ?? null,
    voidReasonText: r['void_reason_text'] ?? null,
  }));
}

/**
 * Owner decision of 13 November 2026 (retest item 9c; IN-18, INV-27): the serials each numbering rule of the site skipped,
 * with the reason the database recorded (site.batch_number_retired_ranges, site-services 1924). Display and audit only.
 */
async function retiredRanges(app: AppContext, db: Db, site: string): Promise<RetiredSerialRangeView[]> {
  const { rows } = await db.query<{ rule_code: string; first_serial: string; last_serial: string; first_number: string | null; last_number: string | null; reason: RetiredSerialRangeView['reason']; at_us: string }>(
    `select r.rule_code, r.first_serial::text, r.last_serial::text, r.first_number, r.last_number, r.reason, ${usOf('r.recorded_at')} as at_us
       from site.batch_number_retired_ranges($1) r`,
    [site],
  );
  return rows.map((r) => ({ ruleCode: r.rule_code, firstSerial: r.first_serial, lastSerial: r.last_serial, firstNumber: r.first_number, lastNumber: r.last_number, reason: r.reason, recordedAt: app.formatInstant(r.at_us) }));
}

async function batchNumber(db: Db, allocationId: string): Promise<BatchNumberView> {
  const n = (await batchNumbers(db, { allocationId }))[0];
  if (!n) throw notFound('batch number');
  return n;
}

/**
 * Phase 7 slice 7h (WP-C, gap C1; IN-18): the numbering rules of a site (site.batch_number_rule), or the one rule `ruleId`,
 * newest first. Who defined each and when come from the row the database wrote.
 */
async function batchNumberRules(app: AppContext, db: Db, where: { site?: string; ruleId?: string }): Promise<BatchNumberRuleView[]> {
  const { rows } = await db.query<{ id: string; rule_code: string; site_code: string; product_code: string | null; batch_kind: BatchNumberRuleView['batchKind']; format: string; site_zone: string; from_us: string; reason: string; by: string; at_us: string }>(
    `select r.id::text, r.rule_code, r.site_code, r.product_code, r.batch_kind, r.format, r.site_zone, ${usOf('r.effective_from')} as from_us, r.reason,
            r.created_by_person_id::text as by, ${usOf('r.recorded_at')} as at_us
       from site.batch_number_rule r
      where ($1::text is null or r.site_code = $1) and ($2::uuid is null or r.id = $2)
      order by r.recorded_at desc, r.rule_code`,
    [where.site ?? null, where.ruleId ?? null],
  );
  const people = await peopleOf(db, rows.map((r) => r.by));
  return rows.map((r) => ({
    ruleId: r.id,
    ruleCode: r.rule_code,
    siteCode: r.site_code,
    productCode: r.product_code,
    batchKind: r.batch_kind,
    format: r.format,
    siteZone: r.site_zone,
    effectiveFrom: app.formatInstant(r.from_us),
    reason: r.reason,
    definedBy: personRef(people, r.by, 'MASTER_DATA_STEWARD'),
    recordedAt: app.formatInstant(r.at_us),
  }));
}

type NumberRoutes = Pick<typeof routes.planning, 'batchNumbers' | 'registerExternalBatchNumber' | 'voidBatchNumber' | 'recoverBatchNumber' | 'batchNumberRules' | 'defineBatchNumberRule'>;

/** The register and the issuer's acts on it: each the person's own command; every rule and right is the database's. */
function batchNumberHandlers(app: AppContext): Handlers<NumberRoutes> {
  const pool = app.pools.app;
  const command = async (ctx: { actor: () => ActorContext; idempotencyKey: string | null; requestHash: string }, sql: string, params: unknown[]): Promise<string> => {
    const out = await withIdempotentActorCommand(pool, ctx.actor(), ctx.idempotencyKey ?? '', ctx.requestHash, async (c) => ((await c.query<{ r: commands.JsonValue }>(sql, params)).rows[0]?.r ?? null));
    return typeof out.result === 'string' ? out.result : '';
  };
  const identity = (b: { productCode: string; productName: string; edition: string; batchSize: string; batchSizeUnit: string; parentBatchNumber?: string | undefined }) => ({
    product_code: b.productCode,
    product_name: b.productName,
    edition: b.edition,
    batch_size: b.batchSize,
    batch_size_unit: b.batchSizeUnit,
    parent_batch_number: b.parentBatchNumber ?? null,
  });
  return {
    batchNumbers: async ({ requireSession }) => {
      const site = requireSession().siteCode;
      return { numbers: await batchNumbers(pool, { site }), retired: await retiredRanges(app, pool, site) };
    },
    registerExternalBatchNumber: async (ctx) => {
      const s = ctx.requireSession();
      const b = ctx.body;
      const id = await command(ctx, 'select site.register_external_batch_number($1::jsonb)::text as r', [
        JSON.stringify({ ...identity(b), batch_number: b.batchNumber, batch_kind: b.batchKind, external_reference: b.externalReference, site_code: s.siteCode, site_zone: app.siteZone.current() }),
      ]);
      return batchNumber(pool, id);
    },
    voidBatchNumber: async (ctx) => {
      ctx.requireSession();
      await command(ctx, 'select site.void_batch_number($1, $2, $3)::text as r', [ctx.params.allocationId, ctx.body.reasonCode, ctx.body.reasonText]);
      return batchNumber(pool, ctx.params.allocationId);
    },
    recoverBatchNumber: async (ctx) => {
      ctx.requireSession();
      const b = ctx.body;
      const id = await command(ctx, 'select site.recover_batch_number($1::jsonb)::text as r', [
        JSON.stringify({ ...identity(b), restore_event_id: b.restoreEventId, rule_code: b.ruleCode, serial: b.serial, batch_number: b.batchNumber, evidence_reference: b.evidenceReference }),
      ]);
      return batchNumber(pool, id);
    },
    batchNumberRules: async ({ requireSession }) => ({ rules: await batchNumberRules(app, pool, { site: requireSession().siteCode }) }),
    defineBatchNumberRule: async (ctx) => {
      const s = ctx.requireSession();
      const b = ctx.body;
      // DI-22: the person's reason is the command's as well as the rule's. The site and its zone are the session's (site
      // services 0700 refuses a zone other than the site policy's).
      const out = await withIdempotentActorCommand(pool, ctx.actor({ reasonCode: 'BATCH_NUMBER_RULE', reasonText: b.reason }), ctx.idempotencyKey ?? '', ctx.requestHash, async (c) =>
        (
          await c.query<{ r: string }>('select site.define_batch_number_rule($1::jsonb)::text as r', [
            JSON.stringify({
              rule_code: b.ruleCode,
              site_code: s.siteCode,
              product_code: b.productCode ?? null,
              batch_kind: b.batchKind,
              format: b.format,
              site_zone: app.siteZone.current(),
              effective_from: b.effectiveFrom ?? null,
              reason: b.reason,
            }),
          ])
        ).rows[0]?.r ?? null,
      );
      const [rule] = await batchNumberRules(app, pool, { ruleId: typeof out.result === 'string' ? out.result : '' });
      if (!rule) throw notFound('numbering rule');
      return rule;
    },
  };
}

type BulkRow = Omit<PackagingBulkView, 'issued'> & {
  issued: { label: string; containerId: string; quantity: string; unit: 'kg' | 'g' | 'units'; personId: string; issuedUs: string }[];
};

export function plugin(scope: FastifyInstance, app: AppContext): Promise<void> {
  const pool = app.pools.app;
  bindRoutes(scope, app, routes.planning, {
    orders: async ({ requireSession }) => {
      const s = requireSession();
      const { rows } = await pool.query<{ r: PlanningOrderView[] }>('select tab.planning_orders($1) as r', [s.tokenHash]);
      return { orders: rows[0]?.r ?? [] };
    },
    packagingOrders: async ({ requireSession }) => {
      const s = requireSession();
      const { rows } = await pool.query<{ r: PackagingOrderView[] }>('select recipe.packaging_orders($1) as r', [s.siteCode]);
      return { orders: rows[0]?.r ?? [] };
    },
    planPackagingOrder: async ({ body, requireSession, actor, idempotencyKey, requestHash }) => {
      requireSession();
      return planGmpBatch(app, actor(), idempotencyKey ?? '', requestHash, {
        familyId: body.familyId,
        markets: [...new Set(body.markets)],
        site: body.site,
        line: body.line,
        batchSize: body.batchSize,
        parentBatch: body.parentBatchId,
        ...(body.erpOrder !== undefined ? { erpOrder: body.erpOrder } : {}),
      });
    },
    packagingBulk: async ({ params, requireSession }) => {
      requireSession();
      const { rows } = await pool.query<{ r: BulkRow | null }>('select recipe.packaging_order_bulk($1) as r', [params.batchId]);
      const r = rows[0]?.r;
      if (!r) throw notFound('packaging order');
      const people = await peopleOf(pool, r.issued.map((i) => i.personId));
      // R10 #12: the order's finished lot once posted, so the screen gives it back instead of the post.
      const lot = (
        await pool.query<{ lotId: string; lotCode: string }>('select f.lot_id as "lotId", l.lot_code as "lotCode" from site.finished_lot f join site.material_lot l on l.id = f.lot_id where f.batch_id = $1', [params.batchId])
      ).rows[0];
      return {
        ...r,
        finishedLot: lot ?? null,
        issued: r.issued.map((i) => ({
          label: i.label,
          containerId: i.containerId,
          quantity: i.quantity,
          unit: i.unit,
          issuedBy: personRef(people, i.personId, 'OPERATOR'),
          issuedAt: app.formatInstant(i.issuedUs),
        })),
      };
    },
    // Phase 7 slice 7g (WP4): the batch-number register and the issuer's acts on it.
    ...batchNumberHandlers(app),
  });
  return Promise.resolve();
}
