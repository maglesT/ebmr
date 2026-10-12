/**
 * The register routes over HTTP record what grouped and critical dispositions stand on (Phase 4 slice 1c regression;
 * contract ns/review.ts; recipe-core 0712, 0718, 0721). review.register records one showing of the full list to the
 * person, at its real time; review.openItem records one opening of the item's detail. Grouped acceptance of items that
 * share one linked deviation is refused before the showing and accepted after it; a critical item is refused until its
 * detail was opened, then accepted on its own.
 *
 * The batch is the set-up CLI's review batch (--gmp-review-batch: two alerts sharing one deviation, an action exception
 * with its own). The critical item is copied by the test from a real register row, as the engine raises one only on a
 * registered-limit breach of a real step (as packages/recipe-core/test/review/review.test.ts does).
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { routes, type SignableAction } from '@ebmr/api-contract';
import { setupInstallation } from '../../src/cli/setup.ts';
import type { ReviewBatchSeed } from '../../src/cli/review-batch.ts';
import { personaIn, refusalOf, valueOf } from '../esig/support.ts';
import { startServer, type TestServer } from '../support/harness.ts';
import { signAction } from '../support/signed-acts.ts';

const database = `ebmr_regroutes_e2e_${randomBytes(4).toString('hex')}`;
const dir = mkdtempSync(join(tmpdir(), 'ebmr-register-routes-'));
let server: TestServer;
let batch: ReviewBatchSeed;
const CRIT = 'EX-3-C';

beforeAll(async () => {
  const keysDir = join(dir, 'keys');
  const seed = await setupInstallation({ installation: 'GMP', database, keysDir, exchangeDir: join(dir, 'exchange'), personaSets: 1, recreate: true, reviewBatch: true, log: () => undefined });
  batch = JSON.parse(readFileSync(join(keysDir, 'gmp-review-batch.json'), 'utf8')) as ReviewBatchSeed;
  server = await startServer('GMP', { prepared: { database, seed }, env: { EBMR_SEAL_KEY_FILE: join(keysDir, 'gmp-seal-key.json') } });
  // A critical item as the engine raises it on a registered-limit breach, copied from the action exception's row.
  const fx = await server.db.admin.connect();
  try {
    await fx.query('begin');
    await fx.query('select kernel.set_actor_context($1::jsonb)', [
      JSON.stringify({
        person_id: '00000000-0000-0000-0000-000000000000', account_id: '00000000-0000-0000-0000-000000000000', role_code: 'TEST_FIXTURE',
        session_id: '00000000-0000-0000-0000-000000000000', source: 'SYSTEM', site_zone: 'UTC', correlation_id: randomUUID(), legal_name: 'Test fixture',
        reason_code: 'TEST_FIXTURE', reason_text: 'a critical register item copied from a real one',
      }),
    ]);
    await fx.query(
      `insert into recipe.exception_register (batch_id, exception_id, row_seq, exception_type, category, severity, tier, title, raising_step_key, raising_step, raised_at, raised_at_us,
                                              raised_by, command_person, mandatory, qa_only, deviation_required, registration_relevant, release_blocking, blocks_until, raised_record, correlation_id)
       select batch_id, $2, row_seq, 'LIMIT_BREACH', category, 'CRITICAL', 'REGISTERED', 'LOD above the registered limit', raising_step_key, raising_step, raised_at, raised_at_us,
              raised_by, command_person, mandatory, true, deviation_required, true, release_blocking, blocks_until, raised_record, correlation_id
         from recipe.exception_register where batch_id = $1 and exception_id = 'EX-3'`,
      [batch.batchId, CRIT],
    );
    await fx.query(
      `insert into recipe.exception_register_act (batch_id, exception_id, act, row_seq, by_person, by_account, role_code, outcome, signature_id, note, correlation_id)
       select batch_id, $2, act, row_seq, by_person, by_account, role_code, outcome, signature_id, note, correlation_id
         from recipe.exception_register_act where batch_id = $1 and exception_id = 'EX-3' and act = 'DISPOSITIONED'`,
      [batch.batchId, CRIT],
    );
    await fx.query('commit');
  } finally {
    fx.release();
  }
}, 900_000);

afterAll(async () => {
  await server?.close();
  rmSync(dir, { recursive: true, force: true });
});

const codeOf = (r: Awaited<ReturnType<typeof signAction>>): string => (r.ok ? 'ok' : (refusalOf(r)?.code ?? 'refused'));
const count = async (table: 'review_list_view' | 'review_item_view', personId: string): Promise<number> =>
  Number((await server.db.admin.query<{ n: string }>(`select count(*)::text as n from recipe.${table} where batch_id = $1 and person_id = $2`, [batch.batchId, personId])).rows[0]?.n ?? '0');

describe('the register routes record the showing and the opening (PR-52, DI-26)', () => {
  it('[PR-52][DI-26] grouped acceptance stands on a recorded showing of the full list; a critical item is accepted only after its recorded opening', async () => {
    const B = batch.batchId;
    const head = await server.asPersona('head1');
    valueOf(await signAction(server, head, 'head1', { kind: 'REVIEW_ACT', act: 'PRODUCTION_APPROVE', batchId: B, input: {} }));
    const qa = await server.asPersona('qaInvestigator');
    const me = personaIn(server, 'qaInvestigator').personId;
    const items = (ids: string[], justification: string): SignableAction => ({ kind: 'REVIEW_ACT', act: 'DISPOSE_ITEM', batchId: B, input: { items: ids, disposition: 'ACCEPT', justification } });
    const group = 'Both alerts were corrected at the booth before any material was handled; no impact on the batch.';

    // Before the list was shown to this person, the group is refused.
    expect(codeOf(await signAction(server, qa, 'qaInvestigator', items(['EX-1', 'EX-2'], group)))).toBe('EBMR-REV-058');

    // The showing is recorded once per call, at its real time.
    const shown = valueOf(await qa.call(routes.review.register, { params: { batchId: B }, body: {} }));
    expect(await count('review_list_view', me)).toBe(1);
    expect(BigInt(shown.shownAt.us)).toBeGreaterThan(1_700_000_000_000_000n);
    expect(shown.items.map((i) => [i.exceptionId, i.critical, i.group === null ? null : 'G']).sort()).toEqual([
      ['EX-1', false, 'G'],
      ['EX-2', false, 'G'],
      ['EX-3', false, 'G'],
      [CRIT, true, null],
    ]);
    valueOf(await signAction(server, qa, 'qaInvestigator', items(['EX-1', 'EX-2'], group)));

    // The critical item: refused before its detail was opened by this person, accepted after.
    const why = 'Investigated under the linked deviation: the LOD was re-tested within the registered limit.';
    expect(codeOf(await signAction(server, qa, 'qaInvestigator', items([CRIT], why)))).toBe('EBMR-REV-055');
    const detail = valueOf(await qa.call(routes.review.openItem, { params: { batchId: B, exceptionId: CRIT }, body: {} }));
    expect(await count('review_item_view', me)).toBe(1);
    expect(BigInt(detail.openedAt.us)).toBeGreaterThan(1_700_000_000_000_000n);
    valueOf(await signAction(server, qa, 'qaInvestigator', items([CRIT], why)));

    const after = valueOf(await qa.call(routes.review.register, { params: { batchId: B }, body: {} }));
    expect(after.items.filter((i) => i.reviewStatus === 'ACCEPTED').map((i) => i.exceptionId).sort()).toEqual(['EX-1', 'EX-2', CRIT].sort());
    expect(await count('review_list_view', me)).toBe(2);
  }, 300_000);
});
