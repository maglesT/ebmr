/**
 * Support of the Phase 7 slice 7g-2 browser flows (decision 0025): the arrangements no screen makes yet, done in the E2E
 * GMP database through the database's own commands under the personas' real identities, as the server tests do them:
 *  - `prepareForVerification(e2e, author, qa, versionId)`: QA records a change record and a risk assessment; the author
 *    sets the draft's change record, effective date and review date and records the verification evidence of the exact
 *    content (validation, simulation with coverage, author-confirmed test vectors, a passing sandbox run: the same stub
 *    reports the recipe-core life-cycle tests record, their hashes computed by the database). The person then starts the
 *    verification on the designer's screen;
 *  - `familyBatchSize(e2e, versionId)`: the id of the family's first batch size (a market authorisation's scope cell);
 *  - `recordSpecimen(e2e, steward, code)`: a SPECIMEN reference document recorded by the steward (the DMS stand-in);
 *  - `officeSignRefused(page, title, who)`: the office ceremony ending in the server's or the database's refusal.
 * DEMO-ONLY data; every name is unique per run.
 */
import { randomUUID } from 'node:crypto';
import type { Page } from '@playwright/test';
import { withCommand, type ActorContext } from '@ebmr/kernel';
import { passwordActor, terminalOf, type SeededPersona } from '@ebmr/test-kit';
import { expect, type E2eWorld } from '../../fixtures/index.ts';
import { withDb } from '../phase6/support.ts';

const because = <T extends ActorContext>(ctx: T, text: string, code = 'E2E_SETUP'): T => ({ ...ctx, reasonCode: code, reasonText: text, correlationId: randomUUID() });

async function actorOf(e2e: E2eWorld, p: SeededPersona): Promise<ActorContext> {
  return withDb(e2e, 'GMP', (db, seed) => passwordActor(db, p, terminalOf(seed, p.homeTerminal).fingerprint));
}

export async function prepareForVerification(e2e: E2eWorld, author: SeededPersona, qa: SeededPersona, versionId: string): Promise<void> {
  const [a, q] = [await actorOf(e2e, author), await actorOf(e2e, qa)];
  await withDb(e2e, 'GMP', async (db) => {
    const tag = randomUUID().slice(0, 8).toUpperCase();
    const one = async <T>(actor: ActorContext, sql: string, params: unknown[]): Promise<T> =>
      withCommand(db.app, because(actor, `E2E set-up of master ${tag}`), async (c) => (await c.query<{ r: T }>(sql, params)).rows[0]?.r as T);
    const cr = await one<string>(q, 'select recipe.record_change_record($1::jsonb) as r', [JSON.stringify({ number: `CC-E2E-${tag}`, title: `E2E master ${tag}`, changeClass: 'MAJOR', processImpacting: true, validationRef: `PV-E2E-${tag}` })]);
    const ra = await one<string>(q, 'select recipe.record_risk_assessment($1::jsonb) as r', [JSON.stringify({ code: `RA-E2E-${tag}`, version: '1', title: 'Process risk assessment', riskClass: 'MEDIUM', rationaleRef: 'QRM-REPORT-1' })]);
    await one(a, "select recipe.set_draft_attributes($1, $2::jsonb)::text as r", [versionId, JSON.stringify({ changeRecordId: cr, effectiveFrom: '2026-01-01T00:00:00Z', reviewDue: '2028-12-31' })]);
    await one(a, "select recipe.link_risk_assessment($1, $2, '{}'::text[])::text as r", [versionId, ra]);
    const hash = async (j: unknown): Promise<string> => (await db.admin.query<{ h: string }>('select recipe.json_hash($1::jsonb) as h', [JSON.stringify(j)])).rows[0]?.h ?? '';
    const facts = (await db.admin.query<{ h: string; e: string }>("select recipe.content_hash_of($1) as h, (recipe.current_content($1)).content -> 'header' ->> 'edition' as e", [versionId])).rows[0];
    if (!facts) throw new Error(`no content for version ${versionId}`);
    const contentHash = facts.h;
    const validation = { validatorVersion: '1.0.0', contentHash, edition: facts.e, rules: [], findings: [], errors: 0, warnings: 0 };
    const sealed = {
      kind: 'FULL', contentHash,
      validator: { version: '1.0.0', errors: 0, warnings: 0, justifiedWarnings: [], passed: true, reportHash: await hash(validation) },
      simulation: { version: '1.0.0', reportHash: 'b'.repeat(64), passed: true, exactPaths: '1', boundHit: false },
      languageVersion: '1', verdict: 'VERIFIED', reasons: [],
    };
    const evidence: [string, unknown][] = [
      ['VALIDATOR', { validation, justifications: [] }],
      ['VERIFICATION', { ...sealed, evidenceHash: await hash(sealed) }],
      ['TEST_VECTORS', { contentHash, simulatorVersion: '1.0.0', goldenCases: [{ id: 'G-1/calc', status: 'PASS' }], boundaryVectors: 4, confirmedBy: author.personId }],
      ['SANDBOX_RUN', { contentHash, runId: `SBX-E2E-${tag}`, sandbox: 'ebmr_sandbox_tablets', coverage: { steps: '100%' }, passed: true }],
    ];
    for (const [kind, report] of evidence) await one(a, 'select recipe.record_evidence($1, $2, $3::jsonb)::text as r', [versionId, kind, JSON.stringify(report)]);
  });
}

export async function familyBatchSize(e2e: E2eWorld, versionId: string): Promise<string> {
  return withDb(e2e, 'GMP', async (db) => {
    const r = (await db.admin.query<{ id: string }>("select f.batch_sizes -> 0 ->> 'id' as id from recipe.mbr_family f join recipe.mbr_version v on v.family_id = f.id where v.id = $1", [versionId])).rows[0]?.id;
    if (!r) throw new Error(`no batch size for version ${versionId}`);
    return r;
  });
}

export async function recordSpecimen(e2e: E2eWorld, steward: SeededPersona, code: string): Promise<void> {
  const s = await actorOf(e2e, steward);
  await withDb(e2e, 'GMP', async (db) => {
    const content = { format: 'ebmr.reference-document', formatVersion: 1, kind: 'SPECIMEN', code, version: '1', title: `Carton specimen ${code}`, effectiveFrom: '2026-01-01', summary: 'Carton artwork as approved for print (DEMO-ONLY).' };
    const h = (await db.admin.query<{ h: string }>('select recipe.json_hash($1::jsonb) as h', [JSON.stringify(content)])).rows[0]?.h ?? '';
    await withCommand(db.app, because(s, `E2E specimen ${code}`), (c) => c.query('select tab.record_reference_document($1::jsonb, $2)', [JSON.stringify(content), h]));
  });
}

/**
 * The office ceremony when the server or the database refuses the signing: the dialog, "Sign", the person's user ID and
 * password if the ceremony asks for them, then the refusal shown in the dialog in the server's words; "Close" ends it
 * with nothing signed. Returns the refusal text the dialog showed.
 */
export async function officeSignRefused(page: Page, title: string | RegExp, who: SeededPersona): Promise<string> {
  const dialog = page.getByRole('dialog', { name: title });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Sign', exact: true }).click();
  const form = dialog.getByRole('form', { name: 'Sign with your user ID and password' });
  const close = dialog.getByRole('button', { name: 'Close' });
  await expect(form.or(close).first()).toBeVisible();
  if (await form.isVisible()) {
    await form.getByLabel('User ID').fill(who.loginName);
    await form.getByLabel('Password').fill(who.password);
    await form.getByRole('button', { name: 'Sign', exact: true }).click();
  }
  await expect(close).toBeVisible();
  await expect(dialog.getByText('Signed.', { exact: true })).toHaveCount(0);
  const text = await dialog.innerText();
  await close.click();
  await expect(dialog).toHaveCount(0);
  return text;
}
