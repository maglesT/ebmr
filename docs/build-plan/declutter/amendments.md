# Declutter plan: amendments

Amendments to `plan.md` (PR #113) after its approval.

- 5 November 2026 (owner, through the lead): the penicillin and beta-lactam rules screen (`/plant-rules`, namespace
  `plantRules`) is DISCONNECTED (decision 3 is now "later"). The beta-lactam check at batch issue runs in the database
  (recipe-core 1655, PR-27) and stays, with the existing rule data. QP batch packages stay disconnected (decision 4).
