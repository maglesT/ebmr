/**
 * The software bill of materials of the release (Phase 7 slice 7c; plan "the SBOM (CycloneDX)"): CycloneDX 1.5 JSON
 * of the product, its workspace packages (each pinned exactly, ADR 0015) and the external packages they declare, with
 * the versions the lockfile resolved. Deterministic: no serial number, no timestamp; components sorted.
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { compareText } from '@ebmr/validation-kit';
import { ROOT } from './sources.ts';

interface Manifest {
  name: string;
  version: string;
  dependencies?: Record<string, string>;
}

function manifests(): Manifest[] {
  const out: Manifest[] = [];
  for (const top of ['packages', 'apps', 'tools']) {
    for (const d of readdirSync(join(ROOT, top)).sort()) {
      const f = join(ROOT, top, d, 'package.json');
      if (existsSync(f)) out.push(JSON.parse(readFileSync(f, 'utf8')) as Manifest);
    }
  }
  return out;
}

/** The version the lockfile resolved for `name` at `spec` (the spec itself when it is exact and not found). */
function resolved(lock: string, name: string, spec: string): string {
  const exact = spec.replace(/^[\^~]/, '');
  const m = new RegExp(`\\n  '?${name.replace(/[/@.]/g, (c) => `\\${c}`)}@([0-9][^:'(\\s]*)`).exec(lock);
  return m?.[1] ?? exact;
}

export function cycloneDx(version: string, product = 'Batchwright Tablets'): Record<string, unknown> {
  const lock = readFileSync(join(ROOT, 'pnpm-lock.yaml'), 'utf8');
  const all = manifests();
  const internal = new Set(all.map((m) => m.name));
  const components = new Map<string, { type: string; name: string; version: string; purl: string; scope: string }>();
  for (const m of all) {
    components.set(`${m.name}@${m.version}`, { type: 'library', name: m.name, version: m.version, purl: `pkg:npm/${encodeURIComponent(m.name)}@${m.version}`, scope: 'required' });
    for (const [dep, spec] of Object.entries(m.dependencies ?? {})) {
      if (internal.has(dep)) continue;
      const v = resolved(lock, dep, spec);
      components.set(`${dep}@${v}`, { type: 'library', name: dep, version: v, purl: `pkg:npm/${encodeURIComponent(dep)}@${v}`, scope: 'required' });
    }
  }
  return {
    bomFormat: 'CycloneDX',
    specVersion: '1.5',
    version: 1,
    metadata: { component: { type: 'application', name: product, version } },
    components: [...components.values()].sort((a, b) => compareText(a.name, b.name) || compareText(a.version, b.version)),
  };
}
