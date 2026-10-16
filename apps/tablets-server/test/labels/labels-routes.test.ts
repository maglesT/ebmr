/**
 * Phase 6 slice 6c: the `labels` routes on a GMP server (contract ns/labels.ts; recipe-core 0990, site services 0950,
 * tablets 1230). Each write is the person's own command through the database's definer; the routes add nothing but
 * the views. The rules themselves are proven in recipe-core, site services and blocks/packaging/line-completion.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { routes } from '@ebmr/api-contract';
import { refusalOf, startSigningServer, valueOf } from '../esig/support.ts';
import type { TestServer } from '../support/harness.ts';

let server: TestServer;
let lotId: string;
const INDIA = ['DRUG_NAME', 'STRENGTH', 'BATCH_NUMBER', 'EXPIRY_DATE', 'MANUFACTURER_NAME_ADDRESS', 'MFG_LICENCE_NO'];
const layout = (fields: string[]) => ({ width: '80', height: '50', elements: fields.map((field, i) => ({ field: field as never, x: '2', y: String(2 + i * 5) })) });

beforeAll(async () => {
  server = await startSigningServer('GMP');
  lotId = randomUUID();
  const c = await server.db.admin.connect();
  try {
    await c.query('begin');
    await c.query('set local session_replication_role = replica');
    await c.query(
      `insert into site.material_lot (id, site_code, lot_code, material_code, material_name, material_kind, received_quantity, unit, expires_at, received_by_person, received_by_account, correlation_id)
       values ($1, 'SITE-1', $2, 'MAT-CTN-1', 'Printed carton', 'PRINTED_PACKAGING', 5000, '1', '2030-01-01T00:00:00Z', $3, $3, $3)`,
      [lotId, `CTN-${randomUUID().slice(0, 6).toUpperCase()}`, randomUUID()],
    );
    await c.query('commit');
  } finally {
    c.release();
  }
}, 600_000);
afterAll(async () => {
  await server?.close();
});

describe('labels routes (GMP)', () => {
  it('[IN-31] the designer saves template versions through the route; an India-domestic template without its manufacturing date shows why it fails and is refused approval; a complete one is approved by QA, never by its designer', async () => {
    const steward = await server.asPersona('steward');
    const approver = await server.asPersona('approver');
    const bindings = valueOf(await steward.call(routes.labels.bindings, {}));
    expect(bindings.bindings.find((b) => b.code === 'MFG_DATE')).toEqual({ code: 'MFG_DATE', description: expect.any(String) as string, indiaRequired: true, printField: 'mfgDate' });
    const code = `RT-${randomUUID().slice(0, 6).toUpperCase()}`;
    const draft = valueOf(await steward.call(routes.labels.createTemplate, { body: { code, scope: 'INDIA_DOMESTIC', markets: ['IN'], layout: layout(INDIA) } }));
    expect(draft).toMatchObject({ code, version: 1, ref: `${code}-v1`, status: 'DRAFT', createdBy: expect.any(String) as string, approvedBy: null, approvalProblem: 'an India-domestic label must bind MFG_DATE (IN-31)' });
    expect(refusalOf(await approver.call(routes.labels.approveTemplate, { params: { templateId: draft.templateId }, body: {} }))).toMatchObject({ code: 'EBMR-LBL-003' });
    const full = valueOf(await steward.call(routes.labels.createTemplate, { body: { code, scope: 'INDIA_DOMESTIC', markets: ['IN'], layout: layout([...INDIA, 'MFG_DATE']) } }));
    expect(full).toMatchObject({ version: 2, approvalProblem: null });
    expect(refusalOf(await steward.call(routes.labels.approveTemplate, { params: { templateId: full.templateId }, body: {} }))).toMatchObject({ code: 'EBMR-IAM-040' });
    const approved = valueOf(await approver.call(routes.labels.approveTemplate, { params: { templateId: full.templateId }, body: {} }));
    expect(approved).toMatchObject({ status: 'APPROVED', approvedBy: expect.any(String) as string });
    expect(valueOf(await steward.call(routes.labels.templates, { query: { status: 'APPROVED' } })).templates.map((t) => t.ref)).toContain(`${code}-v2`);
    expect(refusalOf(await steward.call(routes.labels.template, { params: { templateId: randomUUID() } }))?.code).toBe('EBMR-LBL-004');
  });

  it('[PR-32] an unauthorised user cannot open a label-store transaction through the route; the label store receives and issues', async () => {
    const qa = await server.asPersona('qaInvestigator');
    const stores = await server.asPersona('stores');
    expect(refusalOf(await qa.call(routes.labels.openStoreTransaction, { body: { kind: 'RECEIPT', lotId, quantity: '100' } }))).toMatchObject({ code: 'EBMR-IAM-040' });
    const view = valueOf(await stores.call(routes.labels.openStoreTransaction, { body: { kind: 'RECEIPT', lotId, quantity: '100' } }));
    expect(view).toMatchObject({ lotId, material: 'Printed carton', balance: '100', transactions: [{ kind: 'RECEIPT', quantity: '100', batchRef: null }] });
    expect(valueOf(await qa.call(routes.labels.store, { params: { lotId } })).balance).toBe('100');
    expect(refusalOf(await stores.call(routes.labels.openStoreTransaction, { body: { kind: 'ISSUE', lotId, quantity: '10', batchRef: 'PK-1' } }))?.code).toBe('EBMR-LBL-022');
  });

  it('[PR-34] the packaging completion and master labelling views answer only for a known batch and version', async () => {
    const qa = await server.asPersona('qaInvestigator');
    expect(refusalOf(await qa.call(routes.labels.packaging, { params: { batchId: randomUUID() } }))?.code).toBe('EBMR-LBL-030');
    expect(refusalOf(await qa.call(routes.labels.masterLabelling, { params: { versionId: randomUUID() } }))?.code).toBe('EBMR-LBL-010');
  });
});
