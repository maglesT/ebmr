/**
 * OpenAPI document of the frozen contract (plan section 4: from @fastify/swagger, as a CI artifact only; the server's
 * API reference page shows the same document, platform/openapi.ts):
 *   node --import tsx apps/tablets-server/src/cli/openapi.ts .reports/openapi.json
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { openApiDocument } from '../platform/openapi.ts';

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
