/**
 * What is being signed (module C1; plan section 6, step 1; DI-37): renderers for the SignableContentView
 * `rendering` of each kind (batch_step, batch_stage, mbr_version, batch_exception, fallback). They are tolerant: the
 * known fields of a kind come first in a fixed order with plain labels, and EVERY other field follows as labelled
 * text, so nothing the signature binds to is ever hidden. The exact canonical text (what is hashed) is always
 * available in a disclosure of the signature dialog as well.
 */
import type { ReactNode } from 'react';
import type { SignableContentView } from '@ebmr/api-contract';
import { icls } from './classes.ts';

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

const KIND_TITLES: Readonly<Record<string, string>> = {
  batch_step: 'Step',
  batch_stage: 'Stage',
  mbr_version: 'Master record version',
  batch_exception: 'Exception',
  fallback: 'Record',
};

/** Preferred order and labels per kind; unknown fields follow in key order. */
const KNOWN: Readonly<Record<string, readonly (readonly [string, string])[]>> = {
  batch_step: [
    ['batchNumber', 'Batch'],
    ['product', 'Product'],
    ['stepNumber', 'Step'],
    ['title', 'Title'],
    ['stage', 'Stage'],
    ['block', 'Block'],
    ['instruction', 'Instruction'],
    ['instructionRef', 'Instruction reference'],
    ['values', 'Values'],
    ['fields', 'Values'],
    ['derived', 'Derived values'],
    ['entries', 'Entries'],
    ['exceptions', 'Exceptions'],
    ['mbrVersion', 'Master record version'],
    ['mbrHash', 'Master record hash'],
  ],
  batch_stage: [
    ['batchNumber', 'Batch'],
    ['product', 'Product'],
    ['stageKey', 'Stage'],
    ['title', 'Title'],
    ['steps', 'Steps'],
    ['summary', 'Summary'],
    ['exceptions', 'Exceptions'],
  ],
  mbr_version: [
    ['number', 'Number'],
    ['revision', 'Revision'],
    ['title', 'Title'],
    ['product', 'Product'],
    ['state', 'State'],
    ['markets', 'Markets'],
    ['contentHash', 'Content hash'],
    ['changes', 'Changes'],
  ],
  batch_exception: [
    ['batchNumber', 'Batch'],
    ['runId', 'Run'],
    ['stepNumber', 'Step'],
    ['stepTitle', 'Step title'],
    ['exceptionId', 'Exception'],
    ['class', 'Class'],
    ['severity', 'Severity'],
    ['recorded', 'Recorded value'],
    ['value', 'Recorded value'],
    ['limit', 'Limit'],
    ['raisedBy', 'Raised by'],
    ['raisedAt', 'Raised at'],
    ['disposition', 'Proposed disposition'],
    ['justification', 'Justification'],
    ['meaning', 'Meaning'],
  ],
};

/** "stepNumber" / "step_number" -> "Step number". */
export function humanize(key: string): string {
  const words = key
    .replace(/_/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .trim()
    .toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

const isObj = (v: unknown): v is Record<string, Json> => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Plain text of well-known value shapes: instants {us, text}, decimals {value, unit}, persons {legalName, loginName}. */
export function scalarText(v: unknown): string | null {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'string') return v === '' ? '(empty)' : v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (isObj(v)) {
    if (typeof v['text'] === 'string' && typeof v['us'] === 'string') return v['text'];
    if (typeof v['legalName'] === 'string') return `${v['legalName']}${typeof v['loginName'] === 'string' ? ` (${v['loginName']})` : ''}${typeof v['role'] === 'string' && v['role'] ? `, ${v['role']}` : ''}`;
    if (typeof v['value'] === 'string' && typeof v['unit'] === 'string' && Object.keys(v).every((k) => ['value', 'unit', 'kind'].includes(k))) return `${v['value']} ${v['unit']}`;
  }
  return null;
}

function Value({ value, depth }: { value: unknown; depth: number }): ReactNode {
  const s = scalarText(value);
  if (s !== null) return <span className={icls('valueCell')}>{s}</span>;
  if (Array.isArray(value)) {
    if (value.length === 0) return <span>none</span>;
    return (
      <ol>
        {(value as unknown[]).map((item, i) => (
          <li key={i}>
            <Value value={item} depth={depth + 1} />
          </li>
        ))}
      </ol>
    );
  }
  if (isObj(value)) return <Facts data={value} order={[]} depth={depth + 1} />;
  return <span>{JSON.stringify(value)}</span>;
}

function Facts({ data, order, depth }: { data: Record<string, unknown>; order: readonly (readonly [string, string])[]; depth: number }) {
  const seen = new Set<string>(['kind']);
  const rows: [string, string, unknown][] = [];
  for (const [key, label] of order) {
    if (key in data && !seen.has(key)) {
      rows.push([key, label, data[key]]);
      seen.add(key);
    }
  }
  for (const key of Object.keys(data).sort()) {
    if (!seen.has(key)) {
      rows.push([key, humanize(key), data[key]]);
      seen.add(key);
    }
  }
  if (depth > 6) return <span>{JSON.stringify(data)}</span>;
  return (
    <dl className={icls('facts')}>
      {rows.map(([key, label, value]) => (
        <div key={key} className={icls('factRow')}>
          <dt>{label}</dt>
          <dd>
            <Value value={value} depth={depth} />
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** The record to be signed, per rendering kind; unknown kinds use the fallback (every field shown). */
export function SignableContent({ view }: { view: SignableContentView }) {
  const rendering = view.rendering as Record<string, unknown> & { kind: string };
  const kind = rendering.kind in KIND_TITLES ? rendering.kind : 'fallback';
  const data: Record<string, unknown> =
    kind === 'fallback' && isObj(rendering['content']) ? { ...(rendering['content'] as Record<string, unknown>), ...(rendering['state'] !== undefined && rendering['state'] !== null ? { state: rendering['state'] } : {}) } : rendering;
  const extra = kind === 'fallback' ? Object.fromEntries(Object.entries(rendering).filter(([k]) => !['kind', 'content', 'state'].includes(k))) : {};
  return (
    <section aria-label={`${KIND_TITLES[kind] ?? 'Record'} to be signed`}>
      <h3 className={icls('sectionTitle')}>{view.title}</h3>
      <Facts data={{ ...data, ...extra }} order={KNOWN[kind] ?? []} depth={0} />
      <p className={icls('muted')}>
        {`${KIND_TITLES[kind] ?? 'Record'} ${view.aggregateId}, content version ${view.contentVersion}${view.preview ? ' (as it will be when signed)' : ''}`}
      </p>
    </section>
  );
}
