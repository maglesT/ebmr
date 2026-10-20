/**
 * People and devices through the real screens (Phase 7 slice 7g-1, decision 0025): the system administrator records a
 * person, verifies the identity, opens an account, hands over the first password and requests a role; the process owner
 * approves it; the new person signs in, changes the password and works in the role. Then the administrator registers a
 * kiosk (with its hardening attestation), a balance and a gateway, enrols the gateway's key, binds the balance behind it
 * and binds an OPC UA adapter to the gateway's feed (slice 7a). The database decides every act; the administrator and
 * the process owner are created through the access workflow (no persona holds those roles).
 */
import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto';
import type { Page } from '@playwright/test';
import { axe, expect, test } from '../../fixtures/index.ts';
import { administration, grantedPerson, letters, withDb, type GrantedPerson } from '../phase6/support.ts';

/** The office PC the administration flows use (the QA security-checks PC). */
const OFFICE = 'PC-QA-03';

async function signInAs(page: Page, p: { loginName: string; password: string }): Promise<void> {
  await page.getByLabel('User ID').fill(p.loginName);
  await page.getByLabel('Password').fill(p.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'What do you want to do?' })).toBeVisible();
}

test.describe('administration: people and devices', () => {
  let admin: GrantedPerson;
  let owner: GrantedPerson;

  test.beforeAll(async ({ e2e }) => {
    [admin, owner] = await withDb(e2e, 'GMP', async (db, seed) => {
      const adm = await administration(db, seed);
      return [await grantedPerson(db, seed, adm, 'SYSTEM_ADMINISTRATOR', 'Ira Admin'), await grantedPerson(db, seed, adm, 'PROCESS_OWNER', 'Omar Owner')];
    });
  });

  test('[DI-14][DI-15][DI-16] the administrator creates a person and an account and requests a grant; the process owner approves it; the new person signs in, changes the password and works in the role', { tag: '@office' }, async ({ officePage, e2e, evidence }) => {
    const tag = letters(6);
    const name = `Lena Fischer ${tag}`;
    const login = `lena.${tag}`;
    const page = await officePage('GMP', OFFICE);
    await signInAs(page, admin);
    await page.goto(`${e2e.url('GMP')}/admin/people`);
    await expect(page.getByRole('heading', { name: 'People and accounts' })).toBeVisible();
    await axe.check(page);

    let initial = '';
    await evidence.step('Record the person, verify the identity and open an account', 'The person shows the identity check and an account waiting for activation', async () => {
      const form = page.getByTestId('person-create');
      await form.getByRole('textbox', { name: 'Legal name' }).fill(name);
      await form.getByRole('button', { name: 'Record the person' }).click();
      const card = page.getByTestId(`person-${name}`);
      await expect(card).toBeVisible();
      await card.getByText(`Record an identity check of ${name}`).click();
      await card.getByRole('textbox', { name: 'Document type' }).fill('Employee ID card');
      await card.getByRole('textbox', { name: 'Evidence reference' }).fill(`HR-${tag}`);
      await card.getByRole('textbox', { name: /When the check took place/ }).fill('2026-01-05T09:00:00+05:30');
      await card.getByRole('button', { name: 'Record the identity check' }).click();
      await expect(card).toContainText('Identity checked: Initial by Ira Admin');
      await card.getByText(`Open an account for ${name}`).click();
      await card.getByRole('textbox', { name: 'User ID (never reused)' }).fill(login);
      await card.getByRole('button', { name: 'Open the account' }).click();
      await expect(page.getByTestId(`account-${login}`)).toHaveAttribute('data-status', 'PENDING_ACTIVATION');
    }, page);

    await evidence.step('Issue the first password and activate the account', 'The password is shown once, only when shown to its owner, and is gone after the hand-over; the account is active with a password that must be changed', async () => {
      const account = page.getByTestId(`account-${login}`);
      await account.getByRole('textbox', { name: `Reason (for the record of acts on ${login})` }).fill('new starter');
      await account.getByRole('button', { name: `Issue a password for ${login}` }).click();
      const handover = account.getByTestId('secret-handover');
      await expect(handover).toBeVisible();
      await expect(handover.getByTestId('issued-secret')).toHaveCount(0);
      await handover.getByRole('button', { name: 'Show it to the person' }).click();
      initial = (await handover.getByTestId('issued-secret').textContent()) ?? '';
      expect(initial.length).toBeGreaterThanOrEqual(16);
      await handover.getByRole('button', { name: 'Handed over: remove it from the screen' }).click();
      await expect(handover).toHaveCount(0);
      expect(await page.content()).not.toContain(initial);
      await account.getByRole('button', { name: `Activate ${login}`, exact: true }).click();
      await expect(account).toHaveAttribute('data-status', 'ACTIVE');
      await expect(account).toContainText('Password (must be changed at first use');
      return { passwordLength: initial.length };
    }, page);

    await evidence.step('Request the MBR checker role', 'The grant waits for a second person; the administrator is not offered its approval', async () => {
      await page.goto(`${e2e.url('GMP')}/admin/grants`);
      const form = page.getByTestId('grant-request');
      await form.getByLabel('Account').selectOption({ label: `${name} (${login}, Human)` });
      await form.getByLabel('Role').selectOption('MBR_CHECKER');
      await form.getByRole('textbox', { name: 'Reason' }).fill('checks master batch records');
      await form.getByRole('button', { name: 'Request the grant' }).click();
      const grant = page.getByTestId(`grant-${login}-MBR_CHECKER`);
      await expect(grant).toHaveAttribute('data-status', 'REQUESTED');
      await expect(grant).toContainText('a second person decides it');
      await expect(grant.getByRole('button', { name: /Approve/ })).toHaveCount(0);
    }, page);

    const ownerPage = await officePage('GMP', OFFICE);
    await signInAs(ownerPage, owner);
    await evidence.step('The process owner approves the grant', 'The grant is live, approved by the process owner', async () => {
      await ownerPage.goto(`${e2e.url('GMP')}/admin/grants`);
      const grant = ownerPage.getByTestId(`grant-${login}-MBR_CHECKER`);
      await grant.getByRole('textbox', { name: `Reason (MBR_CHECKER for ${login})` }).fill('approved for MBR checks');
      await grant.getByRole('button', { name: `Approve MBR_CHECKER for ${login}` }).click();
      await expect(grant).toHaveAttribute('data-status', 'APPROVED');
      await expect(grant).toContainText('Approved by Omar Owner');
    }, ownerPage);
    await axe.check(ownerPage);

    const own = await officePage('GMP', OFFICE);
    await evidence.step('The new person signs in with the first password, must change it, and signs in with their own', 'The first sign-in asks for a new password; the next one opens a session in the MBR checker role', async () => {
      await own.getByLabel('User ID').fill(login);
      await own.getByLabel('Password').fill(initial);
      await own.getByRole('button', { name: 'Sign in' }).click();
      const mine = `Lena-${randomBytes(6).toString('base64url')}-2026`;
      await own.getByLabel('New password', { exact: true }).fill(mine);
      await own.getByLabel('Repeat the new password').fill(mine);
      await own.getByRole('button', { name: 'Continue' }).click();
      await signInAs(own, { loginName: login, password: mine });
      await expect(own.getByTestId('identity')).toContainText(`${name} (${login}), MBR_CHECKER`);
    }, own);
  });

  test('[DI-19][DI-20][DI-31] the administrator registers a kiosk and attests it, registers a balance and a gateway, enrols the gateway key, binds the balance behind it and binds an OPC UA adapter to the gateway feed', { tag: '@office' }, async ({ officePage, e2e, evidence }) => {
    const tag = letters(6).toUpperCase();
    const page = await officePage('GMP', OFFICE);
    await signInAs(page, admin);
    const base = e2e.url('GMP');
    const register = async (code: string, cls: string, fingerprint: string, description: string, room?: string) => {
      const form = page.getByTestId('terminal-register');
      await form.getByRole('textbox', { name: 'Code' }).fill(code);
      await form.getByLabel('Class').selectOption(cls);
      await form.getByRole('textbox', { name: /^Room/ }).fill(room ?? '');
      await form.getByRole('textbox', { name: /Key fingerprint/ }).fill(fingerprint);
      await form.getByRole('textbox', { name: 'Description' }).fill(description);
      await form.getByRole('button', { name: 'Register the device' }).click();
      await expect(page.getByTestId(`terminal-${code}`)).toBeVisible();
    };
    const hex = (s: string) => createHash('sha256').update(s).digest('hex');

    await page.goto(`${base}/admin/devices`);
    await expect(page.getByRole('heading', { name: 'Terminals and devices', exact: true })).toBeVisible();
    await axe.check(page);

    await evidence.step('Register a shared kiosk and attest its hardening', 'The kiosk shows the attestation with its evidence reference', async () => {
      const code = `KIOSK-E-${tag}`;
      await register(code, 'SHARED', hex(`kiosk ${tag}`), 'Dispensing kiosk (E2E)', 'DISP-1');
      const kiosk = page.getByTestId(`terminal-${code}`);
      await expect(kiosk).toContainText('No hardening attestation');
      await kiosk.getByText(`Attest the hardening of ${code}`).click();
      for (const label of ['USB mass storage is blocked', 'Kiosk mode is enforced', 'Malware protection is active', 'Operating-system patches are within the agreed time']) await kiosk.getByRole('checkbox', { name: label }).check();
      await kiosk.getByRole('textbox', { name: 'Evidence reference' }).fill(`MDM-${tag}`);
      await kiosk.getByRole('button', { name: `Record the attestation of ${code}` }).click();
      await expect(kiosk).toContainText(`Hardening attested (MDM-${tag}`);
    }, page);

    const { publicKey } = generateKeyPairSync('ed25519');
    const spki = publicKey.export({ type: 'spki', format: 'der' });
    const gw = `GW-E-${tag}`;
    const bal = `BAL-E-${tag}`;
    const gwLogin = `gw.e.${tag.toLowerCase()}`;
    await evidence.step('Register a balance and a gateway, and the gateway\'s INTEGRATION identity', 'Both devices are registered; the gateway account exists', async () => {
      // A room of its own: a balance bound behind a gateway makes its room's weighings wait for that gateway (PR-20), and
      // DISP-1 is where the GMP kiosk batch spec weighs by hand.
      await register(bal, 'INSTRUMENT', hex(`balance ${tag}`), 'Balance 60 kg (E2E)', `RM-E-${tag}`);
      await register(gw, 'SERVER', createHash('sha256').update(spki).digest('hex'), 'Site gateway (E2E)');
      await page.goto(`${base}/admin/people`);
      const form = page.getByTestId('person-create');
      await form.getByRole('textbox', { name: 'Legal name' }).fill(`Gateway ${gw}`);
      await form.getByText('A system (service or integration identity)').click();
      await form.getByRole('button', { name: 'Record the person' }).click();
      const card = page.getByTestId(`person-Gateway ${gw}`);
      await card.getByText(`Open an account for Gateway ${gw}`).click();
      await card.getByRole('textbox', { name: 'User ID (never reused)' }).fill(gwLogin);
      await card.getByLabel('Account kind').selectOption('INTEGRATION');
      await card.getByRole('button', { name: 'Open the account' }).click();
      await expect(page.getByTestId(`account-${gwLogin}`)).toBeVisible();
    }, page);

    await evidence.step('Enrol the gateway key and bind the balance behind it', 'The key is active with the registered fingerprint; the balance is bound behind the gateway', async () => {
      await page.goto(`${base}/admin/devices`);
      const enrol = page.getByTestId('gateway-key-enrol');
      await enrol.getByLabel('Gateway (SERVER device)').selectOption(gw);
      await enrol.getByLabel('Its INTEGRATION login').selectOption(gwLogin);
      await enrol.getByRole('textbox', { name: 'Public key (SPKI DER, base64)' }).fill(spki.toString('base64'));
      await enrol.getByRole('button', { name: 'Enrol the key' }).click();
      await expect(page.getByTestId(`gateway-key-${gw}`)).toHaveAttribute('data-status', 'ACTIVE');
      const bind = page.getByTestId('device-bind');
      const fp = createHash('sha256').update(spki).digest('hex');
      await bind.getByLabel('Gateway key').selectOption({ label: `${gw} (${fp.slice(0, 12)}…${fp.slice(-8)})` });
      await bind.getByLabel('Instrument (registered INSTRUMENT)').selectOption(bal);
      await bind.getByRole('textbox', { name: 'Serial' }).fill(`SN${tag}`);
      await bind.getByRole('textbox', { name: 'Resolution (e.g. 0.001)' }).fill('0.001');
      await bind.getByRole('button', { name: 'Bind the device' }).click();
      await expect(page.getByTestId(`binding-${bal}`)).toContainText(`behind ${gw}`);
    }, page);

    await evidence.step('Register the OPC UA adapter and bind it to the gateway\'s feed', 'The adapter pulls the feed of the gateway', async () => {
      const code = `OPCUA-E-${tag}`;
      const form = page.getByTestId('adapter-register');
      await form.getByRole('textbox', { name: /Adapter code/ }).fill(code);
      await form.getByLabel('Source system').selectOption('OPCUA');
      await form.getByLabel('INTEGRATION account').selectOption({ label: gwLogin });
      await form.getByLabel('SERVER device').selectOption({ label: gw });
      await form.getByRole('textbox', { name: 'Description' }).fill('OPC UA feed (E2E)');
      await form.getByRole('button', { name: 'Register the adapter' }).click();
      const adapter = page.getByTestId(`adapter-${code}`);
      await expect(adapter).toContainText('No gateway feed bound.');
      await adapter.getByLabel(`Gateway whose feed ${code} pulls`).selectOption(gw);
      await adapter.getByRole('textbox', { name: `Reason (${code})` }).fill('commissioning');
      await adapter.getByRole('button', { name: `Bind the feed of ${code}` }).click();
      await expect(adapter).toContainText(`Feed of gateway ${gw}, bound by Ira Admin`);
    }, page);
    await axe.check(page);
  });
});
