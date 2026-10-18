/**
 * The tablets server process: `node --import tsx apps/tablets-server/src/main.ts` with EBMR_* variables
 * (config.ts). Refuses to start against the wrong kind of database, an http origin in production, or demo
 * switches in production.
 */
import { randomBytes } from 'node:crypto';
import { parseConfig } from './config.ts';
import { buildApp } from './app.ts';
import { FEATURES } from './features/index.ts';

async function main(): Promise<void> {
  const config = parseConfig(process.env, () => randomBytes(32).toString('hex'));
  const built = await buildApp(config);
  const { app, ctx } = built;
  // Phase 7 slice 7g-4: a demo or sandbox server that may recreate its database (EBMR_PG_ADMIN_URL; refused for a
  // production GMP server, config.ts) gets the set-up CLI's own code for its demo data load and reset. Only here, so no
  // feature imports the DEMO-ONLY seeding and a production GMP server never loads it.
  if (config.adminUrl) ctx.operations.demoTooling = await import('./cli/installation.ts');
  await app.listen({ host: config.host, port: config.port });
  app.log.info({ installation: config.installation, database: config.database, origin: config.publicOrigin, demo: ctx.demo.enabled }, 'tablets server ready');

  const closers: { close(): Promise<void> }[] = [];
  if (config.gatewayListen) {
    const provider = FEATURES.find((f) => f.module.startGatewayListener && f.installations.includes(config.installation));
    if (provider?.module.startGatewayListener) {
      closers.push(await provider.module.startGatewayListener(ctx, config.gatewayListen));
      app.log.info({ listen: config.gatewayListen }, 'gateway listener ready');
    } else {
      app.log.warn('EBMR_GATEWAY_LISTEN is set but no feature provides a gateway listener yet (module C5)');
    }
  }

  const stop = async (signal: string): Promise<void> => {
    app.log.info({ signal }, 'shutting down');
    for (const c of closers) await c.close().catch(() => undefined);
    await built.close();
    process.exit(0);
  };
  process.once('SIGTERM', () => void stop('SIGTERM'));
  process.once('SIGINT', () => void stop('SIGINT'));
}

main().catch((error: unknown) => {
  console.error(`tablets server refused to start: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
