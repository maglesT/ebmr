/**
 * The runner labels of the CI workflows (the Ubicloud switch): every job names a literal size. GitHub evaluates
 * `runs-on` before the job starts, when `github.job` is still empty, so a size looked up by the job's id came out empty
 * (`ubicloud-standard--ubuntu-2204`) and every job waited for a runner that does not exist. A job whose label is wrong
 * never starts, so nothing inside the run can fail fast: this test is the guard.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import YAML from 'yaml';
import { ROOT } from '../src/register.ts';

/** Each job's `runs-on` text, by job id. */
function runsOn(workflow: string): Map<string, string> {
  const doc = YAML.parse(readFileSync(join(ROOT, '.github/workflows', workflow), 'utf8')) as { jobs: Record<string, { 'runs-on'?: unknown }> };
  return new Map(Object.entries(doc.jobs).map(([id, job]) => [id, typeof job['runs-on'] === 'string' ? job['runs-on'] : '']));
}

/**
 * The Ubicloud size (vCPUs) a `runs-on` names, or undefined when it names none, or labels of different sizes. A job may
 * name one CI_RUNNER label (ubuntu-2204) and one E2E_RUNNER label (ubuntu-2404, decision 0032) of the same size.
 */
function ubicloudSize(text: string): number | undefined {
  const found = [...text.matchAll(/'ubicloud-standard-(\d+)-ubuntu-(2204|2404)'/g)];
  const sizes = new Set(found.map((m) => m[1]));
  const releases = found.map((m) => m[2]);
  if (found.length === 0 || sizes.size !== 1 || new Set(releases).size !== releases.length) return undefined;
  return Number(found[0]?.[1]);
}

describe('CI runner labels', () => {
  it('[meta] in Ubicloud mode only the end-to-end groups (4), the golden batches (8) and the two jobs the end-to-end groups wait on (2) name a Ubicloud size, written out; every other ci.yml job runs on GitHub-hosted (owner)', () => {
    const jobs = runsOn('ci.yml');
    const sizes: Record<string, number | 'github'> = {};
    for (const [id, text] of jobs) {
      expect(text, id).not.toMatch(/github\.job|format\(|fromJSON\(/);
      expect(text, id).toContain('ubuntu-24.04');
      const size = ubicloudSize(text);
      if (size !== undefined) sizes[id] = size;
      else {
        // GitHub-hosted in every mode: no Ubicloud label at all.
        expect(text, id).not.toContain('ubicloud-standard');
        sizes[id] = 'github';
      }
    }
    // Owner: Ubicloud only for the long jobs (end-to-end groups on 4, golden batches on 8) and the end-to-end gate jobs (2,
    // so the groups never wait in GitHub's queue); everything else on GitHub-hosted.
    expect(sizes).toEqual({
      checks: 'github',
      'rules-mutation': 'github',
      'supply-chain': 'github',
      tests: 'github',
      golden: 8,
      report: 'github',
      changes: 2,
      'e2e-plan': 2,
      e2e: 4,
      'e2e-report': 'github',
      traceability: 'github',
      // Decision 0032: a pull request's SQL mutation of its changed guards, sized as mutation.yml's groups (long).
      'sql-mutation': 8,
      // Stage C part 2: the end-to-end seed (built once per run) and its check on a full run, sized as the groups.
      'e2e-seed': 4,
      'seed-check': 4,
      // Decision 0032: main-green.yml's check is a separate workflow.
    });
  });

  it('[meta] only CI_RUNNER pod (by name) puts the heavy jobs (the end-to-end groups and the golden batches) on the pod; unset or any other value runs them on GitHub-hosted; every other ci.yml job runs on GitHub-hosted in every mode (owner: the repository is public, the pod only when asked for)', () => {
    const onPod: string[] = [];
    for (const [id, text] of runsOn('ci.yml')) {
      if (!text.includes("'ebmr-pod'")) {
        // Never the pod: a literal GitHub-hosted label, or Ubicloud's size else GitHub-hosted.
        expect(text, id).not.toContain('ebmr-pod');
        expect(text === 'ubuntu-24.04' || text.endsWith("|| 'ubuntu-24.04' }}"), id).toBe(true);
        continue;
      }
      onPod.push(id);
      expect(text, id).toMatch(/^\$\{\{ \(inputs\.runner \|\| vars\.CI_RUNNER\) == 'pod' && 'ebmr-pod' \|\|/);
      expect(text, id).toMatch(/\|\| 'ubuntu-24.04' \}\}$/);
    }
    expect(onPod.sort()).toEqual(['e2e', 'e2e-seed', 'golden', 'seed-check']);
  });

  it('[meta] E2E_RUNNER=ubicloud (owner, decision 0032) moves only the end-to-end groups, their seed and the golden batches to Ubicloud ubuntu-2404, each telling the scripts it is a one-job machine', () => {
    const doc = YAML.parse(readFileSync(join(ROOT, '.github/workflows/ci.yml'), 'utf8')) as { jobs: Record<string, { 'runs-on'?: string; env?: Record<string, string> }> };
    const moved = Object.entries(doc.jobs).filter(([, j]) => (j['runs-on'] ?? '').includes('E2E_RUNNER')).map(([id]) => id).sort();
    // seed-check moves with the seed job (lead ruling, 14 November 2026, #268): it starts the seed's physical snapshot,
    // which only the same PostgreSQL build can start, and it belongs to the E2E seed the owner approved for Ubicloud.
    expect(moved).toEqual(['e2e', 'e2e-seed', 'golden', 'seed-check']);
    for (const id of moved) {
      const job = doc.jobs[id];
      expect(job?.['runs-on'], id).toMatch(/vars\.E2E_RUNNER == 'ubicloud' && 'ubicloud-standard-\d+-ubuntu-2404' \|\| 'ubuntu-24.04' \}\}$/);
      expect(job?.env?.['EBMR_CI_HOST'], id).toContain("vars.E2E_RUNNER == 'ubicloud'");
    }
  });

  it('[meta] the mutation workflow runs its jobs on Ubicloud standard-8 or GitHub-hosted, the size written out', () => {
    for (const [id, text] of runsOn('mutation.yml')) {
      expect(text, id).not.toMatch(/github\.job|format\(|fromJSON\(/);
      expect(ubicloudSize(text), id).toBe(8);
      expect(text, id).toContain("'ubuntu-24.04'");
    }
  });

  it('[meta] the size check refuses an empty or computed size', () => {
    expect(ubicloudSize("x && 'ubicloud-standard--ubuntu-2204' || y")).toBeUndefined();
    expect(ubicloudSize("format('ubicloud-standard-{0}-ubuntu-2204', 8)")).toBeUndefined();
    expect(ubicloudSize("'ubicloud-standard-4-ubuntu-2204'")).toBe(4);
  });
});
