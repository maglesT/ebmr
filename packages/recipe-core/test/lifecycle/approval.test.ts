/**
 * Preparation, verification, independent check and QA approval of an MBR version (outline 5.2.1;
 * PR-02, PR-05, PR-06, PR-07, DI-04 life-cycle part, INV-04), through the real engine with real
 * e-signatures.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withCommand } from '../../../kernel/src/db/command.ts';
import { challengeFor, cmd, ensureSealKey, signatureAuth } from '../../../kernel/test/esig/helpers.ts';
import type { SeededActor } from '../../../kernel/test/identity/seed.ts';
import { approvePolicyVersion } from '../../../kernel/test/market/helpers.ts';
import { createTestDatabase, type TestDatabase } from '../../../kernel/test/support/db.ts';
import { canonicalJson, mbrContentHash, sha256Hex } from '../../src/flow/canonical.ts';
import * as lc from '../../src/lifecycle/index.ts';
import { clone, realPort, reason, seedCast, stubEvidence, uniqueContent, withSecondRole, World } from './support.ts';

let db: TestDatabase;
let w: World;

beforeAll(async () => {
  db = await createTestDatabase();
  w = new World(db, await seedCast(db));
}, 300_000);

afterAll(async () => {
  await db.drop();
});

const q = async <T>(sql: string, params: unknown[] = []): Promise<T[]> => (await db.admin.query(sql, params)).rows as T[];

/** A draft prepared for verification, then IN_VERIFICATION (the usual start of these tests). */
async function inVerification(opts: Parameters<World['prepare']>[2] = {}) {
  const content = uniqueContent();
  const v = await w.newVersion(content);
  await w.prepare(v.versionId, content, opts);
  await w.startVerification(v.versionId);
  return { ...v, content };
}

async function signatureStatus(id: string): Promise<string> {
  return (await q<{ s: string }>("select esig.signature_state($1) ->> 'status' as s", [id]))[0]?.s ?? '';
}

const FORGED_COLUMNS = `aggregate_type, aggregate_id, aggregate_ref, content_version, content_hash, meaning_code, meaning_version,
  meaning_title, meaning_text, signer_person, signer_account, signer_login, signer_legal_name, signer_role_code, signer_role_name,
  session_id, session_person, cosignature, device_id, auth_event_id, auth_method, components_used, components_required,
  authority_evaluation_id, challenge_id, correlation_id, site_zone, utc_offset, record_state, manifestation, manifestation_text`;

/** The forged row's values from the signer's challenge ($1 version id, $2 challenge id, $3 role code, $4 record state). */
const FORGED_VALUES = `select 'mbr_version', $1, 'mbr_version:' || $1, c.content_version, c.content_hash, c.meaning_code, c.meaning_version,
  'forged', 'forged', c.signer_person, c.signer_account, 'forged', 'forged', $3, 'forged', c.session_id, c.session_person, false,
  c.device_id, gen_random_uuid(), 'PASSWORD', array['PASSWORD'], 'ALL', gen_random_uuid(), c.id, gen_random_uuid(),
  iam.policy_text('site.zone'), '+00:00', $4::text, '{}'::jsonb, 'forged'
  from esig.challenge c where c.id = $2`;

/**
 * The forged row as kernel 1112 still lets owner-level code write it: exactly what the challenge names (record,
 * content, meaning and that meaning type's wording, signer, session, terminal) and an authentication event of the
 * signer made for the challenge ($5), consumed in the forging transaction. The authority evaluation, role and
 * independence checks of esig.sign are what it skips. ($1 version id, $2 challenge id, $3 role code, $4 record state.)
 */
const FORGED_FROM_CHALLENGE = `select c.aggregate_type, c.aggregate_id, c.aggregate_ref, c.content_version, c.content_hash, c.meaning_code, c.meaning_version,
  t.title, t.meaning_text, c.signer_person, c.signer_account, 'forged', 'forged', $3, 'forged', c.session_id, c.session_person, c.cosignature,
  c.device_id, e.id, e.method, e.components, 'ALL', gen_random_uuid(), c.id, gen_random_uuid(),
  iam.policy_text('site.zone'), '+00:00', $4::text, '{}'::jsonb, 'forged'
  from esig.challenge c join esig.meaning_type t on t.code = c.meaning_code and t.version = c.meaning_version
  join iam.auth_event e on e.id = $5::uuid
  where c.id = $2 and c.aggregate_id = $1`;

const FORGED_SEAL = `insert into esig.signature_seal (signature_id, aggregate_ref, key_id, algorithm, payload_sha256, seal)
  values ($1, 'mbr_version:' || $2, 'test-hmac-1', 'HMAC-SHA256', repeat('0', 64), encode(sha256('x'), 'base64'))`;

/**
 * An owner-level writer forges a sealed signature row that passes the engine's SIGNATURE hook: the
 * attack INV-04's database guard must stop. The row is inserted in a command of the signer, naming
 * its challenge exactly as esig.sign does (so the insert is audited, after the transition that
 * entered `recordState`, and bound to that state, kernel 0230/0910). Since kernel 1112 the signature
 * guard holds the row to its challenge and to an authentication of the signer consumed for it in the
 * same transaction, so the forger authenticates the signer for the challenge and consumes the event as
 * esig.sign does; it still skips the e-signature module's authority and independence checks
 * (EBMR-ESIG-040, 043, 044), which is what the machine's guards must catch.
 */
async function forgeSignature(signer: SeededActor, versionId: string, meaning: 'CHECKED' | 'APPROVED', recordState: string): Promise<string> {
  await ensureSealKey(db);
  const ch = await challengeFor(db, signer, versionId, { meaning, aggregateType: 'mbr_version' });
  const authEvent = await signatureAuth(db, signer, signer, ch.challengeId);
  return withCommand(db.admin, await cmd(db, signer), async (c) => {
    await c.query("select iam.consume_auth_event($1, $2, $3, interval '5 minutes')", [authEvent, signer.personId, ch.challengeId]);
    await c.query("select set_config('esig.signing_challenge', $1, true)", [ch.challengeId]);
    const { rows } = await c.query<{ id: string }>(`insert into esig.signature (${FORGED_COLUMNS}) ${FORGED_FROM_CHALLENGE} returning id`, [
      versionId,
      ch.challengeId,
      signer.roleCode,
      recordState,
      authEvent,
    ]);
    const id = rows[0]?.id ?? '';
    await c.query(FORGED_SEAL, [id, versionId]);
    return id;
  });
}

/**
 * The forgery kernel 1112 refuses (D11 found again in the e-signature module): the signing marker set by hand for the
 * signer's open challenge, the meaning wording not the meaning type's and an authentication event nobody made, sealed.
 * Before 1112 it was accepted and committed.
 */
async function forgeOnMarkerAlone(signer: SeededActor, versionId: string, meaning: 'CHECKED' | 'APPROVED', recordState: string): Promise<string> {
  await ensureSealKey(db);
  const ch = await challengeFor(db, signer, versionId, { meaning, aggregateType: 'mbr_version' });
  return withCommand(db.admin, await cmd(db, signer), async (c) => {
    await c.query("select set_config('esig.signing_challenge', $1, true)", [ch.challengeId]);
    const { rows } = await c.query<{ id: string }>(`insert into esig.signature (${FORGED_COLUMNS}) ${FORGED_VALUES} returning id`, [
      versionId,
      ch.challengeId,
      signer.roleCode,
      recordState,
    ]);
    const id = rows[0]?.id ?? '';
    await c.query(FORGED_SEAL, [id, versionId]);
    return id;
  });
}

/**
 * A superuser forges a sealed signature row with triggers off (session_replication_role = replica):
 * no record state, no audited insert. The kernel's SIGNATURE hook refuses it before any guard of the
 * machine runs (EBMR-PLAT-008).
 */
async function forgeReplicaSignature(signer: SeededActor, versionId: string, meaning: 'CHECKED' | 'APPROVED'): Promise<string> {
  await ensureSealKey(db);
  const ch = await challengeFor(db, signer, versionId, { meaning, aggregateType: 'mbr_version' });
  const client = await db.admin.connect();
  try {
    await client.query('begin');
    await client.query("set local session_replication_role = 'replica'");
    const { rows } = await client.query<{ id: string }>(
      `insert into esig.signature (id, recorded_at, ${FORGED_COLUMNS}) select gen_random_uuid(), clock_timestamp(), f.* from (${FORGED_VALUES}) f returning id`,
      [versionId, ch.challengeId, signer.roleCode, null],
    );
    const id = rows[0]?.id ?? '';
    await client.query(FORGED_SEAL, [id, versionId]);
    await client.query('commit');
    return id;
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

/** A recipe guard of the mbr_version machine evaluated directly on a signature (its reason, or null). */
async function guardOn(guard: 'checker_independent' | 'approver_independent' | 'signed_in_state', versionId: string, transition: object, signatureId: string): Promise<string | null> {
  const rows = await q<{ r: string | null }>(
    `select recipe.guard_${guard}('mbr_version', $1, $2::jsonb, jsonb_build_object('signature_id', $3::text), '{}'::jsonb) as r`,
    [versionId, JSON.stringify(transition), signatureId],
  );
  return rows[0]?.r ?? null;
}

describe('preparation, independent check and QA approval (PR-02, INV-04)', () => {
  it('[PR-02][PR-04][INV-04] the author prepares, an independent checker checks, regulatory confirms and QA approves: distinct persons, valid signatures', async () => {
    const content = uniqueContent();
    const v = await w.newVersion(content);
    await w.prepare(v.versionId, content, { evidence: 'real' });
    await w.startVerification(v.versionId);
    const prepared = await w.submit(v.versionId);
    const checked = await w.check(v.versionId);
    const approved = await w.approve(v.versionId);
    expect((await w.state(v.versionId)).state).toBe('APPROVED');
    const signers = await q<{ meaning_code: string; signer_person: string }>(
      "select meaning_code, signer_person from esig.signature where aggregate_ref = 'mbr_version:' || $1 order by recorded_at",
      [v.versionId],
    );
    expect(signers).toEqual([
      { meaning_code: 'PREPARED', signer_person: w.cast.author.personId },
      { meaning_code: 'CHECKED', signer_person: w.cast.checker.personId },
      { meaning_code: 'REGULATORY_CONFIRMED', signer_person: w.cast.regulatory.personId },
      { meaning_code: 'APPROVED', signer_person: w.cast.qa.personId },
    ]);
    for (const s of [prepared, checked, approved]) expect(await signatureStatus(s)).toBe('VALID');
    // What was signed: the MBR content hash and the version's key fields.
    const signed = await lc.versionSigningContent(db.app, v.versionId);
    const canonical = JSON.parse(signed.canonical ?? '{}') as { content: Record<string, unknown> };
    expect(canonical.content['content_hash']).toBe(mbrContentHash(content));
    expect(canonical.content['version_number']).toBe('1');
    expect(canonical.content['effective_from']).toBe('2026-01-01T00:00:00.000000Z');
    expect(canonical.content['review_due']).toBe('2027-12-31');
    expect((canonical.content['evidence'] as unknown[]).length).toBe(4);
    expect(await w.violations()).toEqual([]);
  });

  it('[PR-02][INV-04] when the same person tries to prepare and check a master, the check is refused', async () => {
    const v = await inVerification();
    await w.submit(v.versionId);
    // The author also holds the checker role: e-signature independence refuses the CHECKED signature.
    const authorAsChecker = await withSecondRole(db, w.cast.author, 'MBR_CHECKER');
    await expect(w.signVersion(authorAsChecker, v.versionId, 'CHECKED', 'SUBMITTED')).rejects.toThrow(/EBMR-ESIG-04[34]/);
    const s = await w.state(v.versionId);
    // A sealed CHECKED row written with triggers off (no record state, no audited insert) is refused by
    // the kernel's SIGNATURE hook before any guard of the machine runs.
    const replica = await forgeReplicaSignature(authorAsChecker, v.versionId, 'CHECKED');
    await expect(w.run(w.cast.checker, (c) => lc.checkVersion(c, v.versionId, s.version, replica))).rejects.toThrow(
      /EBMR-PLAT-008 .*applied while the record was in state \(none\)/,
    );
    // A CHECKED row written on the signing marker alone, with wording and an authentication its challenge does not back,
    // is refused by the signature guard itself (kernel 1112).
    await expect(forgeOnMarkerAlone(authorAsChecker, v.versionId, 'CHECKED', 'SUBMITTED')).rejects.toThrow(/EBMR-ESIG-065/);
    // Even a forged, sealed CHECKED signature of the author that passes the hook and the signature guard (the author
    // authenticated for it) is refused by the machine's database guard (INV-04).
    const forged = await forgeSignature(authorAsChecker, v.versionId, 'CHECKED', 'SUBMITTED');
    await expect(w.run(w.cast.checker, (c) => lc.checkVersion(c, v.versionId, s.version, forged))).rejects.toThrow(
      /mbr_version\.checker_independent: the author cannot check their own MBR version/,
    );
    expect((await w.state(v.versionId)).state).toBe('SUBMITTED');
  });

  it('[INV-04] nobody who edited the content since it last entered DRAFT signs CHECKED', async () => {
    const content = uniqueContent();
    const v = await w.newVersion(content);
    // The co-author edits the draft (a comment in the title is enough to be an editor).
    const edited = clone(content);
    edited.header.title = `${edited.header.title} (co-author edit)`;
    await w.run(w.cast.coAuthor, (c) => lc.saveContent(c, v.versionId, edited, 'co-author edit'));
    expect((await q<{ e: string[] }>('select recipe.editors_since_draft($1)::text[] as e', [v.versionId]))[0]?.e.sort()).toEqual(
      [w.cast.author.personId, w.cast.coAuthor.personId].sort(),
    );
    await w.prepare(v.versionId, edited);
    await w.startVerification(v.versionId);
    await w.submit(v.versionId);
    const coAuthorAsChecker = await withSecondRole(db, w.cast.coAuthor, 'MBR_CHECKER');
    await expect(w.signVersion(coAuthorAsChecker, v.versionId, 'CHECKED', 'SUBMITTED')).rejects.toThrow(/EBMR-ESIG-044/);
    const forged = await forgeSignature(coAuthorAsChecker, v.versionId, 'CHECKED', 'SUBMITTED');
    const s = await w.state(v.versionId);
    await expect(w.run(w.cast.checker, (c) => lc.checkVersion(c, v.versionId, s.version, forged))).rejects.toThrow(
      /the checker edited this version since it last entered DRAFT/,
    );
    expect((await w.state(v.versionId)).state).toBe('SUBMITTED');
    // An independent checker is accepted.
    await w.check(v.versionId);
    expect((await w.state(v.versionId)).state).toBe('CHECKED');
  });

  it('[INV-04][PR-02] the checker cannot also approve (S4 default); the approver cannot be the author or an editor', async () => {
    const v = await inVerification();
    await w.submit(v.versionId);
    const checkedSig = await w.check(v.versionId);
    const checkerAsQa = await withSecondRole(db, w.cast.checker, 'QA_MBR_APPROVER');
    await expect(w.signVersion(checkerAsQa, v.versionId, 'APPROVED', 'CHECKED')).rejects.toThrow(/EBMR-ESIG-043/);
    const forged = await forgeSignature(checkerAsQa, v.versionId, 'APPROVED', 'CHECKED');
    const s = await w.state(v.versionId);
    await expect(w.run(w.cast.qa, (c) => lc.approveVersion(c, v.versionId, s.version, forged))).rejects.toThrow(
      /mbr_version\.approver_independent: the checker cannot also approve/,
    );
    const forgedByAuthor = await forgeSignature(await withSecondRole(db, w.cast.author, 'QA_MBR_APPROVER'), v.versionId, 'APPROVED', 'CHECKED');
    await expect(w.run(w.cast.qa, (c) => lc.approveVersion(c, v.versionId, s.version, forgedByAuthor))).rejects.toThrow(
      /the author cannot approve their own MBR version/,
    );
    expect((await w.state(v.versionId)).state).toBe('CHECKED');
    // The guard itself, evaluated on the real CHECKED signature: checker = approver needs S4.
    const reasonText = (await q<{ r: string | null }>(
      "select recipe.guard_approver_independent('mbr_version', $1, '{}'::jsonb, jsonb_build_object('signature_id', $2::text), '{}'::jsonb) as r",
      [v.versionId, checkedSig],
    ))[0]?.r;
    expect(reasonText).toMatch(/unless QA policy S4/);
    await w.approve(v.versionId, w.cast.qa2);
    expect((await w.state(v.versionId)).state).toBe('APPROVED');
    expect(await w.violations()).toEqual([]);
  });

  it('[PR-02] a master with no effective date cannot be approved', async () => {
    const v = await inVerification({ effectiveFrom: null });
    await w.submit(v.versionId);
    await w.check(v.versionId);
    await expect(w.approve(v.versionId)).rejects.toThrow(/effective_date_set: the version has no effective date/);
    // Back to DRAFT, set the date, and the full route again with fresh signatures.
    const s = await w.state(v.versionId);
    await w.run(w.cast.qa, (c) => lc.returnToDraft(c, v.versionId, s.version), reason('effective date missing'));
    await w.run(w.cast.author, (c) => lc.setDraftAttributes(c, v.versionId, { effectiveFrom: '2026-02-01T00:00:00Z' }), reason('effective date agreed with QA'));
    await w.startVerification(v.versionId);
    await w.submit(v.versionId);
    // The QA person who returned it changed its signed content (a new draft cycle), so another checker and approver sign.
    await w.check(v.versionId, w.cast.checker2);
    await w.approve(v.versionId, w.cast.qa2);
    expect((await w.state(v.versionId)).state).toBe('APPROVED');
  });

  it('[PR-04][PR-02] approval requires the regulatory-conformity sign-off for the markets of the version', async () => {
    const v = await inVerification();
    await w.submit(v.versionId);
    await w.check(v.versionId);
    const approved = await w.signVersion(w.cast.qa, v.versionId, 'APPROVED', 'CHECKED');
    const approve = async () => {
      const s = await w.state(v.versionId);
      return w.run(w.cast.qa, (c) => lc.approveVersion(c, v.versionId, s.version, approved));
    };
    await expect(approve()).rejects.toThrow(/regulatory_confirmed: the regulatory-conformity sign-off \(REGULATORY_CONFIRMED\) for the markets of this version is missing \(PR-04\)/);
    // The QA approver cannot give it (the permission belongs to the regulatory-conformity signer).
    await expect(w.sign(w.cast.qa, 'mbr_version', v.versionId, 'REGULATORY_CONFIRMED', 'CHECKED')).rejects.toThrow(/EBMR-ESIG-040/);
    await w.regulatoryConfirm(v.versionId);
    await approve();
    expect((await w.state(v.versionId)).state).toBe('APPROVED');
  });

  it('[PR-05] every approved master carries a periodic-review due date after its effective date', async () => {
    const v = await inVerification({ reviewDue: null });
    await w.submit(v.versionId);
    await w.check(v.versionId);
    await expect(w.approve(v.versionId)).rejects.toThrow(/review_due_set: the version has no periodic-review due date/);
    const early = await inVerification({ effectiveFrom: '2026-06-01T00:00:00Z', reviewDue: '2026-05-31' });
    await w.submit(early.versionId);
    await w.check(early.versionId);
    await expect(w.approve(early.versionId)).rejects.toThrow(/is not after the effective date/);
  });

  it('[DI-37][INV-09][INV-04] a return to DRAFT supersedes every signature and starts a new draft cycle; signatures are never reused', async () => {
    const v = await inVerification();
    const prepared = await w.submit(v.versionId);
    const checked = await w.check(v.versionId);
    const s = await w.state(v.versionId);
    await expect(w.run(w.cast.qa, (c) => lc.returnToDraft(c, v.versionId, s.version))).rejects.toThrow(/reason_given/);
    await w.run(w.cast.qa, (c) => lc.returnToDraft(c, v.versionId, s.version), reason('rework after QA review'));
    expect((await w.state(v.versionId)).state).toBe('DRAFT');
    expect(await signatureStatus(prepared)).toBe('SUPERSEDED_BY_CHANGE');
    expect(await signatureStatus(checked)).toBe('SUPERSEDED_BY_CHANGE');
    expect((await q<{ c: number }>('select recipe.current_cycle($1) as c', [v.versionId]))[0]?.c).toBe(2);
    await w.startVerification(v.versionId);
    // The old PREPARED signature cannot authorise the new submission.
    const s2 = await w.state(v.versionId);
    await expect(w.run(w.cast.author, (c) => lc.submitVersion(c, v.versionId, s2.version, prepared))).rejects.toThrow(/EBMR-PLAT-00[78]|EBMR-PLAT-075/);
    await w.submit(v.versionId);
    expect((await w.state(v.versionId)).state).toBe('SUBMITTED');
    // The RETURN transition is refused unless the new draft cycle is recorded in the same command.
    await w.check(v.versionId, w.cast.checker2);
    const s3 = await w.state(v.versionId);
    await expect(w.run(w.cast.qa, (c) => lc.transitionVersion(c, v.versionId, 'RETURN', s3.version), reason('direct return'))).rejects.toThrow(
      /draft_entry_recorded/,
    );
  });

  it('[INV-04] bypass: the edit log and the version\'s author cannot be erased or rewritten, through the application role or by owner-level writers', async () => {
    const content = uniqueContent();
    const v = await w.newVersion(content);
    for (const sql of [
      'delete from recipe.mbr_version_log where version_id = $1',
      "update recipe.mbr_version_log set person_id = gen_random_uuid() where version_id = $1",
      'insert into recipe.mbr_version_log (version_id, cycle, kind, is_edit, person_id, account_id) select $1, 1, \'EVIDENCE\', false, gen_random_uuid(), gen_random_uuid()',
      'update recipe.mbr_version set author_person = gen_random_uuid() where id = $1',
      'insert into recipe.mbr_draft_entry (version_id, cycle, from_state, person_id, account_id, xact_id) values ($1, 9, \'CHECKED\', gen_random_uuid(), gen_random_uuid(), txid_current())',
    ]) {
      await expect(db.app.query(sql, [v.versionId])).rejects.toThrow(/permission denied/);
    }
    await expect(db.admin.query('delete from recipe.mbr_version_log where version_id = $1', [v.versionId])).rejects.toThrow(/EBMR-AUDIT-004/);
    await expect(
      withCommand(db.admin, { ...w.cast.author, correlationId: randomUUID(), reasonCode: 'TEST', reasonText: 'x' }, (c) =>
        c.query('update recipe.mbr_version set author_person = $2 where id = $1', [v.versionId, w.cast.coAuthor.personId]),
      ),
    ).rejects.toThrow(/identity of an MBR version .* never changes.*EBMR-RCP-024/);
    expect((await q<{ n: string }>('select count(*)::text as n from recipe.mbr_version_log where version_id = $1 and is_edit', [v.versionId]))[0]?.n).toBe('1');
  });

  it('[INV-04] editors count per draft cycle: after a return, earlier-cycle editors are not editors of the new cycle', async () => {
    const content = uniqueContent();
    const v = await w.newVersion(content);
    const edited = clone(content);
    edited.header.title = `${edited.header.title} (cycle 1 edit)`;
    await w.run(w.cast.coAuthor, (c) => lc.saveContent(c, v.versionId, edited));
    await w.prepare(v.versionId, edited);
    await w.startVerification(v.versionId);
    const s = await w.state(v.versionId);
    await w.run(w.cast.author, (c) => lc.returnToDraft(c, v.versionId, s.version), reason('author rework'));
    expect((await q<{ e: string[] }>('select recipe.editors_since_draft($1)::text[] as e', [v.versionId]))[0]?.e).toEqual([]);
    await w.run(w.cast.author, (c) => lc.setDraftAttributes(c, v.versionId, { reviewDue: '2027-11-30' }), reason('periodic review brought forward'));
    expect((await q<{ e: string[] }>('select recipe.editors_since_draft($1)::text[] as e', [v.versionId]))[0]?.e).toEqual([w.cast.author.personId]);
    // A real signature of the cycle-1 editor passes the INV-04 guard (the e-signature module stays stricter:
    // anyone who ever changed the signed content is excluded from CHECKED and APPROVED).
    const coPrepared = await w.sign(w.cast.coAuthor, 'mbr_version', v.versionId, 'PREPARED', 'DRAFT');
    const r = (await q<{ r: string | null }>(
      "select recipe.guard_checker_independent('mbr_version', $1, '{}'::jsonb, jsonb_build_object('signature_id', $2::text), '{}'::jsonb) as r",
      [v.versionId, coPrepared],
    ))[0]?.r;
    expect(r).toBeNull();
  });
});

describe('verification before submission (DI-04, PR-02)', () => {
  it('[PR-02][DI-04] a seeded unit error is caught before the check signature', async () => {
    const content = uniqueContent();
    const bad = clone(content);
    const seal = bad.parameters.find((p) => p.id === 'sealTemp');
    if (!seal?.limits) throw new Error('fixture changed: sealTemp has no limits');
    seal.limits.unit = 'kg';
    const v = await w.newVersion(bad);
    await w.prepare(v.versionId, bad, { evidence: 'none' });
    const report = realPort.validate(bad);
    expect(report.findings.some((f) => f.severity === 'ERROR' && f.rule === 'DATA-UNITS')).toBe(true);
    const e = await w.run(w.cast.author, (c) => lc.recordEvidence(c, v.versionId, 'VALIDATOR', lc.validatorEvidence(report)));
    expect(e.result).toBe('FAIL');
    await expect(w.startVerification(v.versionId)).rejects.toThrow(/validator_passed: the static validator did not pass on this exact content: 1 validator error/);
    // No check signature is possible: the version never reaches SUBMITTED.
    await expect(w.signVersion(w.cast.checker, v.versionId, 'CHECKED', 'SUBMITTED')).rejects.toThrow(/EBMR-ESIG-039/);
  });

  it('[DI-04][PR-02] through the verification port: the validator runs on the stored content, its result is stored with the hash, and verification starts only on a pass', async () => {
    const content = uniqueContent();
    const bad = clone(content);
    const range = bad.parameters.find((p) => p.id === 'sealTemp')?.limits;
    if (!range) throw new Error('fixture changed');
    range.unit = 'kg';
    const v = await w.newVersion(bad);
    await w.prepare(v.versionId, bad, { evidence: 'none' });
    let s = await w.state(v.versionId);
    const refused = await w.run(w.cast.author, (c) => lc.validateAndStartVerification(c, v.versionId, s.version, realPort));
    expect(refused.evidence.result).toBe('FAIL');
    expect(refused.transition).toBeUndefined();
    expect((await w.state(v.versionId)).state).toBe('DRAFT');
    await w.run(w.cast.author, (c) => lc.saveContent(c, v.versionId, content, 'unit corrected'));
    s = await w.state(v.versionId);
    const started = await w.run(w.cast.author, (c) => lc.validateAndStartVerification(c, v.versionId, s.version, realPort));
    expect(started.evidence).toMatchObject({ result: 'PASS', contentHash: mbrContentHash(content) });
    expect(started.transition?.to).toBe('IN_VERIFICATION');
    // The rest of the verification through the port, confirmed by the author, plus a sandbox run.
    const full = realPort.verify(content, []);
    const stored = await w.run(w.cast.author, (c) => lc.recordVerification(c, v.versionId, full, [], w.cast.author.personId));
    expect(stored.map((e) => [e.kind, e.result])).toEqual([
      ['VALIDATOR', 'PASS'],
      ['VERIFICATION', 'PASS'],
      ['TEST_VECTORS', 'PASS'],
    ]);
    expect((await lc.evidenceStatus(db.app, v.versionId)).missing).toEqual(['a passing sandbox test run on this exact content (SANDBOX_RUN)']);
  });

  it('[IN-13][INV-34] approve an MBR with one intermediate lacking a hold time: approval is refused (the validator fails on the stored content, naming the intermediate, and the version stays DRAFT)', async () => {
    const content = uniqueContent('tablet-granulation-compression');
    const bad = clone(content);
    const wet = bad.intermediates.find((i) => i.id === 'I-WET');
    if (!wet) throw new Error('fixture changed: no intermediate I-WET');
    delete wet.holdTime;
    const v = await w.newVersion(bad);
    await w.prepare(v.versionId, bad, { evidence: 'none' });
    const s = await w.state(v.versionId);
    const refused = await w.run(w.cast.author, (c) => lc.validateAndStartVerification(c, v.versionId, s.version, realPort));
    expect(refused.evidence.result).toBe('FAIL');
    expect(refused.transition).toBeUndefined();
    expect(realPort.validate(bad).findings.filter((f) => f.severity === 'ERROR').map((f) => f.message)).toEqual(
      expect.arrayContaining([expect.stringMatching(/Intermediate "Wet mass" \(I-WET\) has no hold time/)]),
    );
    expect((await w.state(v.versionId)).state).toBe('DRAFT');
    // Neither verification nor the approval chain can follow: the database refuses both.
    await expect(w.startVerification(v.versionId)).rejects.toThrow(/validator_passed/);
    await expect(w.submit(v.versionId)).rejects.toThrow();
  });

  it('[DI-04] try to make a new MBR version effective without a verification record: it is blocked', async () => {
    const content = uniqueContent();
    const v = await w.newVersion(content);
    await w.prepare(v.versionId, content, { evidence: 'none' });
    await expect(w.startVerification(v.versionId)).rejects.toThrow(/has not been run on this exact content/);
    const e = stubEvidence(content, w.cast.author.personId);
    await w.run(w.cast.author, (c) => lc.recordEvidence(c, v.versionId, 'VALIDATOR', e.validator));
    await w.startVerification(v.versionId);
    await expect(w.submit(v.versionId)).rejects.toThrow(/evidence_complete: the verification evidence for this exact content is incomplete: missing a passing simulation/);
    const status = await lc.evidenceStatus(db.app, v.versionId);
    expect(status.complete).toBe(false);
    expect(status.missing).toHaveLength(3);
  });

  it('[DI-04] evidence is bound to the exact content hash: an edit voids it, and evidence for other content fails', async () => {
    const content = uniqueContent();
    const v = await w.newVersion(content);
    await w.prepare(v.versionId, content, { evidence: 'real' });
    expect((await lc.evidenceStatus(db.app, v.versionId)).complete).toBe(true);
    const edited = clone(content);
    const seal = edited.parameters.find((p) => p.id === 'sealTemp');
    const range = seal?.limits?.ranges[0];
    if (!range?.high) throw new Error('fixture changed');
    range.high.value = '199';
    await w.run(w.cast.author, (c) => lc.saveContent(c, v.versionId, edited, 'narrower sealing range'));
    const after = await lc.evidenceStatus(db.app, v.versionId);
    expect(after.complete).toBe(false);
    expect(after.items).toEqual({});
    expect((await q<{ n: string }>('select count(*)::text as n from recipe.mbr_evidence_void where version_id = $1', [v.versionId]))[0]?.n).toBe('4');
    // Old reports carry the old hash: recorded again, they fail.
    const old = realPort.verify(content, []);
    const r = await w.run(w.cast.author, (c) => lc.recordEvidence(c, v.versionId, 'VERIFICATION', old.evidence));
    expect(r.result).toBe('FAIL');
    expect(r.problems.join(' ')).toMatch(/not on the current content/);
  });

  it('[DI-04] the database decides the result: a report that hides an error or an altered evidence seal fails', async () => {
    const content = uniqueContent();
    const v = await w.newVersion(content);
    const report = realPort.validate(content);
    const tampered = { ...report, findings: [...report.findings, { rule: 'X', controls: ['DI-04'], severity: 'ERROR', subject: '$', message: 'hidden', key: 'X@$' }] };
    const r1 = await w.run(w.cast.author, (c) => lc.recordEvidence(c, v.versionId, 'VALIDATOR', lc.validatorEvidence(tampered as typeof report)));
    expect(r1.result).toBe('FAIL');
    expect(r1.problems.join(' ')).toMatch(/1 validator error\(s\).*the error count does not match the findings/);
    const warned = { ...report, warnings: 1, findings: [{ rule: 'W', controls: ['DI-04'], severity: 'WARNING', subject: 'x', message: 'w', key: 'W@x' }] };
    const r2 = await w.run(w.cast.author, (c) => lc.recordEvidence(c, v.versionId, 'VALIDATOR', lc.validatorEvidence(warned as typeof report)));
    expect(r2.problems.join(' ')).toMatch(/warnings without a recorded justification: W@x/);
    const r3 = await w.run(w.cast.author, (c) =>
      lc.recordEvidence(c, v.versionId, 'VALIDATOR', lc.validatorEvidence(warned as typeof report, [{ key: 'W@x', text: 'accepted: reviewed by QA', by: w.cast.author.personId }])),
    );
    expect(r3.result).toBe('PASS');
    const full = realPort.verify(content, []);
    const altered = { ...full.evidence, verdict: 'VERIFIED' as const, reasons: [] as string[], languageVersion: 'altered' };
    const r4 = await w.run(w.cast.author, (c) => lc.recordEvidence(c, v.versionId, 'VERIFICATION', altered));
    expect(r4.result).toBe('FAIL');
    expect(r4.problems).toContain('the evidence seal does not match its content (altered evidence)');
    // Test vectors are confirmed by the version's author only.
    const r5 = await w.run(w.cast.coAuthor, (c) => lc.recordEvidence(c, v.versionId, 'TEST_VECTORS', lc.testVectorEvidence(full.simulation, w.cast.coAuthor.personId)));
    expect(r5.problems).toContain("test vectors are confirmed by the version's author");
  });

  it('[DI-04] a value-only change reuses the predecessor\'s structural evidence through delta verification (no new sandbox run)', async () => {
    const content = uniqueContent();
    const v1 = await w.approvedVersion(content, { evidence: 'real' });
    const v2 = await w.run(w.cast.author, (c) => lc.deriveVersion(c, v1.versionId, 'narrow the sealing range'));
    const next = clone(content);
    const range = next.parameters.find((p) => p.id === 'sealTemp')?.limits?.ranges[0];
    if (!range?.low) throw new Error('fixture changed');
    range.low.value = '182';
    await w.run(w.cast.author, (c) => lc.saveContent(c, v2.versionId, next));
    const prevEvidence = (await q<{ report: never }>("select report from recipe.mbr_evidence where version_id = $1 and kind = 'VERIFICATION' and result = 'PASS'", [v1.versionId]))[0]?.report;
    const delta = realPort.deltaVerify(content, prevEvidence as never, next, []);
    if ('refused' in delta) throw new Error(delta.refused);
    expect(delta.evidence.kind).toBe('DELTA');
    await w.run(w.cast.author, async (c) => {
      await lc.recordEvidence(c, v2.versionId, 'VALIDATOR', lc.validatorEvidence(delta.report));
      expect((await lc.recordEvidence(c, v2.versionId, 'VERIFICATION', delta.evidence)).result).toBe('PASS');
      await lc.recordEvidence(c, v2.versionId, 'TEST_VECTORS', lc.testVectorEvidence(delta.simulation, w.cast.author.personId));
    });
    const status = await lc.evidenceStatus(db.app, v2.versionId);
    expect(status).toMatchObject({ complete: true, delta: true });
    // A delta that names another basis fails.
    const wrong = { ...delta.evidence, basis: { ...delta.evidence.basis, contentHash: 'c'.repeat(64) } };
    const { evidenceHash: _e, ...rest } = wrong;
    void _e;
    const resealed = { ...rest, evidenceHash: sha256Hex(canonicalJson(rest)) };
    const bad = await w.run(w.cast.author, (c) => lc.recordEvidence(c, v2.versionId, 'VERIFICATION', resealed));
    expect(bad.problems.join(' ')).toMatch(/must build on the approved version this one was derived from/);
  });
});

describe('risk assessment and change record before submission (PR-07, PR-06)', () => {
  it('[PR-07] submitting a master with a critical parameter and no linked risk assessment is blocked', async () => {
    const v = await inVerification({ risk: false });
    await expect(w.submit(v.versionId)).rejects.toThrow(/critical_elements_risk_assessed: critical elements .*sealTemp.* have no linked risk assessment/);
    // Back to DRAFT; an assessment covering only one element still leaves the others uncovered.
    let s = await w.state(v.versionId);
    await w.run(w.cast.author, (c) => lc.returnToDraft(c, v.versionId, s.version), reason('link the risk assessment'));
    const ra = await w.riskAssessment();
    await w.run(w.cast.author, (c) => lc.linkRiskAssessment(c, v.versionId, ra, ['sealTemp']));
    await w.startVerification(v.versionId);
    await expect(w.submit(v.versionId)).rejects.toThrow(/critical elements .*bulkIssued.* have no linked risk assessment/);
    s = await w.state(v.versionId);
    await w.run(w.cast.author, (c) => lc.returnToDraft(c, v.versionId, s.version), reason('cover the whole master'));
    await w.run(w.cast.author, async (c) => {
      await lc.unlinkRiskAssessment(c, v.versionId, ra);
      await lc.linkRiskAssessment(c, v.versionId, ra);
    });
    await w.startVerification(v.versionId);
    await w.submit(v.versionId);
    expect((await w.state(v.versionId)).state).toBe('SUBMITTED');
  });

  it('[PR-06] a version is submitted only with a linked change record', async () => {
    const v = await inVerification({ changeRecord: false });
    await expect(w.submit(v.versionId)).rejects.toThrow(/change_record_linked: no change record is linked/);
  });

  it('[PR-02] PREPARED is signed by the version author, not by a co-author', async () => {
    const v = await inVerification();
    const coSig = await w.signVersion(w.cast.coAuthor, v.versionId, 'PREPARED', 'IN_VERIFICATION');
    const s = await w.state(v.versionId);
    await expect(w.run(w.cast.coAuthor, (c) => lc.submitVersion(c, v.versionId, s.version, coSig))).rejects.toThrow(/prepared_by_author: PREPARED is signed by the version's author/);
  });

  it('[PR-02][INV-04] a signature applied before its step is refused (CHECKED signed while the version was still in verification)', async () => {
    const v = await inVerification();
    // The e-signature module accepts the CHECKED signature on the content as it stands ...
    const early = await w.signVersion(w.cast.checker, v.versionId, 'CHECKED', 'IN_VERIFICATION');
    await w.submit(v.versionId);
    // ... but the check is a step after the submission: a signature given before it does not count. The
    // signature is bound to the state it was applied in, so the kernel's SIGNATURE hook refuses it first.
    const s = await w.state(v.versionId);
    await expect(w.run(w.cast.checker, (c) => lc.checkVersion(c, v.versionId, s.version, early))).rejects.toThrow(
      /EBMR-PLAT-008 .*was applied while the record was in state IN_VERIFICATION; it cannot authorise a step out of state SUBMITTED/,
    );
    expect((await w.state(v.versionId)).state).toBe('SUBMITTED');
    // The machine's own guard refuses it as well, on the same signature (defence in depth, INV-04).
    expect(await guardOn('signed_in_state', v.versionId, { from: 'SUBMITTED', event: 'CHECK' }, early)).toMatch(
      /the CHECK signature was applied before the version entered SUBMITTED/,
    );
    expect((await w.state(v.versionId)).state).toBe('SUBMITTED');
  });
});

describe('S4: may the checker also approve?', () => {
  it('[INV-04][PR-02] the S4 policy is off by default; switched on, the INV-04 guard allows it but the e-signature catalogue still requires an approver other than the checker', async () => {
    expect((await q<{ r: boolean }>('select recipe.checker_may_approve() as r'))[0]?.r).toBe(false);
    const v = await inVerification();
    await w.submit(v.versionId);
    const checkedSig = await w.check(v.versionId);
    const guard = async () =>
      (await q<{ r: string | null }>(
        "select recipe.guard_approver_independent('mbr_version', $1, '{}'::jsonb, jsonb_build_object('signature_id', $2::text), '{}'::jsonb) as r",
        [v.versionId, checkedSig],
      ))[0]?.r;
    expect(await guard()).toMatch(/unless QA policy S4/);
    await w.run(w.cast.qa, (c) =>
      c.query('select market.define_policy($1::jsonb)', [
        JSON.stringify({ code: 'mbr.checker_may_approve', title: 'S4: the MBR checker may also approve', level: 'TENANT', controls: ['PR-02'], positions: ['ALLOWED', 'NOT_ALLOWED'], defaultPosition: 'NOT_ALLOWED', looseningRequires: 'QA_APPROVAL', reason: 'test' }),
      ]),
    );
    // Switching S4 on is a loosening: its approval is a real POLICY_LOOSENING_APPROVED e-signature of
    // exactly this version (policy, number, position) by a quality-unit person other than its author,
    // w.cast.qa (kernel 0350/0360; EBMR-MKT-073/075). A free approval id is refused.
    const approvalId = await approvePolicyVersion(db, 'mbr.checker_may_approve', 'ALLOWED', w.cast.qa2);
    await w.run(w.cast.qa, (c) =>
      c.query("select market.set_policy_version('mbr.checker_may_approve', 'ALLOWED', null, $1::jsonb)", [JSON.stringify({ approvalId, changeRef: 'CC-S4', reason: 'test' })]),
    );
    expect((await q<{ r: boolean }>('select recipe.checker_may_approve() as r'))[0]?.r).toBe(true);
    expect(await guard()).toBeNull();
    const checkerAsQa = await withSecondRole(db, w.cast.checker, 'QA_MBR_APPROVER');
    await expect(w.signVersion(checkerAsQa, v.versionId, 'APPROVED', 'CHECKED')).rejects.toThrow(/EBMR-ESIG-043/);
    await w.run(w.cast.qa, (c) =>
      c.query("select market.set_policy_version('mbr.checker_may_approve', 'NOT_ALLOWED', null, $1::jsonb)", [JSON.stringify({ changeRef: 'CC-S4-2', reason: 'back to default' })]),
    );
    expect((await q<{ r: boolean }>('select recipe.checker_may_approve() as r'))[0]?.r).toBe(false);
  });
});
