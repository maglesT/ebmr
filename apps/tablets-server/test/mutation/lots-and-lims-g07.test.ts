/**
 * The GMP consumption of a G-07 weighing and the material of a lot an entry names, in the database alone (SQL mutation
 * group "lots-and-lims", tablets 0801, 1093, 1100; Phase 4 slice 7c, the "not twins" of the Phase 3 exit run).
 *
 *   * tab.g07_consumption_problem / tab.g07_consumption_pairs: each new CONTAINER_WEIGHING entry of a lot at a G-07 step
 *     pairs, in recorded order, with the first consumption of this transaction of that lot (of the batch's site) into
 *     this batch of exactly its net in the lot's unit, used by no earlier entry and named by no TB-01 entry of the row;
 *     an unpaired one is refused; entries already in the row, at another step, or naming no lot are left alone.
 *   * tab.g07_consumption_check: the row trigger refuses the update with EBMR-TAB-391 and records each pair through
 *     recipe.claim_consumption.
 *   * tab.entry_lot_material_problem: a weighing or charge entry names a lot of a material the batch's MBR names (in its
 *     bill of materials, directly or through a material reference); other entries are not its concern.
 *
 * Fixtures (planned batch, lots, reservations, consumptions with their transaction, the batch's MBR content) are written
 * by the superuser with session_replication_role = replica in a transaction that is always rolled back.
 *
 * Controls: INV-13, INV-14 (each consumption is the record's own entry), PR-57, PR-19 (the lot is of a BOM material).
 */
import type { PoolClient } from 'pg';
import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startServer, type TestServer } from '../support/harness.ts';
import { attempt, inCommand, replica, tag, value, type Json } from './kill-support.ts';

let gmp: TestServer;
beforeAll(async () => {
  gmp = await startServer('GMP');
}, 180_000);
afterAll(async () => {
  await gmp?.close();
});

const CONTENT = {
  procedure: {
    kind: 'procedure',
    id: 'proc',
    children: [
      { kind: 'phase', id: 'p-g07', block: { type: 'G-07', version: '1' } },
      { kind: 'phase', id: 'p-tb01', block: { type: 'TB-01', version: '1' } },
    ],
  },
  bom: [{ material: 'MAT-A' }, { material: 'REF-B' }],
  references: [{ id: 'REF-B', code: 'MAT-B' }, { id: 'REF-Z', code: 'MAT-Z' }],
};

/** A planned and issued batch on `site` running `content`; its id. */
async function batch(c: PoolClient, site: string, content: Json): Promise<string> {
  const id = randomUUID();
  const hash = createHash('sha256').update(id).digest('hex');
  const fam = (await c.query<{ id: string }>('select id::text from recipe.mbr_family limit 1')).rows[0]?.id ?? randomUUID();
  await c.query(
    `insert into recipe.test_package (package_hash, file_name, package, content, content_hash, family_id, family_code, product, version_id, version_number,
                                      revision, version_state, exporter, exported_at_us, source, imported_by_person, imported_by_account, correlation_id)
     values ($1, $1 || '.json', '{}', $2, $1, gen_random_uuid(), 'FAM', '{"code": "P1", "strength": "1 mg"}', gen_random_uuid(), '1', 1, 'APPROVED', '{}', 0, '{}',
             gen_random_uuid(), gen_random_uuid(), gen_random_uuid())`,
    [hash, JSON.stringify(content)],
  );
  await c.query(
    `insert into recipe.batch_execution (id, batch_number, package_hash, content_hash, installation, purpose, engine_version, registry_fingerprint, policy,
                                         policy_hash, issue_request, market_set, batch_size, site_code, site_zone, issued_at_us, issued_by_person,
                                         issued_by_account, correlation_id)
     values ($1, $2, $3, $3, 'SANDBOX', 'SANDBOX_TEST_RUN', '1', $3, '{}', $3, '{}', '{IN}', 'BS', $4, 'Asia/Kolkata', 0, gen_random_uuid(), gen_random_uuid(), gen_random_uuid())`,
    [id, `B-${id.slice(0, 8).toUpperCase()}`, hash, site],
  );
  await c.query(
    `insert into recipe.stub_batch (id, batch_number, family_id, markets, site, line, batch_size, status, created_by_person, created_by_account)
     values ($1, $2, $3, '{IN}', $4, 'L1', 'BS', 'ISSUED', gen_random_uuid(), gen_random_uuid())`,
    [id, `B-${id.slice(0, 8).toUpperCase()}`, fam, site],
  );
  return id;
}

async function lot(c: PoolClient, site: string, code: string, unit = 'g'): Promise<string> {
  const id = randomUUID();
  await c.query(
    `insert into site.material_lot (id, site_code, lot_code, material_code, material_name, material_kind, received_quantity, unit, expires_at, received_by_person,
                                    received_by_account, correlation_id)
     values ($1, $2, $3, 'MAT-A', 'Material A', 'EXCIPIENT', 100000, $4, clock_timestamp() + interval '1 year', gen_random_uuid(), gen_random_uuid(), gen_random_uuid())`,
    [id, site, code, unit],
  );
  return id;
}

/** A consumption of `quantity` (in the lot's unit) of lot into batch, in this transaction or in transaction `xact`. */
async function consumption(c: PoolClient, lotId: string, batchId: string, quantity: string, unit = 'g', xact: number | null = null): Promise<string> {
  const id = randomUUID();
  await c.query(
    `insert into site.lot_consumption (id, lot_id, reservation_id, batch_id, batch_number, edition, material_code, quantity, unit, quantity_before, quantity_after,
                                       market_set, identity_basis, consumed_by_person, consumed_by_account, xact_id)
     values ($1, $2, gen_random_uuid(), $3, 'B', 'TABLETS', 'MAT-A', $4::numeric, $5, 100000, 100000 - $4::numeric, '{IN}', 'IDENTITY_RESULT', gen_random_uuid(),
             gen_random_uuid(), coalesce($6::bigint, txid_current()))`,
    [id, lotId, batchId, quantity, unit, xact],
  );
  return id;
}

const weighing = (seq: number, lotCode: unknown, net: string, unit = 'kg', step = 'p-g07@1'): Json => ({
  kind: 'CONTAINER_WEIGHING',
  stepKey: step,
  recordedSeq: String(seq),
  data: { lot: { id: lotCode }, net, unit },
});
const tb01 = (seq: number, consumptionId: string): Json => ({ kind: 'DISPENSED', stepKey: 'p-tb01@1', recordedSeq: String(seq), data: { consumption: consumptionId } });

describe('the G-07 consumption pairing (tablets 1093, 1100)', () => {
  it('[INV-13][INV-14][PR-57] each new G-07 weighing pairs in recorded order with the first unused consumption of this transaction, this batch, this lot of the batch\'s site and exactly its net, never one a TB-01 entry names; an unpaired one is refused; old entries, other steps and entries naming no lot are left alone', async () => {
    await inCommand(gmp, 'operator1', async (c) => {
      const t = tag();
      const site = gmp.seed.siteCode;
      const ids: Record<string, string> = {};
      let B = '';
      let B2 = '';
      await replica(c, async () => {
        B = await batch(c, site, CONTENT);
        B2 = await batch(c, 'SITE-9', CONTENT);
        ids['L1'] = await lot(c, site, `L1-${t}`);
        ids['L2'] = await lot(c, site, `L2-${t}`);
        // The same lot code at another site (the batch's site decides which lot an entry names).
        ids['L1x'] = await lot(c, 'SITE-9', `L1-${t}`);
        // Decoys first (consumed earlier): another batch, another lot, another site's lot, another transaction, another
        // quantity; then the consumption a TB-01 entry names; then the ones the G-07 entries may pair with.
        ids['otherBatch'] = await consumption(c, ids['L1'], B2, '1500');
        ids['otherLot'] = await consumption(c, ids['L2'], B, '1500');
        ids['otherSite'] = await consumption(c, ids['L1x'], B, '1500');
        ids['otherXact'] = await consumption(c, ids['L1'], B, '1500', 'g', 1);
        ids['otherQty'] = await consumption(c, ids['L1'], B, '1499');
        ids['named'] = await consumption(c, ids['L1'], B, '1500');
        ids['first'] = await consumption(c, ids['L1'], B, '1500');
        ids['second'] = await consumption(c, ids['L1'], B, '2000');
      });
      const problem = (old: Json, now: Json, b = B) =>
        value<string | null>(c, 'select tab.g07_consumption_problem($1, $2, $3, $4) as r', [b, JSON.stringify(CONTENT), JSON.stringify(old), JSON.stringify(now)]);
      const pairs = async (old: Json, now: Json, b = B) =>
        (await c.query<{ k: string; id: string | null }>('select entry_key as k, consumption_id::text as id from tab.g07_consumption_pairs($1, $2, $3, $4) order by entry_key', [
          b, JSON.stringify(CONTENT), JSON.stringify(old), JSON.stringify(now),
        ])).rows.map((r) => [r.k, r.id]);

      const L1 = `L1-${t}`;
      const old = { entries: { e0: weighing(1, L1, '9.9') } };
      // e2 (seq 2) then e1 (seq 3): recorded order, not key order; e2 takes the first 1.5 kg not named by the TB-01 entry.
      const now = { entries: { ...old.entries, t1: tb01(4, ids['named'] ?? ''), e2: weighing(2, L1, '1.5'), e1: weighing(3, L1, '2000', 'g') } };
      expect(await problem(old, now)).toBeNull();
      expect(await pairs(old, now)).toEqual([['e1', ids['second']], ['e2', ids['first']]]);
      // Without the TB-01 entry the named one is the first of the quantity.
      const unnamed = { entries: { ...old.entries, e2: weighing(2, L1, '1.5') } };
      expect(await pairs(old, unnamed)).toEqual([['e2', ids['named']]]);
      // A third 1.5 kg entry: the two consumptions are used by the first two, so it is refused (pairs: none).
      const three = { entries: { ...old.entries, t1: tb01(9, ids['named'] ?? ''), e2: weighing(2, L1, '1.5'), e3: weighing(3, L1, '1.5') } };
      expect(await problem(old, three)).toMatch(/^entry e3 \(CONTAINER_WEIGHING\) of G-07 step p-g07@1 dispenses 1\.5 kg of lot L1-.* consumed no such quantity of that lot into the batch: .*\(G07-CONSUMPTION; INV-13, INV-14, PR-57\)$/);
      expect(await pairs(old, three)).toEqual([['e2', ids['first']], ['e3', null]]);
      // Only decoys: another quantity, lot, batch, transaction or site does not pair.
      for (const [label, entry] of [
        ['quantity', weighing(2, L1, '1.4')],
        ['lot', weighing(2, `L2-${t}`, '3')],
        ['unit', weighing(2, L1, '1.5', 'g')],
      ] as const) {
        expect(await problem({}, { entries: { t1: tb01(1, ids['named'] ?? ''), x: entry } }), label).toMatch(/^entry x \(CONTAINER_WEIGHING\)/);
      }
      // The other batch's consumption (1.5 kg of L1) is never this batch's; the other site's lot with the same code neither.
      const both = { entries: { t1: tb01(1, ids['named'] ?? ''), a: weighing(2, L1, '1.5'), b: weighing(3, L1, '1.5') } };
      expect(await problem({}, both)).toMatch(/^entry b /);
      expect(await pairs({}, both)).toEqual([['a', ids['first']], ['b', null]]);
      // Entries left alone: already in the row, at another step, naming no lot, of another kind; a row without entries.
      const alone = {
        entries: {
          ...old.entries,
          s: weighing(2, L1, '7', 'kg', 'p-tb01@1'),
          n: { kind: 'CONTAINER_WEIGHING', stepKey: 'p-g07@1', recordedSeq: '3', data: { lot: { id: 7 }, net: '7', unit: 'kg' } },
          o: { ...weighing(4, L1, '7'), kind: 'GROSS_WEIGHING' },
        },
      };
      expect(await problem(old, alone)).toBeNull();
      expect(await pairs(old, alone)).toEqual([]);
      expect(await problem({ entries: [] }, { entries: [weighing(1, L1, '7')] })).toBeNull();
      // An old row with no entries object: every entry of the new row is new.
      expect(await problem({ entries: 'x' }, { entries: { z: weighing(1, L1, '7') } })).toMatch(/^entry z /);
      expect(await problem({ entries: { z: weighing(1, L1, '7') } }, { entries: { z: weighing(1, L1, '7') } })).toBeNull();
      // A weighing whose data is no object names no lot.
      expect(await problem({}, { entries: { d: { ...weighing(1, L1, '7'), data: [] } } })).toBeNull();
    });
  });

  it('[INV-13][INV-14] the row trigger refuses an unpaired G-07 weighing (EBMR-TAB-391) and records each pair as the entry\'s claim of its consumption', async () => {
    await inCommand(gmp, 'operator1', async (c) => {
      const t = tag();
      const site = gmp.seed.siteCode;
      let B = '';
      let B2 = '';
      let B3 = '';
      const ids: Record<string, string> = {};
      const row = (batchId: string, seq: number, type: string) =>
        c.query(
          `insert into recipe.execution_command (batch_id, seq, kind, command_id, command_type, command, command_hash, actor_person, actor_account, actor_role, source,
                                                 session_id, device_class, now_us, accepted, state_version, state_hash, events_hash, event_count, prev_row_hash, row_hash,
                                                 correlation_id)
           values ($1, $2::bigint, case when $2::bigint = 1 then 'ISSUE' else 'COMMAND' end, gen_random_uuid(), $3, '{}', repeat('0', 64), gen_random_uuid(), gen_random_uuid(), 'OPERATOR',
                   'UI', gen_random_uuid(), 'TERMINAL', 0, true, 1, repeat('0', 64), repeat('0', 64), 0, repeat('0', 64), repeat('0', 64), gen_random_uuid())`,
          [batchId, seq, type],
        );
      const stateRow = (batchId: string, state: Json) =>
        c.query(
          "insert into recipe.execution_state (batch_id, state, state_version, state_hash, last_seq, last_row_hash, status) values ($1, $2, 1, repeat('0', 64), 1, 'x', 'IN_PROGRESS')",
          [batchId, JSON.stringify(state)],
        );
      await replica(c, async () => {
        B = await batch(c, site, CONTENT);
        B2 = await batch(c, site, CONTENT);
        B3 = await batch(c, site, CONTENT);
        ids['L1'] = await lot(c, site, `L1-${t}`);
        ids['c1'] = await consumption(c, ids['L1'], B, '1500');
        ids['c2'] = await consumption(c, ids['L1'], B, '2500');
        await stateRow(B, { entries: { e0: weighing(1, `L1-${t}`, '9.9') } });
        // B2's old state holds no weighing, B3's no entries member at all.
        await stateRow(B2, { entries: {} });
        await stateRow(B3, {});
        // The row the update names (seq 2 of B), other rows of B, and another batch's row at the same seq.
        await row(B, 1, 'ISSUE');
        await row(B, 2, 'RECORD_ENTRY');
        await row(B, 3, 'SIGN');
        await row(B2, 2, 'CORRECT_ENTRY');
      });
      // Only the trigger under test runs on the row (the others guard the engine's own writes).
      await c.query('alter table recipe.execution_state disable trigger user');
      await c.query('alter table recipe.execution_state enable trigger ac_tab_g07_consumption');
      const update = (entries: Json, b = B) =>
        attempt(c, "update recipe.execution_state set state = jsonb_set(state, '{entries}', coalesce(state -> 'entries', '{}') || $2::jsonb), last_seq = 2 where batch_id = $1", [b, JSON.stringify(entries)]);
      const refused = await update({ e1: weighing(2, `L1-${t}`, '1.5'), e2: weighing(3, `L1-${t}`, '1.6') });
      expect(refused.ok ? 'ok' : refused.message).toMatch(/^This RECORD_ENTRY row is refused: entry e2 \(CONTAINER_WEIGHING\) .*\. \[EBMR-TAB-391\]$/);
      for (const b of [B2, B3]) {
        const o = await update({ n1: weighing(2, `L1-${t}`, '7') }, b);
        expect(o.ok ? 'ok' : o.message, b).toMatch(/^This .* row is refused: entry n1 \(CONTAINER_WEIGHING\) .*\[EBMR-TAB-391\]$/);
      }
      // Old entries only (none new) or a new entry of another kind: nothing to pair, nothing claimed.
      expect((await update({ e0: weighing(1, `L1-${t}`, '9.9'), x: { kind: 'NOTE', stepKey: 'p-g07@1', recordedSeq: '2', data: {} } })).ok).toBe(true);
      expect((await c.query('select 1 from recipe.consumption_entry where batch_id = $1', [B])).rowCount).toBe(0);
      expect((await update({ e1: weighing(3, `L1-${t}`, '1.5'), e2: weighing(4, `L1-${t}`, '2.5'), s: weighing(5, `L1-${t}`, '4', 'kg', 'p-tb01@1') })).ok).toBe(true);
      const claims = (await c.query<{ k: string; id: string }>('select entry_key as k, consumption_id::text as id from recipe.consumption_entry where batch_id = $1 order by entry_key', [B])).rows;
      expect(claims.map((r) => [r.k, r.id])).toEqual([['e1', ids['c1']], ['e2', ids['c2']]]);
    });
  });
});

describe('the material of the lot an entry names (tablets 0801)', () => {
  it('[PR-19][INV-25] a weighing or charge names a lot of a material the MBR names, in its bill of materials or through a reference; other entries are not checked', async () => {
    await inCommand(gmp, 'operator1', async (c) => {
      let B = '';
      let B2 = '';
      let B3 = '';
      await replica(c, async () => {
        B = await batch(c, gmp.seed.siteCode, CONTENT);
        B2 = await batch(c, gmp.seed.siteCode, { ...CONTENT, bom: { material: 'MAT-A' }, references: {} });
        B3 = await batch(c, gmp.seed.siteCode, { ...CONTENT, bom: [{ material: 'MAT-Q' }], references: [] });
      });
      const problem = (entry: unknown, b = B) => value<string | null>(c, 'select tab.entry_lot_material_problem($1, $2) as r', [b, JSON.stringify(entry)]);
      const e = (kind: string, material: unknown, id: unknown = 'LOT-1'): Json => ({ kind, lot: { id, material } });
      const named = /^lot LOT-1 is of material .*, which the MBR of this batch does not name \(its bill of materials names MAT-A, REF-B\)$/;
      expect(await problem(e('CONTAINER_WEIGHING', 'MAT-A'))).toBeNull();
      expect(await problem(e('CHARGE_LOT', 'MAT-A'))).toBeNull();
      expect(await problem(e('CONTAINER_WEIGHING', 'MAT-B'))).toBeNull();
      expect(await problem(e('CHARGE_LOT', 'MAT-B'))).toBeNull();
      expect(await problem(e('CONTAINER_WEIGHING', 'MAT-C'))).toMatch(named);
      expect(await problem(e('CHARGE_LOT', 'MAT-C'))).toMatch(named);
      // A reference whose code is the material but whose id is no BOM line; a BOM line's id with another code.
      expect(await problem(e('CHARGE_LOT', 'MAT-Z'))).toMatch(named);
      expect(await problem(e('CHARGE_LOT', 'REF-Z'))).toMatch(named);
      expect(await problem(e('CHARGE_LOT', 7))).toBe('lot LOT-1 is of material none, which the MBR of this batch does not name (its bill of materials names MAT-A, REF-B)');
      expect(await problem(e('CHARGE_LOT', 'MAT-C', null))).toBe('lot without an id is of material MAT-C, which the MBR of this batch does not name (its bill of materials names MAT-A, REF-B)');
      // Not this check's: another kind, a lot that is no object, an entry that is no object.
      expect(await problem(e('NOTE', 'MAT-C'))).toBeNull();
      expect(await problem({ kind: 'CHARGE_LOT', lot: 'LOT-1' })).toBeNull();
      expect(await problem([e('CHARGE_LOT', 'MAT-C')])).toBeNull();
      // The batch's own MBR decides: no BOM array (nothing named), another BOM.
      expect(await problem(e('CHARGE_LOT', 'MAT-A'), B2)).toBe('lot LOT-1 is of material MAT-A, which the MBR of this batch does not name (its bill of materials names no material)');
      expect(await problem(e('CHARGE_LOT', 'MAT-B'), B3)).toMatch(/names MAT-Q\)$/);
      expect(await problem(e('CHARGE_LOT', 'MAT-Q'), B3)).toBeNull();
    });
  });
});
