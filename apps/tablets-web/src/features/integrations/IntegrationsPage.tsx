/**
 * The integration health page (Phase 6 slice 6a; DI-31): one row per adapter (last message, data age, open alarms, last
 * reconciliation), the mirrors with their mode, age and bound (a stale blocking mirror stops the steps that read it), and
 * the open integration alarms, each acknowledged by a person with a note.
 */
import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { routes, type AdapterHealthView, type IntegrationAlarmView, type MirrorFreshnessView } from '@ebmr/api-contract';
import { Field, StatusChip } from '@ebmr/ui-kit';
import { useApiQuery } from '../../api/hooks.ts';
import { ActButton, ActResult, Section, useCommand } from '../../app/acts.tsx';
import { RefusalMessage } from '../../app/refusal.tsx';
import { WorkersPanel } from '../operations/WorkersPanel.tsx';
import { age, freshnessText, INTEGRATION_READS, words } from './reads.ts';

export function IntegrationsPage() {
  const adapters = useApiQuery(routes.integrations.adapters);
  const mirrors = useApiQuery(routes.integrations.mirrors);
  const alarms = useApiQuery(routes.integrations.alarms, { query: { state: 'OPEN' } });
  return (
    <>
      <h1>Integration health</h1>
      <p>
        Every value another system sends arrives as a checked message under its adapter&apos;s own identity. A message that is malformed, a duplicate with other
        content, out of order, about something this site does not hold, or older than what is held, is refused with an alarm; nothing is lost, and the reconciliation
        against the source&apos;s own count shows it.
      </p>
      <Section title="Adapters" testId="integration-adapters">
        {adapters.error ? <RefusalMessage error={adapters.error.error} /> : null}
        {adapters.data && adapters.data.adapters.length === 0 ? <p>No adapter is registered.</p> : null}
        <table>
          <thead>
            <tr>
              <th scope="col">Adapter</th>
              <th scope="col">Last message</th>
              <th scope="col">Data age</th>
              <th scope="col">Open alarms</th>
              <th scope="col">Last reconciliation</th>
            </tr>
          </thead>
          <tbody>{adapters.data?.adapters.map((a) => <AdapterRow key={a.adapterCode} a={a} />)}</tbody>
        </table>
      </Section>
      <Section title="Mirrors" testId="integration-mirrors">
        {mirrors.error ? <RefusalMessage error={mirrors.error.error} /> : null}
        <table>
          <thead>
            <tr>
              <th scope="col">Data</th>
              <th scope="col">From</th>
              <th scope="col">Freshness</th>
            </tr>
          </thead>
          <tbody>{mirrors.data?.mirrors.map((m) => <MirrorRow key={m.dataClass} m={m} />)}</tbody>
        </table>
      </Section>
      {/* Phase 7 slice 7g-4: start, stop and restart the adapters' workers and the analytics runner from here. */}
      <WorkersPanel />
      <Section title="Open alarms" testId="integration-alarms">
        {alarms.error ? <RefusalMessage error={alarms.error.error} /> : null}
        {alarms.data && alarms.data.alarms.length === 0 ? <p>No open alarm.</p> : null}
        <ul>
          {alarms.data?.alarms.map((a) => (
            <li key={a.alarmId}>
              <AlarmItem a={a} />
            </li>
          ))}
        </ul>
      </Section>
    </>
  );
}

function AdapterRow({ a }: { a: AdapterHealthView }) {
  const r = a.lastReconciliation;
  return (
    <tr data-testid={`adapter-${a.adapterCode}`}>
      <th scope="row">
        <Link to="/integrations/$adapterCode" params={{ adapterCode: a.adapterCode }}>
          {a.adapterCode}
        </Link>{' '}
        ({words(a.sourceSystem)}) {a.status === 'ACTIVE' ? null : <StatusChip tone="error" label={words(a.status)} />}
        <br />
        {a.description}
      </th>
      <td>{a.lastMessage ? `${a.lastMessage.messageType} ${a.lastMessage.sourceRecordId} (sequence ${a.lastMessage.sequenceNo}, ${words(a.lastMessage.sequenceStatus)})` : 'None yet'}</td>
      <td>{age(a.dataAgeSeconds)}</td>
      <td>{a.openAlarms === '0' ? '0' : <StatusChip tone="warning" label={`${a.openAlarms} open`} />}</td>
      <td>
        {r ? (
          <>
            {r.matched ? <StatusChip tone="ok" label="Matched" /> : <StatusChip tone="error" label="Mismatch" />} {r.sourceCount} sent, {r.acceptedCount} accepted, {r.refusedCount} refused ({r.periodFrom.text} to {r.periodTo.text})
          </>
        ) : (
          'None yet'
        )}
      </td>
    </tr>
  );
}

function MirrorRow({ m }: { m: MirrorFreshnessView }) {
  const tone = m.mode === 'STAND_IN' || !m.stale ? 'ok' : m.blocking ? 'error' : 'warning';
  return (
    <tr data-testid={`mirror-${m.dataClass}`} data-stale={String(m.stale)}>
      <th scope="row">{words(m.dataClass)}</th>
      <td>{m.mode === 'STAND_IN' ? 'Built-in register' : words(m.sourceSystem)}</td>
      <td>
        <StatusChip tone={tone} label={freshnessText(m)} />
        {m.mode === 'MIRROR' && m.stale && m.blocking ? ` Steps that read this data are refused until the ${words(m.sourceSystem)} adapter synchronises again (call the ${words(m.sourceSystem)} system owner).` : null}
      </td>
    </tr>
  );
}

export function AlarmItem({ a }: { a: IntegrationAlarmView }) {
  const ack = useCommand(routes.integrations.acknowledgeAlarm, INTEGRATION_READS, 'the acknowledgment of the alarm');
  const [note, setNote] = useState('');
  return (
    <div data-testid={`alarm-${a.alarmId}`}>
      <p>
        <StatusChip tone={a.severity === 'MINOR' ? 'warning' : 'error'} label={words(a.kind)} /> {a.adapterCode} at {a.raisedAt.text}: {a.summary}
      </p>
      {a.acknowledgement ? (
        <p>
          Acknowledged by {a.acknowledgement.by.legalName} at {a.acknowledgement.at.text}: {a.acknowledgement.note}
        </p>
      ) : (
        <>
          <Field name={`note-${a.alarmId}`} label="What was done about it" value={note} onChange={setNote} />
          <ActButton
            label="Acknowledge the alarm"
            disabled={note.trim().length < 3 || ack.busy}
            onPress={() => ack.run({ params: { alarmId: a.alarmId }, body: { note: note.trim() } })}
          />
          <ActResult error={ack.error} done={ack.done} label="The alarm is acknowledged." />
        </>
      )}
    </div>
  );
}
