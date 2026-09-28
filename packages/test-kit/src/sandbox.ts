/**
 * Sandbox databases for tests, demos and E2E runs (DI-05, INV-18), provisioned through the kernel's own
 * provisioning (kernel sandbox.provisionSandboxDatabase / upgradeSandboxDatabase).
 *
 * Staged provisioning (kernel gap, reported to the lead): iam.bootstrap_installation inserts the
 * "Installation qualification" person and the BOOTSTRAP-CONSOLE-n devices, which the sandbox identifier guard
 * (kernel 0920, TEST- labels only) refuses. Until the kernel bootstraps a sandbox with TEST- labels, a sandbox
 * is provisioned with the kernel migrations before 0920, bootstrapped with TEST- administrator and owner
 * names, and then upgraded with every migration, so the guard applies to everything created afterwards.
 */
import { KERNEL_MIGRATIONS, sandbox, type MigrationSource } from '@ebmr/kernel';
import { ADMIN_URL, copyDatabase, uniqueSuffix } from './db.ts';
import { bootstrapInstallation, type BootstrapResult } from './seed.ts';

/** Kernel migrations applied before the bootstrap in a sandbox: everything before 0920 (the identifier guard on iam). */
export const PRE_GUARD_KERNEL = /^0([0-8]\d\d|9[01]\d)_/;

export interface ProvisionedSandbox {
  database: string;
  bootstrap: BootstrapResult;
}

/**
 * Creates, migrates, marks, bootstraps and secures a sandbox database named ebmr_sandbox_<suffix>
 * (kernel provisioning refuses any other name and any existing database).
 */
export async function provisionBootstrappedSandbox(database: string, sources: MigrationSource[], adminUrl = ADMIN_URL): Promise<ProvisionedSandbox> {
  if (sources[0]?.namespace !== KERNEL_MIGRATIONS.namespace) throw new Error('the kernel migrations must come first');
  await sandbox.provisionSandboxDatabase({ adminUrl, database, sources: [{ ...KERNEL_MIGRATIONS, include: PRE_GUARD_KERNEL }] });
  const bootstrap = await bootstrapInstallation(database, 'SANDBOX', adminUrl);
  await sandbox.upgradeSandboxDatabase({ adminUrl, database, sources });
  return { database, bootstrap };
}

/** `provisionSandboxTemplate()`: a bootstrapped sandbox template ebmr_sandbox_tpl<hex> for copying. */
export async function provisionSandboxTemplate(sources: MigrationSource[], adminUrl = ADMIN_URL): Promise<ProvisionedSandbox> {
  return provisionBootstrappedSandbox(`ebmr_sandbox_tpl${uniqueSuffix()}`, sources, adminUrl);
}

/** A copy of a sandbox template under a new sandbox name (ebmr_sandbox_t<hex>), connect policy re-applied. */
export async function copySandbox(template: string, adminUrl = ADMIN_URL): Promise<string> {
  const name = `ebmr_sandbox_t${uniqueSuffix()}`;
  await copyDatabase(template, name, adminUrl);
  return name;
}
