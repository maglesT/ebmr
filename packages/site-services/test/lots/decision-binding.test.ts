/**
 * Phase 3 exit review HIGH-2 (site-services 0800): a MATERIAL_LOT_STATUS_DECIDED signature names the decision it was
 * given for. The meaning covers HOLD, UNHOLD, RETURN, RECALL and RELEASE_FOR_FURTHER_PROCESSING, so the lot's signed
 * content shows the decision QA proposed at the lot's current state, and change_lot_status refuses any other event.
 * Proven as the application role.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { changeLotStatus, proposeLotDecision } from '../../src/index.ts';
import { createTestDatabase, type TestDatabase } from '../helpers.ts';
import { refusal, seedCast, World } from './support.ts';

let db: TestDatabase;
let w: World;

beforeAll(async () => {
  db = await createTestDatabase();
  w = new World(db, await seedCast(db));
}, 300_000);
afterAll(async () => {
  await db.drop();
});

const content = async (lotId: string): Promise<Record<string, unknown>> =>
  (await db.admin.query<{ c: { content: Record<string, unknown> } }>('select site.material_lot_content($1) as c', [lotId])).rows[0]?.c.content ?? {};

describe('a lot status decision signature binds its event (HIGH-2; sql/0800)', () => {
  it('[DI-37][IN-24] an UNHOLD with a signature given for RETURN is refused; the decision signed is the one applied', async () => {
    const lot = await w.releasedLot('API');
    await w.run(w.cast.qa, (c) => proposeLotDecision(c, lot.lotId, 'HOLD'));
    const hold = await w.sign(w.cast.qa, lot.lotId, 'MATERIAL_LOT_STATUS_DECIDED', 'RELEASED');
    await w.run(w.cast.qa, async (c) => changeLotStatus(c, lot.lotId, 'HOLD', await w.version(lot.lotId), hold), 'supplier complaint under investigation');

    // QA proposes and signs a RETURN; the signed content names it.
    await w.run(w.cast.qa, (c) => proposeLotDecision(c, lot.lotId, 'RETURN'));
    expect(await content(lot.lotId)).toMatchObject({ decision: 'RETURN' });
    const forReturn = await w.sign(w.cast.qa, lot.lotId, 'MATERIAL_LOT_STATUS_DECIDED', 'ON_HOLD');
    expect(await refusal(w.run(w.cast.qa, async (c) => changeLotStatus(c, lot.lotId, 'UNHOLD', await w.version(lot.lotId), forReturn), 'no impact'))).toMatch(
      /EBMR-SITE-114 .*RETURN.*UNHOLD/,
    );
    expect(await refusal(w.run(w.cast.qa, async (c) => changeLotStatus(c, lot.lotId, 'RECALL', await w.version(lot.lotId), forReturn), 'recall'))).toMatch(/EBMR-SITE-114/);
    expect(await w.state(lot.lotId)).toBe('ON_HOLD');

    // A later proposal changes the content: the RETURN signature no longer applies to anything.
    await w.run(w.cast.qa, (c) => proposeLotDecision(c, lot.lotId, 'UNHOLD'));
    expect(await refusal(w.run(w.cast.qa, async (c) => changeLotStatus(c, lot.lotId, 'UNHOLD', await w.version(lot.lotId), forReturn), 'no impact'))).not.toBe('');
    const forUnhold = await w.sign(w.cast.qa, lot.lotId, 'MATERIAL_LOT_STATUS_DECIDED', 'ON_HOLD');
    expect(await w.run(w.cast.qa, async (c) => changeLotStatus(c, lot.lotId, 'UNHOLD', await w.version(lot.lotId), forUnhold), 'investigation closed, no impact')).toMatchObject({ to: 'RELEASED' });
  });

  it('[DI-37][IN-24] a status decision with no proposed decision is refused; a proposal names an event of that meaning from the lot\'s state, by QA only; the application role cannot write a proposal', async () => {
    const lot = await w.releasedLot('API');
    const sig = await w.sign(w.cast.qa, lot.lotId, 'MATERIAL_LOT_STATUS_DECIDED', 'RELEASED');
    expect(await refusal(w.run(w.cast.qa, async (c) => changeLotStatus(c, lot.lotId, 'HOLD', await w.version(lot.lotId), sig), 'complaint'))).toMatch(/EBMR-SITE-114 .*no decision/);
    // UNHOLD is no decision out of RELEASED; RELEASE and REJECT carry their own meanings; the analyst holds no QA disposition.
    expect(await refusal(w.run(w.cast.qa, (c) => proposeLotDecision(c, lot.lotId, 'UNHOLD')))).toMatch(/EBMR-SITE-113/);
    expect(await refusal(w.run(w.cast.qa, (c) => proposeLotDecision(c, lot.lotId, 'REJECT' as 'HOLD')))).toMatch(/EBMR-SITE-113/);
    expect(await refusal(w.run(w.cast.analyst, (c) => proposeLotDecision(c, lot.lotId, 'HOLD')))).toMatch(/EBMR-IAM/);
    expect(
      await refusal(
        db.app.query("insert into site.lot_decision_intent (lot_id, event, from_state, state_version, proposed_by_person, proposed_by_account) values ($1, 'HOLD', 'RELEASED', 2, gen_random_uuid(), gen_random_uuid())", [lot.lotId]),
      ),
    ).toMatch(/permission denied/);
  });
});
