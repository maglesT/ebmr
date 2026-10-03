/**
 * A block configuration form generated from the block version's configuration schema (module C2; outline 6.6: the
 * schema is data, so the designer, engine and renderers read one definition). Strings with a list of values become
 * selects, a field named `sop` selects one of the MBR's SOP references, decimals go through DecimalField (text),
 * booleans are checkboxes, nested objects are fieldsets. Lists and maps are shown read-only and in full in A1 (their
 * editors come with construct editing in A2; review F51). An optional field left empty is removed from the
 * configuration.
 */
import type { flow } from '@ebmr/recipe-core/pure';
import { dcls } from '../classes.ts';
import { Check, CommitDecimal, CommitText, Select, type Option } from './common.tsx';
import { ConfigValue } from './ConfigView.tsx';

type Json = flow.JsonValue;
type Schema = Record<string, unknown>;

function describe(s: Schema): string {
  return typeof s['description'] === 'string' ? s['description'] : '';
}

function FieldEditor({ name, schema, value, onChange, readOnly, sopOptions, path }: { name: string; schema: Schema; value: Json | undefined; onChange: (v: Json | undefined) => void; readOnly: boolean; sopOptions: readonly Option[]; path: string }) {
  const optional = schema['optional'] === true;
  const label = `${name}${optional ? ' (optional)' : ''}`;
  const help = describe(schema);
  switch (schema['type']) {
    case 'string': {
      const values = Array.isArray(schema['enum']) ? (schema['enum'] as string[]) : name === 'sop' ? sopOptions.map((o) => o.value) : null;
      if (values) {
        const labels = name === 'sop' ? sopOptions : values.map((v) => ({ value: v, label: v }));
        const options: Option[] = [...(optional ? [{ value: '', label: '(not set)' }] : []), ...labels];
        return (
          <div>
            <Select label={label} value={typeof value === 'string' ? value : ''} options={options} disabled={readOnly} onChange={(v) => onChange(v === '' ? undefined : v)} />
            {help ? <p className={dcls('small')}>{help}</p> : null}
          </div>
        );
      }
      return (
        <div>
          <CommitText label={label} value={typeof value === 'string' ? value : ''} readOnly={readOnly} multiline={name === 'text'} onCommit={(v) => onChange(v === '' && optional ? undefined : v)} />
          {help ? <p className={dcls('small')}>{help}</p> : null}
        </div>
      );
    }
    case 'decimal':
      return (
        <div>
          <CommitDecimal label={label} unit={typeof schema['unit'] === 'string' ? schema['unit'] : ''} value={typeof value === 'string' ? value : undefined} readOnly={readOnly} allowEmpty={optional} onCommit={(v) => onChange(v ?? undefined)} />
          {help ? <p className={dcls('small')}>{help}</p> : null}
        </div>
      );
    case 'boolean':
      return <Check label={label} checked={value === true} disabled={readOnly} {...(help ? { description: help } : {})} onChange={(on) => onChange(on ? true : optional ? undefined : false)} />;
    case 'integer': {
      const text = typeof value === 'number' ? String(value) : '';
      return (
        <CommitText
          label={`${label} (whole number)`}
          value={text}
          readOnly={readOnly}
          onCommit={(v) => {
            if (v === '' && optional) onChange(undefined);
            else if (/^(0|[1-9][0-9]{0,6})$/.test(v)) onChange(Number(v));
          }}
        />
      );
    }
    case 'object': {
      const fields = (schema['fields'] ?? {}) as Record<string, Schema>;
      const obj = value !== null && typeof value === 'object' && !Array.isArray(value) ? value : undefined;
      return (
        <fieldset className={dcls('fieldset')}>
          <legend className={dcls('legend')}>{label}</legend>
          {help ? <p className={dcls('small')}>{help}</p> : null}
          <ObjectFields
            fields={fields}
            value={obj ?? {}}
            readOnly={readOnly}
            sopOptions={sopOptions}
            path={path}
            onChange={(next) => onChange(Object.keys(next).length === 0 && optional ? undefined : next)}
          />
        </fieldset>
      );
    }
    default:
      // Lists and maps: shown in full, read-only (never cut; review F51); their editors come with A2.
      return (
        <div>
          <p>
            <strong>{label}</strong>: {value === undefined ? 'the block default' : null}
          </p>
          {value !== undefined ? <ConfigValue value={value} label={label} /> : null}
          <p className={dcls('small')}>
            {help} Shown in full; edited in a later release.
          </p>
        </div>
      );
  }
}

function ObjectFields({ fields, value, onChange, readOnly, sopOptions, path }: { fields: Record<string, Schema>; value: Record<string, Json>; onChange: (v: Record<string, Json>) => void; readOnly: boolean; sopOptions: readonly Option[]; path: string }) {
  return (
    <div className={dcls('stack')}>
      {Object.entries(fields).map(([name, schema]) => (
        <FieldEditor
          key={`${path}.${name}`}
          path={`${path}.${name}`}
          name={name}
          schema={schema}
          value={value[name]}
          readOnly={readOnly}
          sopOptions={sopOptions}
          onChange={(v) => {
            const next = { ...value };
            if (v === undefined) delete next[name];
            else next[name] = v;
            onChange(next);
          }}
        />
      ))}
    </div>
  );
}

export function ConfigForm({ schema, value, onChange, readOnly, sopOptions }: { schema: Record<string, unknown>; value: Record<string, Json>; onChange: (v: Record<string, Json>) => void; readOnly: boolean; sopOptions: readonly Option[] }) {
  const fields = (schema['fields'] ?? {}) as Record<string, Schema>;
  if (Object.keys(fields).length === 0) return <p className={dcls('small')}>This block has no configuration.</p>;
  return <ObjectFields fields={fields} value={value} onChange={onChange} readOnly={readOnly} sopOptions={sopOptions} path="config" />;
}
