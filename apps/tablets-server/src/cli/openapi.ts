/**
 * OpenAPI document of the frozen contract (plan section 4: from @fastify/swagger, as a CI artifact only).
 * Registers every route's schemas on a bare Fastify instance (no database, no handlers run) and writes the
 * document:  node --import tsx apps/tablets-server/src/cli/openapi.ts .reports/openapi.json
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import swagger from '@fastify/swagger';
import Fastify from 'fastify';
import { jsonSchemaTransform, serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import { allRoutes, CONTRACT_VERSION, RefusalEnvelope, routes } from '@ebmr/api-contract';

export async function openApiDocument(): Promise<unknown> {
  const app = Fastify({ logger: false });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(swagger, {
    openapi: { info: { title: 'Batchwright Tablets API (GMP and sandbox installations)', version: CONTRACT_VERSION } },
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

async function main(): Promise<void> {
  const out = resolve(process.argv[2] ?? '.reports/openapi.json');
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(await openApiDocument(), null, 2)}\n`);
  console.log(`OpenAPI document written to ${out}`);
}

main().catch((error: unknown) => {
  console.error(`openapi: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
