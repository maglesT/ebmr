/**
 * The database's read rules, rule by rule (SQL mutation group "read-authorisation": tablets 0410 tab.reader_of,
 * tab.role_may; 0420 tab.mbr_content_saved_role; 0440 tab.chain_is_about, tab.entry_withheld; 0530
 * tab.content_for_signing, tab.audit_events, tab.audit_verify_chain). These tests close the gaps the SQL mutation run
 * (tools/sql-mutation) found in the group's own tests (audit/read-authorisation, esig/read-authorisation,
 * audit/view-integrity):
 *   - a cookie token is read for only while its session is ACTIVE and works in a role (EBMR-TAB-018): a session bound
 *     before its role is declared, a locked one and an ended one are each refused, the refusal naming the session's
 *     state ("without a role", "locked", "ended");
 *   - a role never holds one of no permissions (tab.role_may answers false for a NULL list, never NULL or true);
 *   - tab.content_for_signing itself refuses the preview of a record with a meaning the session's role does not sign
 *     (EBMR-TAB-020), whatever the server checked before it, and serves the same record with a meaning the role signs;
 *   - the role an MBR content revision was saved in is that of the revision's own audited INSERT on its version's
 *     chain, and nothing for a revision or a version that is not there;
 *   - what an investigation about the session's person withholds is that investigation's only: the hold another
 *     investigation placed is shown to the person on the chain they read (tab.entry_withheld), and tab.chain_is_about
 *     names only the chains withheld from that person;
 *   - a list of events is bounded as the viewer pages it: from and to are inclusive to the microsecond, "after" an id
 *     excludes it, "up to" an id includes it;
 *   - the verification of a chain the person of an investigation reads, and that is not withheld from them, names its
 *     tamper to them as to a colleague (tab.audit_verify_chain answers nothing only for a withheld chain).
 * Every reader is called with the application role's own credentials (ADR 0012), with the hash of a cookie token bound
 * to a real session as the server binds it (tab.bind_session); the private helpers (tab.role_may, tab.chain_is_about)
 * and what only the owner reads or the superuser does (the audit tables, deleting a chain's head row to tamper with it)
 * are called as the superuser.
 *
 * Controls: DI-16, DI-17, DI-22, DI-23, DI-37, DI-50.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { identity, records, withCommand, type ActorContext } from '@ebmr/kernel';
import { openPersonaSession, passwordActor, terminalOf } from '@ebmr/test-kit';
import { createFamily, startDesignerServer } from '../designer/support.ts';
import { grantedPerson, type GrantedPerson } from '../support/granted-person.ts';
import type { TestServer } from '../support/harness.ts';

let gmp: TestServer;
let lead: GrantedPerson;
let subject: GrantedPerson;
let control: GrantedPerson;
let other: GrantedPerson;
let otherInvestigation = '';

const QA_PC = 'PC-QA-01';
const HEAD_DELETED = 'chain head is missing although the chain has events (head deleted)';
const reason = <T extends ActorContext>(ctx: T): T => ({ ...ctx, reasonCode: 'TEST_SETUP', reasonText: 'read-authorisation mutation test set-up', correlationId: randomUUID() });
const refused = (state: string): string => `Only an active session working in a role granted now can read this; the session is ${state}. [EBMR-TAB-018]`;

/** A session of a created person on the QA office PC, bound to a fresh cookie token's hash as the login binds it. */
async function bound(who: GrantedPerson, role: string | null): Promise<{ hash: string; sessionId: string }> {
  const fp = terminalOf(gmp.seed, QA_PC).fingerprint;
  const ev = await identity.authenticate(gmp.db.authn, { method: 'PASSWORD', identifier: who.loginName, secret: who.password, deviceFingerprint: fp, purpose: 'LOGIN' });
  const s = await identity.openSession(gmp.db.app, ev.authEventId, fp);
  const hash = randomBytes(32).toString('hex');
  await gmp.db.app.query('select tab.bind_session($1, $2, $3)', [s.sessionId, hash, role]);
  return { hash, sessionId: s.sessionId };
}

/** A seeded persona's session on its home terminal, bound in its own role. */
async function personaBound(key: string): Promise<{ hash: string; actor: ActorContext }> {
  const actor = await openPersonaSession(gmp.db, gmp.seed, key);
  const hash = randomBytes(32).toString('hex');
  await gmp.db.app.query('select tab.bind_session($1, $2, $3)', [actor.sessionId, hash, actor.roleCode]);
  return { hash, actor };
}

/** A new demo stub record (RECORD class, chain esig_stub:<id>), entered by the MBR author. */
async function newStub(title: string): Promise<string> {
  const author = await openPersonaSession(gmp.db, gmp.seed, 'author');
  return withCommand(gmp.db.app, reason(author), async (c) =>
    (await c.query<{ id: string }>("insert into esig.stub_signable (kind, title, value, unit) values ('STEP', $1, '4.98', 'g') returning id", [title])).rows[0]?.id ?? '');
}

/** An investigation about `about`, opened and led by the CSV/DI lead. */
async function investigate(about: GrantedPerson, concern: string): Promise<string> {
  const opener = await passwordActor(gmp.db, lead, terminalOf(gmp.seed, QA_PC).fingerprint);
  return withCommand(gmp.db.app, reason(opener), (c) =>
    records.openDiInvestigation(c, { subjectPersonId: about.personId, windowFrom: new Date(Date.UTC(2000, 0, 1)), windowTo: new Date(Date.UTC(2100, 0, 1)), concern }));
}

/** Runs `work` with the head row of `chainKey` deleted by the superuser (the tamper verification names), then puts it back. */
async function withoutHead(chainKey: string, work: () => Promise<void>): Promise<void> {
  const owner = await gmp.db.admin.connect();
  const tamper = async (sqlText: string) => {
    await owner.query('begin');
    await owner.query('set local session_replication_role = replica');
    await owner.query(sqlText, [chainKey]);
    await owner.query('commit');
  };
  await owner.query('create temporary table kept_head as select * from kernel.audit_chain_head where chain_key = $1', [chainKey]);
  try {
    expect((await owner.query('select chain_key from kept_head')).rows).toEqual([{ chain_key: chainKey }]);
    await tamper('delete from kernel.audit_chain_head where chain_key = $1');
    await work();
  } finally {
    await tamper('insert into kernel.audit_chain_head select * from kept_head where chain_key = $1');
    await owner.query('drop table kept_head');
    owner.release();
  }
  expect((await gmp.db.admin.query('select * from kernel.verify_chain($1)', [chainKey])).rows).toEqual([]);
}

beforeAll(async () => {
  gmp = await startDesignerServer({ ruleTables: false });
  lead = await grantedPerson(gmp, 'CSV_DI_LEAD', 'Dev Lead (CSV/DI)');
  subject = await grantedPerson(gmp, 'QA_REVIEWER', 'Anil Kumar (QA reviewer)');
  control = await grantedPerson(gmp, 'QA_REVIEWER', 'Sunita Rao (QA reviewer)');
  other = await grantedPerson(gmp, 'MBR_CHECKER', 'Kiran Patel (MBR checker)');
  // One investigation about the subject, one about another person; the lead opens and leads both.
  await investigate(subject, 'Suspected sharing of a QA reviewer password');
  otherInvestigation = await investigate(other, 'Suspected back-dating of checks');
});
afterAll(async () => {
  await gmp?.close();
});

describe('tab.reader_of (tablets 0410): only an active session working in a role is read for', () => {
  it('[DI-17][DI-16] a session bound before its role is declared is refused "without a role" (EBMR-TAB-018); declared, it reads', async () => {
    const s = await bound(control, null);
    await expect(gmp.db.app.query('select * from tab.audit_chains($1, null, 1)', [s.hash])).rejects.toThrow(refused('without a role'));
    await gmp.db.app.query('select tab.set_session_role($1, $2)', [s.hash, 'QA_REVIEWER']);
    expect((await gmp.db.app.query('select * from tab.audit_chains($1, null, 1)', [s.hash])).rows).toHaveLength(1);
  });

  it('[DI-17][DI-16] a locked session in a role granted now is refused "locked" (EBMR-TAB-018), and reads nothing', async () => {
    const s = await bound(control, 'QA_REVIEWER');
    expect((await gmp.db.app.query('select * from tab.audit_chains($1, null, 1)', [s.hash])).rows).toHaveLength(1);
    await identity.lockSession(gmp.db.app, s.sessionId);
    expect((await gmp.db.app.query<{ r: { state: string; role_code: string } }>('select tab.resolve_session($1) as r', [s.hash])).rows[0]?.r).toMatchObject({ state: 'LOCKED', role_code: 'QA_REVIEWER' });
    await expect(gmp.db.app.query('select * from tab.audit_chains($1, null, 1)', [s.hash])).rejects.toThrow(refused('locked'));
    await expect(gmp.db.app.query('select tab.audit_chain_length($1, $2)', [s.hash, `account:${control.accountId}`])).rejects.toThrow(refused('locked'));
  });

  it('[DI-17][DI-16] an ended session that never declared a role is refused "ended", by its state, not "without a role" (EBMR-TAB-018)', async () => {
    const s = await bound(control, null);
    await identity.endSession(gmp.db.app, s.sessionId);
    expect((await gmp.db.app.query<{ r: { state: string; role_code: string | null } }>('select tab.resolve_session($1) as r', [s.hash])).rows[0]?.r).toMatchObject({ state: 'ENDED', role_code: null });
    await expect(gmp.db.app.query('select * from tab.audit_chains($1, null, 1)', [s.hash])).rejects.toThrow(refused('ended'));
  });
});

describe('tab.role_may (tablets 0410): fail closed', () => {
  it('[DI-17] a role holds one of the permissions named, and never one of no permissions (NULL list): false, not NULL or true', async () => {
    const may = async (role: string, permissions: string[] | null) =>
      (await gmp.db.admin.query<{ m: boolean | null }>('select tab.role_may($1, $2::text[]) as m', [role, permissions])).rows[0]?.m;
    expect(await may('QA_REVIEWER', ['RECORD.READ'])).toBe(true);
    expect(await may('QA_REVIEWER', ['MBR.APPROVE', 'RECORD.AUDIT_TRAIL_REVIEW'])).toBe(true);
    expect(await may('QA_REVIEWER', ['MBR.APPROVE'])).toBe(false);
    expect(await may('QA_REVIEWER', [])).toBe(false);
    expect(await may('QA_REVIEWER', null)).toBe(false);
  });
});

describe('tab.content_for_signing (tablets 0530): the preview is refused by the database itself', () => {
  it('[DI-17][DI-37] a meaning the session\'s role does not sign is refused with EBMR-TAB-020 and the problem, and no content; a meaning it signs is served the kernel\'s content', async () => {
    const stub = await newStub('Granule moisture sample');
    const { hash } = await personaBound('author'); // MBR author on the design office PC (PERSONAL: the session's own role signs)
    await expect(gmp.db.app.query('select tab.content_for_signing($1, $2, $3, $4)', [hash, 'esig_stub', stub, 'APPROVED'])).rejects.toThrow(
      `This session may not read esig_stub ${stub}: the role MBR_AUTHOR may not sign APPROVED (that needs one of MBR.APPROVE). [EBMR-TAB-020]`,
    );
    const served = (await gmp.db.app.query<{ c: Record<string, unknown> }>('select tab.content_for_signing($1, $2, $3, $4) as c', [hash, 'esig_stub', stub, 'PREPARED'])).rows[0]?.c;
    expect(served).toMatchObject({ exists: true, aggregate_type: 'esig_stub', aggregate_id: stub });
    expect(served).toEqual((await gmp.db.admin.query<{ c: unknown }>('select esig.content_for_signing($1, $2) as c', ['esig_stub', stub])).rows[0]?.c);
  });
});

describe('tab.mbr_content_saved_role (tablets 0420): the role of the revision\'s own audited INSERT', () => {
  it('[DI-22][DI-17] the role a content revision was saved in, from its INSERT on its version\'s chain; nothing for a revision or a version that is not there', async () => {
    const author = await gmp.asPersona('author');
    const v = await createFamily(author, { familyCode: 'KILL-RA-DC', product: { code: 'KRA500', name: 'Kill read test tablets', strength: '500 mg' } });
    const content = (await gmp.db.app.query<{ id: string }>('select id::text from recipe.mbr_content where version_id = $1', [v.versionId])).rows;
    expect(content).toHaveLength(1);
    const id = content[0]?.id ?? '';
    // The owner's view: the version's chain carries other entries (the version's own INSERT) before the content's INSERT.
    const chain = (await gmp.db.admin.query<{ t: string; r: string }>(
      "select payload ->> 'table' as t, payload ->> 'record_id' as r from kernel.audit_event where chain_key = $1 order by seq", [`mbr_version:${v.versionId}`],
    )).rows;
    expect(chain.findIndex((e) => e.t === 'recipe.mbr_content' && e.r === id)).toBeGreaterThan(0);
    const role = async (version: string, contentId: string) =>
      (await gmp.db.app.query<{ r: string | null }>('select tab.mbr_content_saved_role($1, $2) as r', [version, contentId])).rows[0]?.r;
    expect(await role(v.versionId, id)).toBe('MBR_AUTHOR');
    expect(await role(v.versionId, randomUUID())).toBeNull();
    expect(await role(randomUUID(), id)).toBeNull();
  });
});

describe('what an investigation about the session\'s person withholds is that investigation\'s only (tablets 0440, 0530)', () => {
  it('[DI-17][DI-50] the hold another investigation placed on its own person\'s account is shown to the subject as to a colleague (tab.entry_withheld); the subject\'s own hold is not', async () => {
    const sub = await bound(subject, 'QA_REVIEWER');
    const col = await bound(control, 'QA_REVIEWER');
    const shown = async (hash: string, chainKey: string) =>
      (await gmp.db.app.query<{ id: string; hold: string | null }>(
        "select id, payload -> 'body' -> 'details' ->> 'hold_id' as hold from tab.audit_events($1, $2, null, null, null, null, null, null, 500)", [hash, chainKey],
      )).rows;
    const owner = async (chainKey: string) =>
      (await gmp.db.admin.query<{ id: string; hold: string | null }>(
        "select id::text, payload -> 'body' -> 'details' ->> 'hold_id' as hold from kernel.audit_event where chain_key = $1 order by id", [chainKey],
      )).rows;
    // The other person's account chain carries the hold the other investigation placed on it.
    const otherHolds = (await gmp.db.admin.query<{ id: string }>('select id::text from records.retention_hold where investigation_id = $1', [otherInvestigation])).rows.map((r) => r.id);
    const otherChain = await owner(`account:${other.accountId}`);
    const placed = otherChain.filter((e) => e.hold !== null);
    expect(placed).toHaveLength(1);
    expect(otherHolds).toContain(placed[0]?.hold);
    expect(await shown(sub.hash, `account:${other.accountId}`)).toEqual(otherChain);
    expect(await shown(col.hash, `account:${other.accountId}`)).toEqual(otherChain);
    // On the subject's own account chain, the hold of the investigation about them is left out for them only.
    const ownChain = await owner(`account:${subject.accountId}`);
    expect(ownChain.filter((e) => e.hold !== null)).toHaveLength(1);
    expect(await shown(sub.hash, `account:${subject.accountId}`)).toEqual(ownChain.filter((e) => e.hold === null));
    expect(await shown(col.hash, `account:${subject.accountId}`)).toEqual(ownChain);
  });

  it('[DI-17][DI-50] tab.chain_is_about names the chains withheld from a person and no other: the subject\'s hold chain and the lead\'s account, not the other person\'s account or the subject\'s own record', async () => {
    const stub = await newStub('Tablet hardness sample');
    const about = async (chainKey: string, person: GrantedPerson) =>
      (await gmp.db.admin.query<{ a: boolean }>('select tab.chain_is_about($1, $2) as a', [chainKey, person.personId])).rows[0]?.a;
    const withheld = (await gmp.db.admin.query<{ c: string[] }>('select (tab.withheld_from($1)).chains as c', [subject.personId])).rows[0]?.c ?? [];
    expect(withheld.length).toBeGreaterThan(1);
    expect(await about(`record_hold:account:${subject.accountId}`, subject)).toBe(true);
    expect(await about(`account:${lead.accountId}`, subject)).toBe(true);
    expect(await about(`account:${other.accountId}`, subject)).toBe(false);
    expect(await about(`account:${subject.accountId}`, subject)).toBe(false);
    expect(await about(`esig_stub:${stub}`, subject)).toBe(false);
    // Nothing is withheld from a colleague.
    expect(await about(`account:${lead.accountId}`, control)).toBe(false);
    expect(await about(`record_hold:account:${subject.accountId}`, control)).toBe(false);
  });

  it('[DI-17][DI-22][DI-23][DI-50] the subject\'s verification of a record chain they read, which is not withheld, names its tamper as the colleague\'s does (tab.audit_verify_chain)', async () => {
    const stub = await newStub('Friability sample');
    const key = `esig_stub:${stub}`;
    const sub = await bound(subject, 'QA_REVIEWER');
    const col = await bound(control, 'QA_REVIEWER');
    const verify = async (hash: string) =>
      (await gmp.db.app.query<{ chain_key: string; registry: boolean; problem: string }>('select chain_key, registry, problem from tab.audit_verify_chain($1, $2)', [hash, key])).rows;
    expect(await verify(sub.hash)).toEqual([]);
    await withoutHead(key, async () => {
      const told = [{ chain_key: key, registry: false, problem: HEAD_DELETED }];
      expect(await verify(col.hash)).toEqual(told);
      expect(await verify(sub.hash)).toEqual(told);
    });
    expect(await verify(sub.hash)).toEqual([]);
  });
});

describe('tab.audit_events (tablets 0530): the bounds of a list of events', () => {
  it('[DI-22][DI-17] from and to are inclusive to the microsecond of an entry, "after" an id excludes that entry, "up to" an id includes it', async () => {
    const stub = await newStub('Disintegration sample');
    const key = `esig_stub:${stub}`;
    const checker = await openPersonaSession(gmp.db, gmp.seed, 'checker');
    for (const message of ['sample label checked', 'sample weight checked']) {
      await withCommand(gmp.db.app, reason(checker), (c) => c.query('select kernel.audit_business_event($1, $2)', [key, message]));
    }
    // The owner's view of the chain: each entry's id and the microsecond it was recorded at.
    const all = (await gmp.db.admin.query<{ id: string; us: string }>(
      "select id::text, (extract(epoch from recorded_at) * 1000000)::bigint::text as us from kernel.audit_event where chain_key = $1 order by id", [key],
    )).rows;
    expect(all.length).toBeGreaterThanOrEqual(3);
    const [first, middle, last] = [all.at(-3), all.at(-2), all.at(-1)].map((e) => e ?? { id: '', us: '' });
    // The last two are separate commands: recorded at distinct instants, after everything before them.
    expect(new Set([first?.us, middle?.us, last?.us]).size).toBe(3);
    const { hash } = await personaBound('checker');
    const ids = async (from: string | null, to: string | null, after: string | null, upTo: string | null) =>
      (await gmp.db.app.query<{ id: string }>('select id from tab.audit_events($1, $2, null, null, $3, $4, $5, $6, 50)', [hash, key, from, to, after, upTo])).rows.map((r) => r.id);
    const upToMiddle = all.slice(0, -1).map((e) => e.id);
    expect(await ids(null, null, null, null)).toEqual(all.map((e) => e.id));
    expect(await ids(middle?.us ?? '', null, null, null)).toEqual([middle?.id, last?.id]);
    expect(await ids(null, middle?.us ?? '', null, null)).toEqual(upToMiddle);
    expect(await ids(middle?.us ?? '', middle?.us ?? '', null, null)).toEqual([middle?.id]);
    expect(await ids(null, null, middle?.id ?? '', null)).toEqual([last?.id]);
    expect(await ids(null, null, null, middle?.id ?? '')).toEqual(upToMiddle);
    expect(await ids(null, null, first?.id ?? '', middle?.id ?? '')).toEqual([middle?.id]);
  });
});

describe('tab.record_read_problem and tab.reader_is_contract_giver as Phase 7 re-creates them (tablets 1426, 1493; D-P7-1 item 4)', () => {
  const reader = (who: { personId: string; accountId: string }, role: string): string =>
    `row(gen_random_uuid(), '${who.personId}'::uuid, '${who.accountId}'::uuid, '${role}', false)::tab.reader`;
  const problem = async (r: string, type: string): Promise<string | null> =>
    (await gmp.db.admin.query<{ p: string | null }>(`select tab.record_read_problem(${r}, $1, $2) as p`, [type, randomUUID()])).rows[0]!.p;

  it('[IN-30][DI-17] an account that holds the contract giver\'s reviewer role reads no record here and counts as the contract giver, whatever role its session works in', async () => {
    const reviewer = await grantedPerson(gmp, 'CONTRACT_GIVER_REVIEWER', 'Contract Giver Reviewer (second role)');
    const asQa = reader(reviewer, 'QA_REVIEWER');
    expect(await problem(asQa, 'esig_stub')).toMatch(/the contract giver's reviewer reads only the batches of its loan licence/);
    expect((await gmp.db.admin.query<{ b: boolean }>(`select tab.reader_is_contract_giver(${asQa}) as b`)).rows[0]!.b).toBe(true);
    // A QA reviewer's account that holds no such role is not the contract giver.
    expect((await gmp.db.admin.query<{ b: boolean }>(`select tab.reader_is_contract_giver(${reader(control, 'QA_REVIEWER')}) as b`)).rows[0]!.b).toBe(false);
  });

  it('[DI-17][DI-37] a compendial rule set and a QP registration are read by a role that signs them and by a governance role, and by no other role (D-P7R-6)', async () => {
    for (const [type, meaning] of [['compendial_rule_set', 'COMPENDIAL_RULE_SET_VERIFIED'], ['qp_register', 'QP_REGISTERED']] as const) {
      const roles = (await gmp.db.admin.query<{ signer: string | null; gov: string | null; neither: string | null }>(
        `with r as (select code, tab.role_may(code, (esig.current_meaning($1)).permissions) as signs, tab.role_may(code, tab.governance_read_permissions()) as gov from iam.role)
         select (select code from r where signs and not gov order by code limit 1) as signer, (select code from r where gov and not signs order by code limit 1) as gov,
                (select code from r where not signs and not gov order by code limit 1) as neither`, [meaning])).rows[0]!;
      // A governance role that does not sign the meaning reads it (the signer roles may all be governance roles too).
      expect(roles.gov && roles.neither).toBeTruthy();
      if (roles.signer) expect(await problem(reader(control, roles.signer), type)).toBeNull();
      expect(await problem(reader(control, roles.gov!), type)).toBeNull();
      expect(await problem(reader(control, roles.neither!), type)).toMatch(new RegExp(`${type} records are read only by the roles that sign them`));
    }
  });
});
