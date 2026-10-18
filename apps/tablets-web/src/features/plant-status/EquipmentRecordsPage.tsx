/**
 * Equipment events and original device records (slice 7g-5, decision 0025; DI-32; routes equipmentData.events and
 * equipmentData.originals): the events of a unit or of a batch, newest first, with their times at the source and at
 * receipt and the step they fell in; and, for a batch, the original records of its simple devices: the raw output a
 * device transmitted, or the printed ticket with its hash, each with the entry it backs. Everything is as the database
 * holds it; nothing is computed here.
 */
import { useState } from 'react';
import { routes } from '@ebmr/api-contract';
import { Field, floor } from '@ebmr/ui-kit';
import { useApiQuery } from '../../api/hooks.ts';
import { Section } from '../../app/acts.tsx';
import { RefusalMessage } from '../../app/refusal.tsx';
import { PLANT_CODE, words } from './reads.ts';

export function EquipmentRecordsPage() {
  const batches = useApiQuery(routes.batches.list);
  const [batchId, setBatchId] = useState('');
  const [unit, setUnit] = useState('');
  const code = unit.trim().toUpperCase();
  return (
    <>
      <h1>Equipment events and original records</h1>
      <p>Equipment events in the batch context (state changes, recipe loads, phases, operator actions, faults), and the original records of the simple devices a batch used.</p>
      {batches.error ? <RefusalMessage error={batches.error.error} /> : null}
      <floor.ChoiceGroup
        label="Batch"
        options={[{ value: '', label: 'Any batch' }, ...(batches.data?.batches ?? []).map((b) => ({ value: b.runId, label: `${b.batchNumber} (${b.statusText})` }))]}
        value={batchId}
        onChange={setBatchId}
      />
      <Field name="eventUnit" label="Unit code (optional)" value={unit} onChange={setUnit} />
      <Events batchId={batchId} code={PLANT_CODE.test(code) ? code : ''} />
      {batchId ? <Originals batchId={batchId} /> : null}
    </>
  );
}

function Events({ batchId, code }: { batchId: string; code: string }) {
  const q = useApiQuery(routes.equipmentData.events, { query: { ...(batchId ? { batchId } : {}), ...(code ? { equipmentCode: code } : {}) } });
  return (
    <Section title="Equipment events" testId="equipment-events">
      {q.error ? <RefusalMessage error={q.error.error} /> : null}
      {q.data && q.data.events.length === 0 ? <p>No event.</p> : null}
      <table>
        <thead>
          <tr>
            <th scope="col">Event</th>
            <th scope="col">Unit</th>
            <th scope="col">At the source</th>
            <th scope="col">Received</th>
            <th scope="col">Step</th>
          </tr>
        </thead>
        <tbody>
          {q.data?.events.map((e) => (
            <tr key={e.eventId} data-testid={`equipment-event-${e.sourceEventId}`}>
              <th scope="row">
                {words(e.kind)}
                {e.state ? ` (${words(e.state)})` : ''}
                {e.recipeVersion ? `, recipe ${e.recipeVersion}` : ''}: {e.message} <span>[{e.source}]</span>
              </th>
              <td>{e.equipmentCode}</td>
              <td>{e.occurredAtSource.text}</td>
              <td>{e.receivedAt.text}</td>
              <td>{e.step ?? ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Section>
  );
}

function Originals({ batchId }: { batchId: string }) {
  const q = useApiQuery(routes.equipmentData.originals, { params: { batchId } });
  return (
    <Section title="Original records of simple devices" testId="equipment-originals">
      {q.error ? <RefusalMessage error={q.error.error} /> : null}
      {q.data && q.data.records.length === 0 ? <p>No original record for this batch.</p> : null}
      <ul>
        {q.data?.records.map((r) => (
          <li key={r.recordId} data-testid={`original-${r.recordId}`}>
            <strong>
              {r.value} {r.unit}
            </strong>{' '}
            from {r.equipmentCode}
            {r.deviceRef ? ` (${r.deviceRef})` : ''} at step {r.step}: {r.capture === 'TRANSMITTED' ? `transmitted output ${r.rawOutput ?? ''}` : `printed ticket ${r.ticketRef ?? ''} (SHA-256 ${r.ticketSha256 ?? ''})`}
            {r.deviceTime ? `, device time ${r.deviceTime.text}` : ''}; recorded by {r.recordedBy.legalName} on {r.recordedAt.text}
            {r.entryRef ? `, backing entry ${r.entryRef}` : ''}.
          </li>
        ))}
      </ul>
    </Section>
  );
}
