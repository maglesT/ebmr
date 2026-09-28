/**
 * Review reproducer F35: an implicit DI-investigation blocker (the person investigated writes to a
 * record inside the window after the investigation was opened) appears without moving the record's
 * blocker epoch.
 *
 *   - records.open_blockers (0440) blocks a record for disposition when an OPEN investigation is linked
 *     to it, or when the investigated person has INSERT/UPDATE/DELETE audit events on the record's
 *     chain inside the window (the implicit branch).
 *   - The blocker-epoch contract (0400, "Blocker epoch (outline 5.7)"; retention-store.ts
 *     lockBlockerEpoch): the release module evaluates open_blockers outside the signing transaction,
 *     then inside it locks the epoch with records.lock_blocker_epoch and refuses if the epoch moved.
 *   - The person's write goes through the ordinary audit trigger and never calls
 *     records.bump_blocker_epoch; the record is linked (and the epoch bumped) only on the next
 *     refresh_di_investigation_scope or at closure.
 *
 * Safe behaviour asserted: when a new disposition blocker appears on a record between the evaluation
 * of open_blockers and the signing transaction, the epoch the signing transaction locks differs from
 * the one seen at evaluation, so the release module's "epoch unchanged" check refuses.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withCommand, type ActorContext } from '../../src/db/command.ts';
import { openDiInvestigation } from '../../src/records/investigations.ts';
import { lockBlockerEpoch, openBlockers } from '../../src/records/retention-store.ts';
import { createTestDatabase, type TestDatabase } from '../support/db.ts';
import { again, createStubTables, insertEntry, testActor } from '../records/helpers.ts';

let db: TestDatabase;
let subject: ActorContext;
let colleague: ActorContext;
let investigator: ActorContext;
let releaser: ActorContext;

const now = async (): Promise<Date> => (await db.app.query<{ t: Date }>('select clock_timestamp() as t')).rows[0]?.t as Date;
const plusHours = (d: Date, h: number) => new Date(d.getTime() + h * 3_600_000);

beforeAll(async () => {
  db = await createTestDatabase();
  await createStubTables(db);
  subject = await testActor(db, { roleCode: 'OPERATOR', legalName: 'Operator under investigation' });
  colleague = await testActor(db, { roleCode: 'OPERATOR', legalName: 'Colleague' });
  investigator = await testActor(db, { roleCode: 'CSV_DI_LEAD', legalName: 'DI investigator' });
  releaser = await testActor(db, { roleCode: 'QA_REVIEWER', legalName: 'QA releaser' });
});

afterAll(async () => {
  await db.drop();
});

describe('F35: an implicit DI-investigation blocker moves the blocker epoch', () => {
  it('[DI-50][DI-12] a write by the person investigated inside the window, after opening, moves the epoch of the record it blocks', async () => {
    const batch = randomUUID();
    // The batch is being made by a colleague; the person investigated has not touched it yet.
    await insertEntry(db, colleague, batch, '4.20');

    const from = await now();
    const id = await withCommand(db.app, again(investigator), (c) =>
      openDiInvestigation(c, { subjectPersonId: subject.personId, windowFrom: from, windowTo: plusHours(from, 1), concern: 'suspected back-dating' }),
    );
    expect(id).toMatch(/^[0-9a-f-]{36}$/);

    // Release module, evaluation outside the signing transaction: nothing blocks the batch; epoch E0.
    const evaluated = await openBlockers(db.app, 'batch', batch);
    expect(evaluated.filter((b) => b.blocksDisposition)).toEqual([]);
    const epochAtEvaluation = await withCommand(db.app, again(releaser), (c) => lockBlockerEpoch(c, 'batch', batch));

    // The person investigated now writes to the batch inside the investigation window.
    await insertEntry(db, subject, batch, '5.55');

    // A disposition blocker has appeared on the batch (precondition: the implicit branch of open_blockers).
    const after = await openBlockers(db.app, 'batch', batch);
    expect(after.filter((b) => b.blocksDisposition).map((b) => [b.kind, b.id])).toEqual([['DI_INVESTIGATION', id]]);

    // Release module, inside the signing transaction: lock the epoch and compare. Because a new
    // disposition blocker appeared since evaluation, the epoch must have moved so the release refuses.
    const epochAtSigning = await withCommand(db.app, again(releaser), (c) => lockBlockerEpoch(c, 'batch', batch));
    expect(
      epochAtSigning,
      `blocker epoch still ${epochAtSigning} although DI investigation ${id} now blocks disposition of batch:${batch}; a release evaluated before the write passes the epoch check`,
    ).not.toBe(epochAtEvaluation);
  });
});
