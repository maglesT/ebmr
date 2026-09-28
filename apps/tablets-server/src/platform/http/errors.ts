/**
 * The error mapper (plan section 4): every non-2xx answer is a RefusalEnvelope. `why` is the kernel's, the
 * engine's or the validator's own message; the guidance catalogue adds what happened, what you can do and who
 * can help. Unknown errors are logged with the correlation id and answered as INTERNAL (nothing was saved).
 */
import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { hasZodFastifySchemaValidationErrors, isResponseSerializationError } from 'fastify-type-provider-zod';
import { commands, identity } from '@ebmr/kernel';
import type { RefusalEnvelope } from '@ebmr/api-contract';
import type { AppContext } from '../context.ts';
import type { GuidanceEntry } from './guidance.ts';
import { HttpRefusal } from './refusal.ts';

export interface MappedError {
  status: number;
  envelope: RefusalEnvelope;
}

function fromGuidance(code: string, entry: GuidanceEntry, why: string, correlationId: string, details?: Record<string, string>): MappedError {
  return {
    status: entry.status,
    envelope: {
      refusal: {
        code,
        kind: entry.kind,
        whatHappened: entry.whatHappened,
        why,
        controls: entry.controls ?? [],
        whatYouCanDo: entry.whatYouCanDo,
        whoCanHelp: entry.whoCanHelp,
        ...(details ? { details } : {}),
      },
      correlationId,
      retryable: entry.retryable ?? false,
    },
  };
}

const stripCode = (message: string): string => message.replace(/^\s*EBMR-[A-Z]+-\d{3}:?\s*/, '').replace(/\s*\[EBMR-[A-Z]+-\d{3}\]\s*$/, '');

export function mapError(app: AppContext, error: unknown, correlationId: string): MappedError {
  const g = (code: string): GuidanceEntry => app.guidance.lookup(code) ?? app.guidance.lookup('INTERNAL')!;
  if (error instanceof HttpRefusal) return { status: error.status, envelope: { refusal: error.refusal, correlationId, retryable: error.retryable } };
  if (hasZodFastifySchemaValidationErrors(error)) {
    const why = error.validation.map((v) => `${v.instancePath || '(body)'} ${v.message ?? ''}`.trim()).join('; ');
    return fromGuidance('SCHEMA', g('SCHEMA'), why, correlationId);
  }
  const fe = error as Partial<FastifyError> & { statusCode?: number };
  if (fe.code === 'FST_CSRF_MISSING_SECRET' || fe.code === 'FST_CSRF_INVALID_TOKEN') return fromGuidance('CSRF', g('CSRF'), 'The CSRF token is missing or not bound to this session.', correlationId);
  if (fe.statusCode === 429) return fromGuidance('RATE_LIMITED', g('RATE_LIMITED'), 'Too many attempts from this terminal for this identifier.', correlationId);
  if (error instanceof identity.AuthenticationFailedError) {
    const locked = error.locked || error.reason === 'ACCOUNT_LOCKED';
    const code = locked ? 'AUTH_LOCKED' : 'EBMR-IAM-140';
    return fromGuidance(code, g(code), locked ? 'The account is locked after too many failed attempts.' : 'The user ID, badge, password or PIN is not correct, or the account cannot sign in here.', correlationId);
  }
  if (isResponseSerializationError(error as Error)) return fromGuidance('INTERNAL', g('INTERNAL'), 'The server built an answer that does not match the contract.', correlationId);
  const code = commands.errorCode(error) ?? identity.ebmrCode(error);
  if (code) {
    const entry = app.guidance.lookup(code);
    if (entry) return fromGuidance(code, entry, stripCode((error as Error).message), correlationId);
    return fromGuidance(code, { ...g('INTERNAL'), status: 422, kind: 'NOT_ALLOWED', whatHappened: 'The system refused this action.', retryable: false }, stripCode((error as Error).message), correlationId);
  }
  if (typeof fe.statusCode === 'number' && fe.statusCode >= 400 && fe.statusCode < 500) {
    return fromGuidance('SCHEMA', { ...g('SCHEMA'), status: fe.statusCode === 404 ? 404 : 400 }, fe.message ?? 'bad request', correlationId);
  }
  return fromGuidance('INTERNAL', g('INTERNAL'), 'An unexpected error occurred; it has been logged.', correlationId);
}

export function installErrorHandling(scope: FastifyInstance, app: AppContext): void {
  scope.setErrorHandler((error: unknown, request: FastifyRequest, reply: FastifyReply) => {
    const correlationId = String(request.id);
    const mapped = mapError(app, error, correlationId);
    if (mapped.status >= 500) request.log.error({ err: error, correlationId }, 'request failed');
    else request.log.info({ code: mapped.envelope.refusal.code, status: mapped.status, correlationId }, 'request refused');
    void reply.code(mapped.status).send(mapped.envelope);
  });

}

/** The 404 envelope of an unknown API route (the SPA fallback handles every other path). */
export function sendApiNotFound(app: AppContext, request: FastifyRequest, reply: FastifyReply): void {
  const correlationId = String(request.id);
  const entry = app.guidance.lookup('NOT_FOUND')!;
  void reply.code(404).send(fromGuidance('NOT_FOUND', entry, `${request.method} ${request.url.split('?')[0] ?? ''} is not a route of the ${app.installation} installation.`, correlationId).envelope);
}
