/**
 * Every app that runs as its own Node process from TypeScript source (`node --import tsx <entry>`: the tablets server,
 * the site gateway, the scale simulator) declares the loader among its runtime dependencies, at the exact version the
 * repository root pins (lead TODO T11 of the Phase 2 exit, "tsx at bundling"). Before, only the root declared tsx, as a
 * development dependency: a process started from an installation of its app's runtime dependencies alone could not
 * load its own source. A bundled build (later) replaces the loader; until then this keeps each app installable alone.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO = fileURLToPath(new URL('../../../', import.meta.url));
type Manifest = { name: string; dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
const manifest = (dir: string): Manifest => JSON.parse(readFileSync(join(REPO, dir, 'package.json'), 'utf8')) as Manifest;

/** The apps whose entry is started with `node --import tsx` (their main.ts or CLI; tools/demo starts them). */
const PROCESS_APPS = ['apps/tablets-server', 'apps/site-gateway', 'apps/simulators'];

describe('runtime loader of the app processes (lead TODO T11)', () => {
  it('[meta] each app started with node --import tsx declares tsx as a runtime dependency at the root\'s exact version', () => {
    const pinned = manifest('.').devDependencies?.['tsx'];
    expect(pinned).toMatch(/^\d+\.\d+\.\d+$/);
    expect(PROCESS_APPS.map((dir) => [manifest(dir).name, manifest(dir).dependencies?.['tsx'] ?? null])).toEqual(
      PROCESS_APPS.map((dir) => [manifest(dir).name, pinned]),
    );
  });
});
