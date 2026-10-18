/**
 * The API reference for developers (Phase 7 slice 7g-4; decision 0025 point 2): the OpenAPI document of the contract as
 * the server builds it (meta.openapi; the same document the CI keeps as an artifact), rendered here: no third-party
 * viewer and nothing from another origin (the strict CSP holds). Routes are grouped by namespace and filtered by text;
 * a route's request and answer schemas open on demand.
 */
import { useMemo, useState } from 'react';
import { routes } from '@ebmr/api-contract';
import { Field, StatusChip } from '@ebmr/ui-kit';
import { useApiQuery } from '../../api/hooks.ts';
import { Section } from '../../app/acts.tsx';
import { RefusalMessage } from '../../app/refusal.tsx';

interface Operation {
  method: string;
  path: string;
  summary: string;
  description: string;
  tag: string;
  schema: unknown;
}

type Doc = { info?: { title?: string; version?: string }; paths?: Record<string, Record<string, { summary?: string; description?: string; tags?: string[] } & Record<string, unknown>>> };

export function operationsOf(doc: Doc): Operation[] {
  const out: Operation[] = [];
  for (const [path, methods] of Object.entries(doc.paths ?? {})) {
    for (const [method, op] of Object.entries(methods)) {
      out.push({ method: method.toUpperCase(), path, summary: op.summary ?? '', description: op.description ?? '', tag: op.tags?.[0] ?? 'api', schema: op });
    }
  }
  return out.sort((a, b) => (a.tag === b.tag ? (a.path === b.path ? a.method.localeCompare(b.method) : a.path.localeCompare(b.path)) : a.tag.localeCompare(b.tag)));
}

function OperationItem({ op }: { op: Operation }) {
  const [open, setOpen] = useState(false);
  return (
    <li data-testid={`api-${op.method}-${op.path}`}>
      <details onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}>
        <summary>
          <StatusChip tone={op.method === 'GET' ? 'info' : 'warning'} label={op.method} /> <code>{op.path}</code> {op.summary}
        </summary>
        <p>{op.description}</p>
        {open ? <pre style={{ whiteSpace: 'pre-wrap', maxHeight: '40rem', overflow: 'auto' }}>{JSON.stringify(op.schema, null, 2)}</pre> : null}
      </details>
    </li>
  );
}

export function ApiReferencePage() {
  const doc = useApiQuery(routes.meta.openapi, {}, { staleTime: Infinity });
  const [filter, setFilter] = useState('');
  const ops = useMemo(() => (doc.data ? operationsOf(doc.data as Doc) : []), [doc.data]);
  const shown = ops.filter((o) => filter.trim() === '' || `${o.method} ${o.path} ${o.summary} ${o.description}`.toLowerCase().includes(filter.trim().toLowerCase()));
  const tags = [...new Set(shown.map((o) => o.tag))];
  const info = (doc.data as Doc | undefined)?.info;
  return (
    <>
      <h1>API reference</h1>
      <p>
        The routes of the API contract{info?.version ? ` (version ${info.version})` : ''}, from the OpenAPI document the server builds from it. Every route answers a refusal as a
        refusal envelope; a route marked SESSION needs a signed-in session, a non-GET one the CSRF token, and a mutating one an Idempotency-Key.
      </p>
      {doc.error ? <RefusalMessage error={doc.error.error} /> : null}
      {doc.isLoading ? <p>Loading the API contract…</p> : null}
      <Field name="api-filter" label="Find a route" type="search" value={filter} onChange={setFilter} />
      {doc.data ? <p data-testid="api-count">{`${String(shown.length)} of ${String(ops.length)} routes`}</p> : null}
      {tags.map((tag) => (
        <Section key={tag} title={tag} testId={`api-tag-${tag}`}>
          <ul>
            {shown.filter((o) => o.tag === tag).map((o) => (
              <OperationItem key={`${o.method} ${o.path}`} op={o} />
            ))}
          </ul>
        </Section>
      ))}
    </>
  );
}
