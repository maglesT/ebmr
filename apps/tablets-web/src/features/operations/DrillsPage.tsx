/**
 * Drills and the hardening check (Phase 7 slice 7g, work package 2; decision 0025 point 3; DI-45, DI-46, DI-48, DI-13):
 * what ops/backup/drill.sh, the drill tool (`pnpm drills`) and `pnpm security:hardening` did, on a screen.
 *  - The restore drill: a backup restored into an isolated database and compared with the live one; recorded by the
 *    backup service identity with its report's hash; a failed drill raises an alarm.
 *  - The upgrade drill: a copy of a database at an earlier release upgraded with this release's migrations and compared.
 *    Decision D-P7R-4: on a sandbox or staging installation only; a GMP installation shows its records and offers no run.
 *  - The hardening check: the database settings, client authentication, roles, demo traces, the server configuration and
 *    the open ports, each with its evidence, recorded with the person and the reason.
 * A drill runs as a job; the page follows it. Who may run what is the database's to decide (CONTINUITY.BACKUP_RUN,
 * PLATFORM.OPERATE); the records are read with CONTINUITY.BACKUP_READ.
 */
import { useEffect, useState } from 'react';
import { routes, type DrillsView, type HardeningRunView } from '@ebmr/api-contract';
import { Banner, Field, StatusChip } from '@ebmr/ui-kit';
import { useApiQuery } from '../../api/hooks.ts';
import { ActButton, ActResult, Section, useCommand, useRefresh } from '../../app/acts.tsx';
import { RefusalMessage } from '../../app/refusal.tsx';
import { DRILL_READS, words } from './reads.ts';

const DATABASE = /^[a-z][a-z0-9_]{1,62}$/;
const PORT = /^[1-9][0-9]{0,4}$/;

export function DrillsPage() {
  const q = useApiQuery(routes.operations.drills);
  const v = q.data;
  const reread = useRefresh(DRILL_READS);
  const running = v?.job.state === 'RUNNING';
  // Follow a running job (the records come with it once it ends).
  useEffect(() => {
    if (!running) return undefined;
    const t = setInterval(() => void reread(), 2000);
    return () => clearInterval(t);
  }, [running, reread]);
  return (
    <>
      <h1>Drills and the hardening check</h1>
      <p>
        A restore drill proves that a backup can be restored and that the restored records, audit trails and signatures are the ones kept. An upgrade drill proves that a database at an
        earlier release upgrades without changing a record. The hardening check verifies the installation&apos;s security settings. Every run is recorded.
      </p>
      {q.error ? <RefusalMessage error={q.error.error} /> : null}
      {v ? <Job v={v} /> : null}
      {v ? <RestoreDrill v={v} /> : null}
      {v ? <UpgradeDrill v={v} /> : null}
      {v ? <Hardening v={v} /> : null}
    </>
  );
}

function Job({ v }: { v: DrillsView }) {
  const j = v.job;
  if (j.state === 'IDLE') return null;
  return (
    <p data-testid="drill-job" data-state={j.state}>
      {j.kind ? words(j.kind) : ''} drill:{' '}
      <StatusChip tone={j.state === 'RUNNING' ? 'pending' : j.state === 'DONE' ? 'ok' : 'error'} label={words(j.state)} /> {j.step ?? ''}
      {j.elapsedSeconds ? ` (${j.elapsedSeconds} s)` : ''}
      {j.error ? `: ${j.error}` : ''}
    </p>
  );
}

function RestoreDrill({ v }: { v: DrillsView }) {
  const run = useCommand(routes.operations.runRestoreDrill, DRILL_READS);
  const [reason, setReason] = useState('');
  return (
    <Section title="Restore drill" testId="drill-restore">
      {v.restore.runnable ? (
        <>
          <Field name="restore-drill-reason" label="Reason (recorded with the request)" value={reason} onChange={setReason} />
          <ActButton label="Run a restore drill" disabled={reason.trim().length < 3 || run.busy || v.job.state === 'RUNNING'} onPress={() => run.run({ body: { reason: reason.trim() } })} />
          <ActResult error={run.error} done={run.done} label="The restore drill has started." />
        </>
      ) : (
        <Banner tone="info" title="This server does not run a restore drill from the screen.">
          <p>{v.restore.problem}</p>
        </Banner>
      )}
      {v.restoreDrills.length === 0 ? <p>No restore drill is recorded.</p> : null}
      <ul>
        {v.restoreDrills.map((d) => (
          <li key={d.drillId} data-testid={`restore-drill-${d.drillId}`} data-result={d.result}>
            <StatusChip tone={d.result === 'PASS' ? 'ok' : 'error'} label={d.result} /> {d.drillId}: {d.sourceDatabase} restored into {d.restoredDatabase}, {d.tablesMatching} of{' '}
            {d.tablesCompared} tables matching, {d.chainsVerified} chains verified, {d.startedAt.text} to {d.finishedAt.text}. Report <code>{d.reportSha256.slice(0, 16)}…</code>
            {d.failures.length > 0 ? `: ${d.failures.join('; ')}` : ''}
          </li>
        ))}
      </ul>
    </Section>
  );
}

function UpgradeDrill({ v }: { v: DrillsView }) {
  const run = useCommand(routes.operations.runUpgradeDrill, DRILL_READS);
  const [reason, setReason] = useState('');
  const [source, setSource] = useState('');
  const [release, setRelease] = useState('');
  const ok = reason.trim().length >= 3 && DATABASE.test(source.trim()) && release.trim() !== '';
  return (
    <Section title="Upgrade drill" testId="drill-upgrade">
      {v.upgrade.runnable ? (
        <>
          <Field name="upgrade-source" label="Database at the earlier release (copied, never changed)" value={source} onChange={setSource} />
          <Field name="upgrade-release" label="The earlier release (e.g. v0.9 at the Phase 6A exit)" value={release} onChange={setRelease} />
          <Field name="upgrade-reason" label="Reason (recorded with the request)" value={reason} onChange={setReason} />
          <ActButton
            label="Run an upgrade drill"
            disabled={!ok || run.busy || v.job.state === 'RUNNING'}
            onPress={() => run.run({ body: { reason: reason.trim(), sourceDatabase: source.trim(), fromRelease: release.trim() } })}
          />
          <ActResult error={run.error} done={run.done} label="The upgrade drill has started." />
        </>
      ) : (
        <Banner tone="info" title={v.installation === 'GMP' ? 'The upgrade drill is not run on a GMP installation.' : 'This server does not run an upgrade drill from the screen.'}>
          <p>{v.upgrade.problem}</p>
        </Banner>
      )}
      {v.upgradeDrills.length === 0 ? <p>No upgrade drill is recorded.</p> : null}
      <ul>
        {v.upgradeDrills.map((d) => (
          <li key={d.drillId} data-testid={`upgrade-drill-${d.drillId}`} data-result={d.result}>
            <StatusChip tone={d.result === 'PASS' ? 'ok' : 'error'} label={d.result} /> {d.drillId}: {d.sourceDatabase} from {d.fromRelease}, {d.migrationsApplied} migrations applied,{' '}
            {d.tablesChanged} of {d.tablesCompared} tables changed, {d.chainsVerified} chains verified, recorded {d.recordedAt.text}. Report <code>{d.reportSha256.slice(0, 16)}…</code>
            {d.failures.length > 0 ? `: ${d.failures.join('; ')}` : ''}
          </li>
        ))}
      </ul>
      {v.requests.length > 0 ? (
        <>
          <h3>Requests</h3>
          <ul>
            {v.requests.map((r) => (
              <li key={r.requestId}>
                {r.recordedAt.text}: {words(r.kind)} drill{r.sourceDatabase ? ` of ${r.sourceDatabase}` : ''} by {r.by}: {r.reason}
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </Section>
  );
}

function Hardening({ v }: { v: DrillsView }) {
  const run = useCommand(routes.operations.runHardeningCheck, DRILL_READS);
  const [reason, setReason] = useState('');
  const [ports, setPorts] = useState('443, 5432');
  const list = ports.split(',').map((p) => p.trim()).filter((p) => p !== '');
  const ok = reason.trim().length >= 3 && list.every((p) => PORT.test(p));
  return (
    <Section title="Installation hardening check" testId="drill-hardening">
      {v.hardening.runnable ? (
        <>
          <Field name="hardening-ports" label="Ports that may listen off loopback (comma separated)" value={ports} onChange={setPorts} />
          <Field name="hardening-reason" label="Reason (recorded)" value={reason} onChange={setReason} />
          <ActButton label="Run the hardening check" disabled={!ok || run.busy} onPress={() => run.run({ body: { reason: reason.trim(), allowedPorts: list } })} />
          <ActResult error={run.error} done={run.done} label={run.done ? `Hardening check: ${run.done.result}.` : 'Done.'} />
        </>
      ) : (
        <Banner tone="info" title="This server does not run the hardening check.">
          <p>{v.hardening.problem}</p>
        </Banner>
      )}
      {v.hardeningChecks.length === 0 ? <p>No hardening check is recorded.</p> : null}
      {v.hardeningChecks.map((h) => (
        <HardeningRun key={h.checkRunId} h={h} />
      ))}
    </Section>
  );
}

function HardeningRun({ h }: { h: HardeningRunView }) {
  return (
    <details data-testid={`hardening-${h.checkRunId}`} data-result={h.result}>
      <summary style={{ minHeight: '2.75rem', paddingBlock: '0.65rem', cursor: 'pointer' }}>
        <StatusChip tone={h.result === 'PASS' ? 'ok' : 'error'} label={h.result} /> {h.recordedAt.text} by {h.by}: {h.reason}
      </summary>
      <table>
        <thead>
          <tr>
            <th scope="col">Check</th>
            <th scope="col">What it proves</th>
            <th scope="col">Result</th>
            <th scope="col">Evidence</th>
          </tr>
        </thead>
        <tbody>
          {h.checks.map((c) => (
            <tr key={c.id}>
              <th scope="row">{c.id}</th>
              <td>{c.title}</td>
              <td>{words(c.status)}</td>
              <td>{c.evidence}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </details>
  );
}
