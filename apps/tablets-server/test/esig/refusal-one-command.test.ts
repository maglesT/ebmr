/**
 * K2 (phase-2 open questions; DI-19, DI-37, INV-10, INV-40): a signing refused before esig.sign is ONE command. The
 * handler's dry run runs once; what it records on purpose (its refusal record, plan section 6), the answer stored
 * under the idempotency key and the failure logged with the signer's own authentication for the challenge commit
 * together, in the command that authentication attributes. The kernel recognises that command's use of the event as
 * the attempt's own (kernel 0950), so it still runs every attempted-misuse check on the event and alerts nobody. A
 * resend of a stored refusal is answered from the stored refusal without a new dry run, and logged the same way with
 * its own fresh authentication. A refusal the dry run THROWS is not one it returns: the attempt rolls back with
 * whatever the dry run wrote, and is logged after the rollback with the signer's authentication, which then
 * attributes nothing.
 *
 * The stub handler is wrapped: it counts its dry runs, records each refusal it finds in the audit trail (as the
 * engine records a refused COMMAND row), and, for a record marked as changing, finds another refusal on any later run;
 * for a record marked as throwing, it writes such a record and then throws its refusal (as runContext's not found).
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { esigStubHandler } from '../../src/features/esig/stub.ts';
import { refusal } from '../../src/platform/http/refusal.ts';
import type { TestBrowser, TestServer } from '../support/harness.ts';
import {
  challengeEvents,
  challengeFor,
  correctStub,
  createStub,
  loggedFailures,
  passwordOf,
  personaIn,
  pinOf,
  refusalOf,
  sign,
  signatureRows,
  signingAlerts,
  startSigningServer,
  valueOf,
} from './support.ts';

let sbx: TestServer;
let gmp: TestServer;
/** Dry runs per stub entry. */
const dryRuns = new Map<string, number>();
/** Stub entries whose record changes after the first dry run: a later run finds another refusal. */
const changing = new Set<string>();
/** Stub entries whose dry run writes a refusal record and then throws its refusal. */
const throwing = new Set<string>();

function registerWrappedStub(server: TestServer): void {
  const base = esigStubHandler(server.built.ctx);
  server.built.ctx.signables.register({
    ...base,
    async dryRun(client, ctx, a) {
      const n = (dryRuns.get(a.stubId) ?? 0) + 1;
      dryRuns.set(a.stubId, n);
      if (throwing.has(a.stubId)) {
        await client.query('select kernel.audit_business_event($1, $2, $3::jsonb)', [`test_k2_refusal:${a.stubId}`, 'written before the dry run threw (test)', JSON.stringify({ code: 'EXE_NOT_FOUND' })]);
        throw refusal(404, { code: 'EXE_NOT_FOUND', kind: 'STALE', whatHappened: 'The record to be signed was not found.', why: 'There is no record to be signed with this id on this installation (test).', controls: ['DI-34'] });
      }
      let out = await base.dryRun(client, ctx, a);
      if (!out.accepted && n > 1 && changing.has(a.stubId)) {
        out = { ...out, refusal: { ...out.refusal, code: 'TEST_K2_LATER', why: 'what a later run finds after the record changed (test)' } };
      }
      if (!out.accepted) {
        // The refusal is part of the record, committed on purpose (as the engine's refused COMMAND row).
        await client.query('select kernel.audit_business_event($1, $2, $3::jsonb)', [`test_k2_refusal:${a.stubId}`, `refused before signing: ${out.refusal.code}`, JSON.stringify({ code: out.refusal.code })]);
      }
      return out;
    },
  });
}

beforeAll(async () => {
  [sbx, gmp] = await Promise.all([startSigningServer('SANDBOX', { stub: false }), startSigningServer('GMP', { stub: false })]);
  registerWrappedStub(sbx);
  registerWrappedStub(gmp);
});
afterAll(async () => {
  await Promise.all([sbx?.close(), gmp?.close()]);
});

interface RefusalRecord {
  code: string;
  auth_event: string | null;
  correlation: string;
}

/** The committed refusal records of a stub entry, with the authentication event and command that attributed each. */
async function refusalRecords(server: TestServer, stubId: string): Promise<RefusalRecord[]> {
  const { rows } = await server.db.admin.query<RefusalRecord>(
    `select payload -> 'body' -> 'details' ->> 'code' as code, payload -> 'actor' ->> 'auth_event_id' as auth_event, correlation_id::text as correlation
       from kernel.audit_event where chain_key = $1 order by seq`,
    [`test_k2_refusal:${stubId}`],
  );
  return rows;
}

/** The command an authentication event attributed (its committed COMMAND use). */
async function attributedCommand(server: TestServer, authEventId: string): Promise<string | undefined> {
  const { rows } = await server.db.admin.query<{ c: string }>("select correlation_id::text as c from iam.auth_event_use where auth_event_id = $1 and use_kind = 'COMMAND'", [authEventId]);
  return rows[0]?.c;
}

async function unalertedMisuse(server: TestServer, challengeId: string): Promise<number> {
  const { rows } = await server.db.admin.query("select 1 from esig.invariant_violations() where invariant = 'DI-19' and detail like $1", [`%${challengeId}%`]);
  return rows.length;
}

describe('kiosk: a refusal before signing is one command (K2)', () => {
  let op: TestBrowser;
  let other: TestBrowser;
  beforeAll(async () => {
    op = await sbx.asPersona('operator1');
    other = await sbx.asPersona('verifier2', 'TEST-KIOSK-DISP-1');
  });

  it('[DI-19][INV-10][INV-40] the dry run runs once; its refusal record, the answer and the failure logged with the signer\'s own authentication commit in the one command that authentication attributes; nobody is alerted', async () => {
    const stub = await createStub(sbx, op, 'operator1');
    const ch = valueOf((await challengeFor(sbx, other, 'verifier2', stub, 'VERIFIED')).r);
    const r = refusalOf(await sign(other, ch.challengeId, stub, pinOf(sbx, 'verifier2')));
    expect(r).toMatchObject({ status: 422, code: 'ESIG_STUB_ORDER' });
    expect(dryRuns.get(stub)).toBe(1);
    const [event] = await challengeEvents(sbx, ch.challengeId);
    if (!event) throw new Error('the attempt made no authentication event');
    const command = await attributedCommand(sbx, event);
    expect(await refusalRecords(sbx, stub)).toEqual([{ code: 'ESIG_STUB_ORDER', auth_event: event, correlation: command }]);
    expect(await loggedFailures(sbx, ch.challengeId)).toEqual([
      { code: 'UNKNOWN:ESIG_STUB_ORDER', event, event_person: personaIn(sbx, 'verifier2').personId, for_challenge: true, misuse: null, uses: 'COMMAND' },
    ]);
    expect(await signingAlerts(sbx, ch.challengeId)).toEqual([]);
    expect(await unalertedMisuse(sbx, ch.challengeId)).toBe(0);
    expect(await signatureRows(sbx, stub)).toEqual([]);
  });

  it('[DI-37][DI-19] what the one dry run finds is what is recorded, answered and logged: a record that changes afterwards cannot split them', async () => {
    const stub = await createStub(sbx, op, 'operator1');
    changing.add(stub);
    const ch = valueOf((await challengeFor(sbx, other, 'verifier2', stub, 'VERIFIED')).r);
    expect(refusalOf(await sign(other, ch.challengeId, stub, pinOf(sbx, 'verifier2')))).toMatchObject({ status: 422, code: 'ESIG_STUB_ORDER' });
    expect((await refusalRecords(sbx, stub)).map((x) => x.code)).toEqual(['ESIG_STUB_ORDER']);
    expect((await loggedFailures(sbx, ch.challengeId)).map((f) => f.code)).toEqual(['UNKNOWN:ESIG_STUB_ORDER']);
    expect(dryRuns.get(stub)).toBe(1);
  });

  it('[DI-37][INV-10] a record changed after the challenge: CONTENT_CHANGED in one command, with one dry run, logged with the signer\'s own authentication, which attributes that command', async () => {
    const stub = await createStub(sbx, op, 'operator1');
    const ch = valueOf((await challengeFor(sbx, op, 'operator1', stub, 'PERFORMED')).r);
    await correctStub(sbx, op, 'operator1', stub, '12.532');
    expect(refusalOf(await sign(op, ch.challengeId, stub, pinOf(sbx, 'operator1')))).toMatchObject({ status: 409, code: 'CONTENT_CHANGED' });
    expect(dryRuns.get(stub)).toBe(1);
    const [event] = await challengeEvents(sbx, ch.challengeId);
    expect(await loggedFailures(sbx, ch.challengeId)).toEqual([
      { code: 'UNKNOWN:CONTENT_CHANGED', event, event_person: personaIn(sbx, 'operator1').personId, for_challenge: true, misuse: null, uses: 'COMMAND' },
    ]);
    expect(await signingAlerts(sbx, ch.challengeId)).toEqual([]);
    expect(await signatureRows(sbx, stub)).toEqual([]);
  });

  it('[DI-19][INV-10] a refusal the dry run throws is answered as it is, keeps nothing the dry run wrote, and is logged after the rollback with the signer\'s own authentication, which attributes nothing; nothing is signed and nobody is alerted', async () => {
    const stub = await createStub(sbx, op, 'operator1');
    throwing.add(stub);
    const ch = valueOf((await challengeFor(sbx, other, 'verifier2', stub, 'VERIFIED')).r);
    expect(refusalOf(await sign(other, ch.challengeId, stub, pinOf(sbx, 'verifier2')))).toMatchObject({ status: 404, code: 'EXE_NOT_FOUND', controls: ['DI-34'] });
    expect(dryRuns.get(stub)).toBe(1);
    // The attempt rolled back: the record the dry run wrote before it threw is not kept, and the event has no use.
    expect(await refusalRecords(sbx, stub)).toEqual([]);
    const [event] = await challengeEvents(sbx, ch.challengeId);
    if (!event) throw new Error('the attempt made no authentication event');
    expect(await attributedCommand(sbx, event)).toBeUndefined();
    // Logged all the same, with the refusal's code and the signer's own authentication for this challenge (DI-19).
    expect(await loggedFailures(sbx, ch.challengeId)).toEqual([
      { code: 'UNKNOWN:EXE_NOT_FOUND', event, event_person: personaIn(sbx, 'verifier2').personId, for_challenge: true, misuse: null, uses: '' },
    ]);
    const { rows } = await sbx.db.admin.query<{ message: string }>('select message from esig.signing_failure where challenge_id = $1', [ch.challengeId]);
    expect(rows.map((r) => r.message)).toEqual(['EXE_NOT_FOUND There is no record to be signed with this id on this installation (test).']);
    expect(await signingAlerts(sbx, ch.challengeId)).toEqual([]);
    expect(await unalertedMisuse(sbx, ch.challengeId)).toBe(0);
    expect(await signatureRows(sbx, stub)).toEqual([]);
  });
});

describe('office: a resend of a stored refusal is one command too (K2)', () => {
  it('[DI-19][INV-10] the resend is answered from the stored refusal without a new dry run, and logged with its own fresh authentication, which attributes the resend; nothing is signed and nobody is alerted', async () => {
    const author = await gmp.asPersona('author');
    const approver = await gmp.asPersona('approver');
    const me = personaIn(gmp, 'approver');
    const stub = await createStub(gmp, author, 'author', { kind: 'MASTER_DOCUMENT', title: 'Paracetamol 500 mg MBR section 7', value: 'v1' });
    valueOf(await sign(author, valueOf((await challengeFor(gmp, author, 'author', stub, 'PREPARED')).r).challengeId, stub, passwordOf(gmp, 'author')));
    const ch = valueOf((await challengeFor(gmp, approver, 'approver', stub, 'APPROVED')).r);
    const key = randomUUID();
    const first = refusalOf(await sign(approver, ch.challengeId, stub, passwordOf(gmp, 'approver'), undefined, key));
    expect(first).toMatchObject({ status: 422, code: 'ESIG_STUB_ORDER' });
    expect(refusalOf(await sign(approver, ch.challengeId, stub, passwordOf(gmp, 'approver'), undefined, key))).toEqual(first);
    // PREPARED ran no dry run of its own refusal; the APPROVED attempt ran one, and the resend none.
    expect(dryRuns.get(stub)).toBe(2);
    const events = await challengeEvents(gmp, ch.challengeId);
    expect(events).toHaveLength(2);
    const [firstEvent, resendEvent] = events as [string, string];
    // The refusal was recorded once, by the first attempt's command.
    expect(await refusalRecords(gmp, stub)).toEqual([{ code: 'ESIG_STUB_ORDER', auth_event: firstEvent, correlation: await attributedCommand(gmp, firstEvent) }]);
    // Each attempt is logged with its own authentication, which attributed its own command: no misuse.
    expect(await loggedFailures(gmp, ch.challengeId)).toEqual([
      { code: 'UNKNOWN:ESIG_STUB_ORDER', event: firstEvent, event_person: me.personId, for_challenge: true, misuse: null, uses: 'COMMAND' },
      { code: 'UNKNOWN:ESIG_STUB_ORDER', event: resendEvent, event_person: me.personId, for_challenge: true, misuse: null, uses: 'COMMAND' },
    ]);
    expect(await attributedCommand(gmp, resendEvent)).not.toBe(await attributedCommand(gmp, firstEvent));
    expect(await signingAlerts(gmp, ch.challengeId)).toEqual([]);
    expect(await unalertedMisuse(gmp, ch.challengeId)).toBe(0);
    expect((await signatureRows(gmp, stub)).map((s) => s.meaning_code)).toEqual(['PREPARED']);
  });
});
