/**
 * Namespace `release` (Phase 4 slice 3, GMP): the release gate G-REL of a finished lot per market, the "since review"
 * acknowledgements and the manufacturer release (outline 5.2.6, 5.2.7, 5.7, 7.3 release cockpit; plan
 * docs/build-plan/phase-4/phase-4-plan.md, slice 3). Every rule is the database's (recipe-core 0780 to 0809; the
 * Tablets items behind the hook, tablets 1160 to 1179).
 *
 * The signed acts are the signable action RELEASE_ACT (signable.ts). Slice 3 builds:
 *   MANUFACTURER_RELEASE   manufacturer_release <lot>/RELEASE           MANUFACTURER_RELEASE (AP or named delegate)
 *   MANUFACTURER_REJECT    manufacturer_release <lot>/REJECT            MANUFACTURER_RELEASE, with the person's reason
 *   POST_CHANGE_EVALUATE   post_change_evaluation <batch>              POST_CHANGE_EVALUATED (QA; IN-03 (c))
 *   PPQ_OUTCOME            ppq_outcome <batch>/<outcome>                VALIDATION_OUTCOME_RECORDED (QA; PR-09)
 *   INVESTIGATION_JUSTIFY  investigation_justification <lot>/<deviation>/<sha256 of the text>
 *                                                                       OPEN_INVESTIGATION_JUSTIFIED (release authority;
 *                                                                       PR-53, only while its switch is on)
 * The other acts of RELEASE_ACT (US_DISPOSE, QP_INTAKE, QP_CERTIFY, MARKET_ADD, MARKET_REMOVE, RECONFIRM, RECALL,
 * REJECT_AFTER_RELEASE, DISPOSAL) arrive with slices 4 and 5. A manufacturer release signs the G-REL checklist of market
 * IN as its content (IN-05 (d)), and the act sends back the epoch the signer evaluated (INV-05: a later change refuses it).
 */
import { z } from 'zod';
import { Instant, PersonRef, Uuid } from '../common.ts';
import { defineRoute } from '../route.ts';

export const ReleaseMarket = z.enum(['IN', 'US', 'EU']);
export type ReleaseMarket = z.infer<typeof ReleaseMarket>;

/** NOT_READY -> READY (computed by G-REL, never set) -> RELEASED or REJECTED; NOT_READY -> REJECTED too. */
export const ManufacturerReleaseState = z.enum(['NOT_READY', 'READY', 'RELEASED', 'REJECTED']);
export type ManufacturerReleaseState = z.infer<typeof ManufacturerReleaseState>;

/** The evidence token of a G-REL evaluation (text); the signing act sends it back. */
export const GrelEpoch = z.string().regex(/^[0-9a-f]{64}$|^0$/);

export const GrelEvidence = z.strictObject({
  /** BATCH, LOT, DEVIATION, INCIDENT, LIMS_RESULT, SAMPLE, CHANGE_RECORD, SIGNATURE, CONTAINER, EXCEPTION, ... */
  kind: z.string().min(1).max(32),
  ref: z.string().min(1).max(256),
  label: z.string().max(512),
});

/** One G-REL item (recipe.grel_evaluate; item shape fixed in recipe-core 0780). */
export const GrelItemView = z.strictObject({
  /** `G<group>.<NAME>` for the core items, `E.<NAME>` for the edition's. */
  id: z.string().regex(/^(G[1-9]|E)\.[A-Z0-9_]{1,64}$/),
  /** Outline 5.2.7 group: 1 to 9 core, 10 edition, 11 market items (slice 4); an edition may answer for 4 and 9. */
  group: z.string().regex(/^([1-9]|1[01])$/),
  title: z.string().min(1),
  status: z.enum(['GREEN', 'RED', 'NA']),
  /** Why it is RED, in the database's words. */
  problem: z.string().nullable(),
  evidence: z.array(GrelEvidence),
  /** The evidence changed after the QA review of the packaging record: the signer acknowledges it item by item. */
  sinceReview: z.boolean(),
  /** This person acknowledged the item at the current epoch (only for since-review items; false otherwise). */
  acknowledged: z.boolean(),
});
export type GrelItemView = z.infer<typeof GrelItemView>;

export const GrelView = z.strictObject({
  lotId: Uuid,
  market: ReleaseMarket,
  epoch: GrelEpoch,
  /** No item RED. */
  ready: z.boolean(),
  items: z.array(GrelItemView),
});
export type GrelView = z.infer<typeof GrelView>;

export const ReleaseDecisionView = z.strictObject({
  decision: z.enum(['RELEASED', 'REJECTED']),
  by: PersonRef,
  at: Instant,
  signatureId: Uuid,
  /** The delegation the signer cited (a named delegate of the AP), or null when the AP signed. */
  delegationId: Uuid.nullable(),
  reason: z.string().nullable(),
  /** The epoch and the SHA-256 of the checklist stored with the signature (IN-05 (d)). */
  epoch: GrelEpoch,
  checklistHash: z.string().regex(/^[0-9a-f]{64}$/),
  /** PR-53: the open investigations released under a signed justification (printed on the release record). */
  justifications: z.array(z.strictObject({ deviationId: Uuid, text: z.string(), signatureId: Uuid })),
});
export type ReleaseDecisionView = z.infer<typeof ReleaseDecisionView>;

export const LotReleaseSummaryView = z.strictObject({
  lotId: Uuid,
  lotCode: z.string(),
  /** The packaging batch the lot was posted from. */
  batchId: Uuid,
  batchNumber: z.string(),
  productCode: z.string(),
  strength: z.string(),
  markets: z.array(z.string()),
  lotStatus: z.string(),
  state: ManufacturerReleaseState,
});
export type LotReleaseSummaryView = z.infer<typeof LotReleaseSummaryView>;

/** Whether an act may be given now, and why not (the database's own reasons). */
export const ReleaseGate = z.strictObject({ ready: z.boolean(), problems: z.array(z.string()) });

export const LotReleaseView = LotReleaseSummaryView.extend({
  /** G-REL for market IN: the manufacturer release checklist. */
  grel: GrelView,
  decision: ReleaseDecisionView.nullable(),
  /** DI-12: incidents linked to the lot's batches, open or not yet assessed for them (they block the disposition). */
  incidents: z.array(z.strictObject({ incidentId: Uuid, number: z.string(), severity: z.string(), status: z.string(), assessed: z.boolean() })),
  /** PR-08: registration-relevant deviations of the lot's batches (registered or validated limit breached). */
  registrationRelevant: z.array(z.strictObject({ batchId: Uuid, exceptionId: z.string(), title: z.string(), deviationRef: z.string().nullable() })),
  /** PR-53: the open-investigation path is on (default off). */
  openInvestigationPath: z.boolean(),
  /** PR-09: batches of the evidence set made under a validation protocol, and their recorded outcome. */
  validationBatches: z.array(z.strictObject({ batchId: Uuid, batchNumber: z.string(), purpose: z.string(), outcome: z.string().nullable() })),
  /** IN-03: batches that are the first under a changed master, and whether QA signed their post-change evaluation. */
  postChange: z.array(z.strictObject({ batchId: Uuid, batchNumber: z.string(), changeRecord: z.string(), evaluated: z.boolean() })),
  gates: z.strictObject({ release: ReleaseGate, reject: ReleaseGate }),
  signable: z.strictObject({ aggregateType: z.literal('manufacturer_release'), release: z.string(), reject: z.string() }),
});
export type LotReleaseView = z.infer<typeof LotReleaseView>;

const lotParams = z.strictObject({ lotId: Uuid });

export const release = {
  queue: defineRoute({
    id: 'release.queue',
    method: 'GET',
    path: '/api/release/lots',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: false,
    summary: 'Finished lots with their manufacturer release state',
    query: z.strictObject({ state: ManufacturerReleaseState.optional() }),
    response: z.strictObject({ lots: z.array(LotReleaseSummaryView) }),
  }),
  lot: defineRoute({
    id: 'release.lot',
    method: 'GET',
    path: '/api/release/lots/:lotId',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: false,
    summary: 'One finished lot: G-REL for IN (the manufacturer release checklist), the decision, incidents, flags and gates',
    params: lotParams,
    response: LotReleaseView,
  }),
  grel: defineRoute({
    id: 'release.grel',
    method: 'GET',
    path: '/api/release/lots/:lotId/grel',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: false,
    summary: 'G-REL of the lot for one market, evaluated now, with this person\'s acknowledgements',
    params: lotParams,
    query: z.strictObject({ market: ReleaseMarket }),
    response: GrelView,
  }),
  acknowledge: defineRoute({
    id: 'release.acknowledge',
    method: 'POST',
    path: '/api/release/lots/:lotId/acknowledgements',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: true,
    summary: 'This person acknowledges one "since review" item at the epoch shown (a later change needs a new acknowledgement)',
    params: lotParams,
    body: z.strictObject({ market: ReleaseMarket, itemId: z.string().regex(/^(G[1-9]|E)\.[A-Z0-9_]{1,64}$/), epoch: GrelEpoch }),
    response: GrelView,
  }),
} as const;
