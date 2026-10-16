/** Child processes of the demo and E2E stacks: `node --import tsx <entry>`, prefixed logs, health checks. */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { REPO_ROOT } from './paths.ts';

export interface RunningProcess {
  name: string;
  child: ChildProcess;
  /** The last output lines (at most TAIL_LINES), kept also when echo is off, for a start-up failure's message. */
  tail(): string[];
  stop(): Promise<void>;
}

/** Output lines a process keeps for tail(). */
export const TAIL_LINES = 40;

export interface SpawnOptions {
  name: string;
  entry: string;
  args?: string[];
  env: Record<string, string>;
  /** Write each output line prefixed with [name] (default true). */
  echo?: boolean;
  onLine?: (line: string) => void;
}

const COLOURS = ['\u001b[36m', '\u001b[35m', '\u001b[33m', '\u001b[32m', '\u001b[34m'];
let colour = 0;

export function spawnNode(opts: SpawnOptions): RunningProcess {
  const tint = COLOURS[colour++ % COLOURS.length] ?? '';
  const child = spawn(process.execPath, ['--import', 'tsx', opts.entry, ...(opts.args ?? [])], {
    cwd: REPO_ROOT,
    env: { ...process.env, ...opts.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const recent: string[] = [];
  for (const stream of [child.stdout, child.stderr]) {
    if (!stream) continue;
    const rl = createInterface({ input: stream });
    rl.on('line', (line) => {
      recent.push(line);
      if (recent.length > TAIL_LINES) recent.shift();
      opts.onLine?.(line);
      if (opts.echo ?? true) process.stdout.write(`${tint}[${opts.name}]\u001b[0m ${line}\n`);
    });
  }
  return {
    name: opts.name,
    child,
    tail: () => [...recent],
    stop: () =>
      new Promise<void>((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) {
          resolve();
          return;
        }
        const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
        child.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
        child.kill('SIGTERM');
      }),
  };
}

/** Runs a node entry to completion; rejects on a non-zero exit. */
export function runNode(opts: SpawnOptions): Promise<void> {
  const p = spawnNode(opts);
  return new Promise((resolve, reject) => {
    p.child.once('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${opts.name} exited with code ${String(code)}`))));
  });
}

/** Waits until GET url answers 200 (the server's /api/meta). */
export async function waitForHttp(url: string, timeoutMs = 60_000, child?: ChildProcess): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  let last = '';
  while (performance.now() < deadline) {
    if (child && (child.exitCode !== null || child.signalCode !== null)) throw new Error(`the process for ${url} exited (${String(child.exitCode ?? child.signalCode)})`);
    try {
      const res = await fetch(url);
      if (res.status === 200) return;
      last = `status ${res.status}`;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`${url} did not answer within ${timeoutMs} ms (${last})`);
}

export function entryExists(entry: string): boolean {
  return existsSync(entry);
}
