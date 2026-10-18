/**
 * The analytics methods (Phase 6A slice 6A-1; DI-52, DI-09): each method version with its intended use, parameters
 * hash, code identity, validation reference, validity and the change record it was written under; the monitoring of
 * each version by month (runs, failures, flags, the share QA dispositioned and the false-alarm rate); and, for QA and
 * the system owner, a version made EFFECTIVE or retired under an approved change record. The server and the database
 * decide (ANALYTICS.METHOD, the change record); a version never changes once in force.
 */
import { useState } from 'react';
import { routes, type AnalyticsMethodId, type MethodVersionView } from '@ebmr/api-contract';
import { Field, floor } from '@ebmr/ui-kit';
import { useApiQuery } from '../../api/hooks.ts';
import { ActButton, ActResult, Section, useCommand } from '../../app/acts.tsx';
import { RefusalMessage } from '../../app/refusal.tsx';
import { useOffered } from '../../app/roles.ts';
import { ANALYTICS_READS, AdvisoryBand, Stat } from './shared.tsx';

export function MethodsPage() {
  const versions = useApiQuery(routes.analytics.methods, {});
  const monitor = useApiQuery(routes.analytics.monitor, {});
  const qa = useOffered('QA');
  return (
    <>
      <h1>Analytics methods</h1>
      {versions.data ? <AdvisoryBand v={versions.data} /> : null}
      <Section title="Method versions" testId="analytics-versions">
        {versions.error ? <RefusalMessage error={versions.error.error} /> : null}
        {versions.data && versions.data.versions.length === 0 ? <p>No method version has been made effective yet.</p> : null}
        <ul>{versions.data?.versions.map((v) => <VersionLine key={`${v.method}-${v.version.toString()}-${v.validFrom.us}`} v={v} />)}</ul>
      </Section>
      <Section title="Monitoring (per method version and month)" testId="analytics-monitor">
        {monitor.error ? <RefusalMessage error={monitor.error.error} /> : null}
        <table>
          <thead><tr><th>Method</th><th>Version</th><th>Month</th><th>Runs</th><th>Failures</th><th>Flags</th><th>Dispositioned</th><th>False-alarm rate</th></tr></thead>
          <tbody>
            {monitor.data?.rows.map((r) => (
              <tr key={`${r.method}-${r.version.toString()}-${r.month}`} data-testid={`analytics-monitor-${r.method}-${r.version.toString()}-${r.month}`}>
                <td>{r.method}</td><td>{r.version.toString()}</td><td>{r.month}</td><td>{r.runs.toString()}</td><td>{r.failures.toString()}</td><td>{r.flags === null ? 'restricted' : r.flags.toString()}</td>
                <td><Stat value={r.dispositionedShare} /></td><td><Stat value={r.falseAlarmRate} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>
      {qa ? <MakeEffective /> : null}
    </>
  );
}

function VersionLine({ v }: { v: MethodVersionView }) {
  return (
    <li data-testid={`analytics-version-${v.method}-${v.version.toString()}-${v.status}`}>
      <strong>{v.method} version {v.version.toString()}</strong> ({v.status === 'EFFECTIVE' ? 'effective' : 'retired'}) · {v.title} · {v.intendedUse}
      <br />
      Parameters SHA-256 {v.parametersSha256} · {v.codeIdentity} · validation {v.validationRef} · valid from {v.validFrom.text}
      {v.validTo ? ` to ${v.validTo.text}` : ''} · change record {v.changeRecord ?? '(software release)'}
    </li>
  );
}

function MakeEffective() {
  const catalog = useApiQuery(routes.analytics.catalog, {});
  const set = useCommand(routes.analyticsConfig.setMethodVersion, ANALYTICS_READS);
  const methods = catalog.data?.methods ?? [];
  const [method, setMethod] = useState<AnalyticsMethodId | ''>('');
  const [version, setVersion] = useState('1');
  const [status, setStatus] = useState<'EFFECTIVE' | 'RETIRED'>('EFFECTIVE');
  const [parameters, setParameters] = useState('{}');
  const [acceptance, setAcceptance] = useState('{"reproduction": "flags identical, values within relative 1e-9"}');
  const [validationRef, setValidationRef] = useState('');
  const [cr, setCr] = useState('');
  const [reason, setReason] = useState('');
  const chosen = methods.find((m) => m.id === method);
  const ok = chosen !== undefined && /^[1-9]\d{0,8}$/.test(version) && validationRef.trim() !== '' && cr.trim() !== '' && reason.trim() !== '';
  return (
    <Section title="Make a method version effective, or retire it" testId="analytics-make-effective">
      <p>Under a change record QA approved for analytics methods. A version in force never changes: changed parameters are a new version.</p>
      <floor.ChoiceGroup label="Method" options={methods.map((m) => ({ value: m.id, label: m.title }))} value={method} onChange={(v) => setMethod(methods.find((m) => m.id === v)?.id ?? '')} />
      <Field name="anaVersion" label="Version" value={version} onChange={setVersion} />
      <floor.ChoiceGroup label="Status" options={[{ value: 'EFFECTIVE', label: 'Effective' }, { value: 'RETIRED', label: 'Retired' }]} value={status} onChange={(v) => setStatus(v === 'RETIRED' ? 'RETIRED' : 'EFFECTIVE')} />
      <Field name="anaParameters" label="Parameters (JSON object)" value={parameters} onChange={setParameters} />
      <Field name="anaAcceptance" label="Acceptance criteria (JSON object)" value={acceptance} onChange={setAcceptance} />
      <Field name="anaValidation" label="Validation reference" value={validationRef} onChange={setValidationRef} />
      <Field name="anaCr" label="Change-record number" value={cr} onChange={setCr} />
      <Field name="anaReason" label="Reason" value={reason} onChange={setReason} />
      <ActButton
        label="Record the method version"
        disabled={!ok || set.busy}
        onPress={() => (ok && chosen ? set.run({
          body: {
            method: chosen.id, version: Number.parseInt(version, 10), status, title: chosen.title, intendedUse: chosen.intendedUse, parametersJson: parameters.trim(),
            acceptanceJson: acceptance.trim(), validationRef: validationRef.trim(), changeRecord: cr.trim(), reason: reason.trim(),
          },
        }) : undefined)}
      />
      <ActResult error={set.error} done={set.done} label="Recorded under the change record." />
    </Section>
  );
}
