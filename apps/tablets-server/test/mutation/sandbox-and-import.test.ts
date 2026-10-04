/**
 * The sandbox's own guards, guard by guard (SQL mutation group "sandbox-and-import", the functions that need a
 * provisioned sandbox or the tablets schema; here tablets 0610 tab.register_sandbox_lot). The scenario tests register
 * the demo lots through the seed, which only ever sends complete lots; these tests call the register with the
 * application role inside the steward's own commands, so each refusal is proven where it is enforced, with its own
 * message, and nothing is written after it.
 *
 * Controls: DI-05 (segregation of non-GMP functions), PR-18 (test lots).
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withCommand, type ActorContext } from '@ebmr/kernel';
import { openPersonaSession } from '@ebmr/test-kit';
import { startExecServer, type ExecServer } from '../execution/support.ts';

let sbx: ExecServer;
beforeAll(async () => {
  sbx = await startExecServer();
}, 180_000);
afterAll(async () => {
  await sbx?.close();
});

/** The message a promise is rejected with, or 'ok'. */
async function messageOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'ok';
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

// ---------------------------------------------------------------------------------------------------------------------

describe('test lots (tablets 0200, 0610)', () => {
  let steward: ActorContext | undefined;
  const register = async (lot: unknown): Promise<string> => {
    steward ??= await openPersonaSession(sbx.db, sbx.seed, 'steward');
    return messageOf(withCommand(sbx.db.app, { ...steward, correlationId: randomUUID() }, (c) => c.query('select tab.register_sandbox_lot($1::jsonb)', [JSON.stringify(lot)])));
  };
  const lots = async (): Promise<string[]> => (await sbx.db.admin.query<{ code: string }>('select lot_code as code from tab.sandbox_lot order by lot_code')).rows.map((r) => r.code);
  const lot = (code: string, extra: Record<string, unknown> = {}) => ({ lotCode: code, materialCode: 'MAT-PCM', materialName: 'Paracetamol', status: 'RELEASED', identityTested: true, ...extra });

  it('[PR-18][DI-05] a test lot without a lot code, or without a yes-or-no identity test, is refused (EBMR-EXE-070) and nothing is registered', async () => {
    const before = await lots();
    const incomplete = 'A test lot needs a lot code, a material, a status and whether it is identity-tested (PR-18). [EBMR-EXE-070]';
    const noIdentityTest: Record<string, unknown> = lot('TEST-L26-0901');
    delete noIdentityTest['identityTested'];
    for (const [what, l] of [
      ['an empty lot code', lot('')],
      ['a blank lot code', lot('   ')],
      ['no lot code', { ...lot('x'), lotCode: undefined }],
      ['no identity test', noIdentityTest],
      ['an identity test that is text', lot('TEST-L26-0902', { identityTested: 'true' })],
      ['an identity test that is null', lot('TEST-L26-0903', { identityTested: null })],
      ['a list instead of a lot', [lot('TEST-L26-0904')]],
    ] as const) {
      expect([what, await register(l)]).toEqual([what, incomplete]);
    }
    expect(await lots()).toEqual(before);
  });

  it('[PR-18] expiry and retest dates are whole epoch microseconds: a negative or fractional value of either alone is refused (EBMR-EXE-070); valid dates are stored as given', async () => {
    const before = await lots();
    const notMicros = 'Expiry and retest dates are epoch microseconds (PR-18). [EBMR-EXE-070]';
    for (const [what, extra] of [
      ['a negative expiry', { expiresAtUs: '-1' }],
      ['a fractional expiry', { expiresAtUs: '1790000000000000.5' }],
      ['a negative retest', { retestAtUs: '-1' }],
      ['a fractional retest', { retestAtUs: '1.5' }],
      ['a valid expiry with a negative retest', { expiresAtUs: '1790000000000000', retestAtUs: '-86400000000' }],
      ['a negative expiry with a valid retest', { expiresAtUs: '-86400000000', retestAtUs: '1790000000000000' }],
    ] as const) {
      expect([what, await register(lot('TEST-L26-0911', extra))]).toEqual([what, notMicros]);
    }
    expect(await lots()).toEqual(before);
    expect(await register(lot('TEST-L26-0911', { expiresAtUs: '1790000000000000', retestAtUs: '1780000000000000' }))).toBe('ok');
    const { rows } = await sbx.db.app.query<{ l: Record<string, unknown> }>("select tab.resolve_lot('TEST-L26-0911') as l");
    expect(rows[0]?.l).toMatchObject({ lotCode: 'TEST-L26-0911', expiresAtUs: '1790000000000000', retestAtUs: '1780000000000000', identityTested: true });
  });

  it('[PR-18][DI-05] a lot is registered once and never changed: registering its code again is refused (EBMR-EXE-071) and the first registration stays', async () => {
    expect(await register(lot('TEST-L26-0921'))).toBe('ok');
    expect(await register(lot('TEST-L26-0921', { status: 'QUARANTINE', identityTested: false }))).toBe(
      'Test lot TEST-L26-0921 is registered already; a lot is never changed, register a new one (PR-18). [EBMR-EXE-071]',
    );
    const { rows } = await sbx.db.admin.query<{ status: string; identity_tested: boolean; n: string }>(
      "select status, identity_tested, count(*) over ()::text as n from tab.sandbox_lot where lot_code = 'TEST-L26-0921'",
    );
    expect(rows).toEqual([{ status: 'RELEASED', identity_tested: true, n: '1' }]);
  });
});
