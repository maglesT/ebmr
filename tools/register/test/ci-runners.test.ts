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

/** The Ubicloud size (vCPUs) a `runs-on` names, or undefined when it names none or more than one. */
function ubicloudSize(text: string): number | undefined {
  const found = [...text.matchAll(/'ubicloud-standard-(\d+)-ubuntu-2204'/g)];
  return found.length === 1 ? Number(found[0]?.[1]) : undefined;
}

describe('CI runner labels', () => {
  it('[meta] in Ubicloud mode only the end-to-end groups (4), the golden batches (8) and the two jobs the end-to-end groups wait on (2) name a Ubicloud size, written out; every other ci.yml job runs on GitHub-hosted (owner)', () => {
    const jobs = runsOn('ci.yml');
    const sizes: Record<string, number | 'github'> = {};
    for (const [id, text] of jobs) {
      expect(text, id).not.toMatch(/github\.job|format\(|fromJSON\(/);
      expect(text, id).toContain('ubuntu-latest');
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
      'supply-chain': 'github',
      tests: 'github',
      golden: 8,
      report: 'github',
      changes: 2,
      'e2e-plan': 2,
      e2e: 4,
      'e2e-report': 'github',
      traceability: 'github',
    });
  });

  it('[meta] in pod mode only the heavy jobs (the end-to-end groups and the golden batches) run on the pod, and CI_RUNNER github moves them to GitHub-hosted; only CI_RUNNER pod-all puts the light ci.yml jobs on the pod too, and in every other mode they run on GitHub-hosted (owner: heavy jobs on the good machine, light ones elsewhere; lead, 8 Nov: pod-all while GitHub-hosted runners are blocked)', () => {
    const heavy: string[] = [];
    const light: string[] = [];
    const podAllFirst = /^\$\{\{ \(inputs\.runner \|\| vars\.CI_RUNNER\) == 'pod-all' && 'ebmr-pod' \|\| /;
    for (const [id, text] of runsOn('ci.yml')) {
      if (podAllFirst.test(text)) {
        // A light job: the pod only in pod-all mode, named first; after it, GitHub-hosted (or Ubicloud's size, then
        // GitHub-hosted), and the pod named nowhere else.
        light.push(id);
        const rest = text.replace(podAllFirst, '');
        expect(rest, id).not.toContain('ebmr-pod');
        expect(rest === "'ubuntu-latest' }}" || rest.endsWith("|| 'ubuntu-latest' }}"), id).toBe(true);
        continue;
      }
      // A heavy job: GitHub-hosted only for CI_RUNNER github, else (Ubicloud's size, then) the pod, in pod and pod-all.
      expect(text, id).not.toContain('pod-all');
      heavy.push(id);
      expect(text, id).toMatch(/^\$\{\{ \(inputs\.runner \|\| vars\.CI_RUNNER\) == 'github' && 'ubuntu-latest' \|\|/);
      expect(text, id).toMatch(/\|\| 'ebmr-pod' \}\}$/);
    }
    expect(heavy.sort()).toEqual(['e2e', 'golden']);
    expect(light.sort()).toEqual(['changes', 'checks', 'e2e-plan', 'e2e-report', 'report', 'supply-chain', 'tests', 'traceability']);
  });

  it('[meta] the mutation workflow runs its jobs on Ubicloud standard-8 or GitHub-hosted, the size written out', () => {
    for (const [id, text] of runsOn('mutation.yml')) {
      expect(text, id).not.toMatch(/github\.job|format\(|fromJSON\(/);
      expect(ubicloudSize(text), id).toBe(8);
      expect(text, id).toContain("'ubuntu-latest'");
    }
  });

  it('[meta] the size check refuses an empty or computed size', () => {
    expect(ubicloudSize("x && 'ubicloud-standard--ubuntu-2204' || y")).toBeUndefined();
    expect(ubicloudSize("format('ubicloud-standard-{0}-ubuntu-2204', 8)")).toBeUndefined();
    expect(ubicloudSize("'ubicloud-standard-4-ubuntu-2204'")).toBe(4);
  });
});
