/**
 * `pnpm demo:setup`  creates ebmr_tablets_demo and ebmr_sandbox_tablets_demo with DEMO-ONLY keys and personas,
 *                    and builds the SPA.
 * `pnpm demo`        starts the GMP server (:3001), the sandbox server (:3011, gateway listener :3012), the site
 *                    gateway (:3021) and the scale simulator (TCP :4001, console :4002), then prints the URLs and
 *                    the credential card.
 * `pnpm dev`         the same servers without the built SPA, plus Vite dev servers on :5173 (GMP) and :5174
 *                    (sandbox) with hot reload.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { DEMO_DATABASES, DEMO_PORTS, KEYS_DIR, REPO_ROOT, WEB_DIST } from './paths.ts';
import { buildWeb, credentialCard, setupStack, startStack } from './stack.ts';

async function setup(): Promise<void> {
  await setupStack({ databases: DEMO_DATABASES, keysDir: KEYS_DIR, personaSets: 1 });
  await buildWeb();
  console.log('\nDemo set-up complete. Start it with: pnpm demo\n');
}

async function run(dev: boolean): Promise<void> {
  if (!existsSync(join(KEYS_DIR, 'gmp-seed.json')) || !existsSync(join(KEYS_DIR, 'sandbox-seed.json'))) {
    throw new Error('the demo is not set up: run `pnpm demo:setup` first');
  }
  if (!dev && !existsSync(join(WEB_DIST, 'index.html'))) await buildWeb();
  const stack = await startStack({ databases: DEMO_DATABASES, keysDir: KEYS_DIR, ports: DEMO_PORTS, webDist: dev ? null : WEB_DIST, demoDevices: true });
  const viteServers = dev
    ? [
        spawn('pnpm', ['--filter', '@ebmr/tablets-web', 'dev'], { cwd: REPO_ROOT, stdio: 'inherit', env: { ...process.env, EBMR_WEB_PORT: '5173', EBMR_API_ORIGIN: stack.urls.gmp } }),
        spawn('pnpm', ['--filter', '@ebmr/tablets-web', 'dev'], { cwd: REPO_ROOT, stdio: 'inherit', env: { ...process.env, EBMR_WEB_PORT: '5174', EBMR_API_ORIGIN: stack.urls.sandbox } }),
      ]
    : [];
  const banner = [
    '',
    '================================================================================',
    ' eBMR Tablets demo (DEMO-ONLY keys and credentials)',
    `   GMP installation      ${dev ? 'http://localhost:5173 (dev)' : stack.urls.gmp}`,
    `   Sandbox (TEST, NOT GMP) ${dev ? 'http://localhost:5174 (dev)' : stack.urls.sandbox}`,
    `   Scale simulator       ${stack.urls.simulatorConsole}`,
    ...stack.missing.map((m) => `   not installed yet:    ${m}`),
    ' First visit on each installation: pick a demo terminal (office PC or kiosk).',
    '================================================================================',
    credentialCard(KEYS_DIR),
    '================================================================================',
    '',
  ];
  console.log(banner.join('\n'));
  const stop = async () => {
    for (const v of viteServers) v.kill('SIGTERM');
    await stack.stop();
    process.exit(0);
  };
  process.once('SIGINT', () => void stop());
  process.once('SIGTERM', () => void stop());
}

const command = process.argv[2];
const main = command === 'setup' ? setup() : command === 'run' ? run(process.argv.includes('--dev')) : Promise.reject(new Error('usage: cli.ts setup | run [--dev]'));
main.catch((error: unknown) => {
  console.error(`demo: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
