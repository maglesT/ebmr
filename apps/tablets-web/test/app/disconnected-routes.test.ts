/**
 * Declutter slice D1 (docs/build-plan/declutter/plan.md section 3, "how the keep list is checked"): the screens of the
 * kept batch-record path call no route of a disconnected namespace, so they keep working where the server answers 410
 * DISCONNECTED (the platform build, or EBMR_DISCONNECT=1). The few disconnected screens that still live inside a kept
 * feature are named here; slice D2 unhooks them (the release EU tab embeds the QP batch package section).
 *
 * Control: DI-17.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DISCONNECTED_NAMESPACES } from '@ebmr/api-contract';

const SRC = join(import.meta.dirname, '../../src');

/** The features of the kept path (plan section 1, with the owner's decisions of 5 November), and the shell. */
const KEPT_DIRS = [
  'app', 'device', 'api',
  ...['access', 'administration', 'audit', 'designer', 'devices', 'floor', 'india', 'labels', 'market', 'master-data', 'master-records',
    'operations', 'planning', 'plant', 'plant-rules', 'quality', 'records', 'release', 'review', 'session'].map((f) => `features/${f}`),
];

/** Disconnected screens inside kept features, for D2 to unhook (file → namespaces it calls). */
const D2_UNHOOK: Record<string, string[]> = {
  'features/labels/SerialisationPages.tsx': ['serialisation'],
  'features/labels/reads.ts': ['serialisation'],
  'features/release/QpPackage.tsx': ['qpPackage'],
  'features/release/QpReaderPage.tsx': ['qpPackage'],
  'features/release/reads.ts': ['notifications'],
};

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? files(p) : /\.tsx?$/.test(name) ? [p] : [];
  });
}

describe('[DI-17] the kept screens call no disconnected route (declutter D1)', () => {
  it('[DI-17] only the named disconnected screens inside kept features reach a disconnected namespace', () => {
    const pattern = new RegExp(`\\broutes\\.(${DISCONNECTED_NAMESPACES.join('|')})\\.`, 'g');
    const found: Record<string, string[]> = {};
    for (const file of KEPT_DIRS.flatMap((d) => files(join(SRC, d)))) {
      const hits = [...readFileSync(file, 'utf8').matchAll(pattern)].map((m) => m[1] ?? '');
      if (hits.length > 0) found[relative(SRC, file)] = [...new Set(hits)].sort();
    }
    expect(found).toEqual(D2_UNHOOK);
  });
});
