# D-3 Discard a never-approved master draft

Part of the demo-gap plan (`plan.md`; D-0 sweep, top row 7, lead audit in `d0/README.md`). One PR: recipe-core 1878.

Found: an author who abandons a new master's draft cannot start again. The family's identity (one family per product,
strength, dosage form, batch-size set, edition and record kind: `mbr_family_identity`, INV-17) holds the abandoned
family, and a second family for the same product is refused with DESIGNER_FAMILY_EXISTS. The lead's decision keeps the
index: it is what stops a twin master. The lifecycle already has WITHDRAW from DRAFT (the author, with a reason); the
designer offers no way to it, and a restart does not reuse the family.

Changes:
- Route `designer.discardDraft` (POST `/api/mbr/versions/:versionId/discard`, the author's reason code and text) and a
  "Discard draft…" button on the designer for a DRAFT version. It is the lifecycle's WITHDRAW, a status change: nothing
  is deleted, the version and its revisions stay, and the transition is in the audit trail with the author's reason
  (DI-22, DI-24). Anyone holding MBR.AUTHOR for the product may discard the draft (the lifecycle's existing rule for
  WITHDRAW from DRAFT); who did and why are recorded. Only a DRAFT is discarded here; a draft is never approved
  (APPROVED never returns to DRAFT, PR-06), and the other withdrawals keep their own routes.
- `recipe.reopen_family` (1878): creating a family with the code of an existing family that has the same identity, and
  whose every version is WITHDRAWN and was never approved, starts the new draft in that family (its next version
  number) instead of a twin. Anything else is refused as before (DESIGNER_FAMILY_EXISTS, with a hint to discard or
  reuse the code). The family row itself is not changed; it is locked for the command, so two restarts at the same
  time give one draft and the second is refused as a twin.

Not added: deleting a family or a version (record retention), or reopening a family that ever had an approved version
(a change to an approved master is a new version derived from it, PR-06).

Tests (all editions): `apps/tablets-server/test/designer/discard-draft.test.ts` and `discard-draft-editions.test.ts` (the discard with its reason and audit
entry, a refusal for a version that is not a draft, a restart of a tablets, an injectables and an API family under the
same code), `packages/recipe-core/test/mutation/reopen-family.test.ts` (the database's refusals),
`apps/tablets-web/test/designer/` (the button).
