/**
 * Feature `audit` (module C1; plan section 11; DI-22, DI-23): the hash-chained audit trail viewer on both
 * installations. Read-only by construction: every route of the namespace is a GET, the read model has no write
 * path, and the application role cannot change, disable or purge audit rows (kernel 0010). A route inventory
 * test proves no audit mutation route exists.
 *
 *  - chains: the audit chains, optionally by key prefix (mbr_version:, batch:), newest activity first;
 *  - events: by chain, correlation, person and time, in chronological order, keyset-paged;
 *  - verify: the kernel recomputes every hash of the chain from the stored payloads (verifyChain).
 */
import { routes } from '@ebmr/api-contract';
import { verifyChain } from '@ebmr/kernel';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../../platform/context.ts';
import { dbNowUs } from '../../platform/db/commands.ts';
import { bindRoutes } from '../../platform/http/bind.ts';
import { refusal } from '../../platform/http/refusal.ts';
import { auditDb, chainLabel, chainLength, DEFAULT_LIMIT, MAX_LIMIT, readChains, readEvents, toView } from './read-model.ts';

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
  bindRoutes(scope, app, routes.audit, {
    chains: async ({ query }) => {
      const rows = await readChains(db, query.prefix);
      return {
        chains: rows.map((r) => ({ chainKey: r.chain_key, label: chainLabel(r.chain_key), events: Number(r.last_seq), lastAt: r.us ? app.formatInstant(r.us) : null })),
      };
    },

    events: async ({ query }) => {
      if (query.correlationId !== undefined && !UUID.test(query.correlationId)) throw badFilter('The correlation id is not a UUID.');
      if (query.personId !== undefined && !UUID.test(query.personId)) throw badFilter('The person id is not a UUID.');
      if (query.cursor !== undefined && !/^[1-9]\d{0,18}$/.test(query.cursor)) throw badFilter('The page cursor is not valid.');
      const limit = Math.min(MAX_LIMIT, query.limit ? Number(query.limit) : DEFAULT_LIMIT);
      const rows = await readEvents(db, {
        chainKey: query.chainKey,
        correlationId: query.correlationId,
        personId: query.personId,
        fromUs: query.from,
        toUs: query.to,
        afterId: query.cursor,
        limit,
      });
      const page = rows.slice(0, limit);
      return { events: page.map((r) => toView(r, (us) => app.formatInstant(us))), nextCursor: rows.length > limit ? (page.at(-1)?.id ?? null) : null };
    },

    verifyChain: async ({ params }) => {
      const events = await chainLength(db, params.chainKey);
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
      const problems = await verifyChain(app.pools.app, params.chainKey);
      return {
        chainKey: params.chainKey,
        ok: problems.length === 0,
        events,
        problems: problems.map((p) => `entry ${p.seq}: ${p.problem}`),
        verifiedAt: app.formatInstant(await dbNowUs(app.pools.app)),
      };
    },
  });
  return Promise.resolve();
}
