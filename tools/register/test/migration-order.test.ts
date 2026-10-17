/**
 * The migration-order check (6jc-R4; Phase 7 plan, slice 7-0): the rule on synthetic listings, then the real check of
 * this checkout against origin/main. Without origin/main the real check skips with the reason, except on GitHub
 * Actions, where the tests job fetches origin/main first and a missing ref fails, so the check cannot switch itself off.
 */
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { listings, mainCommit, migrationOrderProblems, migrationSources, runnerOrder } from '../src/migration-order.ts';
import { ROOT } from '../src/register.ts';

const main = mainCommit(ROOT);
const onCi = process.env['GITHUB_ACTIONS'] === 'true';

describe('the migration-order rule (synthetic listings)', () => {
  const source = 'packages/kernel/sql';
  const onMain = ['0010_audit.sql', '1271_a.sql', '1282_b.sql'];

  it('[meta] files added after main\'s highest pass; files already on main are not judged again', () => {
    expect(migrationOrderProblems([{ source, main: onMain, branch: [...onMain, '1300_x.sql', '1304_y.sql'] }])).toEqual([]);
    expect(migrationOrderProblems([{ source, main: onMain, branch: onMain }])).toEqual([]);
  });

  it('[meta] a file added below main\'s highest is refused, whether it fills a gap or main overtook the branch', () => {
    expect(migrationOrderProblems([{ source, main: onMain, branch: [...onMain, '1275_gap.sql', '1300_x.sql'] }])).toEqual([
      'packages/kernel/sql/1275_gap.sql is added by the branch but sorts before packages/kernel/sql/1282_b.sql, the highest migration of packages/kernel/sql on main',
    ]);
    // main gained 1310 after the branch forked; the branch's 1305 (and the branch not having 1310 yet) is still refused.
    expect(migrationOrderProblems([{ source, main: [...onMain, '1310_main.sql'], branch: [...onMain, '1305_x.sql'] }])).toHaveLength(1);
  });

  it('[meta] the order is the runner\'s (code units of the name), each source on its own, and only .sql files count', () => {
    // "1282_b.sql" < "1282b.sql" in code units ('_' is 0x5F, 'b' 0x62), and "999_x.sql" sorts after "1282_b.sql".
    expect(['1282b.sql', '999_x.sql', '1282_b.sql'].sort(runnerOrder)).toEqual(['1282_b.sql', '1282b.sql', '999_x.sql']);
    expect(migrationOrderProblems([{ source, main: onMain, branch: [...onMain, '1282_a.sql', 'README.md'] }])).toHaveLength(1);
    expect(
      migrationOrderProblems([
        { source: 'packages/recipe-core/sql', main: ['1170_r.sql'], branch: ['1170_r.sql', '1200_r.sql'] },
        { source: 'apps/tablets-server/sql', main: ['1330_t.sql'], branch: ['1330_t.sql', '1300_t.sql'] },
        { source: 'packages/site-services/sql', main: [], branch: ['0001_new_source.sql'] },
      ]),
    ).toEqual(['apps/tablets-server/sql/1300_t.sql is added by the branch but sorts before apps/tablets-server/sql/1330_t.sql, the highest migration of apps/tablets-server/sql on main']);
  });
});

describe('the migration-order check of this checkout', () => {
  it('[meta] every migration directory of the repository is a migration source the check covers', () => {
    const sources = new Set(migrationSources(ROOT));
    const found: string[] = [];
    for (const top of ['packages', 'apps']) {
      for (const dir of readdirSync(join(ROOT, top))) {
        const sql = join(ROOT, top, dir, 'sql');
        if (existsSync(sql) && readdirSync(sql).some((f) => f.endsWith('.sql'))) found.push(`${top}/${dir}/sql`);
      }
    }
    expect(found.length).toBeGreaterThan(0);
    expect(found.filter((d) => !sources.has(d))).toEqual([]);
  });

  it('[meta] origin/main is available on GitHub Actions (the tests job fetches it)', () => {
    if (onCi) expect(main).toHaveProperty('commit');
  });

  it.skipIf('unavailable' in main)('[meta] every migration added by a branch sorts after every migration of its source on main', () => {
    if (!('commit' in main)) throw new Error(main.unavailable);
    expect(migrationOrderProblems(listings(ROOT, main.commit))).toEqual([]);
  });

  if ('unavailable' in main) console.warn(`migration-order check skipped: ${main.unavailable}`);
});
