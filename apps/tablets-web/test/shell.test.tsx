/**
 * The shell (plan sections 5 and 12): the sandbox shows the TEST, NOT GMP band on every screen, including the
 * screens before sign-in; a browser without a terminal key sees the demo picker on a demo installation.
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { setTransport } from '../src/api/client.ts';
import { createFixtureFetch } from '../src/api/fixture-fetch.ts';
import { fixturesFromExamples } from '../src/api/examples.ts';
import { App } from '../src/app/App.tsx';

describe('shell', () => {
  it('[DI-05] the sandbox shows TEST, NOT GMP before sign-in, and a browser without a terminal key gets the demo picker', async () => {
    setTransport(createFixtureFetch({ ...fixturesFromExamples('SANDBOX'), 'session.demoDevices': { devices: [] } }, { installation: 'SANDBOX' }));
    render(<App />);
    expect(await screen.findByRole('note', { name: 'TEST, NOT GMP' })).toBeTruthy();
    expect(await screen.findByRole('heading', { name: 'Demo: choose the terminal this browser is' })).toBeTruthy();
  });

  it('[DI-05] GMP shows no watermark', async () => {
    setTransport(createFixtureFetch({ ...fixturesFromExamples('GMP'), 'session.demoDevices': { devices: [] } }, { installation: 'GMP' }));
    render(<App />);
    expect(await screen.findByRole('heading', { name: 'Demo: choose the terminal this browser is' })).toBeTruthy();
    expect(screen.queryByRole('note', { name: 'TEST, NOT GMP' })).toBeNull();
  });
});
