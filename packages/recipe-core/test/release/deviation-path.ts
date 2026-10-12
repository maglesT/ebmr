/**
 * A copy of site services' test helper (packages/site-services/test/quality/deviation-path.ts) for recipe-core's release
 * tests: recipe-core imports only kernel and expr (.dependency-cruiser.cjs). Keep the two in step.
 *
 * The full deviation path for tests that need a record concluded or closed (Phase 4 slice 2a; site services 0820 to
 * 0822): QA's classification, the finding, the impact on every linked subject for IN, QA's impact sign-off, the closure
 * basis and the conclusion (PENDING_CLOSURE), and optionally the closure. Raw SQL through the caller's own command runner
 * and signer, so the site-services, recipe-core and tablets tests share it.
 *
 * The cast: the classifier is not the initiator; the owner investigates (finding, impacts, basis); the assessor signs the
 * impact and is neither the initiator nor the owner; the concluder and the closer are neither the initiator, the owner nor
 * a recorder of the finding or the basis.
 */

type Queryable = { query: (text: string, values?: unknown[]) => Promise<{ rows: unknown[] }> };

export interface DeviationPathDriver<A extends { personId: string }> {
  run<T>(actor: A, work: (c: Queryable) => Promise<T>): Promise<T>;
  sign(actor: A, aggregate: { type: string; id: string }, meaning: string, expectedState: string): Promise<string>;
}

export interface DeviationPathCast<A> {
  classifier: A;
  owner: A;
  assessor: A;
  concluder: A;
  closer?: A;
}

export interface DeviationPathOptions {
  finding: { assignableCause: boolean; cause: string; rootCauseCategory: string };
  classification?: 'MINOR' | 'MAJOR' | 'CRITICAL';
  /** The impact recorded on every link for each market (default NONE for IN). */
  impact?: 'NONE' | 'POTENTIAL' | 'CONFIRMED';
  markets?: ('IN' | 'US' | 'EU')[];
  close?: boolean;
}

/** A due date a month from now (YYYY-MM-DD). */
export const dueDate = (): string => new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() + 1, 28)).toISOString().slice(0, 10);

export const closureBasis = (finding: DeviationPathOptions['finding']): Record<string, unknown> => ({
  rootCauseMethod: 'Five whys with the investigation team',
  ...(finding.rootCauseCategory === 'HUMAN_ERROR'
    ? { systemFactors: { process: 'The process step gives no prompt for the check', procedure: 'The procedure states the check in a footnote only', system: 'The system accepted the entry without the check' } }
    : {}),
  capaRefs: ['CAPA-TEST-001'],
  notificationRequired: false,
  notificationRationale: 'No registered detail or licence condition is affected',
  otherBatches: [{ subjectKind: 'PRODUCT', ref: 'All other batches of the product made since the last good check', included: false, reason: 'Checks passed on them' }],
});

export async function investigateDeviation<A extends { personId: string }>(
  drv: DeviationPathDriver<A>,
  deviationId: string,
  who: DeviationPathCast<A>,
  o: DeviationPathOptions,
): Promise<void> {
  const q = (a: A, text: string, values: unknown[]) => drv.run(a, (c) => c.query(text, values));
  await q(who.classifier, 'select site.start_deviation_investigation($1, $2::jsonb)', [
    deviationId,
    JSON.stringify({ classification: o.classification ?? 'MAJOR', riskRationale: 'QA classification after the first review of the facts', ownerPersonId: who.owner.personId, dueDate: dueDate() }),
  ]);
  await q(who.owner, 'select site.record_deviation_finding($1, $2::jsonb)', [deviationId, JSON.stringify(o.finding)]);
  const links = (await drv.run(who.owner, (c) => c.query('select id from site.deviation_link where deviation_id = $1 order by linked_at, id', [deviationId]))).rows as { id: string }[];
  for (const l of links) {
    for (const market of o.markets ?? ['IN']) {
      await q(who.owner, 'select site.record_deviation_impact($1, $2::jsonb)', [
        deviationId,
        JSON.stringify({ linkId: l.id, market, impact: o.impact ?? 'NONE', rationale: 'Assessed against the investigation findings' }),
      ]);
    }
  }
  const impact = await drv.sign(who.assessor, { type: 'deviation', id: deviationId }, 'DEVIATION_IMPACT_ASSESSED', 'UNDER_INVESTIGATION');
  await q(who.assessor, 'select site.assess_deviation_impact($1, $2)', [deviationId, impact]);
  await q(who.owner, 'select site.record_deviation_closure_basis($1, $2::jsonb)', [deviationId, JSON.stringify(closureBasis(o.finding))]);
  const concluded = await drv.sign(who.concluder, { type: 'deviation', id: deviationId }, 'DEVIATION_CONCLUDED', 'IMPACT_ASSESSED');
  await q(who.concluder, 'select site.conclude_deviation($1, $2)', [deviationId, concluded]);
  if (o.close) {
    const closer = who.closer ?? who.concluder;
    const closed = await drv.sign(closer, { type: 'deviation', id: deviationId }, 'DEVIATION_CLOSED', 'PENDING_CLOSURE');
    await q(closer, 'select site.close_deviation($1, $2)', [deviationId, closed]);
  }
}
