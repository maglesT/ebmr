/**
 * The plant acts of a GMP step, on the step screen where the step needs them (Phase 7 slice 7h, WP-A; demo gap report
 * A2 to A6; decision 0025):
 *  - a room or line clearance step (G-10@2): start the batch's use of the step's room or line (on its verified
 *    clearance), record it in the step, and end it;
 *  - an equipment status step (G-09@2): for each unit the step checks, the per-use check and booking of a balance or
 *    instrument, or the start of a process unit's use; record it in the step; end a unit's use;
 *  - a tooling step (TB-09@1): inspect a set before use item by item, issue it to the press in use, return it with the
 *    counts (the strokes from the press counter, or keyed from the press) and inspect it after use;
 *  - a press set-up step (TB-10@1): the press in use with the tooling issued to it, and the charge of a closed container
 *    of the batch into the hopper;
 *  - a bilayer compression step (TB-16@1; slice 7m, R1): the charge of a closed container of each layer's blend into that
 *    layer's hopper (the entry names the layer, its hopper, the container's blend and the charge);
 *  - a printed-materials step (G-21@1; gap report D2): the printed packaging lot scanned at the line, its facts read from
 *    the register (batches.printedLot) for the issue entry, which must carry them exactly; the artwork read from the lot
 *    label is still typed by the operator, so the database compares the two.
 * What is offered is the server's (batches.stepPlant); each act is one command of the signed-in person (a fresh badge
 * tap on a shared terminal) and the database decides; its refusal is shown in its own words. The act's answer fills the
 * step's entry form (choices.tsx), which the person then saves: no identifier is ever typed.
 */
import { useEffect, useRef, useState } from 'react';
import { routes, type StepPlantView, type StepScreenView } from '@ebmr/api-contract';
import { Button, Field, floor, StatusChip } from '@ebmr/ui-kit';
import { ActResult, useCommand } from '../../../app/acts.tsx';
import { useApiQuery } from '../../../api/hooks.ts';
import { RefusalMessage } from '../../../app/refusal.tsx';
import { useStepChoices } from '../choices.tsx';
import { wcls } from '../classes.ts';
import { plantEntryParams, plantEntryRoute } from '../family.ts';

const READ = [routes.batches.stepPlant.id];
/** R3.3: a plant entry changes the step and the run as well as the plant (the step's entry is recorded with it). */
const READ_WITH_STEP = [routes.batches.stepPlant.id, routes.execution.step.id, routes.execution.run.id];
/** Whether the step already records `id` (an occupancy or use) in an entry of `kind`. */
const recorded = (view: StepScreenView, kind: string, member: string, id: string): boolean => view.entries.some((e) => e.kind === kind && e.data[member] === id);
const PLANT_BLOCKS = new Set(['G-09@2', 'G-10@2', 'TB-09@1', 'TB-10@1', 'TB-16@1']);
const HOURS = ['4', '8', '12', '24'].map((h) => ({ value: h, label: `${h} h` }));
const yesNo = (b: boolean): string => (b ? 'YES' : 'NO');
const title = (item: string): string => item.charAt(0) + item.slice(1).toLowerCase().replace(/_/g, ' ');

/** Whether the step's block stands on a plant act this screen offers. */
export function hasPlantActs(view: StepScreenView): boolean {
  return view.step.block !== null && PLANT_BLOCKS.has(view.step.block);
}

export function StepPlantActs({ view }: { view: StepScreenView }) {
  // Slice 7o (D-7o-1): the plant acts on both installations (a test run's on the sandbox, against its own database).
  if (view.step.block === 'G-21@1') return <PrintedLotPanel view={view} />;
  return <PlantActs view={view} />;
}

function PlantActs({ view }: { view: StepScreenView }) {
  const offered = hasPlantActs(view);
  const q = useApiQuery(routes.batches.stepPlant, { params: { batchId: view.run.runId, stepKey: view.step.stepKey } }, { enabled: offered });
  if (!offered) return null;
  if (q.error) return <RefusalMessage error={q.error.error} />;
  const v = q.data;
  if (!v) return null;
  return (
    <section className={wcls('section')} aria-label="Plant for this step" data-testid="step-plant">
      <h2 className={wcls('sectionTitle')}>Plant for this step</h2>
      {view.step.block === 'G-10@2' ? <AreaPanel v={v} view={view} /> : null}
      {view.step.block === 'G-09@2' ? <EquipmentPanel v={v} view={view} /> : null}
      {view.step.block === 'TB-09@1' ? <ToolingPanel v={v} /> : null}
      {view.step.block === 'TB-10@1' ? <PressSetupPanel v={v} /> : null}
      {view.step.block === 'TB-16@1' ? <LayerChargePanel v={v} recorded={new Set(view.entries.filter((e) => e.kind === 'HOPPER_CHARGE').map((e) => (typeof e.data['chargeId'] === 'string' ? e.data['chargeId'] : '')))} /> : null}
    </section>
  );
}

// ---------------------------------------------------------------------------------------------
// G-10@2: the room or line the batch uses

function AreaPanel({ v, view }: { v: StepPlantView; view: StepScreenView }) {
  const choices = useStepChoices();
  // R3.3 (D-7k-2): the start of the room's use and its record in the step are one act (one badge tap).
  const start = useCommand(plantEntryRoute(), READ_WITH_STEP, 'starting the use of the room and recording it in this step');
  const end = useCommand(routes.plant.endAreaOccupancy, READ, 'ending the use of the room');
  const busy = start.busy || end.busy;
  const occupied = new Set(v.occupancies.map((o) => o.areaCode));
  const record = (areaCode: string, occupancyId: string) => choices?.choose('AREA_OCCUPANCY', { areaCode, occupancyId });
  return (
    <div data-testid="plant-area">
      {v.occupancies.map((o) => (
        <div key={o.occupancyId} data-testid={`occupancy-${o.areaCode}`}>
          <p>
            <StatusChip tone="ok" label={`${o.areaCode} in use`} /> by batch {o.batchNumber} for {o.stage}, started by {o.startedBy.legalName} at {o.startedAt.text}
          </p>
          {recorded(view, 'AREA_OCCUPANCY', 'occupancyId', o.occupancyId) ? (
            <p className={wcls('muted')}>{`Recorded in this step.`}</p>
          ) : o.mine ? (
            <Button variant="secondary" isDisabled={busy} onPress={() => record(o.areaCode, o.occupancyId)}>
              {`Record ${o.areaCode} in this step`}
            </Button>
          ) : (
            <p className={wcls('muted')}>Started by another person: the step names only your own start.</p>
          )}
          <Button isDisabled={busy} onPress={() => void end.run({ params: { occupancyId: o.occupancyId }, body: {} })}>
            {`End the use of ${o.areaCode}`}
          </Button>
        </div>
      ))}
      {v.stage === null ? <p className={wcls('muted')}>The step belongs to no stage: no room can be used for it.</p> : null}
      {v.areas.length === 0 ? <p className={wcls('muted')}>The stage names no room or line.</p> : null}
      {v.stage !== null
        ? v.areas
            .filter((a) => !occupied.has(a.code))
            .map((a) => {
              const line = a.kind === 'LINE' ? v.lineClearances.find((c) => c.areaCode === a.code) : undefined;
              const what = a.kind === 'LINE' ? 'line' : 'room';
              return (
                <div key={a.code}>
                  {a.kind === 'LINE' && !line ? <p className={wcls('muted')}>{`Line ${a.code} has no verified clearance for an order of this batch yet.`}</p> : null}
                  <Button
                    variant="secondary"
                    isDisabled={busy || (a.kind === 'LINE' && !line)}
                    onPress={() =>
                      void start.run({
                        params: plantEntryParams(v.batchId, view.step.stepKey),
                        body: { expectedVersion: view.run.version, act: { act: 'START_AREA_OCCUPANCY', areaCode: a.code, ...(line ? { order: line.order, artworkSet: line.artworkSet } : {}) } },
                      })
                    }
                  >
                    {`Start using ${what} ${a.code} and record it in this step`}
                  </Button>
                </div>
              );
            })
        : null}
      <ActResult error={start.error ?? end.error} />
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// G-09@2: the units the step checks

function EquipmentPanel({ v, view }: { v: StepPlantView; view: StepScreenView }) {
  if (v.equipment.length === 0) return <p className={wcls('muted')}>This step checks no unit of the stage.</p>;
  return (
    <div data-testid="plant-equipment">
      {v.equipment.map((e) => (
        <UnitRef key={e.ref} v={v} e={e} view={view} />
      ))}
    </div>
  );
}

function UnitRef({ v, e, view }: { v: StepPlantView; e: StepPlantView['equipment'][number]; view: StepScreenView }) {
  const choices = useStepChoices();
  const check = useCommand(routes.plant.recordInstrumentCheck, READ, 'the per-use check');
  // R3.3 (D-7k-2): the booking (an instrument) or the start of the use (a process unit) and its record in the step are
  // one act (one badge tap); the server books or starts as the master's stage binding says.
  const book = useCommand(plantEntryRoute(), READ_WITH_STEP, 'booking the unit and recording it in this step');
  const endUse = useCommand(routes.plant.endEquipmentUse, READ, 'ending the use of the unit');
  const [picked, setPicked] = useState<string | null>(null);
  const [hours, setHours] = useState<string | null>('12');
  const [reference, setReference] = useState('Per-use check');
  const unit = picked ?? (e.units.length === 1 ? (e.units[0]?.code ?? null) : null);
  const codes = new Set(e.units.map((u) => u.code));
  const uses = v.uses.filter((u) => codes.has(u.equipmentCode));
  const busy = check.busy || book.busy || endUse.busy;
  const record = (equipmentCode: string, useId: string) => choices?.choose('EQUIPMENT_USE', { equipmentRef: e.ref, equipmentCode, useId });
  const instrument = e.kind === 'INSTRUMENT';
  const chosen = e.units.find((u) => u.code === unit);
  return (
    <section className={wcls('formCard')} aria-label={`Unit ${e.ref}`} data-testid={`plant-unit-${e.ref}`}>
      <h3 className={wcls('formTitle')}>
        {e.ref} ({e.kind.toLowerCase()}, class {e.classCode})
      </h3>
      {uses.map((u) => (
        <div key={u.useId} data-testid={`use-${u.equipmentCode}`}>
          <p>
            <StatusChip tone="ok" label={`${u.equipmentCode} booked until ${u.plannedEnd.text}`} /> for batch {u.batchNumber}, by {u.startedBy.legalName}
          </p>
          {recorded(view, 'EQUIPMENT_USE', 'useId', u.useId) ? (
            <p className={wcls('muted')}>{`Recorded in this step for ${e.ref}.`}</p>
          ) : u.mine ? (
            <Button variant="secondary" isDisabled={busy} onPress={() => record(u.equipmentCode, u.useId)}>
              {`Record ${u.equipmentCode} for ${e.ref} in this step`}
            </Button>
          ) : (
            <p className={wcls('muted')}>Booked by another person: the step names only your own booking.</p>
          )}
          {u.kind === 'PROCESS' ? (
            <Button isDisabled={busy} onPress={() => void endUse.run({ params: { useId: u.useId }, body: {} })}>
              {`End the use of ${u.equipmentCode}`}
            </Button>
          ) : null}
        </div>
      ))}
      {e.units.length === 0 ? <p className={wcls('muted')}>{`No unit of class ${e.classCode} is in the plant list.`}</p> : null}
      {e.units.length > 1 ? (
        <floor.ChoiceGroup label={`Unit for ${e.ref}`} options={e.units.map((u) => ({ value: u.code, label: `${u.code} ${u.name}${u.areaCode ? ` (${u.areaCode})` : ''}` }))} value={unit} onChange={setPicked} isDisabled={busy} />
      ) : null}
      {chosen ? (
        <>
          <p className={wcls('muted')}>
            {chosen.code} {chosen.name}: {chosen.fitness ?? 'fitness unknown'}
            {chosen.lastCheck ? `; last check ${chosen.lastCheck.result} at ${chosen.lastCheck.at.text}${chosen.lastCheck.mine ? ' (yours)' : ''}` : '; not checked for this batch'}
          </p>
          {instrument ? (
            <>
              <Field name={`checkReference-${e.ref}`} label="Check reference (weights, procedure)" value={reference} onChange={setReference} />
              <div className={wcls('row')}>
                <Button isDisabled={busy || reference.trim() === ''} onPress={() => void check.run({ params: { code: chosen.code }, body: { result: 'PASS', reference: reference.trim(), batchId: v.batchId } })}>
                  {`Per-use check of ${chosen.code} passed`}
                </Button>
                <Button isDisabled={busy || reference.trim() === ''} onPress={() => void check.run({ params: { code: chosen.code }, body: { result: 'FAIL', reference: reference.trim(), batchId: v.batchId } })}>
                  {`Per-use check of ${chosen.code} failed`}
                </Button>
              </div>
            </>
          ) : null}
          {/* R3.4: a unit booked for the batch is not booked again (the database would refuse it): it shows until when. */}
          {uses.some((u) => u.equipmentCode === chosen.code) ? null : (
            <>
              <floor.ChoiceGroup label="Planned use" options={HOURS} value={hours} onChange={setHours} isDisabled={busy} />
              <Button
                variant="secondary"
                isDisabled={busy || hours === null}
                onPress={() =>
                  void book.run({
                    params: plantEntryParams(v.batchId, view.step.stepKey),
                    body: { expectedVersion: view.run.version, act: { act: 'BOOK_UNIT', equipmentRef: e.ref, code: chosen.code, plannedHours: hours ?? '12' } },
                  })
                }
              >
                {`Book ${chosen.code} and record it in this step`}
              </Button>
            </>
          )}
        </>
      ) : null}
      <ActResult error={check.error ?? book.error ?? endUse.error} done={check.done} label={check.done ? `Check recorded: ${check.done.result}.` : ''} />
    </section>
  );
}

// ---------------------------------------------------------------------------------------------
// TB-09@1: press tooling

function Checklist({ items, value, onChange, disabled }: { items: readonly string[]; value: Record<string, boolean>; onChange: (v: Record<string, boolean>) => void; disabled: boolean }) {
  return (
    <>
      {items.map((item) => (
        <floor.ChoiceGroup
          key={item}
          label={title(item)}
          options={[
            { value: 'YES', label: 'In order' },
            { value: 'NO', label: 'Not in order' },
          ]}
          value={item in value ? yesNo(value[item] === true) : null}
          onChange={(x) => onChange({ ...value, [item]: x === 'YES' })}
          isDisabled={disabled}
        />
      ))}
    </>
  );
}

const DISPOSITIONS = ['REPAIR', 'POLISH', 'RETIRE'].map((d) => ({ value: d, label: title(d) }));

function ToolingInspection({ v, set, issueId, when }: { v: StepPlantView; set: string; issueId?: string; when: 'BEFORE' | 'AFTER' }) {
  const choices = useStepChoices();
  const inspect = useCommand(routes.plant.inspectTooling, READ, 'a tooling inspection');
  const [findings, setFindings] = useState<Record<string, boolean>>({});
  const [disposition, setDisposition] = useState<string | null>(null);
  const items = v.tooling.checklist;
  const complete = items.every((i) => i in findings);
  const failed = items.some((i) => findings[i] === false);
  return (
    <div data-testid={`tooling-inspect-${when}-${set}`}>
      <Checklist items={items} value={findings} onChange={setFindings} disabled={inspect.busy} />
      {failed ? <floor.ChoiceGroup label="Disposition of the set" options={DISPOSITIONS} value={disposition} onChange={setDisposition} isDisabled={inspect.busy} /> : null}
      <Button
        variant="secondary"
        isDisabled={inspect.busy || !complete || (failed && disposition === null)}
        onPress={() => void (async () => {
          const body = {
            kind: when === 'BEFORE' ? ('PRE_USE' as const) : ('POST_USE' as const),
            findings,
            ...(issueId ? { issueId } : {}),
            ...(failed && disposition ? { disposition: disposition as 'REPAIR' | 'POLISH' | 'RETIRE' } : {}),
          };
          const r = await inspect.run({ params: { set }, body });
          if (r) {
            setFindings({});
            setDisposition(null);
            choices?.choose('TOOLING_INSPECTED', { set, inspectionId: r.inspectionId, when, result: r.result });
          }
        })()}
      >
        {when === 'BEFORE' ? `Inspect set ${set} before use` : `Inspect set ${set} after use`}
      </Button>
      <ActResult error={inspect.error} done={inspect.done} label={inspect.done ? `Inspection ${inspect.done.result}${inspect.done.held.length > 0 ? `: press output held (${inspect.done.held.join(', ')})` : ''}.` : ''} />
    </div>
  );
}

function ToolingPanel({ v }: { v: StepPlantView }) {
  const choices = useStepChoices();
  const issue = useCommand(routes.plant.issueTooling, READ, 'issuing tooling');
  const [setCode, setSetCode] = useState<string | null>(null);
  const [press, setPress] = useState<string | null>(null);
  const [counts, setCounts] = useState<Record<string, string>>({});
  const set = v.tooling.sets.find((s) => s.code === (setCode ?? (v.tooling.sets.length === 1 ? v.tooling.sets[0]?.code : undefined)));
  const presses = [...new Set(v.uses.filter((u) => u.kind === 'PROCESS').map((u) => u.equipmentCode))];
  const pressCode = press ?? (presses.length === 1 ? (presses[0] ?? null) : null);
  const pre = set ? v.tooling.preUse.find((p) => p.set === set.code) : undefined;
  const n = (k: 'upper' | 'lower' | 'dies') => counts[k] ?? (set ? String(set[k]) : '');
  return (
    <div data-testid="plant-tooling">
      {v.tooling.sets.length === 0 ? <p className={wcls('muted')}>No tooling set is defined for the product.</p> : null}
      {v.tooling.sets.length > 1 ? (
        <floor.ChoiceGroup label="Tooling set" options={v.tooling.sets.map((s) => ({ value: s.code, label: `${s.code}${s.issuedNow ? ' (issued)' : ''}` }))} value={set?.code ?? null} onChange={setSetCode} />
      ) : null}
      {set && !set.issuedNow ? (
        <section className={wcls('formCard')} aria-label={`Set ${set.code} before use`}>
          <h3 className={wcls('formTitle')}>{`Set ${set.code}: before use`}</h3>
          {pre ? (
            <p>
              {`Inspected before use: ${pre.result} at ${pre.at.text}. `}
              <Button onPress={() => choices?.choose('TOOLING_INSPECTED', { set: pre.set, inspectionId: pre.inspectionId, when: 'BEFORE', result: pre.result })}>
                {`Record the inspection of ${pre.set} in this step`}
              </Button>
            </p>
          ) : null}
          <ToolingInspection key={`pre-${set.code}`} v={v} set={set.code} when="BEFORE" />
          {presses.length === 0 ? <p className={wcls('muted')}>No press is in use by the batch: book the press at its status step first.</p> : null}
          {presses.length > 1 ? <floor.ChoiceGroup label="Press" options={presses.map((p) => ({ value: p, label: p }))} value={pressCode} onChange={setPress} /> : null}
          {(['upper', 'lower', 'dies'] as const).map((k) => (
            <Field key={k} name={`count-${k}`} label={`${title(k)} ${k === 'dies' ? '' : 'punches '}issued`} value={n(k)} onChange={(x) => setCounts((c) => ({ ...c, [k]: x }))} inputMode="numeric" />
          ))}
          <Button
            variant="secondary"
            isDisabled={issue.busy || pressCode === null}
            onPress={() => void (async () => {
              if (!pressCode) return;
              const r = await issue.run({ params: { set: set.code }, body: { batchId: v.batchId, press: pressCode, counts: { upper: n('upper'), lower: n('lower'), dies: n('dies') } } });
              if (r) {
                setCounts({});
                choices?.choose('TOOLING_ISSUED', { set: r.set, issueId: r.issueId, press: r.press });
              }
            })()}
          >
            {`Issue set ${set.code} to ${pressCode ?? 'the press'}`}
          </Button>
          <ActResult error={issue.error} />
        </section>
      ) : null}
      {v.tooling.issues.map((x) => (
        <ToolingIssue key={x.issueId} v={v} x={x} />
      ))}
    </div>
  );
}

function ToolingIssue({ v, x }: { v: StepPlantView; x: StepPlantView['tooling']['issues'][number] }) {
  const choices = useStepChoices();
  const ret = useCommand(routes.plant.returnTooling, READ, 'returning tooling');
  const [counts, setCounts] = useState<Record<string, string>>({});
  const [strokes, setStrokes] = useState('');
  const n = (k: 'upper' | 'lower' | 'dies') => counts[k] ?? String(x.counts[k]);
  const r = x.returned;
  return (
    <section className={wcls('formCard')} aria-label={`Set ${x.set} issued to ${x.press}`} data-testid={`tooling-issue-${x.set}`}>
      <h3 className={wcls('formTitle')}>{`Set ${x.set} issued to ${x.press} (${String(x.counts.upper)}/${String(x.counts.lower)}/${String(x.counts.dies)})`}</h3>
      <Button onPress={() => choices?.choose('TOOLING_ISSUED', { set: x.set, issueId: x.issueId, press: x.press })}>{`Record the issue of ${x.set} in this step`}</Button>
      {r ? (
        <>
          <p>
            {`Returned: ${r.strokes} strokes (${r.strokeSource === 'MANUAL' ? 'keyed from the press' : 'press counter'})`}
            {r.countMismatch ? '; the counts do not match the issue' : ''}
            {r.limitExceeded ? '; the stroke limit is passed' : ''}
          </p>
          <Button onPress={() => choices?.choose('TOOLING_RETURNED', { set: x.set, issueId: x.issueId, strokes: r.strokes, strokeSource: r.strokeSource, countMismatch: yesNo(r.countMismatch), limitExceeded: yesNo(r.limitExceeded) })}>
            {`Record the return of ${x.set} in this step`}
          </Button>
          {x.postUse ? (
            <p>
              {`Inspected after use: ${x.postUse.result}. `}
              <Button onPress={() => x.postUse && choices?.choose('TOOLING_INSPECTED', { set: x.set, inspectionId: x.postUse.inspectionId, when: 'AFTER', result: x.postUse.result })}>
                {`Record the inspection after use of ${x.set} in this step`}
              </Button>
            </p>
          ) : (
            <ToolingInspection v={v} set={x.set} issueId={x.issueId} when="AFTER" />
          )}
        </>
      ) : (
        <>
          {(['upper', 'lower', 'dies'] as const).map((k) => (
            <Field key={k} name={`return-${k}`} label={`${title(k)} ${k === 'dies' ? '' : 'punches '}returned`} value={n(k)} onChange={(c) => setCounts((s) => ({ ...s, [k]: c }))} inputMode="numeric" />
          ))}
          <Field name="manualStrokes" label="Strokes read from the press (only when the press counter did not see the whole use)" value={strokes} onChange={setStrokes} inputMode="numeric" />
          <Button
            variant="secondary"
            isDisabled={ret.busy}
            onPress={() => void (async () => {
              const out = await ret.run({ params: { issueId: x.issueId }, body: { counts: { upper: n('upper'), lower: n('lower'), dies: n('dies') }, ...(strokes.trim() !== '' ? { manualStrokes: strokes.trim() } : {}) } });
              if (out) {
                setStrokes('');
                choices?.choose('TOOLING_RETURNED', { set: x.set, issueId: x.issueId, strokes: out.strokes, strokeSource: out.strokeSource, countMismatch: yesNo(out.countMismatch), limitExceeded: yesNo(out.limitExceeded) });
              }
            })()}
          >
            {`Return set ${x.set}`}
          </Button>
          <ActResult error={ret.error} />
        </>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------------------------
// TB-10@1: the press set up with its tooling, and the hopper charged

function PressSetupPanel({ v }: { v: StepPlantView }) {
  const choices = useStepChoices();
  const charge = useCommand(routes.plant.chargeContainer, READ, 'charging a container');
  const [label, setLabel] = useState('');
  const presses = v.uses.filter((u) => u.kind === 'PROCESS' && u.mine);
  const open = v.tooling.issues.filter((x) => x.returned === null);
  const send = async (scanned: string) => {
    // The charge names the plant stage the container goes into (as containers name theirs: BLENDING, COMPRESSION), not the
    // master's stage id (S-COMP, which the contract's stage code refuses): a press set-up step charges the press hopper.
    const r = await charge.run({ body: { batchId: v.batchId, stage: 'COMPRESSION', label: scanned } });
    if (r) {
      setLabel('');
      choices?.choose('HOPPER_CHARGE', { chargeId: r.chargeId });
    }
  };
  return (
    <div data-testid="plant-press-setup">
      <section className={wcls('formCard')} aria-label="Press and tooling">
        <h3 className={wcls('formTitle')}>Press and tooling</h3>
        {presses.length === 0 ? <p className={wcls('muted')}>No press use of yours is open for the batch: book the press at its status step.</p> : null}
        {presses.flatMap((u) =>
          open
            .filter((x) => x.press === u.equipmentCode)
            .map((x) => (
              <Button key={`${u.useId}:${x.issueId}`} variant="secondary" onPress={() => choices?.choose('PRESS_SETUP', { press: u.equipmentCode, useId: u.useId, issueId: x.issueId })}>
                {`Set up ${u.equipmentCode} with set ${x.set}`}
              </Button>
            )),
        )}
        {presses.length > 0 && open.length === 0 ? <p className={wcls('muted')}>No tooling is issued to the press: issue it at the tooling step.</p> : null}
      </section>
      <section className={wcls('formCard')} aria-label="Hopper charge">
        <h3 className={wcls('formTitle')}>Hopper charge</h3>
        {v.containers.length === 0 ? <p className={wcls('muted')}>No closed container of the batch waits to be charged.</p> : null}
        <ul className={wcls('list')}>
          {v.containers.map((c) => (
            <li key={c.containerId} data-testid={`chargeable-${c.label}`}>
              {c.label} ({c.stage}, {c.netQuantity ?? '?'} {c.unit}){c.problem ? `: ${c.problem}` : ''}{' '}
              <Button isDisabled={charge.busy || c.problem !== null} onPress={() => void send(c.label)}>
                {`Charge container ${c.label}`}
              </Button>
            </li>
          ))}
        </ul>
        <Field name="chargeLabel" label="Or scan the container label" value={label} onChange={setLabel} autoComplete="off" />
        <Button isDisabled={charge.busy || label.trim() === ''} onPress={() => void send(label.trim())}>
          Charge the scanned container
        </Button>
        {v.charges
          .filter((g) => g.mine)
          .map((g) => (
            <p key={g.chargeId}>
              {`Charged ${g.label} at ${g.chargedAt.text}. `}
              <Button onPress={() => choices?.choose('HOPPER_CHARGE', { chargeId: g.chargeId })}>{`Record the charge of ${g.label} in this step`}</Button>
            </p>
          ))}
        <ActResult error={charge.error} />
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// TB-16@1: each layer's hopper charged with a container of that layer's blend (slice 7m, R1)

function LayerChargePanel({ v, recorded }: { v: StepPlantView; recorded: ReadonlySet<string> }) {
  const choices = useStepChoices();
  const charge = useCommand(routes.plant.chargeContainer, READ, 'charging a container');
  const record = (l: StepPlantView['layers'][number], chargeId: string) => choices?.choose('HOPPER_CHARGE', { layer: l.id, hopper: l.hopper, blend: l.stage, chargeId });
  const send = async (l: StepPlantView['layers'][number], label: string) => {
    // As at the press set-up: the charge names the plant stage the container goes into, the press hopper.
    const r = await charge.run({ body: { batchId: v.batchId, stage: 'COMPRESSION', label } });
    if (r) record(l, r.chargeId);
  };
  return (
    <div data-testid="plant-layer-charge">
      {v.layers.map((l) => {
        const ready = v.containers.filter((c) => c.stage === l.stage);
        // A charge recorded in the step already is not offered again (the block and the database refuse a second entry).
        const charged = v.charges.filter((g) => g.mine && v.chargedStages[g.chargeId] === l.stage && !recorded.has(g.chargeId));
        return (
          <section key={l.id} className={wcls('formCard')} aria-label={`Layer ${l.id}`} data-testid={`layer-${l.id}`}>
            <h3 className={wcls('formTitle')}>{`Layer ${l.id}: hopper ${l.hopper}, blend ${l.stage}`}</h3>
            {ready.length === 0 ? <p className={wcls('muted')}>{`No closed container of ${l.stage} waits to be charged.`}</p> : null}
            <ul className={wcls('list')}>
              {ready.map((c) => (
                <li key={c.containerId} data-testid={`chargeable-${c.label}`}>
                  {c.label} ({c.netQuantity ?? '?'} {c.unit}){c.problem ? `: ${c.problem}` : ''}{' '}
                  <Button isDisabled={charge.busy || c.problem !== null} onPress={() => void send(l, c.label)}>
                    {`Charge ${c.label} into hopper ${l.hopper}`}
                  </Button>
                </li>
              ))}
            </ul>
            {charged.map((g) => (
              <p key={g.chargeId}>
                {`Charged ${g.label} at ${g.chargedAt.text}. `}
                <Button onPress={() => record(l, g.chargeId)}>{`Record the charge of ${g.label} into hopper ${l.hopper}`}</Button>
              </p>
            ))}
          </section>
        );
      })}
      <ActResult error={charge.error} />
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// G-21@1: a printed packaging lot issued to the line

function PrintedLotPanel({ view }: { view: StepScreenView }) {
  const choices = useStepChoices();
  const [scan, setScan] = useState('');
  const [asked, setAsked] = useState('');
  const q = useApiQuery(routes.batches.printedLot, { params: { batchId: view.run.runId, code: asked } }, { enabled: asked !== '', retry: false });
  const facts = asked !== '' ? q.data : undefined;
  // The lot goes to the issue entry once per "Take the lot" (slice 7k): the effect used to run again whenever the
  // choices changed or the lot was read again, so the saved issue form reopened at once with the same lot.
  const [taken, setTaken] = useState(0);
  const handed = useRef<string | null>(null);
  const choose = choices?.choose;
  useEffect(() => {
    if (!facts || !choose) return;
    const key = `${String(taken)}:${facts.id}`;
    if (handed.current === key) return;
    handed.current = key;
    choose('ISSUE', { lot: { id: facts.id, material: facts.material, status: facts.status, artwork: facts.artwork, ...(facts.expiresAtUs ? { expiresAtUs: facts.expiresAtUs } : {}) } });
  }, [facts, choose, taken]);
  return (
    <section className={wcls('section')} aria-label="Printed packaging lot" data-testid="printed-lot">
      <h2 className={wcls('sectionTitle')}>Printed packaging lot</h2>
      <p className={wcls('muted')}>Scan the lot label: the issue entry takes the lot as the register holds it. Type the artwork you read on the label in the entry yourself.</p>
      <Field name="printedLot" label="Scan the printed packaging lot" value={scan} onChange={setScan} autoComplete="off" />
      <Button variant="secondary" isDisabled={scan.trim() === ''} onPress={() => {
          setAsked(scan.trim());
          setTaken((n) => n + 1);
        }}>
        Take the lot from the register
      </Button>
      {facts ? (
        <p data-testid="printed-lot-facts">
          <StatusChip tone="ok" label={`${facts.id} ${facts.status}`} /> {facts.material}, artwork {facts.artwork}: chosen for the issue entry
        </p>
      ) : null}
      {asked !== '' && q.error ? <RefusalMessage error={q.error.error} /> : null}
    </section>
  );
}
