/**
 * The MBR designer for a hazardous product (Phase 6 slice 6f; IN-27): a cytotoxic product's new MBR gets protective
 * equipment and decontamination steps in every stage and only contained areas.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { routes, type VersionView } from '@ebmr/api-contract';
import { withCommand } from '@ebmr/kernel';
import type { TestBrowser, TestServer } from '../support/harness.ts';
import { actorOf } from '../support/gmp-world.ts';
import { signAction } from '../support/signed-acts.ts';
import { startSigningServer } from '../esig/support.ts';
import { seedReferenceDocuments } from '../../src/features/designer/seed.ts';
import { createFamily, publishTables, refusalOf, stewardActor, valueOf } from './support.ts';

const I = routes.india;
let server: TestServer;
let author: TestBrowser;
let qa: TestBrowser;
let qa2: TestBrowser;

type Node = { kind: string; id: string; name?: string; block?: { type: string }; config?: Record<string, unknown>; binding?: { rooms: string[] }; body?: Node; children?: Node[] };

function stagesOf(v: VersionView): Node[] {
  const out: Node[] = [];
  const walk = (n: Node | undefined): void => {
    if (!n) return;
    if (n.kind === 'stage') out.push(n);
    for (const c of n.children ?? []) walk(c);
    walk(n.body);
  };
  walk((v.content as unknown as { procedure: { body: Node } }).procedure.body);
  return out;
}

/** QA records the product as `hazardClass`; a second QA person approves it through the ceremony. */
async function classify(product: string, hazardClass: 'CYTOTOXIC' | 'STEROID'): Promise<void> {
  const h = valueOf(await qa.call(I.recordHazard, { body: { product: { productCode: product, hazardClass, riskAssessmentRef: `RA-${product}` } } }));
  const rec = h.products.find((x) => x.productCode === product)!;
  valueOf(await signAction(server, qa2, 'qaInvestigator', { kind: 'INDIA_ACT', act: 'HAZARD_APPROVE', subjectId: rec.recordId }));
}

/** A new room, dedicated and contained for `hazardClass` with a second QA person's approval. */
async function containedRoom(hazardClass: string): Promise<string> {
  const area = `CYT-${randomUUID().slice(0, 6).toUpperCase()}`;
  await withCommand(server.db.admin, { ...(await actorOf(server, 'steward')), correlationId: randomUUID() }, (c) =>
    c.query("insert into plant.area (code, kind, name, segregated, negative_pressure, recorded_by) values ($1, 'ROOM', 'Contained suite', false, true, gen_random_uuid())", [area]));
  const d = valueOf(await qa.call(I.recordHazard, { body: { area: { areaCode: area, hazardClass: hazardClass as 'CYTOTOXIC', dedicated: true, breathingAir: 'BACKED_UP', justification: 'Isolator suite, negative pressure, 100 % breathing-air back-up' } } }));
  const rec = d.areas.find((x) => x.areaCode === area)!;
  valueOf(await signAction(server, qa2, 'qaInvestigator', { kind: 'INDIA_ACT', act: 'DEDICATION_APPROVE', subjectId: rec.recordId }));
  return area;
}

beforeAll(async () => {
  // The designer server with signing (the hazard approvals are signed through the ceremony).
  server = await startSigningServer('GMP', { stub: false });
  await seedReferenceDocuments(server.db.app, await stewardActor(server));
  await publishTables(server);
  author = await server.asPersona('author');
  qa = await server.asPersona('approver');
  qa2 = await server.asPersona('qaInvestigator');
}, 300_000);
afterAll(async () => {
  await server?.close();
});

describe('the designer for a hazardous product (IN-27)', () => {
  it('[IN-27] a cytotoxic product\'s MBR gets PPE and decontamination steps and only contained areas', async () => {
    const product = `CYT-${randomUUID().slice(0, 6).toUpperCase()}`;
    await classify(product, 'CYTOTOXIC');
    // Without a contained area for the class, no MBR is made for it.
    const refused = refusalOf(await author.call(routes.designer.createFamily, { body: { templateId: 'dc-mini', familyCode: `${product}-X`, product: { code: product, name: 'Cytotoxic test tablets', strength: '10 mg' }, batchSizes: [{ quantity: '60.000', unit: 'kg' }], markets: ['IN'] } }));
    expect(refused).toMatchObject({ code: 'DESIGNER_NO_CONTAINED_AREA', controls: ['IN-27'] });
    const room = await containedRoom('CYTOTOXIC');
    const v = await createFamily(author, { familyCode: `${product}-F`, product: { code: product, name: 'Cytotoxic test tablets', strength: '10 mg' }, batchSizes: [{ quantity: '61.000', unit: 'kg' }] });
    const stages = stagesOf(v);
    expect(stages.length).toBeGreaterThan(0);
    for (const s of stages) {
      const ops = s.body?.children ?? [];
      expect(ops[0]?.name, s.id).toBe('Protective equipment');
      expect(ops[0]?.body?.children?.[0]).toMatchObject({ block: { type: 'G-03' }, config: { sop: 'SOP-HAZ-PPE' } });
      // The decontamination closes the stage's work, just before the yield that closes its processing (GMP-STAGE-YIELD).
      const decon = ops.findIndex((o) => o.name === 'Decontamination and de-gowning');
      expect(decon, s.id).toBeGreaterThan(0);
      expect(ops.length - decon, s.id).toBeLessThanOrEqual(2);
      expect(ops[decon]?.body?.children?.[0]).toMatchObject({ block: { type: 'G-10' }, signatures: { check: { meaning: 'VERIFIED' } } });
      // Only contained areas are offered: the stage's rooms are the room dedicated and contained for the class.
      expect(s.binding?.rooms).toEqual([room]);
    }
    const refs = (v.content as unknown as { references: { id: string }[] }).references.map((r) => r.id);
    expect(refs).toEqual(expect.arrayContaining(['SOP-HAZ-PPE', 'SOP-HAZ-DECON']));
    // The new content is a valid MBR: the validator finds no error in what the designer added.
    const val = valueOf(await author.call(routes.designer.validate, { body: { content: v.content, versionId: v.versionId } }));
    expect((val as unknown as { findings: { severity: string; path?: string; message: string }[] }).findings.filter((f) => f.severity === 'ERROR' && /ppe|decon|HAZ/i.test(`${f.path ?? ''} ${f.message}`))).toEqual([]);
  }, 300_000);

  it('[IN-27] a product without a hazard class keeps the template as it is', async () => {
    const v = await createFamily(author, { familyCode: `PLAIN-${randomUUID().slice(0, 6).toUpperCase()}`, batchSizes: [{ quantity: '62.000', unit: 'kg' }] });
    for (const s of stagesOf(v)) {
      expect((s.body?.children ?? []).map((o) => o.name)).not.toContain('Protective equipment');
    }
  }, 300_000);
});
