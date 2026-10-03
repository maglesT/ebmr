/**
 * The audit trail viewer (module C1; plan section 11 and screens 9 and 20; DI-22, DI-23), on both installations.
 * Read-only: there is no edit, disable or delete anywhere on these screens (the server has no such route either).
 *  - no filter: the chains, newest activity first, filterable by key prefix (mbr_version:, batch:, esig_stub:);
 *  - a chain: its entries in order, grouped by command (business entry first, field changes expandable), and
 *    "Verify chain" (the server recomputes every hash);
 *  - a correlation or a person: the entries of one command, or of one person. A list across chains stops before
 *    entries that an action still in progress may yet add (review P11): a page can then end early (fewer entries
 *    than asked for, yet a next cursor), the page says so, and "Load more entries" fetches them once that action has
 *    finished; no entry is skipped.
 */
import { getRouteApi, Link } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { routes, type AuditEventView, type CallError, type ChainVerificationView } from '@ebmr/api-contract';
import { audit, Banner, Button, Field } from '@ebmr/ui-kit';
import { api } from '../../api/client.ts';
import { useApiQuery } from '../../api/hooks.ts';
import { RefusalMessage } from '../../app/refusal.tsx';
import { auditLink, type AuditSearch } from './links.ts';

const route = getRouteApi('/audit');
const PAGE = '100';

/**
 * A page that ends early: fewer entries than asked for, and yet the server says there are more. The server only
 * answers so when it held the list back before entries an action still in progress may yet commit (review P11).
 */
const endedEarly = (page: { events: readonly AuditEventView[]; nextCursor: string | null }): boolean => page.nextCursor !== null && page.events.length < Number(PAGE);

function ChainList() {
  const [prefix, setPrefix] = useState('');
  const q = useApiQuery(routes.audit.chains, { query: prefix ? { prefix } : {} });
  return (
    <section aria-labelledby="chains-title">
      <h2 id="chains-title">Audit chains</h2>
      <Field label="Chain key begins with" name="chainPrefix" value={prefix} onChange={setPrefix} description="For example batch:, mbr_version: or esig_stub:" />
      {q.isPending ? <p>Loading…</p> : null}
      {q.isError ? <RefusalMessage error={q.error.error} /> : null}
      {q.data ? (
        q.data.chains.length === 0 ? (
          <p>No chain matches.</p>
        ) : (
          <ul aria-label="Chains">
            {q.data.chains.map((c) => (
              <li key={c.chainKey}>
                <Link {...auditLink({ chain: c.chainKey })}>{c.label}</Link>
                {` · ${c.events} entries${c.lastAt ? ` · last ${c.lastAt.text}` : ''}`}
              </li>
            ))}
          </ul>
        )
      ) : null}
    </section>
  );
}

/** Entries matching a filter, loaded page by page (keyset cursor). */
function EventPages({ filter }: { filter: AuditSearch }) {
  const [events, setEvents] = useState<AuditEventView[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<CallError | null>(null);
  const [loading, setLoading] = useState(true);
  /** The last page ended early: entries after it may still be being written by an action in progress. */
  const [heldBack, setHeldBack] = useState(false);
  const key = JSON.stringify(filter);

  const load = async (after: string | null, replace: boolean) => {
    setLoading(true);
    const f = JSON.parse(key) as AuditSearch;
    const r = await api.call(routes.audit.events, {
      query: {
        ...(f.chain ? { chainKey: f.chain } : {}),
        ...(f.correlation ? { correlationId: f.correlation } : {}),
        ...(f.person ? { personId: f.person } : {}),
        ...(after ? { cursor: after } : {}),
        limit: PAGE,
      },
    });
    setLoading(false);
    if (!r.ok) {
      setError(r.error);
      return;
    }
    setError(null);
    setEvents((prev) => (replace ? r.value.events : [...prev, ...r.value.events]));
    setCursor(r.value.nextCursor);
    setHeldBack(endedEarly(r.value));
  };

  useEffect(() => {
    let live = true;
    void (async () => {
      const f = JSON.parse(key) as AuditSearch;
      const r = await api.call(routes.audit.events, {
        query: { ...(f.chain ? { chainKey: f.chain } : {}), ...(f.correlation ? { correlationId: f.correlation } : {}), ...(f.person ? { personId: f.person } : {}), limit: PAGE },
      });
      if (!live) return;
      setLoading(false);
      if (!r.ok) {
        setError(r.error);
        return;
      }
      setEvents(r.value.events);
      setCursor(r.value.nextCursor);
      setHeldBack(endedEarly(r.value));
    })();
    return () => {
      live = false;
    };
  }, [key]);

  return (
    <section aria-label="Audit entries" aria-busy={loading}>
      {error ? <RefusalMessage error={error} /> : null}
      <audit.AuditEventList events={events} />
      {heldBack ? <p>More entries are still being written by an action in progress. Load more entries in a moment to see them.</p> : null}
      {cursor ? (
        <Button onPress={() => void load(cursor, false)} isDisabled={loading}>
          Load more entries
        </Button>
      ) : null}
      {loading ? <p>Loading…</p> : null}
    </section>
  );
}

function ChainView({ chainKey }: { chainKey: string }) {
  const [result, setResult] = useState<ChainVerificationView | null>(null);
  const [error, setError] = useState<CallError | null>(null);
  const [busy, setBusy] = useState(false);
  // A verdict is shown only as the answer of the latest verification: it goes when a new one starts, and a
  // verification that fails leaves none (never an earlier "Chain intact" next to the failure; F07).
  const verify = async () => {
    setResult(null);
    setError(null);
    setBusy(true);
    const r = await api.call(routes.audit.verifyChain, { params: { chainKey } });
    setBusy(false);
    if (r.ok) setResult(r.value);
    else setError(r.error);
  };
  return (
    <>
      <h2>{`Chain ${chainKey}`}</h2>
      <audit.ChainVerifyBadge result={result} busy={busy} onVerify={() => void verify()} />
      {error ? <RefusalMessage error={error} /> : null}
      <EventPages filter={{ chain: chainKey }} />
    </>
  );
}

export function AuditPage() {
  const search: AuditSearch = route.useSearch();
  return (
    <section aria-labelledby="audit-title">
      <h1 id="audit-title">Audit trail</h1>
      <Banner tone="info" title="Read-only. Every entry is part of a hash chain; nothing here can be edited or removed." />
      {search.chain || search.correlation || search.person ? (
        <p>
          <Link {...auditLink({})}>All chains</Link>
        </p>
      ) : null}
      {search.chain ? (
        <ChainView key={search.chain} chainKey={search.chain} />
      ) : search.correlation || search.person ? (
        <>
          <h2>{search.correlation ? `One action (${search.correlation})` : `Entries by person ${search.person ?? ''}`}</h2>
          <EventPages filter={search} />
        </>
      ) : (
        <ChainList />
      )}
    </section>
  );
}
