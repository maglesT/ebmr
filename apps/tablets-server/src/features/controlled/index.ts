/**
 * Feature `controlled` (Phase 6 slice 6e, GMP; contract ns/controlled.ts): controlled-substance mode, draft control IN-53
 * (status U: NDPS Act and Rules not verified). Every rule is the database's (recipe-core 1031 to 1034, site services
 * 0970); each route runs the person's own command.
 *
 *  - products: QA records a flag under the change record the request names (ActorContext.changeRecord, DI-09); a
 *    second QA person approves it with CONTROLLED_ACT FLAG_APPROVE.
 *  - custody: the first custodian proposes a record and signs it (CUSTODY_FIRST); another person countersigns it
 *    (CUSTODY_SECOND). The dispensing step then consumes against it (the database's guard on the consumption).
 *  - balance and checkpoints: the account per controlled material of a batch; the checkpoint is recorded here and signed
 *    with BALANCE_SIGN; a stage sign-off without it is refused by the database.
 *  - register extracts: run, list and read (with whether the result still reproduces).
 * Every read is the session's own (Phase 7 slice 7a, 6jc-R2): tablets 1413 needs CONTROLLED.READ in the record's scope,
 * else EBMR-CSM-060 or 061 (403).
 * The signed records are GOVERNANCE-class: their content is read through tablets 1250 (tab.controlled_preview,
 * tab.controlled_signing_content), as the support grants' is through 1275.
 */
import { routes, type SignableAction, type SignableContentView } from '@ebmr/api-contract';
import type { commands } from '@ebmr/kernel';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import type { AppContext } from '../../platform/context.ts';
import { withIdempotentActorCommand } from '../../platform/db/commands.ts';
import { bindRoutes } from '../../platform/http/bind.ts';
import type { GuidanceEntry } from '../../platform/http/guidance.ts';
import { refusal } from '../../platform/http/refusal.ts';
import type { SignableActionHandler, SignableActionRegistry } from '../../platform/ports.ts';
import { compact } from '../common/people.ts';
import { contentNotFound, contentOf, type EsigSignableContext } from '../esig/content.ts';
import { refusedOutcome } from '../esig/db-acts.ts';
import { meaningInfo } from '../esig/views.ts';
import { BANNER, balanceView, checkpointViews, custodyViews, extractViews, productViews } from './reads.ts';

type JsonValue = commands.JsonValue;
type ControlledAct = Extract<SignableAction, { kind: 'CONTROLLED_ACT' }>;

export const guidance: Readonly<Record<string, GuidanceEntry>> = {
  'EBMR-CSM-*': {
    status: 422,
    kind: 'NOT_ALLOWED',
    whatHappened: 'Controlled-substance mode refused this.',
    whatYouCanDo: ['Read the reason below; the controlled-substance page shows the custody records and the batch account.'],
    whoCanHelp: ['QA', 'The shift supervisor'],
    controls: ['IN-53'],
  },
  // Phase 7 slice 7a (6jc-R2): the reads need CONTROLLED.READ in the record's scope (tablets 1413, 1414).
  'EBMR-CSM-060': {
    status: 403,
    kind: 'NOT_ALLOWED',
    whatHappened: 'Controlled-substance records are read only by the controlled-substance roles and QA. Nothing of them is shown.',
    whatYouCanDo: ['Ask a custodian, the shift supervisor or QA.'],
    whoCanHelp: ['QA', 'The system administrator (role grants)'],
    controls: ['IN-53'],
  },
  'EBMR-CSM-061': {
    status: 403,
    kind: 'NOT_ALLOWED',
    whatHappened: 'Your role reads controlled-substance records only for another site or product. Nothing of this one is shown.',
    whatYouCanDo: ['Ask a person whose role covers this site and product.'],
    whoCanHelp: ['QA', 'The system administrator (role grants)'],
    controls: ['IN-53'],
  },
  'EBMR-CSM-020': {
    status: 422,
    kind: 'INDEPENDENCE',
    whatHappened: 'A controlled API is dispensed only under dual custody.',
    whatYouCanDo: ['Propose the dispensing of this lot, batch and exact net on the controlled-substance page, sign it, have a second person countersign it, then weigh again.'],
    whoCanHelp: ['A second custodian (verifier or supervisor)'],
    controls: ['IN-53'],
  },
  'EBMR-CSM-042': {
    status: 422,
    kind: 'NOT_ALLOWED',
    whatHappened: 'This stage is a yield checkpoint of the controlled API account and its account is not closed.',
    whatYouCanDo: ['Record the account of each controlled API at this stage and sign it; explain any difference with the deviation raised for it.'],
    whoCanHelp: ['The shift supervisor', 'QA'],
    controls: ['IN-53'],
  },
};

/** A write whose record the writer's session may not read back (EBMR-CSM-061; nothing was committed). */
const unreadable = () =>
  refusal(403, {
    code: 'EBMR-CSM-061',
    kind: 'NOT_ALLOWED',
    whatHappened: 'Your role may not read this controlled-substance record back. Nothing was recorded.',
    why: 'The record would be outside the scope in which your role holds CONTROLLED.READ (IN-53).',
    whatYouCanDo: ['Ask a person whose role covers this site and product.'],
    controls: ['IN-53'],
  });

const notFound = (what: string) =>
  refusal(404, { code: 'EBMR-API-NOT-FOUND', kind: 'STALE', whatHappened: `The ${what} was not found.`, why: `No such ${what}.`, whatYouCanDo: ['Reload the page.'] });

const TARGET: Readonly<Record<ControlledAct['act'], { aggregateType: string; meaning: string; expectedState: string }>> = {
  FLAG_APPROVE: { aggregateType: 'controlled_product', meaning: 'CONTROLLED_PRODUCT_APPROVED', expectedState: 'RECORDED' },
  CUSTODY_FIRST: { aggregateType: 'controlled_custody', meaning: 'CONTROLLED_CUSTODY_RECORDED', expectedState: 'PROPOSED' },
  CUSTODY_SECOND: { aggregateType: 'controlled_custody', meaning: 'CONTROLLED_CUSTODY_COUNTERSIGNED', expectedState: 'AWAITING_COUNTERSIGN' },
  BALANCE_SIGN: { aggregateType: 'controlled_checkpoint', meaning: 'CONTROLLED_BALANCE_SIGNED', expectedState: 'RECORDED' },
};

/** CONTROLLED_ACT: the flag approval, a custodian's place, or the checkpoint, signed through the ceremony (IN-53). */
export function controlledActHandler(app: AppContext): SignableActionHandler<ControlledAct> {
  const content = async (client: pg.PoolClient, a: ControlledAct) => {
    const t = TARGET[a.act];
    const { rows } = await client.query<{ r: Record<string, unknown> }>('select tab.controlled_signing_content($1, $2, $3) as r', [t.aggregateType, a.subjectId, t.meaning]);
    return contentOf(t.aggregateType, a.subjectId, rows[0]?.r ?? {});
  };
  return {
    kind: 'CONTROLLED_ACT',
    aggregateTypes: ['controlled_product', 'controlled_custody', 'controlled_checkpoint'],
    describe: (a) => ({ ...TARGET[a.act], aggregateId: a.subjectId }),
    async previewContent(ctx, query): Promise<SignableContentView> {
      const meaning = await meaningInfo(app.pools.app, query.intent);
      const { rows } = await app.pools.app.query<{ r: Record<string, unknown> }>('select tab.controlled_preview($1, $2, $3, $4) as r', [
        (ctx as Partial<EsigSignableContext>).tokenHash ?? '',
        query.aggregateType,
        query.aggregateId,
        meaning.code,
      ]);
      const c = contentOf(query.aggregateType, query.aggregateId, rows[0]?.r ?? {});
      if (!c.exists || !c.canonical || !c.contentHash || !c.contentVersion) throw contentNotFound(query.aggregateType, query.aggregateId);
      const body = (JSON.parse(c.canonical) as { content?: Record<string, unknown> }).content ?? {};
      return {
        aggregateType: query.aggregateType,
        aggregateId: query.aggregateId,
        contentVersion: c.contentVersion,
        canonicalText: c.canonical,
        contentHash: c.contentHash,
        meaning: meaning.code,
        meaningText: meaning.text,
        title: `${meaning.title}: ${typeof body['title'] === 'string' ? body['title'] : `${query.aggregateType} ${query.aggregateId}`}`,
        preview: false,
        rendering: { kind: 'fallback', state: c.state ?? null, content: body },
      };
    },
    async prepareForChallenge(client, _ctx, a) {
      const c = await content(client, a);
      return { contentVersion: c.contentVersion ?? '0', contentHash: c.contentHash ?? '', changed: false };
    },
    async dryRun(client, _ctx, a) {
      const c = await content(client, a);
      if (!c.exists || !c.contentHash || !c.contentVersion) {
        return refusedOutcome(404, 'EBMR-API-NO-RECORD', 'The record to be signed was not found. Nothing was signed.', `${TARGET[a.act].aggregateType} ${a.subjectId} does not exist.`, ['IN-53'], ['Reload the page.']);
      }
      return { accepted: true, contentHash: c.contentHash, contentVersion: c.contentVersion };
    },
    async apply(client, _ctx, a, signature) {
      switch (a.act) {
        case 'FLAG_APPROVE':
          await client.query('select plant.approve_controlled_product($1, $2)', [a.subjectId, signature.signatureId]);
          return { act: a.act, recordId: a.subjectId };
        case 'CUSTODY_FIRST':
        case 'CUSTODY_SECOND': {
          const { rows } = await client.query<{ s: string }>('select recipe.sign_controlled_custody($1, $2) as s', [a.subjectId, signature.signatureId]);
          return { act: a.act, custodyId: a.subjectId, state: rows[0]?.s ?? null };
        }
        case 'BALANCE_SIGN':
          await client.query('select recipe.sign_controlled_checkpoint($1, $2)', [a.subjectId, signature.signatureId]);
          return { act: a.act, checkpointId: a.subjectId };
      }
    },
  };
}

export function registerSignableActions(registry: SignableActionRegistry, app: AppContext): void {
  if (app.installation !== 'GMP') return;
  registry.register(controlledActHandler(app));
}

export function plugin(scope: FastifyInstance, app: AppContext): Promise<void> {
  const pool = app.pools.app;
  type Ctx = { actor: () => Parameters<typeof withIdempotentActorCommand>[1]; idempotencyKey: string | null | undefined; requestHash: string };
  /**
   * The gated read (tablets 1413) that must show the record just written to the writer's session, run in the write's own
   * transaction: a writer who may not read it back (no CONTROLLED.READ in its scope) is refused and nothing is committed,
   * rather than refused after a committed write (6jc-R2 review). `id` is the definer's result.
   */
  type ReadBack = { sql: string; params: (id: string) => unknown[] };
  /** One write as the person's own command (idempotent by the request's key); the definer's result. */
  const write = async (ctx: Ctx, sql: string, params: unknown[], readBack: ReadBack, over: Record<string, unknown> = {}): Promise<string> => {
    const { result } = await withIdempotentActorCommand(pool, { ...ctx.actor(), ...over }, ctx.idempotencyKey ?? '', ctx.requestHash, async (c) => {
      const r = (await c.query<{ r: JsonValue }>(sql, params)).rows[0]?.r ?? null;
      const id = typeof r === 'string' ? r : '';
      const shown = (await c.query<{ r: { id: string }[] | null }>(readBack.sql, readBack.params(id))).rows[0]?.r ?? [];
      if (!shown.some((x) => x.id === id)) throw unreadable();
      return r;
    });
    return typeof result === 'string' ? result : '';
  };
  bindRoutes(scope, app, routes.controlled, {
    products: async ({ requireSession }) => {
      return { banner: BANNER, products: await productViews(app, pool, requireSession().tokenHash) };
    },
    recordProduct: async ({ body, actor, idempotencyKey, requestHash, requireSession }) => {
      const { attribution: _a, changeRecord, ...p } = body;
      void _a;
      await write({ actor, idempotencyKey, requestHash }, 'select plant.record_controlled_product($1::jsonb)::text as r', [JSON.stringify(p)], {
        sql: 'select tab.controlled_products($1, $2) as r',
        params: () => [requireSession().tokenHash, p.productCode],
      }, { changeRecord });
      const [v] = await productViews(app, pool, requireSession().tokenHash, p.productCode);
      if (!v) throw notFound(`product ${p.productCode}`);
      return v;
    },
    custody: async ({ query, requireSession }) => {
      return { banner: BANNER, records: await custodyViews(app, pool, requireSession().tokenHash, query) };
    },
    proposeCustody: async ({ body, actor, idempotencyKey, requestHash, requireSession }) => {
      const { attribution: _a, ...p } = body;
      void _a;
      const id = await write({ actor, idempotencyKey, requestHash }, 'select recipe.propose_controlled_custody($1::jsonb)::text as r', [JSON.stringify(compact(p))], {
        sql: 'select tab.controlled_custody($1, null, null, $2::uuid) as r',
        params: (id) => [requireSession().tokenHash, id],
      });
      const [v] = await custodyViews(app, pool, requireSession().tokenHash, { custodyId: id });
      if (!v) throw notFound('custody record');
      return v;
    },
    balance: async ({ params, requireSession }) => {
      const v = await balanceView(app, pool, requireSession().tokenHash, params.batchId);
      if (!v) throw notFound('batch');
      return v;
    },
    recordCheckpoint: async ({ body, actor, idempotencyKey, requestHash, requireSession }) => {
      const { attribution: _a, ...p } = body;
      void _a;
      const id = await write({ actor, idempotencyKey, requestHash }, 'select recipe.record_controlled_checkpoint($1::jsonb)::text as r', [JSON.stringify(compact(p))], {
        sql: 'select tab.controlled_checkpoints($1, null, $2::uuid) as r',
        params: (id) => [requireSession().tokenHash, id],
      });
      const [v] = await checkpointViews(app, pool, requireSession().tokenHash, { checkpointId: id });
      if (!v) throw notFound('checkpoint');
      return v;
    },
    registerExtracts: async ({ requireSession }) => {
      return { banner: BANNER, extracts: (await extractViews(app, pool, requireSession().tokenHash)).summaries };
    },
    runRegister: async ({ body, actor, idempotencyKey, requestHash, requireSession }) => {
      const id = await write({ actor, idempotencyKey, requestHash }, 'select recipe.run_controlled_register($1, $2::date, $3::date)::text as r', [body.materialCode, body.from, body.to], {
        sql: 'select tab.controlled_register_extracts($1, $2::uuid) as r',
        params: (id) => [requireSession().tokenHash, id],
      });
      const { full } = await extractViews(app, pool, requireSession().tokenHash, id);
      if (!full) throw notFound('register export');
      return full;
    },
    registerExtract: async ({ params, requireSession }) => {
      const { full } = await extractViews(app, pool, requireSession().tokenHash, params.extractId);
      if (!full) throw notFound('register export');
      return full;
    },
  });
  return Promise.resolve();
}
