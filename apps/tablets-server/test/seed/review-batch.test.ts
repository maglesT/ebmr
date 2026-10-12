/**
 * The DEMO-ONLY review batch of the set-up CLI (`--gmp-review-batch`, Phase 4 slice 1c): a GMP installation made by the
 * CLI carries one GB-T-01 batch record that the review screens and the e2e specs can review: issued with the issuer's
 * ISSUED signature, its first step performed and verified, its exceptions dispositioned on the floor, an output container
 * open with a pending hold, and the record at EXECUTION_COMPLETE (the seed's labelled demo shortcut). The review routes
 * then offer production approval, the register lists the floor's exceptions and the container is listed.
 */
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { routes } from '@ebmr/api-contract';
import { setupInstallation } from '../../src/cli/setup.ts';
import type { ReviewBatchSeed } from '../../src/cli/review-batch.ts';
import { startServer, type TestServer } from '../support/harness.ts';
import { valueOf } from '../esig/support.ts';

const database = `ebmr_review_e2e_${randomBytes(4).toString('hex')}`;
const dir = mkdtempSync(join(tmpdir(), 'ebmr-review-batch-'));
let server: TestServer;
let batch: ReviewBatchSeed;

beforeAll(async () => {
  const keysDir = join(dir, 'keys');
  const seed = await setupInstallation({ installation: 'GMP', database, keysDir, exchangeDir: join(dir, 'exchange'), personaSets: 1, recreate: true, reviewBatch: true, log: () => undefined });
  batch = JSON.parse(readFileSync(join(keysDir, 'gmp-review-batch.json'), 'utf8')) as ReviewBatchSeed;
  server = await startServer('GMP', { prepared: { database, seed }, env: { EBMR_SEAL_KEY_FILE: join(keysDir, 'gmp-seal-key.json') } });
}, 900_000);

afterAll(async () => {
  await server?.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('the review batch of the set-up CLI (demo seed)', () => {
  it('builds an issued GB-T-01 batch record at EXECUTION_COMPLETE that production may approve, with its exceptions in the register', async () => {
    const head = await server.asPersona('head1');
    const queue = valueOf(await head.call(routes.review.queue, { query: {} }));
    expect(queue.batches.map((b) => b.batchId)).toContain(batch.batchId);
    const view = valueOf(await head.call(routes.review.batch, { params: { batchId: batch.batchId } }));
    expect(view).toMatchObject({ batchNumber: batch.batchNumber, reviewState: 'EXECUTION_COMPLETE', cycle: 1, recordKind: 'PROCESSING' });
    expect(view.gates.productionApprove).toEqual({ ready: true, problems: [] });
    const qa = await server.asPersona('qaInvestigator');
    const register = valueOf(await qa.call(routes.review.register, { params: { batchId: batch.batchId }, body: {} }));
    expect(register.items).toHaveLength(3);
    // Every exception was dispositioned on the floor with its deviation: the two alerts share one (review may accept them
    // together), the action exception has its own.
    expect(register.items.map((i) => i.engineDisposition?.outcome)).toEqual(['DEVIATION_RAISED', 'DEVIATION_RAISED', 'DEVIATION_RAISED']);
    const groups = register.items.map((i) => i.group);
    expect(groups[0]).toMatch(/^DEV-/);
    expect(groups[1]).toBe(groups[0]);
    expect(groups[2]).not.toBe(groups[0]);
  }, 120_000);

  it('lists the open output container on PRESS-01 with its pending hold', async () => {
    const qa = await server.asPersona('qaInvestigator');
    const list = valueOf(await qa.call(routes.containers.list, { query: { batchId: batch.batchId } }));
    const c = list.containers.find((x) => x.containerId === batch.containerId);
    expect(c).toMatchObject({ state: 'OPEN', press: 'PRESS-01', label: batch.containerLabel });
    expect(c?.holds.map((h) => h.result)).toEqual(['FAIL']);
  }, 120_000);
});
