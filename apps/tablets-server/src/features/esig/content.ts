/**
 * The content to be signed when no signable handler previews it (plan section 6, step 1): the kernel's canonical
 * content of the record, exactly the text the challenge will be checked against. The client hashes that text itself
 * and compares (DI-37).
 *
 * Who may read it is the database's decision (tablets 0410, review F34): tab.content_for_signing serves the session
 * bound to the request's cookie token only a pair of aggregate type and meaning this installation signs through the
 * kernel's provider, and only a record the session's role may read and a meaning it may sign. The signable handlers
 * read a RECORD-class record's content inside their commands through tab.record_content_for_signing.
 */
import type pg from 'pg';
import type { esig } from '@ebmr/kernel';
import type { SignableContentView } from '@ebmr/api-contract';
import { refusal } from '../../platform/http/refusal.ts';
import type { SignableContext } from '../../platform/ports.ts';
import { meaningInfo } from './views.ts';

/**
 * The request context of a signing step; `meaning` is the catalogue code the signer is asked to sign, `tokenHash` the
 * hash of the session's cookie token (the database reads for that session, tablets 0410).
 */
export interface EsigSignableContext extends SignableContext {
  meaning: string;
  tokenHash: string;
}

export function contentNotFound(aggregateType: string, aggregateId: string): Error {
  return refusal(404, {
    code: 'ESIG_CONTENT_NOT_FOUND',
    kind: 'STALE',
    whatHappened: 'The record to be signed was not found.',
    why: `${aggregateType} ${aggregateId} does not exist or cannot be signed.`,
    controls: ['DI-37'],
    whatYouCanDo: ['Reload the screen.'],
  });
}

/** The kernel's content to be signed as the database answers it (esig.content_for_signing's shape). */
export function contentOf(aggregateType: string, aggregateId: string, r: Record<string, unknown>): esig.ContentForSigning {
  const out: esig.ContentForSigning = { exists: r['exists'] === true, aggregateType, aggregateId };
  if (typeof r['problem'] === 'string') out.problem = r['problem'];
  if (out.exists) {
    out.contentVersion = String(r['content_version']);
    out.state = typeof r['state'] === 'string' ? r['state'] : null;
    out.canonical = String(r['canonical']);
    out.contentHash = String(r['content_hash']);
  }
  return out;
}

/** The content of a RECORD-class record for a handler inside its command (tablets 0410: never a GOVERNANCE-class one). */
export async function recordContentForSigning(db: pg.Pool | pg.PoolClient, aggregateType: string, aggregateId: string): Promise<esig.ContentForSigning> {
  const { rows } = await db.query<{ r: Record<string, unknown> }>('select tab.record_content_for_signing($1, $2) as r', [aggregateType, aggregateId]);
  return contentOf(aggregateType, aggregateId, rows[0]?.r ?? {});
}

/**
 * The content of a GOVERNANCE-class record for the signer's own session, inside the signing command (tab.content_for_signing:
 * the session's role must read the record and may sign the meaning; EBMR-TAB-019/020 otherwise). The restore approval
 * (slice 7g WP2) and, by decision D-P7R-6, the QP register and the compendial rule-set verification read this way.
 */
export async function sessionContentForSigning(db: pg.Pool | pg.PoolClient, ctx: SignableContext | undefined, aggregateType: string, aggregateId: string, meaning: string): Promise<esig.ContentForSigning> {
  // No signing context: no session, so the database reads for none (EBMR-TAB-018).
  const tokenHash = (ctx as Partial<EsigSignableContext> | undefined)?.tokenHash ?? '';
  const { rows } = await db.query<{ r: Record<string, unknown> }>('select tab.content_for_signing($1, $2, $3, $4) as r', [tokenHash, aggregateType, aggregateId, meaning]);
  return contentOf(aggregateType, aggregateId, rows[0]?.r ?? {});
}

/** The meaning code of a preview intent (`<meaning>` or `<meaning>|<decision>`). */
export const meaningOfIntent = (intent: string): string => {
  const bar = intent.indexOf('|');
  return bar < 0 ? intent : intent.slice(0, bar);
};

export async function kernelContent(db: pg.Pool | pg.PoolClient, tokenHash: string, query: { aggregateType: string; aggregateId: string; intent: string }): Promise<SignableContentView> {
  const meaning = await meaningInfo(db, meaningOfIntent(query.intent));
  const { rows } = await db.query<{ r: Record<string, unknown> }>('select tab.content_for_signing($1, $2, $3, $4) as r', [tokenHash, query.aggregateType, query.aggregateId, meaning.code]);
  const c = contentOf(query.aggregateType, query.aggregateId, rows[0]?.r ?? {});
  if (!c.exists || !c.canonical || !c.contentHash || !c.contentVersion) throw contentNotFound(query.aggregateType, query.aggregateId);
  const envelope = JSON.parse(c.canonical) as { content?: Record<string, unknown> };
  const content = envelope.content ?? {};
  const title = typeof content['title'] === 'string' ? content['title'] : `${query.aggregateType} ${query.aggregateId}`;
  return {
    aggregateType: query.aggregateType,
    aggregateId: query.aggregateId,
    contentVersion: c.contentVersion,
    canonicalText: c.canonical,
    contentHash: c.contentHash,
    meaning: meaning.code,
    meaningText: meaning.text,
    title: `${meaning.title}: ${title}`,
    preview: false,
    rendering: { kind: 'fallback', state: c.state ?? null, content },
  };
}
