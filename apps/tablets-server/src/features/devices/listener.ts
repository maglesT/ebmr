/**
 * The gateway listener (sandbox; EBMR_GATEWAY_LISTEN, default 127.0.0.1:3012): the site gateway's uplink, on its
 * own Fastify instance so no browser route is reachable through it and no gateway route through the browser port.
 *
 *   POST /gw/v1/nonce      a single-use nonce for the login proof (60 s)
 *   POST /gw/v1/session    login: Ed25519 proof of possession of the enrolled key (its SHA-256 SPKI fingerprint is the
 *                          registered SERVER device), then kernel SERVICE_KEY authentication on that device and a
 *                          session bound to an opaque bearer token (tab.gateway_session, never a browser cookie)
 *   POST /gw/v1/readings   readings in chain order; each is checked here (schema, hash, Ed25519 signature against the
 *                          enrolled key, raw line equal to the value) and ingested by tab.ingest_reading in its own
 *                          INTEGRATION command (INTERFACE.WRITE; chain, sequence, serial, installation checked in SQL).
 *                          Idempotent by reading id. The first refusal stops the batch and raises an alarm (DI-31).
 *   POST /gw/v1/heartbeat  instrument states (every 5 s); a gap over 10 s shows the scale OFFLINE
 *   POST /gw/v1/logout
 * Integration identities never sign: the kernel refuses SERVICE_KEY authentication for anything but LOGIN, and
 * iam.can_sign refuses non-human accounts.
 */
import { createHash, randomBytes, randomUUID, verify } from 'node:crypto';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import { commands, identity, type ActorContext } from '@ebmr/kernel';
import {
  HeartbeatRequest,
  LoginRequest,
  UplinkRequest,
  ed25519PublicKey,
  interpretWeightLine,
  loginProofMessage,
  readingProblem,
  spkiFingerprint,
  type HeartbeatResponse,
  type LoginResponse,
  type ScaleReading,
  type UplinkResponse,
} from '@ebmr/integration-sdk/scale';
import { consumeNonce, mintNonce } from '../../platform/auth/nonces.ts';
import type { AppContext } from '../../platform/context.ts';
import { withActorCommand } from '../../platform/db/commands.ts';
import { runtimeOf } from './runtime.ts';

const tokenHash = (token: string): string => createHash('sha256').update(token, 'utf8').digest('hex');

class GwError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly relogin = false,
  ) {
    super(message);
  }
}

interface GatewaySession {
  tokenHash: string;
  sessionId: string;
  personId: string;
  accountId: string;
  deviceId: string;
  legalName: string;
  state: string;
  chainId: string;
  gatewayCode: string;
  publicKeySpki: string;
  roles: string[];
}

async function resolveBearer(app: AppContext, request: FastifyRequest): Promise<GatewaySession> {
  const header = request.headers.authorization;
  const token = typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!/^[A-Za-z0-9_-]{40,128}$/.test(token)) throw new GwError(401, 'NO_TOKEN', 'a bearer token is required', true);
  const hash = tokenHash(token);
  const { rows } = await app.pools.app.query<{ r: Record<string, unknown> | null }>('select tab.resolve_gateway_session($1) as r', [hash]);
  const r = rows[0]?.r;
  if (!r || r['state'] !== 'ACTIVE') throw new GwError(401, 'SESSION', 'the gateway session is unknown, ended or locked; log in again', true);
  return {
    tokenHash: hash,
    sessionId: String(r['session_id']),
    personId: String(r['person_id']),
    accountId: String(r['account_id']),
    deviceId: String(r['device_id']),
    legalName: String(r['legal_name']),
    state: String(r['state']),
    chainId: String(r['chain_id']),
    gatewayCode: String(r['gateway_code']),
    publicKeySpki: String(r['public_key_spki']),
    roles: Array.isArray(r['roles']) ? (r['roles'] as unknown[]).map(String) : [],
  };
}

/**
 * The INTEGRATION actor of a gateway session (source INTEGRATION; the role holding INTERFACE.WRITE). `siteZone` is
 * the site policy's zone (ServerConfig.siteZone): the kernel refuses any other (EBMR-IAM-118, DI-27).
 */
export function gatewayActor(gw: GatewaySession, siteZone: string, correlationId: string): ActorContext & { deviceId: string } {
  return {
    personId: gw.personId,
    accountId: gw.accountId,
    roleCode: gw.roles.includes('SERVICE_ACCOUNT') ? 'SERVICE_ACCOUNT' : (gw.roles[0] ?? 'SERVICE_ACCOUNT'),
    sessionId: gw.sessionId,
    deviceId: gw.deviceId,
    source: 'INTEGRATION',
    siteZone,
    legalName: gw.legalName,
    correlationId,
  };
}

async function recordRefusal(app: AppContext, args: { tokenHash: string | null; gatewayCode: string | null; kind: string; code: string; readingId: string | null; message: string; details?: Record<string, unknown> }): Promise<void> {
  await app.pools.app
    .query('select tab.record_gateway_refusal($1, $2, $3, $4, $5, $6, $7::jsonb)', [
      args.tokenHash,
      args.gatewayCode,
      args.kind,
      args.code,
      args.readingId,
      args.message,
      JSON.stringify(args.details ?? {}),
    ])
    .catch(() => undefined);
}

/** DI-32: the raw line must state exactly the value, unit and stability the reading carries. */
function rawProblem(r: ScaleReading): string | null {
  let seen;
  try {
    seen = interpretWeightLine(r.raw);
  } catch (error) {
    return `the raw line cannot be read: ${error instanceof Error ? error.message : String(error)}`;
  }
  if (seen.value !== r.value || seen.unit !== r.unit || seen.stable !== r.stable || seen.status !== r.status) {
    return `the raw line "${r.raw}" states ${seen.value ?? 'no value'} ${seen.unit ?? ''} (${seen.status}), not ${r.value ?? 'no value'} ${r.unit ?? ''} (${r.status})`;
  }
  return null;
}

export interface GatewayListener {
  port: number;
  close(): Promise<void>;
}

export async function startGatewayListener(app: AppContext, listen: { host: string; port: number }): Promise<GatewayListener> {
  if (app.installation !== 'SANDBOX') throw new Error('the gateway listener runs on the sandbox installation in Phase 2');
  const runtime = runtimeOf(app);
  const server = Fastify({ logger: false, bodyLimit: 1024 * 1024, trustProxy: false });

  server.setErrorHandler((error: unknown, _request: FastifyRequest, reply: FastifyReply) => {
    if (error instanceof GwError) {
      void reply.code(error.status).send({ error: { code: error.code, message: error.message, relogin: error.relogin } });
      return;
    }
    const code = commands.errorCode(error) ?? 'INTERNAL';
    const status = code === 'INTERNAL' ? 500 : 422;
    void reply.code(status).send({ error: { code, message: error instanceof Error ? error.message : String(error), relogin: false } });
  });

  server.post('/gw/v1/nonce', async () => {
    const { nonce } = await mintNonce(app.pools.app, app.config.secrets.nonceKey);
    return { nonce };
  });

  server.post('/gw/v1/session', async (request) => {
    const parsed = LoginRequest.safeParse(request.body);
    if (!parsed.success) throw new GwError(400, 'SCHEMA', 'the login request is not in the expected form');
    const body = parsed.data;
    const refuse = async (code: string, message: string): Promise<never> => {
      await recordRefusal(app, { tokenHash: null, gatewayCode: body.gatewayCode, kind: 'GATEWAY_LOGIN_REFUSED', code, readingId: null, message, details: { loginName: body.loginName } });
      throw new GwError(401, code, message);
    };
    if (!(await consumeNonce(app.pools.app, app.config.secrets.nonceKey, body.nonce))) await refuse('NONCE', 'the nonce is unknown, used or expired');
    let proofOk: boolean;
    try {
      proofOk = verify(null, loginProofMessage(body.nonce, body.gatewayCode, body.loginName, body.spki), ed25519PublicKey(body.spki), Buffer.from(body.sig, 'base64'));
    } catch {
      proofOk = false;
    }
    if (!proofOk) await refuse('KEY_PROOF', 'DI-20: the gateway did not prove possession of an Ed25519 key');
    const fingerprint = spkiFingerprint(body.spki);
    let ev: identity.AuthenticationEvent;
    try {
      ev = await identity.authenticate(app.pools.authn, { method: 'SERVICE_KEY', identifier: body.loginName, secret: body.serviceKey, deviceFingerprint: fingerprint, purpose: 'LOGIN' });
    } catch (error) {
      return refuse('AUTH_FAILED', `the gateway identity was not authenticated (${error instanceof Error ? error.message : String(error)})`);
    }
    const session = await identity.openSession(app.pools.app, ev.authEventId, fingerprint);
    const token = randomBytes(32).toString('base64url');
    let bound: { chain_id: string; gateway_code: string; head: { seq: string; hash: string }; installation: 'GMP' | 'SANDBOX'; server_time_us: string; instruments: LoginResponse['instruments'] };
    try {
      const { rows } = await app.pools.app.query<{ r: typeof bound }>('select tab.bind_gateway_session($1, $2, $3) as r', [session.sessionId, tokenHash(token), body.spki]);
      if (!rows[0]) throw new Error('no binding');
      bound = rows[0].r;
    } catch (error) {
      await identity.endSession(app.pools.app, session.sessionId).catch(() => undefined);
      return refuse(commands.errorCode(error) ?? 'BIND', error instanceof Error ? error.message : String(error));
    }
    if (bound.gateway_code !== body.gatewayCode) {
      await app.pools.app.query('select tab.unbind_gateway_session($1)', [tokenHash(token)]);
      await identity.endSession(app.pools.app, session.sessionId).catch(() => undefined);
      return refuse('GATEWAY_CODE', `the key is enrolled for ${bound.gateway_code}, not ${body.gatewayCode}`);
    }
    runtime.links.set(bound.gateway_code, { gatewayCode: bound.gateway_code, apiToken: body.apiToken });
    const response: LoginResponse = {
      token,
      chainId: bound.chain_id,
      head: bound.head,
      installation: bound.installation,
      serverTimeUs: bound.server_time_us,
      instruments: bound.instruments,
    };
    return response;
  });

  server.post('/gw/v1/readings', async (request) => {
    const gw = await resolveBearer(app, request);
    const parsed = UplinkRequest.safeParse(request.body);
    if (!parsed.success) {
      await recordRefusal(app, { tokenHash: gw.tokenHash, gatewayCode: null, kind: 'READING_REFUSED', code: 'SCHEMA', readingId: null, message: 'DI-31: a reading batch was not in the expected form' });
      throw new GwError(400, 'SCHEMA', 'DI-31: the readings are not in the expected form');
    }
    const correlationId = randomUUID();
    const actor = gatewayActor(gw, app.config.siteZone, correlationId);
    const publicKey = ed25519PublicKey(gw.publicKeySpki);
    const results: UplinkResponse['results'] = [];
    let head: UplinkResponse['head'] | null = null;
    let refused: UplinkResponse['refused'] = null;
    for (const item of parsed.data.items) {
      const r = item.reading;
      const problem = readingProblem(r, publicKey);
      const raw = problem ? null : rawProblem(r);
      if (problem || raw) {
        const code = problem?.problem === 'SIGNATURE' ? 'EBMR-DEV-061' : problem?.problem === 'HASH' ? 'EBMR-DEV-045' : problem ? 'EBMR-DEV-040' : 'EBMR-DEV-062';
        const message = problem ? `DI-31: ${problem.detail}` : `DI-32: ${raw ?? ''}`;
        refused = { readingId: r.readingId, code, message };
        await recordRefusal(app, { tokenHash: gw.tokenHash, gatewayCode: null, kind: 'READING_REFUSED', code, readingId: r.readingId, message, details: { seq: r.seq, deviceCode: r.deviceCode } });
        break;
      }
      try {
        const out = await withActorCommand(app.pools.app, actor, async (client) => {
          const { rows } = await client.query<{ r: { outcome: 'INGESTED' | 'DUPLICATE'; readingId: string; seq: string; head: { seq: string; hash: string } } }>(
            'select tab.ingest_reading($1::jsonb, $2::bigint) as r',
            [JSON.stringify(r), item.delayUs],
          );
          if (!rows[0]) throw new Error('tab.ingest_reading returned nothing');
          return rows[0].r;
        });
        results.push({ readingId: out.readingId, seq: out.seq, outcome: out.outcome });
        head = out.head;
        runtime.ingested.emit(out.readingId);
      } catch (error) {
        const code = commands.errorCode(error) ?? 'INTERNAL';
        const message = error instanceof Error ? error.message : String(error);
        refused = { readingId: r.readingId, code, message };
        await recordRefusal(app, { tokenHash: gw.tokenHash, gatewayCode: null, kind: 'READING_REFUSED', code, readingId: r.readingId, message, details: { seq: r.seq, deviceCode: r.deviceCode } });
        break;
      }
    }
    if (!head) {
      const { rows } = await app.pools.app.query<{ h: { seq: string; hash: string } }>('select tab.chain_head($1) as h', [gw.chainId]);
      head = rows[0]?.h ?? { seq: '0', hash: '0'.repeat(64) };
    }
    const response: UplinkResponse = { results, head, refused };
    return response;
  });

  server.post('/gw/v1/heartbeat', async (request) => {
    const gw = await resolveBearer(app, request);
    if (!runtime.link(gw.gatewayCode)) {
      // This server process has no API token for the gateway (it restarted): the gateway must log in again.
      await app.pools.app.query('select tab.unbind_gateway_session($1)', [gw.tokenHash]);
      await identity.endSession(app.pools.app, gw.sessionId).catch(() => undefined);
      throw new GwError(401, 'RELOGIN', 'log in again to hand over the API token', true);
    }
    const parsed = HeartbeatRequest.safeParse(request.body);
    if (!parsed.success) throw new GwError(400, 'SCHEMA', 'the heartbeat is not in the expected form');
    const actor = gatewayActor(gw, app.config.siteZone, randomUUID());
    const out = await withActorCommand(app.pools.app, actor, async (client) => {
      const { rows } = await client.query<{ r: HeartbeatResponse }>('select tab.record_heartbeat($1::jsonb) as r', [JSON.stringify(parsed.data)]);
      if (!rows[0]) throw new Error('tab.record_heartbeat returned nothing');
      return rows[0].r;
    });
    return out;
  });

  server.post('/gw/v1/logout', async (request) => {
    const gw = await resolveBearer(app, request);
    await app.pools.app.query('select tab.unbind_gateway_session($1)', [gw.tokenHash]);
    await identity.endSession(app.pools.app, gw.sessionId).catch(() => undefined);
    runtime.links.delete(gw.gatewayCode);
    return { ok: true };
  });

  await server.listen({ host: listen.host, port: listen.port });
  const address = server.server.address();
  const port = typeof address === 'object' && address ? address.port : listen.port;
  return {
    port,
    async close() {
      runtime.live.close();
      await server.close();
    },
  };
}
