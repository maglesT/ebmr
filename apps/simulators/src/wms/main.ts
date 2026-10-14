/**
 * The WMS simulator process (Phase 6 slice 6a; DEMO-ONLY).
 *
 *   EBMR_SIM_HTTP=127.0.0.1:4320 node --import tsx apps/simulators/src/wms/main.ts
 *
 * The eBMR's WMS adapter reads http://127.0.0.1:4320/wms/v1 (its service-keys entry names it as the endpoint).
 */
import { ErpWmsFeed } from '../erp/feed.ts';
import { address, startErpWmsSimulator } from '../erp/server.ts';
import { wmsRoutes } from './model.ts';

async function main(): Promise<void> {
  const feed = new ErpWmsFeed('WMS');
  const sim = await startErpWmsSimulator(feed, wmsRoutes(feed), address(process.env['EBMR_SIM_HTTP'], '127.0.0.1:4320'));
  console.log(`WMS simulator on ${sim.url} (SIMULATOR, DEMO-ONLY)`);
  const stop = (): void => void sim.close().then(() => process.exit(0));
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
}

main().catch((error: unknown) => {
  console.error(`WMS simulator: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
