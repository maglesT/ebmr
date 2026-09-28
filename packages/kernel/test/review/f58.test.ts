/**
 * Review reproducer F58: reserveCounterBlock (packages/kernel/src/continuity/numbers.ts:77) appends the
 * CEILING entry to the external ledger BEFORE it opens the transaction, runs kernel.begin_command and
 * calls continuity.reserve_counter_ceiling, which is where DI-18 and CONTINUITY.COUNTER_RESERVE (at the
 * actor's location) are checked. A refused reservation therefore leaves a ceiling in the ledger that the
 * database never acknowledged.
 *
 * Scenario (batch-number rule PX-TAB, block 5, SITE-1; the README says product-limited issuers cannot
 * reserve and rely on ceilings reserved by an unrestricted issuer):
 *   1. an unrestricted BATCH_ISSUER allocates PX0001 (ledger and database ceiling 5);
 *   2. a BATCH_ISSUER whose grant is limited to product PX allocates PX0002..PX0005 (block used up);
 *   3. the product-limited issuer tries 4 more allocations; each is refused (it cannot reserve);
 *   4. the unrestricted issuer allocates the next number.
 *
 * Safe behaviour asserted: a refused reservation writes nothing outside the database, so after step 3
 * the ledger ceiling still equals the database ceiling (5), step 4 returns serial 6 (PX0006), and no
 * LEDGER_AHEAD alarm or sequence bump is raised (that alarm is the signal of an unrecorded restore and
 * must not fire in routine operation). The refusal itself may be EBMR-IAM-040 (current behaviour) or
 * EBMR-CONT-011 (a fix that skips the reservation for actors without the permission).
 */
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FileLedger, ledgerMaxCeiling } from '../../src/continuity/ledger.ts';
import { withProtectedNumbers } from '../../src/continuity/numbers.ts';
import { withCommand, type ActorContext } from '../../src/db/command.ts';
import { seedActor } from '../identity/seed.ts';
import { createTestDatabase, type TestDatabase } from '../support/db.ts';
import { seededTestActor } from '../support/seeded-actor.ts';

const SITE = 'SITE-1'; // the seeded devices are at SITE-1
const ZONE = 'Asia/Kolkata';
const PRODUCT = 'PX';
const RULE = 'PX-TAB';
const KEY = `site.batch_number:${RULE}`;

let db: TestDatabase;
let dir: string;
let ledger: FileLedger;
let steward: ActorContext;
let issuer: ActorContext;
let limited: ActorContext;

const again = (ctx: ActorContext): ActorContext => ({ ...ctx, correlationId: randomUUID() });

async function allocateOn(c: pg.PoolClient): Promise<{ batch_number: string; serial: string }> {
  const { rows } = await c.query<{ batch_number: string; serial: string }>(
    'select batch_number, serial::text as serial from site.allocate_batch_number($1::jsonb)',
    [
      JSON.stringify({
        site_code: SITE,
        product_code: PRODUCT,
        product_name: 'Product PX',
        edition: 'TABLETS',
        batch_kind: 'PROCESSING',
        batch_size: '1000',
        batch_size_unit: '{tbl}',
      }),
    ],
  );
  const r = rows[0];
  if (!r) throw new Error('no row');
  return r;
}

const allocate = (ctx: ActorContext) => withProtectedNumbers(db.app, again(ctx), ledger, allocateOn);

beforeAll(async () => {
  db = await createTestDatabase();
  dir = mkdtempSync(join(tmpdir(), 'ebmr-f58-'));
  ledger = new FileLedger(join(dir, 'f58.ledger.jsonl'), { database: 'f58' });
  steward = await seededTestActor(db, { roleCode: 'MASTER_DATA_STEWARD' });
  issuer = await seededTestActor(db, { roleCode: 'BATCH_ISSUER' });
  const { seed: _seed, ...ctx } = await seedActor(db, { roleCode: 'BATCH_ISSUER', scope: { site: SITE, product: PRODUCT }, acknowledgeEsig: false });
  void _seed;
  limited = ctx;
  await withCommand(db.app, again(steward), (c) =>
    c.query('select site.define_batch_number_rule($1::jsonb)', [
      JSON.stringify({
        rule_code: RULE,
        site_code: SITE,
        product_code: PRODUCT,
        batch_kind: 'PROCESSING',
        format: 'PX{SEQ:4}',
        site_zone: ZONE,
        effective_from: null,
        reason: 'SOP-QA-017',
        block_size: 5,
      }),
    ]),
  );
});

afterAll(async () => {
  await db.drop();
  rmSync(dir, { recursive: true, force: true });
});

describe('F58 counter reservation writes to the ledger before authorisation', () => {
  it('[INV-27][IN-18][DI-17] a reservation refused by the database leaves no ceiling in the external ledger, burns no serials and raises no LEDGER_AHEAD alarm', async () => {
    // 1. unrestricted issuer: first number, ceiling 5 in the ledger and in the database.
    expect((await allocate(issuer)).batch_number).toBe('PX0001');
    expect(await ledgerMaxCeiling(ledger, KEY)).toBe(5n);

    // 2. product-limited issuer uses up the block (no reservation needed).
    const used: string[] = [];
    for (let i = 0; i < 4; i++) used.push((await allocate(limited)).batch_number);
    expect(used).toEqual(['PX0002', 'PX0003', 'PX0004', 'PX0005']);

    // 3. product-limited issuer: 4 more attempts, each refused because it cannot reserve a block.
    const refusals: string[] = [];
    for (let i = 0; i < 4; i++) {
      try {
        await allocate(limited);
        refusals.push('ALLOCATED');
      } catch (error) {
        refusals.push(String((error as Error).message));
      }
    }
    for (const r of refusals) expect(r).toMatch(/^(EBMR-IAM-040 .*CONTINUITY\.COUNTER_RESERVE|EBMR-CONT-011)/);

    const ledgerAfterRefusals = await ledgerMaxCeiling(ledger, KEY);
    const dbCounter = await db.app.query<{ reserved_ceiling: string; last_value: string }>(
      'select reserved_ceiling::text, last_value::text from continuity.counter where sequence_key = $1',
      [KEY],
    );

    // 4. the next authorised allocation.
    const next = await allocate(issuer);
    const alarms = await db.app.query<{ severity: string; details: Record<string, unknown> }>(
      "select severity, details from continuity.open_alarm where alarm_code = 'LEDGER_AHEAD' and details ->> 'sequence_key' = $1",
      [KEY],
    );
    const bumps = await db.app.query<{ value_before: string; value_after: string }>(
      "select value_before::text, value_after::text from continuity.sequence_bump where sequence_key = $1 and reason = 'LEDGER_AHEAD'",
      [KEY],
    );

    expect({
      databaseCounter: dbCounter.rows[0],
      ledgerCeilingAfterRefusals: ledgerAfterRefusals?.toString(),
      nextAuthorisedNumber: next.batch_number,
      ledgerAheadAlarms: alarms.rows,
      ledgerAheadBumps: bumps.rows,
    }).toEqual({
      databaseCounter: { reserved_ceiling: '5', last_value: '5' },
      ledgerCeilingAfterRefusals: '5',
      nextAuthorisedNumber: 'PX0006',
      ledgerAheadAlarms: [],
      ledgerAheadBumps: [],
    });
  });
});
