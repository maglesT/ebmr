/**
 * Feature `analytics` (Phase 6A slice 6A-1, GMP; contract ns/analytics.ts and ns/analytics-config.ts; kernel 1240 to
 * 1245; ADR 0020): the advisory analytics screens' routes. It reads the analytics.*_v1 views as the application role,
 * and the flags about a person or an account only through the definer functions that check ANALYTICS.DI_REVIEW (DI-53).
 * Its writes are QA's dispositions (analytics.record_disposition, as the person; DI-52) and method versions and
 * reference sets under an approved change record (analytics.set_method_version, set_reference_set; DI-52, DI-09).
 * Nothing here writes GMP data (DI-51), and no other feature imports this one or the runner
 * (dependency-cruiser no-gmp-feature-imports-analytics). Every read needs ANALYTICS.VIEW; the sandbox serves none of
 * these routes (they are GMP only and answer 404 there; D-6A-6).
 */
import { routes, type AnalyticsDispositionResult, type FlagView } from '@ebmr/api-contract';
import { commands } from '@ebmr/kernel';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { codeIdentity, methodDefinitionProblems, parametersSha256 } from '../../analytics/catalog.ts';
import type { AppContext } from '../../platform/context.ts';
import { withActorCommand, withIdempotentActorCommand } from '../../platform/db/commands.ts';
import { bindRoutes } from '../../platform/http/bind.ts';
import { HttpRefusal, refusal } from '../../platform/http/refusal.ts';
import { peopleOf } from '../common/people.ts';
import { ANALYTICS_GUIDANCE } from './guidance.ts';
import {
  catalog,
  dispositionsOf,
  dispositionViews,
  envelope,
  flagViews,
  methodVersions,
  monitor,
  referenceSets,
  restrictedFlags,
  unrestrictedFlags,
  type FlagRow,
} from './reads.ts';

export const guidance = ANALYTICS_GUIDANCE;

type Actor = Parameters<typeof withActorCommand>[1];

const notFound = () =>
  refusal(404, { code: 'EBMR-ANA-016', kind: 'INVALID_INPUT', whatHappened: 'There is no such advisory flag you may see.', whatYouCanDo: ['Reload the list of flags.'], whoCanHelp: ['QA'] });

const RESTRICTED = new Set(['PERSON', 'ACCOUNT']);

/** JSON text that must be an object (a method version's parameters or acceptance criteria). */
function jsonObject(text: string, what: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    value = undefined;
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw refusal(422, { code: 'EBMR-ANA-015', kind: 'INVALID_INPUT', whatHappened: 'The method version was not recorded.', why: `The ${what} are not a JSON object.`,
                         whatYouCanDo: [`Give the ${what} as a JSON object.`], whoCanHelp: ['QA'], controls: ['DI-52'] });
  }
  return value as Record<string, unknown>;
}

/** Runs a read as the person, after the database checks the permission (ANALYTICS.VIEW unless another is named). */
async function asViewer<T>(pool: pg.Pool, actor: Actor, work: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  try {
    return await withActorCommand(pool, actor, async (c) => {
      await c.query("select iam.require_permission('ANALYTICS.VIEW', '{}'::jsonb)");
      return work(c);
    });
  } catch (error) {
    if (error instanceof HttpRefusal) throw error;
    throw commands.asKernelError(error);
  }
}

/** One flag the person may see: an unrestricted one, or a restricted one with ANALYTICS.DI_REVIEW (else not found). */
async function oneFlag(c: pg.PoolClient, zone: string, flagId: string): Promise<FlagRow> {
  const [open] = await unrestrictedFlags(c, { from: null, to: null, kind: null, zone, flagId });
  if (open) return open;
  await c.query('savepoint restricted_flag');
  try {
    const [restricted] = await restrictedFlags(c, { from: null, to: null, kind: null, zone, flagId });
    await c.query('release savepoint restricted_flag');
    if (restricted) return restricted;
  } catch (error) {
    await c.query('rollback to savepoint restricted_flag');
    if (!/EBMR-ANA-007/.test(error instanceof Error ? error.message : String(error))) throw error;
  }
  throw notFound();
}

export function plugin(scope: FastifyInstance, app: AppContext): Promise<void> {
  const pool = app.pools.app;
  const zone = () => app.siteZone.current();

  const flagResult = async (c: pg.PoolClient, row: FlagRow): Promise<{ flag: FlagView; all: ReturnType<typeof dispositionViews>; dataAgeSeconds: number }> => {
    const dispositions = await dispositionsOf(c, [row]);
    const { flags, dataAgeSeconds } = await flagViews(app, c, [row], dispositions);
    const flag = flags[0];
    if (!flag) throw notFound();
    const people = await peopleOf(c, dispositions.map((d) => d.person_id));
    return { flag, all: dispositionViews(app, dispositions, people), dataAgeSeconds };
  };

  bindRoutes(scope, app, routes.analytics, {
    catalog: async ({ actor }) => asViewer(pool, actor(), (c) => catalog(c)),
    methods: async ({ actor }) => asViewer(pool, actor(), async (c) => ({ ...envelope(), versions: await methodVersions(app, c) })),
    monitor: async ({ actor }) => asViewer(pool, actor(), (c) => monitor(c)),
    flags: async ({ actor, query }) =>
      asViewer(pool, actor(), async (c) => {
        const q = { from: query.from ?? null, to: query.to ?? null, kind: query.kind ?? null, zone: zone() };
        if (q.from !== null && q.to !== null && q.from > q.to) {
          throw refusal(400, { code: 'EBMR-ANA-011', kind: 'INVALID_INPUT', whatHappened: 'The period starts after it ends.', whatYouCanDo: ['Choose a start date on or before the end date.'] });
        }
        // Flags about a person or an account are listed only when asked for by kind, and only with ANALYTICS.DI_REVIEW
        // (the database checks it; D-6A-1-17). Without a period the list is the open flags: those without a disposition.
        const restricted = q.kind !== null && RESTRICTED.has(q.kind);
        const open = q.from === null && q.to === null;
        const rows = restricted ? await restrictedFlags(c, q) : await unrestrictedFlags(c, q);
        const dispositions = await dispositionsOf(c, rows);
        const { flags, dataAgeSeconds } = await flagViews(app, c, rows, dispositions);
        return { ...envelope(dataAgeSeconds), flags: restricted && open ? flags.filter((f) => f.disposition === null) : flags };
      }),
    flag: async ({ actor, params }) =>
      asViewer(pool, actor(), async (c) => {
        const r = await flagResult(c, await oneFlag(c, zone(), params.flagId));
        return { ...envelope(r.dataAgeSeconds), method: r.flag.method, run: r.flag.run, flag: r.flag, dispositions: r.all };
      }),
    dispose: async ({ params, body, actor, idempotencyKey, requestHash }): Promise<AnalyticsDispositionResult> => {
      const who = actor({ reasonCode: 'ANALYTICS_DISPOSITION', reasonText: body.cause });
      const out = await withIdempotentActorCommand(pool, who, idempotencyKey ?? '', requestHash, async (c) => {
        const { rows } = await c.query<{ id: string }>('select analytics.record_disposition($1, $2, $3, $4, $5, $6)::text as id', [
          params.flagId, body.verdict, body.cause, body.deviationRef ?? null, body.supersedes ?? null, body.reason ?? null,
        ]);
        return rows[0]!.id;
      });
      return asViewer(pool, actor(), async (c) => {
        const r = await flagResult(c, await oneFlag(c, zone(), params.flagId));
        const disposition = r.all.find((d) => d.dispositionId === out.result);
        if (!disposition) throw notFound();
        return { ...envelope(r.dataAgeSeconds), method: r.flag.method, run: r.flag.run, disposition };
      });
    },
  });

  bindRoutes(scope, app, routes.analyticsConfig, {
    setMethodVersion: async ({ body, actor, idempotencyKey, requestHash }) => {
      const parameters = jsonObject(body.parametersJson, 'parameters');
      const acceptance = jsonObject(body.acceptanceJson, 'acceptance criteria');
      const problems = methodDefinitionProblems(body.method, parameters);
      if (problems.length > 0) {
        throw refusal(422, { code: 'EBMR-ANA-015', kind: 'INVALID_INPUT', whatHappened: 'The method version was not recorded.', why: problems.join('; '),
                             whatYouCanDo: ['Give parameters that fit the method (the catalogue lists its defaults).'], whoCanHelp: ['QA'], controls: ['DI-52'] });
      }
      const def = {
        method: body.method, version: body.version, status: body.status, title: body.title, intendedUse: body.intendedUse, acceptance,
        parameters, parametersSha256: parametersSha256(parameters), codeIdentity: codeIdentity(app.config.analytics.commit), validationRef: body.validationRef,
      };
      const ctx = { ...actor({ reasonCode: 'CONFIG_CHANGE', reasonText: body.reason }), changeRecord: body.changeRecord };
      const out = await withIdempotentActorCommand(pool, ctx, idempotencyKey ?? '', requestHash, async (c) =>
        (await c.query<{ id: string }>('select analytics.set_method_version($1::jsonb)::text as id', [JSON.stringify(def)])).rows[0]!.id);
      const [version] = await methodVersions(app, pool, { rowId: out.result });
      if (!version) throw new Error('the method version just recorded is not in analytics.method_version_v1');
      return { version };
    },
    setReferenceSet: async ({ body, actor, idempotencyKey, requestHash }) => {
      const ctx = { ...actor({ reasonCode: 'CONFIG_CHANGE', reasonText: body.reason }), changeRecord: body.changeRecord };
      const out = await withIdempotentActorCommand(pool, ctx, idempotencyKey ?? '', requestHash, async (c) => {
        // The model is the candidate's (an output of a completed run); the database checks it is a MODEL_CANDIDATE of
        // the same method whose hash it carries (EBMR-ANA-010).
        const { rows: cand } = await c.query<{ values: { model?: unknown; modelSha256?: unknown } }>('select "values" from analytics.output_v1 where output_id = $1', [body.candidateOutput]);
        const values = cand[0]?.values ?? {};
        const model = values.model !== null && typeof values.model === 'object' ? values.model : {};
        const def = {
          id: body.referenceSetId ?? null, method: body.method, scope: body.scope, batchIds: body.batchIds, candidateOutput: body.candidateOutput,
          model, modelSha256: typeof values.modelSha256 === 'string' ? values.modelSha256 : '0'.repeat(64), status: body.status,
        };
        return (await c.query<{ id: string }>('select analytics.set_reference_set($1::jsonb)::text as id', [JSON.stringify(def)])).rows[0]!.id;
      });
      const sets = await referenceSets(app, pool, out.result);
      const referenceSet = sets[sets.length - 1];
      if (!referenceSet) throw new Error('the reference set just recorded is not in analytics.reference_set_v1');
      return { referenceSet };
    },
  });
  return Promise.resolve();
}
