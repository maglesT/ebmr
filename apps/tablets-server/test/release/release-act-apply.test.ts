/**
 * The two-row release (D-P4-5; release/signables.ts; Phase 6 mutation triage T13). The ceremony signs the manufacturer
 * release and the companion US disposition in one command, and the handler then runs the act. Which act consumes the
 * companion signature is decided only here: recipe.record_release_with_us_disposition checks both signatures, but nothing
 * in the database requires a US_DISPOSITION signature to be consumed, so a two-row release that ran the manufacturer
 * release alone would leave a signed US disposition with no decision behind it. Proved on the handler's apply with a
 * stand-in for the database client (the refusals of the acts themselves are proved in recipe-core's release tests).
 */
import { describe, expect, it } from 'vitest';
import type { SignableAction } from '@ebmr/api-contract';
import type { AppContext } from '../../src/platform/context.ts';
import { releaseActHandler } from '../../src/features/release/signables.ts';

type ReleaseAct = Extract<SignableAction, { kind: 'RELEASE_ACT' }>;
const LOT = '6f1c2a34-0d3e-4b8a-9c55-1e2f3a4b5c6d';

function fakeClient() {
  const sent: { sql: string; params: unknown[] }[] = [];
  const client = {
    query: (sql: string, params: unknown[] = []) => {
      sent.push({ sql, params });
      // No QMS integrated: the release asks nothing (integrations/adapters/qms).
      if (sql.includes('site.qms_mode()')) return Promise.resolve({ rows: [{ mode: 'NONE', lot_code: null }] });
      return Promise.resolve({ rows: [] });
    },
  };
  return { client: client as never, acts: () => sent.filter((s) => s.sql.includes('recipe.record_')) };
}

const release = (input: ReleaseAct['input']): ReleaseAct => ({ kind: 'RELEASE_ACT', act: 'MANUFACTURER_RELEASE', lotId: LOT, input });
const signature = (companionSignatureId?: string) => ({ signatureId: 'SIG-MR', meaning: 'MANUFACTURER_RELEASE', signer: 'AP', ...(companionSignatureId ? { companionSignatureId } : {}) });

describe('the two-row release consumes both signatures (T13)', () => {
  const handler = releaseActHandler({} as AppContext);

  it('[IN-05][DI-37] a release with the US epoch runs the two-row act with both signatures and never the manufacturer release alone', async () => {
    const f = fakeClient();
    await handler.apply(f.client, {} as never, release({ expectedEpoch: 'E-IN', usExpectedEpoch: 'E-US' }), signature('SIG-US'));
    expect(f.acts()).toEqual([{ sql: 'select recipe.record_release_with_us_disposition($1, $2, $3, $4, $5)', params: [LOT, 'SIG-MR', 'SIG-US', 'E-IN', 'E-US'] }]);
  });

  it('[IN-05][DI-37] a two-row release without its US signature runs no act (the ceremony rolls back whole); a release without the US epoch runs the manufacturer release alone', async () => {
    const f = fakeClient();
    await expect(handler.apply(f.client, {} as never, release({ expectedEpoch: 'E-IN', usExpectedEpoch: 'E-US' }), signature())).rejects.toThrow(/US_DISPOSITION signature/);
    expect(f.acts()).toEqual([]);
    const g = fakeClient();
    await handler.apply(g.client, {} as never, release({ expectedEpoch: 'E-IN' }), signature());
    expect(g.acts()).toEqual([{ sql: "select recipe.record_manufacturer_release($1, 'RELEASE', $2, $3, null)", params: [LOT, 'SIG-MR', 'E-IN'] }]);
  });
});
