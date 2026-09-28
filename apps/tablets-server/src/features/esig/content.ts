/**
 * The content to be signed when no signable handler previews it (plan section 6, step 1): the kernel's canonical
 * content of the record (esig.content_for_signing), exactly the text the challenge will be checked against. The
 * client hashes that text itself and compares (DI-37).
 */
import type pg from 'pg';
import { esig } from '@ebmr/kernel';
import type { SignableContentView } from '@ebmr/api-contract';
import { refusal } from '../../platform/http/refusal.ts';
import type { SignableContext } from '../../platform/ports.ts';
import { meaningInfo } from './views.ts';

/** The request context of a signing step; `meaning` is the catalogue code the signer is asked to sign. */
export interface EsigSignableContext extends SignableContext {
  meaning: string;
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

export async function kernelContent(db: pg.Pool | pg.PoolClient, query: { aggregateType: string; aggregateId: string; intent: string }): Promise<SignableContentView> {
  const meaning = await meaningInfo(db, query.intent);
  const c = await esig.contentForSigning(db, query.aggregateType, query.aggregateId);
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
