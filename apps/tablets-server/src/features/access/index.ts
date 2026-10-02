/**
 * Feature `access` (module C1; plan section 5, "Lock, unlock, keep-alive and switch"): the kiosk session life
 * around the kernel's session rules (DI-14, DI-19, DI-20, DI-38, INV-40).
 *
 *  - lock: the session locks now (the kernel also locks it after the idle timeout of its terminal class);
 *  - unlock: a fresh SESSION_UNLOCK authentication of the session's own person on the session's own terminal
 *    (badge and PIN on kiosks, user ID and password on office PCs); another person on a kiosk gets 409
 *    SWITCH_USER;
 *  - keep-alive: extends the session before the idle lock; on kiosks it needs a badge tap of the session's
 *    person (kernel: a COMMAND authentication event);
 *  - switch user (kiosks): badge and PIN of the next person; their session opens with a new cookie token, the
 *    old session locks and its cookie token is unbound. Any unsent entry in the browser is discarded (C4).
 *
 * Every authentication runs on the authentication pool, so a failure is recorded and counts toward lockout.
 * Device proofs cover the request body without its proof; the proven terminal must be the session's own.
 */
import { routes, type SessionView } from '@ebmr/api-contract';
import { identity } from '@ebmr/kernel';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { authenticateTap, otherTerminal, personNames, switchUserRefusal, tapRequired } from '../../platform/auth/attribution.ts';
import { without } from '../../platform/auth/device-proof.ts';
import { isShopFloor, newSessionToken, noRoleHeld, resolveSession, sessionView, setSessionCookie, tokenHash, type ResolvedSession } from '../../platform/auth/session.ts';
import type { AppContext } from '../../platform/context.ts';
import { bindRoutes, pathOf } from '../../platform/http/bind.ts';
import { refusal } from '../../platform/http/refusal.ts';
import { ACCESS_GUIDANCE } from './guidance.ts';

export const guidance = ACCESS_GUIDANCE;

/** SessionView with a CSRF token bound to the session's cookie token (the attribution method comes with the session). */
export function accessSessionView(app: AppContext, reply: FastifyReply, session: ResolvedSession): SessionView {
  return sessionView(session, app.config, reply.generateCsrf({ userInfo: session.tokenHash }));
}

async function reload(app: AppContext, session: ResolvedSession): Promise<ResolvedSession> {
  const s = await resolveSession(app.pools.app, session.tokenHash);
  if (!s) throw new Error('the session could not be resolved again');
  return s;
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

function methodRefused(session: ResolvedSession, method: string) {
  const floor = isShopFloor(session.deviceClass);
  return refusal(422, {
    code: 'LOGIN_METHOD',
    kind: 'NOT_ALLOWED',
    whatHappened: 'This terminal uses another way of confirming who you are.',
    why: `${session.deviceCode} is a ${session.deviceClass} terminal; it takes ${floor ? 'badge and PIN' : 'user ID and password'}, not ${method === 'PASSWORD' ? 'user ID and password' : 'badge and PIN'}.`,
    controls: ['DI-20'],
    whatYouCanDo: ['Kiosks: tap your badge and enter your PIN. Office PCs: user ID and password.'],
  });
}

const RATE = { max: 10, timeWindow: '1 minute', by: 'IP_AND_IDENTIFIER' as const };

export function plugin(scope: FastifyInstance, app: AppContext): Promise<void> {
  bindRoutes(
    scope,
    app,
    routes.access,
    {
      lock: async ({ requireSession, reply }) => {
        const s = requireSession();
        await identity.lockSession(app.pools.app, s.sessionId);
        return accessSessionView(app, reply, await reload(app, s));
      },

      unlock: async ({ body, request, reply, requireSession }) => {
        const s = requireSession();
        const { fingerprint, device } = await app.devices.identify(body.proof, { method: request.method, path: pathOf(request), body: without(body, 'proof') });
        if (device.deviceId !== s.deviceId) throw otherTerminal();
        const wanted = isShopFloor(s.deviceClass) ? 'BADGE_PIN' : 'PASSWORD';
        if (body.method !== wanted) throw methodRefused(s, body.method);
        const ev = await identity.authenticate(app.pools.authn, {
          method: body.method,
          identifier: body.identifier,
          secret: body.secret,
          deviceFingerprint: fingerprint,
          purpose: 'SESSION_UNLOCK',
        });
        if (ev.personId !== s.personId || ev.accountId !== s.accountId) {
          if (isShopFloor(s.deviceClass)) throw switchUserRefusal(s, await personNames(app, ev.personId, ev.accountId), 'Unlocking');
          throw refusal(403, {
            code: 'UNLOCK_OTHER_PERSON',
            kind: 'NOT_ALLOWED',
            whatHappened: `Only ${s.legalName} can unlock this session.`,
            why: 'A locked session is unlocked only by its own person, on the same terminal (DI-38).',
            controls: ['DI-38'],
            whatYouCanDo: ['Sign out, then sign in as yourself.'],
          });
        }
        // tablets 0400 (F36): through the binding, so a session whose role is withdrawn is never unlocked.
        await app.pools.app.query('select tab.unlock_session($1, $2)', [s.tokenHash, ev.authEventId]);
        return accessSessionView(app, reply, await reload(app, s));
      },

      keepAlive: async ({ body, request, reply, requireSession }) => {
        const s = requireSession();
        let authEventId: string | undefined;
        if (isShopFloor(s.deviceClass)) {
          if (!body.badgeUid || !body.proof) throw tapRequired();
          const ev = await authenticateTap(
            app,
            s,
            { badgeUid: body.badgeUid, proof: body.proof },
            { method: request.method, path: pathOf(request), body: without(body, 'proof') },
            'Keeping the session open',
            { plainTapOnly: true },
          );
          authEventId = ev.authEventId;
        }
        // tablets 0400 (F36): through the binding, so a session whose role is withdrawn is never extended.
        await app.pools.app.query('select tab.keep_session_alive($1, $2)', [s.tokenHash, authEventId ?? null]);
        return accessSessionView(app, reply, await reload(app, s));
      },

      switchUser: async ({ body, request, reply, requireSession }) => {
        const old = requireSession();
        const { fingerprint, device } = await app.devices.identify(body.proof, { method: request.method, path: pathOf(request), body: without(body, 'proof') });
        if (device.deviceId !== old.deviceId) throw otherTerminal();
        if (!isShopFloor(device.deviceClass)) {
          throw refusal(422, {
            code: 'SWITCH_NOT_ON_OFFICE',
            kind: 'NOT_ALLOWED',
            whatHappened: 'Switching user by badge works on shop-floor kiosks only.',
            why: `${device.code} is an office terminal.`,
            controls: ['DI-20'],
            whatYouCanDo: ['Sign out, then sign in as the other person.'],
          });
        }
        const ev = await identity.authenticate(app.pools.authn, {
          method: 'BADGE_PIN',
          identifier: body.badgeUid,
          secret: body.pin,
          deviceFingerprint: fingerprint,
          purpose: 'LOGIN',
        });
        if (ev.restricted) {
          throw refusal(409, {
            code: 'MUST_CHANGE_SECRET',
            kind: 'NOT_ALLOWED',
            whatHappened: 'You must choose a new PIN before you continue.',
            why: 'The PIN you used is an initial, reset or expired one.',
            controls: ['DI-15'],
            whatYouCanDo: ['Sign out, then sign in on this terminal with your badge: you will be asked for a new PIN.'],
          });
        }
        const opened = await identity.openSession(app.pools.app, ev.authEventId, fingerprint);
        const roles = await liveRoles(app, opened.accountId);
        if (roles.length === 0) {
          await identity.endSession(app.pools.app, opened.sessionId);
          throw noRoleHeld();
        }
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
        // The previous person's session locks (the kernel already ended it when the same person switched in) and
        // its cookie token is unbound, so it can never be resumed from this browser.
        if (opened.personId !== old.personId) await identity.lockSession(app.pools.app, old.sessionId);
        await app.pools.app.query('select tab.unbind_session($1)', [old.tokenHash]);
        setSessionCookie(reply, app.config, token);
        const next = await resolveSession(app.pools.app, hash);
        if (!next) throw new Error('the new session could not be resolved');
        request.log.info({ device: device.code, switched: opened.personId !== old.personId }, 'user switched');
        return accessSessionView(app, reply, next);
      },
    },
    { rateLimits: { unlock: RATE, switchUser: RATE, keepAlive: RATE } },
  );
  return Promise.resolve();
}
