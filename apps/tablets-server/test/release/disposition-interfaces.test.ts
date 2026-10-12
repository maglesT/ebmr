/**
 * Slice 4-0 interfaces (recipe-core 0820): the market set, the disposition state, the market-add evaluation shape and the
 * importer registry answer for any lot; the suspension is owner-only; the application role writes no importer. As the
 * application role.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { codeOf } from '../execution/db-guards-support.ts';
import { startServer, type TestServer } from '../support/harness.ts';

let gmp: TestServer;

beforeAll(async () => {
  gmp = await startServer('GMP');
}, 300_000);

afterAll(async () => {
  await gmp.close();
});

describe('market disposition interfaces (slice 4-0)', () => {
  it('[meta] an unknown lot has no market set, no export disposition and no importer; IN reads the manufacturer release', async () => {
    const lot = randomUUID();
    const { rows } = await gmp.db.app.query<{ s: string[] | null; us: string | null; eu: string | null; inn: string; imp: unknown }>(
      "select recipe.market_set('LOT', $1) as s, recipe.disposition_state($1, 'US') as us, recipe.disposition_state($1, 'EU') as eu, recipe.disposition_state($1, 'IN') as inn, recipe.eu_importer_of($1) as imp",
      [lot],
    );
    expect(rows[0]).toEqual({ s: null, us: null, eu: null, inn: 'NOT_READY', imp: null });
  });

  it('[meta] the market-add evaluation answers its fixed shape; the suspension and the importer registry are not the application role\'s', async () => {
    const { rows } = await gmp.db.app.query<{ e: { subject_kind: string; market: string; outcome: string; items: { id: string; outcome: string; evidence: unknown[] }[] } }>(
      "select recipe.market_add_evaluate('LOT', $1, 'US') as e",
      [randomUUID()],
    );
    expect(rows[0]!.e).toMatchObject({ subject_kind: 'LOT', market: 'US' });
    expect(['MET', 'UNMET_RECOVERABLE', 'UNMET_FINAL']).toContain(rows[0]!.e.outcome);
    for (const i of rows[0]!.e.items) {
      expect(i.id).toMatch(/^MA\.[A-Z0-9_]+$/);
      expect(['MET', 'UNMET_RECOVERABLE', 'UNMET_FINAL']).toContain(i.outcome);
      expect(Array.isArray(i.evidence)).toBe(true);
    }
    expect(await codeOf(gmp.db.app.query("select recipe.suspend_release($1, '{}'::jsonb)", [randomUUID()]))).toMatch(/permission denied/);
    expect(await codeOf(gmp.db.app.query("insert into recipe.eu_importer (code, name, technical_agreement_ref, mia_number, public_key, signature_id, person_id, account_id) values ('X1', 'x', 'x', 'x', '\\x00', gen_random_uuid(), gen_random_uuid(), gen_random_uuid())"))).toMatch(/permission denied/);
    expect(await codeOf(gmp.db.app.query("insert into recipe.eu_importer_product (product_code, importer_id) values ('P1', gen_random_uuid())"))).toMatch(/permission denied/);
  });
});
