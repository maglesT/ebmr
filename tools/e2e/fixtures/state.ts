/** What the global set-up hands to the workers (EBMR_E2E_STATE), and the seeds it wrote (DEMO-ONLY credentials). */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SeededPersona, SiteSeed } from '@ebmr/test-kit';

export interface E2eState {
  databases: { GMP: string; SANDBOX: string };
  keysDir: string;
  exchangeDir: string;
  urls: { gmp: string; sandbox: string; simulatorConsole: string };
  ports: Record<string, number>;
  workers: number;
}

export function readState(): E2eState {
  const file = process.env['EBMR_E2E_STATE'];
  if (!file) throw new Error('EBMR_E2E_STATE is not set: run the specs through the Playwright config (global set-up)');
  return JSON.parse(readFileSync(file, 'utf8')) as E2eState;
}

export function readSeeds(state: E2eState): { GMP: SiteSeed; SANDBOX: SiteSeed } {
  const read = (f: string) => JSON.parse(readFileSync(join(state.keysDir, f), 'utf8')) as SiteSeed;
  return { GMP: read('gmp-seed.json'), SANDBOX: read('sandbox-seed.json') };
}

/** The persona of this worker's set: worker N uses set N + 1 (set 0 is the demo set). */
export function workerPersona(seed: SiteSeed, key: string, workerIndex: number): SeededPersona {
  const set = workerIndex + 1;
  const p = seed.personas.find((x) => x.key === `${key}-w${set}`);
  if (!p) throw new Error(`persona ${key}-w${set} is not seeded in ${seed.installation}`);
  return p;
}
