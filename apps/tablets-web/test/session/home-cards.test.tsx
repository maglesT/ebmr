/**
 * Declutter D3 (docs/build-plan/declutter/plan.md section 4): the home's four work cards. Each count comes from an
 * existing read (execution.workQueue, review.queue, release.queue); a card is shown only where the session's role may
 * make its read (display only, the server stays the authority); a card opens its list, whose rows link to the record.
 * The Functions list keeps its tiles by title.
 *
 * Control: DI-17.
 */
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { LotReleaseSummaryView, ReviewSummaryView, SessionView, WorkQueueItem } from '@ebmr/api-contract';
import { EXAMPLES } from '@ebmr/api-contract/examples';
import { READ_REFUSED, readOffered, tileOffered } from '../../src/app/tile-access.ts';

const holder = vi.hoisted(() => ({ key: null as null | { privateKey: CryptoKey; publicKeySpki: string; label: string } }));
vi.mock('../../src/device/keystore.ts', () => ({
  loadDeviceKey: () => Promise.resolve(holder.key),
  saveDeviceKey: () => Promise.resolve(),
  forgetDeviceKey: () => Promise.resolve(),
  importDemoKey: () => Promise.reject(new Error('not used in this test')),
}));

const { setTransport } = await import('../../src/api/client.ts');
const { createFixtureFetch } = await import('../../src/api/fixture-fetch.ts');
const { fixturesFromExamples } = await import('../../src/api/examples.ts');
const { App } = await import('../../src/app/App.tsx');

const baseSession = EXAMPLES['session-office'].data as SessionView;

const RUN_A = '11111111-1111-4111-8111-111111111111';
const RUN_B = '22222222-2222-4222-8222-222222222222';
const itemTemplate = (EXAMPLES['work-queue'].data as { items: WorkQueueItem[] }).items[0] as WorkQueueItem;
const item = (runId: string, batchNumber: string, stepKey: string, available: boolean): WorkQueueItem => ({
  ...itemTemplate,
  runId,
  batchNumber,
  stepKey,
  product: { code: 'PCM-500', name: 'Paracetamol', strength: '500 mg' },
  action: { ...itemTemplate.action, available },
});
const WORK = { items: [item(RUN_A, 'B26-0041', itemTemplate.stepKey, true), item(RUN_A, 'B26-0041', itemTemplate.stepKey + 'b', false), item(RUN_B, 'B26-0039', itemTemplate.stepKey, true)] };

const reviewTemplate = (EXAMPLES['review-queue'].data as { batches: ReviewSummaryView[] }).batches[0] as ReviewSummaryView;
const review = (batchId: string, batchNumber: string, reviewState: ReviewSummaryView['reviewState']): ReviewSummaryView => ({ ...reviewTemplate, batchId, batchNumber, reviewState });
const REVIEW = {
  batches: [
    review('33333333-3333-4333-8333-333333333331', 'B26-0030', 'EXECUTION_COMPLETE'),
    review('33333333-3333-4333-8333-333333333332', 'B26-0031', 'PRODUCTION_APPROVED'),
    review('33333333-3333-4333-8333-333333333333', 'B26-0032', 'QA_REVIEWED'),
    review('33333333-3333-4333-8333-333333333334', 'B26-0033', 'IN_PROGRESS'),
  ],
};

const lotTemplate = (EXAMPLES['release-queue'].data as { lots: LotReleaseSummaryView[] }).lots[0] as LotReleaseSummaryView;
const lot = (lotId: string, batchNumber: string, state: LotReleaseSummaryView['state']): LotReleaseSummaryView => ({ ...lotTemplate, lotId, batchNumber, state });
const RELEASE = {
  lots: [
    lot('44444444-4444-4444-8444-444444444441', 'B26-0020', 'READY'),
    lot('44444444-4444-4444-8444-444444444442', 'B26-0021', 'RELEASED'),
    lot('44444444-4444-4444-8444-444444444443', 'B26-0022', 'REJECTED'),
    lot('44444444-4444-4444-8444-444444444444', 'B26-0023', 'NOT_READY'),
  ],
};

beforeAll(async () => {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
  const spki = Buffer.from(await crypto.subtle.exportKey('spki', pair.publicKey)).toString('base64');
  holder.key = { privateKey: pair.privateKey, publicKeySpki: spki, label: 'TEST-PC-QA-1' };
});

afterEach(() => {
  cleanup();
  window.history.replaceState(null, '', '/');
});

/** The whole application at `path`, signed in as `role` on an office PC (GMP), with the three queues as given. */
function open(path: string, role: string, release: { lots: LotReleaseSummaryView[] } = RELEASE) {
  const session = { ...baseSession, role, roles: [role] };
  setTransport(
    createFixtureFetch(
      {
        ...fixturesFromExamples('GMP'),
        'session.demoDevices': { devices: [] },
        'session.deviceNonce': { nonce: 'fixture-nonce-0123456789', expiresInSeconds: 60 },
        'session.identify': session.device,
        'session.get': session,
        'execution.workQueue': WORK,
        'review.queue': REVIEW,
        'release.queue': release,
      },
      { installation: 'GMP' },
    ),
  );
  window.history.replaceState(null, '', path);
  render(<App />);
}

const card = async (name: RegExp) => within(await screen.findByRole('navigation', { name: 'Work' })).findByRole('link', { name });

describe('[DI-17] the home work cards (declutter D3)', () => {
  it('[DI-17] readOffered follows READ_REFUSED like tileOffered; no role is offered every read', () => {
    const refused = READ_REFUSED.GMP['review.queue'] ?? [];
    expect(refused).toContain('EU_QP_READER');
    expect(readOffered('review.queue', 'GMP', 'EU_QP_READER')).toBe(false);
    expect(readOffered('review.queue', 'GMP', 'QA_REVIEWER')).toBe(true);
    expect(readOffered('review.queue', 'GMP', null)).toBe(true);
    expect(readOffered('no.such.read', 'GMP', 'EU_QP_READER')).toBe(true);
    expect(readOffered('people.directory', 'SANDBOX', 'OPERATOR')).toBe(false);
    expect(tileOffered('review', 'GMP', 'EU_QP_READER')).toBe(readOffered('review.queue', 'GMP', 'EU_QP_READER'));
  });

  it('[DI-17] the counts come from the reads: 3 work items in 2 runs (2 available), 2 open reviews, 1 undecided lot', async () => {
    open('/', 'QA_REVIEWER');
    await waitFor(async () => expect((await card(/^My batches/)).textContent).toBe('My batches 2'));
    expect((await card(/^To sign/)).textContent).toBe('To sign 2');
    await waitFor(async () => expect((await card(/^To review/)).textContent).toBe('To review 2'));
    await waitFor(async () => expect((await card(/^To release/)).textContent).toBe('To release 1'));
    expect(screen.getByRole('link', { name: 'To sign 2' })).toBeTruthy();
  });

  it('[DI-17] a role refused review.queue and release.queue (EU_QP_READER) gets none of those cards', async () => {
    expect(READ_REFUSED.GMP['execution.workQueue']).toContain('EU_QP_READER');
    open('/', 'EU_QP_READER');
    await screen.findByRole('heading', { level: 1 });
    expect(screen.queryByRole('navigation', { name: 'Work' })).toBeNull();
    expect(screen.queryByTestId('work-card-to-review')).toBeNull();
    expect(screen.queryByTestId('work-card-to-release')).toBeNull();
  });

  it('[DI-17] a card opens its list, whose rows link to the record', async () => {
    open('/', 'QA_REVIEWER');
    await userEvent.click(await card(/^To sign/));
    expect(await screen.findByRole('heading', { level: 1, name: 'To sign (2)' })).toBeTruthy();
    const rows = within(screen.getByRole('list', { name: 'To sign' })).getAllByRole('link');
    expect(rows).toHaveLength(2);
    expect(rows[0]?.textContent).toContain('B26-0041');
    expect(rows[0]?.textContent).toContain('Paracetamol 500 mg');
    expect(rows[0]?.getAttribute('href')).toBe(`/runs/${RUN_A}/steps/${encodeURIComponent(itemTemplate.stepKey)}`);
    cleanup();

    open('/work/to-review', 'QA_REVIEWER');
    expect(await screen.findByRole('heading', { level: 1, name: 'To review (2)' })).toBeTruthy();
    const reviewRows = within(screen.getByRole('list', { name: 'To review' })).getAllByRole('link');
    expect(reviewRows.map((r) => r.getAttribute('href'))).toEqual(['/review/33333333-3333-4333-8333-333333333331', '/review/33333333-3333-4333-8333-333333333332']);
    cleanup();

    open('/work/to-release', 'QA_REVIEWER');
    expect(await screen.findByRole('heading', { level: 1, name: 'To release (1)' })).toBeTruthy();
    const lotRows = within(screen.getByRole('list', { name: 'To release' })).getAllByRole('link');
    expect(lotRows.map((r) => r.getAttribute('href'))).toEqual(['/release/44444444-4444-4444-8444-444444444441']);
    cleanup();

    open('/work/my-batches', 'QA_REVIEWER');
    expect(await screen.findByRole('heading', { level: 1, name: 'My batches (2)' })).toBeTruthy();
    expect(within(screen.getByRole('list', { name: 'My batches' })).getAllByRole('link')).toHaveLength(3);
  });

  it('[DI-17] an empty list says "Nothing here."', async () => {
    open('/work/to-release', 'QA_REVIEWER', { lots: RELEASE.lots.filter((l) => l.state !== 'READY') });
    expect(await screen.findByRole('heading', { level: 1, name: 'To release (0)' })).toBeTruthy();
    expect(screen.getByText('Nothing here.')).toBeTruthy();
  });

  it('[DI-17] the Functions list still offers the tiles by title, without their descriptions', async () => {
    open('/', 'QA_REVIEWER');
    const nav = await screen.findByRole('navigation', { name: 'Functions' });
    const review = await within(nav).findByRole('link', { name: /^Batch record review/ });
    expect(review.textContent).toBe('Batch record review');
    expect(review.getAttribute('data-available')).toBe('true');
  });
});
