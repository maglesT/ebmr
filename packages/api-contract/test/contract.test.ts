/**
 * The frozen API contract (Phase 2 apps plan section 4): example fixtures parse, the client intents refuse
 * every browser-supplied fact, decimals never travel as numbers, every engine command is classified, and the
 * route table is well formed.
 */
import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import {
  allRoutes,
  CLIENT_PLAIN_TYPES,
  CLIENT_SIGNED_TYPES,
  ClientEntry,
  ClientIntent,
  DataValueWire,
  DecimalString,
  ENGINE_COMMAND_CLASSES,
  ENGINE_ROLE_MAP,
  NAMESPACE_OWNERS,
  RefusalEnvelope,
  routes,
  SignableAction,
  SignedIntent,
  StepScreenView,
  type ContractProofs,
} from '../src/index.ts';
import { EXAMPLES, STEP_EXAMPLES_BY_BLOCK, example } from '../src/examples.ts';

const ok = (schema: z.ZodType, value: unknown): boolean => schema.safeParse(value).success;

describe('example fixtures', () => {
  it('every example parses with its schema, and route examples match their route response', () => {
    for (const [name, e] of Object.entries(EXAMPLES)) {
      const parsed = e.schema.safeParse(e.data);
      expect(parsed.success, `${name}: ${parsed.success ? '' : JSON.stringify(parsed.error.issues.slice(0, 3))}`).toBe(true);
      if ('routeId' in e && e.routeId) {
        const route = allRoutes(routes).find((r) => r.id === e.routeId);
        expect(route, name).toBeDefined();
      }
    }
  });

  it('[DI-05] one step-screen example per block of the dc-mini template, each watermarked TEST, NOT GMP', () => {
    expect(Object.keys(STEP_EXAMPLES_BY_BLOCK).sort()).toEqual(['G-03@1', 'G-04@1', 'G-07@1', 'G-08@1', 'G-09@1', 'G-10@1', 'G-17@1', 'G-20@1', 'G-22@1']);
    for (const [block, name] of Object.entries(STEP_EXAMPLES_BY_BLOCK)) {
      const view = StepScreenView.parse(EXAMPLES[name].data);
      expect(view.run.watermark.text, name).toBe('TEST, NOT GMP');
      expect(view.run.batchNumber, name).toMatch(/^TEST-/);
      if (block !== 'G-17@1') expect(view.step.block, name).toBe(block);
      expect(view.actions.filter((a) => a.primary).length, name).toBeLessThanOrEqual(1);
    }
    expect(example('run').header.watermark.source).toBe('SANDBOX_TEST_RUN');
  });
});

describe('client intents refuse browser-supplied facts (J1-3, J2-8)', () => {
  const base = { type: 'RECORD_DATA', stepKey: 'p-blend@', item: 'blendTime', value: { kind: 'DECIMAL', value: '15', unit: 'min' } };

  it('[DI-32] a value source is MANUAL or SCAN; DEVICE, AUTOMATION, LIMS and BLOCK are server-set', () => {
    expect(ok(ClientIntent, { ...base, source: { mode: 'MANUAL' } })).toBe(true);
    expect(ok(ClientIntent, { ...base, source: { mode: 'SCAN', code: 'X-1' } })).toBe(true);
    for (const source of [
      { mode: 'DEVICE', device: 'TEST-BAL-01', raw: 'S S 15 kg' },
      { mode: 'AUTOMATION', system: 'PLC-1' },
      { mode: 'LIMS', resultRef: 'LIMS-1' },
      { mode: 'BLOCK', entries: ['E-1'] },
      { mode: 'MANUAL', device: 'TEST-BAL-01' },
    ]) {
      expect(ok(ClientIntent, { ...base, source }), JSON.stringify(source)).toBe(false);
    }
  });

  it('[DI-32][INV-26] no actor, roles, signature, command id or occurredAt trust can be sent', () => {
    const intent = { ...base, source: { mode: 'MANUAL' } };
    for (const extra of [
      { actor: { id: 'x', kind: 'PERSON', roles: ['QA'] } },
      { roles: ['QA'] },
      { signature: { id: 's', meaning: 'PERFORMED', signer: 'x' } },
      { commandId: 'c-1' },
      { occurredAt: { us: '1', trust: 'DEVICE_SYNCED' } },
      { expectedVersion: 1 },
    ]) {
      expect(ok(ClientIntent, { ...intent, ...extra }), JSON.stringify(extra)).toBe(false);
    }
    // Signature-bearing intents are not plain commands.
    expect(ok(ClientIntent, { type: 'SIGN_PERFORMED', stepKey: 'p-blend@' })).toBe(false);
    expect(ok(ClientIntent, { type: 'VERIFY', stepKey: 'p-blend@', meaning: 'VERIFIED' })).toBe(false);
    expect(ok(SignedIntent, { type: 'VERIFY', stepKey: 'p-blend@', meaning: 'VERIFIED', signature: { id: 's' } })).toBe(false);
  });

  it('[DI-32][PR-19] lots travel as codes and weights as reading ids: lot status, expiry, identity, balance and device values are refused', () => {
    const weighing = { kind: 'CONTAINER_WEIGHING', item: 'dispApi', bomLine: 'BOM-PCM', lotCode: 'TEST-L26-0101', tareReadingId: '6b1f7c1e-2f3a-4b5c-8d9e-0f1a2b3c4d5e', grossReadingId: '7c2a8d2f-3a4b-4c5d-9e0f-1a2b3c4d5e6f' };
    expect(ok(ClientEntry, weighing)).toBe(true);
    expect(ok(ClientEntry, { ...weighing, tareReadingId: undefined, grossReadingId: undefined, manual: { tare: '1.250', gross: '13.753', unit: 'kg' } })).toBe(true);
    for (const extra of [
      { lot: { id: 'TEST-L26-0101', material: 'MAT-PCM', status: 'RELEASED', identityTested: true } },
      { lotStatus: 'RELEASED' },
      { expiry: '2027-01-01' },
      { identityTested: true },
      { balance: 'TEST-BAL-01' },
      { gross: '13.753' },
      { source: 'DEVICE' },
      { raw: 'S S 13.753 kg' },
    ]) {
      expect(ok(ClientEntry, { ...weighing, ...extra }), JSON.stringify(extra)).toBe(false);
    }
    expect(ok(ClientEntry, { ...weighing, tareReadingId: 'not-a-uuid' })).toBe(false);
    expect(ok(ClientEntry, { kind: 'CHARGE_CONTAINER', containerCode: 'TEST-B26-0001/C-1', scannedBatch: 'TEST-B26-0001' })).toBe(false);
    expect(ok(ClientEntry, { kind: 'CHARGE_LOT', bomLine: 'BOM-PCM', container: 'C', lot: { id: 'L' } })).toBe(false);
  });

  it('[DI-20][DI-30][PR-20] weights keyed by hand may name the balance read, and nothing else about it (review P50)', () => {
    // The server and the database check that the balance named is a scale of the step's room and that none of them is
    // online; its status, the source or the balance as the record states it are never taken from the browser.
    const manual = { tare: '1.250', gross: '13.753', unit: 'kg' };
    const handKeyed = { kind: 'CONTAINER_WEIGHING', item: 'dispApi', bomLine: 'BOM-PCM', lotCode: 'TEST-L26-0101' };
    expect(ok(ClientEntry, { ...handKeyed, manual })).toBe(true);
    expect(ok(ClientEntry, { ...handKeyed, manual: { ...manual, deviceCode: 'TEST-BAL-00' } })).toBe(true);
    expect(ok(ClientEntry, { kind: 'OUTPUT_CONTAINER', intermediate: 'I-BLEND', manual: { ...manual, deviceCode: 'TEST-BAL-02' } })).toBe(true);
    for (const extra of [{ deviceCode: '' }, { deviceCode: 'X'.repeat(65) }, { status: 'OFFLINE' }, { balance: 'MANUAL' }, { source: 'MANUAL' }]) {
      expect(ok(ClientEntry, { ...handKeyed, manual: { ...manual, ...extra } }), JSON.stringify(extra)).toBe(false);
    }
  });

  it('the signable actions carry only the intent and the reviewed version', () => {
    const action = { kind: 'ENGINE_COMMAND', runId: '6b1f7c1e-2f3a-4b5c-8d9e-0f1a2b3c4d5e', expectedVersion: 7, intent: { type: 'SIGN_PERFORMED', stepKey: 'p-blend@' } };
    expect(ok(SignableAction, action)).toBe(true);
    expect(ok(SignableAction, { ...action, actor: { id: 'x' } })).toBe(false);
    expect(ok(SignableAction, { ...action, intent: { type: 'START_STEP', stepKey: 'p-blend@' } })).toBe(false);
  });
});

describe('decimals travel as text (wire rules)', () => {
  it('DecimalString refuses JSON numbers, exponents and malformed text', () => {
    for (const good of ['0', '12.503', '-0.5', '100', '0.000', '-12']) expect(ok(DecimalString, good), good).toBe(true);
    for (const bad of [12.503, 12, '1e3', '1E-3', '1.2e+3', '.5', '5.', '01', '+1', '1,000', ' 1', 'NaN', 'Infinity', '', '0x1f']) {
      expect(ok(DecimalString, bad), String(bad)).toBe(false);
    }
    expect(ok(DataValueWire, { kind: 'DECIMAL', value: 12.5, unit: 'kg' })).toBe(false);
    expect(ok(DataValueWire, { kind: 'SERIES', values: ['1.0', 2], unit: 'mg' })).toBe(false);
    expect(ok(DataValueWire, { kind: 'COUNT', value: 3 })).toBe(false);
  });
});

describe('engine commands are classified exhaustively', () => {
  it('every engine command type is CLIENT_PLAIN, CLIENT_SIGNED, SERVER_ONLY or LATER, and the intents match their classes', () => {
    // The real proof is at compile time (ContractProofs, and `satisfies Record<engine.CommandType, ...>`).
    const proofs: ContractProofs = [true, true, true];
    expect(proofs).toEqual([true, true, true]);
    const plain = ClientIntent.options.map((o) => o.shape.type.value).sort();
    const signed = SignedIntent.options.map((o) => o.shape.type.value).sort();
    expect(plain).toEqual([...CLIENT_PLAIN_TYPES].sort());
    expect(signed).toEqual([...CLIENT_SIGNED_TYPES].sort());
    expect(Object.keys(ENGINE_COMMAND_CLASSES)).toHaveLength(21);
  });
});

describe('route table', () => {
  const all = allRoutes(routes);

  it('route ids are unique and prefixed with their namespace; method and path are unique', () => {
    expect(new Set(all.map((r) => r.id)).size).toBe(all.length);
    for (const [ns, table] of Object.entries(routes)) {
      for (const [name, route] of Object.entries(table) as [string, { id: string }][]) expect(route.id, `${ns}.${name}`).toBe(`${ns}.${name}`);
    }
    expect(new Set(all.map((r) => `${r.method} ${r.path}`)).size).toBe(all.length);
    expect(Object.keys(NAMESPACE_OWNERS).sort()).toEqual(Object.keys(routes).sort());
  });

  it('[INV-40] every FRESH_ON_SHARED route is a mutating SESSION route whose body carries the attribution member', () => {
    const fresh = all.filter((r) => r.attribution === 'FRESH_ON_SHARED');
    expect(fresh.map((r) => r.id).sort()).toEqual(['esig.createChallenge', 'execution.command', 'execution.importPackage', 'execution.issue']);
    for (const r of fresh) {
      expect(r.auth, r.id).toBe('SESSION');
      expect(r.mutating, r.id).toBe(true);
      expect(r.idempotency, r.id).toBe('REQUIRED');
    }
  });

  it('[DI-05] designer routes are GMP only, execution and device routes sandbox only, the rest serve both', () => {
    for (const r of Object.values(routes.designer)) expect(r.installation, r.id).toBe('GMP');
    for (const r of [...Object.values(routes.execution), ...Object.values(routes.devices)]) expect(r.installation, r.id).toBe('SANDBOX');
    for (const r of [...Object.values(routes.meta), ...Object.values(routes.session), ...Object.values(routes.access), ...Object.values(routes.esig), ...Object.values(routes.audit)]) {
      expect(r.installation, r.id).toBe('ANY');
    }
  });

  it('[DI-22] the audit namespace is read-only (no edit, disable or purge route)', () => {
    for (const r of Object.values(routes.audit)) {
      expect(r.method, r.id).toBe('GET');
      expect(r.mutating, r.id).toBe(false);
    }
  });

  it('the refusal envelope has the plain-language parts', () => {
    const envelope = {
      refusal: { code: 'EBMR-IAM-140', kind: 'AUTH_FAILED', whatHappened: 'Sign-in failed.', why: 'The user ID or password is wrong.', controls: ['DI-19'], whatYouCanDo: ['Try again.'], whoCanHelp: ['Your supervisor'] },
      correlationId: 'c-1',
      retryable: true,
    };
    expect(ok(RefusalEnvelope, envelope)).toBe(true);
    expect(ok(RefusalEnvelope, { ...envelope, refusal: { ...envelope.refusal, kind: 'OOPS' } })).toBe(false);
  });

  it('[INV-26] the role map mirror names each shop-floor kernel role once', () => {
    expect(new Set(ENGINE_ROLE_MAP.map((m) => m.kernelRole)).size).toBe(ENGINE_ROLE_MAP.length);
    expect(ENGINE_ROLE_MAP.find((m) => m.kernelRole === 'QA_SHOP_FLOOR')).toMatchObject({ engineRole: 'QA', viaPermission: 'QA.FLOOR_APPROVE' });
  });
});
