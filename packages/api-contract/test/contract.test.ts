/**
 * The frozen API contract (Phase 2 apps plan section 4): example fixtures parse, the client intents refuse
 * every browser-supplied fact, decimals never travel as numbers, every engine command is classified, and the
 * route table is well formed.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  allRoutes,
  defineRoute,
  storableText,
  unstorableTextIssues,
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
  RUN_VERSION_MAX,
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
      expect(view.run.watermark?.text, name).toBe('TEST, NOT GMP');
      expect(view.run.batchNumber, name).toMatch(/^TEST-/);
      if (block !== 'G-17@1') expect(view.step.block, name).toBe(block);
      expect(view.actions.filter((a) => a.primary).length, name).toBeLessThanOrEqual(1);
    }
    expect(example('run').header.watermark?.source).toBe('SANDBOX_TEST_RUN');
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

  it('[DI-34] the run version a screen sends back is one a run can have: a whole number up to the largest PostgreSQL integer, the type a run\'s version is stored in; the run command and the signed engine command refuse one beyond it as malformed (Phase 2 exit follow-up F58.1)', () => {
    expect(RUN_VERSION_MAX).toBe(2 ** 31 - 1);
    const runId = '6b1f7c1e-2f3a-4b5c-8d9e-0f1a2b3c4d5e';
    const command = (expectedVersion: number) => ({ expectedVersion, intent: { type: 'START_STEP', stepKey: 'p-blend@' } });
    const signed = (expectedVersion: number) => ({ kind: 'ENGINE_COMMAND', runId, expectedVersion, intent: { type: 'SIGN_PERFORMED', stepKey: 'p-blend@' } });
    const body = routes.execution.command.body;
    if (!body) throw new Error('the run command has no body schema');
    for (const v of [0, 7, RUN_VERSION_MAX]) {
      expect(ok(body, command(v)), String(v)).toBe(true);
      expect(ok(SignableAction, signed(v)), String(v)).toBe(true);
    }
    for (const v of [RUN_VERSION_MAX + 1, Number.MAX_SAFE_INTEGER, -1, 1.5]) {
      expect(ok(body, command(v)), String(v)).toBe(false);
      expect(ok(SignableAction, signed(v)), String(v)).toBe(false);
    }
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
    expect(Object.keys(ENGINE_COMMAND_CLASSES)).toHaveLength(23);
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
    expect(fresh.map((r) => r.id).sort()).toEqual(['esig.createChallenge', 'execution.command', 'execution.importPackage', 'execution.issue', 'execution.planBatch']);
    for (const r of fresh) {
      expect(r.auth, r.id).toBe('SESSION');
      expect(r.mutating, r.id).toBe(true);
      expect(r.idempotency, r.id).toBe('REQUIRED');
    }
  });

  it('[DI-05][INV-18] designer routes and the GMP batch plan are GMP only, test packages and test batches sandbox only; running batches, devices and the rest serve both', () => {
    for (const r of Object.values(routes.designer)) expect(r.installation, r.id).toBe('GMP');
    expect(routes.execution.planBatch.installation).toBe('GMP');
    for (const r of [routes.execution.testPackages, routes.execution.importPackage, routes.execution.issueForm, routes.execution.issue]) expect(r.installation, r.id).toBe('SANDBOX');
    const installationBound: readonly string[] = ['execution.planBatch', 'execution.testPackages', 'execution.importPackage', 'execution.issueForm', 'execution.issue'];
    for (const r of Object.values(routes.execution).filter((x) => !installationBound.includes(x.id))) expect(r.installation, r.id).toBe('ANY');
    for (const r of [...Object.values(routes.devices), ...Object.values(routes.meta), ...Object.values(routes.session), ...Object.values(routes.access), ...Object.values(routes.esig), ...Object.values(routes.audit)]) {
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

describe('text a record can hold (review F30-F33)', () => {
  const issues = (schema: z.ZodType, value: unknown) => {
    const r = schema.safeParse(value);
    return r.success ? [] : r.error.issues.map((i) => ({ path: i.path, message: i.message }));
  };

  it('[DI-37] every string and member name holding U+0000 or a lone surrogate is found, with its path, at any depth; text a record can hold is not', () => {
    expect(unstorableTextIssues({ a: 'ok', b: ['x', { c: 'Booth\u0000' }], ['k\u0000']: 1, d: 'Line stop \uDBFF', e: '\uDC00', f: ['\uD83D\uDE00', 'e\u0301 \uFFFD \u0001'] })).toEqual([
      { path: [], message: 'has a member name holding U+0000, which no record can hold' },
      { path: ['b', 1, 'c'], message: 'holds U+0000, which no record can hold: enter the text again without it' },
      { path: ['d'], message: 'holds an unpaired surrogate U+DBFF, which no record can hold: enter the text again without it' },
      { path: ['e'], message: 'holds an unpaired surrogate U+DC00, which no record can hold: enter the text again without it' },
    ]);
    expect(unstorableTextIssues('\u0000')).toEqual([{ path: [], message: 'holds U+0000, which no record can hold: enter the text again without it' }]);
    expect(unstorableTextIssues({ n: 1, b: true, z: null, t: 'मिश्रण 😀 \u{10FFFF}' })).toEqual([]);
    // At most `limit` places are named; the walk has no recursion, so no nesting overflows the stack.
    expect(unstorableTextIssues(Array.from({ length: 50 }, () => '\u0000'))).toHaveLength(10);
    let deep: unknown = 'x\u0000';
    for (let i = 0; i < 100_000; i += 1) deep = [deep];
    const [far] = unstorableTextIssues(deep);
    expect(far?.path).toHaveLength(100_000);
  });

  it('[DI-37][DI-34] defineRoute refuses such text in the params, query and body of every route, naming the place; a route\'s own schema is unchanged otherwise', () => {
    const route = defineRoute({
      id: 'test.anything',
      method: 'POST',
      path: '/api/test/:key',
      installation: 'ANY',
      auth: 'SESSION',
      mutating: true,
      summary: 'a route that takes anything',
      params: z.strictObject({ key: z.string() }),
      query: z.looseObject({}),
      body: z.looseObject({}),
      response: z.unknown(),
    });
    expect(issues(route.params, { key: 'a\u0000' })).toEqual([{ path: ['key'], message: 'holds U+0000, which no record can hold: enter the text again without it' }]);
    expect(issues(route.query, { q: 'x\uD800' })).toEqual([{ path: ['q'], message: 'holds an unpaired surrogate U+D800, which no record can hold: enter the text again without it' }]);
    expect(issues(route.body ?? z.never(), { content: { steps: [{ name: 'Booth\u0000' }] } })).toEqual([{ path: ['content', 'steps', 0, 'name'], message: 'holds U+0000, which no record can hold: enter the text again without it' }]);
    expect(issues(route.body ?? z.never(), { content: { steps: [{ name: 'Booth 😀' }] } })).toEqual([]);
    // storableText keeps the schema's own type and rules.
    const s = storableText(z.strictObject({ a: z.string().min(2) }));
    expect(s).toBeInstanceOf(z.ZodObject);
    expect(issues(s, { a: 'x' })[0]?.path).toEqual(['a']);
  });

  it('[DI-37][DI-34][PR-49][DI-04] the real routes refuse it: a plain intent, a signed decision in a challenge, MBR content and a note, an audit chain key and prefix', () => {
    const intent = { type: 'RAISE_EXCEPTION', description: 'Booth door\u0000 found open', severity: 'ALERT' };
    expect(issues(routes.execution.command.body ?? z.never(), { expectedVersion: 1, intent })).toEqual([
      { path: ['intent', 'description'], message: 'holds U+0000, which no record can hold: enter the text again without it' },
    ]);
    const challenge = {
      aggregateType: 'batch_exception',
      aggregateId: 'x',
      contentVersion: '1',
      meaning: 'EXCEPTION_DISPOSITIONED',
      clientContentHash: 'a'.repeat(64),
      action: { kind: 'ENGINE_COMMAND', runId: '00000000-0000-4000-8000-000000000000', expectedVersion: 1, intent: { type: 'DISPOSITION_EXCEPTION', exception: 'E-1', outcome: 'NO_IMPACT', justification: 'Reprinted \udfff' } },
    };
    expect(issues(routes.esig.createChallenge.body ?? z.never(), challenge).map((i) => i.path.join('/'))).toContain('action/intent/justification');
    const save = { baseRevision: 1, content: { format: 'x', formatVersion: 1, procedure: { name: 'Booth\u0000' } }, note: 'Renamed\uD800' };
    expect(issues(routes.designer.saveContent.body ?? z.never(), save).map((i) => i.path.join('/'))).toEqual(['content/procedure/name', 'note']);
    expect(issues(routes.audit.verifyChain.params, { chainKey: 'mbr_version:\u0000' }).map((i) => i.path.join('/'))).toEqual(['chainKey']);
    expect(issues(routes.audit.chains.query, { prefix: '\u0000' }).map((i) => i.path.join('/'))).toEqual(['prefix']);
  });
});
