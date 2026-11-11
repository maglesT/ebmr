/**
 * A block configuration form generated from the block version's configuration schema (module C2; outline 6.6: the
 * schema is data, so the designer, engine and renderers read one definition). Strings with a list of values become
 * selects, a field named `sop` selects one of the MBR's SOP references, decimals go through DecimalField (text),
 * required booleans are checkboxes and optional ones a choice of block default (with its value), yes or no (review
 * F52), whole numbers are checked against the schema's range (review F53), nested objects are fieldsets. A G-21 step's printed items are edited element by element on a draft; other lists and maps
 * are shown read-only and in full (review F51). An optional field left empty is removed from the
 * configuration.
 */
import type { flow } from '@ebmr/recipe-core/pure';
import { Button } from '@ebmr/ui-kit';
import { dcls } from '../classes.ts';
import { Check, CommitDecimal, CommitInteger, CommitText, Select, type Option } from './common.tsx';
import { booleanDefaultWords, ConfigValue } from './ConfigView.tsx';

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
    case 'boolean': {
      if (!optional) return <Check label={label} checked={value === true} disabled={readOnly} {...(help ? { description: help } : {})} onChange={(on) => onChange(on)} />;
      // An optional yes/no has three choices (review F52): the block default (its effective value, as the block's
      // schema declares it and the engine applies it), an explicit yes, an explicit no. An absent member is never shown
      // as "no" when the block reads it as yes, and an explicit no can always be recorded.
      return (
        <div>
          <Select
            label={label}
            value={value === true ? 'yes' : value === false ? 'no' : ''}
            options={[
              { value: '', label: `block default (${booleanDefaultWords(schema)})` },
              { value: 'yes', label: 'yes' },
              { value: 'no', label: 'no' },
            ]}
            disabled={readOnly}
            onChange={(v) => onChange(v === 'yes' ? true : v === 'no' ? false : undefined)}
          />
          {help ? <p className={dcls('small')}>{help}</p> : null}
        </div>
      );
    }
    case 'integer': {
      const min = typeof schema['min'] === 'number' ? schema['min'] : undefined;
      const max = typeof schema['max'] === 'number' ? schema['max'] : undefined;
      return (
        <div>
          <CommitInteger
            label={`${label} (whole number)`}
            value={typeof value === 'number' ? value : undefined}
            readOnly={readOnly}
            allowEmpty={optional}
            {...(min !== undefined ? { min } : {})}
            {...(max !== undefined ? { max } : {})}
            onCommit={(v) => onChange(v ?? undefined)}
          />
          {help ? <p className={dcls('small')}>{help}</p> : null}
        </div>
      );
    }
    case 'object': {
      const fields = (schema['fields'] ?? {}) as Record<string, Schema>;
      const obj = value !== null && typeof value === 'object' && !Array.isArray(value) ? value : undefined;
      return (
        <fieldset className={dcls('fieldset')}>
          <legend className={dcls('legend')}>{label}</legend>
          {help ? <p className={dcls('small')}>{help}</p> : null}
          {/* Slice 7o (found by the R4 browser run): an optional group whose members are required (a duration's unit) is
              removed as a whole, else a copied master keeps a member its product must not have (an acid stage). */}
          {optional && obj !== undefined && !readOnly ? (
            <Button onPress={() => onChange(undefined)}>{`Remove ${name}`}</Button>
          ) : null}
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
    case 'array': {
      // A list of objects (a G-21 step's printed items; injectables residual "edit a packaging master's printed items
      // after create"): each element is edited in place with its own fields, so the firm's own values (limits,
      // allowance, need, counting) can be set after the master was created. Adding or removing elements, and maps inside
      // them (an item's artwork per market), stay read-only here.
      const item = schema['items'] as Schema | undefined;
      // Only the printed items (a G-21 step's `items`, each naming its printed material) and only on an editable draft;
      // a read-only step keeps the full table, and other lists (clearance checklists, devices) keep their read-only view.
      const printed = name === 'items' && item?.['type'] === 'object' && 'material' in ((item['fields'] ?? {}) as Record<string, unknown>);
      if (printed && !readOnly && Array.isArray(value) && value.length > 0) {
        const fields = ((item?.['fields'] ?? {}) as Record<string, Schema>);
        const list = value;
        return (
          <fieldset className={dcls('fieldset')}>
            <legend className={dcls('legend')}>{label}</legend>
            {help ? <p className={dcls('small')}>{help}</p> : null}
            {list.map((el, i) => {
              const obj = el !== null && typeof el === 'object' && !Array.isArray(el) ? el : {};
              const id = typeof obj['id'] === 'string' ? `: ${obj['id']}` : '';
              return (
                <fieldset key={`${path}[${String(i)}]`} className={dcls('fieldset')} aria-label={`${name} ${String(i + 1)}${id}`}>
                  <legend className={dcls('legend')}>{`${name} ${String(i + 1)}${id}`}</legend>
                  <ObjectFields
                    fields={fields}
                    value={obj}
                    readOnly={readOnly}
                    sopOptions={sopOptions}
                    path={`${path}[${String(i)}]`}
                    onChange={(next) => onChange(list.map((x, j) => (j === i ? next : x)))}
                  />
                </fieldset>
              );
            })}
            <p className={dcls('small')}>Items are added or removed with the master's template; their values are edited here.</p>
          </fieldset>
        );
      }
      return readOnlyValue(label, value, help);
    }
    default:
      return readOnlyValue(label, value, help);
  }
}

/** Lists and maps without an editor: shown in full, read-only (never cut; review F51). */
function readOnlyValue(label: string, value: Json | undefined, help: string) {
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
