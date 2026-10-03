/**
 * Feature `audit` (module C1; plan section 11; DI-22, DI-23): the hash-chained audit trail viewer on both
 * installations. Read-only by construction: every route of the namespace is a GET, the read model has no write
 * path, and the application role cannot change, disable or purge audit rows (kernel 0010). A route inventory
 * test proves no audit mutation route exists.
 *
 *  - chains: the audit chains, optionally by key prefix (mbr_version:, batch:), newest activity first, after any chain
 *    whose head row is missing (tablets 0490, review F06: listed with no count or time, to be verified);
 *  - events: by chain, correlation, person and time, in chronological order, keyset-paged; a list across chains
 *    never goes past the settled horizon (horizon.ts, review P11), so no page steps past an entry that a transaction
 *    still in progress may yet commit (a page that stops there still has a next cursor);
 *  - verify: the kernel recomputes every hash of the chain from the stored payloads (verifyChain), and of the registry
 *    chains its entries' user IDs and terminal codes are shown from (review P7), each problem naming its chain.
 * Every read is the database's for the request's session (tablets 0420, review F35; DI-17, DI-50): only the chains its
 * role may read are listed or shown, a person filter names the session's own person unless its role is a governance or
 * audit one, and a chain it may not read is refused (EBMR-TAB-020), verification included.
 */
import { routes } from '@ebmr/api-contract';
import { verifyChain } from '@ebmr/kernel';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../../platform/context.ts';
import { dbNowUs } from '../../platform/db/commands.ts';
import { bindRoutes } from '../../platform/http/bind.ts';
import { refusal } from '../../platform/http/refusal.ts';
import { SettledHorizon } from './horizon.ts';
import { auditDb, chainLabel, chainLength, DEFAULT_LIMIT, MAX_LIMIT, readChains, readEvents, readHeadlessChains, registryChainsOf, toView } from './read-model.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function badFilter(why: string): Error {
  return refusal(400, {
    code: 'SCHEMA',
    kind: 'INVALID_INPUT',
    whatHappened: 'The filter was not in the expected form.',
    why,
    whatYouCanDo: ['Clear the filter and try again.'],
  });
}

export function plugin(scope: FastifyInstance, app: AppContext): Promise<void> {
  const db = auditDb(app);
  const horizon = new SettledHorizon(db);
  bindRoutes(scope, app, routes.audit, {
    chains: async ({ query, requireSession }) => {
      const token = requireSession().tokenHash;
      const headless = await readHeadlessChains(db, token, query.prefix);
      const rows = await readChains(db, token, query.prefix);
      return {
        chains: [
          // A chain whose head row is missing is listed first, with no count or time from its entries (F06).
          ...headless.map((r) => ({ chainKey: r.chain_key, label: chainLabel(r.chain_key), events: Number(r.entries), lastAt: null, headMissing: true as const })),
          ...rows.map((r) => ({ chainKey: r.chain_key, label: chainLabel(r.chain_key), events: Number(r.last_seq), lastAt: r.us ? app.formatInstant(r.us) : null })),
        ],
      };
    },

    events: async ({ query, requireSession }) => {
      const s = requireSession();
      if (query.correlationId !== undefined && !UUID.test(query.correlationId)) throw badFilter('The correlation id is not a UUID.');
      if (query.personId !== undefined && !UUID.test(query.personId)) throw badFilter('The person id is not a UUID.');
      if (query.cursor !== undefined && !/^(?:0|[1-9]\d{0,18})$/.test(query.cursor)) throw badFilter('The page cursor is not valid.');
      const limit = Math.min(MAX_LIMIT, query.limit ? Number(query.limit) : DEFAULT_LIMIT);
      // One chain's entries commit in id order (the chain-head lock); a list across chains stops at the horizon.
      const bound = query.chainKey === undefined ? await horizon.current() : null;
      const rows = await readEvents(db, s.tokenHash, {
        chainKey: query.chainKey,
        correlationId: query.correlationId,
        personId: query.personId,
        fromUs: query.from,
        toUs: query.to,
        afterId: query.cursor,
        upToId: bound?.upTo.toString(),
        limit,
      });
      const page = rows.slice(0, limit);
      const last = page.at(-1)?.id ?? query.cursor ?? '0';
      const nextCursor = rows.length > limit || (bound !== null && !bound.complete) ? last : null;
      return { events: page.map((r) => toView(r, (us) => app.formatInstant(us))), nextCursor };
    },

    verifyChain: async ({ params, requireSession }) => {
      const s = requireSession();
      const events = await chainLength(db, s.tokenHash, params.chainKey);
      // Null only for a chain with neither a head nor an entry; a chain whose head row is missing is verified, and the
      // kernel names the tamper (F06).
      if (events === null) {
        throw refusal(404, {
          code: 'AUDIT_CHAIN_NOT_FOUND',
          kind: 'STALE',
          whatHappened: 'This audit chain does not exist on this installation.',
          why: `No audit entry was ever written on chain ${params.chainKey}.`,
          controls: ['DI-22'],
          whatYouCanDo: ['Check the record and the installation (GMP or sandbox).'],
        });
      }
      const problems = (await verifyChain(app.pools.app, params.chainKey)).map((p) => `entry ${p.seq}: ${p.problem}`);
      // What the view shows beside the chain's own payloads (user IDs, terminal codes) is proven by these chains.
      for (const registry of await registryChainsOf(db, s.tokenHash, params.chainKey)) {
        for (const p of await verifyChain(app.pools.app, registry)) problems.push(`${registry} entry ${p.seq}: ${p.problem}`);
      }
      return {
        chainKey: params.chainKey,
        ok: problems.length === 0,
        events,
        problems,
        verifiedAt: app.formatInstant(await dbNowUs(app.pools.app)),
      };
    },
  });
  return Promise.resolve();
}
