# Decision record 0022: the Phase 6 exit's owner items

- **Date:** 17 October 2026
- **Decided by:** project owner (maglesT), after the Phase 6 exit ("go with recommendations but dont start phase 7
  now"), accepting every recommendation in the list below.
- **Covers:** the owner items of the Phase 6 exit:
  - the review backlog in `docs/build-plan/phase-6/review-backlog.md`
  - the mutation campaign's notes in `docs/build-plan/phase-6/mutation-results.md`
  - the draft control IN-53
- **When:** Phase 7 has not started; the owner starts it. The fixes below are the first items of the Phase 7 plan when it
  is written.

## Decisions

| Item | Decision |
|---|---|
| **IN-53**, controlled-substance mode (NDPS rules not verified) | Stays a draft. Its `expert_decision` stays PENDING until someone qualified checks it against the NDPS rules. The code stays as built, behind the product flag. |
| **6jc-R9** (DI-31): the adapter feed and the gateway's OPC UA feed do not authenticate the sender | Fix early in Phase 7: the gateway signs its feed with the gateway key, and the adapters require mutual TLS. Required before any networked site. |
| **6jc-R10** (PR-27): the penicillin facility rule and the beta-lactam classification are set by one master-data steward | Fix in Phase 7: a change takes effect only with QA approval. |
| **6jc-R2** (IN-53): the controlled-substance list and register reads need only a session | Fix in Phase 7: reads are limited to the CONTROLLED roles and QA. |
| **6jc-R16, the part left** (IN-04): some batch acts are still authorised at the location only, so a product-limited requirement applies to them on every batch. The list includes alarm acknowledgment, disposition proposals, exception-register acts, review freeze, deviation references, dispensing consumption and batch issue. | Fix in Phase 7 the same way as R16 (recipe-core 1100): evaluate in the batch's {site, product} scope. |
| **The dead overload `recipe.check_engine_roles`** (2 arguments, recipe-core 0270; no caller since recipe-core 1100) | Deletion approved: drop it in a new migration in Phase 7. No existing migration is edited. |
| **Smaller items:** <br>• reconciliation never runs <br>• a gateway crash loses readings not yet saved <br>• the server's misleading "nothing was saved" answer (mutation-results, M6-D3 notes) | Go on the Phase 7 hardening list. |

The other low residuals (6jc-R3 to R7, R11 to R15) stay in the review backlog for the Phase 7 plan to sort.

## What does not change

- No control and no `expert_decision` is changed by this record.
- The fixes follow the usual rules:
  - a new migration
  - tests tagged with the control ID
  - one review per slice
  - at most 2 fix rounds, then a residual
