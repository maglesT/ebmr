/**
 * Configuration history (Phase 6 slice 6f; DI-09): the configuration valid at any date and what changed between two
 * dates, with the change records the changes were made under; the platform settings (adapter modes, mirror freshness
 * bounds) and their change under a change record. The versions and their validity are the database's.
 */
import { useState } from 'react';
import { routes, type PlatformSettingView } from '@ebmr/api-contract';
import { Field } from '@ebmr/ui-kit';
import { useApiQuery } from '../../api/hooks.ts';
import { ActButton, ActResult, Section, useCommand } from '../../app/acts.tsx';
import { RefusalMessage } from '../../app/refusal.tsx';
import { CONFIG_READS, isoWithOffset, valueText, words } from './reads.ts';

export function ConfigHistoryPage() {
  return (
    <>
      <h1>Configuration history</h1>
      <p>Every configuration change is kept as a version from the moment it became valid. Pick a date to see the configuration then, or two dates to see what changed.</p>
      <AsOf />
      <Diff />
      <Settings />
    </>
  );
}

function AsOf() {
  const [local, setLocal] = useState('');
  const at = isoWithOffset(local.trim());
  const q = useApiQuery(routes.config.asOf, { query: { at: at ?? '1970-01-01T00:00:00Z' } }, { enabled: at !== null });
  return (
    <Section title="Configuration as of a date" testId="config-as-of">
      <Field name="asOf" label="Date and time (YYYY-MM-DDTHH:MM, your local time)" value={local} onChange={setLocal} />
      {q.error ? <RefusalMessage error={q.error.error} /> : null}
      {at !== null && q.data ? (
        <table>
          <thead>
            <tr><th scope="col">Area</th><th scope="col">Item</th><th scope="col">Value</th><th scope="col">Valid from</th><th scope="col">Change record</th></tr>
          </thead>
          <tbody>
            {q.data.items.map((i) => (
              <tr key={`${i.area}/${i.itemKey}`}>
                <td>{words(i.area)}</td><th scope="row">{i.itemKey}</th><td>{valueText(i.value)}</td><td>{i.validFrom}</td>
                <td>{i.changeRecord ?? (i.basis === 'RELEASE' ? 'software release' : 'before change control')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </Section>
  );
}

function Diff() {
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const f = isoWithOffset(from.trim());
  const t = isoWithOffset(to.trim());
  const q = useApiQuery(routes.config.diff, { query: { from: f ?? '1970-01-01T00:00:00Z', to: t ?? '1970-01-01T00:00:00Z' } }, { enabled: f !== null && t !== null });
  return (
    <Section title="What changed between two dates" testId="config-diff">
      <Field name="diffFrom" label="From (YYYY-MM-DDTHH:MM)" value={from} onChange={setFrom} />
      <Field name="diffTo" label="To (YYYY-MM-DDTHH:MM)" value={to} onChange={setTo} />
      {q.error ? <RefusalMessage error={q.error.error} /> : null}
      {f !== null && t !== null && q.data ? (
        q.data.differences.length === 0 ? (
          <p>No configuration changed between these dates.</p>
        ) : (
          <table>
            <thead>
              <tr><th scope="col">Area</th><th scope="col">Item</th><th scope="col">Before</th><th scope="col">After</th><th scope="col">Change records</th></tr>
            </thead>
            <tbody>
              {q.data.differences.map((d) => (
                <tr key={`${d.area}/${d.itemKey}`}>
                  <td>{words(d.area)}</td><th scope="row">{d.itemKey}</th><td>{valueText(d.before)}</td><td>{valueText(d.after)}</td><td>{d.changeRecords.join(', ')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )
      ) : null}
    </Section>
  );
}

function Settings() {
  const q = useApiQuery(routes.config.settings, {});
  return (
    <Section title="Platform settings" testId="config-settings">
      <p>Adapter modes, mirror freshness bounds and the other platform settings. A change needs an approved change record covering platform settings.</p>
      {q.error ? <RefusalMessage error={q.error.error} /> : null}
      {q.data?.settings.map((s) => <Setting key={s.key} s={s} />)}
    </Section>
  );
}

function Setting({ s }: { s: PlatformSettingView }) {
  const set = useCommand(routes.config.setSetting, CONFIG_READS);
  const [value, setValue] = useState('');
  const [cr, setCr] = useState('');
  const [reason, setReason] = useState('');
  const ok = value.trim() !== '' && cr.trim() !== '' && reason.trim() !== '';
  const range = s.allowedValues ? `one of ${s.allowedValues.join(', ')}` : s.minValue !== null ? `${s.minValue} to ${s.maxValue ?? ''} ${s.unit ?? ''}` : '';
  return (
    <details data-testid={`setting-${s.key}`}>
      <summary>
        {s.key} = {s.value} {s.unit ?? ''} {range ? `(${range})` : ''}
      </summary>
      <p>{s.description}</p>
      <Field name={`v-${s.key}`} label="New value" value={value} onChange={setValue} />
      <Field name={`cr-${s.key}`} label="Change-record number" value={cr} onChange={setCr} />
      <Field name={`r-${s.key}`} label="Reason" value={reason} onChange={setReason} />
      <ActButton label="Change the setting" onPress={() => (ok ? set.run({ params: { key: s.key }, body: { value: value.trim(), changeRecord: cr.trim(), reason: reason.trim() } }) : undefined)} disabled={!ok || set.busy} />
      <ActResult error={set.error} done={set.done} label="Changed under the change record." />
    </details>
  );
}
