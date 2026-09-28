/**
 * Security headers and request checks (DI-13; plan sections 2 and 5):
 *  - X-Ebmr-Installation and X-Correlation-Id on every response; no-store on /api;
 *  - exact Origin (port included) and Sec-Fetch-Site: same-origin on every non-GET API request;
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
import type { FastifyInstance } from 'fastify';
import { requestTokenHash } from '../auth/session.ts';
import type { AppContext } from '../context.ts';
import { refusal } from './refusal.ts';

/** The exact Content-Security-Policy of the SPA and the API (plan section 5). */
export const CSP_DIRECTIVES: Readonly<Record<string, string[]>> = {
  'default-src': ["'self'"],
  'script-src': ["'self'"],
  'style-src': ["'self'"],
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

export async function installSecurity(scope: FastifyInstance, app: AppContext): Promise<void> {
  scope.addHook('onRequest', async (request, reply) => {
    void reply.header(INSTALLATION_HEADER, app.installation);
    void reply.header('x-correlation-id', String(request.id));
    const api = request.url.startsWith('/api/');
    if (api) void reply.header('cache-control', 'no-store');
    if (api && !SAFE_METHODS.has(request.method)) {
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
