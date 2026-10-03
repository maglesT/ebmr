/**
 * Phase 2 exit follow-up F58.1, round 3 (DI-32, DI-34, PR-19): a command recorded as the refusal ENG-STALE uses no
 * scale reading, whatever the order of the writes and whichever transaction or session makes them, and the readings
 * such a row names without using them are exactly its stored tare and gross (tablets 0520; ADR 0012: the application
 * role is the attacker, with the same database rights as the server).
 *
 * Tablets 0500/0510 checked, when the stale row was inserted, only that its command had claimed nothing so far in its
 * transaction. The round-2 verification recorded the honest stale weighing and then claimed its two readings in the same
 * transaction under the row's correlation id: committed, the record said the stale command used them, the next accepted
 * weighing was refused EBMR-DEV-105, and nothing noticed. It also recorded a stale row naming a third reading, or a
 * named reading with a value other than the stored one. Tablets 0520:
 *  - checks at commit, on both sides (the stale row, each claim), that no scale reading is claimed under the correlation
 *    id of a row recorded as the refusal ENG-STALE: before or after the row, in its transaction or another, or in a
 *    transaction open at the same time (the two meet on one key of tab.reading_claim_mark; under REPEATABLE READ the
 *    later one fails to serialise), EBMR-EXE-124;
 *  - binds evidence.namedReadings to the refusal ENG-STALE of an entry captured from a device, and to exactly its tare
 *    and gross as stored, EBMR-EXE-124.
 * The earlier stale-row cases are in db-guards-stale-row.test.ts; this file has a server of its own because the kiosk's
 * device nonces are rate-limited per terminal and minute.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startRig, stopRig, type Rig } from '../devices/room-scales-support.ts';
import { claim, named, staleRowHelpers, weighing, type Json } from './db-guards-stale-support.ts';
import { actorOf, unmatched } from './db-guards-support.ts';
import { outcomeOf, rowsOf, violations } from './support.ts';

let rig: Rig;
beforeAll(async () => {
  rig = await startRig();
}, 180_000);
afterAll(async () => {
  await stopRig(rig);
});

const { readings, usesOf, weighingPast, claimAlone, markOf, openCommand, staleException, preparedRun } = staleRowHelpers(() => rig);

describe('F58.1, round 3: a stale refusal uses no scale reading, checked at commit, and names exactly its stored readings (DI-32, DI-34)', () => {
  it('[DI-32][DI-34][PR-19] round 3: a stale refusal uses no scale reading whatever the order of the writes: written past the server, the honest stale weighing whose readings are then claimed in its own transaction, under its correlation id, is refused at commit (EBMR-EXE-124), and so is that claim checked at once (SET CONSTRAINTS ALL IMMEDIATE), a claim under the correlation id of a committed stale row in a later transaction, and a stale row under the correlation id of claims committed earlier; nothing of the refused ones is kept, and the next accepted weighing uses the readings (F58.1)', async () => {
    const d = await preparedRun();
    const pair = await readings();
    const rowsBefore = await rowsOf(rig.server, d.runId);

    // The forgery of the round-2 verification: the honest stale weighing, then the readings it names claimed under its
    // correlation id and session, in the same transaction. The claims go through; the commit refuses the transaction.
    let claimedInTransaction = false;
    const claimedAfterRow = await weighingPast(d, pair, {
      after: async (c) => {
        await claim(c, pair);
        claimedInTransaction = true;
      },
    });
    expect(claimedAfterRow).toBe('EBMR-EXE-124');
    expect(claimedInTransaction).toBe(true);
    // Every deferred check made at the end of its statement instead: the claim, the later write, is refused at once.
    let claimedAtOnce = false;
    const checkedAtOnce = await weighingPast(d, pair, {
      before: (c) => c.query('set constraints all immediate'),
      after: async (c) => {
        await claim(c, pair);
        claimedAtOnce = true;
      },
    });
    expect(checkedAtOnce).toBe('EBMR-EXE-124');
    expect(claimedAtOnce).toBe(false);
    expect(await rowsOf(rig.server, d.runId)).toEqual(rowsBefore);
    expect(await usesOf([pair.tare, pair.gross])).toBe(0);

    // A committed stale row, then its readings claimed under its correlation id in a later transaction.
    const staleCorrelation = randomUUID();
    expect(await weighingPast(d, pair, { correlationId: staleCorrelation })).toBe('ok');
    expect(await markOf(staleCorrelation)).toEqual({ claimed: false, stale_refusal: true });
    expect(await claimAlone(d, pair, staleCorrelation)).toBe('EBMR-EXE-124');
    expect(await usesOf([pair.tare, pair.gross])).toBe(0);

    // Readings claimed and committed under a correlation id by a command that writes no row (the residual of decision
    // F58.2), then a stale weighing under that correlation id, naming other readings, in a later transaction.
    const other = await readings();
    const claimedCorrelation = randomUUID();
    expect(await claimAlone(d, other, claimedCorrelation)).toBe('ok');
    const fresh = await readings();
    const rowsMid = await rowsOf(rig.server, d.runId);
    expect(await weighingPast(d, fresh, { correlationId: claimedCorrelation })).toBe('EBMR-EXE-124');
    expect(await rowsOf(rig.server, d.runId)).toEqual(rowsMid);
    expect(await usesOf([fresh.tare, fresh.gross])).toBe(0);
    expect(await markOf(claimedCorrelation)).toEqual({ claimed: true, stale_refusal: false });

    // The readings the stale row names were never used: the weighing from the reloaded screen uses them.
    expect(outcomeOf(await d.command('operator1', weighing(pair.tare, pair.gross)))).toBe('ok');
    expect(await usesOf([pair.tare, pair.gross])).toBe(2);
    expect(await violations(rig.server)).toEqual([]);
  }, 300_000);

  it('[DI-32][DI-34][PR-19] round 3: a stale refusal and a claim of scale readings under its correlation id, written past the server in two transactions open at once from two sessions: whichever commits second is refused (EBMR-EXE-124 under READ COMMITTED, a serialization failure under REPEATABLE READ), so the record never holds both (F58.1)', async () => {
    const d = await preparedRun();
    const verifier = (correlationId: string) => actorOf(rig.server, d.browser('verifier1'), 'verifier1', { correlationId });
    const operator = (correlationId: string) => actorOf(rig.server, d.browser('operator1'), 'operator1', { correlationId });
    const pair = await readings();

    // verifier1's stale row commits first; operator1's claim made meanwhile under its correlation id is refused at its
    // commit.
    const z = randomUUID();
    const staleFirst = await openCommand(await verifier(z), 'read committed', (c) => staleException(c, d, 'verifier1'));
    const claimSecond = await openCommand(await operator(z), 'read committed', (c) => claim(c, pair));
    expect(await staleFirst.commit()).toBe('ok');
    expect(await claimSecond.commit()).toBe('EBMR-EXE-124');
    expect(await usesOf([pair.tare, pair.gross])).toBe(0);

    // The same with the claim under REPEATABLE READ: its snapshot was taken before the stale row committed, so it never
    // sees the row; its mark meets the row's on the correlation id, and the claim cannot be serialised.
    const z2 = randomUUID();
    const staleFirst2 = await openCommand(await verifier(z2), 'read committed', (c) => staleException(c, d, 'verifier1'));
    const claimSecond2 = await openCommand(await operator(z2), 'repeatable read', (c) => claim(c, pair));
    expect(await staleFirst2.commit()).toBe('ok');
    expect(await claimSecond2.commit()).toMatch(/could not serialize access/);
    expect(await usesOf([pair.tare, pair.gross])).toBe(0);
    expect([await markOf(z), await markOf(z2)]).toEqual([
      { claimed: false, stale_refusal: true },
      { claimed: false, stale_refusal: true },
    ]);

    // The claim commits first (a command that writes no row); the stale row written meanwhile under its correlation id
    // is refused at its commit.
    const w = randomUUID();
    const rowsBefore = await rowsOf(rig.server, d.runId);
    const staleSecond = await openCommand(await verifier(w), 'read committed', (c) => staleException(c, d, 'verifier1'));
    const claimFirst = await openCommand(await operator(w), 'read committed', (c) => claim(c, pair));
    expect(await claimFirst.commit()).toBe('ok');
    expect(await staleSecond.commit()).toBe('EBMR-EXE-124');
    expect(await rowsOf(rig.server, d.runId)).toEqual(rowsBefore);
    expect(await markOf(w)).toEqual({ claimed: true, stale_refusal: false });
    expect(await violations(rig.server)).toEqual([]);
  }, 300_000);

  it('[DI-32][DI-34][PR-19] round 3: written past the server, the readings a row names without using them (evidence.namedReadings) are exactly the tare and then the gross of a stale weighing captured from a device, as stored: a third named reading, a named value, raw line or capture time other than the stored one, the gross named first, and readings named by an accepted weighing are refused (EBMR-EXE-124); the honest stale weighing names the stored readings (F58.1)', async () => {
    const d = await preparedRun();
    const pair = await readings();
    const used = await readings();
    expect(outcomeOf(await d.command('operator1', weighing(used.tare, used.gross)))).toBe('ok');
    const rowsBefore = await rowsOf(rig.server, d.runId);
    const at = (ev: Json, purpose: string): Json => named(ev).find((r) => r['purpose'] === purpose) ?? {};

    const outcomes = {
      // The round-2 verification's: a third entry naming a reading already used.
      thirdNamed: await weighingPast(d, pair, { edit: (_, ev) => (ev['namedReadings'] = [...named(ev), { ...at(ev, 'GROSS'), purpose: 'CHECK', readingId: used.gross }]) }),
      tareValueNotStored: await weighingPast(d, pair, { edit: (_, ev) => (at(ev, 'TARE')['value'] = '1.2500') }),
      grossRawNotStored: await weighingPast(d, pair, { edit: (_, ev) => (at(ev, 'GROSS')['raw'] = 'forged raw line') }),
      captureTimeNotStored: await weighingPast(d, pair, { edit: (_, ev) => (at(ev, 'TARE')['sourceTimeUs'] = (BigInt(String(at(ev, 'TARE')['sourceTimeUs'])) + 1n).toString()) }),
      grossFirst: await weighingPast(d, pair, { edit: (_, ev) => (ev['namedReadings'] = [...named(ev)].reverse()) }),
      namedByAccepted: await weighingPast(d, pair, { seen: (v) => v, useReadings: true, edit: (_, ev) => (ev['namedReadings'] = ev['readings']) }),
    };
    expect(unmatched(outcomes, {
      thirdNamed: 'EBMR-EXE-124',
      tareValueNotStored: 'EBMR-EXE-124',
      grossRawNotStored: 'EBMR-EXE-124',
      captureTimeNotStored: 'EBMR-EXE-124',
      grossFirst: 'EBMR-EXE-124',
      namedByAccepted: 'EBMR-EXE-124',
    })).toEqual({});
    expect(await rowsOf(rig.server, d.runId)).toEqual(rowsBefore);
    expect(await usesOf([pair.tare, pair.gross])).toBe(0);

    // The honest stale weighing is recorded, naming the stored readings exactly as a claim gives them.
    expect(await weighingPast(d, pair)).toBe('ok');
    const { rows: stored } = await rig.server.db.admin.query<{ list: Json[] }>(
      `select jsonb_agg(jsonb_build_object('purpose', x.purpose, 'readingId', r.id, 'deviceCode', r.device_code, 'value', r.value, 'unit', r.unit, 'raw', r.raw,
                                           'sourceTimeUs', r.source_time_us::text, 'trust', r.trust) order by x.n) as list
         from unnest($1::uuid[], array['TARE', 'GROSS']) with ordinality as x(id, purpose, n) join tab.device_reading r on r.id = x.id`,
      [[pair.tare, pair.gross]],
    );
    const { rows: last } = await rig.server.db.admin.query<{ named: Json[] }>(
      "select evidence -> 'namedReadings' as named from recipe.execution_command where batch_id = $1 order by seq desc limit 1",
      [d.runId],
    );
    expect(stored[0]?.list).toHaveLength(2);
    expect(last[0]?.named).toEqual(stored[0]?.list);
    expect(await usesOf([pair.tare, pair.gross])).toBe(0);
    expect(await violations(rig.server)).toEqual([]);
  }, 300_000);
});
