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
  it('[meta] in Ubicloud mode the heavy ci.yml jobs name a size of 4 or 8 written out and only the light jobs run on GitHub-hosted (owner)', () => {
    const jobs = runsOn('ci.yml');
    const sizes: Record<string, number | 'github'> = {};
    for (const [id, text] of jobs) {
      expect(text, id).not.toMatch(/github\.job|format\(|fromJSON\(/);
      expect(text, id).toContain("'ubuntu-latest'");
      expect(text, id).toContain("'ebmr-pod'");
      const size = ubicloudSize(text);
      if (size !== undefined) sizes[id] = size;
      else {
        // A light job: GitHub-hosted for both github and ubicloud, the pod otherwise. No Ubicloud label at all.
        expect(text, id).not.toContain('ubicloud-standard');
        expect(text, id).toContain("== 'ubicloud') && 'ubuntu-latest'");
        sizes[id] = 'github';
      }
    }
    // Owner: test shards, golden batches and end-to-end groups on 8, the static checks on 4; the light jobs on GitHub-hosted.
    expect(sizes).toEqual({
      checks: 4,
      'supply-chain': 'github',
      tests: 8,
      golden: 8,
      report: 'github',
      'e2e-plan': 'github',
      e2e: 8,
      'e2e-report': 'github',
      traceability: 'github',
    });
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
