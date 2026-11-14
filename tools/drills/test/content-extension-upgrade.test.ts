/**
 * ST-29, DI-37, DI-48 (kernel 1407, tablets 1914; injectables review pass I-6, item 2): a fresh installation and an
 * installation upgraded to this release end with the same definitions of the change record's content provider, the
 * extension merge and plant's APS-lines extension. On a fresh installation the kernel's migrations run before the
 * tablets ones, so tablets 1910 replaces kernel 1407's provider text and 1914 puts it back; on an upgrade 1910 ran long
 * before, 1407 replaces it and 1914 re-creates the same text. Either way the signed content must come from one body.
 *
 * The earlier release is every migration of this tree except kernel 1407 and tablets 1914, the only migrations this
 * change adds (main at d483b66 had exactly the rest, byte for byte: a merged migration is never edited, and the runner
 * refuses a changed checksum). It is built from the tree's files rather than from git, which a shallow CI checkout may
 * not hold.
 */
import { readdirSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate, type MigrationSource } from '@ebmr/kernel';
import { asAdmin, createGmpDatabase, dropDatabase, uniqueSuffix } from '@ebmr/test-kit';
import { tabletsMigrationSources } from '../src/sources.ts';

const NEW: Record<string, string> = { kernel: '1407_esig_content_extensions.sql', tablets: '1914_aps_lines_content_extension.sql' };
const FUNCTIONS = ['platform.change_record_content(text)', 'esig.extend_content(text,text,jsonb)', 'plant.change_record_aps_lines(text)'];

/** The tree's sources without this change's migrations. */
function earlierSources(sources: MigrationSource[]): MigrationSource[] {
  return sources.map((s) => {
    const left = NEW[s.namespace];
    if (left === undefined) return s;
    if (s.include !== undefined) throw new Error(`${s.namespace}: a source with its own filter`);
    return { ...s, include: new RegExp(`^(?!${left.replace(/\./g, '\\.')}$)`) };
  });
}

const fresh = `ebmr_cext_fresh_${uniqueSuffix()}`;
const upgraded = `ebmr_cext_upg_${uniqueSuffix()}`;
let upgradeApplied: string[] = [];

const definitions = (database: string): Promise<Record<string, string | null>> =>
  asAdmin(database, async (c) => {
    const out: Record<string, string | null> = {};
    for (const f of FUNCTIONS) {
      const { rows } = await c.query<{ md5: string | null }>('select md5(pg_get_functiondef(to_regprocedure($1))) as md5', [f]);
      out[f] = rows[0]?.md5 ?? null;
    }
    return out;
  });

beforeAll(async () => {
  const sources = tabletsMigrationSources();
  // The change adds exactly these two files, each present in its source.
  for (const [ns, file] of Object.entries(NEW)) {
    const s = sources.find((x) => x.namespace === ns);
    expect(s && readdirSync(s.directory).includes(file), `${ns}/${file}`).toBe(true);
  }
  await createGmpDatabase(fresh, sources);
  await createGmpDatabase(upgraded, earlierSources(sources));
  upgradeApplied = (await asAdmin(upgraded, (c) => migrate(c, sources))).map((a) => `${a.namespace}/${a.name}`);
}, 900_000);
afterAll(async () => {
  await dropDatabase(fresh);
  await dropDatabase(upgraded);
});

describe('the change record content provider after a fresh installation and after an upgrade (kernel 1407, tablets 1914)', () => {
  it('[ST-29][DI-37][DI-48] a fresh installation and an upgrade from the earlier release end with the same definitions of platform.change_record_content, esig.extend_content and plant.change_record_aps_lines', async () => {
    expect(upgradeApplied).toEqual([`kernel/${NEW['kernel']!}`, `tablets/${NEW['tablets']!}`]);
    const [a, b] = [await definitions(fresh), await definitions(upgraded)];
    for (const f of FUNCTIONS) expect(a[f], f).toMatch(/^[0-9a-f]{32}$/);
    expect(b).toEqual(a);
    // The provider is the kernel's function on both, with 1407's body: it merges the extensions and reads no plant table.
    for (const db of [fresh, upgraded]) {
      const r = await asAdmin(db, async (c) => (await c.query<{ f: string; src: string; ext: string[] }>(
        `select p.function_oid::text as f, s.prosrc as src,
                array(select x.extension_key from platform.content_extension x where x.aggregate_type = 'config_change_record') as ext
           from esig.content_provider p, pg_proc s
          where p.aggregate_type = 'config_change_record' and s.oid = 'platform.change_record_content(text)'::regprocedure`)).rows[0]!);
      expect({ db, f: r.f, ext: r.ext, merges: r.src.includes("esig.extend_content('config_change_record'"), readsPlant: /plant\.|aps_/.test(r.src) })
        .toEqual({ db, f: 'platform.change_record_content(text)', ext: ['aps_lines'], merges: true, readsPlant: false });
    }
  }, 300_000);
});
