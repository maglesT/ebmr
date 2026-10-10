/**
 * The gateway listener (sandbox; EBMR_GATEWAY_LISTEN, default 127.0.0.1:3012): the site gateway's uplink, on its
 * own Fastify instance so no browser route is reachable through it and no gateway route through the browser port.
 *
 *   POST /gw/v1/nonce      a single-use nonce for the login proof (60 s), bound to no key: it is not a browser
 *                          terminal's device-proof nonce, nor is one of those a login nonce here (nonces.ts)
 *   POST /gw/v1/session    login: Ed25519 proof of possession of the enrolled key (its SHA-256 SPKI fingerprint is the
 *                          registered SERVER device), then kernel SERVICE_KEY authentication on that device and a
 *                          session bound to an opaque bearer token (tab.gateway_session, never a browser cookie); no
 *                          session binds under a key of small order enrolled before tablets 0702, under which any
 *                          proof verifies (EBMR-DEV-025, D16)
 *   POST /gw/v1/challenge  a challenge for one upload, issued by the database (tab.issue_ingest_challenge, in the
 *                          gateway's INTEGRATION command), which keeps when it issued it (DI-28; tablets 0330)
 *   POST /gw/v1/readings   readings in chain order, with the upload's challenge; each is checked here (schema, hash,
 *                          Ed25519 signature against the enrolled key, raw line equal to the value, the gateway's
 *                          signature over its wait) and ingested by tab.ingest_reading in its own INTEGRATION command
 *                          (INTERFACE.WRITE; chain, sequence, serial, installation checked in SQL). The database
 *                          proves every stored reading again on its own (0270: hash of the stored content, Ed25519
 *                          signature under the enrolled key, raw line stating the value; DI-31, DI-32), so these
 *                          checks here only refuse early. The wait passed with each reading is the gateway's, as it
 *                          signed it over the challenge and the reading id; the database verifies that signature
 *                          and adds its own time from the challenge's issue to the insert (tablets 0330), so the age
 *                          of a reading never rests on this code's word (DI-28, review finding P53). It refuses a
 *                          wait above 100 years (EBMR-DEV-052, also refused here first) and bounds the age of a
 *                          DEVICE_SYNCED reading by its signed capture time as well (0320). The gateway acts only in
 *                          SITE_GATEWAY (INTERFACE.WRITE only; DI-17), and the database takes its work in no other
 *                          role (0290, EBMR-DEV-032). Idempotent by reading id. The first refusal stops the batch
 *                          and raises an alarm (DI-31).
 *   POST /gw/v1/heartbeat  instrument states (every 5 s at most), with the reason a connected instrument is not
 *                          ready; a gap over 10 s shows the scale OFFLINE. First of all, before any statement that can
 *                          wait on a lock, the heartbeat as received goes on record against the bearer token
 *                          (tab.record_heartbeat_receipt, outside any command; tablets 0350): a heartbeat that is then
 *                          held up, cut off or refused in its command keeps the manual path shut (DI-30, PR-20; review
 *                          finding P50, round 4). The receipt is one statement on the receipts pool
 *                          (DevicesRuntime.receiveHeartbeat), which also reads the session behind the token and the
 *                          site's time zone, so a heartbeat makes no other query before its token is known; a token
 *                          this process did not hand out takes its turn there, one at a time. That statement is bounded
 *                          by the receipts pool's own limits (1 s for a connection, 2 s for the statement): a receipt
 *                          not written within them fails the request, and the heartbeat counts as not received
 *                          (decision X31). Every heartbeat is answered within HEARTBEAT_ANSWER_MS (3 s) of its
 *                          arrival, below the gateway's interval: recorded (200), refused, or 503 HEARTBEAT_PENDING
 *                          while its command (on the reports pool, one per gateway at a time: DevicesRuntime.inTurn),
 *                          or the unbinding and end of a session that must log in again, goes on in the background.
 *                          The reports pool bounds each wait for a connection and each statement of that work to 4 s
 *                          (REPORT_STATEMENT_TIMEOUT_MS), one at a time, not the command as a whole; the answer's
 *                          deadline, not those limits, is what keeps the heartbeats coming. So however the waits of a
 *                          command add up (a connection, the session's row, the room's row, the commit), the gateway,
 *                          which sends the next heartbeat only after this one's answer, sends it on its interval, and
 *                          two receipts are at most about 8 s apart as long as each is written within its limits
 *                          (decisions X29, X30; follow-up round 2 of P50). A receipt not written within them (a
 *                          database loaded so far that its statement cannot end within 2 s, a connection lost and not
 *                          yet opened again) is lost, and so is a heartbeat refused before its receipt (a changed time
 *                          zone): every heartbeat is an arrival of the listener's watch (watch.ts), whose next tick
 *                          tells the database that something was not put on record, so the database vouches for no
 *                          window that holds it and refuses a weight keyed by hand instead of counting the scale
 *                          silent (tablets 0350 item 6; decision X37). The receipts and the ticks log in with the
 *                          listener's own role (kernel 0980), on connections opened before the listener listens
 *                          (DevicesRuntime.startWatch). While the database counts the gateway's API unreachable (a
 *                          capture could not reach it), each heartbeat received has the server probe that API
 *                          (DevicesRuntime.probeApi; tablets 0320, DI-30)
 *   POST /gw/v1/process-readings   process values of the presses and coaters (integration-sdk/process, Phase 3 slice
 *                          3a, D-S3-1): checked here against the wire contract (schema, known tag, unit, fraction
 *                          digits, sequence order within the request), then taken whole or refused whole by
 *                          tab.ingest_process_readings in one INTEGRATION command (device by serial of this gateway's
 *                          enrolment, tag of its kind, unit, digits, per-device sequence without gap, duplicates taken
 *                          once; tablets 0820). A refusal raises a device alarm (DI-31) and nothing of the request is kept
 *   GET  /gw/v1/setpoint-downloads  the setpoints waiting for this gateway's devices (tab.pending_setpoint_downloads;
 *                          their values are the MBR's, requested by a G-06 step; the first fetch is recorded)
 *   POST /gw/v1/setpoint-downloads/:id/ack  the gateway's acknowledgement with its read-back (tab.ack_setpoint_download)
 *   POST /gw/v1/logout
 * Integration identities never sign: the kernel refuses SERVICE_KEY authentication for anything but LOGIN, and
 * iam.can_sign refuses non-human accounts.
 *
 * Every request re-reads the site policy site.zone first (AppContext.siteZone, DI-27): a heartbeat in its receipt
 * statement, on the receipts pool, so it never waits for a connection of the browser routes' pool; any other request
 * on the application pool, which its work uses anyway, so no request nobody authenticated takes a connection of the
 * receipts pool. After a change while the server runs, every request is refused with SITE_ZONE_CHANGED (503, no
 * relogin) until the server restarts, so no reading is taken or refused as bad in a context of the old zone; the
 * gateway keeps its journal and sends again. A heartbeat's receipt carries no zone and only keeps the manual path shut.
 */
import { createHash, randomBytes, randomUUID, verify, type KeyObject } from 'node:crypto';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import { UnstorableTextError } from '@ebmr/expr';
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
  uploadWaitMessage,
  type ChallengeResponse,
  type HeartbeatResponse,
  type LoginResponse,
  type ScaleReading,
  type UplinkItem,
  type UplinkResponse,
} from '@ebmr/integration-sdk/scale';
import { PROCESS_READINGS_PATH, processReadingsProblems, SETPOINT_DOWNLOADS_PATH, SetpointAckRequest, type ProcessReadingsRequest, type SetpointDownloadsResponse } from '@ebmr/integration-sdk/process';
import { consumeNonce, mintNonce } from '../../platform/auth/nonces.ts';
import type { AppContext } from '../../platform/context.ts';
import { withActorCommand } from '../../platform/db/commands.ts';
import { unstorableTextSqlState } from '../../platform/http/errors.ts';
import { installStrictJsonBodies, NotUtf8BodyError } from '../../platform/http/json-body.ts';
import { HttpRefusal } from '../../platform/http/refusal.ts';
import { HEARTBEAT_ANSWER_MS, runtimeOf, TurnTaken } from './runtime.ts';
import type { Arrival } from './watch.ts';

const tokenHash = (token: string): string => createHash('sha256').update(token, 'utf8').digest('hex');

const HEARTBEAT_PATH = '/gw/v1/heartbeat';

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

export interface GatewaySession {
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
  /** The roles the session's account holds now (approved, unrevoked, in validity), as the database reports them. */
  roles: string[];
}

/** A gateway session as tab.resolve_gateway_session reports it for the bearer token whose SHA-256 is `hash`. */
export function gatewaySessionOf(hash: string, r: Record<string, unknown>): GatewaySession {
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

/** The SHA-256 of the request's bearer token; 401 NO_TOKEN when it carries none in the expected form. */
/** The bearer token of `request` when it is in the expected form, otherwise null. */
function bearerToken(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  const token = typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  return /^[A-Za-z0-9_-]{40,128}$/.test(token) ? token : null;
}

function bearerHash(request: FastifyRequest): string {
  const token = bearerToken(request);
  if (token === null) throw new GwError(401, 'NO_TOKEN', 'a bearer token is required', true);
  return tokenHash(token);
}

/** The gateway session `r` (tab.resolve_gateway_session) behind the bearer token whose SHA-256 is `hash`; 401 SESSION unless live. */
function liveSession(hash: string, r: Record<string, unknown> | null | undefined): GatewaySession {
  if (!r || r['state'] !== 'ACTIVE') throw new GwError(401, 'SESSION', 'the gateway session is unknown, ended or locked; log in again', true);
  return gatewaySessionOf(hash, r);
}

async function resolveBearer(app: AppContext, request: FastifyRequest): Promise<GatewaySession> {
  const hash = bearerHash(request);
  const { rows } = await app.pools.app.query<{ r: Record<string, unknown> | null }>('select tab.resolve_gateway_session($1) as r', [hash]);
  return liveSession(hash, rows[0]?.r);
}

/**
 * Whether `error`, ending a heartbeat request before its receipt was started, shows the request was no gateway's
 * heartbeat at all (no bearer token in the expected form, a body that is not a heartbeat or cannot be read): then
 * nothing was lost. Anything else (a changed time zone, an unexpected failure) loses a heartbeat that may be the
 * gateway's. A body whose bytes are not UTF-8 sent with a bearer token in the expected form is lost too (review F33,
 * round 2): such a heartbeat was read before, with U+FFFD in place of those bytes, and put on record; refusing it now
 * must keep the manual path shut, not open it (decision X37, the fail-closed side). Without such a token it is no
 * gateway's heartbeat, as the handler would find first.
 */
function notAHeartbeat(error: unknown, request: FastifyRequest): boolean {
  if (error instanceof GwError) return error.code === 'NO_TOKEN' || error.code === 'SCHEMA';
  if (error instanceof NotUtf8BodyError) return bearerToken(request) === null;
  return frameworkRefusal(error) !== null;
}

/**
 * The status of a request Fastify itself refused before any handler ran (a body that is not JSON, not UTF-8, of
 * another content type, over the body limit, or of another length than announced), or null for any other error.
 */
function frameworkRefusal(error: unknown): number | null {
  if (error instanceof HttpRefusal || error instanceof GwError) return null;
  const status = typeof error === 'object' && error !== null ? (error as { statusCode?: unknown }).statusCode : undefined;
  return typeof status === 'number' && status >= 400 && status < 500 ? status : null;
}

/** Why a heartbeat is answered before it is recorded: its answer is due, or a newer heartbeat took its turn. */
function heartbeatPending(why: string): GwError {
  return new GwError(
    503,
    'HEARTBEAT_PENDING',
    `DI-30: the heartbeat was received (it keeps the manual path shut) but not recorded: ${why}; the next heartbeat is taken as usual`,
  );
}

/**
 * The answer's deadline, HEARTBEAT_ANSWER_MS after a heartbeat arrived (decision X29): `signal` aborts then, with a 503
 * HEARTBEAT_PENDING as its reason, and `race` answers with that reason while the work goes on in the background.
 */
function answerDeadline(): { signal: AbortSignal; race<T>(work: Promise<T>): Promise<T>; clear(): void } {
  const reason = heartbeatPending(`its answer was due ${HEARTBEAT_ANSWER_MS} ms after it arrived, and what is left of it goes on in the background`);
  const controller = new AbortController();
  const due = new Promise<never>((_resolve, reject) => {
    controller.signal.addEventListener('abort', () => reject(reason), { once: true });
  });
  due.catch(() => undefined);
  const timer = setTimeout(() => controller.abort(reason), HEARTBEAT_ANSWER_MS);
  return {
    signal: controller.signal,
    race<T>(work: Promise<T>): Promise<T> {
      // Whatever the work ends with after the answer is not left unhandled.
      work.catch(() => undefined);
      return Promise.race([work, due]);
    },
    clear() {
      clearTimeout(timer);
    },
  };
}

/**
 * The only role a gateway acts in (DI-17 least privilege): SITE_GATEWAY, which holds INTERFACE.WRITE and nothing else
 * (0290). The database takes the gateway's readings and heartbeats in no other role (tab.actor_gateway_key,
 * EBMR-DEV-032), even when its account also holds a broader one such as the kernel's SERVICE_ACCOUNT; the kernel
 * refuses the role to an account that does not hold it (EBMR-IAM-108).
 */
export const GATEWAY_ROLE = 'SITE_GATEWAY';

/**
 * The INTEGRATION actor of a gateway session (source INTEGRATION; role GATEWAY_ROLE, whatever else the account
 * holds). `siteZone` is the site policy's zone as the server holds it
 * (AppContext.siteZone.current(), which refuses once the policy changed): the kernel refuses any other
 * (EBMR-IAM-118, DI-27). The kernel checks the role against the account's grants in every command (EBMR-IAM-108).
 */
export function gatewayActor(gw: GatewaySession, siteZone: string, correlationId: string): ActorContext & { deviceId: string } {
  return {
    personId: gw.personId,
    accountId: gw.accountId,
    roleCode: GATEWAY_ROLE,
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

/** DI-28: the longest wait tab.ingest_reading takes (100 years in microseconds); a longer one is no measured wait (EBMR-DEV-052). */
export const MAX_WAIT_US = 3_155_760_000_000_000n;

/**
 * DI-28 (P53): why the wait of an upload item is not the gateway's own, signed over the upload's challenge and the
 * reading id with the enrolled key (null when it is, or when the wait is unknown). tab.ingest_reading checks the same
 * again (EBMR-DEV-053, EBMR-DEV-055) and also that the database issued the challenge to this enrolment (EBMR-DEV-054),
 * so this check only refuses early.
 */
export function waitProofProblem(challengeId: string, item: UplinkItem, publicKey: KeyObject): { code: string; message: string } | null {
  if (item.delayUs === null) return null;
  const id = item.reading.readingId;
  if (item.waitSig === null) {
    return { code: 'EBMR-DEV-053', message: `EBMR-DEV-053 DI-28: the wait of reading ${id} comes without the gateway's signature over a challenge from the database, so it is not proven` };
  }
  let ok: boolean;
  try {
    ok = verify(null, uploadWaitMessage(challengeId, id, item.delayUs), publicKey, Buffer.from(item.waitSig, 'base64'));
  } catch {
    ok = false;
  }
  if (ok) return null;
  return {
    code: 'EBMR-DEV-055',
    message: `EBMR-DEV-055 DI-28: the signature over the wait of reading ${id} (${item.delayUs} microseconds, challenge ${challengeId}) does not verify with the enrolled gateway key`,
  };
}

export interface GatewayListener {
  port: number;
  close(): Promise<void>;
}

export async function startGatewayListener(app: AppContext, listen: { host: string; port: number }): Promise<GatewayListener> {
  // Both installations since Phase 3 slice 2b: a gateway is enrolled in one installation and its login is checked
  // against that installation in SQL (chain, sequence, serial, installation), so a sandbox gateway never feeds GMP.
  const runtime = runtimeOf(app);
  const server = Fastify({ logger: false, bodyLimit: 1024 * 1024, trustProxy: false });
  // Review F33, round 2: a JSON body is read as strict UTF-8, never through Fastify's replacing decoder, which made
  // U+FFFD of bytes that stand for no character (a login name looked up, a not-ready reason recorded, with a character
  // the gateway never sent).
  installStrictJsonBodies(server);

  // DI-30, PR-20 (tablets 0350 item 6): every heartbeat request is an arrival of the listener's watch from its first
  // hook on; one that ends before its receipt was started is settled here.
  const arrivals = new WeakMap<FastifyRequest, Arrival>();

  server.setErrorHandler((error: unknown, request: FastifyRequest, reply: FastifyReply) => {
    const arrival = arrivals.get(request);
    if (arrival && !arrival.started) arrival.settle(notAHeartbeat(error, request));
    if (error instanceof GwError) {
      void reply.code(error.status).send({ error: { code: error.code, message: error.message, relogin: error.relogin } });
      return;
    }
    if (error instanceof HttpRefusal) {
      // SITE_ZONE_CHANGED (DI-27): the gateway's session and token stay valid; it retries after the restart.
      void reply.code(error.status).send({ error: { code: error.refusal.code, message: `${error.refusal.whatHappened} ${error.refusal.why}`.trim(), relogin: false } });
      return;
    }
    if (error instanceof UnstorableTextError || unstorableTextSqlState(error) !== null) {
      // Review F30-F33: text no record can hold (U+0000, a lone surrogate), refused by the database or by the server's
      // guard, is a request not in the expected form, never INTERNAL. A heartbeat refused so was settled above as lost
      // (its receipt was not written), so the watch's next tick is unclean and the manual path stays shut (X37).
      void reply.code(400).send({ error: { code: 'SCHEMA', message: 'the request holds text no record can hold (U+0000, or half of a surrogate pair); nothing of it was stored', relogin: false } });
      return;
    }
    const framework = frameworkRefusal(error);
    if (framework !== null) {
      // Review F33, round 2: a request Fastify could not read (not UTF-8, not JSON, another content type, over the
      // limit) is not in the expected form, never INTERNAL; its message names no text of the body but Fastify's own.
      void reply.code(400).send({ error: { code: 'SCHEMA', message: error instanceof Error ? error.message : 'the request could not be read', relogin: false } });
      return;
    }
    const code = commands.errorCode(error) ?? 'INTERNAL';
    const status = code === 'INTERNAL' ? 500 : 422;
    void reply.code(status).send({ error: { code, message: error instanceof Error ? error.message : String(error), relogin: false } });
  });

  // DI-27: a change of the site policy site.zone while the server runs refuses every gateway request. Read here on the
  // application pool, which the work of these requests uses anyway, so a request nobody authenticated takes no
  // connection of the receipts pool; a heartbeat reads it in its receipt statement instead (it never waits for a
  // connection of the browser routes' pool) and is refused here only once the change is known.
  server.addHook('onRequest', async (request) => {
    if (request.routeOptions.url === HEARTBEAT_PATH) {
      const arrival = runtime.arrived();
      if (arrival) arrivals.set(request, arrival);
      app.siteZone.current();
      return;
    }
    await app.siteZone.check();
  });

  server.post('/gw/v1/nonce', async () => {
    const { nonce } = await mintNonce(app.pools.app, app.config.secrets.nonceKey, null);
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
    if (!(await consumeNonce(app.pools.app, app.config.secrets.nonceKey, body.nonce, null))) await refuse('NONCE', 'the nonce is unknown, used or expired');
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
    runtime.tokenIssued(tokenHash(token));
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

  // DI-28 (P53): the challenge one upload's waits are signed against; the database keeps when it issued it. A refused
  // challenge refuses the upload, so it is alarmed like a refused reading (DI-31).
  server.post('/gw/v1/challenge', async (request) => {
    const gw = await resolveBearer(app, request);
    const actor = gatewayActor(gw, app.siteZone.current(), randomUUID());
    let out: { challengeId: string };
    try {
      out = await withActorCommand(app.pools.app, actor, async (client) => {
        const { rows } = await client.query<{ r: { challengeId: string } }>('select tab.issue_ingest_challenge() as r');
        if (!rows[0]) throw new Error('tab.issue_ingest_challenge returned nothing');
        return rows[0].r;
      });
    } catch (error) {
      const code = commands.errorCode(error) ?? 'INTERNAL';
      const message = `DI-28: no challenge was issued for an upload, so no reading can be received: ${error instanceof Error ? error.message : String(error)}`;
      await recordRefusal(app, { tokenHash: gw.tokenHash, gatewayCode: null, kind: 'READING_REFUSED', code, readingId: null, message });
      throw error;
    }
    const response: ChallengeResponse = { challengeId: out.challengeId };
    return response;
  });

  server.post('/gw/v1/readings', async (request) => {
    const gw = await resolveBearer(app, request);
    const parsed = UplinkRequest.safeParse(request.body);
    if (!parsed.success) {
      await recordRefusal(app, { tokenHash: gw.tokenHash, gatewayCode: null, kind: 'READING_REFUSED', code: 'SCHEMA', readingId: null, message: 'DI-31: a reading batch was not in the expected form' });
      throw new GwError(400, 'SCHEMA', 'DI-31: the readings are not in the expected form');
    }
    const { challengeId } = parsed.data;
    const correlationId = randomUUID();
    const actor = gatewayActor(gw, app.siteZone.current(), correlationId);
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
      const wait = item.delayUs;
      if (wait !== null && BigInt(wait) > MAX_WAIT_US) {
        // Refused here too, so an absurd wait never reaches the database as PostgreSQL's raw "out of range".
        const code = 'EBMR-DEV-052';
        const message = `${code} DI-28: a reported wait of ${wait} microseconds is longer than 100 years, so it is not a measured wait`;
        refused = { readingId: r.readingId, code, message };
        await recordRefusal(app, { tokenHash: gw.tokenHash, gatewayCode: null, kind: 'READING_REFUSED', code, readingId: r.readingId, message, details: { seq: r.seq, deviceCode: r.deviceCode } });
        break;
      }
      const unproven = waitProofProblem(challengeId, item, publicKey);
      if (unproven) {
        refused = { readingId: r.readingId, ...unproven };
        await recordRefusal(app, { tokenHash: gw.tokenHash, gatewayCode: null, kind: 'READING_REFUSED', ...unproven, readingId: r.readingId, details: { seq: r.seq, deviceCode: r.deviceCode, challengeId } });
        break;
      }
      try {
        const out = await withActorCommand(app.pools.app, actor, async (client) => {
          const { rows } = await client.query<{ r: { outcome: 'INGESTED' | 'DUPLICATE'; readingId: string; seq: string; head: { seq: string; hash: string } } }>(
            'select tab.ingest_reading($1::jsonb, $2::bigint, $3::uuid, $4) as r',
            [JSON.stringify(r), wait, challengeId, item.waitSig],
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

  server.post(HEARTBEAT_PATH, async (request) => {
    // DI-30, PR-20 (decision X29): answered within HEARTBEAT_ANSWER_MS of its arrival, whatever holds it up.
    const deadline = answerDeadline();
    try {
      const hash = bearerHash(request);
      const parsed = HeartbeatRequest.safeParse(request.body);
      if (!parsed.success) throw new GwError(400, 'SCHEMA', 'the heartbeat is not in the expected form');
      // DI-30, PR-20 (tablets 0350): the heartbeat as received is on record before anything that can wait, whatever
      // happens to it afterwards; the receipt takes no lock another transaction can hold, and its statement also reads
      // the session behind the token and the site's time zone (DI-27), so nothing else is asked of the database first.
      // Its arrival is settled by the receipt's own outcome (lost when it fails or never runs).
      const receipt = await deadline.race(runtime.receiveHeartbeat(hash, parsed.data, deadline.signal, arrivals.get(request) ?? null));
      app.siteZone.observe(receipt.policyZone);
      const gw = liveSession(hash, receipt.session);
      if (!runtime.link(gw.gatewayCode)) {
        // This server process has no API token for the gateway (it restarted): the gateway must log in again, once
        // its token is unbound and its session ended. Held up, that goes on in the background (503 meanwhile): the
        // gateway's next heartbeat is received as usual, and is told to log in once the token is unbound.
        await deadline.race(runtime.endGatewaySession(hash, gw.sessionId));
        throw new GwError(401, 'RELOGIN', 'log in again to hand over the API token', true);
      }
      // DI-30 (P51): while the database counts this gateway's API unreachable, probe it (not awaited: the heartbeat is
      // answered at once); an answer marks it reachable, so its scales follow its heartbeats again. Asked by the
      // receipt, so a heartbeat held up in its command does not hold up the probe.
      if (receipt.probeApi) void runtime.probeApi(gw.gatewayCode);
      const actor = gatewayActor(gw, app.siteZone.current(), randomUUID());
      const out = await deadline.race(
        runtime.inTurn(gw.gatewayCode, deadline.signal, () =>
          withActorCommand(runtime.reports(), actor, async (client) => {
            const { rows } = await client.query<{ r: HeartbeatResponse }>('select tab.record_heartbeat($1::jsonb) as r', [JSON.stringify(parsed.data)]);
            if (!rows[0]) throw new Error('tab.record_heartbeat returned nothing');
            return rows[0].r;
          }),
        ),
      );
      const response: HeartbeatResponse = { serverTimeUs: out.serverTimeUs, head: out.head };
      return response;
    } catch (error) {
      if (error instanceof TurnTaken) throw heartbeatPending('a newer heartbeat of this gateway took its turn');
      throw error;
    } finally {
      deadline.clear();
    }
  });

  // DI-31 (D-S3-1, tablets 0820): process readings, taken whole or refused whole; a refusal is alarmed.
  server.post(PROCESS_READINGS_PATH, async (request) => {
    const gw = await resolveBearer(app, request);
    const problems = processReadingsProblems(request.body);
    if (problems) {
      const message = `DI-31: the process readings are not in the expected form: ${problems.slice(0, 5).map((p) => `${p.path} ${p.message}`).join('; ')}`;
      await recordRefusal(app, { tokenHash: gw.tokenHash, gatewayCode: null, kind: 'READING_REFUSED', code: 'SCHEMA', readingId: null, message: message.slice(0, 500) });
      throw new GwError(400, 'SCHEMA', message.slice(0, 500));
    }
    const body = request.body as ProcessReadingsRequest;
    const actor = gatewayActor(gw, app.siteZone.current(), randomUUID());
    try {
      return await withActorCommand(app.pools.app, actor, async (client) => {
        const { rows } = await client.query<{ r: Record<string, unknown> }>('select tab.ingest_process_readings($1::jsonb) as r', [JSON.stringify(body)]);
        if (!rows[0]) throw new Error('tab.ingest_process_readings returned nothing');
        return rows[0].r;
      });
    } catch (error) {
      const code = commands.errorCode(error) ?? 'INTERNAL';
      const message = error instanceof Error ? error.message : String(error);
      await recordRefusal(app, { tokenHash: gw.tokenHash, gatewayCode: null, kind: 'READING_REFUSED', code, readingId: null, message, details: { sessionId: body.sessionId, readings: body.readings.length } });
      throw error;
    }
  });

  // Setpoint downloads for this gateway's devices (tablets 0820); the values are the MBR's, never the gateway's.
  server.get(SETPOINT_DOWNLOADS_PATH, async (request) => {
    const gw = await resolveBearer(app, request);
    const actor = gatewayActor(gw, app.siteZone.current(), randomUUID());
    return withActorCommand(app.pools.app, actor, async (client) => {
      const { rows } = await client.query<{ r: SetpointDownloadsResponse }>('select tab.pending_setpoint_downloads() as r');
      if (!rows[0]) throw new Error('tab.pending_setpoint_downloads returned nothing');
      return rows[0].r;
    });
  });

  server.post(`${SETPOINT_DOWNLOADS_PATH}/:id/ack`, async (request) => {
    const gw = await resolveBearer(app, request);
    const id = (request.params as { id?: unknown }).id;
    const parsed = SetpointAckRequest.safeParse(request.body);
    if (typeof id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id) || !parsed.success) {
      throw new GwError(400, 'SCHEMA', 'DI-31: the setpoint acknowledgement is not in the expected form');
    }
    const actor = gatewayActor(gw, app.siteZone.current(), randomUUID());
    try {
      return await withActorCommand(app.pools.app, actor, async (client) => {
        const { rows } = await client.query<{ r: Record<string, unknown> }>('select tab.ack_setpoint_download($1::uuid, $2::jsonb) as r', [id, JSON.stringify(parsed.data)]);
        if (!rows[0]) throw new Error('tab.ack_setpoint_download returned nothing');
        return rows[0].r;
      });
    } catch (error) {
      const code = commands.errorCode(error) ?? 'INTERNAL';
      const message = error instanceof Error ? error.message : String(error);
      await recordRefusal(app, { tokenHash: gw.tokenHash, gatewayCode: null, kind: 'READING_REFUSED', code, readingId: null, message, details: { downloadId: id } });
      throw error;
    }
  });

  server.post('/gw/v1/logout', async (request) => {
    const gw = await resolveBearer(app, request);
    await app.pools.app.query('select tab.unbind_gateway_session($1)', [gw.tokenHash]);
    runtime.issued.delete(gw.tokenHash);
    await identity.endSession(app.pools.app, gw.sessionId).catch(() => undefined);
    runtime.links.delete(gw.gatewayCode);
    return { ok: true };
  });

  // DI-30, PR-20 (tablets 0350 item 6; decision X37): the receipts' and the watch's connections are open and the first
  // tick is on record before anything is received; without them the listener does not start.
  try {
    await runtime.startWatch();
    await server.listen({ host: listen.host, port: listen.port });
  } catch (error) {
    await server.close().catch(() => undefined);
    throw error;
  }
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
