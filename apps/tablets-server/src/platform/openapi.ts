/**
 * The OpenAPI document of the frozen contract (plan section 4: from @fastify/swagger): every route's schemas registered
 * on a bare Fastify instance (no database, no handlers run). The CLI writes it as a CI artifact (cli/openapi.ts); since
 * Phase 7 slice 7g-4 the server also answers it (meta.openapi) for the web app's API reference page, built once per
 * process (the contract does not change while it runs).
 */
import swagger from '@fastify/swagger';
import Fastify from 'fastify';
import { jsonSchemaTransform, serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import { allRoutes, CONTRACT_VERSION, RefusalEnvelope, routes } from '@ebmr/api-contract';

export async function openApiDocument(): Promise<unknown> {
  const app = Fastify({ logger: false });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(swagger, {
    openapi: { info: { title: 'eBMR Tablets API (GMP and sandbox installations)', version: CONTRACT_VERSION } },
    transform: jsonSchemaTransform,
  });
  const typed = app.withTypeProvider<ZodTypeProvider>();
  for (const route of allRoutes(routes)) {
    typed.route({
      method: route.method,
      url: route.path,
      schema: {
        summary: route.summary,
        description: `${route.id} · installation ${route.installation} · auth ${route.auth} · attribution ${route.attribution} · idempotency ${route.idempotency}`,
        tags: [route.id.split('.')[0] ?? 'api'],
        params: route.params,
        querystring: route.query,
        ...(route.body && route.method !== 'GET' ? { body: route.body } : {}),
        ...(route.stream ? {} : { response: { 200: route.response, '4xx': RefusalEnvelope, '5xx': RefusalEnvelope } }),
      },
      handler: () => Promise.reject(new Error('documentation only')),
    });
  }
  await app.ready();
  const doc = app.swagger();
  await app.close();
  return doc;
}

let cached: Promise<Record<string, unknown>> | null = null;

/** The document, built on first use and kept for the life of the process. */
export function cachedOpenApiDocument(): Promise<Record<string, unknown>> {
  cached ??= openApiDocument().then((d) => d as Record<string, unknown>);
  return cached;
}
