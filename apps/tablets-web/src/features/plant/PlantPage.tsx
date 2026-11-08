/**
 * Plant acts (Phase 3 slice 6): start, complete and verify a cleaning; record a line or room clearance and verify it;
 * record an equipment logbook event or the repair of an open failure, and verify the repair. Verification is the second
 * person's signature (PLANT_VERIFY) through the ceremony; the database refuses the person who recorded the act.
 * Phase 7 slice 7h (WP-A, gap report A7 and A9): a calibration of a unit whose class requires one (LOGBOOK.ENTRY) and
 * the discharge configuration of a press (MASTERDATA.CHANGE); the unit is chosen from the plant list, never typed.
 * Slice 7h (gap report D2): the per-use check and the booking for a batch of an instrument the batch uses without a status
 * step naming it (a closure torque tester on a bottle line: TB23-TESTER), chosen from the plant list (STEP.EXECUTE).
 */
import { useState } from 'react';
import { routes, type RouteResponse } from '@ebmr/api-contract';
import { Field, floor, StatusChip } from '@ebmr/ui-kit';
import { useApiQuery } from '../../api/hooks.ts';
import { useFloorRead } from '../floor/queries.ts';
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
      <Section title="Cleaning for a batch" testId="batch-cleaning">
        <BatchCleaning onStarted={(c) => setStarted((all) => [c, ...all])} />
      </Section>
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
      <Section title="Instrument check and booking for a batch" testId="instrument-use">
        <InstrumentUseForm />
      </Section>
      <Section title="Room or unit in use for a batch" testId="plant-use">
        <PlantUseForm />
      </Section>
      <Section title="Calibration" testId="calibration">
        <CalibrationForm />
      </Section>
      <Section title="Press discharge" testId="press-discharge">
        <PressDischargeForm />
      </Section>
    </>
  );
}

/**
 * R3.10 (hosted-demo trials): for a batch, the rooms and units its stages need with their cleaning state, and the needed
 * cleanings started from the list (each the person's own act through the cleaning route; completed and verified below).
 */
function BatchCleaning({ onStarted }: { onStarted: (c: CleaningView) => void }) {
  // Slice 7o (D-7o-1): the batches of this installation's floor (the test runs on the sandbox).
  const batches = useFloorRead(routes.execution.runs);
  const [batchId, setBatchId] = useState<string | null>(null);
  const open = (batches.data?.runs ?? []).filter((b) => OPEN_BATCH.has(b.status));
  return (
    <>
      {batches.error ? <RefusalMessage error={batches.error.error} /> : null}
      {batches.data && open.length === 0 ? <p>No batch is issued or running.</p> : null}
      {open.length > 0 ? <floor.ChoiceGroup label="Batch" options={open.map((b) => ({ value: b.runId, label: `${b.batchNumber} (${b.product.name})` }))} value={batchId} onChange={setBatchId} /> : null}
      {batchId ? <CleaningNeeds batchId={batchId} onStarted={onStarted} /> : null}
    </>
  );
}

function CleaningNeeds({ batchId, onStarted }: { batchId: string; onStarted: (c: CleaningView) => void }) {
  const q = useApiQuery(routes.batches.cleaningNeeds, { params: { batchId } });
  const start = useCommand(routes.plant.startCleaning, [...PENDING, routes.batches.cleaningNeeds.id], 'starting a cleaning');
  const [level, setLevel] = useState<string | null>('MAJOR');
  if (q.error) return <RefusalMessage error={q.error.error} />;
  if (!q.data) return <p>Loading what the batch needs.</p>;
  const go = async (target: 'EQUIPMENT' | 'AREA', code: string) => {
    const c = await start.run({ body: { target, code, level: level === 'MINOR' ? 'MINOR' : 'MAJOR', method: 'MANUAL' } });
    if (c) onStarted(c);
  };
  const stateChip = (state: string, needs: boolean) => <StatusChip tone={needs ? 'warning' : state === 'CLEANING' ? 'info' : 'ok'} label={state.toLowerCase().replace(/_/g, ' ')} />;
  return (
    <div data-testid={`cleaning-needs-${q.data.batchNumber}`}>
      <floor.ChoiceGroup label="Cleaning level" options={[{ value: 'MAJOR', label: 'MAJOR' }, { value: 'MINOR', label: 'MINOR' }]} value={level} onChange={setLevel} />
      {q.data.stages.map((s) => (
        <section key={s.stageKey} aria-label={`Stage ${s.name}`} data-testid={`cleaning-stage-${s.stageKey}`}>
          <h3>
            {s.name} ({s.status === 'SIGNED_OFF' ? 'signed off' : s.status === 'IN_PROGRESS' ? 'in progress' : 'next'})
          </h3>
          <ul>
            {s.rooms.map((r) => (
              <li key={r.code} data-testid={`need-${r.code}`}>
                {r.kind === 'LINE' ? 'Line' : 'Room'} {r.code} {stateChip(r.state, r.needsCleaning)}{' '}
                {r.needsCleaning ? <ActButton label={`Start the cleaning of ${r.code}`} onPress={() => go('AREA', r.code)} disabled={start.busy} primary={false} /> : null}
              </li>
            ))}
            {s.units.map((u) => (
              <li key={`${u.ref}:${u.code}`} data-testid={`need-${u.code}`}>
                {u.ref}: {u.code} {u.name} {stateChip(u.state, u.needsCleaning)}{' '}
                {u.needsCleaning ? <ActButton label={`Start the cleaning of ${u.code}`} onPress={() => go('EQUIPMENT', u.code)} disabled={start.busy} primary={false} /> : null}
              </li>
            ))}
          </ul>
        </section>
      ))}
      <ActResult error={start.error} done={start.done} label={start.done ? `Cleaning of ${start.done.code} started: complete it below.` : ''} />
    </div>
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
  const cmd = useCommand(routes.plant.completeCleaning, PENDING, 'completing a cleaning');
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
  // Slice 7o (D-7o-1): the batches of this installation's floor family (the test runs on the sandbox).
  const batches = useFloorRead(routes.execution.runs);
  const [batchId, setBatch] = useState<string | null>(null);
  return (
    <>
      <floor.ChoiceGroup label="For batch" options={(batches.data?.runs ?? []).map((b) => ({ value: b.runId, label: `${b.batchNumber} (${b.statusText})` }))} value={batchId} onChange={setBatch} />
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
  const cmd = useCommand(routes.plant.equipmentEvent, PENDING, 'an equipment logbook entry');
  const v = (k: string) => (values[k] ?? '').trim();
  const body = event
    ? {
        event,
        ...(event === 'EVENT' && v('kind') ? { kind: v('kind') as (typeof EVENT_KINDS)[number] } : {}),
        detail: v('detail'),
        ...(v('reference') ? { reference: v('reference') } : {}),
        ...(v('batchNumber') ? { batchNumber: v('batchNumber') } : {}),
      }
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
      {/* G5 (owner report item 22): a qualification or a repair names its reference (recipe-core 0400's table rule). */}
      <Field
        name="reference"
        label={event === 'REPAIR' ? 'Work order reference' : values['kind'] === 'QUALIFIED' || values['kind'] === 'REPAIRED' ? 'Reference (required: the qualification report or work order)' : 'Reference (optional)'}
        value={values['reference'] ?? ''}
        onChange={set('reference')}
        isRequired={event === 'REPAIR' || values['kind'] === 'QUALIFIED' || values['kind'] === 'REPAIRED'}
      />
      {event === 'EVENT' && values['kind'] === 'FAILURE_SIGNALLED' ? <Field name="batchNumber" label="Batch it was signalled in" value={values['batchNumber'] ?? ''} onChange={set('batchNumber')} /> : null}
      <ActButton
        label="Record in the logbook"
        onPress={async () => {
          if (parsed?.success && code.trim()) {
            const r = await cmd.run({ params: { code: code.trim() }, body: parsed.data });
            if (r) setValues({});
          }
        }}
        disabled={!parsed?.success || code.trim() === '' || cmd.busy || ((values['kind'] === 'QUALIFIED' || values['kind'] === 'REPAIRED') && event === 'EVENT' && (values['reference'] ?? '').trim() === '')}
      />
      <ActResult error={cmd.error} done={cmd.done} label={event === 'REPAIR' ? 'Repair recorded: a second person verifies it.' : 'Recorded.'} />
    </>
  );
}

/** The units of the plant list of a kind, to choose from (the database refuses one whose class needs no calibration). */
function useUnits(kind: 'PROCESS' | 'INSTRUMENT' | null) {
  const q = useApiQuery(routes.plant.equipment);
  return (q.data?.equipment ?? []).filter((e) => kind === null || e.kind === kind).map((e) => ({ value: e.code, label: `${e.code} ${e.name} (${e.kind.toLowerCase()}${e.areaCode ? `, ${e.areaCode}` : ''})` }));
}

const HOURS = ['4', '8', '12', '24'].map((h) => ({ value: h, label: `${h} h` }));
const OPEN_BATCH = new Set(['ISSUED', 'IN_PROGRESS', 'ON_HOLD']);

function InstrumentUseForm() {
  const units = useUnits('INSTRUMENT');
  // Slice 7o (D-7o-1): the batches of this installation's floor family (the test runs on the sandbox).
  const batches = useFloorRead(routes.execution.runs);
  const check = useCommand(routes.plant.recordInstrumentCheck, PENDING, 'the per-use check');
  const book = useCommand(routes.plant.recordInstrumentUse, PENDING, 'booking the instrument');
  const [code, setCode] = useState<string | null>(null);
  const [batchId, setBatch] = useState<string | null>(null);
  const [reference, setReference] = useState('Per-use check');
  const [hours, setHours] = useState<string | null>('12');
  const open = (batches.data?.runs ?? []).filter((b) => OPEN_BATCH.has(b.status));
  const busy = check.busy || book.busy;
  return (
    <>
      <floor.ChoiceGroup label="For batch" options={open.map((b) => ({ value: b.runId, label: `${b.batchNumber} (${b.statusText})` }))} value={batchId} onChange={setBatch} />
      <floor.ChoiceGroup label="Instrument" options={units} value={code} onChange={setCode} />
      {code && batchId ? (
        <>
          <Field name="instrumentReference" label="Check reference (weights, procedure)" value={reference} onChange={setReference} />
          <ActButton label={`Per-use check of ${code} passed`} onPress={() => check.run({ params: { code }, body: { result: 'PASS', reference: reference.trim(), batchId } })} disabled={busy || reference.trim() === ''} />
          <ActButton primary={false} label={`Per-use check of ${code} failed`} onPress={() => check.run({ params: { code }, body: { result: 'FAIL', reference: reference.trim(), batchId } })} disabled={busy || reference.trim() === ''} />
          <ActResult error={check.error} done={check.done} label={check.done ? `Check recorded: ${check.done.result}.` : ''} />
          <floor.ChoiceGroup label="Planned use" options={HOURS} value={hours} onChange={setHours} />
          <ActButton label={`Book ${code} for the batch`} onPress={() => book.run({ params: { code }, body: { batchId, plannedHours: hours ?? '12' } })} disabled={busy || hours === null} />
          <ActResult error={book.error} done={book.done} label={book.done ? `${book.done.equipmentCode} booked until ${book.done.plannedEnd.text}.` : ''} />
        </>
      ) : (
        <p>Choose the batch and the instrument.</p>
      )}
    </>
  );
}

/**
 * The use of a room or a process unit by a batch where no step of the batch records it (R3.3 made the step screen's
 * plant acts one act with their record; the separate acts stay here for a use no step names, as the instrument booking
 * above). The database guards the room's clearance and the unit's status.
 */
function PlantUseForm() {
  const units = useUnits('PROCESS');
  const areas = useApiQuery(routes.plant.areas);
  const batches = useApiQuery(routes.batches.list);
  const area = useCommand(routes.plant.startAreaOccupancy, PENDING, 'starting the use of the room');
  const unit = useCommand(routes.plant.startEquipmentUse, PENDING, 'starting the use of the unit');
  const [batchId, setBatch] = useState<string | null>(null);
  const [areaCode, setArea] = useState<string | null>(null);
  const [stage, setStage] = useState('');
  const [code, setCode] = useState<string | null>(null);
  const [hours, setHours] = useState<string | null>('12');
  const open = (batches.data?.batches ?? []).filter((b) => OPEN_BATCH.has(b.status));
  return (
    <>
      <floor.ChoiceGroup label="Batch using it" options={open.map((b) => ({ value: b.runId, label: `${b.batchNumber} (${b.statusText})` }))} value={batchId} onChange={setBatch} />
      {batchId ? (
        <>
          <floor.ChoiceGroup label="Room or line" options={(areas.data?.areas ?? []).map((a) => ({ value: a.code, label: `${a.code} ${a.name}` }))} value={areaCode} onChange={setArea} />
          <Field name="useStage" label="Stage (as the master names it)" value={stage} onChange={setStage} />
          {areaCode ? <ActButton label={`Start using ${areaCode} for the batch`} onPress={() => area.run({ body: { areaCode, batchId, stage: stage.trim() } })} disabled={area.busy || stage.trim() === ''} /> : null}
          <ActResult error={area.error} done={area.done} label={area.done ? `${area.done.areaCode} in use by ${area.done.batchNumber}.` : ''} />
          <floor.ChoiceGroup label="Process unit" options={units} value={code} onChange={setCode} />
          <floor.ChoiceGroup label="Planned use of the unit" options={HOURS} value={hours} onChange={setHours} />
          {code ? <ActButton label={`Start using ${code} for the batch`} onPress={() => unit.run({ params: { code }, body: { batchId, plannedHours: hours ?? '12' } })} disabled={unit.busy || hours === null} /> : null}
          <ActResult error={unit.error} done={unit.done} label={unit.done ? `${unit.done.equipmentCode} in use until ${unit.done.plannedEnd.text}.` : ''} />
        </>
      ) : (
        <p>Choose the batch.</p>
      )}
    </>
  );
}

function CalibrationForm() {
  const units = useUnits(null);
  const [code, setCode] = useState<string | null>(null);
  return (
    <>
      <floor.ChoiceGroup label="Unit calibrated" options={units} value={code} onChange={setCode} />
      {code ? (
        <DefineForm
          key={code}
          title="Record a calibration"
          route={routes.plant.recordCalibration}
          params={{ code }}
          refresh={PENDING}
          submitLabel={`Record the calibration of ${code}`}
          fields={[
            { name: 'asFound', label: 'As found', kind: 'choice', options: ['PASS', 'FAIL'] },
            { name: 'asLeft', label: 'As left', kind: 'choice', options: ['PASS', 'FAIL'] },
            { name: 'reference', label: 'Certificate reference', kind: 'text' },
            { name: 'dueDate', label: 'Next calibration due (YYYY-MM-DD)', kind: 'text' },
          ]}
        />
      ) : (
        <p>Choose the unit that was calibrated.</p>
      )}
    </>
  );
}

function PressDischargeForm() {
  const presses = useUnits('PROCESS');
  const [code, setCode] = useState<string | null>(null);
  return (
    <>
      <floor.ChoiceGroup label="Press" options={presses} value={code} onChange={setCode} />
      {code ? (
        <DefineForm
          key={code}
          title="Configure the press discharge"
          route={routes.plant.configurePressDischarge}
          params={{ code }}
          refresh={PENDING}
          submitLabel={`Configure the discharge of ${code}`}
          fields={[{ name: 'separateStreams', label: 'Each side discharges into its own containers', kind: 'yesno' }]}
        />
      ) : (
        <p>Choose the press.</p>
      )}
    </>
  );
}
