/**
 * Feature `session` (C0; plan section 5): device nonce and identification, the demo device picker, login with
 * user ID and password (office) or badge and PIN (kiosk), role choice, first-login secret change, the current
 * session and logout.
 *
 * Every authentication runs on the authentication pool (kernel identity.authenticate; failures commit and count
 * toward lockout). The session cookie holds an opaque token bound once to the kernel session (tab.bind_session).
 */
import { routes, type DeviceView } from '@ebmr/api-contract';
import { identity } from '@ebmr/kernel';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { ChangeTicketStore } from '../../platform/auth/change-tickets.ts';
import { without } from '../../platform/auth/device-proof.ts';
import { mintNonce } from '../../platform/auth/nonces.ts';
import { clearSessionCookie, isShopFloor, newSessionToken, resolveSession, sessionView, setSessionCookie, tokenHash, type ResolvedSession } from '../../platform/auth/session.ts';
import type { AppContext } from '../../platform/context.ts';
import { bindRoutes, pathOf } from '../../platform/http/bind.ts';
import { refusal } from '../../platform/http/refusal.ts';
import { SESSION_GUIDANCE } from './guidance.ts';

export const guidance = SESSION_GUIDANCE;

function deviceView(device: identity.DeviceInfo): DeviceView {
  const floor = isShopFloor(device.deviceClass);
  return {
    deviceCode: device.code,
    deviceClass: device.deviceClass,
    siteCode: device.siteCode,
    roomCode: device.roomCode,
    lineCode: device.lineCode,
    density: floor ? 'FLOOR' : 'OFFICE',
    loginMethods: floor ? ['BADGE_PIN'] : ['PASSWORD'],
  };
}

function csrfFor(reply: FastifyReply, session: ResolvedSession): string {
  return reply.generateCsrf({ userInfo: session.tokenHash });
}

async function liveRoles(app: AppContext, accountId: string): Promise<string[]> {
  const { rows } = await app.pools.app.query<{ role_code: string }>(
    `select distinct role_code from iam.role_grant
      where account_id = $1 and status = 'APPROVED' and revoked_at is null
        and valid_from <= clock_timestamp() and (valid_to is null or valid_to > clock_timestamp())
      order by role_code`,
    [accountId],
  );
  return rows.map((r) => r.role_code);
}

function loginMethodRefused(device: identity.DeviceInfo, method: string) {
  return refusal(422, {
    code: 'LOGIN_METHOD',
    kind: 'NOT_ALLOWED',
    whatHappened: 'This terminal uses another way of signing in.',
    why: `${device.code} is a ${device.deviceClass} terminal; it takes ${isShopFloor(device.deviceClass) ? 'badge and PIN' : 'user ID and password'}, not ${method === 'PASSWORD' ? 'user ID and password' : 'badge and PIN'}.`,
    controls: ['DI-20'],
    whatYouCanDo: ['Kiosks: tap your badge and enter your PIN. Office PCs: user ID and password.'],
  });
}

const AUTH_RATE_LIMIT = { max: 10, timeWindow: '1 minute', by: 'IP_AND_IDENTIFIER' as const };

export function plugin(scope: FastifyInstance, app: AppContext): Promise<void> {
  const tickets = new ChangeTicketStore();
  bindRoutes(
    scope,
    app,
    routes.session,
    {
      deviceNonce: async () => mintNonce(app.pools.app, app.config.secrets.nonceKey),

      identify: async ({ body, request }) => {
        const { device } = await app.devices.identify(body.proof, { method: request.method, path: pathOf(request), body: without(body, 'proof') });
        return deviceView(device);
      },

      demoDevices: () => {
        if (!app.demo.enabled) {
          return Promise.reject(
            refusal(404, {
              code: 'NOT_FOUND',
              kind: 'NOT_ENABLED',
              whatHappened: 'This function does not exist on this installation.',
              why: 'The demo device picker exists only on demo installations.',
            }),
          );
        }
        return Promise.resolve({ devices: app.demo.devices });
      },

      login: async ({ body, request, reply }) => {
        const { fingerprint, device } = await app.devices.identify(body.proof, { method: request.method, path: pathOf(request), body: without(body, 'proof') });
        const wanted = isShopFloor(device.deviceClass) ? 'BADGE_PIN' : 'PASSWORD';
        if (body.method !== wanted) throw loginMethodRefused(device, body.method);
        const ev = await identity.authenticate(app.pools.authn, {
          method: body.method,
          identifier: body.identifier,
          secret: body.secret,
          deviceFingerprint: fingerprint,
          purpose: 'LOGIN',
        });
        if (ev.restricted) {
          const changeTicket = tickets.issue({ authEventId: ev.authEventId, method: body.method, identifier: body.identifier, fingerprint });
          throw refusal(409, {
            code: 'MUST_CHANGE_SECRET',
            kind: 'NOT_ALLOWED',
            whatHappened: 'You must choose a new password or PIN before you continue.',
            why: 'The secret you used is an initial, reset or expired one.',
            controls: ['DI-15'],
            whatYouCanDo: ['Set a new secret of your own; nobody else will know it.'],
            details: { kind: body.method === 'PASSWORD' ? 'PASSWORD' : 'PIN', changeTicket },
          });
        }
        const opened = await identity.openSession(app.pools.app, ev.authEventId, fingerprint);
        const roles = await liveRoles(app, opened.accountId);
        let role: string | null = roles.length === 1 ? (roles[0] ?? null) : null;
        if (body.roleCode !== undefined) {
          if (!roles.includes(body.roleCode)) {
            await identity.endSession(app.pools.app, opened.sessionId);
            throw refusal(422, { code: 'EBMR-TAB-013', kind: 'NOT_ALLOWED', whatHappened: 'You do not hold that role now.', why: `The account does not hold ${body.roleCode}.`, whatYouCanDo: ['Choose one of your roles.'] });
          }
          role = body.roleCode;
        }
        const token = newSessionToken();
        const hash = tokenHash(token);
        await app.pools.app.query('select tab.bind_session($1, $2, $3)', [opened.sessionId, hash, role]);
        setSessionCookie(reply, app.config, token);
        const session = await resolveSession(app.pools.app, hash);
        if (!session) throw new Error('the new session could not be resolved');
        request.log.info({ device: device.code, deviceClass: device.deviceClass }, 'session opened');
        return sessionView(session, app.config, csrfFor(reply, session));
      },

      changeSecret: async ({ body, request }) => {
        const { fingerprint, device } = await app.devices.identify(body.proof, { method: request.method, path: pathOf(request), body: without(body, 'proof') });
        if ((body.method === 'PASSWORD') !== (body.kind === 'PASSWORD')) {
          throw refusal(400, { code: 'SCHEMA', kind: 'INVALID_INPUT', whatHappened: 'A password is changed with the user ID; a PIN with the badge.' });
        }
        const wanted = isShopFloor(device.deviceClass) ? 'BADGE_PIN' : 'PASSWORD';
        if (body.method === 'PASSWORD' && wanted !== 'PASSWORD') throw loginMethodRefused(device, body.method);
        let authEventId: string;
        if (body.changeTicket !== undefined) {
          const fromTicket = tickets.peek(body.changeTicket, body.method, body.identifier, fingerprint);
          if (!fromTicket) {
            throw refusal(409, {
              code: 'CHANGE_TICKET',
              kind: 'STALE',
              whatHappened: 'The secret change took too long or was started elsewhere.',
              whatYouCanDo: ['Sign in again; you will be asked for a new secret.'],
              whoCanHelp: ['The system administrator, if your initial secret no longer works'],
            });
          }
          authEventId = fromTicket;
        } else {
          const ev = await identity.authenticate(app.pools.authn, {
            method: body.method,
            identifier: body.identifier,
            secret: body.currentSecret ?? '',
            deviceFingerprint: fingerprint,
            purpose: 'CREDENTIAL_CHANGE',
          });
          authEventId = ev.authEventId;
        }
        await identity.changeSecret(app.pools.authn, {
          authEventId,
          kind: body.kind,
          newSecret: body.newSecret,
          ...(body.method === 'PASSWORD' ? { loginName: body.identifier } : {}),
        });
        if (body.changeTicket !== undefined) tickets.consume(body.changeTicket);
        return { changed: true as const };
      },

      get: ({ requireSession, reply }) => {
        const session = requireSession();
        return Promise.resolve(sessionView(session, app.config, csrfFor(reply, session)));
      },

      chooseRole: async ({ body, requireSession, reply }) => {
        const session = requireSession();
        await app.pools.app.query('select tab.set_session_role($1, $2)', [session.tokenHash, body.roleCode]);
        const updated = await resolveSession(app.pools.app, session.tokenHash);
        if (!updated) throw new Error('the session could not be resolved after the role choice');
        return sessionView(updated, app.config, csrfFor(reply, updated));
      },

      logout: async ({ requireSession, reply }) => {
        const session = requireSession();
        await app.pools.app.query('select tab.unbind_session($1)', [session.tokenHash]);
        await identity.endSession(app.pools.app, session.sessionId);
        clearSessionCookie(reply, app.config);
        return { loggedOut: true as const };
      },
    },
    { rateLimits: { login: AUTH_RATE_LIMIT, changeSecret: AUTH_RATE_LIMIT, identify: { max: 60, timeWindow: '1 minute' }, deviceNonce: { max: 120, timeWindow: '1 minute' } } },
  );
  return Promise.resolve();
}
