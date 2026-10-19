/**
 * What the validation and records screens share (Phase 7 slice 7g-3): the reads read again after every act (route ids,
 * so `useRefresh` invalidates each by its prefix), a download of a text file the server hands over, and a select.
 */
import { useState } from 'react';
import { routes, type AnyRoute, type CallError, type CallInput, type RouteResponse } from '@ebmr/api-contract';
import { api } from '../../api/client.ts';
import { ActButton } from '../../app/acts.tsx';
import { RefusalMessage } from '../../app/refusal.tsx';

export const VALIDATION_READS: readonly string[] = Object.values(routes.validation)
  .filter((r) => r.method === 'GET')
  .map((r) => r.id);

export const ESIG_CATALOGUE_READS: readonly string[] = [routes.esig.meaningTypes.id, routes.esig.sealKeys.id];

/** Asks the server for a file and offers it to save (as the backup copy does); `pick` names it and gives its text. */
export function Download<R extends AnyRoute>({ label, route, input, pick, testId }: {
  label: string;
  route: R;
  input: CallInput<R>;
  pick: (v: RouteResponse<R>) => { name: string; text: string; mediaType: string };
  testId: string;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<CallError | null>(null);
  const [href, setHref] = useState<{ url: string; name: string } | null>(null);
  const fetchFile = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api.call(route, input);
      if (!r.ok) {
        setError(r.error);
        return;
      }
      const f = pick(r.value);
      setHref({ url: `data:${f.mediaType};charset=utf-8,${encodeURIComponent(f.text)}`, name: f.name });
    } finally {
      setBusy(false);
    }
  };
  return (
    <span data-testid={testId}>
      {href ? (
        <a href={href.url} download={href.name}>
          Save {href.name}
        </a>
      ) : (
        <ActButton label={label} primary={false} disabled={busy} onPress={fetchFile} />
      )}
      {error ? <RefusalMessage error={error} /> : null}
    </span>
  );
}

export function Choice<T extends string>({ name, label, value, options, onChange }: { name: string; label: string; value: T; options: readonly T[]; onChange: (v: T) => void }) {
  return (
    <label style={{ display: 'block' }}>
      {label}{' '}
      <select name={name} value={value} onChange={(e) => onChange(e.target.value as T)}>
        {options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    </label>
  );
}

/** A plain-language rendering of a code (DESCRIBED -> Described). */
export const words = (code: string): string => code.charAt(0) + code.slice(1).toLowerCase().replace(/_/g, ' ');
