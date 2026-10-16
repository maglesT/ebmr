/**
 * The plant alarm list (DI-49): alarms from the eBMR, OPC UA equipment and the EMS, newest first, open ones by default,
 * filtered by state, source and unit or room code; each open alarm is acknowledged here.
 */
import { useState } from 'react';
import { routes, type PlantAlarmView } from '@ebmr/api-contract';
import { Field, floor } from '@ebmr/ui-kit';
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
  const subjectCode = code.trim().toUpperCase();
  const q = useApiQuery(routes.alarms.list, {
    query: { state, ...(source !== 'ANY' ? { source } : {}), ...(PLANT_CODE.test(subjectCode) ? { subjectCode } : {}) },
  });
  return (
    <>
      <h1>Plant alarms</h1>
      <p>
        Alarms from the eBMR, the equipment (OPC UA) and the environmental monitoring system, with their times at the source.
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
          options={[{ value: 'ANY', label: 'Any' }, { value: 'EBMR', label: 'eBMR' }, { value: 'OPCUA', label: 'Equipment (OPC UA)' }, { value: 'EMS', label: 'EMS' }]}
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
          <tbody>{q.data?.alarms.map((a) => <Row key={a.alarmId} a={a} />)}</tbody>
        </table>
      </Section>
    </>
  );
}

function Row({ a }: { a: PlantAlarmView }) {
  return (
    <tr data-testid={`alarm-${a.alarmId}`} data-gmp-critical={String(a.gmpCritical)}>
      <th scope="row">
        {a.source} {a.alarmCode}: {a.message} {reading(a)} <Flags a={a} />
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
