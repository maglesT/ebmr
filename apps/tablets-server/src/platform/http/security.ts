/**
 * Security headers and request checks (DI-13; plan sections 2 and 5):
 *  - X-Ebmr-Installation and X-Correlation-Id on every response; no-store on every API request and every JSON answer;
 *  - exact Origin (port included) and Sec-Fetch-Site: same-origin on every non-GET request that reaches a route or
 *    names an API path. What is an API request is decided on what the router runs (the matched route) and on the
 *    decoded path, never on the raw spelling of the URL: the router decodes `/%61pi/...` to `/api/...` (review P8);
 *  - the API only under its literal `/api` prefix: any other spelling of it (`/%61pi/...`, `//api/...`, `/API/...`) is
 *    answered 404 before any handler runs, so a check elsewhere that looks at the raw path (the site-zone re-read
 *    before each API request, DI-27) sees every API request that can run;
 *  - cookies (@fastify/cookie) and session-bound CSRF tokens (@fastify/csrf-protection, userInfo = the session
 *    token hash), one cookie name per installation;
 *  - helmet: the strict CSP (no Trusted Types, which would block `new Worker`), COOP and CORP same-origin,
 *    nosniff, Referrer-Policy no-referrer; HSTS only on https;
 *  - the rate-limit plugin with global: false (routes opt in; the kernel lockout stays authoritative).
 */
import cookie from '@fastify/cookie';
import csrf from '@fastify/csrf-protection';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { requestTokenHash } from '../auth/session.ts';
import type { AppContext } from '../context.ts';
import { sendApiNotFound } from './errors.ts';
import { refusal } from './refusal.ts';

/** The exact Content-Security-Policy of the SPA and the API (plan section 5). */
export const CSP_DIRECTIVES: Readonly<Record<string, string[]>> = {
  'default-src': ["'self'"],
  'script-src': ["'self'"],
  // Plus exactly one inline <style>: react-aria's usePreventScroll injects `@layer { * { overscroll-behavior: contain; } }`
  // on mobile WebKit only (react-aria 3.52.1; the kit's stylesheet carries the same rule). A hash admits that text and
  // nothing else; style attributes stay blocked. Recompute it when react-aria changes the text.
  'style-src': ["'self'", "'sha256-gYiS/BvZvRcK27JIXTuwhZ3hs2+VJ1X+2gUlE+farlg='"],
  'img-src': ["'self'", 'data:'],
  'font-src': ["'self'"],
  'connect-src': ["'self'"],
  'worker-src': ["'self'"],
  'object-src': ["'none'"],
  'base-uri': ["'none'"],
  'form-action': ["'self'"],
  'frame-ancestors': ["'none'"],
};

/** The header as helmet writes it (directives separated by ';'). */
export const CSP_HEADER = Object.entries(CSP_DIRECTIVES)
  .map(([k, v]) => `${k} ${v.join(' ')}`)
  .join(';');

export const INSTALLATION_HEADER = 'x-ebmr-installation';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

const isApiPath = (path: string): boolean => path === '/api' || path.startsWith('/api/');

/**
 * Whether a request is an API request, however its path is spelled: the route the router matched (it matches on the
 * percent-decoded path), else the decoded path itself, compared case-insensitively with repeated slashes collapsed.
 * A path that cannot be decoded counts as an API request (the stricter answer).
 */
export function isApiRequest(request: Pick<FastifyRequest, 'url' | 'routeOptions'>): boolean {
  const route = request.routeOptions.url;
  if (route !== undefined && isApiPath(route)) return true;
  const raw = /^[^?#]*/.exec(request.url)?.[0] ?? request.url;
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return true;
  }
  return isApiPath(decoded.replace(/\/{2,}/g, '/').toLowerCase());
}

/** The API's own spelling: the literal prefix `/api`, then a slash, the query, or nothing. */
const CANONICAL_API = /^\/api(?:[/?#]|$)/;

export async function installSecurity(scope: FastifyInstance, app: AppContext): Promise<void> {
  scope.addHook('onRequest', async (request, reply) => {
    void reply.header(INSTALLATION_HEADER, app.installation);
    void reply.header('x-correlation-id', String(request.id));
    const api = isApiRequest(request);
    if (api) void reply.header('cache-control', 'no-store');
    // Every mutating request that can run a handler (any matched route) or names an API path; a request that matches
    // no route and names no API path only reaches the 404 answer.
    if ((api || request.routeOptions.url !== undefined) && !SAFE_METHODS.has(request.method)) {
      const origin = request.headers.origin;
      const site = request.headers['sec-fetch-site'];
      if (origin !== app.config.publicOrigin || site !== 'same-origin') {
        throw refusal(403, {
          code: 'ORIGIN',
          kind: 'NOT_ALLOWED',
          whatHappened: 'The request did not come from this installation’s own pages, so it was refused.',
          why: `Origin ${origin ?? '(none)'} and Sec-Fetch-Site ${String(site ?? '(none)')}; expected ${app.config.publicOrigin} and same-origin.`,
          controls: ['DI-13'],
          whatYouCanDo: ['Open the installation from its own address and try again.'],
          whoCanHelp: ['The system administrator'],
        });
      }
    }
    // An API route reached under another spelling of its prefix runs nothing (review P8, DI-27).
    if (api && !CANONICAL_API.test(request.url)) {
      sendApiNotFound(app, request, reply);
      return reply;
    }
    return undefined;
  });
  // No JSON answer is ever kept by a cache, whatever route produced it (refusal envelopes included).
  scope.addHook('onSend', async (_request, reply, payload) => {
    if (/^application\/(?:[\w.+-]+\+)?json\b/i.test(String(reply.getHeader('content-type') ?? ''))) void reply.header('cache-control', 'no-store');
    return payload;
  });

  await scope.register(cookie);
  await scope.register(csrf, {
    sessionPlugin: '@fastify/cookie',
    cookieKey: app.config.cookies.csrf,
    cookieOpts: { httpOnly: true, sameSite: 'strict', path: '/', secure: app.config.https },
    csrfOpts: { hmacKey: app.config.secrets.csrfHmacKey },
    getUserInfo: (request) => requestTokenHash(request, app.config) ?? '',
    getToken: (request) => {
      const t = request.headers['x-csrf-token'];
      return typeof t === 'string' ? t : '';
    },
  });
  await scope.register(helmet, {
    global: true,
    contentSecurityPolicy: { useDefaults: false, directives: { ...CSP_DIRECTIVES } },
    crossOriginOpenerPolicy: { policy: 'same-origin' },
    crossOriginResourcePolicy: { policy: 'same-origin' },
    crossOriginEmbedderPolicy: false,
    referrerPolicy: { policy: 'no-referrer' },
    strictTransportSecurity: app.config.https ? { maxAge: 31536000, includeSubDomains: true } : false,
    xFrameOptions: { action: 'deny' },
  });
  // preHandler: the key needs the parsed body (identifier or badge).
  await scope.register(rateLimit, { global: false, hook: 'preHandler' });
}
