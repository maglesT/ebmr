/**
 * A step's saved configuration shown read-only and in full (review F51): every member with its value as written,
 * lists of items as a table (one row per item, a column per member, e.g. a clearance checklist's id, text and
 * expected answer), other lists item by item, nested members under their name. Nothing is cut or summarised, so the
 * checker's document and the step panel carry the whole configuration the step runs with, including the yes/no
 * members left to the block default, with the value the block applies (review F52).
 */
import type { ReactNode } from 'react';
import type { flow } from '@ebmr/recipe-core/pure';
import { dcls } from '../classes.ts';

type Json = flow.JsonValue;

const isRecord = (v: Json): v is { [key: string]: Json } => v !== null && typeof v === 'object' && !Array.isArray(v);

/** What an absent optional yes/no means, in words, as the block's schema declares it (review F52). */
export function booleanDefaultWords(s: Record<string, unknown>): string {
  if (typeof s['default'] === 'boolean') return s['default'] ? 'yes' : 'no';
  if (typeof s['defaultText'] === 'string' && s['defaultText'] !== '') return s['defaultText'];
  return 'not stated by the block';
}

/**
 * The optional yes/no members a configuration leaves to the block default, with that default in words: the document
 * shows them beside the members that are set, so a reviewer reads what the step does (review F52).
 */
export function blockDefaults(schema: Record<string, unknown> | undefined, config: Record<string, Json>): { key: string; words: string }[] {
  const fields = (schema?.['fields'] ?? {}) as Record<string, Record<string, unknown>>;
  return Object.entries(fields)
    .filter(([k, f]) => f['type'] === 'boolean' && f['optional'] === true && config[k] === undefined)
    .map(([k, f]) => ({ key: k, words: booleanDefaultWords(f) }));
}

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

/** Every member of a configuration object: name, then value; then the yes/no members left to the block default. */
export function ConfigList({
  config,
  label,
  describe,
  defaults = [],
}: {
  config: { [key: string]: Json };
  label: string;
  describe?: (key: string, value: Json) => ReactNode;
  defaults?: readonly { key: string; words: string }[];
}): ReactNode {
  const entries = Object.entries(config);
  if (entries.length === 0 && defaults.length === 0) return <span className={dcls('small')}>no configuration</span>;
  return (
    <ul className={dcls('list')} aria-label={label}>
      {entries.map(([k, v]) => (
        <li key={k}>
          <span className={dcls('mono')}>{k}</span>: {describe?.(k, v) ?? <ConfigValue value={v} label={`${label}: ${k}`} />}
        </li>
      ))}
      {defaults.map((d) => (
        <li key={`default:${d.key}`}>
          <span className={dcls('mono')}>{d.key}</span>: {d.words} (block default)
        </li>
      ))}
    </ul>
  );
}
