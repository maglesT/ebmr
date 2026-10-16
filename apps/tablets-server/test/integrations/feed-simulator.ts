/**
 * A feed simulator (QMS, LIMS, LMS, CMMS; apps/simulators/src/<system>/main.ts) as its own process on a free loopback
 * port, for the builder-B adapter tests (Phase 6 slice 6a). The server tests never import another app's code
 * (.dependency-cruiser.cjs no-app-to-app): they talk to the simulator over HTTP, as the adapter does.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export type FeedSystem = 'QMS' | 'LIMS' | 'LMS' | 'CMMS' | 'EMS';

export interface FeedSimProcess {
  /** The simulator's origin (the adapter's base URL; the feed is under /<system>/v1). */
  base: string;
  post(path: string, body: unknown): Promise<number>;
  fault(fault: string, on: boolean, slowMs?: number): Promise<void>;
  head(): Promise<number>;
  close(): Promise<void>;
}

export async function spawnFeedSimulator(system: FeedSystem): Promise<FeedSimProcess> {
  const entry = fileURLToPath(new URL(`../../../simulators/src/${system.toLowerCase()}/main.ts`, import.meta.url));
  const child: ChildProcess = spawn(process.execPath, ['--import', 'tsx', entry], { env: { ...process.env, [`EBMR_${system}_HTTP`]: '127.0.0.1:0' }, stdio: ['ignore', 'pipe', 'pipe'] });
  const port = await new Promise<number>((resolve, reject) => {
    let out = '';
    const timer = setTimeout(() => reject(new Error(`the ${system} simulator did not start: ${out}`)), 30_000);
    child.stdout?.on('data', (d: Buffer) => {
      out += d.toString('utf8');
      const m = /http port (\d+)/.exec(out);
      if (m?.[1]) {
        clearTimeout(timer);
        resolve(Number(m[1]));
      }
    });
    child.stderr?.on('data', (d: Buffer) => {
      out += d.toString('utf8');
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`the ${system} simulator exited (${String(code)}): ${out}`));
    });
  });
  const base = `http://127.0.0.1:${port.toString()}`;
  const post = async (path: string, body: unknown): Promise<number> =>
    (await fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).status;
  return {
    base,
    post,
    async fault(fault, on, slowMs) {
      const status = await post('/api/fault', { fault, on, ...(slowMs === undefined ? {} : { slowMs }) });
      if (status !== 200) throw new Error(`fault ${fault}: ${status.toString()}`);
    },
    async head() {
      return Number(((await (await fetch(`${base}/api/state`)).json()) as { head: string }).head);
    },
    close: () =>
      new Promise<void>((resolve) => {
        if (child.exitCode !== null) {
          resolve();
          return;
        }
        child.once('exit', () => resolve());
        child.kill('SIGTERM');
      }),
  };
}
