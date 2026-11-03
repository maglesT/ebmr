/**
 * Library blocks in the designer (decision 0026, slice S9).
 *
 * - AddLibraryBlock: the author picks an approved library block and places it after the step being edited; the master
 *   carries the block's snapshot and the step pins its content hash (ADD_LIBRARY_BLOCK).
 * - LibraryValuesForm: the product's values for a library step, one control per slot of the block (limits as the
 *   registered range with an optional target, equipment classes, counts, intervals, the BOM line from the master's
 *   bill of materials, an earlier step's value, the time points of a profile test), with the formulation checks of
 *   recipe-core (checkBlockUse) shown as they are typed. The validator and the database stay the authority.
 */
import { useState } from 'react';
import { routes } from '@ebmr/api-contract';
import { flow, library, type limits } from '@ebmr/recipe-core/pure';
import { Button } from '@ebmr/ui-kit';
import { useApiQuery } from '../../../api/hooks.ts';
import { dcls } from '../classes.ts';
import type { Content, Op } from '../model/ops.ts';
import { insertionPoint } from '../model/ops.ts';
import { CommitText, Select, type Option } from './common.tsx';

const EXPR = flow.createExprService();
type Config = Record<string, flow.JsonValue>;
type Limit = limits.LimitSpec;

/** A library step's id: p-<code>, numbered when taken. */
export function libraryStepId(content: Content, code: string, taken: (id: string) => boolean): string {
  const base = `p-${code.toLowerCase()}`;
  if (!taken(base)) return base;
  for (let i = 2; ; i++) if (!taken(`${base}-${String(i)}`)) return `${base}-${String(i)}`;
}

function idsOf(content: Content): Set<string> {
  const ids = new Set<string>();
  flow.walk(content.procedure.body, (n) => {
    ids.add(n.id);
  });
  return ids;
}

export function AddLibraryBlock({ content, afterId, dispatch }: { content: Content; afterId: string; dispatch: (op: Op) => void }) {
  const q = useApiQuery(routes.library.list, { query: { state: 'APPROVED' } });
  const [chosen, setChosen] = useState('');
  const blocks = q.data?.blocks ?? [];
  const options: Option[] = [{ value: '', label: '— choose an approved block —' }, ...blocks.map((b) => ({ value: b.blockId, label: `${b.code} v${String(b.version)}: ${b.title}` }))];
  const add = () => {
    const b = blocks.find((x) => x.blockId === chosen);
    const at = insertionPoint(content, afterId);
    if (!b || !at) return;
    const ids = idsOf(content);
    dispatch({ kind: 'ADD_LIBRARY_BLOCK', ...at, stepId: libraryStepId(content, b.code, (id) => ids.has(id)), definition: b.definition as unknown as library.BlockDefinition });
    setChosen('');
  };
  return (
    <fieldset className={dcls('fieldset')} aria-label="Add a library block">
      <legend className={dcls('legend')}>Add a library block after this step</legend>
      <Select label="Approved library block" value={chosen} options={options} onChange={setChosen} />
      <Button onPress={add} isDisabled={chosen === ''}>
        Add the block
      </Button>
    </fieldset>
  );
}

function limitOf(config: Config, slot: string): Limit | undefined {
  const all = config['limits'] as unknown as Record<string, Limit> | undefined;
  return all?.[slot];
}

function boundOf(l: Limit | undefined, side: 'low' | 'high'): string {
  return l?.ranges.find((r) => r.tier === 'REGISTERED')?.[side]?.value ?? '';
}

/** The registered range of a slot from its two bounds (empty bounds left out; no bound at all removes the limit). */
function withLimit(config: Config, slot: string, unit: string, low: string, high: string, source: string): Config {
  const all = { ...((config['limits'] as unknown as Record<string, Limit> | undefined) ?? {}) };
  if (low.trim() === '' && high.trim() === '') delete all[slot];
  else {
    const range: limits.LimitRange = { tier: 'REGISTERED', rounding: 'USP_HALF_UP_AT_LIMIT_DECIMALS', source: { kind: 'REGISTRATION', ref: source.trim() || 'FORMULATION' } };
    if (low.trim() !== '') range.low = { value: low.trim(), inclusive: true };
    if (high.trim() !== '') range.high = { value: high.trim(), inclusive: true };
    all[slot] = { unit, ranges: [range] };
  }
  return { ...config, limits: all as unknown as flow.JsonValue };
}

function withMember(config: Config, member: string, slot: string, value: flow.JsonValue | undefined): Config {
  const all = { ...((config[member] as Record<string, flow.JsonValue> | undefined) ?? {}) };
  if (value === undefined || value === '') delete all[slot];
  else all[slot] = value;
  return { ...config, [member]: all };
}

export function LibraryValuesForm({ content, step, readOnly, onChange }: { content: Content; step: flow.PhaseNode; readOnly: boolean; onChange: (config: Config) => void }) {
  const def = library.definitionsOf(content).find((d) => library.libraryBlockType(d.code) === step.block.type && String(d.version) === step.block.version);
  if (!def) return <p className={dcls('small')}>This master carries no snapshot of {step.block.type}@{step.block.version}; add the block again from the library.</p>;
  const config = step.config;
  const slots = library.slotsOf(def);
  const limitOwners = slots.filter((s) => s.kind === 'LIMIT').map((s) => s.owner);
  const shared = new Set(limitOwners.filter((o, i) => limitOwners.indexOf(o) !== i));
  const problems = library.checkBlockUse(def, { block: { code: def.code, version: def.version }, ...(config as unknown as Omit<library.BlockUse, 'block'>) }, EXPR);
  const bom: Option[] = [{ value: '', label: '— choose a line —' }, ...content.bom.map((b) => ({ value: b.id, label: `${b.id}: ${content.references.find((r) => r.id === b.material)?.title ?? b.material}` }))];
  const perPoint = def.sections.flatMap((s) => s.fields).filter((f): f is library.FieldDef & { type: 'TEST_RESULT' } => f.type === 'TEST_RESULT' && f.perPoint === true);
  return (
    <div className={dcls('stack')} data-testid="library-values">
      <p className={dcls('small')}>
        {def.code} version {def.version} ({def.category.toLowerCase().replace('_', ' ')}); its content is pinned in this master.
      </p>
      {slots.map((s) => {
        const label = `${s.name} (${s.owner})`;
        if (s.kind === 'LIMIT') {
          const l = limitOf(config, s.name);
          const ref = def.referenceLimits?.[s.name];
          // A field with several limits (a test's mean, minimum and maximum) names each by its slot (S11 finding).
          const who = shared.has(s.owner) ? `${s.owner}, ${s.name}` : s.owner;
          return (
            <fieldset key={s.name} aria-label={`Limits of ${who}`} className={dcls('stack')}>
              <legend>
                Limits of {who} ({s.unit}){s.required ? ', required' : ''}
                {ref ? ` · reference ${ref.low ?? ''}${ref.low && ref.high ? ' to ' : ''}${ref.high ?? ''} ${ref.unit}: ${ref.note}` : ''}
              </legend>
              <CommitText label={`${who}: lower limit`} value={boundOf(l, 'low')} readOnly={readOnly} onCommit={(v) => onChange(withLimit(config, s.name, s.unit ?? '1', v, boundOf(l, 'high'), l?.ranges[0]?.source.ref ?? ''))} />
              <CommitText label={`${who}: upper limit`} value={boundOf(l, 'high')} readOnly={readOnly} onCommit={(v) => onChange(withLimit(config, s.name, s.unit ?? '1', boundOf(l, 'low'), v, l?.ranges[0]?.source.ref ?? ''))} />
              <CommitText label={`${who}: target`} value={String((config['targets'] as Record<string, string> | undefined)?.[s.name] ?? '')} readOnly={readOnly} onCommit={(v) => onChange(withMember(config, 'targets', s.name, v.trim()))} />
              <CommitText label={`${who}: reason if looser than the reference`} value={String((config['justifications'] as Record<string, string> | undefined)?.[s.name] ?? '')} readOnly={readOnly} onCommit={(v) => onChange(withMember(config, 'justifications', s.name, v.trim()))} />
            </fieldset>
          );
        }
        if (s.kind === 'BOM_LINE') return <Select key={s.name} label={`Formula line for ${s.owner}`} value={String((config['bomLines'] as Record<string, string> | undefined)?.[s.name] ?? '')} options={bom} disabled={readOnly} onChange={(v) => onChange(withMember(config, 'bomLines', s.name, v))} />;
        if (s.kind === 'EQUIPMENT_CLASS') return <CommitText key={s.name} label={`Equipment class for ${s.owner}`} value={String((config['equipmentClasses'] as Record<string, string> | undefined)?.[s.name] ?? '')} readOnly={readOnly} onCommit={(v) => onChange(withMember(config, 'equipmentClasses', s.name, v.trim()))} />;
        if (s.kind === 'COUNT') return <CommitText key={s.name} label={`Number for ${label}`} value={String((config['counts'] as Record<string, string> | undefined)?.[s.name] ?? '')} readOnly={readOnly} onCommit={(v) => onChange(withMember(config, 'counts', s.name, v.trim()))} />;
        if (s.kind === 'INTERVAL') {
          const iv = (config['intervals'] as Record<string, { value: string; unit: string }> | undefined)?.[s.name];
          return <CommitText key={s.name} label={`Interval for ${label} (minutes)`} value={iv?.value ?? ''} readOnly={readOnly} onCommit={(v) => onChange(withMember(config, 'intervals', s.name, v.trim() === '' ? undefined : { value: v.trim(), unit: 'min' }))} />;
        }
        // STEP_VALUE: the earlier step and its field, written step.field.
        const sv = (config['stepValues'] as Record<string, { step: string; field: string }> | undefined)?.[s.name];
        return (
          <CommitText
            key={s.name}
            label={`Earlier step value for ${s.owner} (step.field)`}
            value={sv ? `${sv.step}.${sv.field}` : ''}
            readOnly={readOnly}
            onCommit={(v) => {
              const [st, ...rest] = v.trim().split('.');
              onChange(withMember(config, 'stepValues', s.name, st && rest.length > 0 ? { step: st, field: rest.join('.') } : undefined));
            }}
          />
        );
      })}
      {perPoint.map((f) => {
        const points = ((config['points'] as Record<string, { id: string; label: string; limits: Limit }[]> | undefined)?.[f.id] ?? []) as { id: string; label: string; limits: Limit }[];
        const setPoints = (next: typeof points) => onChange(withMember(config, 'points', f.id, next.length > 0 ? (next as unknown as flow.JsonValue) : undefined));
        const point = (i: number, low: string, high: string, label: string) => {
          const range: limits.LimitRange = { tier: 'REGISTERED', rounding: 'USP_HALF_UP_AT_LIMIT_DECIMALS', source: { kind: 'REGISTRATION', ref: 'FORMULATION' } };
          if (low.trim() !== '') range.low = { value: low.trim(), inclusive: true };
          if (high.trim() !== '') range.high = { value: high.trim(), inclusive: true };
          return { id: `t${String(i + 1)}`, label, limits: { unit: f.unit, ranges: [range] } };
        };
        return (
          <fieldset key={f.id} aria-label={`Time points of ${f.label}`} className={dcls('stack')}>
            <legend>Time points or stages of {f.label} ({f.unit})</legend>
            {points.map((p, i) => (
              <div key={p.id} className={dcls('inline')}>
                <CommitText label={`Point ${String(i + 1)}: label`} value={p.label} readOnly={readOnly} onCommit={(v) => setPoints(points.map((x, j) => (j === i ? point(i, boundOf(x.limits, 'low'), boundOf(x.limits, 'high'), v) : x)))} />
                <CommitText label={`Point ${String(i + 1)}: lower limit`} value={boundOf(p.limits, 'low')} readOnly={readOnly} onCommit={(v) => setPoints(points.map((x, j) => (j === i ? point(i, v, boundOf(x.limits, 'high'), x.label) : x)))} />
                <CommitText label={`Point ${String(i + 1)}: upper limit`} value={boundOf(p.limits, 'high')} readOnly={readOnly} onCommit={(v) => setPoints(points.map((x, j) => (j === i ? point(i, boundOf(x.limits, 'low'), v, x.label) : x)))} />
              </div>
            ))}
            {readOnly ? null : (
              <Button onPress={() => setPoints([...points, point(points.length, '', '', `Point ${String(points.length + 1)}`)])}>Add a time point</Button>
            )}
          </fieldset>
        );
      })}
      {problems.length > 0 ? (
        <ul aria-label="Problems with these values" data-testid="library-values-problems">
          {problems.map((p, i) => (
            <li key={i}>
              {p.severity === 'ERROR' ? 'Problem' : 'Warning'}: {p.message}
            </li>
          ))}
        </ul>
      ) : (
        <p className={dcls('small')} data-testid="library-values-ok">
          The values pass the formulation checks.
        </p>
      )}
    </div>
  );
}
