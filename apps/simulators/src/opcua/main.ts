/**
 * The OPC UA equipment simulator process (Phase 6 slice 6b, builder A): one OPC UA server with a unit of every Tablets
 * kind (./server.ts), SignAndEncrypt only.
 *
 *   EBMR_SIM_OPCUA_PORT=4840 EBMR_SIM_HTTP=127.0.0.1:4841 EBMR_SIM_LOCATION=RM-COMP-1 EBMR_SIM_PKI=.sim-opcua-pki \
 *     node --import tsx apps/simulators/src/opcua/main.ts
 *
 * It prints the endpoint URL and the SHA-256 of its certificate (enrol the endpoint with it), binds loopback only unless
 * told otherwise, and stops on SIGTERM or SIGINT. SIMULATOR, DEMO-ONLY.
 */
import { startOpcuaSimulator } from './server.ts';

async function main(): Promise<void> {
  const env = process.env;
  const http = /^(.+):(\d+)$/.exec(env['EBMR_SIM_HTTP'] ?? '127.0.0.1:4841');
  const sim = await startOpcuaSimulator({
    port: Number(env['EBMR_SIM_OPCUA_PORT'] ?? '4840'),
    http: http ? { host: http[1] ?? '127.0.0.1', port: Number(http[2]) } : null,
    pkiDir: env['EBMR_SIM_PKI'] ?? '.sim-opcua-pki',
    location: env['EBMR_SIM_LOCATION'] ?? 'RM-COMP-1',
    hostname: env['EBMR_SIM_HOST'] ?? '127.0.0.1',
    seed: Number(env['EBMR_SIM_SEED'] ?? '42'),
  });
  console.log(`OPC UA simulator: ${sim.endpointUrl} (SignAndEncrypt), certificate SHA-256 ${sim.thumbprint}, console on http port ${String(sim.httpPort)} (SIMULATOR, DEMO-ONLY)`);
  const stop = (signal: string) => {
    console.log(`OPC UA simulator stopping (${signal})`);
    void sim.close().then(() => process.exit(0));
  };
  process.once('SIGTERM', () => stop('SIGTERM'));
  process.once('SIGINT', () => stop('SIGINT'));
}

main().catch((error: unknown) => {
  console.error(`OPC UA simulator refused to start: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
