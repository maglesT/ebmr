/**
 * Review reproducer F79: site-scoped qualification requirements fail open when the authority request
 * carries no site.
 *
 * iam.evaluate_authority (packages/kernel/sql/0130_iam_qualifications_authority.sql, line 238; the only
 * definition) applies a qualification requirement only when
 *   iam.scope_covers(q.scope_site, q.scope_area, q.scope_product, v_scope)
 * holds. scope_covers (0100 line 108) is false when the requirement names a site and the request does
 * not. For grants that is fail-closed (no grant, no authority); for requirements it is fail-open (the
 * requirement is silently skipped, so the training gate does not block). esig.sign (0230 line 425)
 * evaluates in the provider's scope, which is '{}' whenever the provider returns no site.
 *
 * INV-26 / DI-21 / IN-04: every signer held the required qualification at that instant; a lapse is a
 * hard block naming the missing item; the training gate is never relaxed (every site is India-licensed).
 *
 * Setup (all through the product's own functions, as ebmr_app inside kernel.begin_command):
 *   - TRAINING_COORDINATOR creates qualification type SOP-VERIFY-xxxx and a requirement on permission
 *     STEP.VERIFY limited to site SITE-1 (the installation's site; every seeded terminal is registered there).
 *   - A VERIFIER with an installation-wide grant, whose terminal is at SITE-1, never receives that
 *     qualification.
 *
 * Positive controls (prove the requirement is live and the verifier lacks it):
 *   - evaluate_authority(verifier, 'STEP.VERIFY', {"site":"SITE-1"}, role VERIFIER) -> refused,
 *     MISSING_QUALIFICATION:<code>;
 *   - VERIFIED on a stub entry carrying site SITE-1 -> EBMR-ESIG-040 MISSING_QUALIFICATION.
 *
 * Safe behaviour asserted (fails with the defect):
 *   1. evaluate_authority(verifier, 'STEP.VERIFY', '{}', role VERIFIER) is also refused with
 *      MISSING_QUALIFICATION:<code> (with the defect: allowed = true, reasons = []).
 *   2. The same verifier, at the same SITE-1 terminal, signing VERIFIED on a stub entry whose provider
 *      returns no site is refused with EBMR-ESIG-040 MISSING_QUALIFICATION, and no VERIFIED signature is
 *      stored (with the defect: the signature is applied and stored).
 */
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withCommand } from '../../src/db/command.ts';
import { evaluateAuthority } from '../../src/identity/authority.ts';
import { createStub, ensureSealKey, run, signStub } from '../esig/helpers.ts';
import { SEED_SITE, seedActor, withReason, type SeededActor } from '../identity/seed.ts';
import { createTestDatabase, type TestDatabase } from '../support/db.ts';

let db: TestDatabase;
let tc: SeededActor;
let op: SeededActor;
let verifier: SeededActor;
let code: string;

type Outcome = { ok: true; value: unknown } | { ok: false; message: string };

const settle = async (p: Promise<unknown>): Promise<Outcome> =>
  p.then(
    (value) => ({ ok: true as const, value }),
    (e: unknown) => ({ ok: false as const, message: e instanceof Error ? e.message : String(e) }),
  );

beforeAll(async () => {
  db = await createTestDatabase();
  await ensureSealKey(db);
  tc = await seedActor(db, { roleCode: 'TRAINING_COORDINATOR', acknowledgeEsig: false });
  op = await seedActor(db, { roleCode: 'OPERATOR', legalName: 'F79 Operator' });
  // Installation-wide VERIFIER grant (scope {}), terminal registered at SITE-1; no qualification recorded.
  verifier = await seedActor(db, { roleCode: 'VERIFIER', legalName: 'F79 Unqualified Verifier' });

  code = `SOP-VERIFY-${randomBytes(2).toString('hex').toUpperCase()}`;
  await withCommand(db.app, withReason(tc), async (c) => {
    await c.query("select iam.create_qualification_type($1, 'Verification SOP', 'current version of the SITE-1 verification SOP')", [code]);
    await c.query("select iam.add_qualification_requirement($1, null, 'STEP.VERIFY', $2::jsonb, 'site SOP')", [
      code,
      JSON.stringify({ site: SEED_SITE }),
    ]);
  });
});

afterAll(async () => {
  await db.drop();
});

async function stubEntry(site: string | null): Promise<string> {
  if (site === null) return createStub(db, op);
  return run(db, op, async (c) => {
    const { rows } = await c.query<{ id: string }>(
      "insert into esig.stub_signable (kind, title, value, unit, site) values ('STEP', 'Granulation: binder added', '12.503', 'kg', $1) returning id",
      [site],
    );
    return rows[0]?.id ?? '';
  });
}

async function verifiedCount(id: string): Promise<number> {
  const { rows } = await db.admin.query<{ n: string }>(
    "select count(*)::text as n from esig.signature where aggregate_ref = $1 and meaning_code = 'VERIFIED'",
    [`esig_stub:${id}`],
  );
  return Number(rows[0]?.n ?? '0');
}

describe('F79: site-scoped qualification requirements are skipped when the request has no site (INV-26, DI-21, IN-04)', () => {
  it('sanity: the requirement is live, the verifier is unqualified, holds an installation-wide grant and works at a SITE-1 terminal', async () => {
    const req = await db.admin.query<{ permission_code: string; scope_site: string | null }>(
      'select permission_code, scope_site from iam.qualification_requirement where qualification_code = $1 and effective_to is null',
      [code],
    );
    expect(req.rows).toEqual([{ permission_code: 'STEP.VERIFY', scope_site: SEED_SITE }]);
    const pq = await db.admin.query('select 1 from iam.person_qualification where person_id = $1 and qualification_code = $2', [verifier.personId, code]);
    expect(pq.rows).toHaveLength(0);
    const g = await db.admin.query<{ role_code: string; scope_site: string | null }>('select role_code, scope_site from iam.role_grant where id = $1', [
      verifier.seed.grantId,
    ]);
    expect(g.rows).toEqual([{ role_code: 'VERIFIER', scope_site: null }]);
    const dev = await db.admin.query<{ site_code: string }>('select site_code from iam.device where id = $1', [verifier.deviceId]);
    expect(dev.rows).toEqual([{ site_code: SEED_SITE }]);
  });

  it('[INV-26][DI-21] iam.evaluate_authority: an installation-wide request does not skip the SITE-1 training requirement', async () => {
    // Positive control: in scope SITE-1 the requirement applies and the verifier is refused.
    const atSite = await evaluateAuthority(db.app, {
      personId: verifier.personId, accountId: verifier.accountId, permission: 'STEP.VERIFY', scope: { site: SEED_SITE }, roleCode: 'VERIFIER',
    });
    expect(atSite).toMatchObject({ allowed: false, reasons: [`MISSING_QUALIFICATION:${code}`] });

    // Same person, same permission, same role, no site in the request.
    const noSite = await evaluateAuthority(db.app, {
      personId: verifier.personId, accountId: verifier.accountId, permission: 'STEP.VERIFY', scope: {}, roleCode: 'VERIFIER',
    });
    expect(
      noSite,
      `unqualified VERIFIER evaluated in scope {} for STEP.VERIFY: ${JSON.stringify(noSite)} ` +
        `(in scope {"site":"${SEED_SITE}"} the same evaluation was ${JSON.stringify(atSite)})`,
    ).toMatchObject({ allowed: false, reasons: [`MISSING_QUALIFICATION:${code}`] });
  });

  it('[INV-26][IN-04] esig.sign: an unqualified verifier cannot sign VERIFIED on an entry whose provider returns no site', async () => {
    // Positive control: the entry carries site SITE-1, the provider returns scope {"site":"SITE-1"} and the
    // training gate refuses the unqualified verifier.
    const sited = await stubEntry(SEED_SITE);
    await signStub(db, op, sited, { meaning: 'PERFORMED' });
    const control = await settle(signStub(db, verifier, sited, { meaning: 'VERIFIED' }));
    expect(control.ok).toBe(false);
    expect(control.ok ? '' : control.message).toMatch(/EBMR-ESIG-040/);
    expect(control.ok ? '' : control.message).toContain(`MISSING_QUALIFICATION:${code}`);
    expect(await verifiedCount(sited)).toBe(0);

    // The same step without a site on the entry (provider scope {}), signed at the same SITE-1 terminal.
    const unsited = await stubEntry(null);
    await signStub(db, op, unsited, { meaning: 'PERFORMED' });
    const outcome = await settle(signStub(db, verifier, unsited, { meaning: 'VERIFIED' }));
    const stored = await verifiedCount(unsited);
    const evals = await db.admin.query<{ scope: object; allowed: boolean; reasons: string[] }>(
      `select e.scope, e.allowed, e.reasons from esig.signature s join iam.authority_evaluation e on e.id = s.authority_evaluation_id
        where s.aggregate_ref = $1 and s.meaning_code = 'VERIFIED'`,
      [`esig_stub:${unsited}`],
    );

    expect(
      outcome,
      `unqualified VERIFIER signed VERIFIED on esig_stub:${unsited} from a ${SEED_SITE} terminal: ${JSON.stringify(outcome)}; ` +
        `stored VERIFIED signatures: ${stored}; authority evaluation used: ${JSON.stringify(evals.rows)}`,
    ).toMatchObject({ ok: false });
    expect(outcome.ok ? '' : outcome.message).toMatch(/EBMR-ESIG-040/);
    expect(outcome.ok ? '' : outcome.message).toContain(`MISSING_QUALIFICATION:${code}`);
    expect(stored).toBe(0);
  });
});
