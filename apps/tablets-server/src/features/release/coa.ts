/**
 * API plan A3 (C3, AS-17): the certificate of analysis of a released finished lot of the API edition. Every rule is the
 * database's (editions/substance/sql 5005): substance.coa_document reads what the CoA says from the existing records,
 * substance.prepare_coa stores it as a true copy (the document and its SHA-256), and substance.sign_coa records the
 * quality unit's COA_APPROVED signature, made through the usual ceremony (signable action COA_ACT, aggregate
 * substance_coa <coa id>, state PREPARED). The right is the existing lot-release right RELEASE.MANUFACTURER (the lead's
 * decision); a dedicated right code would replace it in the meaning type COA_APPROVED and in the two database commands.
 */
import type { CoaDocumentView, LotCoaView, SignableAction, SignableContentView } from '@ebmr/api-contract';
import type pg from 'pg';
import type { AppContext } from '../../platform/context.ts';
import type { SignableActionHandler } from '../../platform/ports.ts';
import { peopleOf, personRef, usOf } from '../common/people.ts';
import { contentNotFound, recordContentForSigning } from '../esig/content.ts';
import { dbActHandler } from '../esig/db-acts.ts';
import { meaningInfo } from '../esig/views.ts';

type CoaAct = Extract<SignableAction, { kind: 'COA_ACT' }>;
type Db = pg.Pool | pg.PoolClient;

interface CoaRow {
  id: string;
  document: CoaDocumentView;
  document_sha256: string;
  state: 'PREPARED' | 'SIGNED';
  intact: boolean;
  prepared_by: string;
  prepared_us: string;
  signed_by: string | null;
  signed_us: string | null;
  signature_id: string | null;
}

/** What the CoA of the lot says now, its problems and gaps, and its prepared CoAs (latest first). */
export async function lotCoa(app: AppContext, db: Db, lotId: string): Promise<LotCoaView> {
  const d = (await db.query<{ d: { document: CoaDocumentView | null; problems: string[]; gaps: string[] } }>('select substance.coa_document($1) as d', [lotId])).rows[0]!.d;
  const { rows } = await db.query<CoaRow>(
    `select c.id, c.document, c.document_sha256, substance.coa_state(c.id) as state, substance.coa_intact(c.id) as intact,
            c.prepared_by_person as prepared_by, ${usOf('c.prepared_at')} as prepared_us,
            g.signed_by_person as signed_by, case when g.signed_at is null then null else ${usOf('g.signed_at')} end as signed_us, g.signature_id
       from substance.coa c left join substance.coa_signature g on g.coa_id = c.id
      where c.lot_id = $1 order by c.prepared_at desc, c.id`,
    [lotId],
  );
  const people = await peopleOf(db, rows.flatMap((r) => [r.prepared_by, r.signed_by]));
  return {
    lotId,
    current: d.document,
    problems: d.problems,
    gaps: d.gaps,
    coas: rows.map((r) => ({
      coaId: r.id,
      state: r.state,
      document: r.document,
      documentSha256: r.document_sha256,
      intact: r.intact,
      preparedBy: personRef(people, r.prepared_by, 'AUTHORISED_PERSON'),
      preparedAt: app.formatInstant(r.prepared_us),
      signedBy: r.signed_by ? personRef(people, r.signed_by, 'COA_APPROVED') : null,
      signedAt: r.signed_us ? app.formatInstant(r.signed_us) : null,
      signatureId: r.signature_id,
    })),
  };
}

/** COA_ACT: the quality unit's COA_APPROVED signature of a prepared CoA; the database command decides (substance 5005). */
export function coaActHandler(app: AppContext): SignableActionHandler<CoaAct> {
  const base = dbActHandler<CoaAct>(app, {
    kind: 'COA_ACT',
    aggregateTypes: ['substance_coa'],
    target: (a) => ({ aggregateType: 'substance_coa', aggregateId: a.subjectId, meaning: 'COA_APPROVED', expectedState: 'PREPARED' }),
    async apply(client, _ctx, a, signatureId) {
      await client.query('select substance.sign_coa($1, $2)', [a.subjectId, signatureId]);
      return { act: a.act, subjectId: a.subjectId };
    },
  });
  return {
    ...base,
    // The esig content route has already checked that this session reads the record and may sign the meaning
    // (tab.signing_preview_problem); the content is the RECORD-class read the signing command makes too.
    async previewContent(_ctx, query): Promise<SignableContentView> {
      const meaning = await meaningInfo(app.pools.app, query.intent);
      const c = await recordContentForSigning(app.pools.app, query.aggregateType, query.aggregateId);
      if (!c.exists || !c.canonical || !c.contentHash || !c.contentVersion) throw contentNotFound(query.aggregateType, query.aggregateId);
      const content = (JSON.parse(c.canonical) as { content?: Record<string, unknown> }).content ?? {};
      return {
        aggregateType: query.aggregateType,
        aggregateId: query.aggregateId,
        contentVersion: c.contentVersion,
        canonicalText: c.canonical,
        contentHash: c.contentHash,
        meaning: meaning.code,
        meaningText: meaning.text,
        title: `${meaning.title}: ${typeof content['title'] === 'string' ? content['title'] : `CoA ${query.aggregateId}`}`,
        preview: false,
        rendering: { kind: 'fallback', state: c.state ?? null, content },
      };
    },
  };
}
