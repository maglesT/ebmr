/**
 * Plant acts (Phase 3 slice 6): start, complete and verify a cleaning; record a line or room clearance and verify it;
 * record an equipment logbook event or the repair of an open failure, and verify the repair. Verification is the second
 * person's signature (PLANT_VERIFY) through the ceremony; the database refuses the person who recorded the act.
 */
import { useState } from 'react';
import { routes, type CallInput, type RouteResponse } from '@ebmr/api-contract';
import { Field, floor, StatusChip } from '@ebmr/ui-kit';
import { useApiQuery } from '../../api/hooks.ts';
import { ActButton, ActResult, Section, useCommand, useSignedAct } from '../../app/acts.tsx';
import { DefineForm, FieldInput } from '../../app/define-form.tsx';
import { RefusalMessage } from '../../app/refusal.tsx';
import { useOffered } from '../../app/roles.ts';

type CleaningView = RouteResponse<typeof routes.plant.startCleaning>;
type PendingVerificationView = RouteResponse<typeof routes.plant.pendingVerifications>['items'][number];

const PENDING = [routes.plant.pendingVerifications.id, routes.plant.equipment.id, routes.plant.areas.id];
const EVENT_KINDS = ['QUALIFIED', 'QUALIFICATION_WITHDRAWN', 'MAINTENANCE_STARTED', 'MAINTENANCE_ENDED', 'TAKEN_OUT_OF_SERVICE', 'RETURNED_TO_SERVICE', 'FAILURE_SIGNALLED', 'RETIRED'] as const;

export function PlantPage() {
  const [started, setStarted] = useState<CleaningView[]>([]);
  return (
    <>
      <h1>Plant</h1>
      <PendingVerifications />
      <Section title="Cleaning" testId="cleaning">
        <DefineForm
          title="Start a cleaning"
          route={routes.plant.startCleaning}
          refresh={PENDING}
          submitLabel="Start the cleaning"
          onDone={(c) => setStarted((all) => [c, ...all])}
          fields={[
            { name: 'target', label: 'What is cleaned', kind: 'choice', options: ['EQUIPMENT', 'AREA'] },
            { name: 'code', label: 'Equipment or area code', kind: 'text' },
            { name: 'level', label: 'Level', kind: 'choice', options: ['MINOR', 'MAJOR'] },
            { name: 'method', label: 'Method', kind: 'choice', options: ['MANUAL', 'CIP'], optional: true },
          ]}
        />
        <CompleteCleaning started={started} />
      </Section>
      <Section title="Line or room clearance" testId="clearance">
        <ClearanceForm />
      </Section>
      <Section title="Equipment logbook" testId="equipment-event">
        <EquipmentEventForm />
      </Section>
    </>
  );
}

function PendingVerifications() {
  const q = useApiQuery(routes.plant.pendingVerifications);
  const verifier = useOffered('PLANT_VERIFIER');
  return (
    <Section title="Waiting for verification" testId="pending-verifications">
      {q.error ? <RefusalMessage error={q.error.error} /> : null}
      {q.data && q.data.items.length === 0 ? <p>Nothing waits for a second person.</p> : null}
      <ul>
        {q.data?.items.map((item) => (
          <li key={`${item.act}:${item.id}`} data-testid={`pending-${item.act}-${item.subject}`}>
            <PendingItem item={item} verifier={verifier} />
          </li>
        ))}
      </ul>
    </Section>
  );
}

function PendingItem({ item, verifier }: { item: PendingVerificationView; verifier: boolean }) {
  const signed = useSignedAct(PENDING);
  const what = item.act === 'CLEANING' ? 'cleaning' : item.act === 'CLEARANCE' ? 'clearance' : 'repair';
  return (
    <>
      <p>
        <StatusChip tone="warning" label={item.act} /> {item.subject}: {item.summary} · recorded by {floor.personLine(item.recordedBy)}, {item.recordedAt.text}
      </p>
      {verifier ? (
        <ActButton label={`Verify the ${what} of ${item.subject}`} onPress={() => signed.sign({ kind: 'PLANT_VERIFY', act: item.act, id: item.id }, `Verify the ${what} of ${item.subject}: ${item.summary}`)} disabled={signed.busy || signed.outcome === 'SIGNED'} />
      ) : null}
      <ActResult error={signed.error} outcome={signed.outcome} />
    </>
  );
}

function CompleteCleaning({ started }: { started: CleaningView[] }) {
  const [id, setId] = useState('');
  const [cycle, setCycle] = useState('');
  const cmd = useCommand(routes.plant.completeCleaning, PENDING);
  const chosen = id.trim();
  return (
    <div data-testid="complete-cleaning">
      <h3>Complete a cleaning</h3>
      {started.length > 0 ? (
        <floor.ChoiceGroup label="Cleaning started here" options={started.map((c) => ({ value: c.cleaningId, label: `${c.code} (${c.level}, ${c.method}) started ${c.startedAt.text}` }))} value={chosen === '' ? null : chosen} onChange={setId} />
      ) : null}
      <Field name="cleaningId" label="Cleaning id" value={id} onChange={setId} description="Scan the cleaning record, or choose one started here" />
      <Field name="cycleReference" label="CIP cycle reference" value={cycle} onChange={setCycle} description="A CIP cleaning names its cycle (optional for manual cleaning)" />
      <ActButton
        label="Complete the cleaning"
        onPress={() => cmd.run({ params: { id: chosen }, body: cycle.trim() ? { cycleReference: cycle.trim() } : {} })}
        disabled={chosen === '' || cmd.busy}
      />
      <ActResult error={cmd.error} done={cmd.done} label="Completed: a second person verifies it." />
    </div>
  );
}

function ClearanceForm() {
  const batches = useApiQuery(routes.batches.list);
  const [batchId, setBatch] = useState<string | null>(null);
  return (
    <>
      <floor.ChoiceGroup label="For batch" options={(batches.data?.batches ?? []).map((b) => ({ value: b.runId, label: `${b.batchNumber} (${b.statusText})` }))} value={batchId} onChange={setBatch} />
      {batchId ? (
        <DefineForm
          title="Record a clearance"
          route={routes.plant.recordClearance}
          refresh={PENDING}
          fixed={{ batchId }}
          submitLabel="Record the clearance"
          fields={[
            { name: 'areaCode', label: 'Area or line', kind: 'text' },
            { name: 'type', label: 'Type', kind: 'choice', options: ['PRODUCT_CHANGE', 'CAMPAIGN', 'PACKAGING_ORDER'] },
            { name: 'result', label: 'Result', kind: 'choice', options: ['PASSED', 'FAILED'] },
            { name: 'order', label: 'Packaging order', kind: 'text', optional: true },
            { name: 'artworkSet', label: 'Artwork set', kind: 'text', optional: true },
          ]}
        />
      ) : (
        <p>Choose the batch the clearance is for.</p>
      )}
    </>
  );
}

function EquipmentEventForm() {
  const [code, setCode] = useState('');
  const [event, setEvent] = useState<'EVENT' | 'REPAIR' | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const cmd = useCommand(routes.plant.equipmentEvent, PENDING);
  const v = (k: string) => (values[k] ?? '').trim();
  const body =
    event === 'REPAIR'
      ? { event: 'REPAIR' as const, detail: v('detail'), reference: v('reference') }
      : event === 'EVENT'
        ? { event: 'EVENT' as const, kind: v('kind') as (typeof EVENT_KINDS)[number], detail: v('detail'), ...(v('reference') ? { reference: v('reference') } : {}) }
        : null;
  const parsed = body ? routes.plant.equipmentEvent.body?.safeParse(body) : undefined;
  const set = (k: string) => (x: string) => setValues((s) => ({ ...s, [k]: x }));
  return (
    <>
      <Field name="equipmentCode" label="Equipment code" value={code} onChange={setCode} />
      <floor.ChoiceGroup
        label="Record"
        options={[
          { value: 'EVENT', label: 'A logbook event' },
          { value: 'REPAIR', label: 'The repair of its open failure' },
        ]}
        value={event}
        onChange={(x) => setEvent(x === 'REPAIR' ? 'REPAIR' : 'EVENT')}
      />
      {event === 'EVENT' ? <FieldInput field={{ name: 'kind', label: 'Event', kind: 'choice', options: EVENT_KINDS }} value={values['kind'] ?? ''} onChange={set('kind')} /> : null}
      <Field name="detail" label="Detail" value={values['detail'] ?? ''} onChange={set('detail')} />
      <Field name="reference" label={event === 'REPAIR' ? 'Work order reference' : 'Reference (optional)'} value={values['reference'] ?? ''} onChange={set('reference')} />
      <ActButton
        label="Record in the logbook"
        onPress={async () => {
          if (parsed?.success && code.trim()) {
            const r = await cmd.run({ params: { code: code.trim() }, body: parsed.data } as CallInput<typeof routes.plant.equipmentEvent>);
            if (r) setValues({});
          }
        }}
        disabled={!parsed?.success || code.trim() === '' || cmd.busy}
      />
      <ActResult error={cmd.error} done={cmd.done} label={event === 'REPAIR' ? 'Repair recorded: a second person verifies it.' : 'Recorded.'} />
    </>
  );
}
