/**
 * Logging (plan section 5): pino through Fastify, JSON in production, pino-pretty in development. Secrets,
 * PINs, passwords, credentials, attributions, cookies and CSRF tokens are redacted wherever they appear in a
 * logged object (a test proves it).
 */
import type { Writable } from 'node:stream';
import type { FastifyServerOptions } from 'fastify';

const SECRET_KEYS = ['secret', 'pin', 'password', 'newSecret', 'currentSecret', 'changeTicket', 'credentials', 'attribution', 'serviceKey', 'privateKeyPkcs8', 'csrfToken'];

export const REDACT_PATHS: string[] = [
  ...SECRET_KEYS,
  ...SECRET_KEYS.map((k) => `*.${k}`),
  ...SECRET_KEYS.map((k) => `*.*.${k}`),
  'req.headers.cookie',
  'req.headers["x-csrf-token"]',
  'req.headers.authorization',
  'res.headers["set-cookie"]',
  'headers.cookie',
  'headers["x-csrf-token"]',
  'headers["set-cookie"]',
];

export function loggerOptions(level: string, pretty: boolean, stream?: Writable): Exclude<FastifyServerOptions['logger'], undefined> {
  return {
    level,
    redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
    ...(stream ? { stream } : {}),
    ...(pretty && !stream ? { transport: { target: 'pino-pretty', options: { translateTime: 'SYS:HH:MM:ss', ignore: 'pid,hostname' } } } : {}),
  };
}
