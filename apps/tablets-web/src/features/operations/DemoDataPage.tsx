/**
 * Demo and test data (Phase 7 slice 7g-4; decision 0025 point 2): on a sandbox or a demo installation the system
 * administrator loads the demo data (the personas and terminals, every feature's seed and, on a GMP demo installation,
 * the review batch and the packaging order) or resets the installation to a clean state that awaits its first-run
 * set-up. Both recreate the database: the page names what is lost and the person types the database's name to confirm.
 * A GMP installation that is not a demo one refuses both, in the database (EBMR-OPS-010). While the job runs nobody is
 * signed in (the sessions go with the database); the page follows the job and then starts again.
 */
import { useEffect, useState } from 'react';
import { routes } from '@ebmr/api-contract';
import { Banner, Field, StatusChip } from '@ebmr/ui-kit';
import { useApiQuery } from '../../api/hooks.ts';
import { ActButton, Section, useCommand } from '../../app/acts.tsx';
import { followingRecreation } from '../../app/maintenance.ts';
import { RefusalMessage } from '../../app/refusal.tsx';
import { DEMO_READS } from './reads.ts';

/** Starts the page again (a new installation: the device picker or the first-run set-up). */
export const reloadApp = { now: (): void => window.location.assign('/') };

function JobPanel({ token }: { token: string | null }) {
  // Asked every second until the job has ended: an answer lost meanwhile (the server is recreating the database) is
  // asked again, never taken for the end.
  const job = useApiQuery(routes.operations.demoJob, {}, {
    refetchInterval: (q) => (q.state.data?.state === 'DONE' || q.state.data?.state === 'FAILED' ? false : 1000),
  });
  useEffect(() => {
    followingRecreation.active = true;
    return () => {
      followingRecreation.active = false;
    };
  }, []);
  const j = job.data;
  return (
    <Section title="The installation is being recreated" testId="demo-job">
      {token ? (
        <Banner tone="info" title="The set-up token of the clean installation (shown once)">
          <p>
            Copy it now: the first-run set-up asks for it. <code data-testid="setup-token">{token}</code>
          </p>
        </Banner>
      ) : null}
      {j ? (
        <p data-testid="demo-job-state" data-state={j.state}>
          <StatusChip tone={j.state === 'DONE' ? 'ok' : j.state === 'FAILED' ? 'error' : 'pending'} label={j.state === 'RUNNING' ? 'Running' : j.state === 'DONE' ? 'Done' : j.state === 'FAILED' ? 'Failed' : 'Idle'} />{' '}
          {j.step ?? ''}
          {j.elapsedSeconds ? ` (${j.elapsedSeconds} s)` : ''}
        </p>
      ) : null}
      {j?.state === 'FAILED' ? <Banner tone="error" title="The job failed."><p>{j.error}</p></Banner> : null}
      {j?.state === 'DONE' || j?.state === 'FAILED' ? <ActButton label="Start the application again" onPress={() => reloadApp.now()} /> : null}
    </Section>
  );
}

export function DemoDataPage() {
  const view = useApiQuery(routes.operations.demo);
  const load = useCommand(routes.operations.demoLoad, DEMO_READS);
  const reset = useCommand(routes.operations.demoReset, DEMO_READS);
  const [reason, setReason] = useState('');
  const [confirm, setConfirm] = useState('');
  const [reviewBatch, setReviewBatch] = useState(false);
  const [packaging, setPackaging] = useState(false);
  const [started, setStarted] = useState<{ token: string | null } | null>(null);
  const v = view.data;
  if (started || v?.job.state === 'RUNNING') return (
    <>
      <h1>Demo and test data</h1>
      <JobPanel token={started?.token ?? null} />
    </>
  );
  const ready = v?.allowed === true && reason.trim().length >= 3 && confirm === v.database && !load.busy && !reset.busy;
  const body = { reason: reason.trim(), confirmDatabase: confirm };
  return (
    <>
      <h1>Demo and test data</h1>
      {view.error ? <RefusalMessage error={view.error.error} /> : null}
      {v && !v.allowed ? (
        <Banner tone="warning" title="Demo data and resets are refused here.">
          <p data-testid="demo-refusal">{v.refusal}</p>
        </Banner>
      ) : null}
      {v ? (
        <Section title="What is lost" testId="demo-contents">
          <p>
            Loading the demo data or resetting recreates the database <code>{v.database}</code> ({v.installation === 'SANDBOX' ? 'sandbox' : 'GMP'}
            {v.demo ? ', a demo installation' : ''}). Everything in it is lost: {v.contents.persons} persons, {v.contents.accounts} accounts, {v.contents.devices} terminals and
            devices, {v.contents.batches} batches, {v.contents.signatures} signatures and {v.contents.auditEntries} audit-trail entries, and every session (everyone is signed out).
          </p>
        </Section>
      ) : null}
      {v?.allowed ? (
        <Section title="Confirm" testId="demo-confirm">
          <Field name="demo-reason" label="Reason (recorded)" value={reason} onChange={setReason} />
          <Field name="demo-confirm" label={`Type the database name ${v.database} to confirm`} value={confirm} onChange={setConfirm} />
          {v.reviewBatchAllowed ? (
            <fieldset>
              <legend>Also build (GMP demo installation)</legend>
              <label>
                <input type="checkbox" checked={reviewBatch} onChange={(e) => setReviewBatch(e.target.checked)} /> a GB-T-01 batch record ready for review
              </label>
              <br />
              <label>
                <input type="checkbox" checked={packaging} onChange={(e) => setPackaging(e.target.checked)} /> the packaging-order demo (with the review batch)
              </label>
            </fieldset>
          ) : null}
          <p>
            <ActButton
              label="Load the demo data"
              disabled={!ready}
              onPress={async () => {
                const r = await load.run({ body: { ...body, reviewBatch: reviewBatch || packaging, packaging } });
                if (r) setStarted({ token: null });
              }}
            />{' '}
            <ActButton
              label="Reset to a clean state"
              primary={false}
              disabled={!ready}
              onPress={async () => {
                const r = await reset.run({ body });
                if (r) setStarted({ token: r.setupToken });
              }}
            />
          </p>
          {load.error ? <RefusalMessage error={load.error} /> : null}
          {reset.error ? <RefusalMessage error={reset.error} /> : null}
        </Section>
      ) : null}
    </>
  );
}
