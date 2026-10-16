/**
 * The EMS simulator process (Phase 6 slice 6b, builder B): the room sensor feed, heartbeat, reconciliation and the EMS routes
 * over HTTP for the eBMR's EMS adapter; state lasts for the run of the process.
 *
 *   EBMR_EMS_HTTP=127.0.0.1:4056 node --import tsx apps/simulators/src/ems/main.ts
 *
 * It binds a loopback address unless told otherwise, and stops on SIGTERM or SIGINT. SIMULATOR, DEMO-ONLY.
 */
import { listenAddress, startFeedSimulator } from '../system-feed/server.ts';
import { emsSimulator } from './model.ts';

async function main(): Promise<void> {
  const { feed, plugin } = emsSimulator();
  const sim = await startFeedSimulator(feed, plugin, listenAddress(process.env['EBMR_EMS_HTTP'], '127.0.0.1:4056'));
  console.log(`EMS simulator: http port ${sim.port.toString()} (SIMULATOR, DEMO-ONLY)`);
  const stop = (signal: string) => {
    console.log(`EMS simulator stopping (${signal})`);
    void sim.close().then(() => process.exit(0));
  };
  process.once('SIGTERM', () => stop('SIGTERM'));
  process.once('SIGINT', () => stop('SIGINT'));
}

main().catch((error: unknown) => {
  console.error(`EMS simulator refused to start: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
