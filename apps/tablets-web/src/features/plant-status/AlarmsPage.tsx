/**
 * The plant alarm list (DI-49): alarms from Batchwright itself, OPC UA equipment and the EMS, newest first, open ones by default,
 * filtered by state, source and unit or room code; each open alarm is acknowledged here. One alarm opens in detail
 * (alarms.alarm; slice 7g-5): its configuration version, severity, tag, every time at the source and at receipt, the
 * batches and steps it is bound to, and its acknowledgment.
 */
import { useState } from 'react';
import { routes, type PlantAlarmView } from '@ebmr/api-contract';
import { Button, Field, floor } from '@ebmr/ui-kit';
import { useApiQuery } from '../../api/hooks.ts';
import { Section } from '../../app/acts.tsx';
import { RefusalMessage } from '../../app/refusal.tsx';
import { Acknowledgement, Flags, reading } from './AlarmParts.tsx';
import { PLANT_CODE } from './reads.ts';

const STATES = ['OPEN', 'ACKNOWLEDGED', 'ALL'] as const;
const SOURCES = ['EBMR', 'OPCUA', 'EMS'] as const;

export function AlarmsPage() {
  const [state, setState] = useState<(typeof STATES)[number]>('OPEN');
  const [source, setSource] = useState<(typeof SOURCES)[number] | 'ANY'>('ANY');
  const [code, setCode] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const subjectCode = code.trim().toUpperCase();
  const q = useApiQuery(routes.alarms.list, {
    query: { state, ...(source !== 'ANY' ? { source } : {}), ...(PLANT_CODE.test(subjectCode) ? { subjectCode } : {}) },
  });
  return (
    <>
      <h1>Plant alarms</h1>
      <p>
        Alarms from Batchwright itself, the equipment (OPC UA) and the environmental monitoring system, with their times at the source.
        Each is acknowledged with the action taken; a GMP-critical alarm also needs a comment, and some need a deviation reference.
      </p>
      <Section title="Alarms" testId="plant-alarms">
        <floor.ChoiceGroup
          label="State"
          options={[
            { value: 'OPEN', label: 'Open' },
            { value: 'ACKNOWLEDGED', label: 'Acknowledged' },
            { value: 'ALL', label: 'All' },
          ]}
          value={state}
          onChange={(v) => setState(STATES.find((s) => s === v) ?? 'OPEN')}
        />
        <floor.ChoiceGroup
          label="Source"
          options={[{ value: 'ANY', label: 'Any' }, { value: 'EBMR', label: 'Batchwright' }, { value: 'OPCUA', label: 'Equipment (OPC UA)' }, { value: 'EMS', label: 'EMS' }]}
          value={source}
          onChange={(v) => setSource(SOURCES.find((s) => s === v) ?? 'ANY')}
        />
        <Field name="alarmSubject" label="Unit or room code" value={code} onChange={setCode} />
        {q.error ? <RefusalMessage error={q.error.error} /> : null}
        {q.data && q.data.alarms.length === 0 ? <p>No alarm.</p> : null}
        <table>
          <thead>
            <tr>
              <th scope="col">Alarm</th>
              <th scope="col">Unit or room</th>
              <th scope="col">Raised at source</th>
              <th scope="col">Cleared at source</th>
              <th scope="col">Batches</th>
              <th scope="col">Acknowledgment</th>
            </tr>
          </thead>
          <tbody>{q.data?.alarms.map((a) => <Row key={a.alarmId} a={a} onOpen={() => setOpen(a.alarmId)} />)}</tbody>
        </table>
      </Section>
      {open ? <AlarmDetail alarmId={open} onClose={() => setOpen(null)} /> : null}
    </>
  );
}

function Row({ a, onOpen }: { a: PlantAlarmView; onOpen: () => void }) {
  return (
    <tr data-testid={`alarm-${a.alarmId}`} data-gmp-critical={String(a.gmpCritical)}>
      <th scope="row">
        {a.source} {a.alarmCode}: {a.message} {reading(a)} <Flags a={a} /> <Button onPress={onOpen}>{`Details of ${a.alarmCode} on ${a.subject.code}`}</Button>
      </th>
      <td>{a.subject.code}</td>
      <td>{a.raisedAtSource.text}</td>
      <td>{a.clearedAtSource ? a.clearedAtSource.text : 'Not cleared'}</td>
      <td>{a.batches.map((b) => `${b.batchNumber}${b.step ? ` (${b.step})` : ''}`).join(', ') || 'None'}</td>
      <td>
        <Acknowledgement a={a} />
      </td>
    </tr>
  );
}

/** One alarm as the database holds it now (alarms.alarm), read again after an acknowledgment. */
function AlarmDetail({ alarmId, onClose }: { alarmId: string; onClose: () => void }) {
  const q = useApiQuery(routes.alarms.alarm, { params: { alarmId } });
  const a = q.data;
  return (
    <Section title="Alarm in detail" testId="alarm-detail">
      {q.error ? <RefusalMessage error={q.error.error} /> : null}
      {a ? (
        <dl data-testid={`alarm-detail-${a.alarmId}`}>
          <dt>Alarm</dt>
          <dd>
            {a.source} {a.alarmCode} (occurrence {a.occurrenceId}): {a.message} <Flags a={a} />
          </dd>
          <dt>Unit or room</dt>
          <dd>
            {a.subject.code} ({a.subject.kind === 'AREA' ? 'room or line' : 'equipment'}){a.tag ? `, tag ${a.tag}` : ''}
          </dd>
          <dt>Reading</dt>
          <dd>{reading(a) || 'None sent'}</dd>
          <dt>Configuration</dt>
          <dd>{a.codeVersion ? `Version ${a.codeVersion} of the alarm code, severity ${a.severity}` : `Code not configured: treated as GMP-critical (severity ${a.severity})`}</dd>
          <dt>Times</dt>
          <dd>
            Raised at the source {a.raisedAtSource.text}; received {a.receivedAt.text}; {a.clearedAtSource ? `cleared at the source ${a.clearedAtSource.text}` : 'not cleared'};{' '}
            {a.sourceAcknowledgedAt ? `acknowledged at the source ${a.sourceAcknowledgedAt.text}` : 'not acknowledged at the source'}.
          </dd>
          <dt>Batches</dt>
          <dd>{a.batches.map((b) => `${b.batchNumber}${b.step ? ` (${b.step})` : ''}`).join(', ') || 'None: the unit or room served no batch then'}</dd>
          <dt>Acknowledgment in Batchwright</dt>
          <dd>
            <Acknowledgement a={a} />
          </dd>
        </dl>
      ) : null}
      <Button onPress={onClose}>Close the details</Button>
    </Section>
  );
}
