/**
 * The operations console (Phase 7 slice 7g-4): what used to be a command in a terminal, each on its page. Which of them
 * a person may use is the database's to decide (the system administrator's PLATFORM.OPERATE and CONTINUITY.BACKUP_RUN;
 * the demo conveniences only on a sandbox or a demo installation); every page shows the refusal it gets.
 */
import { Link } from '@tanstack/react-router';
import { StatusChip } from '@ebmr/ui-kit';
import { routes } from '@ebmr/api-contract';
import { useApiQuery } from '../../api/hooks.ts';
import { RefusalMessage } from '../../app/refusal.tsx';
import { installationLabel, isSandbox } from '../../app/installation.ts';
import { Section } from '../../app/acts.tsx';
import { useScreensOff } from '../../app/disconnected.tsx';

export function OperationsPage() {
  const off = useScreensOff();
  const meta = useApiQuery(routes.meta.get, {}, { staleTime: 60_000 }).data;
  const demoOrSandbox = isSandbox(meta?.installation) || meta?.demo === true;
  return (
    <>
      <h1>Operations</h1>
      <p>
        This installation is <StatusChip tone={isSandbox(meta?.installation) ? 'test' : 'info'} label={installationLabel(meta?.installation)} />
        {meta?.demo ? <> and a <StatusChip tone="warning" label="demo installation" /></> : null}. Each operation is recorded with the person who did it and the reason given.
      </p>
      <Section title="Every installation" testId="operations-common">
        <ul>
          <li>
            <Link to="/operations/backups">Backups</Link>: take a backup now, see every backup with its size, time and hash, and take a copy of one.
          </li>
          <li>
            <Link to="/operations/workers">Background workers</Link>: start, stop or restart the integration adapters and the analytics runner.
          </li>
          <li>
            <Link to="/operations/drills">Drills and the hardening check</Link>: run a restore drill (and on a sandbox an upgrade drill) and the installation hardening check, and
            see their records.
          </li>
          <li>
            <Link to="/operations/restore">Restore procedure</Link>: after a restore, a copy or a failover, secure the identifiers, record the restore, have it approved and complete it.
          </li>
          <li>
            <Link to="/operations/alarms">Continuity alarms</Link>: failed backups, drills and checks, broken audit chains; acknowledge each.
          </li>
          <li>
            <Link to="/operations/installation">This installation&apos;s identity</Link>: the first-run set-up&apos;s next step, its code and key.
          </li>
          {off('/developer/api') ? null : (
            <li>
              <Link to="/developer/api">API reference</Link>: the routes of the API contract, for developers.
            </li>
          )}
        </ul>
      </Section>
      {meta?.demo === true ? <CredentialCard /> : null}
      <Section title="Demo and sandbox installations" testId="operations-demo">
        {demoOrSandbox ? null : <p>These are refused on this GMP installation: it is not a demo installation.</p>}
        <ul>
          <li>
            <Link to="/operations/demo">Demo and test data</Link>: load the demo data, or reset the installation to a clean state.
          </li>
          <li>
            <Link to="/operations/simulators">Simulators</Link>: start and stop the ERP/WMS, QMS, LIMS, LMS, CMMS, EMS, L3 and OPC UA simulators and switch their faults.
          </li>
        </ul>
      </Section>
    </>
  );
}

/**
 * R3.13 (slice 7k): the DEMO-ONLY credential card of a demo installation (what pnpm demo prints), so a presenter with only
 * the site knows who signs in where: the administrators' passwords of this set-up and every demo persona. Asked only on
 * a demo installation; the server refuses it on any other (DEMO_ONLY).
 */
function CredentialCard() {
  const q = useApiQuery(routes.operations.credentialCard);
  return (
    <Section title="Credential card (DEMO-ONLY)" testId="credential-card">
      <p>DEMO-ONLY credentials of this demo installation&apos;s set-up. They exist in the demo database only; the administrators&apos; passwords are new at each set-up.</p>
      {q.error ? <RefusalMessage error={q.error.error} /> : null}
      {q.data ? (
        <table aria-label="Demo credentials">
          <thead>
            <tr>
              <th>Person</th>
              <th>Roles</th>
              <th>Where</th>
              <th>Sign in with</th>
            </tr>
          </thead>
          <tbody>
            {q.data.entries.map((e) => (
              <tr key={e.loginName} data-testid={`credential-${e.loginName}`}>
                <td>{e.legalName}</td>
                <td>{e.roles.join(', ')}</td>
                <td>{e.terminal ?? 'an office PC'}</td>
                <td>{e.method === 'BADGE_PIN' ? `badge ${e.badgeUid ?? '?'} (Tap ${e.legalName} on the demo reader), PIN ${e.pin ?? '?'}` : `user ID ${e.loginName}, password ${e.password ?? '?'}`}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </Section>
  );
}
