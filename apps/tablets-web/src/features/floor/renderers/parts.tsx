/**
 * Building parts of the block renderers (module C4): a value field (RECORD_DATA), a computed field (display
 * only, INV-25), the entries so far, a scale reading capture, and a generic entry form (RECORD_ENTRY) generated
 * from the server's EntryFormView and checked against the contract's strict ClientEntry before it is sent.
 *
 * The browser never decides a GMP outcome: whether recording is possible comes from the server's actions; the
 * limit verdict appears only in the view the server returns after commit; values are never pre-filled; lots
 * travel as codes and weights as reading ids (or hand-typed values on the two-person path).
 */
import { useState, type ReactNode } from 'react';
import {
  ClientEntry,
  routes,
  type ActionView,
  type DataValueWire,
  type FieldView,
  type ReadingView,
  type StepScreenView,
} from '@ebmr/api-contract';
import { Button, decimalProblem, Field, floor } from '@ebmr/ui-kit';
import { useApiQuery } from '../../../api/hooks.ts';
import { ScaleCaptureSlot } from '../../../app/ports.tsx';
import { wcls } from '../classes.ts';
import { EntryStatus } from '../components/EntryStatus.tsx';
import { useSessionChange } from '../session.tsx';
import { st } from '../text.ts';
import { useRunCommand } from '../usePendingCall.ts';

type EntryFormView = StepScreenView['entryForms'][number];

// ---------------------------------------------------------------------------------------------
// Availability as the server stated it

export interface Availability {
  available: boolean;
  reason: string | null;
  /** The server offers the action at all on this step. */
  offered: boolean;
}

export function availability(view: StepScreenView, action: ActionView['action']): Availability {
  const a = view.actions.find((x) => x.action === action);
  return { available: a?.available ?? false, reason: a?.reason ?? null, offered: a !== undefined };
}

// ---------------------------------------------------------------------------------------------
// Values (RECORD_DATA)

const INTEGER = /^(0|[1-9][0-9]*)$/;

function maxDecimalsOf(field: FieldView): number | undefined {
  if (field.valueType === 'COUNT') return 0;
  return field.precision?.kind === 'DECIMALS' ? field.precision.digits : undefined;
}

/** The value the person entered, as it travels (decimal text, never a number), or null while incomplete. */
export function valueOf(field: FieldView, input: { text: string; choice: string | null; scan: string | null }): DataValueWire | null {
  if (field.capture === 'SCAN') {
    if (!input.scan) return null;
    return field.valueType === 'CATEGORY' ? { kind: 'CATEGORY', value: input.scan } : { kind: 'TEXT', value: input.scan };
  }
  switch (field.valueType) {
    case 'DECIMAL': {
      const maxDecimals = maxDecimalsOf(field);
      if (!field.unit || input.text === '' || decimalProblem(input.text, maxDecimals !== undefined ? { maxDecimals } : {}) !== null) return null;
      return { kind: 'DECIMAL', value: input.text, unit: field.unit };
    }
    case 'COUNT':
      return INTEGER.test(input.text) ? { kind: 'COUNT', value: input.text } : null;
    case 'BOOLEAN':
      return input.choice === null ? null : { kind: 'BOOLEAN', value: input.choice === 'YES' };
    case 'CATEGORY':
      return input.choice === null ? null : { kind: 'CATEGORY', value: input.choice };
    case 'TEXT':
      return input.text.trim() === '' ? null : { kind: 'TEXT', value: input.text };
    case 'INSTANT':
      return null;
  }
}

const YES_NO = [
  { value: 'YES', label: floor.ft('checklist.answer.YES') },
  { value: 'NO', label: floor.ft('checklist.answer.NO') },
];

/** A computed item: shown with its target, limits and the server's values; never an input (INV-25). */
export function ComputedField({ field, note }: { field: FieldView; note?: string }) {
  const target = field.target?.value.kind === 'DECIMAL' ? field.target : null;
  return (
    <section className={wcls('computed')} aria-label={field.name} data-testid={`computed-${field.item}`}>
      <p className={wcls('computedName')}>{field.name}</p>
      <p className={wcls('muted')}>{note ?? st('field.computed')}</p>
      {target && target.value.kind === 'DECIMAL' ? (
        <p>
          {floor.ft('numeric.target', { value: target.value.value, unit: target.value.unit })} <span className={wcls('muted')}>{floor.ft('numeric.targetSource', { source: target.source })}</span>
        </p>
      ) : null}
      <floor.LimitDisplay limits={field.limits} unit={field.unit} />
      <floor.AttemptList label={`${st('field.recorded')}: ${field.name}`} attempts={field.attempts} />
    </section>
  );
}

/** One value of the step: computed and system-captured values are shown only; manual and scanned values get an input. */
export function FieldEntry({ field, view }: { field: FieldView; view: StepScreenView }) {
  if (field.computed) return <ComputedField field={field} />;
  if (field.capture !== 'MANUAL' && field.capture !== 'SCAN') return <ComputedField field={field} note={st('field.systemCaptured')} />;
  return <ManualFieldEntry field={field} view={view} />;
}

function ManualFieldEntry({ field, view }: { field: FieldView; view: StepScreenView }) {
  const record = availability(view, 'RECORD_DATA');
  const [text, setText] = useState('');
  const [choice, setChoice] = useState<string | null>(null);
  const [scan, setScan] = useState<string | null>(null);
  const clear = () => {
    setText('');
    setChoice(null);
    setScan(null);
  };
  const cmd = useRunCommand(view.run.runId, view.step.stepKey, st('tap.reason.entry', { what: field.name }), { onSaved: clear });
  useSessionChange(clear);
  const locked = cmd.busy || cmd.state === 'notSaved';
  const value = valueOf(field, { text, choice, scan });
  const save = () => {
    if (!value) return;
    const source = field.capture === 'SCAN' && scan ? ({ mode: 'SCAN', code: scan } as const) : ({ mode: 'MANUAL' } as const);
    cmd.send({ type: 'RECORD_DATA', stepKey: view.step.stepKey, item: field.item, value, source }, view.run.version, view);
  };
  const maxDecimals = maxDecimalsOf(field);
  const target = field.target?.value.kind === 'DECIMAL' ? { value: field.target.value.value, unit: field.target.value.unit, source: field.target.source } : null;

  let input: ReactNode = null;
  if (record.available) {
    if (field.capture === 'SCAN') input = <floor.ScanField label={field.name} value={scan} onChange={setScan} isDisabled={locked} name={field.item} />;
    else if (field.valueType === 'DECIMAL' || field.valueType === 'COUNT') {
      input =
        field.valueType === 'DECIMAL' && !field.unit ? (
          <p>{st('field.noUnit')}</p>
        ) : (
          <floor.NumericEntry
            label={field.name}
            name={field.item}
            unit={field.unit ?? ''}
            value={text}
            onChange={setText}
            {...(maxDecimals !== undefined ? { maxDecimals } : {})}
            target={target}
            limits={field.limits}
            isDisabled={locked}
          />
        );
    } else if (field.valueType === 'BOOLEAN') input = <floor.ChoiceGroup label={field.name} options={YES_NO} value={choice} onChange={setChoice} isDisabled={locked} />;
    else if (field.valueType === 'CATEGORY')
      input = <floor.ChoiceGroup label={field.name} options={(field.categories ?? []).map((c) => ({ value: c, label: c }))} value={choice} onChange={setChoice} isDisabled={locked} />;
    else if (field.valueType === 'TEXT') input = <Field label={field.name} name={field.item} value={text} onChange={setText} isDisabled={locked} autoComplete="off" />;
    else input = <p>{st('field.instantNotHere')}</p>;
  }

  return (
    <section className={wcls('formCard')} aria-label={field.name} data-testid={`field-${field.item}`}>
      <h3 className={wcls('formTitle')}>{field.name}</h3>
      {input}
      {record.available && field.valueType !== 'INSTANT' ? (
        <Button variant="primary" className={wcls('saveButton')} onPress={save} isDisabled={!value || locked}>
          {st('save.field', { name: field.name })}
        </Button>
      ) : !record.available ? (
        <p className={wcls('muted')}>
          {st('field.cannotRecord')}
          {record.reason ? ` ${record.reason}` : ''}
        </p>
      ) : null}
      <EntryStatus call={cmd} />
      <floor.AttemptList label={`${st('field.recorded')}: ${field.name}`} attempts={field.attempts} />
    </section>
  );
}

// ---------------------------------------------------------------------------------------------
// Entries (RECORD_ENTRY)

export function EntryList({ entries }: { entries: StepScreenView['entries'] }) {
  if (entries.length === 0) return null;
  return (
    <section className={wcls('section')} aria-label={st('entries.title')}>
      <h3 className={wcls('formTitle')}>{st('entries.title')}</h3>
      <ul className={wcls('entries')}>
        {entries.map((e) => (
          <li key={e.entryId} className={wcls('entry')} data-testid={`entry-${e.entryId}`}>
            <div>{e.summary}</div>
            <div className={wcls('muted')}>{st('entries.by', { name: floor.personLine(e.by), at: e.at.text })}</div>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** The answers each checklist entry kind accepts (typed against the contract's ClientEntry). */
type AnswersOf<K extends ClientEntry['kind']> = Extract<ClientEntry, { kind: K }> extends { answers: readonly { answer: infer A }[] } ? A : never;
const CLEARANCE_ANSWERS: readonly AnswersOf<'CLEARANCE_CHECK'>[] = ['CONFIRMED', 'NOT_CONFIRMED', 'NOT_APPLICABLE'];
const EQUIPMENT_ANSWERS: readonly AnswersOf<'EQUIPMENT_STATUS'>[] = ['YES', 'NO'];
export const CHECKLIST_ANSWERS: Readonly<Partial<Record<ClientEntry['kind'], readonly floor.ChecklistAnswer[]>>> = {
  CLEARANCE_CHECK: CLEARANCE_ANSWERS.map((a) => ({ value: a, label: floor.enumText('checklist.answer', a) })),
  EQUIPMENT_STATUS: EQUIPMENT_ANSWERS.map((a) => ({ value: a, label: floor.enumText('checklist.answer', a) })),
};

export interface FormOptions {
  /** String fields that are label scans (keyboard-wedge), e.g. G-09 labelId. */
  scan?: readonly string[];
  /** Weighing form: when the scale is not online the reading fields become the manual two-person path. */
  weighing?: boolean;
  /** Members the entry needs that the form does not ask for, e.g. G-07 item (from the step's computed item). */
  fixed?: Readonly<Record<string, string>>;
  /** Members the entry must carry; a missing one is named instead of a schema message. */
  required?: readonly string[];
}

function purposeOf(name: string): 'TARE' | 'GROSS' | 'CHECK' {
  return /tare/i.test(name) ? 'TARE' : /gross/i.test(name) ? 'GROSS' : 'CHECK';
}

const BAND_TIERS = ['ALERT', 'INTERNAL_ACTION', 'VALIDATED', 'REGISTERED'] as const;

/**
 * The display band for the live gauge (C5): target and the tightest limit tier of the step's one weighed
 * (computed, device-captured) item, as decimal text. Display only; the engine decides acceptance.
 */
export function gaugeBand(view: StepScreenView): { low?: string; high?: string; target?: string; unit: string } | undefined {
  const weighed = view.fields.filter((f) => f.computed && f.capture === 'DEVICE');
  const field = weighed.length === 1 ? weighed[0] : undefined;
  if (!field?.unit) return undefined;
  const limit = BAND_TIERS.map((t) => field.limits.find((l) => l.tier === t)).find((l) => l !== undefined);
  const target = field.target?.value.kind === 'DECIMAL' ? field.target.value.value : undefined;
  if (!limit && target === undefined) return undefined;
  return { unit: field.unit, ...(limit?.low ? { low: limit.low.value } : {}), ...(limit?.high ? { high: limit.high.value } : {}), ...(target !== undefined ? { target } : {}) };
}

function ReadingCapture({ label, purpose, reading, onReading, view, disabled }: { label: string; purpose: 'TARE' | 'GROSS' | 'CHECK'; reading: ReadingView | null; onReading: (r: ReadingView | null) => void; view: StepScreenView; disabled: boolean }) {
  const devices = view.run.scale ? [view.run.scale.deviceCode] : view.run.equipment.map((e) => e.code);
  const band = purpose === 'GROSS' ? gaugeBand(view) : undefined;
  if (reading) {
    return (
      <div className={wcls('readingBox')} data-testid={`reading-${purpose}`}>
        <p>{st('reading.captured', { purpose: label, value: reading.value, unit: reading.unit, device: reading.deviceCode, status: reading.stable ? 'stable' : reading.status, raw: reading.raw, at: reading.recordedAt.text })}</p>
        <Button onPress={() => onReading(null)} isDisabled={disabled}>
          {st('reading.again')}
        </Button>
      </div>
    );
  }
  return (
    <div className={wcls('section')}>
      <p className={wcls('formTitle')}>{label}</p>
      <ScaleCaptureSlot deviceCodes={devices} purpose={purpose} {...(band ? { band } : {})} onCaptured={(r) => onReading(r)} disabled={disabled} />
    </div>
  );
}

function LotInfo({ code }: { code: string }) {
  const lot = useApiQuery(routes.execution.lot, { params: { code } }, { retry: false });
  if (lot.isPending) return null;
  if (!lot.data) return <p className={wcls('muted')}>{st('lot.unknown', { code })}</p>;
  const l = lot.data;
  return (
    <p className={wcls('muted')} data-testid="lot-info">
      {st('lot.info', {
        code: l.lotCode,
        material: `${l.material.name} (${l.material.code})`,
        status: l.status,
        expiry: l.expiry ? `, expiry ${l.expiry}` : '',
        retest: l.retest ? `, retest ${l.retest}` : '',
        identity: l.identityTested ? ', identity tested' : ', identity not tested',
      })}
    </p>
  );
}

interface FormState {
  texts: Record<string, string>;
  choices: Record<string, string>;
  scans: Record<string, string>;
  readings: Record<string, ReadingView>;
  checks: Record<string, Record<string, string>>;
}

const EMPTY_FORM: FormState = { texts: {}, choices: {}, scans: {}, readings: {}, checks: {} };

/** Builds the entry from what the person gave; null members stay absent. */
export function buildEntry(form: EntryFormView, state: FormState, opts: FormOptions & { manual: { unit: string } | null }): { candidate: Record<string, unknown>; complete: boolean } {
  const candidate: Record<string, unknown> = { kind: form.kind, ...(opts.fixed ?? {}) };
  let complete = true;
  for (const f of form.fields) {
    let v: unknown;
    switch (f.type) {
      case 'decimal':
      case 'integer':
        v = state.texts[f.name] ? state.texts[f.name] : undefined;
        if (typeof v === 'string' && decimalProblem(v, f.type === 'integer' ? { maxDecimals: 0 } : {}) !== null) v = undefined;
        break;
      case 'string':
        v = opts.scan?.includes(f.name) ? state.scans[f.name] : state.texts[f.name]?.trim() ? state.texts[f.name] : undefined;
        break;
      case 'boolean':
        v = state.choices[f.name] === undefined ? undefined : state.choices[f.name] === 'YES';
        break;
      case 'enum':
        v = state.choices[f.name];
        break;
      case 'lot':
      case 'container':
        v = state.scans[f.name];
        break;
      case 'reading':
        if (opts.manual) continue;
        v = state.readings[f.name]?.readingId;
        break;
      case 'checklist': {
        const items = f.options ?? [];
        const answers = state.checks[f.name] ?? {};
        v = floor.checklistComplete(items.map((i) => ({ id: i.value, label: i.label })), answers) ? items.map((i) => ({ id: i.value, answer: answers[i.value] })) : undefined;
        break;
      }
    }
    if (v === undefined || v === '') {
      if (f.required) complete = false;
      continue;
    }
    candidate[f.name] = v;
  }
  if (opts.manual) {
    const tare = state.texts['__manual.tare'] ?? '';
    const gross = state.texts['__manual.gross'] ?? '';
    if (tare && gross && decimalProblem(tare) === null && decimalProblem(gross) === null) candidate['manual'] = { tare, gross, unit: opts.manual.unit };
    else complete = false;
  }
  return { candidate, complete };
}

/** One entry form of the step, generated from the server's EntryFormView. */
export function EntryFormCard({ form, view, options = {} }: { form: EntryFormView; view: StepScreenView; options?: FormOptions }) {
  const record = availability(view, 'RECORD_ENTRY');
  const [state, setState] = useState<FormState>(EMPTY_FORM);
  const clear = () => setState(EMPTY_FORM);
  // A reading is used up even by a refused command (DEV-105): after a definite "not applied" the person captures again.
  const dropReadings = () => setState((s) => ({ ...s, readings: {} }));
  const cmd = useRunCommand(view.run.runId, view.step.stepKey, st('tap.reason.entry', { what: form.title }), { onSaved: clear, onNotApplied: dropReadings });
  useSessionChange(clear);
  const locked = cmd.busy || cmd.state === 'notSaved';

  const readingFields = form.fields.filter((f) => f.type === 'reading');
  const manualUnit = readingFields[0]?.unit ?? view.run.scale?.unit ?? null;
  const manual = options.weighing && readingFields.length > 0 && view.run.scale?.status !== 'ONLINE' && manualUnit ? { unit: manualUnit } : null;
  const { candidate, complete } = buildEntry(form, state, { ...options, manual });
  const missing = (options.required ?? []).filter((m) => !(m in candidate) && !form.fields.some((f) => f.name === m));
  const parsed = complete && missing.length === 0 ? ClientEntry.safeParse(candidate) : null;
  const problem = missing.length > 0 ? st('form.missingField', { name: missing.join(', ') }) : parsed && !parsed.success ? st('form.problem', { problem: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') }) : null;

  const set = <K extends keyof FormState>(part: K, name: string, value: FormState[K][string] | null) =>
    setState((s) => {
      const next = { ...s[part] } as Record<string, unknown>;
      if (value === null) delete next[name];
      else next[name] = value;
      return { ...s, [part]: next };
    });

  const save = () => {
    if (!parsed?.success) return;
    cmd.send({ type: 'RECORD_ENTRY', stepKey: view.step.stepKey, entry: parsed.data }, view.run.version, view);
  };

  if (!record.offered) return null;
  return (
    <section className={wcls('formCard')} aria-label={form.title} data-testid={`form-${form.kind}`}>
      <h3 className={wcls('formTitle')}>{form.title}</h3>
      <p className={wcls('muted')}>{form.description}</p>
      {!record.available ? (
        <p className={wcls('muted')}>
          {st('field.cannotRecord')}
          {record.reason ? ` ${record.reason}` : ''}
        </p>
      ) : (
        <>
          {manual ? <floor.TwoPersonNotice /> : null}
          {form.fields.map((f) => {
            const description = f.description;
            switch (f.type) {
              case 'decimal':
              case 'integer':
                return (
                  <floor.NumericEntry
                    key={f.name}
                    name={f.name}
                    label={f.label}
                    unit={f.unit ?? ''}
                    value={state.texts[f.name] ?? ''}
                    onChange={(v) => set('texts', f.name, v)}
                    {...(f.type === 'integer' ? { maxDecimals: 0 } : {})}
                    description={description}
                    isDisabled={locked}
                  />
                );
              case 'string':
                return options.scan?.includes(f.name) ? (
                  <floor.ScanField key={f.name} name={f.name} label={f.label} description={description} value={state.scans[f.name] ?? null} onChange={(v) => set('scans', f.name, v)} isDisabled={locked} />
                ) : (
                  <Field key={f.name} name={f.name} label={f.label} description={description} value={state.texts[f.name] ?? ''} onChange={(v) => set('texts', f.name, v)} isDisabled={locked} autoComplete="off" />
                );
              case 'boolean':
                return <floor.ChoiceGroup key={f.name} label={f.label} description={description} options={YES_NO} value={state.choices[f.name] ?? null} onChange={(v) => set('choices', f.name, v)} isDisabled={locked} />;
              case 'enum':
                return <floor.ChoiceGroup key={f.name} label={f.label} description={description} options={f.options ?? []} value={state.choices[f.name] ?? null} onChange={(v) => set('choices', f.name, v)} isDisabled={locked} />;
              case 'lot':
              case 'container':
                return (
                  <div key={f.name}>
                    <floor.ScanField name={f.name} label={f.label} description={description} value={state.scans[f.name] ?? null} onChange={(v) => set('scans', f.name, v)} isDisabled={locked} />
                    {f.type === 'lot' && state.scans[f.name] ? <LotInfo code={state.scans[f.name] ?? ''} /> : null}
                  </div>
                );
              case 'reading':
                return manual ? null : (
                  <ReadingCapture key={f.name} label={f.label} purpose={purposeOf(f.name)} reading={state.readings[f.name] ?? null} onReading={(r) => set('readings', f.name, r)} view={view} disabled={locked} />
                );
              case 'checklist': {
                const answers = CHECKLIST_ANSWERS[form.kind as ClientEntry['kind']] ?? [];
                return (
                  <floor.ChecklistEntry
                    key={f.name}
                    label={f.label}
                    items={(f.options ?? []).map((o) => ({ id: o.value, label: o.label }))}
                    answers={answers}
                    value={state.checks[f.name] ?? {}}
                    onChange={(v) => set('checks', f.name, v)}
                    isDisabled={locked}
                  />
                );
              }
            }
            return null;
          })}
          {manual ? (
            <>
              <floor.NumericEntry label={st('manual.tare')} name="manual-tare" unit={manual.unit} value={state.texts['__manual.tare'] ?? ''} onChange={(v) => set('texts', '__manual.tare', v)} isDisabled={locked} />
              <floor.NumericEntry label={st('manual.gross')} name="manual-gross" unit={manual.unit} value={state.texts['__manual.gross'] ?? ''} onChange={(v) => set('texts', '__manual.gross', v)} isDisabled={locked} />
            </>
          ) : null}
          {problem ? <p role="alert">{problem}</p> : null}
          <Button variant="primary" className={wcls('saveButton')} onPress={save} isDisabled={!parsed?.success || locked}>
            {st('save.form', { title: form.title })}
          </Button>
        </>
      )}
      <EntryStatus call={cmd} />
    </section>
  );
}
