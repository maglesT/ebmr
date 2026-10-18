/**
 * Feature `incidents` (Phase 7 slice 7g-2, decision 0025; GMP): the incident register (DI-12) and its CERT-In reporting
 * step over HTTP (contract ns/incidents.ts; kernel 0410). Every rule is the database's: each write is the person's own
 * command through a records definer (never an administrator, then INCIDENT.RAISE where the person works, or
 * INCIDENT.INVESTIGATE, INCIDENT.CERT_IN_REPORT, INCIDENT.CLOSE), and a refusal carries its EBMR-REC-05x code. The reads
 * come from records.incident_current (reads.ts).
 */
import { routes, type IncidentView } from '@ebmr/api-contract';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../../platform/context.ts';
import { withIdempotentActorCommand } from '../../platform/db/commands.ts';
import { bindRoutes } from '../../platform/http/bind.ts';
import type { GuidanceEntry } from '../../platform/http/guidance.ts';
import { incidentDetail, incidentRegister } from './reads.ts';

const entry = (whatHappened: string, whatYouCanDo: string[], status = 422, kind: GuidanceEntry['kind'] = 'NOT_ALLOWED'): GuidanceEntry => ({
  status, kind, whatHappened, whatYouCanDo, whoCanHelp: ['QA', 'The data-integrity lead'], controls: ['DI-12'],
});

export const guidance: Readonly<Record<string, GuidanceEntry>> = {
  'EBMR-REC-050': entry('The incident is not complete: it needs a source from the list, an upper-case type, a severity, a title, and a time with its trust level (or neither).', ['Complete the form and send it again.'], 422, 'INVALID_INPUT'),
  'EBMR-REC-051': entry('There is no incident with this id.', ['Open the incident from the register.'], 404, 'INVALID_INPUT'),
  'EBMR-REC-052': entry('The incident is not in a state that allows this.', ['Reload the incident: an incident is investigated once, closed only while under investigation, and a closed one does not change.'], 409),
  'EBMR-REC-053': entry('This incident was major or critical at some point, so it is closed only with a root cause and a CAPA reference.', ['Give the root cause and the CAPA reference, then close it.']),
  'EBMR-REC-054': entry('Closing an incident needs a closure summary.', ['Write the summary and close it again.'], 422, 'INVALID_INPUT'),
  'EBMR-REC-055': entry('The CERT-In step refused this: an incident is marked reportable once, its report is recorded once with the time it was made and the acknowledgement reference, and a reportable incident closes only after its report.', ['Read the reason below and correct the entry.']),
  'EBMR-REC-056': entry('The impact assessment refused this: it is made by a person, for a record linked to the incident, once, with a rationale (and the deviation reference when there is an impact).', ['Read the reason below and correct the entry.']),
};

export function plugin(scope: FastifyInstance, app: AppContext): Promise<void> {
  const pool = app.pools.app;
  type Ctx = { actor: () => Parameters<typeof withIdempotentActorCommand>[1]; idempotencyKey: string | null | undefined; requestHash: string };
  /** One command as the person's own (idempotent by the request's key); the incident's id is its result. */
  const write = async (ctx: Ctx, sql: string, params: unknown[], idOf?: string): Promise<IncidentView> => {
    const { result } = await withIdempotentActorCommand(pool, ctx.actor(), ctx.idempotencyKey ?? '', ctx.requestHash, async (c) => {
      const r = (await c.query<{ r: string | null }>(sql, params)).rows[0]?.r ?? null;
      return idOf ?? r ?? '';
    });
    return incidentDetail(app, pool, result);
  };
  bindRoutes(scope, app, routes.incidents, {
    register: async ({ query, requireSession }) => {
      requireSession();
      return incidentRegister(app, pool, query.status);
    },
    detail: async ({ params, requireSession }) => {
      requireSession();
      return incidentDetail(app, pool, params.incidentId);
    },
    raise: ({ body, actor, idempotencyKey, requestHash }) =>
      write(
        { actor, idempotencyKey, requestHash },
        'select records.raise_incident($1, $2, $3, $4, $5, $6::jsonb, $7::timestamptz, $8, $9)::text as r',
        [body.source, body.incidentType, body.severity, body.title, body.description, JSON.stringify(body.links), body.occurredAt ?? null, body.occurredAtTrust ?? null, body.certInReportable],
      ),
    link: ({ params, body, actor, idempotencyKey, requestHash }) =>
      write({ actor, idempotencyKey, requestHash }, 'select records.link_incident($1, $2, $3, $4)::text as r', [params.incidentId, body.aggregateType, body.aggregateId, body.stepRef ?? null], params.incidentId),
    startInvestigation: ({ params, body, actor, idempotencyKey, requestHash }) =>
      write({ actor, idempotencyKey, requestHash }, 'select records.start_incident_investigation($1, $2)::text as r', [params.incidentId, body.note ?? null], params.incidentId),
    reclassify: ({ params, body, actor, idempotencyKey, requestHash }) =>
      write({ actor, idempotencyKey, requestHash }, 'select records.reclassify_incident($1, $2, $3)::text as r', [params.incidentId, body.severity, body.justification], params.incidentId),
    assessImpact: ({ params, body, actor, idempotencyKey, requestHash }) =>
      write(
        { actor, idempotencyKey, requestHash },
        'select records.assess_incident_impact($1, $2, $3, $4, $5, $6)::text as r',
        [params.incidentId, body.aggregateType, body.aggregateId, body.outcome, body.rationale, body.deviationRef ?? null],
        params.incidentId,
      ),
    markCertInReportable: ({ params, body, actor, idempotencyKey, requestHash }) =>
      write({ actor, idempotencyKey, requestHash }, 'select records.mark_incident_cert_in_reportable($1, $2)::text as r', [params.incidentId, body.justification], params.incidentId),
    recordCertInReport: ({ params, body, actor, idempotencyKey, requestHash }) =>
      write({ actor, idempotencyKey, requestHash }, 'select records.record_cert_in_report($1, $2::timestamptz, $3)::text as r', [params.incidentId, body.reportedAt, body.reference], params.incidentId),
    close: ({ params, body, actor, idempotencyKey, requestHash }) =>
      write({ actor, idempotencyKey, requestHash }, 'select records.close_incident($1, $2, $3, $4)::text as r', [params.incidentId, body.summary, body.rootCause ?? null, body.capaRef ?? null], params.incidentId),
  });
  return Promise.resolve();
}
