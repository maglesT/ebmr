/**
 * An exception disposition signed end to end through the e-signature routes (module C1 with C3's ENGINE_COMMAND
 * handler; DI-37, PR-49, INV-03). The person who raised the exception, holding a QA role as well, is refused the
 * signature by the kernel (review F13: the INV-03 tag had no refusal behind it). The content preview names the
 * proposal in its intent the way the web ceremony builds it (apps/tablets-web access calls.ts previewIntent: the
 * UTF-8 JSON {outcome, justification} as unpadded base64url, from the action the challenge and the sign request also
 * carry). A justification in Hindi, with
 * accented Latin and a character outside the Basic Multilingual Plane, previews, challenges and signs without
 * EBMR-ESIG-013, and the signature binds exactly the previewed hash.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { esig, identity, withCommand } from '@ebmr/kernel';
import { execution } from '@ebmr/recipe-core';
import { passwordActor } from '@ebmr/test-kit';
import { asPersonaInRole, dcMini, importAndIssue, outcomeOf, personaIn, refusalOf, rowsOf, RunDriver, startExecServer, valueOf, violations, writePackage, type ExecServer } from '../execution/support.ts';

let server: ExecServer;
beforeAll(async () => {
  server = await startExecServer();
  vi.useFakeTimers({ toFake: ['performance'] });
}, 120_000);
afterAll(async () => {
  vi.useRealTimers();
  await server?.close();
});

/** The browser's encoding (TextEncoder and btoa), as the web ceremony's previewIntent does it. */
function browserBase64Url(text: string): string {
  let binary = '';
  for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

describe('an exception disposition through the ceremony routes', () => {
  it('[DI-37][PR-49][INV-03] the raiser, also holding a QA role, is refused the disposition (EBMR-ESIG-044) and nothing is signed; a non-ASCII justification by QA previews, challenges and signs without EBMR-ESIG-013; the signature binds the previewed hash', async () => {
    const issuer = await server.asPersona('issuer');
    const runId = await importAndIssue(server, issuer, writePackage(server, dcMini()));
    const d = new RunDriver(server, runId, { issuer, operator1: await server.asPersona('operator1'), qa1: await server.asPersona('qa1') });
    d.beforeTap = () => vi.advanceTimersByTime(7_000);
    await d.ok('operator1', { type: 'RAISE_EXCEPTION', stepKey: undefined, description: 'Label printer jammed once; label reprinted', severity: 'ALERT' });
    const exception = (await d.runView('qa1')).exceptions[0]?.exceptionId;
    if (!exception) throw new Error('no exception');

    const justification = 'लेबल प्रिंटर एक बार अटका; लेबल दोबारा छापा गया। Café résumé: no impact ✓ 𝛼';
    const json = JSON.stringify({ outcome: 'NO_IMPACT', justification });
    // The browser's bytes are the ones the driver sends (node's base64url of the same UTF-8 JSON).
    expect(browserBase64Url(json)).toBe(Buffer.from(json, 'utf8').toString('base64url'));

    // INV-03: the person who raised an exception never decides it. operator1, also holding QA_SHOP_FLOOR, asks for the
    // same disposition through the same routes and is refused; nothing is signed or recorded.
    const who = personaIn(server, 'operator1');
    const admin = await passwordActor(server.db, server.seed.bootstrap.admin, server.seed.bootstrap.admin.fingerprint, { reasonCode: 'TEST_SETUP', reasonText: 'INV-03 test: the raiser also holds QA_SHOP_FLOOR', correlationId: randomUUID() });
    const grantId = await withCommand(server.db.app, admin, (c) => identity.requestRoleGrant(c, { accountId: who.accountId, roleCode: 'QA_SHOP_FLOOR', scope: {}, reason: 'INV-03 test: the raiser also holds QA_SHOP_FLOOR' }));
    const owner = await passwordActor(server.db, server.seed.bootstrap.owner, server.seed.bootstrap.owner.fingerprint, { reasonCode: 'TEST_SETUP', reasonText: 'INV-03 test: approve the second role', correlationId: randomUUID() });
    await withCommand(server.db.app, owner, (c) => identity.decideRoleGrant(c, grantId, true, 'INV-03 test'));
    const raiser = new RunDriver(server, runId, { operator1: await asPersonaInRole(server, 'operator1', 'QA_SHOP_FLOOR') });
    raiser.beforeTap = d.beforeTap;
    const rows0 = await rowsOf(server, runId);
    const own = await raiser.sign('operator1', { type: 'DISPOSITION_EXCEPTION', exception, outcome: 'NO_IMPACT', justification: 'No impact.' });
    // The kernel refuses the signature itself: the exception's signed content names its raiser as having entered it.
    expect({ stage: own.stage, outcome: outcomeOf(own.result) }).toEqual({ stage: 'sign', outcome: '422:EBMR-ESIG-044' });
    expect(refusalOf(own.result)).toMatchObject({ kind: 'INDEPENDENCE', retryable: false });
    expect(refusalOf(own.result).why).toMatch(/INV-03: EXCEPTION_DISPOSITIONED is never signed by a person who performed, entered data in or corrected the record/);
    expect(await rowsOf(server, runId)).toEqual(rows0);
    const signatures = async () => (await server.db.admin.query<{ n: string }>("select count(*)::text as n from esig.signature where aggregate_id = $1 and meaning_code = 'EXCEPTION_DISPOSITIONED'", [`${runId}:${exception}`])).rows[0]?.n;
    expect(await signatures()).toBe('0');
    expect((await execution.loadState(server.db.admin, runId))?.state.exceptions[exception]?.status).toBe('OPEN');

    const r = await d.sign('qa1', { type: 'DISPOSITION_EXCEPTION', exception, outcome: 'NO_IMPACT', justification });
    if (!r.content.ok) throw new Error(`preview refused: ${JSON.stringify(r.content.error)}`);
    expect(r.content.value.rendering).toMatchObject({ kind: 'batch_exception', disposition: { proposed: { outcome: 'NO_IMPACT', justification, deviationRef: null } } });
    expect(r.challenge?.ok, JSON.stringify(r.challenge && !r.challenge.ok ? r.challenge.error : null)).toBe(true);
    const signed = valueOf(r.result);
    expect(signed.manifestation).toMatchObject({ meaning: 'EXCEPTION_DISPOSITIONED', aggregateType: 'batch_exception', valid: true, contentHash: r.content.value.contentHash, contentVersion: r.content.value.contentVersion });
    const k = await esig.contentForSigning(server.db.admin, 'batch_exception', `${runId}:${exception}`);
    expect(k.contentHash).toBe(r.content.value.contentHash);
    const st = await execution.loadState(server.db.admin, runId);
    expect(st?.state.exceptions[exception]).toMatchObject({ status: 'DISPOSITIONED', disposition: { outcome: 'NO_IMPACT', justification, by: personaIn(server, 'qa1').personId } });
    expect(await signatures()).toBe('1');
    expect(await violations(server)).toEqual([]);
  }, 180_000);
});
