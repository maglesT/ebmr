/**
 * Change control of masters (PR-06) and registration conformity (PR-04): an approved master never
 * changes; a change is a derived version with a change record, a validation link when it affects the
 * process, and the regulatory action each market needs when a registered element changes. The
 * comparisons are computed by the database; the TypeScript mirror is proven equal.
 */
import { randomUUID } from 'node:crypto';
import fc from 'fast-check';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withCommand } from '../../../kernel/src/db/command.ts';
import { createTestDatabase, type TestDatabase } from '../../../kernel/test/support/db.ts';
import { mbrContentHash } from '../../src/flow/canonical.ts';
import type { MbrContent } from '../../src/flow/model.ts';
import * as lc from '../../src/lifecycle/index.ts';
import { clone, loadFixture, seedCast, uniqueContent, World } from './support.ts';

let db: TestDatabase;
let w: World;

beforeAll(async () => {
  db = await createTestDatabase();
  w = new World(db, await seedCast(db));
}, 300_000);

afterAll(async () => {
  await db.drop();
});

const sealRange = (m: MbrContent) => {
  const r = m.parameters.find((p) => p.id === 'sealTemp')?.limits?.ranges[0];
  if (!r?.low || !r.high) throw new Error('fixture changed: sealTemp');
  return r as typeof r & { low: NonNullable<typeof r.low>; high: NonNullable<typeof r.high> };
};
const avgRange = (m: MbrContent) => {
  const r = m.acceptanceSchemes.find((s) => s.id === 'AS-UOW')?.criteria.find((c) => c.id === 'IP-AVG')?.range;
  if (!r?.low || !r.high) throw new Error('fixture changed: AS-UOW/IP-AVG');
  return r as typeof r & { low: NonNullable<typeof r.low>; high: NonNullable<typeof r.high> };
};

/** Derives v2 from an approved v1, applies `edit`, links `changeRecord`, verifies and gets it CHECKED; returns the APPROVED signature. */
async function checkedSuccessor(v1: string, edit: (m: MbrContent) => void, changeRecord: string) {
  const v2 = await w.run(w.cast.author, (c) => lc.deriveVersion(c, v1, 'change under test'));
  const content = (await lc.loadContent(db.app, v2.versionId)).content;
  edit(content);
  await w.run(w.cast.author, (c) => lc.saveContent(c, v2.versionId, content));
  const ra = await w.riskAssessment();
  await w.run(w.cast.author, async (c) => {
    await lc.setDraftAttributes(c, v2.versionId, { changeRecordId: changeRecord, effectiveFrom: '2026-03-01T00:00:00Z', reviewDue: '2028-03-01' });
    await lc.linkRiskAssessment(c, v2.versionId, ra);
  });
  await w.recordEvidence(v2.versionId, content, 'stub');
  await w.startVerification(v2.versionId);
  await w.submit(v2.versionId);
  await w.check(v2.versionId);
  await w.regulatoryConfirm(v2.versionId);
  const approvedSig = await w.signVersion(w.cast.qa, v2.versionId, 'APPROVED', 'CHECKED');
  const approve = async () => {
    const s = await w.state(v2.versionId);
    return w.run(w.cast.qa, (c) => lc.approveVersion(c, v2.versionId, s.version, approvedSig));
  };
  return { v2: v2.versionId, content, approve };
}

describe('an approved master never changes (PR-06)', () => {
  it('[PR-06] a direct edit of an approved or effective master is impossible; the change is a derived version', async () => {
    const content = uniqueContent();
    const v1 = await w.approvedVersion(content);
    await w.authorise({ versionId: v1.versionId, market: 'IN', kind: 'CURRENT', cells: [{ site: 'S1', line: 'L1', batch_size: 'PO-20K' }], regulatoryBasis: 'India: no prior approval needed' });
    const edited = clone(content);
    sealRange(edited).high.value = '205';
    await expect(w.run(w.cast.author, (c) => lc.saveContent(c, v1.versionId, edited))).rejects.toThrow(/This MBR version is APPROVED: its content can change only in DRAFT.*EBMR-RCP-021/);
    await expect(w.run(w.cast.author, (c) => lc.setDraftAttributes(c, v1.versionId, { effectiveFrom: '2030-01-01T00:00:00Z' }))).rejects.toThrow(/EBMR-RCP-021/);
    const ra = await w.riskAssessment();
    await expect(w.run(w.cast.author, (c) => lc.linkRiskAssessment(c, v1.versionId, ra))).rejects.toThrow(/EBMR-RCP-021/);
    await expect(w.run(w.cast.author, (c) => lc.createVersion(c, v1.familyId, edited))).rejects.toThrow(/EBMR-RCP-025/);
    // The application role has no direct write on any recipe table ...
    await expect(db.app.query('update recipe.mbr_content set content = content where version_id = $1', [v1.versionId])).rejects.toThrow(/permission denied/);
    await expect(db.app.query("update recipe.mbr_version set effective_from = now() where id = $1", [v1.versionId])).rejects.toThrow(/permission denied/);
    await expect(db.app.query('delete from recipe.mbr_content where version_id = $1', [v1.versionId])).rejects.toThrow(/permission denied/);
    // ... and even owner-level writers are refused by the table guards.
    await expect(db.admin.query('update recipe.mbr_content set reason = $2 where version_id = $1', [v1.versionId, 'x'])).rejects.toThrow(/EBMR-AUDIT-004|insert-only/);
    await expect(
      withCommand(db.admin, { ...w.cast.author, correlationId: randomUUID() }, (c) =>
        c.query("insert into recipe.mbr_content (version_id, revision, content, content_hash, edited_by_person, edited_by_account) values ($1, 0, $2::jsonb, $3, $4, $4)", [
          v1.versionId,
          JSON.stringify(edited),
          mbrContentHash(edited),
          w.cast.author.personId,
        ]),
      ),
    ).rejects.toThrow(/EBMR-RCP-021/);
    // The change: a new DRAFT version derived from the approved one, starting from its content.
    const v2 = await w.run(w.cast.author, (c) => lc.deriveVersion(c, v1.versionId, 'raise the sealing limit'));
    expect(v2).toMatchObject({ versionNumber: 2, state: 'DRAFT', contentHash: v1.contentHash });
    await w.run(w.cast.author, (c) => lc.saveContent(c, v2.versionId, edited, 'sealing limit'));
    expect((await lc.loadContent(db.app, v1.versionId)).contentHash).toBe(v1.contentHash);
    expect(await w.violations()).toEqual([]);
  });

  it('[PR-06] a process-impacting change with no validation link cannot be approved', async () => {
    const content = uniqueContent();
    const v1 = await w.approvedVersion(content);
    const cr = await w.changeRecord({ processImpacting: false, validationRef: null });
    const s = await checkedSuccessor(v1.versionId, (m) => (sealRange(m).low.value = '182'), cr);
    await expect(s.approve()).rejects.toThrow(/change_control_complete: this change affects the process \(parameters\) and change record CC-[0-9a-f]+ has no validation link/);
    expect((await w.state(s.v2)).state).toBe('CHECKED');
    await w.run(w.cast.qa, (c) => lc.addChangeValidation(c, cr, 'PV-PACK-2026-07', 'sealing range revalidated'));
    await s.approve();
    expect((await w.state(s.v2)).state).toBe('APPROVED');
  });

  it('[PR-06] a change that touches only titles and test data is not process-impacting; a first version is a new process', async () => {
    const content = uniqueContent();
    const v1 = await w.approvedVersion(content);
    const cr = await w.changeRecord({ processImpacting: false, validationRef: null });
    const s = await checkedSuccessor(v1.versionId, (m) => (m.header.title = `${m.header.title} (reworded)`), cr);
    await s.approve();
    expect((await w.state(s.v2)).state).toBe('APPROVED');
    // The change owner may classify it process-impacting all the same: then the link is required.
    const cr2 = await w.changeRecord({ processImpacting: true, validationRef: null });
    const s2 = await checkedSuccessor(s.v2, (m) => (m.header.title = `${m.header.title} again`), cr2);
    await expect(s2.approve()).rejects.toThrow(/classified process-impacting by the change owner/);
    // A new master without a validation link.
    const fresh = uniqueContent();
    const v = await w.newVersion(fresh);
    await w.prepare(v.versionId, fresh, { validationLink: false });
    await w.startVerification(v.versionId);
    await w.submit(v.versionId);
    await w.check(v.versionId);
    await expect(w.approve(v.versionId)).rejects.toThrow(/this change affects the process \(new master\)/);
  });

  it('[PR-06] the diff report lists exactly the changed fields', async () => {
    const content = uniqueContent();
    const v1 = await w.approvedVersion(content);
    const v2 = await w.run(w.cast.author, (c) => lc.deriveVersion(c, v1.versionId, 'two changes'));
    const next = clone(content);
    sealRange(next).low.value = '185';
    next.header.title = 'Retitled';
    await w.run(w.cast.author, (c) => lc.saveContent(c, v2.versionId, next));
    const diff = await lc.versionDiff(db.app, v2.versionId);
    expect(diff.baselines).toHaveLength(1);
    const b = diff.baselines[0];
    expect(b?.baselineVersionNumber).toBe(1);
    expect(b?.diff.changes.map((c) => [c.path, c.before, c.after, c.class])).toEqual([
      ['/header/title', content.header.title, 'Retitled', 'STRUCTURAL'],
      ['/parameters[sealTemp]/limits/ranges[VALIDATED]/low/value', '180', '185', 'VALUE'],
    ]);
    expect(diff.processImpact).toEqual({ impacting: true, newMaster: false, areas: ['parameters'] });
    const sql = (await db.app.query<{ r: { impacting: boolean; areas: string[] } }>('select recipe.process_impact($1) as r', [v2.versionId])).rows[0]?.r;
    expect(sql).toMatchObject({ impacting: true, areas: ['parameters'] });
    const pkg = await lc.bulkApprovalPackage(db.app, [v2.versionId]);
    expect(pkg[0]?.baselines[0]?.diff.changes).toHaveLength(2);
  });
});

describe('registration conformity (PR-04)', () => {
  const granulation = () => uniqueContent('tablet-granulation-compression');

  it('[PR-04] widening a registered range with no variation reference is blocked; with the reference per market it is approved', async () => {
    const content = granulation();
    const v1 = await w.approvedVersion(content);
    const cr = await w.changeRecord({ regulatory: [{ market: 'IN', category: 'PRIOR_APPROVAL' }, { market: 'US', category: 'PAS' }] });
    const s = await checkedSuccessor(v1.versionId, (m) => (avgRange(m).low.value = '235.0'), cr);
    await expect(s.approve()).rejects.toThrow(
      /registered_ranges_kept: registered elements changed without the regulatory action each market needs: AS-UOW\/IP-AVG: registered range changed from \[237\.5, 262\.5\] to \[235\.0, 262\.5\] without a variation, supplement or approval reference for market IN; .* for market US \(PR-04\)/,
    );
    await w.run(w.cast.regulatory, async (c) => {
      await lc.addChangeRegulatory(c, cr, 'IN', 'PRIOR_APPROVAL', 'CDSCO/PAC/2026/117');
      await lc.addChangeRegulatory(c, cr, 'US', 'PAS', 'NDA 012345 S-018 approved');
    });
    await s.approve();
    expect((await w.state(s.v2)).state).toBe('APPROVED');
  });

  it('[PR-04] narrowing a registered range needs a regulatory assessment for every market, not a variation reference', async () => {
    const content = granulation();
    const v1 = await w.approvedVersion(content);
    const cr = await w.changeRecord();
    const s = await checkedSuccessor(v1.versionId, (m) => (avgRange(m).high.value = '260.0'), cr);
    await expect(s.approve()).rejects.toThrow(/without a regulatory assessment for market IN/);
    await w.run(w.cast.regulatory, async (c) => {
      await lc.addChangeRegulatory(c, cr, 'IN', 'NOTIFICATION');
      await lc.addChangeRegulatory(c, cr, 'US', 'CBE-30');
    });
    await s.approve();
    expect((await w.state(s.v2)).state).toBe('APPROVED');
  });

  it('[PR-04] the database and the TypeScript mirror find the same registered changes (fast-check)', async () => {
    const base = loadFixture('tablet-granulation-compression');
    const decimal = fc.tuple(fc.integer({ min: 200, max: 300 }), fc.integer({ min: 0, max: 9 })).map(([i, d]) => `${i}.${d}`);
    const edit = fc.record({
      low: fc.option(decimal, { nil: undefined }),
      high: fc.option(decimal, { nil: undefined }),
      lowInclusive: fc.boolean(),
      highInclusive: fc.boolean(),
      remove: fc.boolean(),
      unit: fc.constantFrom('mg', 'mg', 'mg', 'g'),
      registration: fc.constantFrom('3', '3', '4'),
    });
    await fc.assert(
      fc.asyncProperty(edit, async (e) => {
        const after = clone(base);
        const scheme = after.acceptanceSchemes.find((s) => s.id === 'AS-UOW');
        const criterion = scheme?.criteria.find((c) => c.id === 'IP-AVG');
        if (!scheme || !criterion) throw new Error('fixture changed');
        if (e.remove) criterion.range = { ...criterion.range, tier: 'INTERNAL_ACTION' };
        const r = criterion.range;
        if (e.low === undefined) delete r.low;
        else r.low = { value: e.low, inclusive: e.lowInclusive };
        if (e.high === undefined) delete r.high;
        else r.high = { value: e.high, inclusive: e.highInclusive };
        criterion.unit = e.unit;
        const reg = after.references.find((x) => x.kind === 'REGISTRATION');
        if (reg) reg.version = e.registration;
        const ts = lc.registeredChanges(base, after).map((c) => `${c.subject}:${c.widened}`).sort();
        const { rows } = await db.app.query<{ k: string }>(
          "select subject || ':' || widened as k from recipe.registered_changes($1::jsonb, $2::jsonb) order by 1",
          [JSON.stringify(base), JSON.stringify(after)],
        );
        expect(rows.map((x) => x.k).sort()).toEqual(ts);
      }),
      { numRuns: 60 },
    );
  });

  it('[PR-06] the database and the TypeScript mirror agree on the process impact of edits (fast-check)', async () => {
    const base = loadFixture('tablet-blister-packaging');
    const edits: ((m: MbrContent) => void)[] = [
      (m) => (m.header.title = 'x'),
      (m) => (m.header.product.name = 'y'),
      (m) => (m.goldenCases = []),
      (m) => {
        const r = m.references[0];
        if (r) r.title = 'renamed';
      },
      (m) => (sealRange(m).low.value = '181'),
      (m) => {
        const b = m.bom[0];
        if (b) b.quantity.value = '20001';
      },
      (m) => (m.riskReductions = []),
      (m) => {
        const r = m.references[0];
        if (r) r.version = '99';
      },
    ];
    await fc.assert(
      fc.asyncProperty(fc.subarray(edits.map((_, i) => i)), async (chosen) => {
        const after = clone(base);
        for (const i of chosen) edits[i]?.(after);
        const ts = lc.processImpact([base], after);
        const { rows } = await db.app.query<{ k: string }>(
          `select k from (select jsonb_object_keys(recipe.process_relevant($1::jsonb)) k union select jsonb_object_keys(recipe.process_relevant($2::jsonb))) u
            where recipe.process_relevant($1::jsonb) -> k is distinct from recipe.process_relevant($2::jsonb) -> k order by 1`,
          [JSON.stringify(base), JSON.stringify(after)],
        );
        expect(rows.map((r) => r.k)).toEqual(ts.areas);
      }),
      { numRuns: 40 },
    );
  });
});
