/**
 * The QMS simulator process (Phase 6 slice 6a, builder B): the feed, heartbeat, reconciliation and the system's own routes
 * over HTTP for the eBMR's QMS adapter; state lasts for the run of the process.
 *
 *   EBMR_QMS_HTTP=127.0.0.1:4051 node --import tsx apps/simulators/src/qms/main.ts
 *
 * It binds a loopback address unless told otherwise, and stops on SIGTERM or SIGINT. SIMULATOR, DEMO-ONLY.
 */
import { listenAddress, startFeedSimulator } from '../system-feed/server.ts';
import { qmsSimulator } from './model.ts';

async function main(): Promise<void> {
  const { feed, plugin } = qmsSimulator();
  const sim = await startFeedSimulator(feed, plugin, listenAddress(process.env['EBMR_QMS_HTTP'], '127.0.0.1:4051'));
  console.log(`QMS simulator: http port ${sim.port.toString()} (SIMULATOR, DEMO-ONLY)`);
  const stop = (signal: string) => {
    console.log(`QMS simulator stopping (${signal})`);
    void sim.close().then(() => process.exit(0));
  };
  process.once('SIGTERM', () => stop('SIGTERM'));
  process.once('SIGINT', () => stop('SIGINT'));
}

main().catch((error: unknown) => {
  console.error(`QMS simulator refused to start: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
