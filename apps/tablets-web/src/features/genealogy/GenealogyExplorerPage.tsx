/**
 * The genealogy explorer (Phase 6 slice 6d; PR-57, IN-07, IN-29): the trace of a lot, batch, container or shipment,
 * forward or backward, at any depth, as of an instant (recipe.genealogy over the insert-only rows of each business event,
 * D-P6d-1). Shown as a tree from the start (each node expanded once where it is first reached; a node reached again is
 * named with its edge, D-P6d-0-2) and as a table, filtered by node kind, and exported as CSV. The as-of instant is typed
 * with its offset, never guessed from the browser's zone; empty means now. Every node, edge and depth is the server's.
 */
import { useMemo, useState, type ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import { routes, GenealogyDirection, GenealogyNodeKind, type FederatedTraceView, type GenealogyEdgeView, type GenealogyNodeView, type GenealogyTraceView } from '@ebmr/api-contract';
import { Banner, Field, floor, StatusChip } from '@ebmr/ui-kit';
import { useApiQuery } from '../../api/hooks.ts';
import { ActButton, Section } from '../../app/acts.tsx';
import { RefusalMessage } from '../../app/refusal.tsx';
import { useRouteSearch } from '../floor/params.ts';
import { validToUs } from '../release/QpPackage.tsx';
import { csvHref, nodeLine, words } from './reads.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KINDS = GenealogyNodeKind.options;
const DIRECTIONS = GenealogyDirection.options;
type Kind = (typeof KINDS)[number];
type Direction = (typeof DIRECTIONS)[number];
type Filter = Kind | 'ALL';

interface Asked {
  kind: Kind;
  id: string;
  direction: Direction;
  asOfUs: string | null;
  /** Phase 6 slice 6i: ask the installations at the other end of each transfer reached (genealogy.federatedTrace). */
  acrossSites: boolean;
}

const key = (n: { kind: string; id: string }): string => `${n.kind}:${n.id}`;

export function GenealogyExplorerPage() {
  const search = useRouteSearch();
  const initialKind = KINDS.find((k) => k === search['kind']) ?? 'LOT';
  const initialDirection = DIRECTIONS.find((d) => d === search['direction']) ?? 'FORWARD';
  const initialId = search['id'] ?? '';
  const [kind, setKind] = useState<Kind>(initialKind);
  const [id, setId] = useState(initialId);
  const [direction, setDirection] = useState<Direction>(initialDirection);
  const [asOf, setAsOf] = useState('');
  const [acrossSites, setAcrossSites] = useState(false);
  const [asked, setAsked] = useState<Asked | null>(UUID.test(initialId) ? { kind: initialKind, id: initialId, direction: initialDirection, asOfUs: null, acrossSites: false } : null);
  const asOfUs = asOf.trim() === '' ? null : validToUs(asOf);
  const ok = UUID.test(id.trim()) && (asOf.trim() === '' || asOfUs !== null);
  return (
    <>
      <h1>Genealogy explorer</h1>
      <p>
        Where a lot, batch, container or shipment came from (backward) or went (forward), through every split, merge, rework, addition, recovery and shipment, as the
        records stood at an instant. Each link is the record its event wrote; nothing is inferred.
      </p>
      <Section title="Trace" testId="genealogy-ask">
        <floor.ChoiceGroup label="Start from" options={KINDS.map((k) => ({ value: k, label: words(k) }))} value={kind} onChange={(v) => setKind(KINDS.find((k) => k === v) ?? 'LOT')} />
        <Field name="genealogyId" label="Record id" value={id} onChange={setId} />
        <floor.ChoiceGroup
          label="Direction"
          options={[
            { value: 'FORWARD', label: 'Forward (where it went)' },
            { value: 'BACKWARD', label: 'Backward (where it came from)' },
          ]}
          value={direction}
          onChange={(v) => setDirection(DIRECTIONS.find((d) => d === v) ?? 'FORWARD')}
        />
        <Field name="genealogyAsOf" label="As of (empty: now; with offset, e.g. 2026-10-12T10:10:00+05:30)" value={asOf} onChange={setAsOf} />
        <label>
          <input type="checkbox" checked={acrossSites} onChange={(e) => setAcrossSites(e.target.checked)} /> Across sites (ask the other installation of each transfer reached)
        </label>
        <ActButton label="Trace" disabled={!ok} onPress={() => ok && setAsked({ kind, id: id.trim().toLowerCase(), direction, asOfUs, acrossSites })} />
      </Section>
      {asked ? asked.acrossSites ? <FederatedResult asked={asked} /> : <TraceResult asked={asked} /> : null}
    </>
  );
}

function TraceResult({ asked }: { asked: Asked }) {
  const q = useApiQuery(routes.genealogy.trace, { query: { kind: asked.kind, id: asked.id, direction: asked.direction, ...(asked.asOfUs ? { asOfUs: asked.asOfUs } : {}) } });
  if (q.error) return <RefusalMessage error={q.error.error} />;
  const t = q.data;
  if (!t) return <p>Tracing…</p>;
  return <TraceView t={t} />;
}

/**
 * Phase 6 slice 6i (L-41, PR-57): the local trace and each other site's sealed part, with the as-of point of what is
 * shown; a part that is not the answer as of the instant asked makes the whole result incomplete, said in a banner.
 */
function FederatedResult({ asked }: { asked: Asked }) {
  const q = useApiQuery(routes.genealogy.federatedTrace, { query: { kind: asked.kind, id: asked.id, direction: asked.direction, ...(asked.asOfUs ? { asOfUs: asked.asOfUs } : {}) } });
  if (q.error) return <RefusalMessage error={q.error.error} />;
  const f = q.data;
  if (!f) return <p>Tracing here and asking the other sites…</p>;
  return (
    <>
      {f.complete ? (
        <Banner tone="ok" title="Complete across sites">
          Every other site answered as of {f.local.asOf.text}.
        </Banner>
      ) : (
        <Banner tone="error" title="Incomplete: not every site answered as of the instant asked">
          <p data-testid="federated-incomplete">
            {f.remote.filter((p) => p.status !== 'ANSWERED').map((p) => `${p.peer} (${words(p.status)})`).join(', ')}
            {f.beyondOneHop.length > 0 ? ` · beyond one hop: ${f.beyondOneHop.map((b) => `${b.packageNo} to ${b.peer}`).join(', ')}` : ''}
          </p>
        </Banner>
      )}
      <TraceView t={f.local} />
      <RemoteParts f={f} />
    </>
  );
}

function RemoteParts({ f }: { f: FederatedTraceView }) {
  return (
    <Section title="Other sites" testId="federated-parts">
      {f.remote.length === 0 ? <p>No transfer to or from another site is reached.</p> : null}
      {f.remote.map((p) => {
        const nodes = new Map(p.nodes.map((n) => [key(n), n]));
        return (
          <div key={p.transferId} data-testid={`federated-part-${p.packageNo}`} data-status={p.status}>
            <h3>
              {p.packageNo} at {p.peer} <StatusChip tone={p.status === 'ANSWERED' ? 'ok' : 'error'} label={words(p.status)} />
            </h3>
            <p>
              {p.excerptAsOf
                ? p.status === 'ANSWERED'
                  ? `As of ${p.excerptAsOf.text}, sealed by ${p.peer}.`
                  : `Last excerpt received, as of ${p.excerptAsOf.text} (older than the instant asked, ${p.askedAsOf.text}).`
                : 'No excerpt was ever received from this site.'}
              {p.detail ? ` ${p.detail}` : ''}
            </p>
            <ul>
              {p.edges.map((e) => {
                const n = nodes.get(key(e.node));
                return (
                  <li key={`${key(e.node)}<${e.parent ? key(e.parent) : ''}<${e.edgeKind ?? ''}`} data-kind={e.node.kind} data-depth={e.depth.toString()}>
                    {e.edgeKind ? <StatusChip tone="neutral" label={words(e.edgeKind)} /> : null} {n ? nodeLine(n) : e.node.id} (depth {e.depth.toString()})
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}
    </Section>
  );
}

function TraceView({ t }: { t: GenealogyTraceView }) {
  const [view, setView] = useState<'TREE' | 'TABLE'>('TREE');
  const [filter, setFilter] = useState<Filter>('ALL');
  return (
    <Section title={`${words(t.direction)} genealogy of ${t.start.label}`} testId="genealogy-result">
      <p data-testid="genealogy-summary">
        As of {t.asOf.text}: {t.counts.lots.toString()} lot(s), {t.counts.batches.toString()} batch(es), {t.counts.containers.toString()} container(s),{' '}
        {t.counts.shipments.toString()} shipment(s){t.counts.transfers ? `, ${t.counts.transfers.toString()} transfer(s) to or from other sites` : ''}.
      </p>
      <floor.ChoiceGroup
        label="Show as"
        options={[
          { value: 'TREE', label: 'Tree' },
          { value: 'TABLE', label: 'Table' },
        ]}
        value={view}
        onChange={(v) => setView(v === 'TABLE' ? 'TABLE' : 'TREE')}
      />
      <floor.ChoiceGroup
        label="Node kind"
        options={[{ value: 'ALL', label: 'All' }, ...KINDS.map((k) => ({ value: k, label: words(k) }))]}
        value={filter}
        onChange={(v) => setFilter(KINDS.find((k) => k === v) ?? 'ALL')}
      />
      {view === 'TREE' ? <Tree trace={t} filter={filter} /> : <Table trace={t} filter={filter} />}
      <p>
        <a data-testid="genealogy-export" href={csvHref(exportRows(t))} download={`genealogy-${t.start.label}-${t.direction.toLowerCase()}-${t.asOf.us}.csv`}>
          Export as CSV
        </a>
      </p>
    </Section>
  );
}

/** Every edge row as the table shows it, the as-of point and direction in each file name and header (unfiltered). */
export function exportRows(t: GenealogyTraceView): string[][] {
  const nodes = new Map(t.nodes.map((n) => [key(n), n]));
  const label = (r: { kind: string; id: string } | null) => (r ? (nodes.get(key(r))?.label ?? r.id) : '');
  return [
    ['depth', 'kind', 'label', 'id', 'code', 'name', 'sub_kind', 'state', 'edge_kind', 'from_kind', 'from_label', 'direction', 'as_of_us'],
    ...t.edges.map((e) => {
      const n = nodes.get(key(e.node));
      return [e.depth.toString(), e.node.kind, label(e.node), e.node.id, n?.code ?? '', n?.name ?? '', n?.subKind ?? '', n?.state ?? '', e.edgeKind ?? '', e.parent?.kind ?? '', label(e.parent), t.direction, t.asOf.us];
    }),
  ];
}

function Table({ trace: t, filter }: { trace: GenealogyTraceView; filter: Filter }) {
  const nodes = useMemo(() => new Map(t.nodes.map((n) => [key(n), n])), [t]);
  const rows = t.edges.filter((e) => filter === 'ALL' || e.node.kind === filter);
  return (
    <table data-testid="genealogy-table">
      <thead>
        <tr>
          <th scope="col">Depth</th>
          <th scope="col">Node</th>
          <th scope="col">Link</th>
          <th scope="col">Reached from</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((e) => {
          const n = nodes.get(key(e.node));
          const p = e.parent ? nodes.get(key(e.parent)) : undefined;
          return (
            <tr key={`${key(e.node)}<${e.parent ? key(e.parent) : ''}<${e.edgeKind ?? ''}`} data-testid={`genealogy-row-${n?.label ?? e.node.id}`} data-kind={e.node.kind} data-depth={e.depth.toString()}>
              <td>{e.depth.toString()}</td>
              <th scope="row">{n ? <NodeName n={n} /> : e.node.id}</th>
              <td>{e.edgeKind ? words(e.edgeKind) : 'start'}</td>
              <td>{p ? p.label : ''}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

/**
 * The tree from the start: each node's children are the edges whose parent it is; a node is expanded where it is first
 * reached (fewest steps) and named again, unexpanded, under any other parent. With a kind filter, nodes of other kinds
 * stay as the path to the ones shown (dimmed).
 */
function Tree({ trace: t, filter }: { trace: GenealogyTraceView; filter: Filter }) {
  const nodes = useMemo(() => new Map(t.nodes.map((n) => [key(n), n])), [t]);
  const children = useMemo(() => {
    const m = new Map<string, GenealogyEdgeView[]>();
    for (const e of t.edges) {
      if (!e.parent) continue;
      const k = key(e.parent);
      m.set(k, [...(m.get(k) ?? []), e]);
    }
    return m;
  }, [t]);
  const expanded = new Set<string>();
  const render = (n: GenealogyNodeView, edge: GenealogyEdgeView | null): ReactNode => {
    const k = key(n);
    const first = !expanded.has(k);
    expanded.add(k);
    const kids = first ? (children.get(k) ?? []) : [];
    const shown = filter === 'ALL' || n.kind === filter;
    return (
      <li key={`${k}<${edge?.parent ? key(edge.parent) : ''}<${edge?.edgeKind ?? ''}`} data-testid={`genealogy-node-${n.label}`} data-kind={n.kind} data-repeat={String(!first)} style={shown ? undefined : { opacity: 0.55 }}>
        {edge?.edgeKind ? <StatusChip tone="neutral" label={words(edge.edgeKind)} /> : null} <NodeName n={n} />
        {first ? null : ' (reached again; shown above)'}
        {kids.length > 0 ? (
          <ul>
            {kids.map((e) => {
              const c = nodes.get(key(e.node));
              return c ? render(c, e) : null;
            })}
          </ul>
        ) : null}
      </li>
    );
  };
  return <ul data-testid="genealogy-tree">{render(t.start, null)}</ul>;
}

/** A node's line, linking to what can be opened from it. */
function NodeName({ n }: { n: GenealogyNodeView }) {
  if (n.kind === 'LOT' && n.subKind === 'FINISHED')
    return (
      <>
        <Link to="/release/$lotId" params={{ lotId: n.id }}>
          {n.label}
        </Link>{' '}
        {nodeLine(n).slice(n.label.length)}{' '}
        <Link to="/genealogy/lots/$lotId/supply-chain" params={{ lotId: n.id }}>
          supply chain
        </Link>
      </>
    );
  if (n.kind === 'BATCH')
    return (
      <>
        <Link to="/review/$batchId" params={{ batchId: n.id }}>
          {n.label}
        </Link>
        {nodeLine(n).slice(n.label.length)}
      </>
    );
  return <>{nodeLine(n)}</>;
}
