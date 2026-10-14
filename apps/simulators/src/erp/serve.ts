/**
 * The long-running ERP simulator process (Phase 6 slice 6a; DEMO-ONLY). The one-shot catalogue import (main.ts) stays
 * as the demo seed.
 *
 *   EBMR_SIM_HTTP=127.0.0.1:4310 node --import tsx apps/simulators/src/erp/serve.ts
 *
 * The eBMR's ERP adapter reads http://127.0.0.1:4310/erp/v1 (its service-keys entry names it as the endpoint).
 */
import { ErpWmsFeed } from './feed.ts';
import { erpRoutes } from './model.ts';
import { address, startErpWmsSimulator } from './server.ts';

async function main(): Promise<void> {
  const feed = new ErpWmsFeed('ERP');
  const sim = await startErpWmsSimulator(feed, erpRoutes(feed), address(process.env['EBMR_SIM_HTTP'], '127.0.0.1:4310'));
  console.log(`ERP simulator on ${sim.url} (SIMULATOR, DEMO-ONLY)`);
  const stop = (): void => void sim.close().then(() => process.exit(0));
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
}

main().catch((error: unknown) => {
  console.error(`ERP simulator: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
