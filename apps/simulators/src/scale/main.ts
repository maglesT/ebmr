/**
 * The MT-SICS scale simulator process (module C5), started by `pnpm demo` and the E2E stack:
 *
 *   EBMR_SIM_TCP=127.0.0.1:4001 EBMR_SIM_HTTP=127.0.0.1:4002 EBMR_SIM_SERIAL=SIM-0001 EBMR_SIM_SEED=42 \
 *     node --import tsx apps/simulators/src/scale/main.ts
 *
 * Optional: EBMR_SIM_RESOLUTION (default 0.001), EBMR_SIM_UNIT (kg), EBMR_SIM_CAPACITY (60.000). It binds loopback
 * addresses only unless told otherwise, and stops on SIGTERM or SIGINT.
 */
import { startScaleSimulator } from './server.ts';

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
  const sim = await startScaleSimulator({
    tcp: address(env['EBMR_SIM_TCP'], '127.0.0.1:4001'),
    http: address(env['EBMR_SIM_HTTP'], '127.0.0.1:4002'),
    serial: env['EBMR_SIM_SERIAL'] ?? 'SIM-0001',
    seed,
    resolution: env['EBMR_SIM_RESOLUTION'] ?? '0.001',
    unit: env['EBMR_SIM_UNIT'] ?? 'kg',
    capacity: env['EBMR_SIM_CAPACITY'] ?? '60.000',
  });
  console.log(`scale simulator ${sim.model.serial}: MT-SICS on tcp port ${sim.tcpPort}, console on http port ${String(sim.httpPort)} (SIMULATOR, DEMO-ONLY)`);
  const stop = (signal: string) => {
    console.log(`scale simulator stopping (${signal})`);
    void sim.close().then(() => process.exit(0));
  };
  process.once('SIGTERM', () => stop('SIGTERM'));
  process.once('SIGINT', () => stop('SIGINT'));
}

main().catch((error: unknown) => {
  console.error(`scale simulator refused to start: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
