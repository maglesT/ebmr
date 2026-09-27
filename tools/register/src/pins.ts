/**
 * Exact pinning of shared packages (ADR 0015).
 *
 * Every internal dependency must use the workspace protocol with an exact version equal to the
 * version of the package it resolves to ("workspace:0.1.0"). Ranges ("workspace:*", "^", "~")
 * are refused, so a shared-package change reaches an edition only when that edition's pin changes.
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './register.ts';

interface Manifest {
  name: string;
  version: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

export function readManifests(root = ROOT): Manifest[] {
  const out: Manifest[] = [];
  for (const dir of ['packages', 'apps', 'tools']) {
    const base = join(root, dir);
    if (!existsSync(base)) continue;
    for (const entry of readdirSync(base)) {
      const file = join(base, entry, 'package.json');
      if (existsSync(file)) out.push(JSON.parse(readFileSync(file, 'utf8')) as Manifest);
    }
  }
  return out;
}

export function checkPins(manifests: Manifest[]): string[] {
  const versions = new Map(manifests.map((m) => [m.name, m.version]));
  const errors: string[] = [];
  for (const m of manifests) {
    for (const [dep, spec] of Object.entries({ ...m.dependencies, ...m.devDependencies })) {
      if (!dep.startsWith('@ebmr/')) continue;
      const exact = /^workspace:(\d+\.\d+\.\d+(?:-[\w.]+)?)$/.exec(spec);
      if (!exact) {
        errors.push(`${m.name}: ${dep} must be pinned as workspace:<exact version>, found "${spec}"`);
        continue;
      }
      const actual = versions.get(dep);
      if (actual === undefined) errors.push(`${m.name}: ${dep} is not a workspace package`);
      else if (actual !== exact[1]) errors.push(`${m.name}: pins ${dep}@${exact[1]} but the workspace has ${actual}`);
    }
  }
  return errors;
}
