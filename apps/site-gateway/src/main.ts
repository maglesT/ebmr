/**
 * The site gateway process (module C5), started by `pnpm demo` and the E2E stack:
 *
 *   EBMR_GW_CONFIG=var/demo/keys/gateway-config.json node --import tsx apps/site-gateway/src/main.ts
 *
 * It refuses to start when its journal fails verification (a broken chain is never uploaded or extended).
 * It stops on SIGTERM or SIGINT after closing its instruments, uplink and journal.
 */
import { startGatewayApi } from './api.ts';
import { loadGatewayConfig } from './config.ts';
import { SiteGateway } from './gateway.ts';

async function main(): Promise<void> {
  const path = process.env['EBMR_GW_CONFIG'];
  if (!path) throw new Error('EBMR_GW_CONFIG (the gateway configuration file) is required');
  const config = loadGatewayConfig(path);
  const gateway = await SiteGateway.start(config, { log: (m) => console.log(`[${config.gatewayCode}] ${m}`) });
  const api = await startGatewayApi(gateway, config.listen);
  console.log(`site gateway ${config.gatewayCode} (${config.installation}): API on ${config.listen.host}:${api.port}, uplink ${config.uplink}, journal ${config.journalDir}`);
  const stop = (signal: string) => {
    console.log(`site gateway stopping (${signal})`);
    void (async () => {
      await api.server.close().catch(() => undefined);
      await gateway.stop().catch(() => undefined);
      process.exit(0);
    })();
  };
  process.once('SIGTERM', () => stop('SIGTERM'));
  process.once('SIGINT', () => stop('SIGINT'));
}

main().catch((error: unknown) => {
  console.error(`site gateway refused to start: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
