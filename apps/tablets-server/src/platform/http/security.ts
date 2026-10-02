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
 *    token hash), one cookie name per installation; an API request that carries either of them more than once is
 *    refused (401 COOKIE_DUPLICATED) and the copies other pages set are removed (review F41);
 *  - helmet: the strict CSP (no Trusted Types, which would block `new Worker`), COOP and CORP same-origin,
 *    nosniff, Referrer-Policy no-referrer; HSTS only on https; on every answer, the gate's own refusals included
 *    (its hooks run before the gate's);
 *  - the rate-limit plugin with global: false (routes opt in; the kernel lockout stays authoritative).
 */
import cookie from '@fastify/cookie';
import csrf from '@fastify/csrf-protection';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { cookieCount, requestTokenHash } from '../auth/session.ts';
import type { AppContext } from '../context.ts';
import { fromGuidance, sendApiNotFound } from './errors.ts';
import type { GuidanceCatalogue } from './guidance.ts';
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

/**
 * The headers helmet writes with the options below, for the few answers Fastify sends before any hook can run (a URL
 * it cannot decode: FST_ERR_BAD_URL, and its other framework errors). test/platform/security.test.ts compares this set
 * with what helmet writes on an ordinary answer, so the two cannot drift apart (review F43).
 */
export function frameworkSecurityHeaders(https: boolean): Record<string, string> {
  return {
    'content-security-policy': CSP_HEADER,
    'cross-origin-opener-policy': 'same-origin',
    'cross-origin-resource-policy': 'same-origin',
    'origin-agent-cluster': '?1',
    'referrer-policy': 'no-referrer',
    ...(https ? { 'strict-transport-security': 'max-age=31536000; includeSubDomains' } : {}),
    'x-content-type-options': 'nosniff',
    'x-dns-prefetch-control': 'off',
    'x-download-options': 'noopen',
    'x-frame-options': 'DENY',
    'x-permitted-cross-domain-policies': 'none',
    'x-xss-protection': '0',
  };
}

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

/**
 * The Set-Cookie values that remove every copy of these cookies a page could have set for this request's path: each
 * path the browser matches against it except `/` (where this server's own HttpOnly cookies live, which another page
 * can neither overwrite nor shadow there), under the name and as a nameless cookie whose value starts with the name
 * (the browser sends that as `name=value`), and on https the partitioned copy at `/`.
 */
export function duplicateCookieExpiries(url: string, names: readonly string[], https: boolean): string[] {
  const path = /^[^?#]*/.exec(url)?.[0] ?? '/';
  const paths = new Set<string>();
  for (let i = path.indexOf('/', 1); ; i = path.indexOf('/', i + 1)) {
    const prefix = i < 0 ? path : path.slice(0, i);
    if (prefix.length > 1) paths.add(prefix);
    if (i < 0) break;
    paths.add(path.slice(0, i + 1));
  }
  const secure = https ? '; Secure' : '';
  const out: string[] = [];
  for (const name of names) {
    for (const p of paths) out.push(`${name}=; Path=${p}; Max-Age=0${secure}`, `=${name}=; Path=${p}; Max-Age=0${secure}`);
    if (https) out.push(`${name}=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Strict; Partitioned`);
  }
  return out;
}

/** The API's own spelling: the literal prefix `/api`, then a slash, the query, or nothing. */
const CANONICAL_API = /^\/api(?:[/?#]|$)/;

export async function installSecurity(scope: FastifyInstance, app: AppContext): Promise<void> {
  // Helmet first: Fastify runs onRequest hooks in the order they are added, and the gate below answers some requests
  // itself (403 ORIGIN, the 404 for another spelling of /api), as does the site-zone hook after it. Registered after
  // them, helmet never ran for those answers, which then carried no CSP, frame or CORP header (review F43).
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
  // This installation's session or CSRF cookie more than once (review F41): cookies ignore ports, so a page on another
  // port of the host (the other installation's, or any) can set a copy with a longer path, or a partitioned one, that
  // the browser sends first. Such a request is served as nobody (never one of the values); the copies other pages set
  // are removed, so the retry carries this server's own cookie only.
  scope.addHook('onRequest', async (request, reply) => {
    if (!isApiRequest(request)) return;
    const names = [app.config.cookies.session, app.config.cookies.csrf].filter((n) => cookieCount(request.headers, n) > 1);
    if (names.length === 0) return;
    request.log.warn({ cookies: names, correlationId: String(request.id) }, 'security: a request carried a cookie of this installation more than once; served as nobody');
    void reply.header('set-cookie', duplicateCookieExpiries(request.url, names, app.config.https));
    throw refusal(
      401,
      {
        code: 'COOKIE_DUPLICATED',
        kind: 'NOT_ALLOWED',
        whatHappened: 'Another page on this computer set a second sign-in cookie for this installation, so the request was not served.',
        why: `The request carried ${names.join(' and ')} more than once. The copies other pages set have been removed.`,
        controls: ['DI-13', 'DI-38'],
        whatYouCanDo: ['Try again.', 'If it happens again, close the pages of other addresses of this computer, then clear the cookies of this site.'],
        whoCanHelp: ['The system administrator'],
      },
      true,
    );
  });
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
  // preHandler: the key needs the parsed body (identifier or badge).
  await scope.register(rateLimit, { global: false, hook: 'preHandler' });
}

/**
 * The answer to an error Fastify raises before any hook runs (FST_ERR_BAD_URL for a URL it cannot decode, the
 * parameter-length and async-constraint errors): the refusal envelope, with the installation and correlation headers,
 * no-store and helmet's header set. Without it Fastify wrote its own body with none of these (review F43).
 */
export function answerFrameworkError(
  installation: string,
  https: boolean,
  guidance: GuidanceCatalogue,
  error: FastifyError,
  request: FastifyRequest,
  reply: FastifyReply,
): void {
  const correlationId = String(request.id);
  const status = typeof error.statusCode === 'number' && error.statusCode >= 400 ? error.statusCode : 400;
  const base = status >= 500 ? guidance.lookup('INTERNAL')! : guidance.lookup('SCHEMA')!;
  const mapped = fromGuidance(status >= 500 ? 'INTERNAL' : 'SCHEMA', { ...base, status }, status >= 500 ? 'An unexpected error occurred; it has been logged.' : 'The address of the request is not valid.', correlationId);
  request.log.info({ code: error.code, status, correlationId }, 'request refused before routing');
  void reply
    .code(status)
    .headers({ ...frameworkSecurityHeaders(https), [INSTALLATION_HEADER]: installation, 'x-correlation-id': correlationId, 'cache-control': 'no-store', 'content-type': 'application/json; charset=utf-8' })
    .send(JSON.stringify(mapped.envelope));
}
