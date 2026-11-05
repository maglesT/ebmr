/**
 * Floor acts on the step screen beside the block's entries (Phase 7 slice 7g, WP4; decision 0025: every act has a screen):
 *  - a process step (a block taking SETPOINT_READBACK entries: G-06@1 and the tablet blocks built on it): the process
 *    device and plant units it is bound to, binding them, and an MBR setpoint downloaded to the bound device;
 *  - a G-21@1 packaging step: the record's coding the coder prints while no batch data is recorded (slice 7h, gap report
 *    D2), the batch data the database computed with the MRP a person gives, a new version with the
 *    person's reason, the second person's check of an MRP (IN-31) and a print job released to a printer of the step
 *    (PR-36);
 *  - a TB-17@1 step: a metal-detector or reject-gate challenge with its test pieces (IN-36); the CHALLENGE entry then
 *    names the challenge the server answered;
 *  - a TB-08@1 step (slice 7m, R1): the quality unit's authorised uses of reserved residue at this step, each opening the
 *    ADDITION entry with its container and authorisation (never an identifier typed).
 * Every choice offered is the server's (devices.stepBindings, execution.packagingBatchData); every act is one command
 * of the signed-in person (a fresh badge tap on a shared terminal, FRESH_ON_SHARED) and every rule is the database's:
 * its refusal is shown in its own words. Nothing typed is kept once sent or closed.
 */
import { useState } from 'react';
import { routes, TABLET_ENTRY_KINDS_BY_BLOCK, type StepScreenView } from '@ebmr/api-contract';
import { Button, Field, floor, StatusChip } from '@ebmr/ui-kit';
import { ActResult, useCommand } from '../../../app/acts.tsx';
import { useApiQuery } from '../../../api/hooks.ts';
import { RefusalMessage } from '../../../app/refusal.tsx';
import { wcls } from '../classes.ts';
import { useStepChoices } from '../choices.tsx';

const BINDINGS = [routes.devices.stepBindings.id];
const BATCH_DATA = [routes.execution.packagingBatchData.id];

/** Whether the step's block takes values from a process device (its entries include a setpoint read-back). */
export function isProcessStep(view: StepScreenView): boolean {
  const kinds = view.step.block ? (TABLET_ENTRY_KINDS_BY_BLOCK as Readonly<Record<string, readonly string[]>>)[view.step.block] : undefined;
  return kinds?.includes('SETPOINT_READBACK') ?? false;
}

export function StepFloorActs({ view }: { view: StepScreenView }) {
  return (
    <>
      {isProcessStep(view) ? <StepDevicePanel view={view} /> : null}
      {view.step.block === 'G-21@1' ? <PackagingBatchDataPanel view={view} /> : null}
      {view.step.block === 'TB-17@1' ? <DetectorChallengePanel view={view} /> : null}
      {view.step.block === 'TB-08@1' ? <ReprocessingSourcePanel view={view} /> : null}
    </>
  );
}

function StepDevicePanel({ view }: { view: StepScreenView }) {
  const target = { batchId: view.run.runId, stepKey: view.step.stepKey };
  const q = useApiQuery(routes.devices.stepBindings, { query: target });
  const bindDevice = useCommand(routes.devices.bindStepDevice, BINDINGS, 'binding the process device of the step');
  const bindUnit = useCommand(routes.devices.bindStepEquipment, BINDINGS, 'binding a plant unit to the step');
  const download = useCommand(routes.devices.requestSetpointDownload, BINDINGS, 'a setpoint download to the device');
  const [device, setDevice] = useState<string | null>(null);
  const [unit, setUnit] = useState<string | null>(null);
  const d = q.data;
  const busy = bindDevice.busy || bindUnit.busy || download.busy;
  const boundUnits = new Set(d?.equipment.map((e) => e.code) ?? []);
  const freeUnits = d?.unitsInUse.filter((u) => !boundUnits.has(u.code)) ?? [];
  return (
    <section className={wcls('section')} aria-label="Device and equipment of the step" data-testid="step-device">
      <h2 className={wcls('sectionTitle')}>Device and equipment of the step</h2>
      {q.error ? <RefusalMessage error={q.error.error} /> : null}
      {d ? (
        <>
          {d.device ? (
            <p data-testid="step-device-bound">
              Process device {d.device.code}, bound by {d.device.boundBy.legalName} at {d.device.boundAt.text}
            </p>
          ) : d.devices.length === 0 ? (
            <p className={wcls('muted')}>No active process device to bind.</p>
          ) : (
            <>
              <floor.ChoiceGroup
                label="Process device"
                description="The device linked to the plant unit this step runs on."
                isDisabled={busy}
                options={d.devices.map((x) => ({ value: x.code, label: `${x.code} (${x.equipmentKind.toLowerCase()}${x.unitCode ? `, unit ${x.unitCode}` : ''})` }))}
                value={device}
                onChange={setDevice}
              />
              <Button
                variant="secondary"
                isDisabled={!device || busy}
                onPress={() => {
                  if (device) void bindDevice.run({ body: { ...target, deviceCode: device } }).then((r) => r && setDevice(null));
                }}
              >
                Bind the device
              </Button>
              <ActResult error={bindDevice.error} done={bindDevice.done} label="Device bound." />
            </>
          )}
          <ul aria-label="Plant units of the step">
            {d.equipment.map((e) => (
              <li key={e.code}>
                Unit {e.code} {e.name}, bound by {e.boundBy.legalName} at {e.boundAt.text}
              </li>
            ))}
          </ul>
          {freeUnits.length > 0 ? (
            <>
              <floor.ChoiceGroup label="Plant unit in use by the batch" isDisabled={busy} options={freeUnits.map((u) => ({ value: u.code, label: `${u.code} ${u.name}` }))} value={unit} onChange={setUnit} />
              <Button
                isDisabled={!unit || busy}
                onPress={() => {
                  if (unit) void bindUnit.run({ body: { ...target, equipmentCode: unit } }).then((r) => r && setUnit(null));
                }}
              >
                Bind the unit to the step
              </Button>
              <ActResult error={bindUnit.error} done={bindUnit.done} label="Unit bound." />
            </>
          ) : null}
          {d.setpoints.length > 0 ? (
            <ul aria-label="Setpoints of the MBR" data-testid="step-setpoints">
              {d.setpoints.map((s) => (
                <li key={s.tag}>
                  {s.tag}: {s.value} {s.unit} {s.waiting ? <StatusChip tone="warning" label="Waiting for the gateway" /> : null}{' '}
                  <Button isDisabled={busy || !d.device || s.waiting} onPress={() => void download.run({ body: { ...target, tag: s.tag } })}>
                    {`Download ${s.tag} to the device`}
                  </Button>
                </li>
              ))}
            </ul>
          ) : null}
          <ActResult error={download.error} done={download.done} label="Download requested: the gateway fetches it and reads it back." />
        </>
      ) : null}
    </section>
  );
}

function PackagingBatchDataPanel({ view }: { view: StepScreenView }) {
  const target = { batchId: view.run.runId, stepKey: view.step.stepKey };
  const q = useApiQuery(routes.execution.packagingBatchData, { query: target });
  // Slice 7h (gap report D2): with no batch data recorded, the coder is set up with the record's own coding (the batch
  // number, manufacture date and expiry the database computes; tab.g21_expected_coding), shown here as the coder's data.
  const completion = useApiQuery(routes.labels.packaging, { params: { batchId: view.run.runId } });
  const recordCoding = completion.data?.steps.find((x) => x.stepKey === view.step.stepKey)?.expectedCoding ?? null;
  const record = useCommand(routes.execution.recordPackagingBatchData, BATCH_DATA, 'the batch data of the packaging step');
  const check = useCommand(routes.execution.checkPackagingBatchData, BATCH_DATA, 'the check of the batch data');
  const release = useCommand(routes.execution.releasePrintJob, BATCH_DATA, 'releasing a print job');
  const [mrp, setMrp] = useState('');
  const [reason, setReason] = useState('');
  const [device, setDevice] = useState('');
  const [layout, setLayout] = useState('');
  const c = q.data?.current ?? null;
  const busy = record.busy || check.busy || release.busy;
  const needsReason = c !== null;
  const send = async () => {
    const body = { ...target, ...(mrp.trim() !== '' ? { mrp: mrp.trim() } : {}), ...(needsReason ? { reason: reason.trim() } : {}) };
    if (await record.run({ body })) {
      setMrp('');
      setReason('');
    }
  };
  return (
    <section className={wcls('section')} aria-label="Batch data and print jobs" data-testid="packaging-batch-data">
      <h2 className={wcls('sectionTitle')}>Batch data and print jobs</h2>
      {q.error ? <RefusalMessage error={q.error.error} /> : null}
      {c ? (
        <div data-testid="batch-data-current" data-version={c.version}>
          <p>
            Version {c.version}: {Object.entries(c.fields).map(([k, v]) => `${k} ${v}`).join(' · ')}
          </p>
          <p className={wcls('muted')}>
            Given by {c.recordedBy.legalName} at {c.recordedAt.text}
            {c.reason ? `. Reason: ${c.reason}` : ''}
          </p>
          {'mrp' in c.fields ? (
            c.checkedBy ? (
              <p data-testid="batch-data-checked">
                MRP checked by {c.checkedBy.legalName} at {c.checkedAt?.text ?? ''}
              </p>
            ) : (
              <>
                <p className={wcls('muted')}>The MRP is checked by a second person before a print job carries it (IN-31).</p>
                <Button isDisabled={busy} onPress={() => void check.run({ body: { ...target, version: c.version } })}>
                  {`Check the MRP of version ${String(c.version)}`}
                </Button>
                <ActResult error={check.error} done={check.done} label="Checked." />
              </>
            )
          ) : null}
        </div>
      ) : (
        <>
          <p className={wcls('muted')}>No batch data yet: the database computes the batch number, the dates and the expiry.</p>
          {recordCoding ? (
            <p data-testid="record-coding">
              The coder prints the record&apos;s coding: batch {recordCoding.batch} · manufactured {recordCoding.mfgDate} · expiry {recordCoding.expiryDate}
              {recordCoding.mrp ? ` · MRP ${recordCoding.mrp}` : ''}
            </p>
          ) : null}
        </>
      )}
      <Field name="mrp" label="MRP in rupees (only where the pack shows it)" value={mrp} onChange={setMrp} inputMode="decimal" />
      {needsReason ? <Field name="batchDataReason" label="Reason for the change (the jobs on the earlier data are voided)" value={reason} onChange={setReason} isRequired /> : null}
      <Button variant="secondary" isDisabled={busy || (needsReason && reason.trim() === '')} onPress={() => void send()}>
        {c ? 'Record a new version of the batch data' : 'Record the batch data'}
      </Button>
      <ActResult error={record.error} done={record.done} label="Batch data recorded." />
      {c ? (
        <>
          <Field name="printer" label="Printer of the step" value={device} onChange={setDevice} />
          <Field name="layout" label="Layout reference" value={layout} onChange={setLayout} />
          <Button
            isDisabled={busy || device.trim() === '' || layout.trim() === ''}
            onPress={() =>
              void release.run({ body: { ...target, device: device.trim(), layout: layout.trim() } }).then((r) => {
                if (r) {
                  setDevice('');
                  setLayout('');
                }
              })
            }
          >
            Release the print job
          </Button>
          <ActResult error={release.error} done={release.done} label="Print job released to the printer." />
        </>
      ) : null}
      {q.data && q.data.jobs.length > 0 ? (
        <ul aria-label="Print jobs" data-testid="print-jobs">
          {q.data.jobs.map((j) => (
            <li key={j.jobId}>
              {j.device} {j.layout} on version {j.dataVersion}: <StatusChip tone={j.state === 'VOID' ? 'error' : 'neutral'} label={j.state} /> ({j.releasedBy.legalName}, {j.releasedAt.text})
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

type PieceResult = 'BOTH' | 'DETECTED' | 'MISSED';
const PIECE_OPTIONS: { value: PieceResult; label: string }[] = [
  { value: 'BOTH', label: 'Detected and rejected' },
  { value: 'DETECTED', label: 'Detected, not rejected' },
  { value: 'MISSED', label: 'Not detected' },
];

/**
 * Slice 7m (R1, TB-08): the authorised uses of a closed container of an earlier batch at this step; choosing one opens
 * the ADDITION entry naming the container and the authorisation. The block and the database judge the source again.
 */
function ReprocessingSourcePanel({ view }: { view: StepScreenView }) {
  const choices = useStepChoices();
  const stepId = view.step.stepKey.split('@')[0] ?? view.step.stepKey;
  const auths = useApiQuery(routes.quality.reprocessingAuthorisations, { query: { batchId: view.run.runId } });
  const residues = useApiQuery(routes.quality.residues, { query: {} });
  const labels = new Map((residues.data?.containers ?? []).map((c) => [c.containerId, `${c.label} (${c.batchNumber}, ${c.remaining} ${c.unit} left)`]));
  const usable = (auths.data?.authorisations ?? []).filter((a) => a.stepId === stepId && a.containerId !== null && a.authorisedBy !== null);
  return (
    <section className={wcls('section')} aria-label="Reprocessing sources" data-testid="reprocessing-sources">
      <h2 className={wcls('sectionTitle')}>Reprocessing sources</h2>
      {auths.error ? <RefusalMessage error={auths.error.error} /> : null}
      {usable.length === 0 ? <p className={wcls('muted')}>No authorised use of a residue container waits at this step: the quality unit authorises it on the reprocessing screen.</p> : null}
      <ul className={wcls('list')}>
        {usable.map((a) => {
          const label = labels.get(a.containerId ?? '') ?? 'a container of an earlier batch';
          return (
            <li key={a.authorisationId} data-testid={`source-${a.authorisationId}`}>
              {`${label}, ${a.caseCode.toLowerCase().replace(/_/g, ' ')} authorised by ${a.authorisedBy?.legalName ?? ''} (${a.investigationRef}) `}
              <Button onPress={() => choices?.choose('ADDITION', { container: a.containerId ?? '', authorisation: a.authorisationId })}>{`Take from ${label.split(' ')[0] ?? ''}`}</Button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function DetectorChallengePanel({ view }: { view: StepScreenView }) {
  const challenge = useCommand(routes.execution.recordDetectorChallenge, [], 'a detector challenge');
  const choices = useStepChoices();
  const [press, setPress] = useState('');
  const [device, setDevice] = useState<'METAL_DETECTOR' | 'REJECT_GATE' | null>(null);
  const [deviceCode, setDeviceCode] = useState('');
  const [timing, setTiming] = useState<'START' | 'INTERVAL' | 'AFTER_STOPPAGE' | 'END' | null>(null);
  const [codes, setCodes] = useState('');
  const [results, setResults] = useState<Record<string, PieceResult>>({});
  const pieces = [...new Set(codes.split(/[\s,]+/).map((x) => x.trim()).filter((x) => x !== ''))];
  const complete = press.trim() !== '' && device !== null && deviceCode.trim() !== '' && timing !== null && pieces.length > 0 && pieces.every((p) => results[p] !== undefined);
  const send = async () => {
    if (!complete || !device || !timing) return;
    const r = await challenge.run({
      body: {
        batchId: view.run.runId,
        press: press.trim(),
        device,
        deviceCode: deviceCode.trim(),
        timing,
        pieces: pieces.map((p) => ({ piece: p, detected: results[p] !== 'MISSED', rejected: results[p] === 'BOTH' })),
      },
    });
    if (r) {
      setCodes('');
      setResults({});
      // Slice 7m (R1): the CHALLENGE entry opens naming the challenge the server answered (never a typed identifier).
      choices?.choose('CHALLENGE', { challengeId: r.challengeId, device, timing, passed: r.passed ? 'YES' : 'NO' });
    }
  };
  const done = challenge.done;
  return (
    <section className={wcls('section')} aria-label="Detector challenge" data-testid="detector-challenge">
      <h2 className={wcls('sectionTitle')}>Detector challenge</h2>
      <Field name="press" label="Press (equipment code)" value={press} onChange={setPress} />
      <floor.ChoiceGroup label="Device" options={[{ value: 'METAL_DETECTOR', label: 'Metal detector' }, { value: 'REJECT_GATE', label: 'Reject gate' }]} value={device} onChange={(v) => setDevice(v as 'METAL_DETECTOR' | 'REJECT_GATE')} />
      <Field name="detectorCode" label="Device code" value={deviceCode} onChange={setDeviceCode} />
      <floor.ChoiceGroup
        label="When"
        options={[
          { value: 'START', label: 'Start' },
          { value: 'INTERVAL', label: 'Interval' },
          { value: 'AFTER_STOPPAGE', label: 'After a stoppage' },
          { value: 'END', label: 'End' },
        ]}
        value={timing}
        onChange={(v) => setTiming(v as 'START' | 'INTERVAL' | 'AFTER_STOPPAGE' | 'END')}
      />
      <Field name="pieces" label="Test pieces (codes of the register, separated by commas)" value={codes} onChange={setCodes} />
      {pieces.map((p) => (
        <floor.ChoiceGroup key={p} label={`Test piece ${p}`} options={PIECE_OPTIONS} value={results[p] ?? null} onChange={(v) => setResults({ ...results, [p]: v as PieceResult })} />
      ))}
      <Button variant="secondary" isDisabled={!complete || challenge.busy} onPress={() => void send()}>
        Record the challenge
      </Button>
      {done ? (
        <p data-testid="challenge-result" data-passed={done.passed ? 'yes' : 'no'}>
          {done.passed ? 'Challenge passed.' : `Challenge failed: the press output is held${done.held.length > 0 ? ` (${done.held.join(', ')})` : ''}.`} The challenge entry below names it:
          save it.
        </p>
      ) : null}
      <ActResult error={challenge.error} />
    </section>
  );
}

/**
 * A merge of two output containers of the batch (GMP; recipe-core 0422; IN-26 (c), L-30): both named by their scanned
 * labels (a scanner types into the field); the database checks the same batch, stage and unit, a usable source and an
 * open, unheld target, and answers the target as it is now.
 */
export function MergeContainers() {
  const merge = useCommand(routes.containers.merge, [routes.containers.list.id], 'a merge of two containers');
  const [source, setSource] = useState('');
  const [target, setTarget] = useState('');
  const done = merge.done;
  return (
    <section className={wcls('section')} aria-label="Merge two containers" data-testid="merge-containers">
      <h2 className={wcls('sectionTitle')}>Merge two containers</h2>
      <Field name="mergeSource" label="Scan the container poured out (source label)" value={source} onChange={setSource} autoComplete="off" />
      <Field name="mergeTarget" label="Scan the open container poured into (target label)" value={target} onChange={setTarget} autoComplete="off" />
      <Button
        variant="secondary"
        isDisabled={source.trim() === '' || target.trim() === '' || merge.busy}
        onPress={() =>
          void merge.run({ body: { sourceLabel: source.trim(), targetLabel: target.trim() } }).then((r) => {
            if (r) {
              setSource('');
              setTarget('');
            }
          })
        }
      >
        Merge the containers
      </Button>
      {done ? (
        <p data-testid="merge-result">
          Merged into {done.label} ({done.state.toLowerCase()}).
        </p>
      ) : null}
      <ActResult error={merge.error} />
    </section>
  );
}
