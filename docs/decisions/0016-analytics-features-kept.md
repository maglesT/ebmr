# Decision record 0016: the analytics and AI features kept, built after Phase 6

- **Date:** 14 October 2026
- **Decided by:** project owner (maglesT), in the Phase 4 session, choosing from the list of seventeen analytics, ML
  and AI ideas: "have 1, 2, 3, 8, 9, 10, 16", to be built after Phase 6.
- **Narrows:** decision 0015 (which stays the rule set for how any of this is built: advisory only, read-only, versioned
  and validated, statistics first).

## Kept (built after Phase 6)

1. **Trend charts and process control:** control charts and capability per critical process parameter and in-process
   check, with drift alerts.
2. **Multivariate monitoring:** PCA with Hotelling's T-squared and Q-residual charts, flagging a batch unusual as a
   whole while every value is within its limits.
3. **Deviation-rate comparisons:** by step, equipment, supplier lot, room and shift, with confidence intervals.
8. **Audit-trail anomaly detection (data integrity):** rules first (late or back-dated entries, correction counts, one
   login on two terminals too quickly, values too regular, repeated tests until a pass), then per-user statistical
   baselines, then ML (isolation forest, local outlier factor) once history exists. Every flag shows its reasons and is
   marked real or false alarm by QA; never an automatic accusation.
9. **Review by exception scoring:** a transparent weighted risk score per completed batch record (exceptions, values
   near limits, corrections, item 8 flags, new operator or equipment, unusual durations), ordering the QA review queue
   with the top reasons shown; later, weights learned from QA's own review outcomes. It orders the review, never skips
   one: every record is still reviewed in full.
10. **Golden batch profile:** each batch's full equipment curves compared with the band of good batches (dynamic time
   warping or multivariate monitoring). It needs continuous equipment data, so it follows the Phase 6 equipment
   integration (OPC UA or a historian) and applies to connected equipment only.
16. **Production and cleaning scheduling:** an optimiser (constraint programming, for example OR-Tools) planning batches,
   equipment campaigns and cleaning order; it proposes a plan, a planner approves it.

All run on the site's own servers with open-source models, in a separate read-only analytics module, with the rule set
or model version recorded on every output and QA feedback stored for later tuning.

## Not kept now (parked; the owner may reopen any of them)

4 deviation risk prediction, 5 deviation type suggestion, 6 alert learning from QA feedback, 7 the investigation
assistant tuned on QA feedback (the RLHF layer of decision 0015), 11 predictive maintenance, 12 soft sensors, 13 vision
checks of printed codes and instrument displays, 14 voice entry, 15 similar-case search, 17 stability trending.
Decision 0015's sections on these stay as the design to follow if one is reopened.
