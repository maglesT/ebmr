/**
 * A small form for one POST of the Phase 3 slice 6 office screens, described by a field list: text, a choice, yes/no,
 * a whole number, a decimal (text, never a JavaScript number), an instant (ISO-8601 with offset). The body is checked
 * against the route's own contract schema before it is sent, so the form can send only what the contract allows; the
 * server and the database decide the rest. Dotted names build nested members (`size.value`).
 */
import { useState } from 'react';
import type { AnyRoute, CallInput, RouteResponse } from '@ebmr/api-contract';
import { Field, floor } from '@ebmr/ui-kit';
import { ActButton, ActResult, useCommand } from './acts.tsx';

export interface FormField {
  name: string;
  label: string;
  kind: 'text' | 'choice' | 'yesno' | 'int' | 'decimal' | 'instant';
  options?: readonly string[];
  optional?: boolean;
  description?: string;
}

function setPath(target: Record<string, unknown>, path: string, value: unknown): void {
  const [head, ...rest] = path.split('.');
  if (!head) return;
  if (rest.length === 0) {
    target[head] = value;
    return;
  }
  const child = (target[head] ?? {}) as Record<string, unknown>;
  target[head] = child;
  setPath(child, rest.join('.'), value);
}

/** The body built from the typed values (empty optional members absent), or the names still missing. */
export function buildBody(fields: readonly FormField[], values: Record<string, string>): { body: Record<string, unknown>; missing: string[] } {
  const body: Record<string, unknown> = {};
  const missing: string[] = [];
  for (const f of fields) {
    const raw = (values[f.name] ?? '').trim();
    if (raw === '') {
      if (!f.optional) missing.push(f.label);
      continue;
    }
    const value = f.kind === 'yesno' ? raw === 'YES' : f.kind === 'int' && /^-?[0-9]+$/.test(raw) ? Number(raw) : raw;
    setPath(body, f.name, value);
  }
  return { body, missing };
}

export function FieldInput({ field, value, onChange }: { field: FormField; value: string; onChange: (v: string) => void }) {
  const description = [field.description, field.optional ? 'optional' : ''].filter(Boolean).join(' · ');
  switch (field.kind) {
    case 'choice':
      return <floor.ChoiceGroup label={field.label} description={description} options={(field.options ?? []).map((o) => ({ value: o, label: o }))} value={value === '' ? null : value} onChange={onChange} />;
    case 'yesno':
      return (
        <floor.ChoiceGroup
          label={field.label}
          description={description}
          options={[
            { value: 'YES', label: 'Yes' },
            { value: 'NO', label: 'No' },
          ]}
          value={value === '' ? null : value}
          onChange={onChange}
        />
      );
    default:
      return <Field name={field.name} label={field.label} description={description} value={value} onChange={onChange} autoComplete="off" {...(field.kind === 'int' || field.kind === 'decimal' ? { inputMode: field.kind === 'int' ? 'numeric' : 'decimal' } : {})} />;
  }
}

export interface DefineFormProps<R extends AnyRoute> {
  title: string;
  route: R;
  fields: readonly FormField[];
  /** Path parameters of the route, if any. */
  params?: Record<string, string>;
  /** Members added to every body (fixed by the screen). */
  fixed?: Record<string, unknown>;
  refresh: readonly string[];
  submitLabel: string;
  onDone?: (value: RouteResponse<R>) => void;
}

export function DefineForm<R extends AnyRoute>({ title, route, fields, params, fixed = {}, refresh, submitLabel, onDone }: DefineFormProps<R>) {
  const [values, setValues] = useState<Record<string, string>>({});
  const cmd = useCommand(route, refresh);
  const { body, missing } = buildBody(fields, values);
  const full = { ...fixed, ...body };
  const parsed = missing.length === 0 && route.body ? route.body.safeParse(full) : null;
  const problem = parsed && !parsed.success ? parsed.error.issues.map((i) => `${i.path.join('.') || 'form'}: ${i.message}`).join('; ') : null;
  const send = async () => {
    const r = await cmd.run({ body: full, ...(params ? { params } : {}) } as unknown as CallInput<R>);
    if (r) {
      setValues({});
      onDone?.(r);
    }
  };
  return (
    <form aria-label={title} onSubmit={(e) => e.preventDefault()} data-testid={`form-${title}`}>
      <h3>{title}</h3>
      {fields.map((f) => (
        <FieldInput key={f.name} field={f} value={values[f.name] ?? ''} onChange={(v) => setValues((s) => ({ ...s, [f.name]: v }))} />
      ))}
      {missing.length > 0 ? <p>Still needed: {missing.join(', ')}.</p> : null}
      {problem ? <p role="alert">Not in the expected form: {problem}</p> : null}
      <ActButton label={submitLabel} onPress={send} disabled={missing.length > 0 || problem !== null || cmd.busy} />
      <ActResult error={cmd.error} done={cmd.done} />
    </form>
  );
}
