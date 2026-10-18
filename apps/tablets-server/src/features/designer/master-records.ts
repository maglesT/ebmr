/**
 * The master-record acts that had no screen (Phase 7 slice 7g-2, decision 0025): a version's market authorisations
 * (recipe-core 0160, 0290; ADR 0014; PR-04, PR-05) and the labelling specimens (tablets 1479; DI-35).
 *  - marketAuthorisations: the records of a version with their state and the valid REGULATORY_CONFIRMED and
 *    MBR_MARKET_AUTHORISED signatures on each (tab.signatures_of: RECORD-class records only);
 *  - proposeMarketAuthorisation: recipe.propose_market_authorisation (MBR.APPROVE; an APPROVED version, a market of its
 *    market set);
 *  - withdrawMarketAuthorisation: recipe.withdraw_market_authorisation with QA's own reason in the command (0290);
 *  - specimens: the SPECIMEN reference documents with their state (tab.labelling_specimen_state) and approval.
 * The signatures themselves are the signable actions MBR_MARKET_ACT and SPECIMEN_ACT (signables.ts). The database decides.
 */
import type pg from 'pg';
import type { LabellingSpecimenView, MarketAuthorisationView, Routes } from '@ebmr/api-contract';
import { lifecycle } from '@ebmr/recipe-core';
import type { AppContext } from '../../platform/context.ts';
import { withIdempotentActorCommand } from '../../platform/db/commands.ts';
import type { Handlers } from '../../platform/http/bind.ts';
import { refusal } from '../../platform/http/refusal.ts';
import { peopleOf, personRef, usOf } from '../common/people.ts';
import { signaturesOf } from '../esig/views.ts';

type Db = pg.Pool | pg.PoolClient;
const us = (col: string): string => `case when ${col} is null then null else ${usOf(col)} end`;

interface MaRow {
  id: string; version_id: string; market: string; kind: 'CURRENT' | 'BRIDGING'; cells: { site: string; line: string; batch_size: string }[];
  from_us: string | null; to_us: string | null; regulatory_basis: string; state: MarketAuthorisationView['state']; proposed_by: string; proposed_us: string;
  activated_us: string | null; w_reason: string | null; w_by: string | null; w_us: string | null;
}

export async function marketAuthorisationViews(app: AppContext, db: Db, where: { versionId?: string; authorisationId?: string }): Promise<MarketAuthorisationView[]> {
  const { rows } = await db.query<MaRow>(
    `select a.id, a.version_id, a.market, a.kind, a.cells, ${us('a.effective_from')} as from_us, ${us('a.effective_to')} as to_us, a.regulatory_basis,
            recipe.market_authorisation_state(a.id) as state, a.proposed_by_person as proposed_by, ${usOf('a.recorded_at')} as proposed_us,
            ${us('act.effective_from')} as activated_us, w.reason as w_reason, w.person_id as w_by, ${us('w.recorded_at')} as w_us
       from recipe.market_authorisation a
       left join recipe.market_authorisation_activation act on act.authorisation_id = a.id
       left join recipe.market_authorisation_withdrawal w on w.authorisation_id = a.id
      where ($1::uuid is null or a.version_id = $1) and ($2::uuid is null or a.id = $2)
      order by a.market, a.recorded_at`,
    [where.versionId ?? null, where.authorisationId ?? null],
  );
  // The record's signatures as the application reads them (tablets 0410: RECORD-class records only).
  const sigs = new Map(await Promise.all(rows.map(async (r) => [r.id, (await signaturesOf(db, lifecycle.MARKET_AUTHORISATION_AGGREGATE, r.id)).filter((s) => s.valid)] as const)));
  const people = await peopleOf(db, rows.flatMap((r) => [r.proposed_by, r.w_by]));
  const signed = (id: string, meaning: string) => {
    const s = (sigs.get(id) ?? []).filter((x) => x.meaning === meaning).at(-1);
    return s ? { by: s.signer, at: s.signedAt } : null;
  };
  return rows.map((r) => ({
    authorisationId: r.id,
    versionId: r.version_id,
    market: r.market,
    kind: r.kind,
    cells: r.cells.map((c) => ({ site: c.site, line: c.line, batchSize: c.batch_size })),
    effectiveFrom: r.from_us === null ? null : app.formatInstant(r.from_us),
    effectiveTo: r.to_us === null ? null : app.formatInstant(r.to_us),
    regulatoryBasis: r.regulatory_basis,
    state: r.state,
    proposedBy: personRef(people, r.proposed_by, 'QA_MBR_APPROVER'),
    proposedAt: app.formatInstant(r.proposed_us),
    regulatoryConfirmedBy: signed(r.id, 'REGULATORY_CONFIRMED'),
    qaAuthorisedBy: signed(r.id, 'MBR_MARKET_AUTHORISED'),
    activatedAt: r.activated_us === null ? null : app.formatInstant(r.activated_us),
    withdrawal: r.w_reason !== null && r.w_by !== null && r.w_us !== null ? { reason: r.w_reason, by: personRef(people, r.w_by, 'QA_MBR_APPROVER'), at: app.formatInstant(r.w_us) } : null,
  }));
}

async function oneAuthorisation(app: AppContext, db: Db, authorisationId: string): Promise<MarketAuthorisationView> {
  const [v] = await marketAuthorisationViews(app, db, { authorisationId });
  if (!v) throw refusal(404, { code: 'EBMR-RCP-083', kind: 'INVALID_INPUT', whatHappened: 'There is no market authorisation with this id.', why: `Market authorisation ${authorisationId} does not exist.`, whatYouCanDo: ['Reload the master record.'], whoCanHelp: ['QA'], controls: ['PR-04'] });
  return v;
}

export async function specimenViews(app: AppContext, db: Db): Promise<LabellingSpecimenView[]> {
  const { rows } = await db.query<{ id: string; code: string; version: string; title: string; content_hash: string; effective_from: string; state: LabellingSpecimenView['state']; by: string; at_us: string; approver: string | null; approved_us: string | null }>(
    `select d.id, d.code, d.version, d.title, d.content_hash, to_char(d.effective_from, 'YYYY-MM-DD') as effective_from, tab.labelling_specimen_state(d.id) as state,
            d.recorded_by_person as by, ${usOf('d.recorded_at')} as at_us, a.approved_by_person as approver, ${us('a.approved_at')} as approved_us
       from tab.reference_document d left join tab.labelling_specimen_approval a on a.document_id = d.id
      where d.kind = 'SPECIMEN' order by d.code, d.effective_from desc`,
  );
  const people = await peopleOf(db, rows.flatMap((r) => [r.by, r.approver]));
  return rows.map((r) => ({
    documentId: r.id, code: r.code, version: r.version, title: r.title, hash: r.content_hash, effectiveFrom: r.effective_from, state: r.state,
    recordedBy: personRef(people, r.by, 'MASTER_DATA_STEWARD'), recordedAt: app.formatInstant(r.at_us),
    approvedBy: r.approver ? personRef(people, r.approver, 'QA_MBR_APPROVER') : null, approvedAt: r.approved_us ? app.formatInstant(r.approved_us) : null,
  }));
}

export function masterRecordHandlers(app: AppContext): Pick<Handlers<Routes['designer']>, 'marketAuthorisations' | 'proposeMarketAuthorisation' | 'withdrawMarketAuthorisation' | 'specimens'> {
  const pool = app.pools.app;
  return {
    marketAuthorisations: async ({ params, requireSession }) => {
      requireSession();
      return { authorisations: await marketAuthorisationViews(app, pool, { versionId: params.versionId }) };
    },
    proposeMarketAuthorisation: async ({ params, body, actor, idempotencyKey, requestHash }) => {
      const def: lifecycle.MarketAuthorisationDefinition = {
        versionId: params.versionId, market: body.market, kind: body.kind,
        cells: body.cells.map((c) => ({ site: c.site, line: c.line, batch_size: c.batchSize })),
        ...(body.effectiveFrom ? { effectiveFrom: body.effectiveFrom } : {}),
        ...(body.effectiveTo ? { effectiveTo: body.effectiveTo } : {}),
        ...(body.successorVersionId ? { successorVersionId: body.successorVersionId } : {}),
        regulatoryBasis: body.regulatoryBasis,
      };
      const { result: id } = await withIdempotentActorCommand(pool, actor(), idempotencyKey ?? '', requestHash, (c) => lifecycle.proposeMarketAuthorisation(c, def));
      return oneAuthorisation(app, pool, id);
    },
    withdrawMarketAuthorisation: async ({ params, body, actor, idempotencyKey, requestHash }) => {
      // DI-22, EBMR-AUDIT-002: the QA person's own reason, both halves, is the command's (each ended cell's audit entry records it).
      await withIdempotentActorCommand(pool, actor({ reasonCode: body.reason.code, reasonText: body.reason.text }), idempotencyKey ?? '', requestHash, async (c) => {
        await lifecycle.withdrawMarketAuthorisation(c, params.authorisationId, body.reason.text);
        return params.authorisationId;
      });
      return oneAuthorisation(app, pool, params.authorisationId);
    },
    specimens: async ({ requireSession }) => {
      requireSession();
      return { specimens: await specimenViews(app, pool) };
    },
  };
}
