/**
 * The analytics overview (Phase 6A slice 6A-1; PR-60): every analytics method with its intended use, its inputs, what
 * it gives and "changes GMP data: no", the versions in force, and the inputs the analytics role reads.
 */
import { Link } from '@tanstack/react-router';
import { routes } from '@ebmr/api-contract';
import { StatusChip } from '@ebmr/ui-kit';
import { useApiQuery } from '../../api/hooks.ts';
import { Section } from '../../app/acts.tsx';
import { RefusalMessage } from '../../app/refusal.tsx';
import { AdvisoryBand } from './shared.tsx';

export function AnalyticsPage() {
  const q = useApiQuery(routes.analytics.catalog, {});
  return (
    <>
      <h1>Analytics</h1>
      {q.error ? <RefusalMessage error={q.error.error} /> : null}
      {q.data ? (
        <>
          <AdvisoryBand v={q.data} />
          <p>
            <Link to="/analytics/flags">Open flags</Link> · <Link to="/analytics/methods">Methods, versions and monitoring</Link> · <Link to="/analytics/profiles">Golden batch profiles</Link>
          </p>
          <Section title="Methods" testId="analytics-methods-catalog">
            <ul>
              {q.data.methods.map((m) => (
                <li key={m.id} data-testid={`analytics-method-${m.id}`}>
                  <strong>{m.title}</strong> ({m.id}) · {m.intendedUse} · Changes GMP data: no ·{' '}
                  {m.effectiveVersions.length > 0 ? <StatusChip tone="ok" label={`In force: version ${m.effectiveVersions.join(', ')}`} /> : <StatusChip tone="neutral" label="No version in force" />}
                  <br />
                  Reads {m.inputs.join(', ')}; gives {m.outputKinds.join(', ')}{m.flagRules.length > 0 ? `; flags ${m.flagRules.join(', ')}` : '; never flags'}.
                </li>
              ))}
            </ul>
          </Section>
          <Section title="Inputs the analytics role reads" testId="analytics-inputs">
            <ul>
              {q.data.inputs.map((i) => <li key={i.name}>{i.name} (version {i.version.toString()}, {i.grain}; slice {i.ownerSlice})</li>)}
            </ul>
          </Section>
        </>
      ) : q.error ? null : <p>Reading the analytics catalogue…</p>}
    </>
  );
}
