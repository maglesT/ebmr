/**
 * A dc-mini test package from GMP in the sandbox exchange inbox, made through the real GMP designer API as the
 * MBR author of this worker (module C2's routes, exactly as the designer screens call them): the author picks the
 * design PC on the demo picker and signs in with user ID and password; then, with the session's cookie and CSRF
 * token, the typed contract client creates a family and its DRAFT from the dc-mini template, validates it (the
 * server's gate: no errors, no warnings), and writes the test package (write-once, GMP stamp). Nothing is written
 * into the exchange directory by the test itself: the file is the GMP server's export (DI-05, INV-18).
 *
 * Specs that need a package to import (the live floor tests) call `dcMiniPackage.get()`; the first call of a
 * worker exports one package and later calls reuse it, so every test of the worker issues its TEST- batches
 * from the same imported package.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { createApiClient, routes, type ApiClient, type FetchLike, type Result } from '@ebmr/api-contract';
import type { E2eState } from './state.ts';

export interface TestPackageRef {
  packageHash: string;
  versionId: string;
  familyCode: string;
  productCode: string;
  /** The inbox file the GMP server wrote. */
  file: string;
}

/** The value of a call, or an error naming the route and the server's refusal. */
export function valueOf<T>(what: string, r: Result<T>): T {
  if (r.ok) return r.value;
  const e = r.error;
  throw new Error(`${what} failed: ${e.kind === 'REFUSAL' ? `${e.status} ${e.envelope.refusal.code}: ${e.envelope.refusal.whatHappened} ${e.envelope.refusal.why}` : JSON.stringify(e)}`);
}

/**
 * The typed contract client over a signed-in page's request context: the session cookie comes from the browser
 * context, the CSRF token from GET /api/session, and Origin and Sec-Fetch-Site are the page's own origin.
 */
export async function pageApi(page: Page, origin: string, installation: 'GMP' | 'SANDBOX'): Promise<ApiClient> {
  const f: FetchLike = async (url, init) => {
    const res = await page.request.fetch(`${origin}${url}`, {
      method: init.method,
      headers: { ...init.headers, origin, 'sec-fetch-site': 'same-origin' },
      ...(init.body !== undefined ? { data: init.body } : {}),
      failOnStatusCode: false,
    });
    const headers = res.headers();
    return { status: res.status(), headers: { get: (n: string) => headers[n.toLowerCase()] ?? null }, text: () => res.text() };
  };
  const bare = createApiClient({ fetch: f, installation: () => installation });
  const session = valueOf('GET /api/session', await bare.call(routes.session.get));
  return createApiClient({ fetch: f, installation: () => installation, csrfToken: () => session.csrfToken });
}

/**
 * Creates a dc-mini family and DRAFT as `author` on an already signed-in GMP page, checks the server's gate and
 * exports the test package. `tag` makes the family and product codes unique (one family per product, strength
 * and batch-size set).
 */
export async function exportDcMiniPackage(page: Page, state: E2eState, tag: string): Promise<TestPackageRef> {
  const client = await pageApi(page, state.urls.gmp, 'GMP');
  const templates = valueOf('designer templates', await client.call(routes.designer.templates));
  const template = templates.templates.find((t) => t.templateId === 'dc-mini');
  if (!template) throw new Error('the GMP designer does not offer the dc-mini template');
  const familyCode = `FAM-E2E-${tag}`;
  const productCode = `PCM500-E2E-${tag}`;
  const version = valueOf(
    'create the family from dc-mini',
    await client.call(routes.designer.createFamily, {
      body: { templateId: 'dc-mini', familyCode, product: { ...template.product, code: productCode }, batchSizes: [{ quantity: '60.000', unit: 'kg' }], markets: ['IN'] },
    }),
  );
  const report = valueOf('validate the draft', await client.call(routes.designer.validate, { body: { versionId: version.versionId, content: version.content } }));
  if (!report.gate.passed || report.gate.errors > 0) throw new Error(`the dc-mini draft does not pass the gate: ${report.findings.map((f) => `${f.rule} ${f.message}`).join(' | ')}`);
  const pkg = valueOf('write the test package', await client.call(routes.designer.testPackage, { params: { versionId: version.versionId }, body: {} }));
  const file = join(state.exchangeDir, 'to-sandbox', pkg.fileName);
  if (!existsSync(file)) throw new Error(`the GMP server reported ${pkg.fileName} but it is not in the sandbox inbox ${join(state.exchangeDir, 'to-sandbox')}`);
  const written = JSON.parse(readFileSync(file, 'utf8')) as { packageHash?: string; source?: { installationKind?: string } };
  if (written.packageHash !== pkg.packageHash || written.source?.installationKind !== 'GMP') throw new Error(`the inbox file ${pkg.fileName} is not the GMP export ${pkg.packageHash}`);
  return { packageHash: pkg.packageHash, versionId: version.versionId, familyCode, productCode, file };
}

export interface DcMiniPackages {
  /** This worker's dc-mini package (exported on first use, then reused by the worker's tests). */
  get(): Promise<TestPackageRef>;
}

/** Caches one export per worker; `make` exports a package (a failed export is retried by the next caller). */
export function cachedPackage(make: () => Promise<TestPackageRef>): DcMiniPackages {
  let pending: Promise<TestPackageRef> | null = null;
  return {
    get() {
      const p = (pending ??= make());
      p.catch(() => {
        if (pending === p) pending = null;
      });
      return p;
    },
  };
}

/** A unique tag for family and product codes: the worker's persona set and random hex. */
export function packageTag(workerSet: number): string {
  return `W${workerSet}${randomBytes(3).toString('hex').toUpperCase()}`;
}
