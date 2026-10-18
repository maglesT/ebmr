/**
 * The report views and their documented export (slice 7g-5, decision 0025; routes dashboards.catalog and
 * dashboards.export): the catalogue of the report views the analytics path reads (version, grain, columns), and one
 * view's rows as text with the SHA-256 the server computed over them. The file offered for download is the very text
 * that hash covers (the view, its columns and its rows as JSON), so whoever receives it can check it. For information
 * only, like the dashboards: no GMP decision is taken on it.
 */
import { useState } from 'react';
import { routes, type ReportExportView } from '@ebmr/api-contract';
import { Button } from '@ebmr/ui-kit';
import { useApiQuery } from '../../api/hooks.ts';
import { Section } from '../../app/acts.tsx';
import { RefusalMessage } from '../../app/refusal.tsx';

const PREVIEW_ROWS = 20;

export function ReportExport() {
  const catalog = useApiQuery(routes.dashboards.catalog);
  const [view, setView] = useState<string | null>(null);
  return (
    <Section title="Report views and their export" testId="report-catalog">
      {catalog.error ? <RefusalMessage error={catalog.error.error} /> : null}
      {catalog.data ? <p>As of {catalog.data.dataAsOf.text}.</p> : null}
      <ul>
        {catalog.data?.views.map((v) => (
          <li key={v.viewName} data-testid={`report-view-${v.viewName}`}>
            <strong>{v.viewName}</strong> (version {v.version}, one row per {v.grain}): {v.description}. Columns: {v.columns.map((c) => `${c.name} (${c.type})`).join(', ')}.{' '}
            <Button onPress={() => setView(v.viewName)}>{`Export ${v.viewName}`}</Button>
          </li>
        ))}
      </ul>
      {view ? <Export view={view} /> : null}
    </Section>
  );
}

/** The exact text the server's SHA-256 covers (features/dashboards/reads.ts exportView). */
const exportText = (e: ReportExportView): string => JSON.stringify({ view: e.viewName, columns: e.columns, rows: e.rows });

function Export({ view }: { view: string }) {
  const q = useApiQuery(routes.dashboards.export, { query: { view } });
  const e = q.data;
  return (
    <div data-testid="report-export">
      <h3>{`Export of ${view}`}</h3>
      {q.error ? <RefusalMessage error={q.error.error} /> : null}
      {e ? (
        <>
          <p>
            {e.rows.length} row(s), read {e.readAt.text} (data as of {e.dataAsOf.text}). SHA-256 <code data-testid="report-export-sha256">{e.sha256}</code>.{' '}
            <a href={`data:application/json;charset=utf-8,${encodeURIComponent(exportText(e))}`} download={`${e.viewName}.json`}>
              Download the export
            </a>
          </p>
          <table>
            <caption>{e.rows.length > PREVIEW_ROWS ? `The first ${String(PREVIEW_ROWS)} rows` : 'The rows'}</caption>
            <thead>
              <tr>
                {e.columns.map((c) => (
                  <th key={c} scope="col">
                    {c}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {e.rows.slice(0, PREVIEW_ROWS).map((r, i) => (
                <tr key={i}>
                  {r.map((cell, j) => (
                    <td key={j}>{cell ?? ''}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </>
      ) : null}
    </div>
  );
}
