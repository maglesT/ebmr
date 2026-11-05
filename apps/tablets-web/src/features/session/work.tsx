/**
 * Declutter D3 (docs/build-plan/declutter/plan.md section 4): the home's four work cards and the one list each opens.
 * Every count comes from an existing read (execution.workQueue, review.queue, release.queue); a card is shown only where
 * the session's role may make its read and its route is served on this installation (display only: the server and the
 * database stay the authority for every read and act, DI-17).
 */
import { Link } from '@tanstack/react-router';
import { routes, type ManufacturerReleaseState, type ReviewState } from '@ebmr/api-contract';
import { useApiQuery } from '../../api/hooks.ts';
import { useBoot } from '../../app/boot.tsx';
import { cls } from '../../app/classes.ts';
import { readOffered } from '../../app/tile-access.ts';

export type WorkKind = 'my-batches' | 'to-sign' | 'to-review' | 'to-release';

interface WorkCard {
  readonly kind: WorkKind;
  readonly title: string;
  readonly route: typeof routes.execution.workQueue | typeof routes.review.queue | typeof routes.release.queue;
}

export const WORK_CARDS: readonly WorkCard[] = [
  { kind: 'my-batches', title: 'My batches', route: routes.execution.workQueue },
  { kind: 'to-sign', title: 'To sign', route: routes.execution.workQueue },
  { kind: 'to-review', title: 'To review', route: routes.review.queue },
  { kind: 'to-release', title: 'To release', route: routes.release.queue },
];

/**
 * The review states that still need a reviewer: EXECUTION_COMPLETE (awaiting the production approval) and
 * PRODUCTION_APPROVED (awaiting the QA review). QA_REVIEWED is finished; ISSUED, IN_PROGRESS and ON_HOLD are still in
 * execution; CANCELLED and ABORTED are closed.
 */
const REVIEW_OPEN: readonly ReviewState[] = ['EXECUTION_COMPLETE', 'PRODUCTION_APPROVED'];

/**
 * The manufacturer release states with no decision yet: NOT_READY (G-REL not met; the lot may still be rejected) and
 * READY. RELEASED, REJECTED and the after-release states (suspended, recalled, rejected after release) are decided.
 */
const RELEASE_OPEN: readonly ManufacturerReleaseState[] = ['NOT_READY', 'READY'];

export interface WorkRow {
  readonly key: string;
  readonly batchNumber: string;
  readonly product: string;
  readonly text: string;
  readonly link: { readonly to: '/runs/$runId/steps/$stepKey'; readonly params: { runId: string; stepKey: string } } | { readonly to: '/review/$batchId'; readonly params: { batchId: string } } | { readonly to: '/release/$lotId'; readonly params: { lotId: string } };
}

export interface WorkState {
  readonly status: 'pending' | 'error' | 'success';
  readonly rows: readonly WorkRow[];
  /** The card's count: distinct batches for "My batches", else the rows. */
  readonly count: number;
}

/** The cards this session is offered (role may make the read; the route is served on this installation). */
export function useWorkCards(): readonly WorkCard[] {
  const boot = useBoot();
  const installation = boot.meta?.installation ?? 'GMP';
  const role = boot.session?.role ?? null;
  return WORK_CARDS.filter((c) => (c.route.installation === 'ANY' || c.route.installation === installation) && readOffered(c.route.id, installation, role));
}

/** The rows and count of one card, from its read (queried only when `enabled`). */
export function useWork(kind: WorkKind, enabled: boolean): WorkState {
  const isQueue = kind === 'my-batches' || kind === 'to-sign';
  const queue = useApiQuery(routes.execution.workQueue, {}, { enabled: enabled && isQueue });
  const review = useApiQuery(routes.review.queue, {}, { enabled: enabled && kind === 'to-review' });
  const release = useApiQuery(routes.release.queue, {}, { enabled: enabled && kind === 'to-release' });
  const q = isQueue ? queue : kind === 'to-review' ? review : release;
  if (q.isError) return { status: 'error', rows: [], count: 0 };
  if (isQueue) {
    if (!queue.data) return { status: 'pending', rows: [], count: 0 };
    const items = kind === 'to-sign' ? queue.data.items.filter((i) => i.action.available) : queue.data.items;
    const rows = items.map((i) => ({
      key: `${i.runId}:${i.stepKey}`,
      batchNumber: i.batchNumber,
      product: `${i.product.name} ${i.product.strength}`,
      text: `${i.stage} · ${i.number} ${i.title}`,
      link: { to: '/runs/$runId/steps/$stepKey' as const, params: { runId: i.runId, stepKey: i.stepKey } },
    }));
    const count = kind === 'my-batches' ? new Set(items.map((i) => i.runId)).size : rows.length;
    return { status: 'success', rows, count };
  }
  if (kind === 'to-review') {
    if (!review.data) return { status: 'pending', rows: [], count: 0 };
    const rows = review.data.batches
      .filter((b) => REVIEW_OPEN.includes(b.reviewState))
      .map((b) => ({ key: b.batchId, batchNumber: b.batchNumber, product: b.product, text: b.reviewState.replace(/_/g, ' ').toLowerCase(), link: { to: '/review/$batchId' as const, params: { batchId: b.batchId } } }));
    return { status: 'success', rows, count: rows.length };
  }
  if (!release.data) return { status: 'pending', rows: [], count: 0 };
  const rows = release.data.lots
    .filter((l) => RELEASE_OPEN.includes(l.state))
    .map((l) => ({ key: l.lotId, batchNumber: l.batchNumber, product: `${l.productCode} ${l.strength}`, text: `${l.lotCode} · ${l.state.replace(/_/g, ' ').toLowerCase()}`, link: { to: '/release/$lotId' as const, params: { lotId: l.lotId } } }));
  return { status: 'success', rows, count: rows.length };
}

const countText = (w: WorkState): string => (w.status === 'pending' ? '…' : w.status === 'error' ? '–' : String(w.count));

function Card({ card }: { card: WorkCard }) {
  const w = useWork(card.kind, true);
  return (
    <Link to={`/work/${card.kind}`} className={cls('workCard')} data-testid={`work-card-${card.kind}`}>
      <span className={cls('workTitle')}>{card.title}</span> <span className={cls('workCount')}>{countText(w)}</span>
    </Link>
  );
}

/** The home's work cards (only those offered). */
export function WorkCards() {
  const cards = useWorkCards();
  if (cards.length === 0) return null;
  return (
    <nav aria-label="Work" className={cls('workCards')}>
      {cards.map((c) => (
        <Card key={c.kind} card={c} />
      ))}
    </nav>
  );
}

function RowLink({ row }: { row: WorkRow }) {
  const body = (
    <>
      <strong>{row.batchNumber}</strong> <span>{row.product}</span> <span className={cls('muted')}>{row.text}</span> <span aria-hidden="true">›</span>
    </>
  );
  return (
    <Link to={row.link.to} params={row.link.params} className={cls('workRow')}>
      {body}
    </Link>
  );
}

/** The one list a work card opens: a heading with the count, then a linked row per item. */
export function WorkList({ kind }: { kind: WorkKind }) {
  const card = WORK_CARDS.find((c) => c.kind === kind) ?? WORK_CARDS[0];
  const offered = useWorkCards().some((c) => c.kind === kind);
  const w = useWork(kind, offered);
  const title = card?.title ?? '';
  return (
    <>
      <h1>
        {title} ({offered ? countText(w) : '–'})
      </h1>
      {offered && w.status === 'success' && w.rows.length === 0 ? <p>Nothing here.</p> : null}
      {w.rows.length > 0 ? (
        <ul className={cls('workList')} aria-label={title}>
          {w.rows.map((r) => (
            <li key={r.key}>
              <RowLink row={r} />
            </li>
          ))}
        </ul>
      ) : null}
    </>
  );
}

export const MyBatchesPage = () => <WorkList kind="my-batches" />;
export const ToSignPage = () => <WorkList kind="to-sign" />;
export const ToReviewPage = () => <WorkList kind="to-review" />;
export const ToReleasePage = () => <WorkList kind="to-release" />;
