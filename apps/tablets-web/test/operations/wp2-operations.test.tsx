/**
 * The operations screens of slice 7g, work package 2 on test answers: the restore procedure (the steps in order, the
 * approver named never the operator, the approval through the ceremony offered only to a named approver, the completion),
 * the drills and the hardening check (decision D-P7R-4: a GMP installation shows the records and offers no upgrade drill),
 * the continuity alarms (acknowledged with a comment) and this installation's identity (the first-run set-up's next step).
 * The server tests prove the refusals; here the pages send what the person chose and show what came back.
 */
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import type { ContinuityAlarmView, DrillsView, Instant, RestoreEventView, RestoreView } from '@ebmr/api-contract';
import { apiState } from '../../src/api/client.ts';
import { ME, render7g } from './wp2-support.tsx';

afterEach(() => {
  cleanup();
  apiState.installation = undefined;
});

const at = (us: string): Instant => ({ us, text: `18-OCT-2026 10:${us.slice(-2)}:00 +05:30 (Asia/Kolkata)` });
const QA = '0b8f1c2a-9999-4c7d-8e9f-0a1b2c3d4e99';
const EVENT = '0b8f1c2a-eeee-4c7d-8e9f-0a1b2c3d4eee';
const HASH = 'ab'.repeat(32);

const event = (over: Partial<RestoreEventView> = {}): RestoreEventView => ({
  restoreEventId: EVENT, eventKind: 'FULL_RESTORE', backupId: 'nightly-1', backupTakenAt: at('1000000000000001'), restorePoint: null, performedAt: at('1000000000000002'),
  reason: 'disk failure', changeReference: 'INC-42', operatorPersonId: ME, operator: 'Ira Admin', approvers: [{ personId: QA, legalName: 'Divya Menon', approvedAt: null }],
  status: 'RECORDED', contentHash: HASH, discardedAnchorIds: ['7'], affectedChainKeys: ['batch:B-1'], anchorComparison: [{ anchorId: '7', status: 'DISCARDABLE', problems: [] }],
  recordedAt: at('1000000000000003'), completedAt: null, moves: [], ...over,
});
const restore = (over: Partial<RestoreView> = {}): RestoreView => ({
  configured: true, problem: null, incarnation: '7291:1:16384:24576', identifiersSecured: false, events: [], approverCandidates: [{ personId: QA, legalName: 'Divya Menon' }, { personId: ME, legalName: 'Ira Admin' }], ...over,
});

describe('the restore procedure (DI-45)', () => {
  it('[DI-45][DI-18] the administrator secures the identifiers, then records the restore naming an approver who is never themself', async () => {
    const ui = render7g('/operations/restore', {
      role: 'SYSTEM_ADMINISTRATOR',
      fixtures: { 'operations.restore': restore(), 'operations.secureIdentifiers': { moves: [{ sequenceKey: 'kernel.audit_event_id_seq', sourceKind: 'PG_SEQUENCE', valueBefore: '10', externalValue: '15', valueAfter: '1000015' }] }, 'operations.recordRestoreEvent': event() },
    });
    expect((await screen.findByTestId('restore-state')).textContent).toContain('Identifiers not secured');
    const secure = screen.getByTestId('restore-secure');
    await userEvent.type(within(secure).getByRole('textbox', { name: 'Reason (recorded)' }), 'restored from nightly');
    await userEvent.click(within(secure).getByRole('button', { name: 'Secure the identifiers' }));
    await waitFor(() => expect(ui.posts('/api/operations/restore/identifiers')).toHaveLength(1));
    expect(ui.posts('/api/operations/restore/identifiers')[0]?.body).toEqual({ reason: 'restored from nightly' });
    expect((await within(secure).findByText('1 identifier source(s) moved.')).textContent).toBeTruthy();

    const form = screen.getByTestId('restore-record');
    // The operator is never offered as an approver.
    expect(within(form).queryByRole('checkbox', { name: 'Ira Admin' })).toBeNull();
    await userEvent.selectOptions(within(form).getByLabelText('What was done'), 'FULL_RESTORE');
    await userEvent.type(within(form).getByRole('textbox', { name: 'Backup restored from' }), 'nightly-1');
    await userEvent.type(within(form).getByRole('textbox', { name: /When that backup was taken/ }), '2026-10-18T00:30:00Z');
    await userEvent.type(within(form).getByRole('textbox', { name: /When the restore or failover was performed/ }), '2026-10-18T06:00:00Z');
    await userEvent.type(within(form).getByRole('textbox', { name: 'Reason' }), 'disk failure');
    await userEvent.type(within(form).getByRole('textbox', { name: 'Incident or change record' }), 'INC-42');
    const button = within(form).getByRole('button', { name: 'Record the restore' });
    expect(button.hasAttribute('disabled')).toBe(true);
    await userEvent.click(within(form).getByRole('checkbox', { name: 'Divya Menon' }));
    await userEvent.click(button);
    await waitFor(() => expect(ui.posts('/api/operations/restore/events')).toHaveLength(1));
    expect(ui.posts('/api/operations/restore/events')[0]?.body).toEqual({
      eventKind: 'FULL_RESTORE', backupId: 'nightly-1', backupTakenAt: '2026-10-18T00:30:00Z', performedAt: '2026-10-18T06:00:00Z', reason: 'disk failure', changeReference: 'INC-42', approverPersonIds: [QA],
    });
  });

  it('[DI-45][DI-37] a named approver approves the restore through the ceremony (RESTORE_APPROVE); the operator is offered no approval; the administrator completes an approved restore', async () => {
    const qa = render7g('/operations/restore', { role: 'QA_REVIEWER', personId: QA, fixtures: { 'operations.restore': restore({ identifiersSecured: true, events: [event()] }) } });
    const row = await screen.findByTestId(`restore-event-${EVENT}`);
    expect(row.textContent).toContain('1 audit chain(s) lost history: batch:B-1');
    await userEvent.click(within(row).getByRole('button', { name: 'Approve this restore' }));
    await waitFor(() => expect(qa.ceremony.sign).toHaveBeenCalledTimes(1));
    expect(qa.ceremony.sign.mock.calls[0]?.[0]).toMatchObject({ action: { kind: 'RESTORE_APPROVE', restoreEventId: EVENT } });
    cleanup();

    const admin = render7g('/operations/restore', {
      role: 'SYSTEM_ADMINISTRATOR',
      fixtures: { 'operations.restore': restore({ identifiersSecured: true, events: [event({ status: 'APPROVED', approvers: [{ personId: QA, legalName: 'Divya Menon', approvedAt: at('1000000000000004') }] })] }), 'operations.completeRestore': { event: event({ status: 'COMPLETED' }), moves: [] } },
    });
    const approved = await screen.findByTestId(`restore-event-${EVENT}`);
    expect(within(approved).queryByRole('button', { name: 'Approve this restore' })).toBeNull();
    await userEvent.type(within(approved).getByRole('textbox', { name: 'Reason for completing (recorded)' }), 'approved; resume');
    await userEvent.click(within(approved).getByRole('button', { name: '4. Complete the restore' }));
    await waitFor(() => expect(admin.posts(`/api/operations/restore/events/${EVENT}/completion`)).toHaveLength(1));
  });

  it('[DI-45] a server without the external ledger says why and offers no step', async () => {
    render7g('/operations/restore', { role: 'SYSTEM_ADMINISTRATOR', fixtures: { 'operations.restore': restore({ configured: false, problem: 'No external continuity ledger is configured on this server (EBMR_NUMBER_LEDGER_FILE).' }) } });
    expect((await screen.findByText(/EBMR_NUMBER_LEDGER_FILE/)).textContent).toBeTruthy();
    const secure = screen.getByTestId('restore-secure');
    await userEvent.type(within(secure).getByRole('textbox', { name: 'Reason (recorded)' }), 'try it');
    expect(within(secure).getByRole('button', { name: 'Secure the identifiers' }).hasAttribute('disabled')).toBe(true);
  });
});

const drills = (over: Partial<DrillsView> = {}): DrillsView => ({
  installation: 'GMP',
  restore: { runnable: true, problem: null },
  upgrade: { runnable: false, problem: 'The upgrade drill runs on a sandbox or staging installation only (D-P7R-4).' },
  hardening: { runnable: true, problem: null },
  job: { state: 'IDLE', kind: null, step: null, error: null, elapsedSeconds: null },
  restoreDrills: [{ drillId: 'drill-20261018T040000Z-ab12cd', sourceDatabase: 'ebmr_gmp', restoredDatabase: 'ebmr_gmp_drill', backupSha256: HASH, result: 'PASS', failures: [], tablesCompared: '412', tablesMatching: '412', chainsVerified: '96', reportSha256: HASH, reportUri: 'file:///var/backups/drills/restore/x.json', startedAt: at('1000000000000010'), finishedAt: at('1000000000000011'), recordedAt: at('1000000000000012') }],
  upgradeDrills: [],
  requests: [],
  hardeningChecks: [],
  ...over,
});

describe('drills and the hardening check (decision 0025 point 3)', () => {
  it('[DI-45] D-P7R-4: on a GMP installation the page shows the drill records and offers no upgrade drill; a restore drill is run with a reason and the page follows its job', async () => {
    let started = false;
    const ui = render7g('/operations/drills', {
      role: 'SYSTEM_ADMINISTRATOR',
      fixtures: {
        'operations.drills': () => (started ? drills({ job: { state: 'RUNNING', kind: 'RESTORE', step: 'restoring', error: null, elapsedSeconds: '4' } }) : drills()),
        'operations.runRestoreDrill': () => {
          started = true;
          return { requestId: '0b8f1c2a-1234-4c7d-8e9f-0a1b2c3d4e55', job: { state: 'RUNNING', kind: 'RESTORE', step: 'starting', error: null, elapsedSeconds: '0' } };
        },
      },
    });
    const upgrade = await screen.findByTestId('drill-upgrade');
    expect(upgrade.textContent).toContain('The upgrade drill is not run on a GMP installation.');
    expect(within(upgrade).queryByRole('button', { name: 'Run an upgrade drill' })).toBeNull();
    const restoreSection = screen.getByTestId('drill-restore');
    expect(within(restoreSection).getByTestId('restore-drill-drill-20261018T040000Z-ab12cd').textContent).toContain('412 of 412 tables matching, 96 chains verified');
    await userEvent.type(within(restoreSection).getByRole('textbox', { name: 'Reason (recorded with the request)' }), 'quarterly test');
    await userEvent.click(within(restoreSection).getByRole('button', { name: 'Run a restore drill' }));
    await waitFor(() => expect(ui.posts('/api/operations/drills/restore')).toHaveLength(1));
    expect(ui.posts('/api/operations/drills/restore')[0]?.body).toEqual({ reason: 'quarterly test' });
    expect((await screen.findByTestId('drill-job')).getAttribute('data-state')).toBe('RUNNING');
  });

  it('[DI-45] on a sandbox the upgrade drill is run on a named database at an earlier release; the hardening check is run with the allowed ports and its checks shown', async () => {
    const ui = render7g('/operations/drills', {
      role: 'SYSTEM_ADMINISTRATOR',
      installation: 'SANDBOX',
      fixtures: {
        'operations.drills': drills({ installation: 'SANDBOX', upgrade: { runnable: true, problem: null }, hardeningChecks: [{ checkRunId: '0b8f1c2a-5678-4c7d-8e9f-0a1b2c3d4e66', result: 'FAIL', checks: [{ id: 'PG-TLS', area: 'POSTGRESQL', title: 'TLS on', status: 'FAIL', evidence: 'ssl=off' }], reportSha256: HASH, reason: 'after patch', by: 'Ira Admin', recordedAt: at('1000000000000020') }] }),
        'operations.runUpgradeDrill': { requestId: '0b8f1c2a-1234-4c7d-8e9f-0a1b2c3d4e56', job: { state: 'RUNNING', kind: 'UPGRADE', step: 'starting', error: null, elapsedSeconds: '0' } },
        'operations.runHardeningCheck': { checkRunId: '0b8f1c2a-5678-4c7d-8e9f-0a1b2c3d4e67', result: 'PASS', checks: [{ id: 'PORTS', area: 'PORTS', title: 'ports', status: 'PASS', evidence: 'none' }], reportSha256: HASH, reason: 'monthly', by: 'Ira Admin', recordedAt: at('1000000000000021') },
      },
    });
    const upgrade = await screen.findByTestId('drill-upgrade');
    await userEvent.type(within(upgrade).getByRole('textbox', { name: /Database at the earlier release/ }), 'ebmr_release_v09');
    await userEvent.type(within(upgrade).getByRole('textbox', { name: /The earlier release/ }), 'v0.9');
    await userEvent.type(within(upgrade).getByRole('textbox', { name: 'Reason (recorded with the request)' }), 'release check');
    await userEvent.click(within(upgrade).getByRole('button', { name: 'Run an upgrade drill' }));
    await waitFor(() => expect(ui.posts('/api/operations/drills/upgrade')).toHaveLength(1));
    expect(ui.posts('/api/operations/drills/upgrade')[0]?.body).toEqual({ reason: 'release check', sourceDatabase: 'ebmr_release_v09', fromRelease: 'v0.9' });

    const hardening = screen.getByTestId('drill-hardening');
    expect(within(hardening).getByTestId('hardening-0b8f1c2a-5678-4c7d-8e9f-0a1b2c3d4e66').textContent).toContain('ssl=off');
    await userEvent.type(within(hardening).getByRole('textbox', { name: 'Reason (recorded)' }), 'monthly');
    await userEvent.click(within(hardening).getByRole('button', { name: 'Run the hardening check' }));
    await waitFor(() => expect(ui.posts('/api/operations/hardening')).toHaveLength(1));
    expect(ui.posts('/api/operations/hardening')[0]?.body).toEqual({ reason: 'monthly', allowedPorts: ['443', '5432'] });
  });
});

describe('continuity alarms (DI-45)', () => {
  it('[DI-45] an open alarm is acknowledged with what was done; an acknowledged one shows who and when', async () => {
    const alarm = (id: string, ack: ContinuityAlarmView['acknowledgement']): ContinuityAlarmView => ({ alarmId: id, code: 'BACKUP_JOB_FAILED', severity: 'HIGH', subject: 'Backup job nightly failed', details: '{"job":"nightly"}', raisedAt: at('1000000000000030'), acknowledgement: ack });
    const OPEN = '0b8f1c2a-aaaa-4c7d-8e9f-0a1b2c3d4eaa';
    const ui = render7g('/operations/alarms', {
      role: 'PROCESS_OWNER',
      fixtures: {
        'operations.alarms': { alarms: [alarm(OPEN, null), alarm('0b8f1c2a-bbbb-4c7d-8e9f-0a1b2c3d4ebb', { by: 'Omar Owner', comment: 'cleared', at: at('1000000000000031') })] },
        'operations.acknowledgeAlarm': alarm(OPEN, { by: 'Omar Owner', comment: 'disk cleared', at: at('1000000000000032') }),
      },
    });
    const open = await screen.findByTestId(`alarm-${OPEN}`);
    expect(screen.getByTestId('alarms-acknowledged').textContent).toContain('Acknowledged by Omar Owner');
    const ack = within(open).getByRole('button', { name: 'Acknowledge' });
    expect(ack.hasAttribute('disabled')).toBe(true);
    await userEvent.type(within(open).getByRole('textbox', { name: 'What was done (BACKUP_JOB_FAILED)' }), 'disk cleared');
    await userEvent.click(ack);
    await waitFor(() => expect(ui.posts(`/api/operations/alarms/${OPEN}/acknowledgement`)).toHaveLength(1));
    expect(ui.posts(`/api/operations/alarms/${OPEN}/acknowledgement`)[0]?.body).toEqual({ comment: 'disk cleared' });
  });
});

describe('this installation\'s identity (the first-run set-up\'s next step)', () => {
  it('[DI-31] the administrator sets the identity from the server\'s key with the site and a reason; a sandbox has none', async () => {
    const ui = render7g('/operations/installation', {
      role: 'SYSTEM_ADMINISTRATOR',
      fixtures: {
        'transfers.peers': { installation: null, peers: [] },
        'transfers.setInstallationIdentity': { installationCode: 'PUNE-TAB-GMP', siteCode: 'SITE-1', edition: 'TABLETS', keyFingerprint: HASH, keyVersion: 1, serverHoldsKey: true },
      },
    });
    expect((await screen.findByTestId('installation-identity')).textContent).toContain('This installation has no identity yet.');
    const set = screen.getByTestId('installation-identity-set');
    const site = within(set).getByRole('textbox', { name: 'Site code' });
    await userEvent.clear(site);
    await userEvent.type(site, 'site-1');
    await userEvent.type(within(set).getByRole('textbox', { name: 'Reason (recorded)' }), 'first-run set-up');
    await userEvent.click(within(set).getByRole('button', { name: "Set this installation's identity" }));
    await waitFor(() => expect(ui.posts('/api/transfers/installation')).toHaveLength(1));
    expect(ui.posts('/api/transfers/installation')[0]?.body).toEqual({ siteCode: 'SITE-1', reason: 'first-run set-up' });
    cleanup();
    render7g('/operations/installation', { role: 'SYSTEM_ADMINISTRATOR', installation: 'SANDBOX' });
    expect((await screen.findByText(/has no installation identity/)).textContent).toBeTruthy();
  });
});
