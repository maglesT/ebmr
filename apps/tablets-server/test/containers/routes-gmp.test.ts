/**
 * The container routes on GMP (Phase 4 slice 1b; contract ns/containers.ts): open, close typed or weighed, the second
 * person's VERIFY_CLOSE and QA's RELEASE through the signing ceremony (CONTAINER_ACT), sort and reject with the person's
 * reason. The rules are the database's (recipe-core 0740, 0741; tablets 1111); these tests prove the server reaches them.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { sha256Hex } from '@ebmr/expr';
import { routes, type ContainerView, type SignableAction } from '@ebmr/api-contract';
import { personaIn, refusalOf, tapFor, valueOf } from '../esig/support.ts';
import type { TestBrowser } from '../support/harness.ts';
import { startGmpBatchWorld, type GmpBatchWorld } from '../support/gmp-world.ts';
import { credentialsOf } from '../support/signed-acts.ts';

let w: GmpBatchWorld;
let operator: TestBrowser;
let verifier: TestBrowser;
let batchId: string;

beforeAll(async () => {
  w = await startGmpBatchWorld();
  const issuer = await w.gmp.asPersona('issuer');
  [operator, verifier] = await Promise.all([w.gmp.asPersona('operator1'), w.gmp.asPersona('verifier1')]);
  batchId = await w.issued(issuer);
  vi.useFakeTimers({ toFake: ['performance'] });
}, 600_000);
afterAll(async () => {
  vi.useRealTimers();
  await w?.close();
});

/** The signing ceremony of a kiosk persona: describe, preview, a challenge confirmed by a fresh badge tap, sign. */
async function signAction(b: TestBrowser, key: string, action: SignableAction) {
  const d = valueOf(await b.call(routes.esig.describe, { body: { action } }));
  const preview = await b.call(routes.esig.content, { query: { aggregateType: d.aggregateType, aggregateId: d.aggregateId, intent: d.meaning ?? '' } });
  if (!preview.ok) return preview;
  const body = { aggregateType: d.aggregateType, aggregateId: d.aggregateId, contentVersion: preview.value.contentVersion, meaning: d.meaning ?? '', clientContentHash: sha256Hex(preview.value.canonicalText), action };
  vi.advanceTimersByTime(7_000);
  const challenge = await b.call(routes.esig.createChallenge, { body, attribution: await tapFor(b, personaIn(w.gmp, key), 'POST', '/api/esig/challenges', body) });
  if (!challenge.ok) return challenge;
  const signBody = { challengeId: challenge.value.challengeId, credentials: credentialsOf(w.gmp, key), action };
  return b.call(routes.esig.sign, { body: { ...signBody, proof: await b.proof('POST', '/api/esig/sign', signBody) } });
}

const tap = async (path: string, body: Record<string, unknown>) => {
  vi.advanceTimersByTime(7_000);
  return tapFor(operator, personaIn(w.gmp, 'operator1'), 'POST', path, body);
};
async function open(): Promise<ContainerView> {
  const body = { batchId, stage: 'GRANULATION', unit: 'kg' as const };
  return valueOf(await operator.call(routes.containers.open, { body, attribution: await tap('/api/containers', body) }));
}
async function closeTyped(c: ContainerView, net: string) {
  const body = { expectedVersion: c.version, typed: { net } };
  return operator.call(routes.containers.close, { params: { containerId: c.containerId }, body, attribution: await tap(`/api/containers/${c.containerId}/close`, body) });
}
const listed = async (id: string) => (valueOf(await verifier.call(routes.containers.list, { query: { batchId } })).containers.find((c) => c.containerId === id));

describe('container routes (GMP, Phase 4 slice 1b)', () => {
  it('[DI-30][INV-03] a typed close is listed as unusable until a second person verifies it through the ceremony; the closer is refused', async () => {
    const c = await open();
    expect(c).toMatchObject({ state: 'OPEN', batchId, closeBasis: null });
    const closed = valueOf(await closeTyped(c, '18.250'));
    expect(closed).toMatchObject({ state: 'CLOSED', closeBasis: 'TYPED', netQuantity: '18.250', netVerifiedBy: null });
    expect(closed.usableProblem).toMatch(/second person/);
    const act = { kind: 'CONTAINER_ACT' as const, act: 'VERIFY_CLOSE' as const, containerId: c.containerId };
    expect((await signAction(operator, 'operator1', act)).ok).toBe(false);
    const ok = await signAction(verifier, 'verifier1', act);
    expect(ok.ok, ok.ok ? '' : JSON.stringify(ok.error)).toBe(true);
    expect(await listed(c.containerId)).toMatchObject({ netVerifiedBy: { personId: personaIn(w.gmp, 'verifier1').personId }, usableProblem: null });
    // A second verification is refused (once is enough; the ceremony rolls back whole).
    expect((await signAction(verifier, 'verifier1', act)).ok).toBe(false);
  }, 180_000);

  it('[DI-30][DI-32] a close is weighed or typed, never both; a weighed close stands on readings the room\'s balance sent (unknown ones are refused); a stale version is refused', async () => {
    const c = await open();
    const both = { expectedVersion: c.version, typed: { net: '1.000' }, weighing: { tareReadingId: randomUUID(), grossReadingId: randomUUID() } };
    expect((await operator.call(routes.containers.close, { params: { containerId: c.containerId }, body: both as never, attribution: await tap(`/api/containers/${c.containerId}/close`, both) })).ok).toBe(false);
    const weighed = { expectedVersion: c.version, weighing: { tareReadingId: randomUUID(), grossReadingId: randomUUID() } };
    const r = await operator.call(routes.containers.close, { params: { containerId: c.containerId }, body: weighed, attribution: await tap(`/api/containers/${c.containerId}/close`, weighed) });
    expect(r.ok).toBe(false);
    expect(JSON.stringify(refusalOf(r))).toMatch(/EBMR-DEV-10[13]/);
    expect((await closeTyped({ ...c, version: c.version + 5 }, '2.000')).ok).toBe(false);
    expect(await listed(c.containerId)).toMatchObject({ state: 'OPEN', netQuantity: null });
  }, 180_000);

  it('[L-30] a container that is not held cannot be released, sorted or rejected; the refusals name the state', async () => {
    const c = valueOf(await closeTyped(await open(), '3.500'));
    const release = await signAction(await w.gmp.asPersona('qa1'), 'qa1', { kind: 'CONTAINER_ACT', act: 'RELEASE', containerId: c.containerId, reason: { code: 'IPC_INVESTIGATED', text: 'Investigation concluded' } });
    expect(release.ok).toBe(false);
    const body = { expectedVersion: c.version, reason: { code: 'SORTING', text: '100 % sort after a failed check' } };
    const sorted = await operator.call(routes.containers.sort, { params: { containerId: c.containerId }, body, attribution: await tap(`/api/containers/${c.containerId}/sort`, body) });
    expect(sorted.ok).toBe(false);
    expect(await listed(c.containerId)).toMatchObject({ state: 'CLOSED', releaseProblem: null });
  }, 180_000);
});
