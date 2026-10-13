# Decision record 0015: process analytics and deviation prediction (advisory)

- **Date:** 13 October 2026
- **Decided by:** project owner (maglesT), in the Phase 4 session: use the deviation records, with the process
  parameters and situations they are linked to, to predict deviations from process parameters or show trends; the
  owner asked which model, and recorded the recommendation as this decision.

## Decision

1. **Advisory only.** Analytics and models suggest; they never decide. No model output releases, blocks, rejects or
   changes a batch, and no output is a GMP record or a gate. A person makes every GMP decision. Outputs are logged with
   the model version that produced them.
2. **Separate and read-only.** A separate analytics module reads a copy of the data (a read replica or an export); it
   has no write access to the batch, deviation or release records.
3. **Phase 6 (with the planned dashboards): trends and statistical process control.**
   - Control charts and capability per critical process parameter and in-process check; drift alerts (for example a
     parameter trending to its limit over the last N batches); deviation rates by step, equipment, supplier lot, room
     and shift. This supports continued process verification and the PQR.
   - Multivariate statistical process control: PCA with Hotelling's T-squared and Q-residual charts, flagging batches
     unusual as a whole before any deviation; it needs no deviation labels and works from early batches.
4. **After Tablets v1.0, on a real site's history: deviation risk scoring.**
   - Main model: gradient-boosted trees (LightGBM, XGBoost or CatBoost) with SHAP explanations per batch, and
     monotonic constraints where the process direction is known.
   - Baseline: regularised logistic regression; the simpler model is used unless the boosted model is clearly better.
   - Training discipline: time-based train and test split (never random); class weights or focal loss for the rare
     deviations (no synthetic oversampling); calibrated probabilities (Platt or isotonic); judged by precision-recall
     AUC and recall at a fixed alert rate, not accuracy.
   - Features: margin to each limit, rolling trends, time since maintenance or calibration, campaign position, raw
     material lot results and supplier, environmental readings; shift or experience band rather than named operators.
   - Starts only when a product has enough history (indicatively 100 or more batches and a few dozen deviations).
5. **Later: deviation type suggestion.** A small text model (embeddings with logistic regression, or a fine-tuned
   compact transformer) suggests the category or likely root cause when a deviation is raised; QA confirms.
6. **Validation and control.** Each model is a versioned, change-controlled item with its training data reference,
   performance, and drift monitoring on inputs and predictions; retraining produces a new recorded version. The
   approach follows the regulators' expectations for AI in GMP (paraphrased: intended use stated, model validated for
   it, performance monitored, human oversight), reviewed against the then-current EU GMP Annex 22 and FDA guidance
   before release.
7. **Demo data.** The synthetic demo data can test the pipeline, not train a meaningful model; real models are trained
   on a site's own history at deployment.

## Additions (13 October 2026, same session)

8. **Statistics first.** Inferential statistics are the foundation (control charts, capability, multivariate SPC,
   deviation-rate comparisons with confidence intervals). The first risk model is a **Bayesian hierarchical logistic
   regression** (interpretable, shares strength across products and equipment, works with little data, gives real
   uncertainty). Gradient-boosted trees with SHAP are added only if they clearly beat it on held-out later batches.
   A pattern found by a model or by SHAP is a hypothesis: it is confirmed statistically before any process change, and
   any process change goes through change control.
9. **Human-feedback (RLHF) layer, after v1.0.**
   - **Risk alerts:** QA marks each alert a true risk or a false alarm, with the actual cause; the feedback is stored
     with its audit trail and used (with active learning, asking QA about the least certain batches) to improve the
     ranking and thresholds of alerts.
   - **Investigation assistant:** a language-model assistant drafts a deviation investigation (likely root causes from
     similar past deviations, linked parameter trends, affected batches, suggested actions); QA edits and approves.
     QA's ratings, comparisons and edits are preference data used to tune the assistant (RLHF with a reward model, or
     DPO).
   - **Rules:** learning is offline and in batches; each tuned model is a new versioned, validated, change-controlled
     release, never a model that updates itself in use. The layer is advisory only: it never changes a process
     parameter, never releases, blocks or rejects a batch, and never writes to the batch record. No reinforcement
     learning experiments on real batches.
   - Checked against the then-current EU GMP Annex 22 and FDA guidance on AI before release.
