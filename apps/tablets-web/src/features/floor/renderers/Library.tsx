/**
 * The generic renderer of library blocks (decision 0026, slice S5): one form for every library block, drawn from the
 * step's definition (the master's snapshot) and the product's values. Each section is a form; its typed fields show
 * their unit and the formulation's limits, and a value outside a limit is flagged while it is typed (display only: the
 * engine and the database decide). Conditional fields appear when their condition holds; a calculated field is never
 * typed (the server computes it and the recorded entry shows it); timers are started and stopped on the server's clock;
 * a test result takes the planned number of readings (per time point for a profile). The section stays open while the
 * definition allows another entry (a repeat, a count, a loop that has not passed). Entries go as LIBRARY_ENTRY.
 */
import { useMemo, useState } from 'react';
import type { ClientEntry, StepScreenView } from '@ebmr/api-contract';
import { flow, library, limits } from '@ebmr/recipe-core/pure';
import { Button, decimalProblem, Field, floor } from '@ebmr/ui-kit';
import { wcls } from '../classes.ts';
import { EntryStatus } from '../components/EntryStatus.tsx';
import { useRunCommand } from '../usePendingCall.ts';
import { EntryList } from './parts.tsx';
import type { RendererProps } from './types.ts';

type Def = library.BlockDefinition;
type Section = library.SectionDef;
type FieldDef = library.FieldDef;
type Config = Omit<library.BlockUse, 'block'>;
type Drafts = Record<string, string>;

const EXPR = flow.createExprService();

/** The innermost tier of a limit as people read it, e.g. "≤ 1.0 %" or "55 to 65 Cel". */
export function limitText(spec: limits.LimitSpec | undefined): string | null {
  if (!spec) return null;
  const r = (['ALERT', 'INTERNAL_ACTION', 'REGISTERED', 'VALIDATED'] as const).map((t) => spec.ranges.find((x) => x.tier === t)).find((x) => x !== undefined);
  if (!r) return null;
  if (r.low && r.high) return `${r.low.value} to ${r.high.value} ${spec.unit}`;
  if (r.low) return `${r.low.inclusive ? '≥' : '>'} ${r.low.value} ${spec.unit}`;
  if (r.high) return `${r.high.inclusive ? '≤' : '<'} ${r.high.value} ${spec.unit}`;
  return null;
}

/** The tier a typed value breaches (display only), or null. */
function breachOf(spec: limits.LimitSpec | undefined, value: string, unit: string): string | null {
  if (!spec || decimalProblem(value, { allowNegative: true }) !== null) return null;
  try {
    const ev = limits.evaluateLimits(spec, { value, unit }, EXPR);
    return ev.breached ? ev.breached.toLowerCase().replace('_', ' ') : null;
  } catch {
    return null;
  }
}

function shownIn(f: FieldDef, values: Readonly<Record<string, unknown>>): boolean {
  return f.showWhen === undefined || values[f.showWhen.field] === f.showWhen.equals;
}

/** The typed value of a draft for the entry, as the block's schema takes it. */
function typedValue(f: FieldDef, drafts: Drafts, config: Config): unknown {
  const v = drafts[f.id];
  switch (f.type) {
    case 'YES_NO':
      return v === 'yes' ? true : v === 'no' ? false : undefined;
    case 'SAMPLE': {
      // The planned number of units is shown in the field until the operator changes it: what is shown is what is
      // recorded (S11 finding: a shown default was not counted as entered).
      const units = v ?? config.counts?.[f.unitsSlot];
      return units !== undefined && /^[1-9][0-9]{0,5}$/.test(units) ? Number(units) : undefined;
    }
    default:
      return v === undefined || v.trim() === '' ? undefined : v.trim();
  }
}

/** The readings of a test result field from its drafts (keys `id#i` or `id#point#i`). */
function readings(f: FieldDef & { type: 'TEST_RESULT' }, n: number, drafts: Drafts, point?: string): string[] {
  return Array.from({ length: n }, (_, i) => (drafts[point === undefined ? `${f.id}#${String(i)}` : `${f.id}#${point}#${String(i)}`] ?? '').trim());
}

/** Builds the entry of a section from its drafts: the data, what is still missing, and the problems. */
export function buildSectionEntry(section: Section, config: Config, drafts: Drafts): { data: Record<string, unknown>; pending: string[]; problems: string[] } {
  const data: Record<string, unknown> = {};
  const pending: string[] = [];
  const problems: string[] = [];
  for (const f of section.fields) {
    if (f.type === 'CALC' || f.type === 'TIMER') continue;
    const values: Record<string, unknown> = {};
    for (const g of section.fields) values[g.id] = typedValue(g, drafts, config);
    if (!shownIn(f, values)) continue;
    if (f.type === 'TEST_RESULT') {
      const n = Number(config.counts?.[f.replicatesSlot] ?? '1');
      const sets = f.perPoint === true ? (config.points?.[f.id] ?? []).map((p) => [p.id, readings(f, n, drafts, p.id)] as const) : [['', readings(f, n, drafts)] as const];
      if (sets.some(([, rs]) => rs.some((r) => r === ''))) {
        pending.push(f.label);
        continue;
      }
      if (sets.some(([, rs]) => rs.some((r) => decimalProblem(r, { allowNegative: true }) !== null))) problems.push(`${f.label}: every reading is a decimal`);
      data[f.id] = f.perPoint === true ? Object.fromEntries(sets) : sets[0]?.[1];
      continue;
    }
    const v = typedValue(f, drafts, config);
    if (v === undefined) {
      if (f.required !== false) pending.push(f.label);
      continue;
    }
    if ((f.type === 'NUMBER' || f.type === 'WEIGHING') && decimalProblem(typeof v === 'string' ? v : '', { allowNegative: true }) !== null) problems.push(`${f.label}: a decimal, e.g. 6.500`);
    if (f.type === 'TEXT' && f.pattern !== undefined && !new RegExp(`^(?:${f.pattern})$`, 'u').test(typeof v === 'string' ? v : '')) problems.push(`${f.label}: not in the expected form`);
    data[f.id] = v;
  }
  return { data, pending, problems };
}

/** Whether the definition allows another entry of the section now (the server decides; this keeps the form honest). */
function openFor(section: Section, config: Config, recorded: StepScreenView['entries']): boolean {
  const mine = recorded.filter((e) => e.kind === section.id);
  const r = section.repeat ?? { kind: 'ONCE' as const };
  if (r.kind === 'ONCE') return mine.length === 0;
  if (r.kind === 'COUNT') return mine.length < Number(config.counts?.[r.countSlot] ?? '1');
  if (r.kind === 'UNTIL_PASS') {
    const last = mine[mine.length - 1];
    const max = r.maxRepeatsSlot !== undefined ? config.counts?.[r.maxRepeatsSlot] : undefined;
    if (max !== undefined && mine.length >= Number(max)) return false;
    if (!last) return true;
    const f = section.fields.find((x) => x.id === r.untilField);
    const v = f?.type === 'CALC' ? ((last.data['computed'] as Record<string, { value?: string }> | undefined)?.[f.id]?.value ?? '') : (typeof last.data[r.untilField] === 'string' ? (last.data[r.untilField] as string) : '');
    if (f?.type === 'YES_NO') return f.expected !== undefined && last.data[f.id] !== f.expected;
    const spec = f && 'limitSlot' in f && f.limitSlot !== undefined ? config.limits?.[f.limitSlot] : undefined;
    return f !== undefined && 'unit' in f ? breachOf(spec, v, f.unit) !== null : false;
  }
  return true;
}

function FieldInput({ f, config, drafts, set, disabled }: { f: FieldDef; config: Config; drafts: Drafts; set: (k: string, v: string) => void; disabled: boolean }) {
  const name = `lib-${f.id}`;
  switch (f.type) {
    case 'YES_NO':
      return (
        <floor.ChoiceGroup
          label={f.label}
          options={[
            { value: 'yes', label: 'Yes' },
            { value: 'no', label: 'No' },
          ]}
          value={drafts[f.id] ?? null}
          onChange={(v) => set(f.id, v)}
          isDisabled={disabled}
          {...(f.expected !== undefined ? { description: `Expected: ${f.expected ? 'yes' : 'no'}` } : {})}
        />
      );
    case 'CHOICE':
      return <floor.ChoiceGroup label={f.label} options={f.options.map((o) => ({ value: o, label: o }))} value={drafts[f.id] ?? null} onChange={(v) => set(f.id, v)} isDisabled={disabled} />;
    case 'NUMBER':
    case 'WEIGHING': {
      const spec = f.limitSlot !== undefined ? config.limits?.[f.limitSlot] : undefined;
      const limit = limitText(spec);
      const breach = breachOf(spec, drafts[f.id] ?? '', f.unit);
      return (
        <div>
          <Field name={name} label={`${f.label} (${f.unit})`} value={drafts[f.id] ?? ''} onChange={(v) => set(f.id, v)} inputMode="decimal" isDisabled={disabled} {...(limit ? { description: `Limit ${limit}` } : {})} />
          {breach ? (
            <p role="status" data-testid={`lib-breach-${f.id}`}>
              Outside the {breach} limit: saving it raises an exception.
            </p>
          ) : null}
        </div>
      );
    }
    case 'SAMPLE':
      return <Field name={name} label={`${f.label} (units)`} value={drafts[f.id] ?? config.counts?.[f.unitsSlot] ?? ''} onChange={(v) => set(f.id, v)} inputMode="numeric" isDisabled={disabled} description={`Planned: ${config.counts?.[f.unitsSlot] ?? '?'} units`} />;
    case 'TEST_RESULT': {
      const n = Number(config.counts?.[f.replicatesSlot] ?? '1');
      const points = f.perPoint === true ? (config.points?.[f.id] ?? []) : [{ id: '', label: '', limits: undefined }];
      return (
        <fieldset aria-label={f.label}>
          <legend>
            {f.label} ({f.unit}), {n} readings
          </legend>
          {points.map((p) => (
            <div key={p.id} data-testid={`lib-readings-${f.id}${p.id ? `-${p.id}` : ''}`}>
              {p.label ? <p>{`${p.label}${limitText(p.limits) ? `: limit ${String(limitText(p.limits))}` : ''}`}</p> : null}
              {Array.from({ length: n }, (_, i) => {
                const key = p.id ? `${f.id}#${p.id}#${String(i)}` : `${f.id}#${String(i)}`;
                return <Field key={key} name={`lib-${key}`} label={`${f.label}${p.label ? ` ${p.label}` : ''} reading ${String(i + 1)}`} value={drafts[key] ?? ''} onChange={(v) => set(key, v)} inputMode="decimal" isDisabled={disabled} />;
              })}
            </div>
          ))}
        </fieldset>
      );
    }
    case 'CALC':
    case 'TIMER':
      return null;
    default:
      return <Field name={name} label={f.label} value={drafts[f.id] ?? ''} onChange={(v) => set(f.id, v)} isDisabled={disabled} {...(f.help !== undefined ? { description: f.help } : {})} />;
  }
}

function SectionForm({ view, section, config }: { view: StepScreenView; section: Section; config: Config }) {
  const [drafts, setDrafts] = useState<Drafts>({});
  const cmd = useRunCommand(view.run.runId, view.step.stepKey, `recording ${section.title}`, { onSaved: () => setDrafts({}), onDiscarded: () => setDrafts({}) });
  const set = (k: string, v: string) => setDrafts((d) => ({ ...d, [k]: v }));
  const values: Record<string, unknown> = {};
  for (const f of section.fields) values[f.id] = typedValue(f, drafts, config);
  const { data, pending, problems } = buildSectionEntry(section, config, drafts);
  const locked = cmd.busy || cmd.state === 'notSaved';
  const save = () => {
    const entry: ClientEntry = { kind: 'LIBRARY_ENTRY', entryKind: section.id, data: data as Record<string, never> };
    cmd.send({ type: 'RECORD_ENTRY', stepKey: view.step.stepKey, entry }, view.run.version, view);
  };
  const calcs = section.fields.filter((f) => f.type === 'CALC');
  return (
    <section className={wcls('formCard')} aria-label={section.title} data-testid={`lib-section-${section.id}`}>
      <h3 className={wcls('formTitle')}>{section.title}</h3>
      {section.fields.filter((f) => shownIn(f, values)).map((f) => (
        <FieldInput key={f.id} f={f} config={config} drafts={drafts} set={set} disabled={locked} />
      ))}
      {calcs.length > 0 ? <p className={wcls('muted')}>Calculated when saved: {calcs.map((c) => c.label).join(', ')}.</p> : null}
      {problems.length > 0 ? <p role="alert">{problems.join('; ')}</p> : pending.length > 0 ? <p className={wcls('muted')}>Still to enter: {pending.join(', ')}.</p> : null}
      <Button variant="primary" onPress={save} isDisabled={locked || pending.length > 0 || problems.length > 0}>
        Save {section.title}
      </Button>
      <EntryStatus call={cmd} />
    </section>
  );
}

function TimerControl({ view, f }: { view: StepScreenView; f: FieldDef & { type: 'TIMER' } }) {
  const cmd = useRunCommand(view.run.runId, view.step.stepKey, `${f.label}`);
  const started = view.entries.some((e) => e.kind === library.TIMER_START && e.data['field'] === f.id);
  const stopped = view.entries.some((e) => e.kind === library.TIMER_STOP && e.data['field'] === f.id);
  const send = (kind: 'TIMER_START' | 'TIMER_STOP') => cmd.send({ type: 'RECORD_ENTRY', stepKey: view.step.stepKey, entry: { kind: 'LIBRARY_ENTRY', entryKind: kind, data: { field: f.id } } }, view.run.version, view);
  if (stopped) return null;
  return (
    <section className={wcls('formCard')} aria-label={f.label} data-testid={`lib-timer-${f.id}`}>
      <h3 className={wcls('formTitle')}>{f.label}</h3>
      <Button variant="primary" onPress={() => send(started ? 'TIMER_STOP' : 'TIMER_START')} isDisabled={cmd.busy}>
        {started ? `Stop ${f.label}` : `Start ${f.label}`}
      </Button>
      <EntryStatus call={cmd} />
    </section>
  );
}

export function LibraryRenderer({ view }: RendererProps) {
  const lib = view.library;
  const def = lib?.definition as Def | undefined;
  const config = (lib?.config ?? {}) as Config;
  const timers = useMemo(() => (def ? def.sections.flatMap((s) => s.fields).filter((f): f is FieldDef & { type: 'TIMER' } => f.type === 'TIMER') : []), [def]);
  if (!def) return <p role="alert">This library step has no definition in its master; it cannot be recorded here.</p>;
  const working = view.step.status === 'IN_PROGRESS';
  return (
    <>
      {def.instructions ? <p>{def.instructions}</p> : null}
      {(def.inputs ?? []).some((i) => lib?.inputs?.[i.id]) ? (
        <ul aria-label="Values for this batch">
          {(def.inputs ?? []).map((i) => {
            const v = lib?.inputs?.[i.id];
            return v ? <li key={i.id}>{`${i.label}: ${v.value} ${v.unit}`}</li> : null;
          })}
        </ul>
      ) : null}
      <EntryList entries={view.entries} />
      {working ? timers.map((t) => <TimerControl key={t.id} view={view} f={t} />) : null}
      {working ? def.sections.filter((s) => openFor(s, config, view.entries)).map((s) => <SectionForm key={s.id} view={view} section={s} config={config} />) : null}
    </>
  );
}
