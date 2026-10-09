/**
 * The simulation worker's TypeScript loader belongs to the server (lead TODO T11 of the Phase 2 exit, "tsx at
 * bundling"; DI-04: a simulation is static verification evidence of an MBR, so it must run wherever the server runs).
 *
 * The server runs from TypeScript source in Phase 2 (`node --import tsx`), and the simulation worker loads its entry
 * through tsx's scoped import, resolved from the server's own module (simulation.ts tsxLoaderUrl). tsx was declared
 * only as a development dependency of the repository root, so the worker found it only because the root's
 * node_modules lies above the server's in this checkout: an installation of the server's runtime dependencies alone
 * (a production install, `pnpm deploy --prod`) had no tsx, and every simulation failed with "the TypeScript loader tsx
 * is not installed for the server". Now tsx is a runtime dependency of the server (and of the other apps that run as
 * their own process with `node --import tsx`), pinned to the root's exact version.
 */
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { tsxLoaderUrl } from '../../src/features/designer/simulation.ts';

const REPO = fileURLToPath(new URL('../../../../', import.meta.url));
type Manifest = { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
const manifest = (dir: string): Manifest => JSON.parse(readFileSync(join(REPO, dir, 'package.json'), 'utf8')) as Manifest;

describe('the simulation worker loader (lead TODO T11)', () => {
  it('[DI-04] the simulation worker loads tsx installed for the server itself, at the exact version the repository pins, not the root\'s development copy', () => {
    const pinned = manifest('.').devDependencies?.['tsx'];
    expect(pinned).toMatch(/^\d+\.\d+\.\d+$/);
    expect(manifest('apps/tablets-server').dependencies?.['tsx']).toBe(pinned);
    const own = join(REPO, 'apps/tablets-server/node_modules/tsx');
    expect(existsSync(join(own, 'package.json'))).toBe(true);
    const installed = JSON.parse(readFileSync(join(own, 'package.json'), 'utf8')) as { version: string };
    expect(installed.version).toBe(pinned);
    // The loader the worker imports is the server's own copy.
    expect(fileURLToPath(tsxLoaderUrl()).startsWith(realpathSync(own) + sep)).toBe(true);
  });
});
