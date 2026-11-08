/**
 * D-4 (demo gaps): `pnpm demo:setup` gives GMP the whole library catalogue approved, so "Add library block" offers it on a
 * fresh demo. Each approval is the real signed act of the demo QA persona, and its record says what was done: the
 * command and the signature carry the reason "Demo set-up: seed catalogue approved by the demo QA persona (demo:setup)"
 * (owner rule: records say what was actually done). DEMO-ONLY: product code never calls the seeding.
 *
 * Controls: PR-05 (QA-approved library content), DI-35 (the approval signature), DI-22 (the audit trail with its reason).
 */
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { librarySeed } from '@ebmr/recipe-core';
import { library } from '@ebmr/recipe-core/pure';
import { ADMIN_URL, dropDatabase, endPool, openPool } from '@ebmr/test-kit';
import { setupInstallation } from '../../src/cli/setup.ts';
import { DEMO_CATALOGUE_REASON } from '../../src/cli/demo-catalogue.ts';

const database = `ebmr_democat_e2e_${randomBytes(4).toString('hex')}`;
const dir = mkdtempSync(join(tmpdir(), 'ebmr-seed-catalogue-'));
let pool: pg.Pool;

beforeAll(async () => {
  await setupInstallation({ installation: 'GMP', database, keysDir: join(dir, 'keys'), exchangeDir: join(dir, 'exchange'), personaSets: 1, recreate: true, demoCatalogue: true, log: () => undefined });
  const url = new URL(ADMIN_URL);
  url.pathname = `/${database}`;
  pool = openPool({ connectionString: url.toString(), max: 2 });
}, 900_000);

afterAll(async () => {
  if (pool) await endPool(pool);
  await dropDatabase(database);
  rmSync(dir, { recursive: true, force: true });
});

describe('the demo\'s approved library catalogue (D-4)', () => {
  it('[PR-05][DI-35] every seed block of every edition is APPROVED, each by a LIBRARY_BLOCK_APPROVED signature of the demo QA persona', async () => {
    const { rows } = await pool.query<{ code: string; state: string; edition: string; signatures: number }>(
      `select b.code, recipe.library_block_state(b.id) as state, recipe.library_block_edition(b.definition) as edition,
              (select count(*)::int from esig.signature s where s.aggregate_type = 'library_block' and s.aggregate_id = b.id::text and s.meaning_code = 'LIBRARY_BLOCK_APPROVED') as signatures
         from recipe.library_block b order by b.code`,
    );
    const seed = librarySeed.SEED_CATALOGUE.map((i) => i.definition.code).sort();
    expect(rows.map((r) => r.code)).toEqual(seed);
    expect(rows.filter((r) => r.state !== 'APPROVED' || r.signatures !== 1)).toEqual([]);
    const editions = new Set(librarySeed.SEED_CATALOGUE.map((i) => library.blockEdition(i.definition)));
    expect(new Set(rows.map((r) => r.edition))).toEqual(editions);
  });

  it('[DI-22][DI-35] each approval\'s audit record says the demo set-up made it, not a person who reviewed the block', async () => {
    const { rows } = await pool.query<{ total: number; with_reason: number }>(
      `select count(*)::int as total,
              count(*) filter (where exists (select 1 from kernel.audit_event e where e.record_id = s.id::text and e.payload ->> 'reason_text' = $1))::int as with_reason
         from esig.signature s where s.aggregate_type = 'library_block' and s.meaning_code = 'LIBRARY_BLOCK_APPROVED'`,
      [DEMO_CATALOGUE_REASON],
    );
    expect(rows[0]?.total).toBe(librarySeed.SEED_CATALOGUE.length);
    expect(rows[0]?.with_reason).toBe(rows[0]?.total);
  });

  it('[meta] DEMO-ONLY: only the set-up CLI calls the catalogue seeding; no feature or platform code imports it', () => {
    const root = new URL('../../src/', import.meta.url).pathname;
    const files = (d: string): string[] => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? files(join(d, f)) : [join(d, f)]));
    const callers = files(root).filter((f) => f.endsWith('.ts') && !f.endsWith('demo-catalogue.ts') && /import\(['"][^'"]*demo-catalogue\.ts['"]\)|from ['"][^'"]*demo-catalogue\.ts['"]/.test(readFileSync(f, 'utf8')));
    expect(callers.map((f) => f.slice(root.length))).toEqual(['cli/installation.ts']);
  });
});
