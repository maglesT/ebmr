/**
 * An exception disposition signed end to end through the e-signature routes (module C1 with C3's ENGINE_COMMAND
 * handler; DI-37, PR-49, INV-03). The content preview names the proposal in its intent the way the web ceremony
 * builds it (apps/tablets-web access calls.ts previewIntent: the UTF-8 JSON {outcome, justification} as unpadded
 * base64url, from the action the challenge and the sign request also carry). A justification in Hindi, with
 * accented Latin and a character outside the Basic Multilingual Plane, previews, challenges and signs without
 * EBMR-ESIG-013, and the signature binds exactly the previewed hash.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { esig } from '@ebmr/kernel';
import { execution } from '@ebmr/recipe-core';
import { dcMini, importAndIssue, RunDriver, startExecServer, valueOf, violations, writePackage, type ExecServer } from '../execution/support.ts';

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
  it('[DI-37][PR-49][INV-03] a non-ASCII justification previews, challenges and signs without EBMR-ESIG-013; the signature binds the previewed hash', async () => {
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

    const r = await d.sign('qa1', { type: 'DISPOSITION_EXCEPTION', exception, outcome: 'NO_IMPACT', justification });
    if (!r.content.ok) throw new Error(`preview refused: ${JSON.stringify(r.content.error)}`);
    expect(r.content.value.rendering).toMatchObject({ kind: 'batch_exception', disposition: { proposed: { outcome: 'NO_IMPACT', justification, deviationRef: null } } });
    expect(r.challenge?.ok, JSON.stringify(r.challenge && !r.challenge.ok ? r.challenge.error : null)).toBe(true);
    const signed = valueOf(r.result);
    expect(signed.manifestation).toMatchObject({ meaning: 'EXCEPTION_DISPOSITIONED', aggregateType: 'batch_exception', valid: true, contentHash: r.content.value.contentHash, contentVersion: r.content.value.contentVersion });
    const k = await esig.contentForSigning(server.db.admin, 'batch_exception', `${runId}:${exception}`);
    expect(k.contentHash).toBe(r.content.value.contentHash);
    const st = await execution.loadState(server.db.admin, runId);
    expect(st?.state.exceptions[exception]).toMatchObject({ status: 'DISPOSITIONED', disposition: { outcome: 'NO_IMPACT', justification } });
    expect(await violations(server)).toEqual([]);
  }, 180_000);
});
