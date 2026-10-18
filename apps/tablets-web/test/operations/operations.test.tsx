/**
 * The operations screens (Phase 7 slice 7g-4; decision 0025 point 2) on test answers: demo and test data (what is lost,
 * the typed confirmation, the job and the reset's set-up token; the GMP refusal shown in the database's words), the
 * backups (the catalogue with size, time and hash; a backup taken with a reason; a copy saved as stored), the
 * background workers (start and stop with a reason; an adapter refused on its transport names EBMR-INT-034), the
 * simulators' test console (start, a fault switched on) and the API reference (the routes of the OpenAPI document).
 */
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import type { BackupsView, DemoJobView, DemoView, SimulatorView, WorkersView } from '@ebmr/api-contract';
import { apiState } from '../../src/api/client.ts';
import { at, refusalAnswer, renderOperations } from './support.tsx';

afterEach(() => {
  cleanup();
  apiState.installation = undefined;
});

const job = (state: DemoJobView['state'], kind: DemoJobView['kind'] = null, step: string | null = null): DemoJobView => ({ state, kind, step, error: null, elapsedSeconds: state === 'IDLE' ? null : '3' });
const demo = (over: Partial<DemoView> = {}): DemoView => ({
  allowed: true, refusal: null, installation: 'SANDBOX', demo: true, database: 'ebmr_sandbox_tablets_demo', reviewBatchAllowed: false,
  contents: { persons: '27', accounts: '30', devices: '19', batches: '4', signatures: '58', auditEntries: '12034' }, job: job('IDLE'), ...over,
});

describe('demo and test data (decision 0025)', () => {
  it('[DI-05] the page names what a load or a reset loses; nothing is sent until the reason is given and the database name typed', async () => {
    const ui = renderOperations('/operations/demo', { installation: 'SANDBOX', fixtures: { 'operations.demo': demo() } });
    const contents = await screen.findByTestId('demo-contents');
    expect(contents.textContent).toContain('27 persons, 30 accounts, 19 terminals and devices, 4 batches, 58 signatures and 12034 audit-trail entries');
    const reset = screen.getByRole('button', { name: 'Reset to a clean state' });
    expect(reset.hasAttribute('disabled')).toBe(true);
    await userEvent.type(screen.getByRole('textbox', { name: 'Reason (recorded)' }), 'fresh start');
    await userEvent.type(screen.getByRole('textbox', { name: /Type the database name/ }), 'ebmr_sandbox_tablets_dem');
    expect(reset.hasAttribute('disabled')).toBe(true);
    await userEvent.type(screen.getByRole('textbox', { name: /Type the database name/ }), 'o');
    expect(reset.hasAttribute('disabled')).toBe(false);
    expect(ui.posts('/api/operations/demo/reset')).toHaveLength(0);
  });

  it('[DI-05] a reset shows the set-up token of the clean installation once and follows the job until it is done', async () => {
    let calls = 0;
    const ui = renderOperations('/operations/demo', {
      installation: 'SANDBOX',
      fixtures: {
        'operations.demo': demo(),
        'operations.demoReset': { job: job('RUNNING', 'RESET', 'starting'), setupToken: 'T'.repeat(43) },
        'operations.demoJob': () => (++calls < 2 ? job('RUNNING', 'RESET', 'provisioning sandbox') : job('DONE', 'RESET', 'done')),
      },
    });
    await screen.findByTestId('demo-contents');
    await userEvent.type(screen.getByRole('textbox', { name: 'Reason (recorded)' }), 'fresh start');
    await userEvent.type(screen.getByRole('textbox', { name: /Type the database name/ }), 'ebmr_sandbox_tablets_demo');
    await userEvent.click(screen.getByRole('button', { name: 'Reset to a clean state' }));
    expect((await screen.findByTestId('setup-token')).textContent).toBe('T'.repeat(43));
    expect(ui.posts('/api/operations/demo/reset')[0]?.body).toEqual({ reason: 'fresh start', confirmDatabase: 'ebmr_sandbox_tablets_demo' });
    await waitFor(() => expect(screen.getByTestId('demo-job-state').getAttribute('data-state')).toBe('DONE'), { timeout: 5000 });
    expect(screen.getByRole('button', { name: 'Start the application again' })).toBeTruthy();
  });

  it('[DI-05] on a GMP installation that is not a demo one the page shows the database\'s refusal and offers no act; a GMP demo installation offers the review batch', async () => {
    renderOperations('/operations/demo', { fixtures: { 'operations.demo': demo({ allowed: false, installation: 'GMP', demo: false, database: 'ebmr_tablets', refusal: 'EBMR-OPS-010 ebmr_tablets is a GMP installation, not a demo one' }) } });
    expect((await screen.findByTestId('demo-refusal')).textContent).toMatch(/^EBMR-OPS-010/);
    expect(screen.queryByRole('button', { name: 'Load the demo data' })).toBeNull();
    cleanup();
    const ui = renderOperations('/operations/demo', { fixtures: { 'operations.demo': demo({ installation: 'GMP', database: 'ebmr_tablets_demo', reviewBatchAllowed: true }), 'operations.demoLoad': { job: job('RUNNING', 'LOAD') }, 'operations.demoJob': job('RUNNING', 'LOAD', 'seeding feature planning') } });
    await screen.findByTestId('demo-contents');
    await userEvent.click(screen.getByRole('checkbox', { name: /batch record ready for review/ }));
    await userEvent.type(screen.getByRole('textbox', { name: 'Reason (recorded)' }), 'demo for the QA team');
    await userEvent.type(screen.getByRole('textbox', { name: /Type the database name/ }), 'ebmr_tablets_demo');
    await userEvent.click(screen.getByRole('button', { name: 'Load the demo data' }));
    await waitFor(() => expect(ui.posts('/api/operations/demo/load')).toHaveLength(1));
    expect(ui.posts('/api/operations/demo/load')[0]?.body).toEqual({ reason: 'demo for the QA team', confirmDatabase: 'ebmr_tablets_demo', reviewBatch: true, packaging: false });
    expect((await screen.findByTestId('demo-job-state')).textContent).toContain('seeding feature planning');
  });
});

const backups: BackupsView = {
  configured: true,
  problem: null,
  backups: [{
    backupId: 'ebmr_tablets_demo-20261018T050000Z-ab12cd', tier: 'OPERATIONAL', method: 'PG_DUMP_CUSTOM', databaseName: 'ebmr_tablets_demo', sha256: 'a'.repeat(64), sizeBytes: '3145728',
    storageUri: 'file:///var/lib/ebmr/backups/x.dump.enc', immutableUntil: null, encryptionKeyRef: 'kms:ebmr/backup', toolVersion: 'pg_dump (PostgreSQL) 16.4', snapshotTakenAt: at('1792300000000000'), recordedAt: at('1792300000000010'), downloadable: true,
  }],
  runs: [{ jobRunId: '9b2c4d6e-1f3a-4b5c-8d7e-0a1b2c3d4e5f', jobName: 'request-1', tier: 'OPERATIONAL', status: 'FAILED', backupId: null, error: 'pg_dump failed (exit 1)', startedAt: at('1792200000000000'), finishedAt: at('1792200000000005') }],
  requests: [],
};

describe('backups (DI-45)', () => {
  it('[DI-45] the catalogue shows each backup with its size, time and hash, and the failed job with its error; a backup is taken with a reason', async () => {
    const ui = renderOperations('/operations/backups', {
      fixtures: { 'operations.backups': backups, 'operations.runBackup': { requestId: '1b2c4d6e-1f3a-4b5c-8d7e-0a1b2c3d4e5f', run: { ...backups.runs[0]!, status: 'SUCCEEDED', backupId: 'b-2', error: null }, error: null } },
    });
    const row = await screen.findByTestId(`backup-${backups.backups[0]!.backupId}`);
    expect(row.textContent).toContain('3.0 MiB (3145728 bytes)');
    expect(row.textContent).toContain(backups.backups[0]!.recordedAt.text);
    expect(screen.getByTestId(`backup-hash-${backups.backups[0]!.backupId}`).textContent).toBe('a'.repeat(64));
    expect(screen.getByTestId('backup-runs').textContent).toContain('pg_dump failed (exit 1)');
    await userEvent.type(screen.getByRole('textbox', { name: 'Reason (recorded with the request)' }), 'before the upgrade');
    await userEvent.click(screen.getByRole('button', { name: 'Take a backup now' }));
    await waitFor(() => expect(ui.posts('/api/operations/backups')[0]?.body).toEqual({ reason: 'before the upgrade', tier: 'OPERATIONAL' }));
    expect(await screen.findByText('Backup b-2 taken.')).toBeTruthy();
  });

  it('[DI-45] a copy of a stored backup is offered to save once the server hands it over; a refusal is shown in its words', async () => {
    renderOperations('/operations/backups', {
      fixtures: { 'operations.backups': backups, 'operations.backupFile': { backupId: backups.backups[0]!.backupId, fileName: 'x.dump.enc', sizeBytes: '4', sha256: 'a'.repeat(64), contentBase64: 'RUJNUg==', manifest: '{}' } },
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Take a copy' }));
    const link = await screen.findByTestId(`backup-download-${backups.backups[0]!.backupId}`);
    expect(link.getAttribute('href')).toBe('data:application/octet-stream;base64,RUJNUg==');
    expect(link.getAttribute('download')).toBe('x.dump.enc');
    cleanup();
    renderOperations('/operations/backups', { fixtures: { 'operations.backups': { ...backups, configured: false, problem: 'No backup directory is configured on this server (EBMR_BACKUP_DIR).' } } });
    expect((await screen.findByText('No backup directory is configured on this server (EBMR_BACKUP_DIR).')).textContent).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Take a backup now' }).hasAttribute('disabled')).toBe(true);
  });
});

const workers: WorkersView = {
  workers: [
    { kind: 'ADAPTER', code: 'LMS-MAIN', sourceSystem: 'LMS', running: true, state: 'IDLE', problem: null },
    { kind: 'ADAPTER', code: 'QMS-MAIN', sourceSystem: 'QMS', running: false, state: 'STOPPED', problem: 'EBMR-INT-034 the adapter base URL http://qms.example.com/qms/v1 is off loopback without mutual TLS' },
    { kind: 'ANALYTICS', code: 'ANALYTICS', sourceSystem: null, running: true, state: 'RUNNING', problem: null },
  ],
  acts: [{ act: 'ADAPTER_START', target: 'QMS-MAIN', outcome: 'REFUSED', detail: 'EBMR-INT-034 off loopback', reason: 'start it', by: 'Kavya Iyer', at: at('1792300000000020') }],
};

describe('background workers (decision 0025)', () => {
  it('[DI-31] each worker shows its state and why it does not run; a stop is sent with the reason; a refused start shows the refusal', async () => {
    const ui = renderOperations('/operations/workers', {
      fixtures: {
        'operations.workers': workers,
        'operations.controlWorker': ({ params }: { params: Record<string, string> }) =>
          params['code'] === 'QMS-MAIN' ? refusalAnswer(409, 'WORKER_REFUSED', 'The worker QMS-MAIN was not started. The refusal is recorded.', 'EBMR-INT-034 the adapter base URL is off loopback without mutual TLS') : { ...workers.workers[0]!, running: false, state: 'STOPPED' },
      },
    });
    expect((await screen.findByTestId('worker-problem-QMS-MAIN')).textContent).toMatch(/^EBMR-INT-034/);
    const stop = screen.getByRole('button', { name: 'Stop LMS-MAIN' });
    expect(stop.hasAttribute('disabled')).toBe(true);
    await userEvent.type(screen.getByRole('textbox', { name: /Reason/ }), 'LMS maintenance');
    await userEvent.click(stop);
    await waitFor(() => expect(ui.posts('/api/operations/workers/LMS-MAIN')[0]?.body).toEqual({ action: 'STOP', reason: 'LMS maintenance' }));
    await userEvent.click(screen.getByRole('button', { name: 'Start QMS-MAIN' }));
    const row = screen.getByTestId('worker-QMS-MAIN');
    expect((await within(row).findByText('The worker QMS-MAIN was not started. The refusal is recorded.'))).toBeTruthy();
    expect(screen.getByTestId('worker-acts').textContent).toContain('Adapter start QMS-MAIN by Kavya Iyer (start it): refused, EBMR-INT-034 off loopback');
  });

  it('[DI-31] the integration health page carries the workers panel', async () => {
    renderOperations('/integrations', { fixtures: { 'operations.workers': workers } });
    expect(await screen.findByTestId('worker-LMS-MAIN')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Restart ANALYTICS' })).toBeTruthy();
  });
});

const sim = (over: Partial<SimulatorView> = {}): SimulatorView => ({ code: 'QMS', title: 'QMS', running: false, url: null, endpoint: null, faults: [], available: ['FEED_GAP', 'STALE_VALUE'], problem: null, ...over });

describe('the simulators\' test console (decision 0025)', () => {
  it('[DI-05] a simulator is started and a fault switched on with the reason; on a GMP installation the refusal is shown and nothing is offered', async () => {
    const running = sim({ running: true, url: 'http://127.0.0.1:41000', endpoint: 'http://127.0.0.1:41000/qms/v1' });
    const ui = renderOperations('/operations/simulators', {
      installation: 'SANDBOX',
      fixtures: {
        'operations.simulators': { allowed: true, refusal: null, simulators: [running, sim({ code: 'LMS', title: 'LMS (training)' })] },
        'operations.simulatorFault': { ...running, faults: ['STALE_VALUE'] },
        'operations.controlSimulator': { ...sim({ code: 'LMS', title: 'LMS (training)' }), running: true },
      },
    });
    expect((await screen.findByTestId('simulator-endpoint-QMS')).textContent).toBe('http://127.0.0.1:41000/qms/v1');
    await userEvent.click(screen.getByRole('button', { name: 'Switch on Stale value' }));
    await waitFor(() => expect(ui.posts('/api/operations/simulators/QMS/faults')[0]?.body).toEqual({ fault: 'STALE_VALUE', on: true, reason: 'test console' }));
    await userEvent.type(screen.getByRole('textbox', { name: /Reason/ }), 'show the LMS feed');
    await userEvent.click(screen.getByRole('button', { name: 'Start the LMS simulator' }));
    await waitFor(() => expect(ui.posts('/api/operations/simulators/LMS')[0]?.body).toEqual({ action: 'START', reason: 'show the LMS feed' }));
    cleanup();
    renderOperations('/operations/simulators', { fixtures: { 'operations.simulators': { allowed: false, refusal: 'EBMR-OPS-010 ebmr_tablets is a GMP installation, not a demo one', simulators: [] } } });
    expect((await screen.findByText(/^EBMR-OPS-010/)).textContent).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Start the/ })).toBeNull();
  });
});

describe('the API reference (decision 0025)', () => {
  it('lists the routes of the OpenAPI document by namespace, filters them, and opens a route\'s schemas on demand', async () => {
    const doc = {
      openapi: '3.0.3', info: { title: 'eBMR', version: '1.0.0' },
      paths: {
        '/api/operations/backups': { get: { summary: 'The backup catalogue', description: 'operations.backups · auth SESSION', tags: ['operations'] }, post: { summary: 'A backup now', description: 'operations.runBackup', tags: ['operations'] } },
        '/api/meta': { get: { summary: 'Installation kind', description: 'meta.get · auth NONE', tags: ['meta'] } },
      },
    };
    renderOperations('/developer/api', { fixtures: { 'meta.openapi': doc } });
    expect((await screen.findByTestId('api-count')).textContent).toBe('3 of 3 routes');
    expect(screen.getByTestId('api-tag-operations')).toBeTruthy();
    await userEvent.type(screen.getByRole('searchbox', { name: 'Find a route' }), 'backup');
    expect(screen.getByTestId('api-count').textContent).toBe('2 of 3 routes');
    expect(screen.queryByTestId('api-tag-meta')).toBeNull();
    const item = screen.getByTestId('api-POST-/api/operations/backups');
    expect(item.textContent).toContain('A backup now');
  });
});
