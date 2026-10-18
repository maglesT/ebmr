/**
 * Access governance through the real screens (Phase 7 slice 7g-5, decision 0025): the system administrator requests a
 * permission for a role and is not offered its decision; the process owner approves it under the approved change record
 * (a role's permissions are configuration, DI-09); the administrator removes it again. An authorised person delegates
 * the manufacturer release to a deputy; the process owner approves it, a third person; the delegator revokes it. The
 * process owner records the legal entity's US e-signature certification letter. The database decides every act; the
 * people are created through the access workflow (no persona holds these roles).
 */
import type { Page } from '@playwright/test';
import { axe, expect, test } from '../../fixtures/index.ts';
import { administration, ensureChangeRecord, grantedPerson, letters, withDb, type GrantedPerson } from '../phase6/support.ts';

/** The office PC the administration flows use (the QA security-checks PC). */
const OFFICE = 'PC-QA-03';

async function signInAs(page: Page, p: { loginName: string; password: string }): Promise<void> {
  await page.getByLabel('User ID').fill(p.loginName);
  await page.getByLabel('Password').fill(p.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'What do you want to do?' })).toBeVisible();
}

/** A local instant `days` from now as the screen takes it (ISO 8601 with offset; the browser's clock, for the test only). */
const isoIn = (days: number): string => new Date(Date.now() + days * 86_400_000).toISOString().replace(/\.\d{3}Z$/, 'Z');

test.describe('administration: access governance', () => {
  let admin: GrantedPerson;
  let owner: GrantedPerson;
  let ap: GrantedPerson;
  let deputy: GrantedPerson;
  let permission = '';
  let changeRecord = '';

  test.beforeAll(async ({ e2e }) => {
    [admin, owner, ap, deputy, permission, changeRecord] = await withDb(e2e, 'GMP', async (db, seed) => {
      const adm = await administration(db, seed);
      const { rows } = await db.admin.query<{ code: string }>(
        `select p.code from iam.permission p
          where p.domain = 'GMP' and p.effect = 'READ'
            and not exists (select 1 from iam.role_permission rp where rp.role_code = 'QA_REVIEWER' and rp.permission_code = p.code and rp.removed_at is null)
            and not exists (select 1 from iam.role_permission_request r where r.role_code = 'QA_REVIEWER' and r.permission_code = p.code and r.status = 'REQUESTED')
          order by p.code limit 1`,
      );
      const code = rows[0]?.code;
      if (!code) throw new Error('every GMP read permission is already held by QA_REVIEWER');
      return [
        await grantedPerson(db, seed, adm, 'SYSTEM_ADMINISTRATOR', 'Ira Admin'),
        await grantedPerson(db, seed, adm, 'PROCESS_OWNER', 'Omar Owner'),
        await grantedPerson(db, seed, adm, 'AUTHORISED_PERSON', `Ana Authorised ${letters(4)}`),
        await grantedPerson(db, seed, adm, 'QA_REVIEWER', `Dev Deputy ${letters(4)}`),
        code,
        await ensureChangeRecord(db),
      ] as const;
    });
  });

  test('[DI-16][DI-18][DI-09] the administrator requests a permission for a role; the process owner approves it under the change record; the administrator removes it', { tag: '@office' }, async ({ officePage, e2e, evidence }) => {
    const base = e2e.url('GMP');
    const page = await officePage('GMP', OFFICE);
    await signInAs(page, admin);
    await page.goto(`${base}/admin/role-permissions`);
    await expect(page.getByRole('heading', { name: 'Role permissions' })).toBeVisible();
    await axe.check(page);

    await evidence.step('Request the permission for the QA reviewer role', 'The request waits for a second person; the administrator is not offered its decision', async () => {
      const form = page.getByTestId('role-permission-request');
      await form.getByLabel('Role').selectOption('QA_REVIEWER');
      await form.getByLabel('Permission').selectOption(permission);
      await form.getByRole('textbox', { name: 'Reason' }).fill('reviewers read the new register');
      await form.getByRole('button', { name: 'Request the permission' }).click();
      await expect(page.getByTestId('role-permission-requested').getByTestId(`role-permission-QA_REVIEWER-${permission}`)).toHaveAttribute('data-status', 'REQUESTED');
      await expect(page.getByTestId('role-permission-requested')).toContainText('You requested this, so a second person decides it.');
      await expect(page.getByRole('button', { name: `Approve ${permission} for QA_REVIEWER` })).toHaveCount(0);
    }, page);

    const ownerPage = await officePage('GMP', OFFICE);
    await signInAs(ownerPage, owner);
    await evidence.step('The process owner approves it under the approved change record', 'The request is approved by the process owner; the role holds the permission', async () => {
      await ownerPage.goto(`${base}/admin/role-permissions`);
      const open = ownerPage.getByTestId('role-permission-requested').getByTestId(`role-permission-QA_REVIEWER-${permission}`);
      await open.getByRole('textbox', { name: `Reason (${permission} for QA_REVIEWER)` }).fill('agreed with QA');
      await open.getByRole('textbox', { name: /^Change record approved for role permissions/ }).fill(changeRecord);
      await open.getByRole('button', { name: `Approve ${permission} for QA_REVIEWER` }).click();
      await expect(ownerPage.getByTestId('role-permission-decided').getByTestId(`role-permission-QA_REVIEWER-${permission}`).first()).toContainText('Approved by Omar Owner');
      await ownerPage.getByTestId('role-QA_REVIEWER').getByText(/^QA_REVIEWER/).click();
      await expect(ownerPage.getByTestId('role-QA_REVIEWER')).toContainText(permission);
    }, ownerPage);
    await axe.check(ownerPage);

    await evidence.step('The administrator removes the permission again under the change record', 'The role no longer holds it', async () => {
      await page.reload();
      const form = page.getByTestId('role-permission-remove');
      await form.getByLabel('Role').selectOption('QA_REVIEWER');
      await form.getByLabel('Permission it holds').selectOption(permission);
      await form.getByRole('textbox', { name: 'Change record approved for role permissions' }).fill(changeRecord);
      await form.getByRole('textbox', { name: 'Reason for the removal' }).fill('the register is retired');
      await form.getByRole('button', { name: 'Remove the permission' }).click();
      await expect(form).toContainText('Removed.');
      await page.getByTestId('role-QA_REVIEWER').getByText(/^QA_REVIEWER/).click();
      await expect(page.getByTestId('role-QA_REVIEWER')).not.toContainText(permission);
    }, page);
  });

  test('[IN-05][DI-35][DI-18] the authorised person delegates the manufacturer release to a deputy; the process owner approves it; the delegator revokes it', { tag: '@office' }, async ({ officePage, e2e, evidence }) => {
    const base = e2e.url('GMP');
    const sop = `SOP-QA-${letters(5).toUpperCase()}`;
    const page = await officePage('GMP', OFFICE);
    await signInAs(page, ap);
    await page.goto(`${base}/admin/delegations`);
    await expect(page.getByRole('heading', { name: 'Delegations of signing authority' })).toBeVisible();
    await axe.check(page);
    const item = page.getByTestId(`delegation-${deputy.loginName}-${sop}`);

    await evidence.step('The authorised person requests the delegation', 'It waits for a third person; the delegator is not offered its decision', async () => {
      const form = page.getByTestId('delegation-request');
      await form.getByRole('textbox', { name: "Delegate's user ID" }).fill(deputy.loginName);
      await form.getByRole('checkbox', { name: /\(MANUFACTURER_RELEASE\)$/ }).check();
      await form.getByRole('checkbox', { name: 'IN' }).check();
      await form.getByRole('textbox', { name: /^Valid from/ }).fill(isoIn(0));
      await form.getByRole('textbox', { name: /^Valid to/ }).fill(isoIn(14));
      await form.getByRole('textbox', { name: /SOP reference/ }).fill(sop);
      await form.getByRole('textbox', { name: 'Reason' }).fill('annual leave of the authorised person');
      await form.getByRole('button', { name: 'Request the delegation' }).click();
      await expect(item).toHaveAttribute('data-status', 'REQUESTED');
      await expect(item).toContainText('a third person decides it');
      await expect(item.getByRole('button')).toHaveCount(0);
    }, page);

    const ownerPage = await officePage('GMP', OFFICE);
    await signInAs(ownerPage, owner);
    await evidence.step('The process owner approves the delegation', 'The delegation is in force, approved by the process owner', async () => {
      await ownerPage.goto(`${base}/admin/delegations`);
      const theirs = ownerPage.getByTestId(`delegation-${deputy.loginName}-${sop}`);
      const label = `${ap.legalName} to ${deputy.legalName}`;
      await theirs.getByRole('textbox', { name: `Reason (delegation ${label})` }).fill('SOP followed');
      await theirs.getByRole('button', { name: `Approve the delegation ${label}` }).click();
      await expect(theirs).toHaveAttribute('data-status', 'APPROVED');
      await expect(theirs).toContainText('In force');
      await expect(theirs).toContainText('Approved by Omar Owner');
    }, ownerPage);
    await axe.check(ownerPage);

    await evidence.step('The delegator revokes the delegation', 'The delegation is revoked by its delegator', async () => {
      await page.reload();
      const label = `${ap.legalName} to ${deputy.legalName}`;
      await item.getByRole('textbox', { name: `Reason (delegation ${label})` }).fill('back from leave');
      await item.getByRole('button', { name: `Revoke the delegation ${label}` }).click();
      await expect(item).toHaveAttribute('data-status', 'REVOKED');
      await expect(item).toContainText(`Revoked by ${ap.legalName}`);
    }, page);
  });

  test('[DI-15] the process owner records the US e-signature certification letter; the page says a legal entity without one is blocked', { tag: '@office' }, async ({ officePage, e2e, evidence }) => {
    const entity = `Batchwright Pharma ${letters(5)} Pvt Ltd`;
    const letter = `CERT-${letters(6).toUpperCase()}`;
    const page = await officePage('GMP', OFFICE);
    await signInAs(page, owner);
    await page.goto(`${e2e.url('GMP')}/admin/us-esig-certification`);
    await expect(page.getByRole('heading', { name: 'US electronic-signature certification' })).toBeVisible();
    await axe.check(page);
    await evidence.step('Check the legal entity, then record its letter', 'Without a letter the entity is shown as blocked; the recorded letter is on file', async () => {
      await page.getByTestId('us-esig-status').getByRole('textbox', { name: 'Legal entity' }).fill(entity);
      await expect(page.getByTestId('us-esig-status-result')).toHaveAttribute('data-on-file', 'false');
      const form = page.getByTestId('us-esig-record');
      await form.getByRole('textbox', { name: 'Legal entity (as named in the letter)' }).fill(entity);
      await form.getByRole('textbox', { name: 'Letter reference' }).fill(letter);
      await form.getByRole('textbox', { name: 'Submitted on (YYYY-MM-DD)' }).fill('2026-03-02');
      await form.getByRole('button', { name: 'Record the letter' }).click();
      await expect(page.getByTestId(`us-esig-${letter}`)).toContainText(`${entity}: letter ${letter}, submitted on 2026-03-02`);
      await expect(page.getByTestId('us-esig-status-result')).toHaveAttribute('data-on-file', 'true');
    }, page);
  });
});
