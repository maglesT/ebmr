/**
 * A warning justification answers the warning of the content it was written for (review P15 and P59; IN-02, DI-04,
 * PR-03; outline 6.3 "warnings need a recorded justification").
 *
 * tab.designer_justification keeps the content revision and hash each justification was written against (IN-02:
 * bound to the revision and content hash), but the designer took the latest row per finding key as in force for any
 * later content, and the gate, the VALIDATOR evidence and the test package matched on the key (`${rule}@${subject}`,
 * a stable element id) alone. So a warning whose element changed, or that disappeared and came back as a different
 * warning under the same key, passed on a text written for other content.
 *
 * Now a justification is in force only for exactly the revision and content hash it was recorded against; the
 * justify request names the saved revision and content hash its author was shown (409 DESIGNER_STALE when that is no
 * longer the saved content, so a text written for revision 2 is never recorded against revision 3); the database
 * records one only against the content hash its caller names while that is still the saved content (EBMR-TAB-156)
 * and fails VALIDATOR evidence that carries any other (0280_designer_guards.sql).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { identity, type ActorContext } from '@ebmr/kernel';
import { routes, type VersionView } from '@ebmr/api-contract';
import { lifecycle } from '@ebmr/recipe-core';
import type { flow } from '@ebmr/recipe-core/pure';
import { asAdmin, openPersonaSession } from '@ebmr/test-kit';
import { loadValidationContext } from '../../src/features/designer/adapters/expressions.ts';
import type { TestBrowser, TestServer } from '../support/harness.ts';
import { createFamily, edited, findPhase, justifyBody, parameter, refusalOf, saveContent, startDesignerServer, valueOf } from './support.ts';

let server: TestServer;
let author: TestBrowser;

async function validate(content: unknown, versionId?: string) {
  return valueOf(await author.call(routes.designer.validate, { body: { content: content as VersionView['content'], ...(versionId ? { versionId } : {}) } }));
}

async function authorActor(): Promise<ActorContext> {
  return { ...(await openPersonaSession(server.db, server.seed, 'author')), reasonCode: 'TEST', reasonText: 'justification binding test' };
}

beforeAll(async () => {
  server = await startDesignerServer();
  author = await server.asPersona('author');
}, 180_000);
afterAll(async () => {
  await server?.close();
});

describe('warning justifications are bound to the content they were written for (IN-02, DI-04, PR-03)', () => {
  it('[IN-02][PR-03][DI-04] a justification of a deleted parameter does not justify a different parameter re-added under the same id (P15)', async () => {
    const KEY = 'DATA-SINGLE-WRITER@pX';
    const v1 = await createFamily(author, { familyCode: 'PCM500-P15', batchSizes: [{ quantity: '71.000', unit: 'kg' }] });

    // Revision 2: an unrecorded information-only parameter pX; its warning is justified.
    const withInfo = edited(v1, (c) => {
      const p = structuredClone(parameter(c, 'blendTime')) as flow.Parameter & { name: string; id: string };
      p.id = 'pX';
      p.name = 'Room humidity (information only)';
      c.parameters.push(p);
    });
    const v2 = valueOf(await saveContent(author, v1, withInfo, 'information-only parameter added'));
    const r2 = await validate(v2.content, v1.versionId);
    const w2 = r2.findings.find((f) => f.key === KEY);
    expect(w2?.severity).toBe('WARNING');
    expect(r2.gate).toEqual(expect.objectContaining({ errors: 0, unjustifiedWarnings: 1 }));
    valueOf(
      await author.call(routes.designer.justify, {
        params: { versionId: v1.versionId },
        body: justifyBody(v2, KEY, 'Information only: room humidity is recorded in the room log, not in the batch record.'),
      }),
    );
    expect((await validate(v2.content, v1.versionId)).gate.passed).toBe(true);

    // Revision 3: pX deleted; the warning disappears.
    const v3 = valueOf(await saveContent(author, v2, v1.content, 'information-only parameter removed'));
    const r3 = await validate(v3.content, v1.versionId);
    expect(r3.findings.some((f) => f.key === KEY)).toBe(false);
    expect(r3.gate.passed).toBe(true);

    // Revision 4: a different, critical process parameter under the same id pX that no step records.
    const withCpp = edited(v3, (c) => {
      const p = structuredClone(parameter(c, 'blenderSpeed')) as flow.Parameter & { name: string; id: string };
      p.id = 'pX';
      p.name = 'Lubrication blend time';
      c.parameters.push(p);
    });
    const v4 = valueOf(await saveContent(author, v3, withCpp, 'lubrication blend time added'));
    const r4 = await validate(v4.content, v1.versionId);
    const w4 = r4.findings.find((f) => f.key === KEY);
    expect(w4?.severity).toBe('WARNING');
    expect(w4?.message).not.toBe(w2?.message);
    expect(r4.findings.filter((f) => f.severity === 'ERROR')).toEqual([]);
    expect(r4.findings.filter((f) => f.severity === 'WARNING').map((f) => f.key)).toEqual([KEY]);

    // The new warning was never justified: not shown as justified, the gate fails, the version view lists nothing.
    expect(w4?.justification ?? null).toBeNull();
    expect(r4.gate).toEqual(expect.objectContaining({ passed: false, errors: 0, unjustifiedWarnings: 1 }));
    expect(v4.justifications).toEqual([]);

    // ...and the version does not enter verification on the justification of the deleted parameter.
    const started = await author.call(routes.designer.startVerification, { params: { versionId: v1.versionId }, body: { baseRevision: v4.revision } });
    const after = valueOf(await author.call(routes.designer.version, { params: { versionId: v1.versionId } }));
    expect({ ok: started.ok, state: after.state }).toEqual({ ok: false, state: 'DRAFT' });
  });

  it('[IN-02][DI-04] a justification recorded for revision 2 does not justify the same-keyed warning after the justified step changed in revision 3 (P59)', async () => {
    const KEY = 'G07-TOLERANCE-MISSING@p-disp-exc';
    const v1 = await createFamily(author, { familyCode: 'PCM500-P59', batchSizes: [{ quantity: '59.000', unit: 'kg' }] });

    // Revision 2: the excipient tolerance is removed; the author justifies the warning for this content.
    const v2 = valueOf(await saveContent(author, v1, edited(v1, (c) => (findPhase(c, 'p-disp-exc').config = {})), 'excipient tolerance removed'));
    expect(v2.revision).toBe(2);
    const r2 = await validate(v2.content, v2.versionId);
    expect(r2.findings.find((f) => f.key === KEY)?.severity).toBe('WARNING');
    expect(r2.gate).toEqual(expect.objectContaining({ passed: false, errors: 0, unjustifiedWarnings: 1 }));
    const justified = valueOf(
      await author.call(routes.designer.justify, {
        params: { versionId: v2.versionId },
        body: justifyBody(v2, KEY, 'Excipients are weighed net on the balance and checked against the formula at reconciliation (SOP-DISP-001).'),
      }),
    );
    expect(justified.justifications.map((j) => j.findingKey)).toEqual([KEY]);
    const stored = await asAdmin(server.database, (c) =>
      c.query<{ content_revision: number; content_hash: string }>('select content_revision, content_hash from tab.designer_justification where version_id = $1', [v2.versionId]),
    );
    expect(stored.rows).toEqual([{ content_revision: 2, content_hash: v2.contentHash }]);

    // Revision 3: the justified step itself changes (whole supplier containers instead of net weighing, new name).
    const changed = edited(v2, (c) => {
      const p = findPhase(c, 'p-disp-exc');
      p.config = { method: 'WHOLE_CONTAINER' };
      p.name = 'Dispense excipients as whole supplier containers';
    });
    // While the change is not saved yet (the editor validates it live), revision 2's justification is not shown as in
    // force for it either: it is other content.
    const unsaved = await validate(changed, v2.versionId);
    expect(unsaved.findings.find((f) => f.key === KEY)?.justification ?? null).toBeNull();
    expect(unsaved.gate).toEqual(expect.objectContaining({ passed: false, unjustifiedWarnings: 1 }));
    expect((await validate(v2.content, v2.versionId)).gate.passed).toBe(true);
    const v3 = valueOf(await saveContent(author, v2, changed, 'excipients dispensed as whole containers'));
    expect(v3.revision).toBe(3);
    expect(v3.contentHash).not.toBe(v2.contentHash);
    expect(v3.justifications).toEqual([]);

    // Without justifications, revision 3 has no error and exactly the same-keyed warning (the only thing to justify).
    const bare = await validate(v3.content);
    expect(bare.findings.filter((f) => f.severity === 'WARNING').map((f) => f.key)).toEqual([KEY]);
    expect(bare.gate).toEqual(expect.objectContaining({ passed: false, errors: 0, unjustifiedWarnings: 1 }));

    // The justification written for revision 2 is not in force for revision 3's different content.
    const r3 = await validate(v3.content, v3.versionId);
    expect(r3.findings.find((f) => f.key === KEY)?.justification ?? null).toBeNull();
    expect(r3.gate).toEqual(expect.objectContaining({ passed: false, errors: 0, unjustifiedWarnings: 1 }));
    const start = await author.call(routes.designer.startVerification, { params: { versionId: v3.versionId }, body: { baseRevision: v3.revision } });
    expect(refusalOf(start).code).toBe('DESIGNER_GATE_FAILED');
    const refusedPkg = refusalOf(await author.call(routes.designer.testPackage, { params: { versionId: v3.versionId }, body: {} }));
    expect(refusedPkg.code).toBe('DESIGNER_GATE_FAILED');

    // Once the author justifies the warning for revision 3, verification starts: the refusal was the stale justification only.
    valueOf(
      await author.call(routes.designer.justify, {
        params: { versionId: v3.versionId },
        body: justifyBody(v3, KEY, 'Whole supplier containers are checked against the certificate and the formula at reconciliation (SOP-DISP-001).'),
      }),
    );
    const started = valueOf(await author.call(routes.designer.startVerification, { params: { versionId: v3.versionId }, body: { baseRevision: v3.revision } }));
    expect(started.state).toBe('IN_VERIFICATION');
    expect(started.justifications.map((j) => j.text)).toEqual([expect.stringMatching(/^Whole supplier containers/) as unknown]);
  });

  it('[IN-02][DI-04] the database records a justification only against the content hash it names, while that is the saved content (EBMR-TAB-156)', async () => {
    const KEY = 'G07-TOLERANCE-MISSING@p-disp-exc';
    const v1 = await createFamily(author, { familyCode: 'PCM500-P59DBJ', batchSizes: [{ quantity: '58.000', unit: 'kg' }] });
    const v2 = valueOf(await saveContent(author, v1, edited(v1, (c) => (findPhase(c, 'p-disp-exc').config = {})), 'excipient tolerance removed'));
    const v3 = valueOf(await saveContent(author, v2, edited(v2, (c) => (findPhase(c, 'p-disp-exc').name = 'Dispense excipients (renamed)')), 'renamed'));
    const actor = await authorActor();
    const record = (sql: string, args: unknown[]) => identity.withGuardedCommand(server.db.app, actor, (c) => c.query(sql, args));

    // Written for revision 2's content while revision 3 is saved: refused.
    await expect(record('select tab.record_designer_justification($1, $2, $3, $4)', [v1.versionId, KEY, 'for revision 2', v2.contentHash])).rejects.toThrow(/EBMR-TAB-156/);
    // The form that names no content is not the application's to call.
    await expect(record('select tab.record_designer_justification($1, $2, $3)', [v1.versionId, KEY, 'no content named'])).rejects.toThrow(/permission denied/);
    // Written for the content that is saved: recorded, bound to revision 3 and its hash.
    const ok = await record('select tab.record_designer_justification($1, $2, $3, $4) as r', [v1.versionId, KEY, 'for revision 3', v3.contentHash]);
    expect((ok.rows[0] as { r: { revision: number; content_hash: string } }).r).toEqual(expect.objectContaining({ revision: 3, content_hash: v3.contentHash }));
  });

  it('[IN-02][DI-04] VALIDATOR evidence carrying a justification not in force for the current content does not pass, whoever assembled it', async () => {
    const v1 = await createFamily(author, { familyCode: 'PCM500-P59DBE', batchSizes: [{ quantity: '57.000', unit: 'kg' }] });
    const KEY = 'G07-TOLERANCE-MISSING@p-disp-exc';
    const v2 = valueOf(await saveContent(author, v1, edited(v1, (c) => (findPhase(c, 'p-disp-exc').config = {})), 'excipient tolerance removed'));
    const oldText = 'Checked at reconciliation (revision 2).';
    valueOf(await author.call(routes.designer.justify, { params: { versionId: v1.versionId }, body: justifyBody(v2, KEY, oldText) }));
    const v3 = valueOf(await saveContent(author, v2, edited(v2, (c) => (findPhase(c, 'p-disp-exc').name = 'Dispense excipients (renamed)')), 'renamed'));
    const mbr = v3.content as unknown as flow.MbrContent;
    const loaded = await loadValidationContext(server.db.app, mbr);
    const report = lifecycle.createVerificationPort(loaded.context).validate(mbr);
    expect(report.errors).toBe(0);
    const actor = await authorActor();
    const personId = actor.personId;
    const evidence = (justifications: { key: string; text: string; by: string }[]) =>
      identity.withGuardedCommand(server.db.app, actor, (c) => lifecycle.recordEvidence(c, v1.versionId, 'VALIDATOR', lifecycle.validatorEvidence(report, justifications)));

    // The revision-2 justification, as it was recorded, carried into revision 3's evidence: FAIL, with the reason.
    const stale = await evidence([{ key: KEY, text: oldText, by: personId }]);
    expect(stale.result).toBe('FAIL');
    expect(stale.problems.join(' ')).toMatch(/not recorded for this content \(revision 3\): G07-TOLERANCE-MISSING@p-disp-exc/);
    // Controls: no justification passes (no validator warning to justify); a recorded one for revision 3 passes; a
    // text other than the recorded one, or another person, does not.
    expect((await evidence([])).result).toBe('PASS');
    const newText = 'Checked at reconciliation (revision 3).';
    valueOf(await author.call(routes.designer.justify, { params: { versionId: v1.versionId }, body: justifyBody(v3, KEY, newText) }));
    expect((await evidence([{ key: KEY, text: newText, by: personId }])).result).toBe('PASS');
    expect((await evidence([{ key: KEY, text: `${newText} (edited)`, by: personId }])).result).toBe('FAIL');
    expect((await evidence([{ key: KEY, text: newText, by: '00000000-0000-4000-8000-000000000000' }])).result).toBe('FAIL');
  });
  it('[IN-02][DI-04] a justification written for revision 2 is refused once revision 3 was saved meanwhile elsewhere, and cannot let revision 3 enter verification (P15, P59)', async () => {
    const KEY = 'G07-TOLERANCE-MISSING@p-disp-exc';
    const v1 = await createFamily(author, { familyCode: 'PCM500-P59RACE', batchSizes: [{ quantity: '56.000', unit: 'kg' }] });
    const v2 = valueOf(await saveContent(author, v1, edited(v1, (c) => (findPhase(c, 'p-disp-exc').config = {})), 'excipient tolerance removed'));
    // The author validates revision 2, sees the warning and starts writing the justification.
    const r2 = await validate(v2.content, v2.versionId);
    expect(r2.findings.find((f) => f.key === KEY)?.severity).toBe('WARNING');
    // Meanwhile, in another session, revision 3 changes the justified step itself (the same-keyed warning stays).
    const elsewhere = await server.asPersona('author');
    const v3 = valueOf(
      await saveContent(
        elsewhere,
        v2,
        edited(v2, (c) => {
          const p = findPhase(c, 'p-disp-exc');
          p.config = { method: 'WHOLE_CONTAINER' };
          p.name = 'Dispense excipients as whole supplier containers';
        }),
        'changed elsewhere',
      ),
    );
    expect(v3.revision).toBe(3);
    expect((await validate(v3.content)).findings.filter((f) => f.severity === 'WARNING').map((f) => f.key)).toEqual([KEY]);

    // The author submits the text written for revision 2: refused as stale, nothing recorded.
    const refused = refusalOf(
      await author.call(routes.designer.justify, { params: { versionId: v2.versionId }, body: justifyBody(v2, KEY, 'Excipients are weighed net on the balance (revision 2 content).') }),
    );
    expect([refused.status, refused.code, refused.kind]).toEqual([409, 'DESIGNER_STALE', 'STALE']);
    const rows = await asAdmin(server.database, (c) => c.query('select 1 from tab.designer_justification where version_id = $1', [v2.versionId]));
    expect(rows.rowCount).toBe(0);
    // A body naming revision 3 but revision 2's content hash is refused too.
    const mixed = refusalOf(await author.call(routes.designer.justify, { params: { versionId: v2.versionId }, body: { ...justifyBody(v3, KEY, 'mixed'), contentHash: v2.contentHash } }));
    expect(mixed.code).toBe('DESIGNER_STALE');

    // Revision 3 does not enter verification on it.
    const start = await author.call(routes.designer.startVerification, { params: { versionId: v3.versionId }, body: { baseRevision: 3 } });
    const after = valueOf(await author.call(routes.designer.version, { params: { versionId: v3.versionId } }));
    expect({ ok: start.ok, state: after.state, justs: after.justifications }).toEqual({ ok: false, state: 'DRAFT', justs: [] });
  });
});
