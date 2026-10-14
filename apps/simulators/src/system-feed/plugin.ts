/**
 * A simulator plugin from its system contract (Phase 6 slice 6a, builder B): one POST route per inbound message type
 * that validates the body with the contract's payload schema, lets the model change its state, and publishes the
 * message on the feed. SIMULATOR, DEMO-ONLY.
 */
import type { SystemContract } from '@ebmr/integration-sdk/adapter';
import type { SystemFeed } from './feed.ts';
import type { FeedPlugin } from './server.ts';

export interface PublishRoute {
  /** The path after the prefix, e.g. '/qms/v1/deviations'. */
  path: string;
  messageType: string;
  /** The record's id in the source (the envelope's sourceRecordId). */
  recordId(payload: Record<string, unknown>): string;
  /** The model may complete the payload (a new version token) before it is checked and published. */
  complete?(body: Record<string, unknown>): Record<string, unknown>;
  /** Told the checked payload once it is published (the model keeps its state). */
  published?(payload: Record<string, unknown>): void;
}

export function contractPlugin(
  feed: SystemFeed,
  contract: SystemContract,
  o: { prefix: string; title: string; routes: PublishRoute[]; reads?: FeedPlugin['route']; consoleRows?: () => [string, string][]; state?: () => unknown },
): FeedPlugin {
  return {
    prefix: o.prefix,
    title: o.title,
    route(method, path, query, body) {
      const r = o.routes.find((x) => x.path === path);
      if (r && method === 'POST') {
        const schema = contract.inbound[r.messageType]?.versions['1'];
        const filled = r.complete && typeof body === 'object' && body !== null && !Array.isArray(body) ? r.complete(body as Record<string, unknown>) : body;
        const parsed = schema?.safeParse(filled);
        if (!parsed?.success) {
          return { status: 400, body: { error: { code: 'SCHEMA', message: parsed ? parsed.error.issues.map((i) => `${i.path.map(String).join('.')}: ${i.message}`).join('; ') : 'unknown type' } } };
        }
        const payload = parsed.data as Record<string, unknown>;
        const env = feed.publish(r.messageType, r.recordId(payload), payload);
        r.published?.(payload);
        return { status: 201, body: { sequenceNo: env.sequenceNo, idempotencyKey: env.idempotencyKey, payload: env.payload } };
      }
      return o.reads ? o.reads(method, path, query, body) : undefined;
    },
    consoleRows: o.consoleRows ?? (() => []),
    state: o.state ?? (() => ({})),
  };
}
