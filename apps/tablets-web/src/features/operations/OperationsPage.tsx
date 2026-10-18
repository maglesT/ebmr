/**
 * The operations console (Phase 7 slice 7g-4): what used to be a command in a terminal, each on its page. Which of them
 * a person may use is the database's to decide (the system administrator's PLATFORM.OPERATE and CONTINUITY.BACKUP_RUN;
 * the demo conveniences only on a sandbox or a demo installation); every page shows the refusal it gets.
 */
import { Link } from '@tanstack/react-router';
import { StatusChip } from '@ebmr/ui-kit';
import { routes } from '@ebmr/api-contract';
import { useApiQuery } from '../../api/hooks.ts';
import { installationLabel, isSandbox } from '../../app/installation.ts';
import { Section } from '../../app/acts.tsx';

export function OperationsPage() {
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
            <Link to="/developer/api">API reference</Link>: the routes of the API contract, for developers.
          </li>
        </ul>
      </Section>
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
