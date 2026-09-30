/**
 * Review finding P7 (DI-22, DI-23, INV-08): the audit viewer shows only what the chain verification covers, or proves
 * what it shows. A superuser who rewrites stored values behind the audit trail's back (triggers off: the DI-23 catalog
 * test "change an audit row directly in the DB; the verification job alarms and names the entry") must not make the
 * viewer show a forged record, user ID or terminal while "Verify chain" answers intact:
 *  - an entry's table, record, action, chain position, correlation and time are shown from the hashed payload, and
 *    verification names an entry whose indexed columns differ from it;
 *  - the user ID and the terminal code are not in the entry's payload (only the account and terminal ids are): they
 *    are shown from the hashed registry entries (the account's and the terminal's own chains), and verifying a chain
 *    also verifies the registry chains its entries draw on;
 *  - the chain list shows each chain's entry count and last activity from the hashed payload of its last entry, found
 *    through the head's position and hash (which verification checks), never through the head's last_event pointer
 *    (which it does not).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { routes, type AuditEventView } from '@ebmr/api-contract';
import type { TestBrowser, TestServer } from '../support/harness.ts';
import { correctStub, createStub, personaIn, startSigningServer, valueOf } from '../esig/support.ts';

let gmp: TestServer;
let author: TestBrowser;

beforeAll(async () => {
  gmp = await startSigningServer('GMP');
  author = await gmp.asPersona('author');
});
afterAll(async () => {
  await gmp?.close();
});

async function eventsOf(chainKey: string): Promise<AuditEventView[]> {
  return valueOf(await author.call(routes.audit.events, { query: { chainKey, limit: '200' } })).events;
}

const verify = async (chainKey: string) => valueOf(await author.call(routes.audit.verifyChain, { params: { chainKey } }));

/** A superuser change with triggers off (the same technique as viewer.test.ts), one row exactly. */
async function tamper(sql: string, params: unknown[]): Promise<void> {
  const c = await gmp.db.admin.connect();
  try {
    await c.query('begin');
    await c.query('set local session_replication_role = replica');
    const r = await c.query(sql, params);
    expect(r.rowCount).toBe(1);
    await c.query('commit');
  } finally {
    c.release();
  }
}

describe('P7 audit viewer vs chain verification', () => {
  it('[DI-23][INV-08] indexed columns changed directly in the DB: the viewer keeps showing the hashed entry and verifyChain names it', async () => {
    const stub = await createStub(gmp, author, 'author', { kind: 'MASTER_DOCUMENT', title: 'Paracetamol 500 mg, section 5', value: 'granulation v1', unit: '' });
    const other = await createStub(gmp, author, 'author', { kind: 'MASTER_DOCUMENT', title: 'Paracetamol 500 mg, section 6', value: 'blending v1', unit: '' });
    const chainKey = `esig_stub:${stub}`;
    const [created] = await eventsOf(chainKey);
    expect(created).toMatchObject({ seq: '1', action: 'INSERT', table: 'esig.stub_signable', recordId: stub, summary: `Created esig.stub_signable ${stub}` });
    expect((await verify(chainKey)).ok).toBe(true);

    await tamper(
      `update kernel.audit_event set table_name = 'iam.person', record_id = $2, action = 'DELETE', correlation_id = gen_random_uuid(),
              recorded_at = recorded_at - interval '3 days' where id = $1`,
      [created?.eventId, other],
    );
    const { rows } = await gmp.db.admin.query<{ t: string; r: string }>(`select payload ->> 'table' as t, payload ->> 'record_id' as r from kernel.audit_event where id = $1`, [created?.eventId]);
    expect(rows[0]).toEqual({ t: 'esig.stub_signable', r: stub });

    const shown = (await eventsOf(chainKey)).find((e) => e.eventId === created?.eventId);
    expect(shown).toMatchObject({
      chainKey,
      seq: '1',
      action: 'INSERT',
      table: 'esig.stub_signable',
      recordId: stub,
      summary: `Created esig.stub_signable ${stub}`,
      correlationId: created?.correlationId,
      at: created?.at,
    });
    const verdict = await verify(chainKey);
    expect(verdict.ok).toBe(false);
    expect(verdict.problems).toContain('entry 1: indexed columns differ from the hashed payload');
  });

  it('[DI-22][DI-23][INV-08] a user ID or terminal code changed in the registry is not shown: the viewer shows the hashed registry entries', async () => {
    const stub = await createStub(gmp, author, 'author', { kind: 'MASTER_DOCUMENT', title: 'Paracetamol 500 mg, section 7', value: 'drying v1', unit: '' });
    const chainKey = `esig_stub:${stub}`;
    const me = personaIn(gmp, 'author');
    const [created] = await eventsOf(chainKey);
    expect(created).toMatchObject({ who: { personId: me.personId, legalName: 'Asha Rao', loginName: 'asha.rao', role: 'MBR_AUTHOR' }, device: 'PC-DESIGN-01' });

    await tamper(`update iam.account set login_name = 'vikram.shah.x' where login_name = 'asha.rao'`, []);
    await tamper(`update iam.device set code = 'PC-QA-99' where code = 'PC-DESIGN-01'`, []);
    try {
      const shown = (await eventsOf(chainKey)).find((e) => e.eventId === created?.eventId);
      expect({ loginName: shown?.who?.loginName, device: shown?.device }).toEqual({ loginName: 'asha.rao', device: 'PC-DESIGN-01' });
    } finally {
      await tamper(`update iam.account set login_name = 'asha.rao' where login_name = 'vikram.shah.x'`, []);
      await tamper(`update iam.device set code = 'PC-DESIGN-01' where code = 'PC-QA-99'`, []);
    }
  });

  it('[DI-23][INV-08] verifying a chain also verifies the registry entries its view draws on, and names the altered one', async () => {
    const stub = await createStub(gmp, author, 'author', { kind: 'MASTER_DOCUMENT', title: 'Paracetamol 500 mg, section 8', value: 'coating v1', unit: '' });
    const chainKey = `esig_stub:${stub}`;
    expect(await verify(chainKey)).toMatchObject({ ok: true, problems: [] });
    const { rows } = await gmp.db.admin.query<{ id: string; chain_key: string; seq: string }>(
      `select e.id::text as id, e.chain_key, e.seq::text as seq from kernel.audit_event e join iam.account a on e.chain_key = 'account:' || a.id
        where a.login_name = 'asha.rao' and e.table_name = 'iam.account' and e.action = 'INSERT'`,
    );
    const entry = rows[0];
    if (!entry) throw new Error('the account of asha.rao has no audited INSERT');
    const original = (await gmp.db.admin.query<{ p: string }>('select payload::text as p from kernel.audit_event where id = $1', [entry.id])).rows[0]?.p;
    await tamper(`update kernel.audit_event set payload = jsonb_set(payload, '{body,new,login_name}', '"vikram.shah"') where id = $1`, [entry.id]);
    try {
      const verdict = await verify(chainKey);
      expect(verdict.ok).toBe(false);
      expect(verdict.problems).toContain(`${entry.chain_key} entry ${entry.seq}: hash does not match the payload (event altered)`);
      // The chain's own entries are intact, and the count is still this chain's.
      expect(verdict.problems.every((p) => p.startsWith(`${entry.chain_key} `))).toBe(true);
      expect(verdict.events).toBe((await eventsOf(chainKey)).length);
    } finally {
      // The same payload back (jsonb text is canonical, so the stored hash matches again): later tests verify chains of this author.
      await tamper('update kernel.audit_event set payload = $2::jsonb where id = $1', [entry.id, original]);
    }
    expect(await verify(chainKey)).toMatchObject({ ok: true, problems: [] });
  });

  it('[DI-22][DI-23][INV-08] the chain list shows the time and count of a chain\'s last entry from its hashed payload, not from the indexed columns', async () => {
    const stub = await createStub(gmp, author, 'author', { kind: 'MASTER_DOCUMENT', title: 'Paracetamol 500 mg, section 9', value: 'compression v1', unit: '' });
    const chainKey = `esig_stub:${stub}`;
    const listed = async () => valueOf(await author.call(routes.audit.chains, { query: { prefix: chainKey } })).chains.find((c) => c.chainKey === chainKey);
    const before = await listed();
    const entries = await eventsOf(chainKey);
    const last = entries.at(-1);
    expect(before).toMatchObject({ events: entries.length, lastAt: { us: last?.at.us } });

    // The time column of the last entry: the list keeps showing the hashed time, and verification names the entry.
    await tamper(`update kernel.audit_event set recorded_at = recorded_at + interval '400 days' where id = $1`, [last?.eventId]);
    expect(await listed()).toEqual(before);
    expect((await verify(chainKey)).ok).toBe(false);
    // Its position column: the entry is no longer where the verified head says the chain ends, so nothing is shown from
    // it (no time) and the count is the head's own; verification names the chain.
    await tamper(`update kernel.audit_event set seq = seq + 1000 where id = $1`, [last?.eventId]);
    expect(await listed()).toEqual({ ...before, lastAt: null });
    expect((await verify(chainKey)).ok).toBe(false);
  });

  it('[DI-22][DI-23][INV-08] the chain list does not follow the head pointer verification leaves unchecked: moving last_event to an earlier entry changes neither count nor time', async () => {
    const stub = await createStub(gmp, author, 'author', { kind: 'MASTER_DOCUMENT', title: 'Paracetamol 500 mg, section 11', value: 'lubrication v1', unit: '' });
    await correctStub(gmp, author, 'author', stub, 'lubrication v2');
    await correctStub(gmp, author, 'author', stub, 'lubrication v3');
    const chainKey = `esig_stub:${stub}`;
    const listed = async () => valueOf(await author.call(routes.audit.chains, { query: { prefix: chainKey } })).chains.find((c) => c.chainKey === chainKey);
    const entries = await eventsOf(chainKey);
    expect(entries.length).toBeGreaterThanOrEqual(3);
    const before = await listed();
    expect(before).toMatchObject({ events: entries.length, lastAt: { us: entries.at(-1)?.at.us } });

    // Every entry the head could point to instead: the first of this chain, and the last of another chain.
    const other = `esig_stub:${await createStub(gmp, author, 'author', { kind: 'MASTER_DOCUMENT', title: 'Paracetamol 500 mg, section 12', value: 'coating v1', unit: '' })}`;
    for (const target of [entries[0]?.eventId, (await eventsOf(other)).at(-1)?.eventId]) {
      await tamper(`update kernel.audit_chain_head set last_event = $2 where chain_key = $1`, [chainKey, target]);
      // Verification does not check the pointer, so it still answers intact: the list must not depend on it.
      expect(await verify(chainKey)).toMatchObject({ ok: true, problems: [], events: entries.length });
      expect({ target, listed: await listed() }).toEqual({ target, listed: before });
    }
    // The head's hash, which verification does check: the last entry is then no longer the one the head names, so no
    // time is shown from it (the count is the head's own) and verification names the chain.
    await tamper(`update kernel.audit_chain_head set last_hash = sha256(last_hash) where chain_key = $1`, [chainKey]);
    expect(await listed()).toEqual({ ...before, lastAt: null });
    expect((await verify(chainKey)).problems).toContain(`entry ${entries.length}: chain head does not match the last event (events removed or head altered)`);
  });
});
