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
