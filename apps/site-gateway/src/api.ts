/**
 * The gateway's API for its server (Fastify, loopback by default, 127.0.0.1:3021 in the demo):
 *   GET  /v1/health                     identity, login, journal watermark and instrument states (no secret)
 *   POST /v1/devices/:code/capture      a stable reading (CaptureRequest -> CaptureResponse)
 *   GET  /v1/devices/:code/live         live display samples (SSE, display only, never recorded)
 * Capture and live need the API token this gateway handed to the server at its login (bearer), so only the
 * server it logged in to can trigger captures; the server never holds the gateway's credential.
 */
import { timingSafeEqual } from 'node:crypto';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { CaptureRequest, type LiveSample } from '@ebmr/integration-sdk/scale';
import type { SiteGateway } from './gateway.ts';

function authorised(gateway: SiteGateway, request: FastifyRequest): boolean {
  const header = request.headers.authorization;
  const token = typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  const a = Buffer.from(token, 'utf8');
  const b = Buffer.from(gateway.apiToken, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

function deny(reply: FastifyReply): FastifyReply {
  return reply.code(401).send({ error: { code: 'NOT_AUTHORISED', message: 'the API token of the logged-in server is required', relogin: false } });
}

export async function startGatewayApi(gateway: SiteGateway, listen: { host: string; port: number }): Promise<{ server: FastifyInstance; port: number }> {
  const server = Fastify({ logger: false, bodyLimit: 64 * 1024, trustProxy: false });

  server.get('/v1/health', () => gateway.health());

  server.post<{ Params: { code: string } }>('/v1/devices/:code/capture', async (request, reply) => {
    if (!authorised(gateway, request)) return deny(reply);
    const body = CaptureRequest.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: { code: 'SCHEMA', message: 'the capture request is not in the expected form', relogin: false } });
    return gateway.capture(request.params.code, body.data.purpose, body.data.timeoutMs);
  });

  server.get<{ Params: { code: string } }>('/v1/devices/:code/live', (request, reply) => {
    if (!authorised(gateway, request)) return deny(reply);
    if (!gateway.instruments.has(request.params.code)) return reply.code(404).send({ error: { code: 'UNKNOWN_DEVICE', message: 'not an instrument of this gateway', relogin: false } });
    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive' });
    const send = (sample: LiveSample) => {
      if (!raw.writableEnded) raw.write(`data: ${JSON.stringify(sample)}\n\n`);
    };
    const unsubscribe = gateway.subscribeLive(request.params.code, send);
    raw.once('close', unsubscribe);
    return reply;
  });

  await server.listen({ host: listen.host, port: listen.port });
  const address = server.server.address();
  return { server, port: typeof address === 'object' && address ? address.port : listen.port };
}
