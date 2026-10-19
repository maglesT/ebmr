/**
 * Floor acts beside the engine's entries (Phase 7 slice 7g, WP4; decision 0025: every act has a screen):
 *  - the batch data of a G-21 packaging step (tab.record_packaging_batch_data, tablets 0951 as replaced by 1201): the
 *    database computes the batch number, the manufacture date and the expiry from the product master; the person gives
 *    the MRP where the market's pack shows it; a new version only with the person's own reason, which voids the print
 *    jobs released on the earlier data (L-29, DI-22);
 *  - the second person's check of a version with an MRP (tab.check_packaging_batch_data: STEP.VERIFY, never the person
 *    who gave it; IN-31);
 *  - the release of a print job to a printer of the step (tab.release_print_job: the record's data only, a checked MRP,
 *    the line cleared for the order; PR-36);
 *  - a metal-detector or reject-gate challenge of a press in use by the batch (tab.record_detector_challenge, tablets
 *    0872: certified test pieces of the register; a failure holds the press output, IN-36). The TB-17 CHALLENGE entry
 *    then names the challenge.
 * Every act is the person's own idempotent command; every rule and right is the database's.
 */
import type { DetectorChallengeView, PackagingBatchDataView, routes } from '@ebmr/api-contract';
import type pg from 'pg';
import type { AppContext } from '../../platform/context.ts';
import { withIdempotentActorCommand } from '../../platform/db/commands.ts';
import type { HandlerContext } from '../../platform/http/bind.ts';
import { peopleOf, personRef, usOf } from '../common/people.ts';

type Db = Pick<pg.Pool, 'query'>;
type Ctx<R extends keyof typeof routes.execution> = HandlerContext<(typeof routes.execution)[R]>;

interface DataRow {
  id: string;
  version: number;
  fields: Record<string, string>;
  reason: string | null;
  recorded_by_person: string;
  recorded_us: string;
  checked_by_person: string | null;
  checked_us: string | null;
}

export async function packagingBatchDataView(app: AppContext, db: Db, batchId: string, stepKey: string): Promise<PackagingBatchDataView> {
  const [data, jobs] = await Promise.all([
    db.query<DataRow>(
      `select d.id, d.version, d.fields, d.reason, d.recorded_by_person, ${usOf('d.recorded_at')} as recorded_us, c.checked_by_person,
              case when c.data_id is null then null else ${usOf('c.checked_at')} end as checked_us
         from tab.packaging_batch_data d left join tab.packaging_batch_data_check c on c.data_id = d.id
        where d.batch_id = $1 and d.step_key = $2 order by d.version desc limit 1`,
      [batchId, stepKey],
    ),
    db.query<{ id: string; config_device: string; layout_ref: string; data_version: number; state: string; released_by_person: string; released_us: string }>(
      `select j.id, j.config_device, j.layout_ref, j.data_version, tab.print_job_state(j.id) as state, j.released_by_person, ${usOf('j.released_at')} as released_us
         from tab.print_job j where j.batch_id = $1 and j.step_key = $2 order by j.released_at, j.id`,
      [batchId, stepKey],
    ),
  ]);
  const d = data.rows[0];
  const people = await peopleOf(db, [d?.recorded_by_person, d?.checked_by_person, ...jobs.rows.map((j) => j.released_by_person)]);
  return {
    batchId,
    stepKey,
    current: d
      ? {
          version: d.version,
          fields: d.fields,
          reason: d.reason,
          recordedBy: personRef(people, d.recorded_by_person, 'OPERATOR'),
          recordedAt: app.formatInstant(d.recorded_us),
          checkedBy: d.checked_by_person ? personRef(people, d.checked_by_person, 'VERIFIER') : null,
          checkedAt: d.checked_us ? app.formatInstant(d.checked_us) : null,
        }
      : null,
    jobs: jobs.rows.map((j) => ({
      jobId: j.id,
      device: j.config_device,
      layout: j.layout_ref,
      dataVersion: j.data_version,
      state: j.state,
      releasedBy: personRef(people, j.released_by_person, 'OPERATOR'),
      releasedAt: app.formatInstant(j.released_us),
    })),
  };
}

type WriteCtx = Pick<Ctx<'recordPackagingBatchData'>, 'requireSession' | 'actor' | 'idempotencyKey' | 'requestHash'>;

/** One idempotent command of the person's: the database's answer as JSON. */
async function write(app: AppContext, ctx: WriteCtx, sql: string, params: unknown[]): Promise<unknown> {
  ctx.requireSession();
  const out = await withIdempotentActorCommand(app.pools.app, ctx.actor(), ctx.idempotencyKey ?? '', ctx.requestHash, async (c) => {
    const { rows } = await c.query<{ r: unknown }>(sql, params);
    return (rows[0]?.r ?? null) as never;
  });
  return out.result;
}

export function floorActHandlers(app: AppContext) {
  const pool = app.pools.app;
  return {
    packagingBatchData: (ctx: Ctx<'packagingBatchData'>) => {
      ctx.requireSession();
      return packagingBatchDataView(app, pool, ctx.query.batchId, ctx.query.stepKey);
    },
    recordPackagingBatchData: async (ctx: Ctx<'recordPackagingBatchData'>) => {
      const b = ctx.body;
      await write(app, ctx, 'select tab.record_packaging_batch_data($1, $2, $3, $4) as r', [b.batchId, b.stepKey, b.mrp ?? null, b.reason ?? null]);
      return packagingBatchDataView(app, pool, b.batchId, b.stepKey);
    },
    checkPackagingBatchData: async (ctx: Ctx<'checkPackagingBatchData'>) => {
      const b = ctx.body;
      await write(app, ctx, 'select tab.check_packaging_batch_data($1, $2, $3) as r', [b.batchId, b.stepKey, b.version]);
      return packagingBatchDataView(app, pool, b.batchId, b.stepKey);
    },
    releasePrintJob: async (ctx: Ctx<'releasePrintJob'>) => {
      const b = ctx.body;
      await write(app, ctx, 'select tab.release_print_job($1, $2, $3, $4) as r', [b.batchId, b.stepKey, b.device, b.layout]);
      return packagingBatchDataView(app, pool, b.batchId, b.stepKey);
    },
    recordDetectorChallenge: async (ctx: Ctx<'recordDetectorChallenge'>): Promise<DetectorChallengeView> => {
      const b = ctx.body;
      const r = (await write(app, ctx, 'select tab.record_detector_challenge($1, $2, $3, $4, $5, $6::jsonb) as r', [b.batchId, b.press, b.device, b.deviceCode, b.timing, JSON.stringify(b.pieces)])) as {
        challengeId: string;
        passed: boolean;
        hold: { pending?: string[]; held?: string[] } | null;
      };
      const held = [...(r.hold?.held ?? []), ...(r.hold?.pending ?? [])];
      return { challengeId: r.challengeId, passed: r.passed, held };
    },
  };
}
