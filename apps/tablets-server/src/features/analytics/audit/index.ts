/**
 * Feature `analytics-audit` (Phase 6A slice 6A-4, GMP; contract ns/analytics-audit.ts; kernel 1260, 1261, recipe-core
 * 1150, 1151; decision 0016 item 8; draft control DI-53): the audit-trail anomaly flags for QA data-integrity review.
 *   analyticsAudit.flags    one flag per key (the latest; D-6A-4-5) with the key's current disposition and how often
 *                           and since when it was raised; without a period the open keys only (as D-6A-1-17).
 *   analyticsAudit.flag     one flag with its reasons, the audit entries behind it (no old or new values) and the
 *                           dispositions of its key.
 *   analyticsAudit.entries  the entries of a batch's audit-trail review scope that the keys name, so the review panel
 *                           orders them first and highlights them; it hides nothing and the review is unchanged (DI-25).
 * Every read needs ANALYTICS.VIEW, then the definers need ANALYTICS.DI_REVIEW (the database checks both; a person
 * without DI_REVIEW is refused EBMR-ANA-007 for every flag alike, so the refusal tells nothing about one). A flag sends
 * no notification and closes only with QA's disposition, recorded through analytics.dispose (analytics.record_disposition
 * checks DI_REVIEW for a restricted flag); a real problem goes into the deviation process as usual. Nothing here writes
 * GMP data (DI-51). It lives in the analytics feature's folder (dependency-cruiser no-gmp-feature-imports-analytics).
 */
import { routes, type FlagView } from '@ebmr/api-contract';
import { commands } from '@ebmr/kernel';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import type { AppContext } from '../../../platform/context.ts';
import { withActorCommand } from '../../../platform/db/commands.ts';
import { bindRoutes } from '../../../platform/http/bind.ts';
import { HttpRefusal, refusal } from '../../../platform/http/refusal.ts';
import { peopleOf } from '../../common/people.ts';
import { dispositionViews, dispositionsOf, envelope, flagViews, restrictedFlags, type FlagRow } from '../reads.ts';
import { auditKeys, flagEntries, flagKey, flaggedEntries, repeatOf, type KeyRow } from './reads.ts';

// The EBMR-ANA guidance is the analytics feature's (../guidance.ts), served for every analytics route.

type Actor = Parameters<typeof withActorCommand>[1];

const AUDIT_METHODS = new Set(['ATA.RULES', 'ATA.BASELINE']);

const notFound = () =>
  refusal(404, { code: 'EBMR-ANA-016', kind: 'INVALID_INPUT', whatHappened: 'There is no such audit-trail flag.', whatYouCanDo: ['Reload the list of audit-trail flags.'], whoCanHelp: ['QA'] });

/** A read as the person: ANALYTICS.VIEW here, ANALYTICS.DI_REVIEW in each definer the read calls. */
async function asReviewer<T>(pool: pg.Pool, actor: Actor, work: (c: pg.PoolClient) => Promise<T>): Promise<T> {
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

/** The views of the keys: each its latest flag, with the key's current disposition (it may sit on an earlier flag). */
async function keyViews(app: AppContext, c: pg.PoolClient, keys: readonly KeyRow[]): Promise<{ flags: FlagView[]; dataAgeSeconds: number; all: ReturnType<typeof dispositionViews> }> {
  const holders: FlagRow[] = [...new Set(keys.map((k) => k.disposition_flag).filter((x): x is string => x !== null))].map((id) => ({ ...(keys[0] as KeyRow), flag_id: id, restricted: true }));
  const dispositions = await dispositionsOf(c, holders);
  const { flags, dataAgeSeconds } = await flagViews(app, c, keys, []);
  const people = await peopleOf(c, dispositions.map((d) => d.person_id));
  const all = dispositionViews(app, dispositions, people);
  const byFlag = new Map(keys.map((k) => [k.flag_id, k]));
  return {
    flags: flags.map((f) => {
      const k = byFlag.get(f.flagId);
      const current = k?.disposition_flag ? all.find((d) => d.flagId === k.disposition_flag && d.current) ?? null : null;
      return { ...f, disposition: current, drill: `/analytics/audit-flags/${f.flagId}` };
    }),
    dataAgeSeconds,
    all,
  };
}

export function plugin(scope: FastifyInstance, app: AppContext): Promise<void> {
  const pool = app.pools.app;
  const zone = () => app.siteZone.current();

  bindRoutes(scope, app, routes.analyticsAudit, {
    flags: async ({ actor, query }) =>
      asReviewer(pool, actor(), async (c) => {
        const q = { from: query.from ?? null, to: query.to ?? null, zone: zone() };
        if (q.from !== null && q.to !== null && q.from > q.to) {
          throw refusal(400, { code: 'EBMR-ANA-011', kind: 'INVALID_INPUT', whatHappened: 'The period starts after it ends.', whatYouCanDo: ['Choose a start date on or before the end date.'] });
        }
        const all = await auditKeys(c, q);
        // Without a period the open keys (no current disposition), as the flags list does (D-6A-1-17).
        const keys = q.from === null && q.to === null ? all.filter((k) => k.disposition_flag === null) : all;
        const v = await keyViews(app, c, keys);
        return { ...envelope(v.dataAgeSeconds), flags: v.flags, repeats: keys.map((k) => repeatOf(app, k)) };
      }),
    flag: async ({ actor, params }) =>
      asReviewer(pool, actor(), async (c) => {
        const [row] = await restrictedFlags(c, { from: null, to: null, kind: null, zone: zone(), flagId: params.flagId });
        if (!row || !AUDIT_METHODS.has(row.method)) throw notFound();
        const key = flagKey(row);
        const k = (await auditKeys(c, { from: null, to: null, zone: zone() })).find((x) => x.flag_key === key);
        const shown: KeyRow = k ? { ...row, flag_key: key, raised_count: k.raised_count, first_us: k.first_us, disposition_flag: k.disposition_flag, verdict: k.verdict }
                                : { ...row, flag_key: key, raised_count: 1, first_us: row.raised_us, disposition_flag: null, verdict: null };
        const v = await keyViews(app, c, [shown]);
        const flag = v.flags[0];
        if (!flag) throw notFound();
        // The dispositions of the key: those of the flag holding its current one, and of this flag.
        const own = shown.disposition_flag === row.flag_id ? [] : await dispositionsOf(c, [row]);
        const people = await peopleOf(c, own.map((d) => d.person_id));
        const dispositions = [...v.all, ...dispositionViews(app, own, people)];
        return {
          ...envelope(v.dataAgeSeconds), method: flag.method, run: flag.run, flag, entries: await flagEntries(app, c, row.flag_id), dispositions,
          repeat: repeatOf(app, shown),
        };
      }),
    entries: async ({ actor, params }) =>
      asReviewer(pool, actor(), async (c) => ({ ...envelope(), batchId: params.batchId, entries: await flaggedEntries(c, params.batchId) })),
  });
  return Promise.resolve();
}
