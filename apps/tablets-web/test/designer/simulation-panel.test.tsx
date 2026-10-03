/**
 * The simulation panel shows a report only for the saved content it was run on (review P20; DI-04: simulation
 * evidence is bound to the content hash). The report was kept in the panel's state, so after a new revision was
 * saved the panel read "Simulate saved revision 4" next to revision 3's green "Simulation passed" and its coverage.
 */
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FetchLike, SimulationReportView } from '@ebmr/api-contract';
import { flow } from '@ebmr/recipe-core/pure';
import { setTransport } from '../../src/api/client.ts';
import { createFixtureFetch, type FixtureMap } from '../../src/api/fixture-fetch.ts';
import { DesignerEditor } from '../../src/features/designer/DesignerPage.tsx';
import { fixtureVersion, PALETTE, PERSON_ID, renderRouted, report } from './support.tsx';

const at = { us: '1790580603000000', text: '28-SEP-2026 13:00:03 +05:30 (Asia/Kolkata)' };
const OTHER_CONTENT = 'This simulation ran on other content than the saved revision on screen.';

function simulation(contentHash: string, passed = true): SimulationReportView {
  return {
    watermark: { text: 'TEST, NOT GMP', source: 'SIMULATION', notice: 'Simulation output is not a GMP record.', control: 'DI-05' },
    contentHash,
    passed,
    paths: 3,
    coverage: { nodes: { covered: 14, total: 14 }, decisions: { covered: 2, total: 2 }, percent: '100.0' },
    problems: [],
    runs: [{ pathId: 'P1', outcome: 'COMPLETED', exceptions: [] }],
    simulatedAt: at,
  };
}

/** The server's saved content (hash) as the simulate route sees it: revision 3 first, then what the author saves. */
let serverHash = '';
/** When set, the next simulate answer waits for it (an answer still on its way); later ones do not. */
let simulateGate: Promise<void> | null = null;

function install(extra: FixtureMap = {}): void {
  const fixtures: FixtureMap = {
    'designer.validate': ({ body }: { body: { content: flow.MbrContent } }) => report([], flow.mbrContentHash(body.content)),
    'designer.simulate': () => simulation(serverHash),
    'designer.saveContent': ({ body }: { body: { content: flow.MbrContent } }) => {
      serverHash = flow.mbrContentHash(body.content);
      return fixtureVersion({ revision: 4, content: body.content as never, contentHash: serverHash });
    },
    ...extra,
  };
  const inner = createFixtureFetch(fixtures, { installation: 'GMP' });
  const gated: FetchLike = async (url, init) => {
    // The answer is computed when the request arrives (content saved at that moment), delivered when released.
    const answer = await inner(url, init);
    if (url.includes('/simulate') && simulateGate) {
      const gate = simulateGate;
      simulateGate = null;
      await gate;
    }
    return answer;
  };
  setTransport(gated);
}

async function saveRevision4(): Promise<void> {
  const title = await screen.findByRole('textbox', { name: 'Title' });
  await userEvent.clear(title);
  await userEvent.type(title, 'Renamed title{Enter}');
  await userEvent.click(screen.getByRole('button', { name: 'Save revision…' }));
  const dialog = await screen.findByRole('dialog', { name: 'Save revision 4' });
  await userEvent.type(within(dialog).getByRole('textbox', { name: /Change note/ }), 'Renamed');
  await userEvent.click(within(dialog).getByRole('button', { name: 'Save revision' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(await screen.findByText(/revision 4 ·/)).toBeTruthy();
}

beforeEach(() => {
  window.localStorage.clear();
  serverHash = fixtureVersion().contentHash;
  simulateGate = null;
  install();
});
afterEach(() => {
  window.localStorage.clear();
});

describe('simulation panel (DI-04: a report belongs to the content it was run on)', () => {
  it('[DI-04] after a new revision is saved, the earlier revision\'s "Simulation passed" is no longer shown', async () => {
    renderRouted(() => <DesignerEditor initial={fixtureVersion()} palette={PALETTE} personId={PERSON_ID} />);
    await userEvent.click(await screen.findByRole('tab', { name: 'Simulation' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Simulate saved revision 3' }));
    expect(await screen.findByText('Simulation passed')).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Simulation report' })).toBeTruthy();

    await saveRevision4();
    await userEvent.click(screen.getByRole('tab', { name: 'Simulation' }));
    expect(await screen.findByRole('button', { name: 'Simulate saved revision 4' })).toBeTruthy();
    expect(screen.queryByText('Simulation passed')).toBeNull();
    expect(screen.queryByRole('region', { name: 'Simulation report' })).toBeNull();
    expect(screen.queryByText(OTHER_CONTENT)).toBeNull(); // the author's own save leaves a clean panel, not a warning

    // Simulating the new revision shows its own report.
    await userEvent.click(screen.getByRole('button', { name: 'Simulate saved revision 4' }));
    expect(await screen.findByText('Simulation passed')).toBeTruthy();
    expect(screen.getByText(new RegExp(`of content ${serverHash.slice(0, 12)}`))).toBeTruthy();
  });

  it('[DI-04] an answer for revision 3 that arrives after revision 4 was saved is not shown as current', async () => {
    let release: () => void = () => undefined;
    simulateGate = new Promise<void>((r) => (release = r));
    renderRouted(() => <DesignerEditor initial={fixtureVersion()} palette={PALETTE} personId={PERSON_ID} />);
    await userEvent.click(await screen.findByRole('tab', { name: 'Simulation' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Simulate saved revision 3' }));
    expect(await screen.findByRole('button', { name: 'Simulating…' })).toBeTruthy();

    await saveRevision4();
    await userEvent.click(screen.getByRole('tab', { name: 'Simulation' }));
    // Revision 4 is simulated while revision 3's answer is still on its way.
    await userEvent.click(await screen.findByRole('button', { name: 'Simulate saved revision 4' }));
    expect(await screen.findByText(new RegExp(`of content ${serverHash.slice(0, 12)}`))).toBeTruthy();
    // The late answer (for revision 3's content) arrives: it neither replaces revision 4's report nor shows itself.
    release();
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.getByText('Simulation passed')).toBeTruthy();
    expect(screen.getByText(new RegExp(`of content ${serverHash.slice(0, 12)}`))).toBeTruthy();
    expect(screen.queryByText(OTHER_CONTENT)).toBeNull();
    expect(screen.getByRole('button', { name: 'Simulate saved revision 4' })).toBeTruthy();
  });

  it('[DI-04] an answer for revision 3 that arrives after revision 4 was saved, with nothing simulated since, shows nothing', async () => {
    let release: () => void = () => undefined;
    simulateGate = new Promise<void>((r) => (release = r));
    renderRouted(() => <DesignerEditor initial={fixtureVersion()} palette={PALETTE} personId={PERSON_ID} />);
    await userEvent.click(await screen.findByRole('tab', { name: 'Simulation' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Simulate saved revision 3' }));
    await saveRevision4();
    release();
    await userEvent.click(screen.getByRole('tab', { name: 'Simulation' }));
    await new Promise((r) => setTimeout(r, 50));
    expect(await screen.findByRole('button', { name: 'Simulate saved revision 4' })).toBeTruthy();
    expect(screen.queryByText('Simulation passed')).toBeNull();
    expect(screen.queryByRole('region', { name: 'Simulation report' })).toBeNull();
    expect(screen.queryByText(OTHER_CONTENT)).toBeNull();
  });

  it('[DI-04] a report the server made on other content than the saved revision on screen is shown as such, never as passed', async () => {
    serverHash = 'e'.repeat(64); // someone saved the version elsewhere since this screen loaded it
    renderRouted(() => <DesignerEditor initial={fixtureVersion()} palette={PALETTE} personId={PERSON_ID} />);
    await userEvent.click(await screen.findByRole('tab', { name: 'Simulation' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Simulate saved revision 3' }));
    expect(await screen.findByText(OTHER_CONTENT)).toBeTruthy();
    expect(screen.queryByText('Simulation passed')).toBeNull();
  });
});
