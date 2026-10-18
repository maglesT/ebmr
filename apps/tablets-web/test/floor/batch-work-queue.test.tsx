/**
 * "What you can do now" in one GMP batch (slice 7g-5, decision 0025; route batches.workQueue): the batch overview on the
 * GMP installation lists the batch's steps this terminal's room may work on, each with the action the server offers and,
 * when not available now, greyed with the server's reason (DI-34). The sandbox has no such read (its cockpit is the
 * terminal's whole queue).
 */
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { routes } from '@ebmr/api-contract';
import { EXAMPLES } from '@ebmr/api-contract/examples';
import { apiState } from '../../src/api/client.ts';
import { renderFloor, RUN_ID, type Recorded } from './support.tsx';

afterEach(() => {
  cleanup();
  apiState.installation = undefined;
});

const base = Object.values(EXAMPLES).find((e) => 'routeId' in e && e.routeId === routes.batches.workQueue.id)?.data as { items: { stepKey: string; number: string; title: string; action: Record<string, unknown> }[] };
const first = base.items[0]!;
const queue = routes.batches.workQueue.response.parse({ items: [{ ...first, runId: RUN_ID, action: { ...first.action, available: false, reason: 'The room is not clean.' } }] });

describe('the work queue of one GMP batch', () => {
  it('[DI-34] the GMP batch overview lists what this room may do now in the batch, greyed with the server\'s reason', async () => {
    const seen: Recorded[] = [];
    renderFloor(`/runs/${RUN_ID}`, { installation: 'GMP', fixtures: { 'batches.workQueue': queue }, intercept: (r) => { seen.push(r); return undefined; } });
    const box = await screen.findByTestId('batch-work-queue');
    await waitFor(() => expect(seen.some((r) => r.method === 'GET' && r.path === `/api/batches/${RUN_ID}/work-queue`)).toBe(true));
    const item = await within(box).findByTestId(`batch-work-${first.stepKey}`);
    expect(item.getAttribute('data-available')).toBe('false');
    expect(item.textContent).toContain('The room is not clean.');
    expect(within(item).getByRole('link', { name: `${first.number} ${first.title}` }).getAttribute('href')).toBe(`/runs/${RUN_ID}/steps/${encodeURIComponent(first.stepKey)}`);
  });

  it('[DI-34] the sandbox overview has no batch queue', async () => {
    renderFloor(`/runs/${RUN_ID}`);
    await screen.findByRole('heading', { level: 1 });
    expect(screen.queryByTestId('batch-work-queue')).toBeNull();
  });
});
