/**
 * The built SPA served from the same origin as the API (plan section 2), so cookies and the CSP stay simple.
 * Unknown non-API GET paths get index.html (client-side routing); unknown API paths get a 404 envelope.
 */
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import fastifyStatic from '@fastify/static';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.ts';
import { sendApiNotFound } from './errors.ts';
import { isApiRequest } from './security.ts';

export async function installSpa(scope: FastifyInstance, app: AppContext): Promise<boolean> {
  const dist = app.config.webDist ? resolve(app.config.webDist) : null;
  const available = dist !== null && existsSync(join(dist, 'index.html'));
  if (available) {
    await scope.register(fastifyStatic, {
      root: dist,
      wildcard: false,
      index: false,
      setHeaders: (res, path) => {
        void res.header('cache-control', path.endsWith('index.html') ? 'no-cache' : 'public, max-age=31536000, immutable');
      },
    });
  }
  scope.setNotFoundHandler((request, reply) => {
    // What is an API path is decided as the security hook decides it (isApiRequest: the decoded path, never the raw
    // spelling), so `/api#...` or any other spelling of the prefix never gets the SPA page (review P8).
    if (isApiRequest(request) || request.method !== 'GET' || !available) {
      sendApiNotFound(app, request, reply);
      return;
    }
    void reply.header('cache-control', 'no-cache').sendFile('index.html');
  });
  return available;
}
