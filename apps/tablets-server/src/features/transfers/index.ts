/**
 * Feature `transfers` (Phase 6 slice 6i, GMP): lot-transfer packages between site installations and the site-to-site
 * genealogy endpoint (contract ns/transfers.ts; kernel 1220, site services 0980, 0981, recipe-core 1090; outline L-41;
 * DI-31, DI-39, PR-57). Every rule is the database's: the package content is built by site.prepare_transfer_package and
 * the seal verified by site.seal_transfer_package, the receipt checked by site.import_transfer_package (a refusal is an
 * answer with its alarm, never a silent drop), the acceptance is the signable action TRANSFER_RECEIPT_DECIDE and a peer's
 * trust PEER_INSTALLATION_APPROVE. The server's one part is the installation key (keys.ts): it seals what the database
 * built and nothing else (D-P6i-0-8).
 */
import { routes } from '@ebmr/api-contract';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../../platform/context.ts';
import { withIdempotentActorCommand } from '../../platform/db/commands.ts';
import { bindRoutes } from '../../platform/http/bind.ts';
import { refusal } from '../../platform/http/refusal.ts';
import type { SignableActionRegistry } from '../../platform/ports.ts';
import { compact } from '../common/people.ts';
import { installationKey } from './federation.ts';
import { TRANSFERS_GUIDANCE } from './guidance.ts';
import { alarms, identity, packageFile, peers, receipt, receipts, packages } from './reads.ts';
import { peerApproveHandler, receiptDecideHandler } from './signables.ts';

export const guidance = TRANSFERS_GUIDANCE;

export function registerSignableActions(registry: SignableActionRegistry, app: AppContext): void {
  if (app.installation !== 'GMP') return;
  registry.register(receiptDecideHandler(app));
  registry.register(peerApproveHandler(app));
}

const noKey = () =>
  refusal(503, {
    code: 'EBMR-FED-020',
    kind: 'NOT_ENABLED',
    whatHappened: 'This server holds no installation key, so it seals nothing.',
    why: 'EBMR_INSTALLATION_KEY_FILE is not configured, or names another installation or key than the database holds.',
    whatYouCanDo: ['Configure the installation key of this installation (DEMO-ONLY file; a KMS or HSM in production).'],
    whoCanHelp: ['The system administrator'],
    controls: ['DI-31'],
  });

export function plugin(scope: FastifyInstance, app: AppContext): Promise<void> {
  const pool = app.pools.app;
  /** The key, only when it is this installation's current one. */
  const currentKey = async () => {
    const key = installationKey(app);
    const me = await identity(pool, key);
    if (!key || !me?.serverHoldsKey) throw noKey();
    return key;
  };
  bindRoutes(scope, app, routes.transfers, {
    peers: async ({ requireSession }) => {
      requireSession();
      return { installation: await identity(pool, installationKey(app)), peers: await peers(app, pool) };
    },
    proposePeer: async ({ body, actor, idempotencyKey, requestHash }) => {
      const { result: id } = await withIdempotentActorCommand(pool, actor(), idempotencyKey ?? '', requestHash, async (c) =>
        (await c.query<{ id: string }>('select platform.propose_peer_installation($1::jsonb)::text as id', [JSON.stringify(body)])).rows[0]!.id);
      return (await peers(app, pool, id))[0]!;
    },
    packages: async ({ requireSession }) => {
      requireSession();
      return { packages: await packages(app, pool) };
    },
    prepare: async ({ body, actor, idempotencyKey, requestHash }) => {
      const key = await currentKey();
      const spec = compact({ destination: body.destination, quantity: body.quantity, markets: body.markets, holdUntil: body.holdUntil });
      const { result: id } = await withIdempotentActorCommand(pool, actor(), idempotencyKey ?? '', requestHash, async (c) => {
        const p = (await c.query<{ r: { packageId: string; payload: string } }>('select site.prepare_transfer_package($1, $2::jsonb) as r', [body.lotId, JSON.stringify(spec)])).rows[0]!.r;
        await c.query('select site.seal_transfer_package($1, $2)', [p.packageId, key.seal('transfer-package', p.payload)]);
        return p.packageId;
      });
      return packageFile(pool, id);
    },
    packageFile: async ({ params, requireSession }) => {
      requireSession();
      return packageFile(pool, params.packageId);
    },
    receipts: async ({ requireSession }) => {
      requireSession();
      return { receipts: await receipts(app, pool) };
    },
    receipt: async ({ params, requireSession }) => {
      requireSession();
      return receipt(app, pool, params.receiptId);
    },
    import: async ({ body, actor, idempotencyKey, requestHash }) => {
      const { result } = await withIdempotentActorCommand(pool, actor(), idempotencyKey ?? '', requestHash, async (c) =>
        (await c.query<{ r: { outcome: 'RECEIVED' | 'REFUSED'; receiptId?: string; kind?: string; reason?: string; alarmId?: string } }>(
          'select site.import_transfer_package($1, $2) as r', [body.payload, body.seal])).rows[0]!.r);
      if (result.outcome === 'RECEIVED') return { outcome: 'RECEIVED' as const, receipt: await receipt(app, pool, result.receiptId!) };
      return { outcome: 'REFUSED' as const, kind: result.kind as 'TAMPERED', reason: result.reason!, alarmId: result.alarmId! };
    },
    alarms: async ({ requireSession }) => {
      requireSession();
      return { alarms: await alarms(app, pool) };
    },
    acknowledgeAlarm: async ({ params, body, actor, idempotencyKey, requestHash }) => {
      await withIdempotentActorCommand(pool, actor(), idempotencyKey ?? '', requestHash, async (c) => {
        await c.query('select platform.acknowledge_installation_alarm($1, $2)', [params.alarmId, body.note]);
        return params.alarmId;
      });
      return (await alarms(app, pool, params.alarmId))[0]!;
    },
  });
  bindRoutes(scope, app, routes.federation, {
    // Site to site: no session; the request's seal under a trusted peer's key is the authentication (the database checks it).
    genealogy: async ({ body }) => {
      const key = await currentKey();
      const r = (await pool.query<{ r: { ok: boolean; payload?: string; reason?: string } }>('select recipe.answer_federated_genealogy($1, $2) as r', [body.request, body.seal])).rows[0]!.r;
      if (!r.ok || !r.payload) {
        const code = r.reason?.match(/EBMR-[A-Z]+-\d{3}/)?.[0] ?? 'EBMR-FED-002';
        throw refusal(403, { code, kind: 'NOT_ALLOWED', whatHappened: 'The genealogy request was refused.', why: r.reason ?? 'refused', whatYouCanDo: ['Check the request and the installation keys.'], controls: ['DI-31'] });
      }
      return { payload: r.payload, seal: key.seal('federation-answer', r.payload) };
    },
  });
  return Promise.resolve();
}
