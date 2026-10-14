/**
 * The LMS simulator process (Phase 6 slice 6a, builder B): the feed, heartbeat, reconciliation and the system's own routes
 * over HTTP for the eBMR's LMS adapter; state lasts for the run of the process.
 *
 *   EBMR_LMS_HTTP=127.0.0.1:4053 node --import tsx apps/simulators/src/lms/main.ts
 *
 * It binds a loopback address unless told otherwise, and stops on SIGTERM or SIGINT. SIMULATOR, DEMO-ONLY.
 */
import { listenAddress, startFeedSimulator } from '../system-feed/server.ts';
import { lmsSimulator } from './model.ts';

async function main(): Promise<void> {
  const { feed, plugin } = lmsSimulator();
  const sim = await startFeedSimulator(feed, plugin, listenAddress(process.env['EBMR_LMS_HTTP'], '127.0.0.1:4053'));
  console.log(`LMS simulator: http port ${sim.port.toString()} (SIMULATOR, DEMO-ONLY)`);
  const stop = (signal: string) => {
    console.log(`LMS simulator stopping (${signal})`);
    void sim.close().then(() => process.exit(0));
  };
  process.once('SIGTERM', () => stop('SIGTERM'));
  process.once('SIGINT', () => stop('SIGINT'));
}

main().catch((error: unknown) => {
  console.error(`LMS simulator refused to start: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
