/**
 * The CMMS simulator process (Phase 6 slice 6a, builder B): the feed, heartbeat, reconciliation and the system's own routes
 * over HTTP for the eBMR's CMMS adapter; state lasts for the run of the process.
 *
 *   EBMR_CMMS_HTTP=127.0.0.1:4054 node --import tsx apps/simulators/src/cmms/main.ts
 *
 * It binds a loopback address unless told otherwise, and stops on SIGTERM or SIGINT. SIMULATOR, DEMO-ONLY.
 */
import { listenAddress, startFeedSimulator } from '../system-feed/server.ts';
import { cmmsSimulator } from './model.ts';

async function main(): Promise<void> {
  const { feed, plugin } = cmmsSimulator();
  const sim = await startFeedSimulator(feed, plugin, listenAddress(process.env['EBMR_CMMS_HTTP'], '127.0.0.1:4054'));
  console.log(`CMMS simulator: http port ${sim.port.toString()} (SIMULATOR, DEMO-ONLY)`);
  const stop = (signal: string) => {
    console.log(`CMMS simulator stopping (${signal})`);
    void sim.close().then(() => process.exit(0));
  };
  process.once('SIGTERM', () => stop('SIGTERM'));
  process.once('SIGINT', () => stop('SIGINT'));
}

main().catch((error: unknown) => {
  console.error(`CMMS simulator refused to start: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
