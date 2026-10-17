/**
 * Phase 6A exit (slice 6A-7), the advisory analytics through the screens (ADR 0020; draft controls DI-51, DI-52, DI-53,
 * PR-61; DI-26, DI-32):
 *  1. QA reads the control chart of a critical item: the advisory band, Phase I limits, the master's specification and
 *     each recorded value as decimal text, the rule hit with its reasons; a point drills to the batch record.
 *  2. The data-integrity reviewer (CSV_DI_LEAD, ANALYTICS.DI_REVIEW) opens an audit-trail flag about a person, with its
 *     reasons and the entries behind it (never a value), and dispositions it as a false alarm; it leaves the open flags,
 *     and the batch's audit-trail review lists the flagged entry first, with its verdict, and still every entry (DI-25).
 *  3. QA's review queue is ordered by review priority with each record's reasons; the lowest-priority record still asks
 *     for its full review (production approval, every exception, the audit-trail review, then the QA review).
 *  4. The trend viewer shows a batch step's press series as received and, on request, the golden profile overlay under
 *     it: the reference set's band, the batch's curve, the flags and the samples exactly as recorded.
 *
 * Every flow runs on the analytics copy of the E2E GMP database and its own server, with the runs recorded as the runner
 * records them (support.ts: TEST FIXTURE, D-6A-7-b-1 and -2). The synthetic history (test-kit analyticsHistory: 30
 * batches, a shift of the granulation end-point from batch 24, 21 press-force curves, one abnormal) gives the numbers;
 * its newest batch is the set-up's review batch, so the chart drills to a real record.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { analyticsHistory, HISTORY_ITEMS, HISTORY_SEEDS } from '@ebmr/test-kit';
import { axe, expect, signIn, test } from '../../fixtures/index.ts';
import { administration, endSessions, grantedPerson, openTile } from '../phase6/support.ts';
import {
  analyticsCopy, approveReferenceSet, asOwner, copyRecord, imrChart, officeOn, pressBand, putInForce, recordRun, resample, type AnalyticsCopy, type DraftFlag,
} from './support.ts';

test.describe.configure({ mode: 'serial' });

let copy: AnalyticsCopy;
let review: { batchId: string; batchNumber: string };
const h = analyticsHistory();

test.beforeAll(async ({ e2e }, info) => {
  info.setTimeout(420_000);
  review = JSON.parse(readFileSync(join(e2e.state.keysDir, 'gmp-review-batch.json'), 'utf8')) as { batchId: string; batchNumber: string };
  copy = await analyticsCopy(e2e);
  await putInForce(copy, ['SPC.IMR', 'ATA.RULES', 'REVIEW.PRIORITY', 'GBP.DTW_BAND']);
});

test.afterAll(async () => {
  await copy?.stop();
});

test('[DI-51][DI-52] the control chart of a critical item shows the advisory band, its Phase I limits, the master\'s specification and each recorded value as decimal text with the rule hit and its reasons; a point drills to the batch record @office', async ({ browser, persona, evidence }) => {
  test.setTimeout(180_000);
  const item = HISTORY_ITEMS.endpoint;
  const { rows: facts } = await copy.db.admin.query<{ product_code: string; family_code: string }>('select product_code, family_code from report.batch_fact_v1 where batch_id = $1', [review.batchId]);
  const product = facts[0]?.product_code ?? '';
  const family = facts[0]?.family_code ?? '';
  expect(product).not.toBe('');
  // The charted value of a batch is its last attempt of the item; the newest batch of the history is the review batch.
  const batches = h.batches.map((b, k) => (k === h.batches.length - 1 ? { ...b, batch_id: review.batchId, batch_number: review.batchNumber } : b));
  const texts = h.batches.map((b) => h.cppValues.filter((v) => v.batch_id === b.batch_id && v.item === item.item).sort((x, y) => y.attempt - x.attempt)[0]!.value_text);
  const values = texts.map(Number);
  const chart = imrChart(values);
  const ref = `${product}|${family}|${item.item}`;

  // TEST FIXTURE: the batch facts of this copy are the history's (their completion times), with the review batch as the
  // newest, as the server's SPC test replaces the row function behind report.batch_fact_v1 in its own database.
  await asOwner(copy, [
    { text: 'create schema e2e_fixture' },
    { text: 'create table e2e_fixture.batch_fact (batch_id uuid primary key, batch_number text, product_code text, strength text, family_code text, issued_at timestamptz, completed_at timestamptz)' },
    { text: 'grant usage on schema e2e_fixture to ebmr_owner' },
    { text: 'grant select on e2e_fixture.batch_fact to ebmr_owner' },
    ...batches.map((b) => ({
      text: 'insert into e2e_fixture.batch_fact values ($1, $2, $3, $4, $5, $6, $7)',
      values: [b.batch_id, b.batch_number, product, b.strength, family, b.issued_at, b.completed_at],
    })),
    {
      text: `create or replace function report.batch_fact_rows_v1()
        returns table (batch_id uuid, batch_number text, product_code text, strength text, mbr_version_id uuid, family_code text, record_kind text,
                       status text, issued_at timestamptz, completed_at timestamptz, released boolean, read_at timestamptz, data_as_of timestamptz)
        language sql stable security definer set search_path = pg_catalog, pg_temp as $$
          select f.batch_id, f.batch_number, f.product_code, f.strength, null::uuid, f.family_code, 'PROCESSING', 'EXECUTION_COMPLETE', f.issued_at, f.completed_at, false,
                 statement_timestamp(), statement_timestamp()
            from e2e_fixture.batch_fact f order by f.completed_at, f.batch_number
        $$`,
    },
  ]);

  const hits = (rule: string) => chart.rules.flatMap((r, k) => (r.includes(rule) ? [k] : []));
  const flags: DraftFlag[] = ['NELSON_1', 'NELSON_2'].filter((rule) => hits(rule).length > 0).map((rule) => ({
    subjectKind: 'PRODUCT_ITEM', subjectRef: ref, rule, severity: 'ATTENTION',
    reasons: hits(rule).slice(0, 5).map((k) => ({
      code: rule,
      text: rule === 'NELSON_1' ? `batch ${batches[k]!.batch_number} lies beyond a control limit` : `nine or more points in a row on one side of the centre line, up to batch ${batches[k]!.batch_number}`,
      evidence: [{ kind: 'BATCH', ref: batches[k]!.batch_id }],
    })),
  }));
  expect(flags.map((f) => f.rule), 'the history shifts the end-point from batch 24').toContain('NELSON_2');
  await recordRun(copy, {
    method: 'SPC.IMR',
    inputs: [{ view: 'report.cpp_value_v1', rows: values.length }, { view: 'report.batch_fact_v1', rows: batches.length }],
    outputs: [{
      subjectKind: 'PRODUCT_ITEM', subjectRef: ref, kind: 'CONTROL_CHART', reasons: [{ code: 'PHASE_I', text: `Phase I limits from the ${values.length.toString()} batches charted` }],
      values: {
        chart: 'IMR', limitsSource: 'PHASE_I', batchIds: batches.map((b) => b.batch_id).join(','), valueTexts: texts.join(','), plotted: values, spread: chart.movingRanges,
        pointRules: chart.rules.map((r) => r.join(';')).join(','), centre: chart.centre, upperControl: chart.upper, lowerControl: chart.lower,
        movingRangeMean: chart.movingRangeMean, movingRangeUpper: chart.movingRangeUpper, specLower: item.lower, specUpper: item.upper, specTarget: item.target, unit: item.unit,
      },
      flags,
    }],
  });

  const qa = persona('GMP', 'qaInvestigator');
  const page = await officeOn(browser, copy.origin, 'PC-QA-01');
  try {
    await signIn.office(page, qa);
    await evidence.step('QA opens the control chart of the granulation end-point', 'The advisory band, Phase I limits, the master\'s specification as its decimal text, every batch\'s recorded value and the rule hit with its reasons', async () => {
      await openTile(page, 'Control charts and deviation rates');
      await page.getByLabel('Product code').fill(product);
      await page.getByLabel('MBR family').fill(family);
      await page.getByLabel('Critical item').fill(item.item);
      await page.getByRole('button', { name: 'Show' }).click();
      const band = page.getByTestId('analytics-advisory').first();
      await expect(band).toContainText('Advisory analytics, not for GMP decisions');
      await expect(band).toContainText('Method SPC.IMR version 1');
      await expect(page.getByTestId('analytics-spc-source')).toContainText(`Phase I limits from the first batches (no approved reference set) Individuals and moving range chart of ${values.length.toString()} batches`);
      await expect(page.getByTestId('analytics-spc-specification')).toContainText(`Master's specification (${item.unit}): lower ${item.lower}, target ${item.target}, upper ${item.upper}.`);
      await expect(page.getByTestId('analytics-spc-chart')).toBeVisible();
      const rule2 = page.getByTestId('analytics-spc-flag-NELSON_2');
      await expect(rule2).toContainText('SPC.IMR version 1');
      await expect(rule2).toContainText('open');
      await expect(rule2).toContainText(`up to batch ${batches[hits('NELSON_2')[0]!]!.batch_number}`);
      const rows = page.getByTestId('analytics-spc-points').locator('tbody tr');
      await expect(rows).toHaveCount(values.length);
      const last = rows.filter({ hasText: review.batchNumber });
      await expect(last.locator('td').nth(2)).toHaveText(texts[texts.length - 1]!);
      await expect(last.locator('td').nth(3).locator('span')).toHaveAttribute('title', 'Advisory, not a GMP value');
      await axe.check(page);
      return { points: await rows.count(), rule2Hits: hits('NELSON_2').length };
    }, page);

    await evidence.step('QA drills from the review batch\'s point to its record', 'The batch record\'s review opens: decisions are taken there, not on the chart', async () => {
      await page.getByTestId('analytics-spc-points').getByRole('link', { name: review.batchNumber, exact: true }).click();
      await expect(page.getByRole('heading', { name: `Review of batch ${review.batchNumber}`, level: 1 })).toBeVisible();
      await expect(page.getByTestId('review-state')).toBeVisible();
      return { url: new URL(page.url()).pathname };
    }, page);
  } finally {
    await page.context().close();
  }
});

test('[DI-53][DI-52][DI-25] the data-integrity reviewer opens an audit-trail flag about a person with its reasons and the entries behind it, never a value, and dispositions it as a false alarm with the cause; it then leaves the open flags, and the batch\'s audit-trail review lists the flagged entry first and still every entry @office', async ({ browser, evidence }) => {
  test.setTimeout(180_000);
  // An entry of the review batch's line clearance, recorded at the kiosk by the operator.
  const { rows } = await copy.db.admin.query<{ event_id: string; chain_key: string; person_id: string; legal_name: string; terminal: string }>(
    `select f.event_id, f.chain_key, f.person_id::text, p.legal_name, f.terminal from report.audit_fact_v1 f join iam.person p on p.id = f.person_id
      where f.batch_id = $1 and f.command_type = 'RECORD_ENTRY' order by f.recorded_at limit 1`,
    [review.batchId],
  );
  const entry = rows[0];
  expect(entry, 'the review batch has a recorded entry').toBeDefined();
  const reason = `E2E fixture: the entry ${entry!.chain_key}#${entry!.event_id} of batch ${review.batchNumber}, flagged as a late entry to exercise the review (the rule itself is proven by the package and server tests)`;
  const run = await recordRun(copy, {
    method: 'ATA.RULES',
    inputs: [{ view: 'report.audit_fact_v1', rows: 1 }],
    outputs: [{
      subjectKind: 'PERSON', subjectRef: entry!.person_id, kind: 'AUDIT_RULE_HIT', values: { LATE_ENTRY: 1 },
      reasons: [{ code: 'RULE_HITS', text: '1 audit-trail rule hit(s) for data-integrity review: LATE_ENTRY 1' }],
      flags: [{
        subjectKind: 'PERSON', subjectRef: entry!.person_id, rule: 'LATE_ENTRY', severity: 'INFO',
        reasons: [{ code: 'LATE_ENTRY', text: reason, evidence: [{ kind: 'AUDIT_EVENT', ref: `${entry!.chain_key}#${entry!.event_id}` }, { kind: 'BATCH', ref: review.batchId }] }],
      }],
    }],
  });
  const flagId = run.flagIds[0]!;
  const lead = await (async () => {
    const adm = await administration(copy.db, copy.seed);
    try {
      return await grantedPerson(copy.db, copy.seed, adm, 'CSV_DI_LEAD', `Lata Krishnan ${randomUUID().slice(0, 4)}`);
    } finally {
      await endSessions(copy.db, adm.admin, adm.owner);
    }
  })();

  const page = await officeOn(browser, copy.origin, 'PC-QA-01');
  try {
    await signIn.office(page, { ...lead, key: 'diLead', set: 0, title: 'CSV and data-integrity lead', kiosk: false, homeTerminal: 'PC-QA-01', pin: null, badgeUid: null });
    const cause = 'The entry was keyed at the step as it happened; nothing late (E2E check)';
    await evidence.step('The data-integrity reviewer opens the open audit-trail flags', 'The flag about the operator, with its rule and reasons, open; the banner says a flag is not a finding', async () => {
      await openTile(page, 'Audit-trail flags');
      await expect(page.getByRole('heading', { name: 'Audit-trail flags', level: 1 })).toBeVisible();
      await expect(page.getByText('A flag is not a finding')).toBeVisible();
      const line = page.getByTestId(`audit-flag-${flagId}`);
      await expect(line).toContainText('Late entry');
      await expect(line).toContainText(reason);
      await expect(line).toContainText('Open: no disposition yet.');
      return { open: true };
    }, page);

    await evidence.step('Open the flag and disposition it as a false alarm with the cause', 'The entry behind it is listed without any value; the disposition names the reviewer and the cause', async () => {
      await page.getByTestId(`audit-flag-${flagId}`).getByRole('link').first().click();
      await expect(page.getByRole('heading', { name: 'Audit-trail flag', level: 1 })).toBeVisible();
      await expect(page.getByTestId('audit-flag-reasons')).toContainText(reason);
      const entries = page.getByTestId('audit-flag-entries');
      await expect(entries.locator('thead th')).toHaveText(['Recorded', 'Time claimed', 'Action', 'Table and field', 'Correction', 'Terminal', 'Audit trail']);
      const row = page.getByTestId(`audit-flag-entry-${entry!.event_id}`);
      await expect(row).toContainText(entry!.terminal);
      await expect(page.getByTestId('audit-flag-dispositions')).toContainText('Open: no disposition yet.');
      await page.getByRole('button', { name: 'Disposition', exact: true }).click();
      const dialog = page.getByTestId('audit-disposition-dialog');
      const record = dialog.getByRole('button', { name: 'Record the disposition' });
      await expect(record).toBeDisabled();
      await dialog.getByRole('radio', { name: 'False alarm' }).locator('xpath=ancestor::label[1]').click();
      await dialog.getByLabel('Cause (at least 10 characters)').fill(cause);
      await expect(record).toBeEnabled();
      await record.click();
      await expect(dialog).toHaveCount(0);
      await expect(page.getByTestId('audit-flag-dispositions')).toContainText(`Current: False alarm (${lead.legalName}`);
      await expect(page.getByTestId('audit-flag-dispositions')).toContainText(cause);
      await axe.check(page);
      return { entries: await entries.locator('tbody tr').count() };
    }, page);

    await evidence.step('Back to the open flags', 'The dispositioned flag is no longer open', async () => {
      await page.getByRole('link', { name: 'All audit-trail flags' }).click();
      await expect(page.getByRole('heading', { name: 'Audit-trail flags', level: 1 })).toBeVisible();
      await expect(page.getByTestId('audit-flags')).toBeVisible();
      await expect(page.getByTestId(`audit-flag-${flagId}`)).toHaveCount(0);
      return { open: false };
    }, page);

    await evidence.step('The reviewer opens the batch record\'s audit-trail review', 'The flagged entry is listed first and highlighted with its verdict; every entry of the review scope is still listed', async () => {
      await page.goto(`${copy.origin}/review/${review.batchId}`);
      await expect(page.getByRole('heading', { name: `Review of batch ${review.batchNumber}`, level: 1 })).toBeVisible();
      const panel = page.getByTestId('audit-trail-review');
      await expect(panel.getByTestId('audit-trail-flagged-note')).toContainText('1 entries named by audit-trail flags are listed first');
      const rows = panel.getByTestId('audit-trail-events').locator('tbody tr');
      await expect(rows.first()).toHaveAttribute('data-flagged', 'true');
      await expect(rows.first()).toContainText('Audit-trail flag (advisory): Late entry, false alarm');
      await expect(panel.locator('[data-flagged="true"]')).toHaveCount(1);
      const summary = await panel.getByTestId('audit-trail-summary').innerText();
      const inScope = Number(/(\d+) events in scope/.exec(summary)?.[1] ?? 'NaN');
      expect(await panel.getByText(/^The report lists the first/).count(), 'the report is not truncated').toBe(0);
      await expect(rows).toHaveCount(inScope);
      return { events: inScope, flagged: 1 };
    }, page);
  } finally {
    await page.context().close();
  }
  // The disposition is the person's own, audited (DI-52): its row names the reviewer.
  const { rows: d } = await copy.db.admin.query<{ person_id: string; verdict: string }>('select person_id::text, verdict from analytics.flag_disposition where flag = $1', [flagId]);
  expect(d).toEqual([{ person_id: lead.personId, verdict: 'FALSE_ALARM' }]);
});

test('[PR-61][DI-26] the review queue is ordered by review priority with each record\'s reasons, and the lowest-priority record still asks for its full review: production approval, the audit-trail review and the QA review @office', async ({ browser, persona, evidence }) => {
  test.setTimeout(180_000);
  const tag = randomUUID().slice(0, 4).toUpperCase();
  const high = { id: await copyRecord(copy, review.batchId, `RPX-${tag}-1`), number: `RPX-${tag}-1` };
  const middle = { id: await copyRecord(copy, review.batchId, `RPX-${tag}-2`), number: `RPX-${tag}-2` };
  // The records awaiting QA review in the copy: the lowest score goes to the review batch while it awaits QA review
  // (the review spec may have reviewed it before this spec ran), else to the second copy.
  const { rows: waiting } = await copy.db.admin.query<{ id: string; batch_number: string }>(
    `select b.id::text, b.batch_number from recipe.batch_execution b join recipe.execution_state s on s.batch_id = b.id
      where b.installation = 'GMP' and b.purpose = 'GMP_BATCH' and s.status in ('EXECUTION_COMPLETE', 'ABORTED') and recipe.batch_review_state(b.id) <> 'QA_REVIEWED'
      order by b.batch_number`,
  );
  const lowest = waiting.some((w) => w.id === review.batchId) ? { id: review.batchId, number: review.batchNumber } : middle;
  const others = waiting.filter((w) => ![high.id, middle.id, lowest.id].includes(w.id));
  const reason = (code: string, text: string, weight: number) => ({ code, text, weight });
  type Scored = [string, { score: number; reasons: ReturnType<typeof reason>[] }];
  const scores = new Map<string, Scored[1]>([
    [high.id, { score: 16, reasons: [reason('DEVIATION', '2 linked deviations (4 points each)', 8), reason('EXCEPTION_MAJOR', '2 major exceptions (action level; 3 points each)', 6), reason('NEW_OPERATOR', '1 person new to the product worked on this record (2 points once)', 2)] }],
    [middle.id, { score: 9, reasons: [reason('DEVIATION', '1 linked deviation (4 points each)', 4), reason('EXCEPTION_MAJOR', '1 major exception (action level; 3 points each)', 3), reason('NEW_EQUIPMENT', '1 unit new or recently maintained (2 points once)', 2)] }],
    ...others.map((w, i): Scored => [w.id, { score: 5 + i / 10, reasons: [reason('EXCEPTION_MINOR', '5 minor exceptions (alert level; 1 point each)', 5)] }]),
    [lowest.id, { score: 1, reasons: [reason('EXCEPTION_MINOR', '1 minor exception (alert level; 1 point each)', 1)] }],
  ]);
  await recordRun(copy, {
    method: 'REVIEW.PRIORITY',
    inputs: [{ view: 'report.review_fact_v1', rows: scores.size }],
    outputs: [...scores].map(([id, s]) => ({ subjectKind: 'BATCH', subjectRef: id, kind: 'REVIEW_PRIORITY', values: { score: s.score }, reasons: s.reasons })),
  });
  const order = [...scores].filter(([id]) => waiting.some((w) => w.id === id) || id === high.id || id === middle.id).sort((a, b) => b[1].score - a[1].score).map(([id]) => id);

  const qa = persona('GMP', 'qaInvestigator');
  const page = await officeOn(browser, copy.origin, 'PC-QA-01');
  try {
    await signIn.office(page, qa);
    await evidence.step('QA opens the review queue', 'The band says the order is advisory; the records awaiting QA review come highest priority first, each with its score and top reasons', async () => {
      await openTile(page, 'Batch record review');
      await expect(page.getByRole('heading', { name: 'Batch record review', level: 1 })).toBeVisible();
      const band = page.getByTestId('review-priority-band');
      await expect(band).toContainText('Advisory analytics, not for GMP decisions');
      await expect(band).toContainText('every record is listed and still needs its full review');
      const scored = page.getByTestId('review-queue').locator('[data-scored="true"]');
      await expect(scored).toHaveCount(order.length);
      const shown = await scored.evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')?.replace('review-priority-', '') ?? ''));
      expect(shown).toEqual(order);
      await expect(page.getByTestId(`review-priority-reasons-${high.id}`)).toHaveText(scores.get(high.id)!.reasons.map((r) => r.text).join('; '));
      await expect(page.getByTestId(`review-priority-${lowest.id}`)).toContainText('Priority 1 (advisory)');
      await expect(page.getByTestId(`review-priority-reasons-${lowest.id}`)).toHaveText('1 minor exception (alert level; 1 point each)');
      await axe.check(page);
      return { scored: shown.length, lowest: lowest.number };
    }, page);

    await evidence.step('QA opens the lowest-priority record from its priority', 'The priority page says the record still needs its full review; the record asks for production approval, the audit-trail review and the QA review as any other', async () => {
      await page.getByTestId(`review-priority-${lowest.id}`).getByRole('link', { name: 'Priority 1 (advisory)' }).click();
      await expect(page.getByRole('heading', { name: 'Review priority', level: 1 })).toBeVisible();
      await expect(page.getByTestId('review-priority-detail')).toContainText('The record still needs its full review: every exception dispositioned, the audit-trail review and the QA review before release.');
      await page.getByRole('link', { name: 'Open the record\'s review' }).click();
      await expect(page.getByRole('heading', { name: `Review of batch ${lowest.number}`, level: 1 })).toBeVisible();
      await expect(page.getByTestId('review-state')).not.toContainText('QA reviewed');
      await expect(page.getByTestId('production-approval')).toBeVisible();
      await expect(page.getByTestId('audit-trail-review')).toBeVisible();
      const gate = page.getByTestId('qa-review-problems');
      await expect(gate).toContainText('Not yet possible:');
      await expect(page.getByTestId('qa-review').getByRole('button', { name: 'Sign the QA review' })).toBeDisabled();
      return { qaReviewOpen: false, problems: await gate.locator('li').count() };
    }, page);
  } finally {
    await page.context().close();
  }
});

test('[DI-51][DI-52] the trend viewer shows a batch step\'s press series as received and, on request, the golden profile overlay under it: the reference set\'s band, the batch\'s curve, its flags and every sample exactly as recorded @office', async ({ browser, persona, evidence }) => {
  test.setTimeout(240_000);
  const STEP = 'compression';
  const TAG = 'force.main_kN';
  const prefix = randomUUID().slice(0, 4).toUpperCase();
  // The history's abnormal curve is the review batch's press force; its 20 normal curves are the reference batches.
  const abnormal = h.pressCurves[HISTORY_SEEDS.abnormalCurve - 1]!;
  const normal = h.pressCurves.filter((c) => !c.abnormal);
  const first = Date.parse(abnormal.samples[0]!.source_time);
  const shiftMs = Date.now() - 2 * 3_600_000 - first;
  const samples = abnormal.samples.map((s) => {
    const us = ((BigInt(Date.parse(s.source_time) + shiftMs)) * 1000n).toString();
    return { sourceTime: us, serverTime: null, raw: s.raw_text, value: s.status === 'BAD' ? null : s.raw_text, status: s.status === 'BAD' ? '0x80000000' : s.status === 'UNCERTAIN' ? '0x40000000' : '0x00000000' };
  });
  const fromUs = BigInt(samples[0]!.sourceTime);
  const toUs = BigInt(samples[samples.length - 1]!.sourceTime);
  const { rows: facts } = await copy.db.admin.query<{ product_code: string; family_code: string }>(
    `select recipe.batch_product(x.id) ->> 'code' as product_code, f.code as family_code from recipe.batch_execution x
       left join recipe.mbr_version v on v.id = report.batch_version(x.id) left join recipe.mbr_family f on f.id = v.family_id where x.id = $1`,
    [review.batchId],
  );
  const product = facts[0]?.product_code ?? '';
  const family = facts[0]?.family_code ?? '';
  const pressId = randomUUID();
  const press = `PRS-E2E-${prefix}`;
  const useId = randomUUID();
  // TEST FIXTURE: a press of the review batch's compression step with its use, binding and one chunk of its main
  // compression force, as the server's profile test writes them (profile-support.ts); the OPC UA path is proven there.
  await asOwner(copy, [
    { text: "insert into plant.equipment (id, code, name, class_code, kind, recorded_by) values ($1, $2, 'Tablet press (E2E profile fixture)', 'EQC-PRESS-GBT', 'PROCESS', gen_random_uuid())", values: [pressId, press] },
    {
      text: `insert into plant.equipment_use (id, equipment_id, previous_use_id, batch_id, batch_ref, product_code, planned_end, cleaning_id, started_by, started_at)
             values ($1, $2, null, $3, $4, $5, to_timestamp($7::numeric / 1000000) + interval '1 day', gen_random_uuid(), gen_random_uuid(), to_timestamp($6::numeric / 1000000))`,
      values: [useId, pressId, review.batchId, review.batchNumber, product, (fromUs - 60_000_000n).toString(), (toUs + 60_000_000n).toString()],
    },
    {
      text: `insert into plant.equipment_use_end (use_id, equipment_id, started_at, ended_by, ended_at, clean_hold_crossed, calibration_crossed, campaign_crossed, overran_plan)
             values ($1, $2, to_timestamp($3::numeric / 1000000), gen_random_uuid(), to_timestamp($4::numeric / 1000000), false, false, false, false)`,
      values: [useId, pressId, (fromUs - 60_000_000n).toString(), (toUs + 60_000_000n).toString()],
    },
    {
      text: `insert into plant.step_equipment (batch_id, step, equipment_id, use_id, person_id, account_id, correlation_id, bound_at)
             values ($1, $2, $3, $4, gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), to_timestamp($5::numeric / 1000000))`,
      values: [review.batchId, STEP, pressId, useId, (fromUs - 30_000_000n).toString()],
    },
    {
      text: `insert into plant.series (id, source, subject_kind, equipment_id, tag, unit, chunk_no, from_us, to_us, sample_count, samples, chunk_hash, inbound_message_id)
             values (gen_random_uuid(), 'OPCUA', 'EQUIPMENT', $1, $2, 'kN', 1, $3, $4, $5, $6::jsonb, repeat('c', 64), gen_random_uuid())`,
      values: [pressId, TAG, fromUs.toString(), toUs.toString(), samples.length, JSON.stringify(samples)],
    },
  ]);

  // The fixture's numbers: the curves resampled to 50 points over the step's normalised time (usable samples only).
  const usable = (c: typeof abnormal) => c.samples.filter((s) => s.status !== 'BAD').map((s) => ({ t: Date.parse(s.source_time), v: Number(s.raw_text) }));
  const band = pressBand(normal.map((c) => resample(usable(c), 50)), resample(usable(abnormal), 50));
  const used = abnormal.samples.filter((s) => s.status !== 'BAD').length;
  const { rows: types } = await copy.db.admin.query<{ equipment_type: string }>('select equipment_type from report.series_ref_v1 where batch_id = $1 and step = $2 and tag = $3', [review.batchId, STEP, TAG]);
  const equipmentType = types[0]?.equipment_type ?? '';
  expect(equipmentType, 'the press series is the batch step\'s (report.series_ref_v1)').not.toBe('');
  const scope = { productCode: product, familyCode: family, equipmentType, step: STEP, tag: TAG };
  const batchIds = normal.map((c) => c.batch_id);
  const model = { scope, unit: 'kN', batchIds, medoidBatchId: batchIds[band.medoid], reference: band.reference, low: band.low, high: band.high, distanceLimit: band.distanceLimit, fit: { points: 50, tolerance: 1 } };
  const modelSha256 = createHash('sha256').update(JSON.stringify(model), 'utf8').digest('hex');
  const candidate = await recordRun(copy, {
    method: 'GBP.DTW_BAND',
    inputs: [{ view: 'report.series_ref_v1', rows: batchIds.length }],
    outputs: [{
      subjectKind: 'EQUIPMENT_STEP_TAG', subjectRef: `${product}|${family}|${equipmentType}|${STEP}|${TAG}`, kind: 'MODEL_CANDIDATE',
      values: { model, modelSha256, ...scope, unit: 'kN', batches: batchIds.length, batchIds, medoidBatchId: model.medoidBatchId, distanceLimit: band.distanceLimit },
      reasons: [{ code: 'CANDIDATE', text: `fitted on ${batchIds.length.toString()} batches that may be reference batches (E2E fixture: the synthetic history's normal press curves)` }],
    }],
  });
  const referenceSet = await approveReferenceSet(copy, 'GBP.DTW_BAND', scope, candidate.outputIds[0]!);
  const outsideShare = band.outside / band.curve.length;
  const evidenceOf = [{ kind: 'BATCH', ref: review.batchId }];
  const outsideReason = { code: 'OUT_OF_BAND', weight: outsideShare, evidence: evidenceOf, text: `${(outsideShare * 100).toFixed(1)} % of the 50 points of ${TAG} in ${STEP} fall outside the band of ${batchIds.length.toString()} reference batches (flagged above 10 %)` };
  const farReason = { code: 'DTW_DISTANCE', weight: band.distance, evidence: evidenceOf, text: `the DTW distance to the reference curve is ${band.distance.toPrecision(4)} kN, against the references' limit of ${band.distanceLimit.toPrecision(4)}` };
  const profileFlags: DraftFlag[] = [
    ...(outsideShare > 0.1 ? [{ subjectKind: 'BATCH', subjectRef: review.batchId, rule: 'OUT_OF_BAND', severity: 'ATTENTION' as const, reasons: [outsideReason] }] : []),
    ...(band.distance > band.distanceLimit ? [{ subjectKind: 'BATCH', subjectRef: review.batchId, rule: 'DTW_DISTANCE', severity: 'ATTENTION' as const, reasons: [farReason] }] : []),
  ];
  expect(profileFlags.length, 'the history\'s abnormal curve leaves the band').toBeGreaterThan(0);
  await recordRun(copy, {
    method: 'GBP.DTW_BAND',
    referenceSet,
    inputs: [{ view: 'report.series_ref_v1', rows: 1 }],
    outputs: [{
      subjectKind: 'BATCH', subjectRef: review.batchId, kind: 'PROFILE_DISTANCE', reasons: [outsideReason, farReason], flags: profileFlags,
      values: {
        status: 'PROFILED', batchNumber: review.batchNumber, step: STEP, tag: TAG, equipmentCode: press, equipmentType, unit: 'kN', referenceSet, points: 50, curve: band.curve,
        distance: band.distance, distanceLimit: band.distanceLimit, outsideShare, outsidePoints: band.outside, used, droppedBad: samples.length - used, uncertain: abnormal.samples.filter((s) => s.status === 'UNCERTAIN').length,
        startUs: samples.find((s) => s.value !== null)!.sourceTime, endUs: [...samples].reverse().find((s) => s.value !== null)!.sourceTime,
      },
    }],
  });

  const qa = persona('GMP', 'qaInvestigator');
  const page = await officeOn(browser, copy.origin, 'PC-QA-01');
  try {
    await signIn.office(page, qa);
    await evidence.step('QA opens the trends of the review batch for the press force of its compression step', 'The native samples of the step as received, with their raw values and status codes', async () => {
      await openTile(page, 'Batch record review');
      await page.getByTestId(`review-batch-${review.batchNumber}`).getByRole('link', { name: review.batchNumber, exact: true }).click();
      await page.getByTestId('batch-trends-link').click();
      await expect(page.getByRole('heading', { name: 'Trends', level: 1 })).toBeVisible();
      const radio = page.getByRole('radiogroup', { name: 'Tag' }).getByRole('radio', { name: `${TAG} (kN)`, exact: true });
      await radio.locator('xpath=ancestor::label[1]').click();
      await expect(radio).toBeChecked();
      await page.getByLabel('Step (optional)').fill(STEP);
      await expect(page.getByTestId('trend-chart')).toBeVisible();
      for (const s of [samples[0]!, samples[samples.length - 1]!]) {
        const cells = page.getByTestId(`trend-sample-${s.sourceTime}`).locator('td');
        await expect(cells.nth(1)).toHaveText(s.raw);
        await expect(cells.nth(3)).toHaveText(s.status);
      }
      return { samples: samples.length };
    }, page);

    await evidence.step('Show the golden profile under the chart', 'The advisory band, the reference set and its batches, the band chart with the batch curve, the share outside and the distance as advisory statistics, the flags, and every sample exactly as recorded', async () => {
      await page.getByRole('button', { name: 'Show the golden profile (advisory)' }).click();
      const overlay = page.getByTestId('profile-overlay');
      await expect(overlay.getByTestId('analytics-advisory')).toContainText('Advisory analytics, not for GMP decisions');
      await expect(overlay).toContainText(`${review.batchNumber} · ${STEP} · ${TAG} on ${press} (${equipmentType}) · against reference set ${referenceSet} of ${batchIds.length.toString()} batches`);
      await expect(overlay.getByTestId('profile-band-chart')).toBeVisible();
      await expect(overlay.getByTestId('profile-outside')).toHaveCount(band.outside);
      await expect(overlay.getByTestId('profile-stats')).toContainText(`Points outside the band: ${band.outside.toString()} of 50`);
      await expect(overlay.getByTestId('profile-flags')).toContainText(profileFlags[0]!.rule);
      await overlay.getByText(`The samples as recorded (${samples.length.toString()})`).click();
      const rows = overlay.getByTestId('profile-samples').locator('tbody tr');
      await expect(rows).toHaveCount(samples.length);
      await expect(rows.first().locator('td')).toHaveText([samples[0]!.sourceTime, samples[0]!.raw, samples[0]!.value ?? '(none)', samples[0]!.status, samples[0]!.status === '0x00000000' ? 'GOOD' : samples[0]!.status === '0x40000000' ? 'UNCERTAIN' : 'BAD']);
      await axe.check(page);
      return { outside: band.outside, flags: profileFlags.length, samples: await rows.count() };
    }, page);
  } finally {
    await page.context().close();
  }
});
