/**
 * A step's saved configuration shown read-only and in full (review F51): every member with its value as written,
 * lists of items as a table (one row per item, a column per member, e.g. a clearance checklist's id, text and
 * expected answer), other lists item by item, nested members under their name. Nothing is cut or summarised, so the
 * checker's document and the step panel carry the whole configuration the step runs with.
 */
import type { ReactNode } from 'react';
import type { flow } from '@ebmr/recipe-core/pure';
import { dcls } from '../classes.ts';

type Json = flow.JsonValue;

const isRecord = (v: Json): v is { [key: string]: Json } => v !== null && typeof v === 'object' && !Array.isArray(v);

export function ConfigValue({ value, label }: { value: Json; label: string }): ReactNode {
  if (value === null) return <span>none</span>;
  if (typeof value === 'boolean') return <span>{value ? 'yes' : 'no'}</span>;
  if (typeof value === 'string' || typeof value === 'number') return <span>{String(value)}</span>;
  if (Array.isArray(value)) {
    if (value.length === 0) return <span>no items</span>;
    if (value.every(isRecord)) {
      const columns = [...new Set(value.flatMap((item) => Object.keys(item)))];
      return (
        <table className={dcls('grid')} aria-label={label}>
          <thead>
            <tr>
              <th scope="col">#</th>
              {columns.map((c) => (
                <th key={c} scope="col" className={dcls('mono')}>
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {value.map((item, i) => (
              <tr key={i}>
                <td>{i + 1}</td>
                {columns.map((c) => (
                  <td key={c}>{item[c] === undefined ? '—' : <ConfigValue value={item[c]} label={`${label} ${i + 1} ${c}`} />}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      );
    }
    return (
      <ol className={dcls('list')} aria-label={label}>
        {value.map((item, i) => (
          <li key={i}>
            <ConfigValue value={item} label={`${label} ${i + 1}`} />
          </li>
        ))}
      </ol>
    );
  }
  return <ConfigList config={value} label={label} />;
}

/** Every member of a configuration object: name, then value. */
export function ConfigList({ config, label, describe }: { config: { [key: string]: Json }; label: string; describe?: (key: string, value: Json) => ReactNode }): ReactNode {
  const entries = Object.entries(config);
  if (entries.length === 0) return <span className={dcls('small')}>no configuration</span>;
  return (
    <ul className={dcls('list')} aria-label={label}>
      {entries.map(([k, v]) => (
        <li key={k}>
          <span className={dcls('mono')}>{k}</span>: {describe?.(k, v) ?? <ConfigValue value={v} label={`${label}: ${k}`} />}
        </li>
      ))}
    </ul>
  );
}
