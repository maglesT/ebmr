/**
 * Shop-floor renderers of the tablet blocks TB-01 to TB-24 and of G-06@1, G-21@1 and G-24@2 (Phase 3 slice 6, D-S6-2).
 * Each draws the step's values, its entries so far and the server's own entry forms (GenericBody), then the block's
 * BLOCK_ENTRY forms in the block's own sections (block-entry.tsx). The forms are generated from the block's entry
 * schemas; the layout (which kinds belong together, in which order) is the block's. Additions (TB-08, G-24@2) choose
 * their source from the sources the database lists for the step; TB-24 shows the batch's SSCC register.
 */
import { useState } from 'react';
import { routes, TABLET_ENTRY_KINDS_BY_BLOCK, type AdditionSourceView, type StepScreenView } from '@ebmr/api-contract';
import { Button, Field, StatusChip } from '@ebmr/ui-kit';
import { useQueryClient } from '@tanstack/react-query';
import { useCommand } from '../../../app/acts.tsx';
import { EntryStatus } from '../components/EntryStatus.tsx';
import { useRunCommand } from '../usePendingCall.ts';
import { queryKey, useApiQuery } from '../../../api/hooks.ts';
import { RefusalMessage } from '../../../app/refusal.tsx';
import { wcls } from '../classes.ts';
import { st } from '../text.ts';
import { BlockEntrySections, blockEntryForms, PROCESS_VALUE_KINDS, type EntrySection } from './block-entry.tsx';
import { ScaleStatus } from './G-07@1.tsx';
import { GenericBody } from './Generic.tsx';
import type { BlockRenderer, RendererProps } from './types.ts';

const PROCESS: EntrySection = { title: st('block.processValues'), kinds: PROCESS_VALUE_KINDS };
const RUN = { title: 'Run and stoppages', kinds: ['RUN_START', 'STOPPAGE_START', 'STOPPAGE_END', 'CHANGE', 'RUN_END'] };
const IPC = { title: 'In-process checks', kinds: ['STATION_SWEEP', 'WEIGHT_CHECK', 'WEIGHT_SECOND_STAGE', 'PHYSICAL_CHECK', 'FRIABILITY_RUN', 'DT_START', 'DT_END'] };

/** The sections of each block version, in screen order (kinds not named come last, under "Other entries"). */
export const BLOCK_LAYOUTS: Readonly<Record<string, readonly EntrySection[]>> = {
  'G-06@1': [
    { title: 'Setpoints and recipe', kinds: ['SETPOINT_READBACK', 'RECIPE_CHECK'] },
    { title: 'Actual values', kinds: ['ACTUAL'] },
    { title: 'Alarms and interface', kinds: ['ALARM', 'ALARM_ACK', 'INTERFACE_LOSS'] },
  ],
  'G-21@1': [
    { title: 'Printed materials issued', kinds: ['ISSUE'] },
    { title: 'Coding and first print', kinds: ['FIRST_PRINT'] },
    { title: 'Challenges', kinds: ['CHALLENGE'] },
    { title: 'Serial numbers', kinds: ['SERIAL_POOL', 'SERIAL_RECONCILIATION'] },
    { title: 'Reconciliation', kinds: ['RECONCILIATION'] },
  ],
  'G-24@2': [{ title: 'Addition', kinds: ['ADDITION'] }],
  'TB-01@1': [],
  'TB-01@2': [],
  'TB-02@1': [
    { title: 'Screen checks', kinds: ['SCREEN_CHECK'] },
    { title: 'Material passed', kinds: ['MATERIAL_PASS'] },
  ],
  'TB-03@1': [{ title: 'Binder solution', kinds: ['PREPARED', 'DISCARD'] }],
  'TB-04@1': [PROCESS, { title: 'Wet massing', kinds: ['MASSING_START', 'BINDER_ADDITION', 'EXTRA_FLUID', 'END_POINT'] }],
  'TB-05@1': [PROCESS, { title: 'Drying and LOD', kinds: ['DRYING_START', 'LOD_SAMPLE', 'DRYING_END'] }, { title: 'Filter bags', kinds: ['BAG_CHECK'] }],
  'TB-06@1': [
    PROCESS,
    { title: 'Run', kinds: ['RUN_START', 'FEED', 'RUN_END'] },
    { title: 'Ribbon and screen checks', kinds: ['RIBBON_CHECK', 'SCREEN_CHECK'] },
    { title: 'Output and yield', kinds: ['GRANULE_OUTPUT', 'FINES_RECYCLED', 'YIELD'] },
  ],
  'TB-07@1': [
    PROCESS,
    { title: 'Blending', kinds: ['BLEND_START', 'BLEND_END'] },
    { title: 'Lubrication', kinds: ['LUBRICANT_ADDED', 'LUBRICATION_END'] },
    { title: 'Blend uniformity samples', kinds: ['BU_SAMPLE'] },
  ],
  'TB-08@1': [{ title: 'Addition', kinds: ['ADDITION'] }],
  'TB-09@1': [{ title: 'Punches and dies', kinds: ['TOOLING_INSPECTED', 'TOOLING_ISSUED', 'TOOLING_RETURNED'] }],
  'TB-10@1': [PROCESS, { title: 'Press set-up', kinds: ['PRESS_SETUP', 'PRE_USE_CHECKLIST', 'HOPPER_CHARGE'] }, { title: 'First-off and settings', kinds: ['FIRST_OFF', 'SETTING_CHANGE'] }],
  'TB-11@1': [RUN, IPC],
  'TB-12@1': [{ title: 'Weight checks', kinds: ['WEIGHT_CHECK', 'WEIGHT_SECOND_STAGE'] }],
  'TB-13@1': [{ title: 'Physical checks', kinds: ['PHYSICAL_CHECK'] }],
  'TB-14@1': [{ title: 'Friability', kinds: ['FRIABILITY_RUN'] }],
  'TB-15@1': [{ title: 'Disintegration', kinds: ['DT_START', 'DT_END'] }],
  'TB-16@1': [PROCESS, { title: 'Hopper', kinds: ['HOPPER_CHARGE'] }, RUN, IPC],
  'TB-17@1': [PROCESS, { title: 'Detector challenges', kinds: ['CHALLENGE'] }, { title: 'Rejects', kinds: ['REJECT_COUNT'] }, { title: 'De-dusting', kinds: ['DEDUSTING'] }],
  'TB-18@1': [
    PROCESS,
    { title: 'Room and pan', kinds: ['ROOM_CHECK', 'PAN_LOAD', 'CORE_SAMPLE'] },
    { title: 'Spraying', kinds: ['SPRAY_START', 'SPRAY_END', 'SUSPENSION_USED', 'APPLICATION'] },
    { title: 'Weight gain', kinds: ['WEIGHT_CHECK'] },
  ],
  'TB-19@1': [{ title: 'Printing', kinds: ['PRINT_SETUP', 'PRINT_CHECK'] }],
  'TB-20@1': [{ title: 'Inspection', kinds: ['INSPECTION_START', 'INSPECTION_END'] }, { title: 'Results', kinds: ['SORT_RESULT', 'AQL_RESULT'] }],
  'TB-21@1': [
    PROCESS,
    { title: 'Line set-up', kinds: ['LINE_SETUP', 'EQUIPMENT_CHECK'] },
    { title: 'Run', kinds: ['RUN_START', 'REEL_CHANGE', 'RUN_END'] },
    { title: 'Defect checks', kinds: ['DEFECT_CHECK'] },
    { title: 'Rejects and count', kinds: ['REJECTS', 'COUNT'] },
  ],
  'TB-22@1': [{ title: 'Run', kinds: ['RUN_START', 'EVENT', 'RUN_END'] }, { title: 'Leak tests', kinds: ['LEAK_TEST'] }],
  'TB-23@1': [
    { title: 'Checks', kinds: ['COUNT_CHECK', 'DESICCANT_CHECK', 'TORQUE_CHECK', 'SEAL_CHECK', 'CHALLENGE'] },
    { title: 'Output', kinds: ['REJECTS', 'BRIGHT_STOCK', 'BRIGHT_STOCK_USE', 'GOOD_OUTPUT'] },
  ],
  'TB-24@1': [
    { title: 'Checks', kinds: ['CHALLENGE', 'ATD_CHECK', 'EXAMINATION'] },
    { title: 'Packs', kinds: ['PACKS_MADE', 'REJECTS', 'PACK_SAMPLE', 'SET_ASIDE', 'RE_ENTRY'] },
    { title: 'Shippers', kinds: ['SHIPPER'] },
    { title: 'Reconciliation', kinds: ['RECONCILIATION'] },
  ],
};

/**
 * The step's own values, entries and server forms, without any server form of a BLOCK_ENTRY kind the block forms
 * already offer (the typed kinds, e.g. TB-01's weighing, stay the server's forms).
 */
function OwnBody({ view, weighing = false }: RendererProps & { weighing?: boolean }) {
  const blockKinds = new Set(blockEntryForms(view).map((f) => f.kind as string));
  const own = { ...view, entryForms: view.entryForms.filter((f) => !blockKinds.has(f.kind)) };
  return <GenericBody view={own} {...(weighing ? { forms: () => ({ weighing: true }) } : {})} />;
}

// ---------------------------------------------------------------------------------------------
// Addition sources (TB-08, G-24@2)

function sourceLine(s: AdditionSourceView): string {
  return st('sources.line', {
    label: s.label,
    batch: s.sourceBatchNumber,
    product: s.product,
    intermediate: s.intermediate ? `, ${s.intermediate}` : '',
    remaining: s.remaining,
    unit: s.unit,
    expiry: s.sourceExpiry ? `, expiry ${s.sourceExpiry.text}` : '',
  });
}

/** The sources the database lists for the step, each with its facts and why it cannot be used now (if so). */
export function AdditionSources({ view, chosen, onChoose }: { view: StepScreenView; chosen: string | null; onChoose: (s: AdditionSourceView) => void }) {
  const q = useApiQuery(routes.batches.additionSources, { params: { batchId: view.run.runId, stepKey: view.step.stepKey } });
  if (q.isPending) return <p>{st('loading')}</p>;
  if (q.error) return <RefusalMessage error={q.error.error} />;
  const sources = q.data.sources;
  return (
    <section className={wcls('section')} aria-label={st('sources.title')} data-testid="addition-sources">
      <h3 className={wcls('sectionTitle')}>{st('sources.title')}</h3>
      {sources.length === 0 ? <p>{st('sources.empty')}</p> : null}
      <ul className={wcls('list')}>
        {sources.map((s) => (
          <li key={s.containerId} className={wcls('item')} data-testid={`source-${s.label}`}>
            <p>{sourceLine(s)}</p>
            {s.problem ? <p className={wcls('muted')}>{st('sources.problem', { problem: s.problem })}</p> : null}
            {chosen === s.containerId ? (
              <StatusChip tone="ok" label={st('sources.chosen', { label: s.label })} />
            ) : (
              <Button onPress={() => onChoose(s)} isDisabled={s.problem !== null}>
                {st('sources.use', { label: s.label })}
              </Button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

function AdditionRenderer({ view }: RendererProps) {
  const [source, setSource] = useState<AdditionSourceView | null>(null);
  const layout = BLOCK_LAYOUTS[view.step.block ?? ''] ?? [];
  // Only the identifiers the person chose by tapping are carried; the source's facts are read by the server.
  const chosen = source ? { container: source.containerId, ...(source.authorisationId ? { authorisation: source.authorisationId } : {}) } : undefined;
  return (
    <>
      <OwnBody view={view} />
      <AdditionSources view={view} chosen={source?.containerId ?? null} onChoose={setSource} />
      <BlockEntrySections view={view} sections={layout} {...(chosen ? { chosen } : {})} />
    </>
  );
}

// ---------------------------------------------------------------------------------------------
// SSCC register (TB-24)

export function SsccRegister({ view }: RendererProps) {
  const qc = useQueryClient();
  const q = useApiQuery(routes.batches.sscc, { params: { batchId: view.run.runId } });
  // Issuing an SSCC is the person's own act: a fresh badge tap on a shared terminal (FRESH_ON_SHARED).
  const cmd = useCommand(routes.batches.issueSscc, [], 'issuing an SSCC');
  const busy = cmd.busy;
  const error = cmd.error;
  const issue = async () => {
    await cmd.run({ params: { batchId: view.run.runId, stepKey: view.step.stepKey }, body: {} });
    await qc.invalidateQueries({ queryKey: queryKey(routes.batches.sscc, { params: { batchId: view.run.runId } }) });
  };
  return (
    <section className={wcls('section')} aria-label="SSCC register" data-testid="sscc-register">
      <h3 className={wcls('sectionTitle')}>SSCC register</h3>
      {q.data ? (
        <ul>
          {q.data.ssccs.map((s) => (
            <li key={s.sscc}>
              {s.sscc} · {s.stepKey} · {s.shipper ? `${s.shipper.packs} packs${s.shipper.part ? ' (part shipper)' : ''}` : 'not used yet'}
            </li>
          ))}
        </ul>
      ) : null}
      {q.error ? <RefusalMessage error={q.error.error} /> : null}
      <Button onPress={() => void issue()} isDisabled={busy}>
        Issue the next SSCC
      </Button>
      {error ? <RefusalMessage error={error} /> : null}
    </section>
  );
}

// ---------------------------------------------------------------------------------------------
// Potency calculation (TB-01)

/** R10 #1: the governing calculation's result as the server read it from the entry: each lot, then each target. */
export function PotencyResult({ potency }: { potency: NonNullable<StepScreenView['potency']> }) {
  const changed = potency.lots.filter((l) => l.changed);
  return (
    <div data-testid="potency-result">
      <table className={wcls('table')} aria-label="Lots of the calculation">
        <thead>
          <tr>
            <th scope="col">Lot</th>
            <th scope="col">Assay</th>
            <th scope="col">Water</th>
            <th scope="col">Basis</th>
            <th scope="col">As-is potency</th>
            <th scope="col">Target</th>
          </tr>
        </thead>
        <tbody>
          {potency.lots.map((l) => (
            <tr key={l.lotCode} data-testid={`potency-lot-${l.lotCode}`}>
              <td>{l.lotCode}</td>
              <td>{l.assay} %</td>
              <td>{l.water !== null ? `${l.water} %` : l.lod !== null ? `LOD ${l.lod} %` : '–'}</td>
              <td>{basisText(l.basis)}</td>
              <td>{l.asIs} %</td>
              <td>
                {l.target} {potency.active.unit}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <ul className={wcls('list')} aria-label="Targets of the calculation">
        <li data-testid="potency-target-active">
          {potency.active.material}: target {potency.active.target} {potency.active.unit} (standard {potency.active.standard} {potency.active.unit})
        </li>
        {potency.excipient ? (
          <li data-testid="potency-target-excipient">
            {potency.excipient.material} (compensating): target {potency.excipient.target} {potency.excipient.unit} (standard {potency.excipient.standard} {potency.excipient.unit})
          </li>
        ) : null}
        <li>
          Total: {potency.total} {potency.active.unit}
        </li>
      </ul>
      {changed.length > 0 ? (
        <p role="alert" data-testid="potency-changed">
          Potency changed since the calculation ({changed.map((l) => l.lotCode).join(', ')}): recalculate before weighing.
        </p>
      ) : null}
    </div>
  );
}

const BASIS_TEXT: Readonly<Record<string, string>> = { AS_IS: 'as is', ANHYDROUS_WATER: 'anhydrous (water)', DRIED_LOD: 'dried (LOD)', ANHYDROUS_SOLVENT_FREE: 'anhydrous, solvent-free', ACTIVITY: 'activity' };
const basisText = (b: string): string => BASIS_TEXT[b] ?? b.toLowerCase().replace(/_/g, ' ');

/**
 * Phase 7 slice 7l (R1): the potency-adjusted quantities of TB-01 calculated from the active's lots, scanned in
 * allocation order (with more than one lot, each lot's base-equivalent share). The server reads each lot's status and
 * approved assay from the lot register and the block computes the targets (POTENCY_CALCULATION, never typed values).
 */
export function PotencyCalculation({ view }: RendererProps) {
  const [lots, setLots] = useState<{ lotCode: string; baseEquivalent: string }[]>([{ lotCode: '', baseEquivalent: '' }]);
  const clear = () => setLots([{ lotCode: '', baseEquivalent: '' }]);
  const cmd = useRunCommand(view.run.runId, view.step.stepKey, 'calculating the potency-adjusted quantities', { onSaved: clear });
  const done = view.entries.some((e) => e.kind === 'POTENCY_CALCULATION');
  const set = (i: number, k: 'lotCode' | 'baseEquivalent', v: string) => setLots((ls) => ls.map((l, j) => (j === i ? { ...l, [k]: v } : l)));
  const filled = lots.filter((l) => l.lotCode.trim() !== '');
  const several = filled.length > 1;
  const ready = filled.length > 0 && (!several || filled.every((l) => l.baseEquivalent.trim() !== ''));
  const locked = cmd.busy || cmd.state === 'notSaved';
  const calculate = () => {
    if (!ready) return;
    const entry = { kind: 'POTENCY_CALCULATION' as const, lots: filled.map((l) => ({ lotCode: l.lotCode.trim(), ...(several ? { baseEquivalent: l.baseEquivalent.trim() } : {}) })) };
    cmd.send({ type: 'RECORD_ENTRY', stepKey: view.step.stepKey, entry }, view.run.version, view);
  };
  return (
    <section className={wcls('formCard')} aria-label="Potency calculation" data-testid="potency-calculation">
      <h3 className={wcls('formTitle')}>Potency calculation</h3>
      {done ? <StatusChip tone="ok" label="Calculated from the lots" /> : <p className={wcls('muted')}>Scan the active's lots in the order they are used; the targets are calculated from each lot's approved assay.</p>}
      {view.potency ? <PotencyResult potency={view.potency} /> : null}
      {lots.map((l, i) => (
        <div key={i}>
          <Field name={`potency-lot-${i}`} label={`Lot ${i + 1} of the active`} value={l.lotCode} onChange={(v) => set(i, 'lotCode', v)} isDisabled={locked} autoComplete="off" />
          {lots.length > 1 ? <Field name={`potency-share-${i}`} label={`Base equivalent from lot ${i + 1}`} value={l.baseEquivalent} onChange={(v) => set(i, 'baseEquivalent', v)} isDisabled={locked} autoComplete="off" /> : null}
        </div>
      ))}
      <Button onPress={() => setLots((ls) => [...ls, { lotCode: '', baseEquivalent: '' }])} isDisabled={locked || lots.length >= 3}>
        Add a lot
      </Button>
      <Button variant="primary" onPress={calculate} isDisabled={locked || !ready}>
        Calculate from the lots
      </Button>
      <EntryStatus call={cmd} />
    </section>
  );
}

// ---------------------------------------------------------------------------------------------
// The renderers

function sectionsRenderer(key: string, extra?: BlockRenderer): BlockRenderer {
  const layout = BLOCK_LAYOUTS[key] ?? [];
  const weighing = key === 'TB-01@1' || key === 'TB-01@2';
  function Renderer({ view }: RendererProps) {
    const Extra = extra;
    return (
      <>
        {weighing ? (
          <p>
            <ScaleStatus view={view} />
          </p>
        ) : null}
        {weighing ? <PotencyCalculation view={view} /> : null}
        <OwnBody view={view} weighing={weighing} />
        <BlockEntrySections view={view} sections={layout} />
        {Extra ? <Extra view={view} /> : null}
      </>
    );
  }
  Renderer.displayName = `Renderer(${key})`;
  return Renderer;
}

/** A dedicated renderer for every block version of the contract's BLOCK_ENTRY list. */
export const TABLET_RENDERERS: Readonly<Record<string, BlockRenderer>> = Object.fromEntries(
  Object.keys(TABLET_ENTRY_KINDS_BY_BLOCK).map((key) => [key, key === 'TB-08@1' || key === 'G-24@2' ? AdditionRenderer : sectionsRenderer(key, key === 'TB-24@1' ? SsccRegister : undefined)]),
);
