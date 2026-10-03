/**
 * Sandbox databases for tests, demos and E2E runs (DI-05, INV-18), provisioned through the kernel's own
 * provisioning (kernel sandbox.provisionSandboxDatabase).
 *
 * One stage: every migration is applied first, the reserved-identifier guard (kernel 0920) included, and the
 * installation is bootstrapped afterwards. Since kernel 1000 iam.bootstrap_installation writes TEST- labels of its
 * own in a sandbox (the installation-qualification person, its console devices), so every label in a sandbox is a
 * TEST- label (decision C0-1, closed by lead TODO T8 of the Phase 2 exit). Before kernel 1000 the kit applied the
 * kernel migrations before 0920, bootstrapped, and then applied the rest.
 */
import { KERNEL_MIGRATIONS, sandbox, type MigrationSource } from '@ebmr/kernel';
import { ADMIN_URL, copyDatabase, uniqueSuffix } from './db.ts';
import { bootstrapInstallation, type BootstrapResult } from './seed.ts';

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
  await sandbox.provisionSandboxDatabase({ adminUrl, database, sources });
  const bootstrap = await bootstrapInstallation(database, 'SANDBOX', adminUrl);
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
