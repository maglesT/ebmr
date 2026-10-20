/**
 * Schema-driven block entries (Phase 3 slice 6, D-S6-2): one form per BLOCK_ENTRY kind of a tablet block, G-06@1,
 * G-21@1 or G-24@2, generated from the block version's own entry schema, and sent as
 * `{kind: 'BLOCK_ENTRY', entryKind, data}`. The engine validates the data against that same schema and the database's
 * guards decide the rest; the form only says what is still missing before Save can be pressed.
 *
 * The schema is the step view's `blockEntries`: the server's description of the block's entry schemas, one per kind the
 * step offers (members the server fills are marked `serverFilled`).
 *
 * Values travel as the block schema takes them: decimals as decimal text (never JavaScript numbers), whole numbers as
 * safe integers, yes/no as booleans, lists and objects as such. Members the server fills (its own time, the facts it
 * reads from the database, the signer of an authorisation) are never asked for. Nothing is pre-filled except the
 * identifiers a person chose by tapping (e.g. an addition's source container).
 */
import { useState, type ReactNode } from 'react';
import { ClientEntry, type BlockEntryFormView, type BlockFieldSchemaWire, type BlockFieldWire, type StepScreenView } from '@ebmr/api-contract';
import { Button, decimalProblem, Field, floor } from '@ebmr/ui-kit';
import { useStepChoices } from '../choices.tsx';
import { wcls } from '../classes.ts';
import { EntryStatus } from '../components/EntryStatus.tsx';
import { useSessionChange } from '../session.tsx';
import { st } from '../text.ts';
import { useDraftGuard } from '../unsettled.ts';
import { useRunCommand } from '../usePendingCall.ts';
import { DeviceReadingPicker, isDeviceEntry } from './device-reading.tsx';
import { availability } from './parts.tsx';

// ---------------------------------------------------------------------------------------------
// The schema as it travels (contract BlockFieldSchemaWire: recipe-core's FieldSchema, a pattern as its source text)

export type EntryFieldSchema = BlockFieldSchemaWire;
export type BlockEntryFormDef = BlockEntryFormView;

/** A member the server fills (a fact it reads from the database or a device): never asked for, never sent. */
export function isServerFilled(s: EntryFieldSchema): boolean {
  return s.serverFilled === true;
}

/** "groupWeight" -> "Group weight". */
function memberTitle(name: string): string {
  const words = name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/Us$/, '').toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** The BLOCK_ENTRY forms the step offers, each with the block's own schema, as the server sent them. */
export function blockEntryForms(view: StepScreenView): BlockEntryFormDef[] {
  return view.blockEntries;
}

// ---------------------------------------------------------------------------------------------
// Draft values and their conversion to the wire

/** What the person typed or chose: text for scalars, lists and objects of drafts. */
export type Draft = string | Draft[] | { [k: string]: Draft };

const INTEGER = /^-?(0|[1-9][0-9]*)$/;

function patternOk(pattern: string | undefined, text: string): boolean {
  if (!pattern) return true;
  try {
    return new RegExp(pattern).test(text);
  } catch {
    return true; // the engine checks the pattern again
  }
}

export interface Converted {
  value: BlockFieldWire | undefined;
  /** Labels of required members not given yet. */
  pending: string[];
  /** Members given but not readable (with why). */
  problems: string[];
}

/** Converts a draft for `schema` into the wire value; an empty optional member stays absent. */
export function toWire(schema: EntryFieldSchema, draft: Draft | undefined, label: string): Converted {
  const none = (required: boolean): Converted => ({ value: undefined, pending: required ? [label] : [], problems: [] });
  const required = schema.optional !== true;
  switch (schema.type) {
    case 'string': {
      const text = typeof draft === 'string' ? draft.trim() : '';
      if (text === '') return none(required);
      if (schema.enum && !schema.enum.includes(text)) return { value: undefined, pending: [], problems: [`${label}: ${st('block.notAChoice')}`] };
      if (!patternOk(schema.pattern, text)) return { value: undefined, pending: [], problems: [`${label}: ${st('block.badFormat')}`] };
      return { value: text, pending: [], problems: [] };
    }
    case 'decimal': {
      const text = typeof draft === 'string' ? draft.trim() : '';
      if (text === '') return none(required);
      const problem = decimalProblem(text, { allowNegative: schema.min === undefined || schema.min.startsWith('-') });
      return problem === null ? { value: text, pending: [], problems: [] } : { value: undefined, pending: [], problems: [`${label}: ${problem}`] };
    }
    case 'integer': {
      const text = typeof draft === 'string' ? draft.trim() : '';
      if (text === '') return none(required);
      if (!INTEGER.test(text) || !Number.isSafeInteger(Number(text))) return { value: undefined, pending: [], problems: [`${label}: ${st('block.wholeNumber')}`] };
      // A count, as the block schema takes it (a safe integer, BlockFieldWire).
      return { value: Number(text), pending: [], problems: [] };
    }
    case 'boolean': {
      if (draft === 'YES') return { value: true, pending: [], problems: [] };
      if (draft === 'NO') return { value: false, pending: [], problems: [] };
      return none(required);
    }
    case 'object': {
      const d = draft !== undefined && typeof draft === 'object' && !Array.isArray(draft) ? draft : {};
      const value: Record<string, BlockFieldWire> = {};
      const pending: string[] = [];
      const problems: string[] = [];
      let touched = false;
      for (const [name, member] of Object.entries(schema.fields)) {
        if (isServerFilled(member)) continue;
        const c = toWire(member, d[name], label === '' ? memberTitle(name) : `${label} / ${memberTitle(name)}`);
        pending.push(...c.pending);
        problems.push(...c.problems);
        if (c.value !== undefined) {
          value[name] = c.value;
          touched = true;
        }
      }
      // An optional object left entirely empty stays absent (its own members are then not asked for).
      if (!touched && !required) return { value: undefined, pending: [], problems: [] };
      return { value, pending, problems };
    }
    case 'array': {
      const items = Array.isArray(draft) ? draft : [];
      const values: BlockFieldWire[] = [];
      const pending: string[] = [];
      const problems: string[] = [];
      items.forEach((item, i) => {
        const c = toWire({ ...schema.items, optional: false }, item, `${label} ${i + 1}`);
        pending.push(...c.pending);
        problems.push(...c.problems);
        if (c.value !== undefined) values.push(c.value);
      });
      if (items.length === 0) return none(required && (schema.minItems ?? 1) > 0);
      if (schema.minItems !== undefined && items.length < schema.minItems) pending.push(st('block.atLeast', { label, count: schema.minItems }));
      return { value: values, pending, problems };
    }
    case 'record': {
      const rows = Array.isArray(draft) ? draft : [];
      const value: Record<string, BlockFieldWire> = {};
      const pending: string[] = [];
      const problems: string[] = [];
      for (const row of rows) {
        if (!Array.isArray(row)) continue;
        const key = typeof row[0] === 'string' ? row[0].trim() : '';
        if (key === '') {
          pending.push(`${label}: ${st('block.key')}`);
          continue;
        }
        const c = toWire({ ...schema.values, optional: false }, row[1], `${label} ${key}`);
        pending.push(...c.pending);
        problems.push(...c.problems);
        if (c.value !== undefined) value[key] = c.value;
      }
      if (rows.length === 0) return none(required);
      return { value, pending, problems };
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Inputs

const YES_NO = [
  { value: 'YES', label: floor.ft('checklist.answer.YES') },
  { value: 'NO', label: floor.ft('checklist.answer.NO') },
];

function emptyDraft(schema: EntryFieldSchema): Draft {
  return schema.type === 'object' ? {} : schema.type === 'array' || schema.type === 'record' ? [] : '';
}

interface InputProps {
  name: string;
  label: string;
  schema: EntryFieldSchema;
  draft: Draft | undefined;
  onChange: (d: Draft) => void;
  disabled: boolean;
  /** Top level of the form (the keypad is offered there only). */
  top: boolean;
}

function SchemaInput({ name, label, schema, draft, onChange, disabled, top }: InputProps): ReactNode {
  const description = schema.optional ? `${schema.description} (${st('block.optional')})` : schema.description;
  const text = typeof draft === 'string' ? draft : '';
  switch (schema.type) {
    case 'string':
      return schema.enum ? (
        <floor.ChoiceGroup label={label} description={description} options={schema.enum.map((v) => ({ value: v, label: v }))} value={text === '' ? null : text} onChange={onChange} isDisabled={disabled} />
      ) : (
        <Field name={name} label={label} description={description} value={text} onChange={onChange} isDisabled={disabled} autoComplete="off" />
      );
    case 'decimal':
    case 'integer':
      return (
        <floor.NumericEntry
          name={name}
          label={label}
          unit=""
          description={description}
          value={text}
          onChange={onChange}
          {...(schema.type === 'integer' ? { maxDecimals: 0 } : {})}
          allowNegative={schema.type === 'decimal' ? schema.min === undefined || schema.min.startsWith('-') : schema.min === undefined || schema.min < 0}
          keypad={top}
          isDisabled={disabled}
        />
      );
    case 'boolean':
      return <floor.ChoiceGroup label={label} description={schema.defaultText ? `${description}. ${schema.defaultText}` : description} options={YES_NO} value={text === '' ? null : text} onChange={onChange} isDisabled={disabled} />;
    case 'object': {
      const d = draft !== undefined && typeof draft === 'object' && !Array.isArray(draft) ? draft : {};
      return (
        <fieldset className={wcls('section')} data-testid={`block-object-${name}`}>
          <legend>{label}</legend>
          <p className={wcls('muted')}>{description}</p>
          {Object.entries(schema.fields)
            .filter(([, m]) => !isServerFilled(m))
            .map(([k, m]) => (
              <SchemaInput key={k} name={`${name}.${k}`} label={memberTitle(k)} schema={m} draft={d[k]} onChange={(v) => onChange({ ...d, [k]: v })} disabled={disabled} top={false} />
            ))}
        </fieldset>
      );
    }
    case 'array':
    case 'record': {
      const items = Array.isArray(draft) ? draft : [];
      const max = schema.type === 'array' ? schema.maxItems : undefined;
      const set = (i: number, v: Draft) => onChange(items.map((x, j) => (j === i ? v : x)));
      return (
        <fieldset className={wcls('section')} data-testid={`block-list-${name}`}>
          <legend>{label}</legend>
          <p className={wcls('muted')}>{description}</p>
          <ol>
            {items.map((item, i) => (
              <li key={i}>
                {schema.type === 'array' ? (
                  <SchemaInput name={`${name}.${i}`} label={`${label} ${i + 1}`} schema={{ ...schema.items, optional: false }} draft={item} onChange={(v) => set(i, v)} disabled={disabled} top={false} />
                ) : (
                  <>
                    <Field name={`${name}.${i}.key`} label={st('block.key')} value={Array.isArray(item) && typeof item[0] === 'string' ? item[0] : ''} onChange={(k) => set(i, [k, Array.isArray(item) ? (item[1] ?? emptyDraft(schema.values)) : emptyDraft(schema.values)])} isDisabled={disabled} autoComplete="off" />
                    <SchemaInput name={`${name}.${i}.value`} label={st('block.value')} schema={{ ...schema.values, optional: false }} draft={Array.isArray(item) ? item[1] : undefined} onChange={(v) => set(i, [Array.isArray(item) && typeof item[0] === 'string' ? item[0] : '', v])} disabled={disabled} top={false} />
                  </>
                )}
                <Button onPress={() => onChange(items.filter((_, j) => j !== i))} isDisabled={disabled}>
                  {st('block.remove', { label: `${label} ${i + 1}` })}
                </Button>
              </li>
            ))}
          </ol>
          <Button onPress={() => onChange([...items, schema.type === 'array' ? emptyDraft(schema.items) : ['', emptyDraft(schema.values)]])} isDisabled={disabled || (max !== undefined && items.length >= max)}>
            {st('block.add', { label })}
          </Button>
        </fieldset>
      );
    }
  }
}

// ---------------------------------------------------------------------------------------------
// The form

/** Builds the BLOCK_ENTRY from the drafts, checked against the contract's strict ClientEntry. */
export function buildBlockEntry(def: BlockEntryFormDef, drafts: Record<string, Draft>): { entry: ClientEntry | null; pending: string[]; problems: string[] } {
  const c = toWire(def.schema, drafts, '');
  if (c.pending.length > 0 || c.problems.length > 0 || c.value === undefined || typeof c.value !== 'object' || Array.isArray(c.value)) return { entry: null, pending: c.pending, problems: c.problems };
  const parsed = ClientEntry.safeParse({ kind: 'BLOCK_ENTRY', entryKind: def.kind, data: c.value });
  if (!parsed.success) return { entry: null, pending: [], problems: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) };
  return { entry: parsed.data, pending: [], problems: [] };
}

export interface BlockEntryFormProps {
  def: BlockEntryFormDef;
  view: StepScreenView;
  /** Identifiers chosen by a tap elsewhere on the screen (e.g. the addition's source container). */
  chosen?: Readonly<Record<string, string>>;
}

/**
 * The BLOCK_ENTRY of a process value taken from the equipment (D-P4-10): only the source and the reading's id; the
 * server copies the rest from the stored reading.
 */
export function deviceEntry(def: BlockEntryFormDef, readingId: string | null): ClientEntry | null {
  if (!readingId) return null;
  const parsed = ClientEntry.safeParse({ kind: 'BLOCK_ENTRY', entryKind: def.kind, data: { source: 'EQUIPMENT', readingId } });
  return parsed.success ? parsed.data : null;
}

export function BlockEntryForm({ def, view, chosen: passed = {} }: BlockEntryFormProps) {
  const record = availability(view, 'RECORD_ENTRY');
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  // Phase 7 slice 7h (WP-A): the identifiers a plant act of the step screen chose for this kind (choices.tsx).
  const choices = useStepChoices();
  const given: Readonly<Record<string, string>> = { ...passed, ...(choices?.chosen[def.kind] ?? {}) };
  // A process value: from the equipment (a reading picked) or keyed by hand (the block's manual-entry path).
  const device = isDeviceEntry(def);
  const [source, setSource] = useState<'EQUIPMENT' | 'MANUAL' | null>(null);
  const [reading, setReading] = useState<string | null>(null);
  const chosen: Readonly<Record<string, string>> = device && source === 'MANUAL' ? { ...given, source: 'MANUAL' } : given;
  const clear = () => {
    setDrafts({});
    setReading(null);
    choices?.clear(def.kind);
  };
  const cmd = useRunCommand(view.run.runId, view.step.stepKey, st('tap.reason.entry', { what: def.title }), { onSaved: clear, onDiscarded: clear });
  useSessionChange(clear);
  useDraftGuard(Object.keys(drafts).length > 0);
  const locked = cmd.busy || cmd.state === 'notSaved';
  const merged: Record<string, Draft> = { ...drafts, ...chosen };
  const fromDevice = device && source === 'EQUIPMENT';
  const built = fromDevice ? { entry: deviceEntry(def, reading), pending: reading ? [] : [st('device.pick')], problems: [] } : device && source === null ? { entry: null, pending: [st('device.source')], problems: [] } : buildBlockEntry(def, merged);
  const { entry, pending, problems } = built;
  const save = () => {
    if (!entry) return;
    cmd.send({ type: 'RECORD_ENTRY', stepKey: view.step.stepKey, entry }, view.run.version, view);
  };
  if (!record.offered) return null;
  return (
    <section className={wcls('formCard')} aria-label={def.title} data-testid={`block-form-${def.kind}`}>
      <h3 className={wcls('formTitle')}>{def.title}</h3>
      <p className={wcls('muted')}>{def.description}</p>
      {!record.available ? (
        <p className={wcls('muted')}>
          {st('field.cannotRecord')}
          {record.reason ? ` ${record.reason}` : ''}
        </p>
      ) : (
        <>
          {device ? (
            <floor.ChoiceGroup
              label={st('device.source')}
              options={[
                { value: 'EQUIPMENT', label: st('device.equipment') },
                { value: 'MANUAL', label: st('device.manual') },
              ]}
              value={source}
              onChange={(v) => setSource(v === 'MANUAL' ? 'MANUAL' : 'EQUIPMENT')}
              isDisabled={locked}
            />
          ) : null}
          {fromDevice ? <DeviceReadingPicker view={view} value={reading} onChange={setReading} disabled={locked} /> : null}
          {Object.entries(def.schema.fields)
            .filter(([, m]) => !isServerFilled(m))
            .filter(() => !fromDevice && !(device && source === null))
            .map(([name, member]) =>
              name === 'source' && device ? null : name in chosen ? (
                <p key={name} data-testid={`chosen-${name}`}>
                  {memberTitle(name)}: {chosen[name]}
                </p>
              ) : (
                <SchemaInput key={name} name={name} label={memberTitle(name)} schema={member} draft={drafts[name]} onChange={(d) => setDrafts((s) => ({ ...s, [name]: d }))} disabled={locked} top />
              ),
            )}
          {problems.length > 0 ? <p role="alert">{st('form.problem', { problem: problems.join('; ') })}</p> : null}
          {problems.length === 0 && pending.length > 0 ? (
            <p className={wcls('muted')} data-testid="still-needed">
              {st('form.stillNeeded', { names: pending.join(', ') })}
            </p>
          ) : null}
          <Button variant="primary" className={wcls('saveButton')} onPress={save} isDisabled={entry === null || locked}>
            {st('save.form', { title: def.title })}
          </Button>
        </>
      )}
      <EntryStatus call={cmd} />
    </section>
  );
}

/** A group of entry kinds under one heading (a block's own layout). */
export interface EntrySection {
  title: string;
  kinds: readonly string[];
}

/** The process-value kinds every automated block shares with G-06@1. */
export const PROCESS_VALUE_KINDS = ['SETPOINT_READBACK', 'ACTUAL', 'ALARM', 'ALARM_ACK', 'INTERFACE_LOSS', 'RECIPE_CHECK'] as const;

/**
 * The block entries of a step in the block's own sections; each form opens on demand (one at a time), so a kiosk
 * screen shows what can be recorded without a wall of inputs. Kinds no section names come last under "Other entries".
 */
export function BlockEntrySections({ view, sections, chosen }: { view: StepScreenView; sections: readonly EntrySection[]; chosen?: Readonly<Record<string, string>> }) {
  const forms = blockEntryForms(view);
  const byKind = new Map(forms.map((f) => [f.kind as string, f]));
  // A plant act of the step screen chose identifiers for a kind: its form opens with them (choices.tsx), until the
  // person opens or closes a form themselves (the choice counter at that moment is kept with their choice).
  const choices = useStepChoices();
  const seq = choices?.seq ?? 0;
  const [toggled, setToggled] = useState<{ kind: string | null; at: number }>({ kind: null, at: 0 });
  const lastChosen = choices?.last ?? null;
  const open = seq > toggled.at && lastChosen !== null && byKind.has(lastChosen) ? lastChosen : toggled.kind;
  const setOpen = (kind: string | null) => setToggled({ kind, at: seq });
  const placed = new Set(sections.flatMap((s) => s.kinds));
  const all: EntrySection[] = [...sections, { title: st('block.other'), kinds: forms.map((f) => f.kind).filter((k) => !placed.has(k)) }];
  return (
    <>
      {all.map((section) => {
        const defs = section.kinds.map((k) => byKind.get(k)).filter((d): d is BlockEntryFormDef => d !== undefined);
        if (defs.length === 0) return null;
        return (
          <section key={section.title} className={wcls('section')} aria-label={section.title} data-testid={`block-section-${section.title}`}>
            <h3 className={wcls('sectionTitle')}>{section.title}</h3>
            <div className={wcls('row')}>
              {defs.map((d) => (
                <Button key={d.kind} variant={open === d.kind ? 'primary' : 'secondary'} onPress={() => setOpen(open === d.kind ? null : d.kind)}>
                  {st('block.record', { title: d.title })}
                </Button>
              ))}
            </div>
            {defs.map((d) => (open === d.kind ? <BlockEntryForm key={d.kind} def={d} view={view} {...(chosen ? { chosen } : {})} /> : null))}
          </section>
        );
      })}
    </>
  );
}
