/**
 * Schema-driven block entries (Phase 3 slice 6, D-S6-2): one form per BLOCK_ENTRY kind of a tablet block, G-06@1,
 * G-21@1 or G-24@2, generated from the block version's own entry schema, and sent as
 * `{kind: 'BLOCK_ENTRY', entryKind, data}`. The engine validates the data against that same schema and the database's
 * guards decide the rest; the form only says what is still missing before Save can be pressed.
 *
 * Where the schema comes from:
 *  - the step view's `blockEntries` (the server's description of the block's entry schemas, one per kind the step
 *    offers), when the server sends it;
 *  - otherwise, for the generic blocks the browser can read itself (recipe-core/pure: G-06@1, G-21@1, G-24@2), the
 *    block registry's own `dataSchema`.
 * The tablet blocks' schemas live in the server; without `blockEntries` their forms are not offered and the screen says
 * so (never a guessed form).
 *
 * Values travel as the block schema takes them: decimals as decimal text (never JavaScript numbers), whole numbers as
 * safe integers, yes/no as booleans, lists and objects as such. Members the server fills (its own time, the facts it
 * reads from the database, the signer of an authorisation) are never asked for. Nothing is pre-filled except the
 * identifiers a person chose by tapping (e.g. an addition's source container).
 */
import { useState, type ReactNode } from 'react';
import { blocks } from '@ebmr/recipe-core/pure';
import { ClientEntry, TabletEntryKind, TYPED_ENTRY_KINDS, type BlockFieldWire, type StepScreenView } from '@ebmr/api-contract';
import { Button, decimalProblem, Field, floor } from '@ebmr/ui-kit';
import { wcls } from '../classes.ts';
import { EntryStatus } from '../components/EntryStatus.tsx';
import { useSessionChange } from '../session.tsx';
import { st } from '../text.ts';
import { useDraftGuard } from '../unsettled.ts';
import { useRunCommand } from '../usePendingCall.ts';
import { availability } from './parts.tsx';

// ---------------------------------------------------------------------------------------------
// The schema as it travels (recipe-core blocks/schema.ts FieldSchema, with a pattern as its source text)

interface Common {
  description: string;
  optional?: boolean;
  /** The server fills this member; the form never asks for it. */
  serverFilled?: boolean;
}
export type EntryFieldSchema =
  | (Common & { type: 'string'; enum?: readonly string[]; pattern?: string })
  | (Common & { type: 'decimal'; min?: string; minExclusive?: boolean })
  | (Common & { type: 'integer'; min?: number; max?: number })
  | (Common & { type: 'boolean'; default?: boolean; defaultText?: string })
  | (Common & { type: 'object'; fields: Readonly<Record<string, EntryFieldSchema>> })
  | (Common & { type: 'array'; items: EntryFieldSchema; minItems?: number; maxItems?: number })
  | (Common & { type: 'record'; values: EntryFieldSchema });
export type EntryObjectSchema = Extract<EntryFieldSchema, { type: 'object' }>;

export interface BlockEntryFormDef {
  kind: TabletEntryKind;
  title: string;
  description: string;
  schema: EntryObjectSchema;
}

/** recipe-core's FieldSchema (RegExp patterns) as the wire shape (pattern source text). */
export function schemaToWire(s: unknown): EntryFieldSchema {
  const o = s as Record<string, unknown> & { type: EntryFieldSchema['type'] };
  const base = { ...o } as Record<string, unknown>;
  if (o['pattern'] instanceof RegExp) base['pattern'] = o['pattern'].source;
  if (o.type === 'object') base['fields'] = Object.fromEntries(Object.entries(o['fields'] as Record<string, unknown>).map(([k, v]) => [k, schemaToWire(v)]));
  if (o.type === 'array') base['items'] = schemaToWire(o['items']);
  if (o.type === 'record') base['values'] = schemaToWire(o['values']);
  return base as unknown as EntryFieldSchema;
}

/**
 * Members the server fills (review with 6a: `serverFilled` on the server's description). Until every description
 * carries the flag, a member whose own description says the server or the database supplies it is left out too.
 */
const SERVER_FILLED = /\(server time\)|filled by the server|time the server received|the server made|released by the server|read from the database/i;
export function isServerFilled(s: EntryFieldSchema): boolean {
  return s.serverFilled === true || SERVER_FILLED.test(s.description);
}

/** "SETPOINT_READBACK" -> "Setpoint readback". */
export function kindTitle(kind: string): string {
  const words = kind.toLowerCase().replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** "groupWeight" -> "Group weight". */
function memberTitle(name: string): string {
  const words = name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/Us$/, '').toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

const GENERIC_SCHEMAS: Readonly<Record<string, blocks.BlockVersion>> = {
  'G-06@1': blocks.G06,
  'G-21@1': blocks.G21,
  'G-24@2': blocks.G24V2,
};

const TYPED = new Set<string>(TYPED_ENTRY_KINDS);

/** What the server may add to the step view: the block's entry schemas for the kinds the step offers. */
interface WithBlockEntries {
  blockEntries?: readonly { kind: string; title: string; description: string; schema: unknown }[];
}

/** The BLOCK_ENTRY forms of the step: from the server's description, else from the generic block registry. */
export function blockEntryForms(view: StepScreenView): BlockEntryFormDef[] | null {
  const sent = (view as StepScreenView & WithBlockEntries).blockEntries;
  const out: BlockEntryFormDef[] = [];
  if (Array.isArray(sent)) {
    for (const e of sent) {
      const kind = TabletEntryKind.safeParse(e.kind);
      if (!kind.success || TYPED.has(kind.data)) continue;
      const schema = schemaToWire(e.schema);
      if (schema.type !== 'object') continue;
      out.push({ kind: kind.data, title: e.title, description: e.description, schema });
    }
    return out;
  }
  const block = view.step.block ? GENERIC_SCHEMAS[view.step.block] : undefined;
  if (!block?.dataSchema) return null;
  for (const [k, s] of Object.entries(block.dataSchema.entries)) {
    const kind = TabletEntryKind.safeParse(k);
    if (!kind.success || TYPED.has(kind.data)) continue;
    const schema = schemaToWire(s);
    if (schema.type !== 'object') continue;
    out.push({ kind: kind.data, title: kindTitle(k), description: s.description, schema });
  }
  return out;
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

export function BlockEntryForm({ def, view, chosen = {} }: BlockEntryFormProps) {
  const record = availability(view, 'RECORD_ENTRY');
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const clear = () => setDrafts({});
  const cmd = useRunCommand(view.run.runId, view.step.stepKey, st('tap.reason.entry', { what: def.title }), { onSaved: clear, onDiscarded: clear });
  useSessionChange(clear);
  useDraftGuard(Object.keys(drafts).length > 0);
  const locked = cmd.busy || cmd.state === 'notSaved';
  const merged: Record<string, Draft> = { ...drafts, ...chosen };
  const { entry, pending, problems } = buildBlockEntry(def, merged);
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
          {Object.entries(def.schema.fields)
            .filter(([, m]) => !isServerFilled(m))
            .map(([name, member]) =>
              name in chosen ? (
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
  const [open, setOpen] = useState<string | null>(null);
  if (forms === null) {
    return (
      <p className={wcls('muted')} data-testid="block-forms-unavailable">
        {st('block.noSchema', { block: view.step.block ?? '' })}
      </p>
    );
  }
  const byKind = new Map(forms.map((f) => [f.kind as string, f]));
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
