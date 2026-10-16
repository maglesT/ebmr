/**
 * Feature `transfers` (Phase 6 slice 6i, GMP): lot-transfer packages between site installations and the site-to-site
 * genealogy endpoint (contract ns/transfers.ts; kernel 1220, site services 0980, 0981, recipe-core 1090; outline L-41;
 * DI-31, DI-39, PR-57). Every rule is the database's: the package content is built by site.prepare_transfer_package and
 * the seal verified by site.seal_transfer_package, the receipt checked by site.import_transfer_package (a refusal is an
 * answer with its alarm, never a silent drop), the acceptance is the signable action TRANSFER_RECEIPT_DECIDE and a peer's
 * trust PEER_INSTALLATION_APPROVE. The server's one part is the installation key (keys.ts): it seals what the database
 * built and nothing else (D-P6i-0-8).
 */
import { readFileSync } from 'node:fs';
import { routes } from '@ebmr/api-contract';
import { identity as kernelIdentity } from '@ebmr/kernel';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../../platform/context.ts';
import { withActorCommand, withIdempotentActorCommand } from '../../platform/db/commands.ts';
import { bindRoutes } from '../../platform/http/bind.ts';
import { refusal } from '../../platform/http/refusal.ts';
import type { SignableActionRegistry } from '../../platform/ports.ts';
import { compact } from '../common/people.ts';
import { openAdapterActor, type AdapterCredentials } from '../integrations/adapters/framework.ts';
import { installationKey } from './federation.ts';
import { TRANSFERS_GUIDANCE } from './guidance.ts';
import { alarms, identity, packageFile, peers, receipt, receipts, packages } from './reads.ts';
import { peerApproveHandler, receiptDecideHandler } from './signables.ts';

export const guidance = TRANSFERS_GUIDANCE;

/** Site-to-site requests per client address (review 6i-R3). */
export const FEDERATION_RATE = { max: 30, timeWindow: '1 minute' } as const;

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

/** The service-keys file's terminal of the federation endpoint's INTEGRATION identity (role FEDERATION_INTERFACE). */
export const FEDERATION_TERMINAL = 'SRV-FEDERATION-01';

/** The federation identity's credentials from EBMR_SERVICE_KEYS_FILE (DEMO-ONLY file); null when none is configured. */
export function federationCredentials(file: string | null): AdapterCredentials | null {
  if (!file) return null;
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as { services?: { terminal: string; loginName: string; serviceKey: string; fingerprint?: string | null; terminalKey?: { fingerprint?: string } | null }[] };
  const e = (parsed.services ?? []).find((x) => x.terminal === FEDERATION_TERMINAL);
  const fingerprint = e?.terminalKey?.fingerprint ?? e?.fingerprint ?? null;
  return e && fingerprint ? { loginName: e.loginName, serviceKey: e.serviceKey, fingerprint } : null;
}

const noIdentity = () =>
  refusal(503, {
    code: 'EBMR-FED-022',
    kind: 'NOT_ENABLED',
    whatHappened: 'This server has no federation identity, so it answers no other installation.',
    why: `EBMR_SERVICE_KEYS_FILE names no ${FEDERATION_TERMINAL} service (an INTEGRATION account in role FEDERATION_INTERFACE).`,
    whatYouCanDo: ['Configure the federation endpoint\'s service identity.'],
    whoCanHelp: ['The system administrator'],
    controls: ['DI-14', 'DI-31'],
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
      // The answer runs as the endpoint's INTEGRATION identity (FEDERATION.ANSWER; it never signs, DI-14); the database
      // checks the request's seal, destination, time window and nonce (recipe-core 1093, kernel 1220).
      const creds = federationCredentials(app.config.serviceKeysFile);
      if (!creds) throw noIdentity();
      const fed = await openAdapterActor(app, creds, 'FEDERATION_INTERFACE');
      let r: { ok: boolean; payload?: string; reason?: string };
      try {
        r = await withActorCommand(pool, { ...fed, correlationId: crypto.randomUUID() }, async (c) =>
          (await c.query<{ r: { ok: boolean; payload?: string; reason?: string } }>('select recipe.answer_federated_genealogy($1, $2) as r', [body.request, body.seal])).rows[0]!.r);
      } finally {
        await kernelIdentity.endSession(app.pools.app, fed.sessionId);
      }
      if (!r.ok || !r.payload) {
        const code = r.reason?.match(/EBMR-[A-Z]+-\d{3}/)?.[0] ?? 'EBMR-FED-002';
        throw refusal(403, { code, kind: 'NOT_ALLOWED', whatHappened: 'The genealogy request was refused.', why: r.reason ?? 'refused', whatYouCanDo: ['Check the request and the installation keys.'], controls: ['DI-31'] });
      }
      return { payload: r.payload, seal: key.seal('federation-answer', r.payload) };
    },
    // Review 6i-R3: the route needs no session and every request costs a seal verification in the database, so it is
    // counted per client address (a refused request still leaves its alarm).
  }, { rateLimits: { genealogy: FEDERATION_RATE } });
  return Promise.resolve();
}
