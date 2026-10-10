/**
 * Phase 3 slice 4a review (recipe-core 0580): what the database builds for a G-21 entry, read through
 * recipe.g21_entry_data directly on cases the engine's own runs do not reach: every market of the batch names the artwork
 * the issued lot carries (review HIGH 2), and a gateway device's challenge is timed by the device's result, not by when it
 * was recorded (review HIGH 1). The server tests drive the same rules through the application role.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../../kernel/test/support/db.ts';

let db: TestDatabase;
beforeAll(async () => {
  db = await createTestDatabase();
}, 120_000);
afterAll(async () => {
  await db.drop();
});

type Json = Record<string, unknown>;
const MIN = 60_000_000n;
const T = 1_790_582_400_000_000n;

async function build(cfg: Json, c: Json, kind: string, prior: Json[], markets: string[], nowUs: bigint): Promise<Json> {
  const { rows } = await db.admin.query<{ r: Json }>("select recipe.g21_entry_data($1::jsonb, $2::jsonb, $3, $4::jsonb, $5::jsonb, $6::numeric, '\"P1\"'::jsonb) as r", [
    JSON.stringify(cfg), JSON.stringify(c), kind, JSON.stringify(prior), JSON.stringify(markets), nowUs.toString(),
  ]);
  return rows[0]?.r ?? {};
}

describe('G-21 entry data in the database (recipe-core 0580)', () => {
  it('[PR-32][PR-33] an issue is refused unless every market of the batch names the artwork the lot carries', async () => {
    const item = { id: 'CARTON', material: 'M', unit: '1', issue: { need: '10', allowancePercent: '0' }, counting: 'ROLL_COUNTER', limits: { maxUnexplained: '0' } };
    const c = { item: 'CARTON', lot: { id: 'L', material: 'M', status: 'RELEASED', artwork: 'ART-7' }, scannedArtwork: 'ART-7', quantity: { value: '10', unit: '1' } };
    const problem = async (artwork: Json) => (await build({ items: [{ ...item, artwork }] }, c, 'ISSUE', [], ['IN', 'US'], T))['problem'] ?? null;
    expect(await problem({ IN: 'ART-7' })).toMatch(/none for US.*G21-ARTWORK/);
    expect(await problem({ IN: 'ART-7', US: 'ART-9' })).toMatch(/ART-9 for US.*G21-ARTWORK/);
    expect(await problem({ IN: 'ART-7', US: 'ART-7' })).toBeNull();
  });

  it('[IN-22][PR-37] a gateway device\'s challenge is missed by the device\'s times: a result taken 31 minutes after the last passing one is missed though both were recorded within a minute, one taken 29 minutes after is not', async () => {
    const cfg = { devices: [{ id: 'CAM', kind: 'VISION', serial: 'PRN-1', every: { value: '30', unit: 'min' } }], unit: 'U' };
    const prior = [{ id: 'EN-1', kind: 'CHALLENGE', stepKey: 'p@', recordedAt: (T + 40n * MIN).toString(), data: { device: 'CAM', trigger: 'START', result: 'PASS', event: 'e', at: T.toString(), missed: false } }];
    const ch = (at: bigint) => ({ device: 'CAM', trigger: 'INTERVAL', result: 'PASS', event: '00000000-0000-4000-8000-000000000001', at: at.toString() });
    expect(((await build(cfg, ch(T + 31n * MIN), 'CHALLENGE', prior, ['IN'], T + 41n * MIN))['data'] as Json)['missed']).toBe(true);
    expect(((await build(cfg, ch(T + 29n * MIN), 'CHALLENGE', prior, ['IN'], T + 41n * MIN))['data'] as Json)['missed']).toBe(false);
    expect((await build(cfg, ch(T + 50n * MIN), 'CHALLENGE', prior, ['IN'], T + 41n * MIN))['problem']).toMatch(/G21-EVENT/);
  });
});
