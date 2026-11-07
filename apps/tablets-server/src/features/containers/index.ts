/**
 * Feature `containers` (Phase 4 slice 1b, GMP): the output containers of a batch over HTTP (contract ns/containers.ts):
 * open, close (weighed from two scale readings of the session's room, or typed), sort and reject, and the signed acts
 * CONTAINER_ACT VERIFY_CLOSE (the second person's VERIFIED check of a typed net, DI-30) and RELEASE (QA's
 * OUTPUT_CONTAINER_RELEASED once the hold is explained). Every write is the person's own command; every rule is the
 * database's (recipe-core 0420 to 0422, 0740, 0741; tablets 1111). The views show the database's own reasons why a
 * container is not usable (plant.container_usable_problem) or not releasable (plant.container_release_problem).
 * API plan A4c (recipe-core 1881, 1882, 1882): QA's own hold of a closed or released container (plant.hold_container, with QA's
 * reason); `qaHoldable` is the database's answer whether the container's machine version takes QA_HOLD in its state.
 */
import { routes, type ContainerView, type SignableAction } from '@ebmr/api-contract';
import type { ActorContext } from '@ebmr/kernel';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import type { AppContext } from '../../platform/context.ts';
import { withIdempotentActorCommand } from '../../platform/db/commands.ts';
import { bindRoutes } from '../../platform/http/bind.ts';
import { refusal } from '../../platform/http/refusal.ts';
import type { SignableActionHandler, SignableActionRegistry } from '../../platform/ports.ts';
import { peopleOf, personRef, usOf } from '../common/people.ts';
import { dbActHandler } from '../esig/db-acts.ts';

type Db = Pick<pg.Pool, 'query'>;
type ContainerAct = Extract<SignableAction, { kind: 'CONTAINER_ACT' }>;

const notFound = () => refusal(404, { code: 'EBMR-API-NOT-FOUND', kind: 'STALE', whatHappened: 'The container was not found.', why: 'No such output container.', whatYouCanDo: ['Reload the list.'] });

interface Row {
  id: string;
  label_code: string;
  batch_id: string;
  batch_number: string;
  stage: string;
  press_code: string | null;
  stream: string | null;
  quantity_unit: 'kg' | 'g' | 'units';
  state: ContainerView['state'];
  version: string;
  opened_by_person: string;
  opened_us: string;
  net: string | null;
  basis: 'WEIGHED' | 'TYPED' | null;
  closed_by: string | null;
  closed_us: string | null;
  verified_by: string | null;
  holds: { checkId: string; result: 'FAIL' | 'MISSED'; press: string; stream: string | null; reference: string; us: string }[];
  qa_holds: { reasonCode: string; reasonText: string; personId: string; us: string }[];
  qa_holdable: boolean;
  usable_problem: string | null;
  release_problem: string | null;
}

/** The containers of batch `batchId` (or the one container `id`), oldest first. */
async function containerViews(app: AppContext, db: Db, filter: { batchId?: string; id?: string }): Promise<ContainerView[]> {
  const { rows } = await db.query<Row>(
    `select c.id, c.label_code, c.batch_id, c.batch_number, c.stage, c.press_code, c.stream, c.quantity_unit, s.state, s.version::text as version,
            c.opened_by_person, ${usOf('c.opened_at')} as opened_us, x.net_quantity::text as net, x.basis, x.person_id as closed_by,
            case when x.closed_at is null then null else ${usOf('x.closed_at')} end as closed_us, v.person_id as verified_by,
            coalesce((select jsonb_agg(jsonb_build_object('checkId', k.id, 'result', k.result, 'press', k.press_code, 'stream', k.stream, 'reference', k.reference,
                                                          'us', ${usOf('k.recorded_at')}) order by h.recorded_at, h.id)
                        from plant.container_hold h join plant.ipc_check k on k.id = h.ipc_check_id where h.container_id = c.id), '[]'::jsonb) as holds,
            coalesce((select jsonb_agg(jsonb_build_object('reasonCode', coalesce(sh.reason_code, ''), 'reasonText', coalesce(sh.reason_text, ''), 'personId', sh.person_id,
                                                          'us', ${usOf('sh.recorded_at')}) order by sh.to_version)
                        from platform.state_history sh where sh.aggregate_type = 'output_container' and sh.aggregate_id = c.id and sh.event = 'QA_HOLD'), '[]'::jsonb) as qa_holds,
            exists (select 1 from platform.machine_transition t where t.machine_code = s.machine_code and t.machine_version = s.machine_version
                       and t.from_state = s.state and t.event = 'QA_HOLD') as qa_holdable,
            plant.container_usable_problem(c.id) as usable_problem,
            case when s.state in ('HELD', 'SORTED') then plant.container_release_problem(c.id) end as release_problem
       from plant.output_container c
       join platform.aggregate_state s on s.aggregate_type = 'output_container' and s.aggregate_id = c.id
       left join plant.container_close x on x.container_id = c.id
       left join plant.container_close_verification v on v.container_id = c.id
      where ($1::uuid is null or c.batch_id = $1) and ($2::uuid is null or c.id = $2)
      order by c.opened_at, c.id`,
    [filter.batchId ?? null, filter.id ?? null],
  );
  const people = await peopleOf(db, rows.flatMap((r) => [r.opened_by_person, r.closed_by, r.verified_by, ...r.qa_holds.map((h) => h.personId)]));
  return rows.map((r) => ({
    containerId: r.id,
    label: r.label_code,
    batchId: r.batch_id,
    batchNumber: r.batch_number,
    stage: r.stage,
    press: r.press_code,
    stream: r.stream,
    unit: r.quantity_unit,
    state: r.state,
    version: Number(r.version),
    openedBy: personRef(people, r.opened_by_person, 'OPERATOR'),
    openedAt: app.formatInstant(r.opened_us),
    netQuantity: r.net,
    closeBasis: r.basis,
    closedBy: r.closed_by ? personRef(people, r.closed_by, 'OPERATOR') : null,
    closedAt: r.closed_us ? app.formatInstant(r.closed_us) : null,
    netVerifiedBy: r.verified_by ? personRef(people, r.verified_by, 'VERIFIER') : null,
    holds: r.holds.map((h) => ({ checkId: h.checkId, result: h.result, press: h.press, stream: h.stream, reference: h.reference, recordedAt: app.formatInstant(h.us) })),
    qaHolds: r.qa_holds.map((h) => ({ reasonCode: h.reasonCode, reasonText: h.reasonText, by: personRef(people, h.personId, 'QA'), recordedAt: app.formatInstant(h.us) })),
    qaHoldable: r.qa_holdable,
    usableProblem: r.usable_problem,
    releaseProblem: r.release_problem,
  }));
}

async function containerView(app: AppContext, db: Db, id: string): Promise<ContainerView> {
  const v = (await containerViews(app, db, { id }))[0];
  if (!v) throw notFound();
  return v;
}

const ACTS: Readonly<Record<ContainerAct['act'], string>> = { VERIFY_CLOSE: 'VERIFIED', RELEASE: 'OUTPUT_CONTAINER_RELEASED' };

export function containerActHandler(app: AppContext): SignableActionHandler<ContainerAct> {
  return dbActHandler<ContainerAct>(app, {
    kind: 'CONTAINER_ACT',
    aggregateTypes: ['output_container'],
    target: (a) => ({ aggregateType: 'output_container', aggregateId: a.containerId, meaning: ACTS[a.act] }),
    reasonOf: (a) => (a.reason ? { reasonCode: a.reason.code, reasonText: a.reason.text } : undefined),
    async apply(client, _ctx, a, signatureId) {
      if (a.act === 'VERIFY_CLOSE') {
        await client.query('select plant.verify_container_close($1, $2)', [a.containerId, signatureId]);
      } else {
        const { rows } = await client.query<{ v: string }>("select version::text as v from platform.aggregate_state where aggregate_type = 'output_container' and aggregate_id = $1", [a.containerId]);
        await client.query('select plant.release_container($1, $2::bigint, $3)', [a.containerId, rows[0]?.v ?? '0', signatureId]);
      }
      return { act: a.act, containerId: a.containerId };
    },
  });
}

export function registerSignableActions(registry: SignableActionRegistry, app: AppContext): void {
  registry.register(containerActHandler(app));
}

export function plugin(scope: FastifyInstance, app: AppContext): Promise<void> {
  const pool = app.pools.app;
  /** One idempotent command of the person's (with their own reason when the act needs one); the database's answer as an id. */
  const write = async (
    ctx: { actor: () => ActorContext & { deviceId: string }; idempotencyKey: string | null; requestHash: string },
    work: (c: pg.PoolClient) => Promise<string>,
    reason?: { code: string; text: string },
  ): Promise<string> => {
    const actor = reason ? { ...ctx.actor(), reasonCode: reason.code, reasonText: reason.text } : ctx.actor();
    const out = await withIdempotentActorCommand(pool, actor, ctx.idempotencyKey ?? '', ctx.requestHash, work);
    return typeof out.result === 'string' ? out.result : '';
  };
  const one = async <T>(c: pg.PoolClient, sql: string, params: unknown[]): Promise<T> => (await c.query<{ r: T }>(sql, params)).rows[0]?.r as T;
  bindRoutes(scope, app, routes.containers, {
    list: async ({ query, requireSession }) => {
      requireSession();
      return { containers: await containerViews(app, pool, { batchId: query.batchId }) };
    },
    open: async (ctx) => {
      ctx.requireSession();
      const b = ctx.body;
      const id = await write(ctx, async (c) =>
        (await one<{ container_id: string }>(c, 'select plant.open_container($1, $2, $3, $4, $5) as r', [b.batchId, b.stage, b.unit, b.press ?? null, b.stream ?? null])).container_id,
      );
      return containerView(app, pool, id);
    },
    close: async (ctx) => {
      ctx.requireSession();
      const { weighing, typed, expectedVersion } = ctx.body;
      await write(ctx, async (c) => {
        if (weighing) await c.query('select tab.close_container_weighed($1, $2, $3, $4)', [ctx.params.containerId, weighing.tareReadingId, weighing.grossReadingId, expectedVersion]);
        else await c.query('select plant.close_container($1, $2::numeric, $3)', [ctx.params.containerId, typed?.net ?? null, expectedVersion]);
        return ctx.params.containerId;
      });
      return containerView(app, pool, ctx.params.containerId);
    },
    sort: async (ctx) => {
      ctx.requireSession();
      await write(ctx, async (c) => {
        await c.query('select plant.sort_container($1, $2)', [ctx.params.containerId, ctx.body.expectedVersion]);
        return ctx.params.containerId;
      }, ctx.body.reason);
      return containerView(app, pool, ctx.params.containerId);
    },
    reject: async (ctx) => {
      ctx.requireSession();
      await write(ctx, async (c) => {
        await c.query('select plant.reject_container($1, $2)', [ctx.params.containerId, ctx.body.expectedVersion]);
        return ctx.params.containerId;
      }, ctx.body.reason);
      return containerView(app, pool, ctx.params.containerId);
    },
    // API plan A4c (recipe-core 1881, 1882, 1882): QA holds a closed or released container with its own reason (QA.FLOOR_APPROVE).
    hold: async (ctx) => {
      ctx.requireSession();
      await write(ctx, async (c) => {
        await c.query('select plant.hold_container($1, $2)', [ctx.params.containerId, ctx.body.expectedVersion]);
        return ctx.params.containerId;
      }, ctx.body.reason);
      return containerView(app, pool, ctx.params.containerId);
    },
    // Phase 7 slice 7g (WP4, decision 0025): a merge of two scanned containers (recipe-core 0422; IN-26 (c), L-30): the
    // database finds both labels, checks the right (STEP.EXECUTE for the product), the same batch, stage and unit, a
    // usable source and an open, unheld target.
    merge: async (ctx) => {
      ctx.requireSession();
      const target = await write(ctx, async (c) => (await one<{ target_id: string }>(c, 'select plant.merge_container($1, $2) as r', [ctx.body.sourceLabel, ctx.body.targetLabel])).target_id);
      return containerView(app, pool, target);
    },
  });
  return Promise.resolve();
}
