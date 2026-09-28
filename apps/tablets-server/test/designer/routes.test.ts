/**
 * Designer routes on the GMP installation (module C2): families from the template, revisions with stale-revision
 * protection, validation with the real adapters, justifications, start of verification and the controls the brief
 * names (PR-01, PR-03, PR-06, PR-08, IN-02, INV-34, DI-04).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { routes, type VersionView } from '@ebmr/api-contract';
import { flow } from '@ebmr/recipe-core/pure';
import type { TestBrowser, TestServer } from '../support/harness.ts';
import { createFamily, edited, findPhase, NEW_FAMILY, parameter, refusalOf, removeNode, saveContent, startDesignerServer, templateMbr, valueOf } from './support.ts';

let server: TestServer;
let author: TestBrowser;
let familyCounter = 0;

/** A new family per test (unique code and batch-size set), so tests do not share versions. */
async function freshVersion(): Promise<VersionView> {
  familyCounter += 1;
  return createFamily(author, { familyCode: `PCM500-T${familyCounter}`, batchSizes: [{ quantity: `${60 + familyCounter}.000`, unit: 'kg' }] });
}

async function validate(content: unknown, versionId?: string) {
  return valueOf(await author.call(routes.designer.validate, { body: { content: content as VersionView['content'], ...(versionId ? { versionId } : {}) } }));
}

beforeAll(async () => {
  server = await startDesignerServer();
  author = await server.asPersona('author');
});
afterAll(async () => {
  await server?.close();
});

describe('templates, families and versions', () => {
  it('lists the dc-mini template with its product, markets and 14 steps', async () => {
    const r = valueOf(await author.call(routes.designer.templates));
    expect(r.templates).toEqual([expect.objectContaining({ templateId: 'dc-mini', product: { code: 'PCM500', name: 'Paracetamol tablets', strength: '500 mg' }, markets: ['IN'], steps: 14 })]);
  });

  it('[PR-01] creates a family and its DRAFT version from the template with the approved discrete batch sizes', async () => {
    const v = await createFamily(author);
    expect(v.state).toBe('DRAFT');
    expect(v.revision).toBe(1);
    expect(v.number).toBe('1');
    expect(v.familyCode).toBe('PCM500-DC');
    expect(v.markets).toEqual(['IN']);
    expect(v.auditChain).toBe(`mbr_version:${v.versionId}`);
    expect(v.savedBy).toEqual(expect.objectContaining({ legalName: 'Asha Rao', loginName: 'asha.rao', role: 'MBR_AUTHOR' }));
    const mbr = flow.parseMbr(v.content);
    expect(mbr.ok).toBe(true);
    if (!mbr.ok) return;
    expect(mbr.mbr.header.batchSizes).toEqual([
      { id: 'BS-100K', quantity: { value: '60.000', unit: 'kg' } },
      { id: 'BS-50K', quantity: { value: '30.000', unit: 'kg' } },
    ]);
    expect(v.contentHash).toBe(flow.mbrContentHash(mbr.mbr));
    const families = valueOf(await author.call(routes.designer.families));
    expect(families.families.find((f) => f.familyCode === 'PCM500-DC')?.versions).toEqual([expect.objectContaining({ versionId: v.versionId, state: 'DRAFT', revision: 1 })]);
    const again = valueOf(await author.call(routes.designer.version, { params: { versionId: v.versionId } }));
    expect(again.contentHash).toBe(v.contentHash);
  });

  it('[PR-01] a batch size of the author scales the BOM exactly from the reference size (no free scaling later)', async () => {
    const v = await createFamily(author, { familyCode: 'PCM500-DC45', batchSizes: [{ quantity: '45', unit: 'kg' }] });
    const mbr = templateMbr();
    const content = v.content as unknown as flow.MbrContent;
    expect(content.header.batchSizes).toEqual([{ id: 'BS-45KG', quantity: { value: '45', unit: 'kg' } }]);
    // 50.000 kg x 45 / 60 = 37.500 kg; 9.400 -> 7.050; 0.600 -> 0.450 (exact, template decimals).
    expect(content.bom.map((b) => b.quantity.value)).toEqual(['37.500', '7.050', '0.450']);
    expect(mbr.bom.map((b) => b.quantity.value)).toEqual(['50.000', '9.400', '0.600']);
  });

  it('[PR-01] refuses a batch size that is not a positive mass, or listed twice', async () => {
    for (const batchSizes of [[{ quantity: '100000', unit: '{tablets}' }], [{ quantity: '0', unit: 'kg' }], [{ quantity: '60', unit: 'kg' }, { quantity: '60000', unit: 'g' }]]) {
      const r = refusalOf(await author.call(routes.designer.createFamily, { body: { ...NEW_FAMILY, familyCode: 'PCM500-BAD', batchSizes } }));
      expect(r.status).toBe(422);
      expect(r.code).toBe('DESIGNER_BATCH_SIZE');
      expect(r.controls).toContain('PR-01');
    }
  });

  it('[PR-01] content whose batch sizes differ from the family is not saved (the approved set is fixed per family)', async () => {
    const v = await freshVersion();
    const r = refusalOf(await saveContent(author, v, edited(v, (j) => j.header.batchSizes.push({ id: 'BS-X', quantity: { value: '75', unit: 'kg' } }))));
    expect(r.status).toBe(422);
    expect(r.code).toBe('EBMR-RCP-023');
    expect(r.why).toMatch(/batch sizes differ/);
  });

  it('[INV-28] India cannot be left out of the market set; it is never added silently', async () => {
    const r = refusalOf(await author.call(routes.designer.createFamily, { body: { ...NEW_FAMILY, familyCode: 'PCM500-US', markets: ['US'] } }));
    expect(r.status).toBe(422);
    expect(r.code).toBe('DESIGNER_MARKETS');
    expect(r.controls).toContain('INV-28');
  });

  it('refuses a twin family (same code, or same product, strength and batch sizes) with 409', async () => {
    const r = refusalOf(await author.call(routes.designer.createFamily, { body: { ...NEW_FAMILY } }));
    expect(r.status).toBe(409);
    expect(r.code).toBe('DESIGNER_FAMILY_EXISTS');
  });

  it('[DI-17] a person whose role lacks MBR.AUTHOR cannot create a family', async () => {
    const checker = await server.asPersona('checker');
    const r = refusalOf(await checker.call(routes.designer.createFamily, { body: { ...NEW_FAMILY, familyCode: 'PCM500-CHK', batchSizes: [{ quantity: '12', unit: 'kg' }] } }));
    expect(r.code).toBe('EBMR-IAM-040');
    expect([403, 422]).toContain(r.status);
  });

  it('answers 401 without a session and 428 without an idempotency key', async () => {
    const anon = server.browser();
    expect(refusalOf(await anon.call(routes.designer.families)).status).toBe(401);
    const res = await author.inject({ method: 'POST', url: '/api/mbr/families', payload: JSON.stringify(NEW_FAMILY), headers: { 'content-type': 'application/json', 'x-csrf-token': author.csrf ?? '' } });
    expect(res.statusCode).toBe(428);
  });
});

describe('revisions (PR-06, DI-04)', () => {
  it('[PR-06] a stale base revision is refused with 409 and nothing is saved', async () => {
    const v = await freshVersion();
    const v2 = valueOf(await saveContent(author, v, edited(v, (j) => (j.header.title = `${j.header.title} (edited)`))));
    expect(v2.revision).toBe(2);
    const stale = refusalOf(await saveContent(author, v, edited(v, (j) => (j.header.title = 'another edit'))));
    expect(stale.status).toBe(409);
    expect(stale.code).toBe('DESIGNER_STALE');
    expect(stale.kind).toBe('STALE');
    const now = valueOf(await author.call(routes.designer.version, { params: { versionId: v.versionId } }));
    expect(now.revision).toBe(2);
  });

  it('refuses a revision without a change (it would only void evidence)', async () => {
    const v = await freshVersion();
    const r = refusalOf(await saveContent(author, v, v.content));
    expect(r.code).toBe('DESIGNER_NO_CHANGE');
  });

  it('[PR-03] content that is not a well-formed MBR is not saved and the parser names the path', async () => {
    const v = await freshVersion();
    const r = refusalOf(await saveContent(author, v, edited(v, (j) => ((j.parameters[0] as unknown as Record<string, unknown>)['unexpected'] = true))));
    expect(r.status).toBe(422);
    expect(r.code).toBe('EBMR-RCP-029');
    expect(r.why).toMatch(/parameters/);
  });
});

describe('validation with the real adapters', () => {
  it('[PR-03][DI-04] the template content passes; the report is bound to its content hash', async () => {
    const v = await freshVersion();
    const r = await validate(v.content, v.versionId);
    expect(r.findings.filter((f) => f.severity !== 'INFO')).toEqual([]);
    expect(r.gate).toEqual({ passed: true, errors: 0, warnings: 0, unjustifiedWarnings: 0 });
    expect(r.contentHash).toBe(v.contentHash);
    // G-09@1 and G-10@1 are sandbox-only until Phase 3: shown as information on those four steps, never hidden.
    expect(r.findings.map((f) => `${f.rule}@${f.nodeId}`).sort()).toEqual([
      'ENG-DEF-SANDBOX-ONLY@p-blend-clear',
      'ENG-DEF-SANDBOX-ONLY@p-blend-status',
      'ENG-DEF-SANDBOX-ONLY@p-disp-bal',
      'ENG-DEF-SANDBOX-ONLY@p-disp-clear',
    ]);
  });

  it('[PR-03] deleting the clearance step gives GMP-STAGE-CLEARANCE naming PR-03 at the stage; start verification is refused', async () => {
    const v = await freshVersion();
    const content = edited(v, (j) => expect(removeNode(j, 'p-blend-clear')).toBe(true));
    const r = await validate(content, v.versionId);
    const f = r.findings.find((x) => x.rule === 'GMP-STAGE-CLEARANCE');
    expect(f).toBeDefined();
    expect(f?.severity).toBe('ERROR');
    expect(f?.controls).toContain('PR-03');
    expect(f?.section).toBe('8');
    expect(f?.message).toMatch(/clearance/);
    expect(['S-BLEND', 'p-blend-status', 'p-blend-charge', 'p-blend']).toContain(f?.nodeId);
    expect(r.gate.passed).toBe(false);
    const saved = valueOf(await saveContent(author, v, content, 'clearance removed'));
    const refused = refusalOf(await author.call(routes.designer.startVerification, { params: { versionId: v.versionId }, body: { baseRevision: saved.revision } }));
    expect(refused.status).toBe(422);
    expect(refused.code).toBe('DESIGNER_GATE_FAILED');
    const after = valueOf(await author.call(routes.designer.version, { params: { versionId: v.versionId } }));
    expect(after.state).toBe('DRAFT');
  });

  it('[PR-08] a limit-tier nesting error is named with its rule and control', async () => {
    const v = await freshVersion();
    const content = edited(v, (j) => {
      const alert = parameter(j, 'blendTime').limits?.ranges.find((r) => r.tier === 'ALERT');
      if (alert?.high) alert.high.value = '19'; // outside the internal action range (12-18)
    });
    const r = await validate(content, v.versionId);
    const f = r.findings.find((x) => x.rule === 'GMP-LIMITS');
    expect(f?.severity).toBe('ERROR');
    expect(f?.controls).toContain('PR-08');
    expect(f?.section).toBe('6');
    expect(f?.subjectPath).toEqual(['parameters', 'blendTime']);
    expect(f?.message).toMatch(/Blend time/);
  });

  it('[IN-02] a risk-based reduction without a rationale is refused by the gate, naming IN-02', async () => {
    const v = await freshVersion();
    const content = edited(v, (j) => {
      parameter(j, 'blenderSpeed').criticality = 'NON_CRITICAL';
      j.riskReductions.push({ id: 'RR-SPEED', kind: 'MINOR_CLASSIFICATION', subjects: ['blenderSpeed'], riskClass: 'LOW' });
    });
    const r = await validate(content, v.versionId);
    const f = r.findings.find((x) => x.rule === 'GMP-RISK' && x.subjectPath.includes('RR-SPEED'));
    expect(f?.severity).toBe('ERROR');
    expect(f?.controls).toContain('IN-02');
    expect(f?.message).toMatch(/rationale/);
    expect(f?.section).toBe('11');
    expect(r.gate.passed).toBe(false);
  });

  it('[INV-34][IN-52] a limit bound to a market rule key is checked against the minimum the kernel market engine resolves', async () => {
    const v = await freshVersion();
    const bound = (max: string) =>
      edited(v, (j) =>
        j.timeConstraints.push({
          id: 'TC-BLEND-SAMPLE',
          name: 'Blend step duration (bound to the market interval)',
          kind: 'PROCESS_WINDOW',
          from: { node: 'p-blend', event: 'START' },
          to: { node: 'p-blend', event: 'END' },
          max: { value: max, unit: 'min' },
          source: { kind: 'VALIDATION_REPORT', ref: 'VR-BLEND-01' },
          breach: 'EXCEPTION',
          pauses: 'INCLUDED',
          marketRule: { key: 'tablets.compression.ipcSampleMaxInterval', bound: 'HIGH' },
        }),
      );
    const ok = await validate(bound('20'), v.versionId);
    expect(ok.findings.filter((f) => f.rule === 'MKT-MINIMA')).toEqual([]);
    const loose = await validate(bound('45'), v.versionId);
    const f = loose.findings.find((x) => x.rule === 'MKT-MINIMA');
    expect(f?.severity).toBe('ERROR');
    expect(f?.message).toMatch(/30 min/);
    expect(f?.message).toMatch(/IN/);
    expect(f?.section).toBe('9');
  });

  it('[INV-34] the market adapter fails closed on a key it cannot resolve (UNRESOLVED is an error)', async () => {
    const v = await freshVersion();
    const content = edited(v, (j) => (parameter(j, 'blendTime').marketRule = { key: 'tablets.blend.noSuchKey', bound: 'HIGH' }));
    const r = await validate(content, v.versionId);
    const f = r.findings.find((x) => x.rule === 'MKT-MINIMA' && /noSuchKey/.test(x.message));
    expect(f?.severity).toBe('ERROR');
    expect(r.gate.passed).toBe(false);
  });

  it('[PR-03] a reference not pinned to the registered hash fails the gate (HASH_MISMATCH)', async () => {
    const v = await freshVersion();
    const content = edited(v, (j) => {
      const ref = j.references.find((r) => r.id === 'SOP-DISP-001');
      if (ref) ref.hash = '0'.repeat(64);
    });
    const r = await validate(content, v.versionId);
    const f = r.findings.find((x) => x.rule === 'GMP-REFERENCES');
    expect(f?.message).toMatch(/does not match its pinned hash/);
    expect(f?.section).toBe('3');
  });

  it('content that does not parse is reported as findings at their paths, never as a server error', async () => {
    const r = await validate({ format: 'ebmr.mbr-content', formatVersion: 1, header: {} });
    expect(r.gate.passed).toBe(false);
    expect(r.findings.length).toBeGreaterThan(0);
    expect(r.findings.every((f) => f.rule === 'FLOW-PARSE' && f.severity === 'ERROR')).toBe(true);
  });
});

describe('justifications and start of verification (IN-02, DI-04, PR-06)', () => {
  it('[DI-04][IN-02] a definition warning is justified by the author, then the version passes and enters verification; evidence is bound to the hash', async () => {
    const v = await freshVersion();
    const noTolerance = edited(v, (j) => (findPhase(j, 'p-disp-exc').config = {}));
    const v2 = valueOf(await saveContent(author, v, noTolerance, 'excipient tolerance removed'));
    const r = await validate(v2.content, v.versionId);
    const w = r.findings.find((f) => f.key === 'G07-TOLERANCE-MISSING@p-disp-exc');
    expect(w?.severity).toBe('WARNING');
    expect(w?.justification).toBeNull();
    expect(r.gate).toEqual(expect.objectContaining({ passed: false, errors: 0, unjustifiedWarnings: 1 }));

    const errorKey = 'GMP-STAGE-CLEARANCE@S-BLEND';
    const notWarning = refusalOf(await author.call(routes.designer.justify, { params: { versionId: v.versionId }, body: { findingKey: errorKey, text: 'no' } }));
    expect(notWarning.code).toBe('DESIGNER_NOT_A_FINDING');

    const refusedFirst = refusalOf(await author.call(routes.designer.startVerification, { params: { versionId: v.versionId }, body: { baseRevision: v2.revision } }));
    expect(refusedFirst.code).toBe('DESIGNER_GATE_FAILED');

    const j = valueOf(
      await author.call(routes.designer.justify, {
        params: { versionId: v.versionId },
        body: { findingKey: 'G07-TOLERANCE-MISSING@p-disp-exc', text: 'Excipients are checked against the formula at reconciliation (SOP-DISP-001).' },
      }),
    );
    expect(j.justifications.map((x) => [x.findingKey, x.by.legalName])).toEqual([['G07-TOLERANCE-MISSING@p-disp-exc', 'Asha Rao']]);
    const r2 = await validate(v2.content, v.versionId);
    expect(r2.gate.passed).toBe(true);
    expect(r2.findings.find((f) => f.key === 'G07-TOLERANCE-MISSING@p-disp-exc')?.justification?.text).toMatch(/reconciliation/);

    const started = valueOf(await author.call(routes.designer.startVerification, { params: { versionId: v.versionId }, body: { baseRevision: v2.revision } }));
    expect(started.state).toBe('IN_VERIFICATION');
    const validatorEvidence = started.evidence.filter((e) => e.kind === 'VALIDATOR');
    expect(validatorEvidence.at(-1)).toEqual(expect.objectContaining({ contentHash: v2.contentHash, valid: true }));
    expect(validatorEvidence.at(-1)?.summary).toMatch(/^Passed/);

    // PR-06: no revision, justification or second start once the version left DRAFT.
    const save = refusalOf(await saveContent(author, started, edited(started, (x) => (x.header.title = 'late edit'))));
    expect(save.code).toBe('EBMR-RCP-021');
    expect(save.controls).toContain('PR-06');
    const late = refusalOf(await author.call(routes.designer.justify, { params: { versionId: v.versionId }, body: { findingKey: 'G07-TOLERANCE-MISSING@p-disp-exc', text: 'late' } }));
    expect(late.code).toBe('EBMR-RCP-021');
  });

  it('[DI-04] a failed attempt stays on record, and a new revision voids the evidence of the earlier content', async () => {
    const v = await freshVersion();
    const broken = valueOf(await saveContent(author, v, edited(v, (j) => removeNode(j, 'p-disp-clear')), 'clearance removed'));
    refusalOf(await author.call(routes.designer.startVerification, { params: { versionId: v.versionId }, body: { baseRevision: broken.revision } }));
    const withEvidence = valueOf(await author.call(routes.designer.version, { params: { versionId: v.versionId } }));
    const failed = withEvidence.evidence.filter((e) => e.kind === 'VALIDATOR');
    expect(failed).toHaveLength(1);
    expect(failed[0]).toEqual(expect.objectContaining({ contentHash: broken.contentHash, valid: true }));
    expect(failed[0]?.summary).toMatch(/Did not pass/);

    const fixed = valueOf(await saveContent(author, withEvidence, v.content, 'clearance restored'));
    const voided = fixed.evidence.filter((e) => e.kind === 'VALIDATOR');
    expect(voided[0]).toEqual(expect.objectContaining({ contentHash: broken.contentHash, valid: false }));
    expect(voided[0]?.summary).toMatch(/voided/);
  });

  it('[PR-06] start verification with a stale base revision is refused with 409', async () => {
    const v = await freshVersion();
    const r = refusalOf(await author.call(routes.designer.startVerification, { params: { versionId: v.versionId }, body: { baseRevision: v.revision + 1 } }));
    expect(r.status).toBe(409);
    expect(r.code).toBe('DESIGNER_STALE');
  });
});
