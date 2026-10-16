/**
 * The federated genealogy (Phase 6 slice 6i; recipe-core 1090, 1091; L-41, PR-57, IN-29; D-P6i-0-7, D-P6i-0-9).
 *
 * Asking: for a TRANSFER node the database reached, the server asks the installation at the other end of the transfer.
 * The request is built by this database (recipe.issue_federated_request: nonce, issued-at, query) and sealed with this
 * installation's key; the answer is kept only if this database verifies the other installation's seal and that it
 * answers exactly what was asked (recipe.record_federated_excerpt). A site that does not answer (or refuses, or answers
 * wrongly) is logged with an alarm (recipe.record_federation_failure); the last excerpt received is shown with its own,
 * older as-of point and the part is not ANSWERED, so the result says it is incomplete (never silently partial).
 *
 * Answering: the endpoint hands the sealed request to recipe.answer_federated_genealogy, which checks the seal, the
 * destination, the time and the nonce, and that the transfer was exchanged with the caller; the server seals the
 * excerpt the database built.
 */
import type pg from 'pg';
import type { FederatedPartStatus, FederatedPartView, FederatedTraceView, GenealogyDirection, GenealogyEdgeView, GenealogyNodeKind, GenealogyNodeView } from '@ebmr/api-contract';
import type { AppContext } from '../../platform/context.ts';
import { trace } from '../genealogy/reads.ts';
import { loadInstallationKey, type InstallationKey } from './keys.ts';

type Db = Pick<pg.Pool, 'query'>;

const keys = new WeakMap<AppContext, InstallationKey | null>();

/** This server's installation key (EBMR_INSTALLATION_KEY_FILE), read once per server; null when none is configured. */
export function installationKey(app: AppContext): InstallationKey | null {
  if (!keys.has(app)) keys.set(app, loadInstallationKey(app.config.installationKeyFile));
  return keys.get(app) ?? null;
}

interface ExcerptRow {
  nodeKind: GenealogyNodeKind;
  nodeId: string;
  parentKind: GenealogyNodeKind | null;
  parentId: string | null;
  edgeKind: GenealogyEdgeView['edgeKind'];
  depth: number;
}
interface ExcerptNode {
  kind: GenealogyNodeKind;
  id: string;
  label: string;
  code: string | null;
  name: string | null;
  sub_kind: string | null;
  state: string | null;
}
export interface Excerpt {
  asOfUs: string;
  rows: ExcerptRow[];
  nodes: ExcerptNode[];
}

export interface PeerAnswer {
  status: FederatedPartStatus;
  detail: string | null;
  /** The excerpt shown: the answer (ANSWERED) or the last one received before (its own as-of), or none. */
  excerpt: Excerpt | null;
  excerptId: string | null;
  excerptAsOfUs: string | null;
}

const excerptOf = (payload: string): Excerpt => {
  const p = JSON.parse(payload) as { asOfUs: string; rows: ExcerptRow[]; nodes: ExcerptNode[] };
  return { asOfUs: p.asOfUs, rows: p.rows, nodes: p.nodes };
};

/** The last excerpt this site received for (peer, transfer, direction), whatever its as-of. */
async function lastExcerpt(db: Db, peer: string, transferId: string, direction: GenealogyDirection): Promise<{ id: string; payload: string } | null> {
  const { rows } = await db.query<{ id: string | null; payload: string | null }>(
    'select (e).id::text as id, (e).payload as payload from (select recipe.last_federated_excerpt($1, $2, $3) as e) x', [peer, transferId, direction]);
  return rows[0]?.id && rows[0].payload ? { id: rows[0].id, payload: rows[0].payload } : null;
}

const reasonOf = (text: string): string => {
  try {
    const j = JSON.parse(text) as { why?: unknown; whatHappened?: unknown; code?: unknown };
    return [j.code, j.why ?? j.whatHappened].filter((x) => typeof x === 'string').join(' ') || text.slice(0, 500);
  } catch {
    return text.slice(0, 500);
  }
};

/**
 * Asks `peer` for its genealogy from `transferId` in `direction` as of `asOfUs`. Never throws for the other site's
 * failure: it is the part's status, logged with an alarm.
 */
export async function askPeer(app: AppContext, db: Db, peer: string, transferId: string, direction: GenealogyDirection, asOfUs: string): Promise<PeerAnswer> {
  let issued: { nonce: string; request: string; baseUrl: string };
  try {
    issued = (await db.query<{ r: { nonce: string; request: string; baseUrl: string } }>(
      "select recipe.issue_federated_request($1, $2, $3, timestamptz 'epoch' + ($4::bigint * interval '1 microsecond')) as r", [peer, transferId, direction, asOfUs])).rows[0]!.r;
  } catch (error) {
    const last = await lastExcerpt(db, peer, transferId, direction);
    return { status: 'NOT_REGISTERED', detail: error instanceof Error ? error.message : String(error), excerpt: last ? excerptOf(last.payload) : null, excerptId: last?.id ?? null, excerptAsOfUs: last ? excerptOf(last.payload).asOfUs : null };
  }
  const fail = async (status: 'UNREACHABLE' | 'REFUSED' | 'WRONG_ANSWER', detail: string, record = true): Promise<PeerAnswer> => {
    if (record) await db.query('select recipe.record_federation_failure($1, $2, $3)', [issued.nonce, status, detail]);
    const last = await lastExcerpt(db, peer, transferId, direction);
    return { status, detail, excerpt: last ? excerptOf(last.payload) : null, excerptId: last?.id ?? null, excerptAsOfUs: last ? excerptOf(last.payload).asOfUs : null };
  };
  const key = installationKey(app);
  if (!key) return fail('REFUSED', 'EBMR-FED-020 this server holds no installation key, so it cannot seal a request (EBMR_INSTALLATION_KEY_FILE)');
  if (app.config.env === 'production' && !issued.baseUrl.startsWith('https://')) {
    return fail('REFUSED', `EBMR-FED-021 ${peer} is registered with an http address; production calls other installations over https only (DI-13)`);
  }
  let res: Response;
  try {
    res = await fetch(`${issued.baseUrl.replace(/\/+$/, '')}/api/federation/genealogy`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ request: issued.request, seal: key.seal('federation-request', issued.request) }),
      signal: AbortSignal.timeout(app.config.federationTimeoutS * 1000),
    });
  } catch (error) {
    return fail('UNREACHABLE', `${peer} did not answer within ${app.config.federationTimeoutS} seconds (${error instanceof Error ? (error.cause instanceof Error ? error.cause.message : error.message) : String(error)})`);
  }
  const text = await res.text().catch(() => '');
  if (res.status !== 200) return fail('REFUSED', `${peer} refused the request (HTTP ${res.status}): ${reasonOf(text)}`);
  let body: { payload?: unknown; seal?: unknown };
  try {
    body = JSON.parse(text) as { payload?: unknown; seal?: unknown };
  } catch {
    body = {};
  }
  if (typeof body.payload !== 'string' || typeof body.seal !== 'string') return fail('WRONG_ANSWER', `${peer} answered something that is not a sealed excerpt`);
  const rec = (await db.query<{ r: { ok: boolean; excerptId?: string; reason?: string } }>('select recipe.record_federated_excerpt($1, $2, $3) as r', [issued.nonce, body.payload, body.seal])).rows[0]!.r;
  if (!rec.ok || !rec.excerptId) return fail('WRONG_ANSWER', rec.reason ?? 'the answer was not kept', false);
  const excerpt = excerptOf(body.payload);
  return { status: 'ANSWERED', detail: null, excerpt, excerptId: rec.excerptId, excerptAsOfUs: excerpt.asOfUs };
}

/** The installation at the other end of a TRANSFER node as this site sees it. */
export const otherEnd = (n: Pick<GenealogyNodeView, 'subKind' | 'code' | 'name'>): string => (n.subKind === 'OUTBOUND' ? n.name : n.code) ?? '';

const nodeView = (n: ExcerptNode): GenealogyNodeView => ({ kind: n.kind, id: n.id, label: n.label, code: n.code, name: n.name, subKind: n.sub_kind, state: n.state });
const edgeView = (r: ExcerptRow): GenealogyEdgeView => ({
  node: { kind: r.nodeKind, id: r.nodeId },
  parent: r.parentKind && r.parentId ? { kind: r.parentKind, id: r.parentId } : null,
  edgeKind: r.edgeKind,
  depth: r.depth,
});

/** The local trace and, for every transfer it reaches, the other site's part (contract genealogy.federatedTrace). */
export async function federatedTrace(app: AppContext, db: Db, kind: GenealogyNodeKind, id: string, direction: GenealogyDirection, asked: string | undefined): Promise<FederatedTraceView> {
  const local = await trace(app, db, kind, id, direction, asked);
  const me = (await db.query<{ code: string | null }>('select (platform.current_installation()).installation_code as code')).rows[0]?.code ?? null;
  const transfers = local.nodes.filter((n) => n.kind === 'TRANSFER');
  const remote: FederatedPartView[] = [];
  const beyond = new Map<string, { transferId: string; packageNo: string; peer: string }>();
  for (const t of transfers) {
    const peer = otherEnd(t);
    const a = await askPeer(app, db, peer, t.id, direction, local.asOf.us);
    const nodes = (a.excerpt?.nodes ?? []).map(nodeView);
    for (const n of nodes) {
      if (n.kind !== 'TRANSFER' || n.id === t.id || transfers.some((x) => x.id === n.id)) continue;
      const far = otherEnd(n);
      if (far !== me) beyond.set(n.id, { transferId: n.id, packageNo: n.label, peer: far });
    }
    remote.push({
      transferId: t.id,
      packageNo: t.label,
      peer,
      status: a.status,
      askedAsOf: local.asOf,
      excerptAsOf: a.excerptAsOfUs ? app.formatInstant(a.excerptAsOfUs) : null,
      detail: a.detail,
      nodes,
      edges: (a.excerpt?.rows ?? []).map(edgeView),
    });
  }
  return {
    local,
    remote,
    complete: remote.every((p) => p.status === 'ANSWERED') && beyond.size === 0,
    beyondOneHop: [...beyond.values()],
  };
}
