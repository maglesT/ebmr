/**
 * A printer simulator process (Phase 3 slice 4a): a line printer with code reader and vision system speaking
 * `ebmr.sim-printer.v1`.
 *
 *   EBMR_SIM_TCP=127.0.0.1:4031 EBMR_SIM_HTTP=127.0.0.1:4032 EBMR_SIM_SERIAL=PRN-0001 EBMR_SIM_SEED=42 \
 *     EBMR_SIM_RATE_PER_MIN=60 node --import tsx apps/simulators/src/printer/main.ts
 *
 * EBMR_SIM_RUNNING=1 starts the line running. It binds loopback addresses only unless told otherwise, and stops on
 * SIGTERM or SIGINT.
 */
import { startPrinterSimulator } from './server.ts';

function address(value: string | undefined, fallback: string): { host: string; port: number } {
  const text = value && value !== '' ? value : fallback;
  const m = /^(.+):(\d+)$/.exec(text);
  if (!m) throw new Error(`not a host:port address: ${text}`);
  return { host: m[1] ?? '127.0.0.1', port: Number(m[2]) };
}

async function main(): Promise<void> {
  const env = process.env;
  const seed = Number(env['EBMR_SIM_SEED'] ?? '42');
  if (!Number.isInteger(seed)) throw new Error('EBMR_SIM_SEED must be an integer');
  const rate = env['EBMR_SIM_RATE_PER_MIN'] ?? '60';
  if (!/^[1-9][0-9]{0,5}$/.test(rate)) throw new Error('EBMR_SIM_RATE_PER_MIN must be a whole number from 1');
  const sim = await startPrinterSimulator({
    tcp: address(env['EBMR_SIM_TCP'], '127.0.0.1:4031'),
    http: address(env['EBMR_SIM_HTTP'], '127.0.0.1:4032'),
    serial: env['EBMR_SIM_SERIAL'] ?? 'PRN-0001',
    seed,
    ratePerMin: BigInt(rate),
    running: env['EBMR_SIM_RUNNING'] === '1' || env['EBMR_SIM_RUNNING'] === 'true',
  });
  console.log(`printer simulator ${sim.model.serial}: ebmr.sim-printer.v1 on tcp port ${sim.tcpPort}, console on http port ${String(sim.httpPort)} (SIMULATOR, DEMO-ONLY)`);
  const stop = (signal: string) => {
    console.log(`printer simulator stopping (${signal})`);
    void sim.close().then(() => process.exit(0));
  };
  process.once('SIGTERM', () => stop('SIGTERM'));
  process.once('SIGINT', () => stop('SIGINT'));
}

main().catch((error: unknown) => {
  console.error(`printer simulator refused to start: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
