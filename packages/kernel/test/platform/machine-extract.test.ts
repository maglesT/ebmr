/**
 * The extractor (src/state/extract.ts) turns an XState machine into the transition table the
 * database publishes, or refuses it with a MachineDefinitionError that names the problem. Each
 * refusal below uses a machine that is valid in every other respect, so the named check is the
 * only one that can refuse it. The canonical text and hash are compared with fixed expected values
 * (the same form platform.machine_canonical_text builds in SQL; machine-consistency.test.ts checks
 * the published machines against the database).
 */
import { describe, expect, it } from 'vitest';
import { createMachine, type AnyStateMachine } from 'xstate';
import { gmp, type MachineDescriptor } from '../../src/state/definition.ts';
import { canonicalText, definitionHash, extractDefinition, MachineDefinitionError, type MachineDefinition } from '../../src/state/extract.ts';

const GO = { permission: 'demo.go' } as const;

function describeMachine(machine: AnyStateMachine, overrides: Partial<Omit<MachineDescriptor, 'machine'>> = {}): MachineDescriptor {
  return {
    code: 'demo',
    version: 1,
    aggregateType: 'demo_record',
    description: 'extractor test machine',
    createPermission: 'demo.create',
    seedFile: '0599_never.sql',
    machine,
    ...overrides,
  };
}

/** Builds a machine from a configuration XState accepts but its types may not (e.g. malformed meta). */
function looseMachine(config: object): AnyStateMachine {
  return createMachine(config as never);
}

/** Machine `demo` with states A (configured here) and B (final); `root` adds keys to the root. */
function machineWith(a: object, root: object = {}): AnyStateMachine {
  return looseMachine({ id: 'demo', initial: 'A', states: { A: a, B: { type: 'final' } }, ...root });
}

/** The extractor's refusal message, or 'accepted'. Any other error fails the test. */
function refusal(descriptor: MachineDescriptor): string {
  try {
    extractDefinition(descriptor);
  } catch (error) {
    if (error instanceof MachineDefinitionError) return error.message;
    throw error;
  }
  return 'accepted';
}

describe('extractDefinition: the descriptor', () => {
  it('[meta] the baseline machine used by the refusal tests is accepted', () => {
    expect(refusal(describeMachine(machineWith({ on: { GO: gmp('B', GO) } })))).toBe('accepted');
  });

  it('[meta] a refusal is a MachineDefinitionError naming the machine code and the problem', () => {
    const descriptor = describeMachine(machineWith({ on: { GO: gmp('B', GO) } }), { version: 0 });
    let thrown: unknown;
    try {
      extractDefinition(descriptor);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(MachineDefinitionError);
    expect(thrown).toMatchObject({ name: 'MachineDefinitionError', message: 'machine demo: the version must be a positive integer' });
  });

  it('[meta] the machine code must be lower_snake_case', () => {
    const machine = looseMachine({ id: 'Demo', initial: 'A', states: { A: { on: { GO: gmp('B', GO) } }, B: { type: 'final' } } });
    expect(refusal(describeMachine(machine, { code: 'Demo' }))).toBe('machine Demo: the code must be lower_snake_case');
  });

  it('[meta] the XState id must equal the machine code', () => {
    const machine = looseMachine({ id: 'other', initial: 'A', states: { A: { on: { GO: gmp('B', GO) } }, B: { type: 'final' } } });
    expect(refusal(describeMachine(machine))).toBe('machine demo: the XState id other must equal the machine code');
  });

  it('[meta] the version must be a positive integer', () => {
    const machine = machineWith({ on: { GO: gmp('B', GO) } });
    for (const version of [0, -1, 1.5, Number.NaN]) {
      expect([version, refusal(describeMachine(machine, { version }))]).toEqual([version, 'machine demo: the version must be a positive integer']);
    }
    expect(extractDefinition(describeMachine(machine, { version: 2 })).version).toBe(2);
  });

  it('[meta] the aggregate type must be lower_snake_case', () => {
    const machine = machineWith({ on: { GO: gmp('B', GO) } });
    expect(refusal(describeMachine(machine, { aggregateType: 'DemoRecord' }))).toBe('machine demo: the aggregate type must be lower_snake_case');
  });

  it('[DI-17] the create permission must be a dotted lower_snake name', () => {
    const machine = machineWith({ on: { GO: gmp('B', GO) } });
    for (const createPermission of ['demo', 'Demo.create', 'demo.Create', 'demo..create']) {
      expect([createPermission, refusal(describeMachine(machine, { createPermission }))]).toEqual([
        createPermission,
        'machine demo: the create permission must be a dotted lower_snake name (DI-17: creating an aggregate is a permission)',
      ]);
    }
  });
});

describe('extractDefinition: the root and the initial state', () => {
  it('[meta] the root must be a compound state', () => {
    const message = 'machine demo: the root must be a compound state with child states';
    expect(refusal(describeMachine(looseMachine({ id: 'demo' })))).toBe(message);
    expect(refusal(describeMachine(looseMachine({ id: 'demo', type: 'parallel', states: { A: {}, B: {} } })))).toBe(message);
  });

  it('[meta] the root may have no transitions, entry or exit actions or invocations, each on its own', () => {
    const message = 'machine demo: the root may not have transitions, actions or invocations';
    const roots: [string, object][] = [
      ['transition', { on: { RESET: '.A' } }],
      ['entry action', { entry: () => undefined }],
      ['exit action', { exit: () => undefined }],
      ['invocation', { invoke: { src: 'worker' } }],
    ];
    for (const [name, root] of roots) {
      expect([name, refusal(describeMachine(machineWith({ on: { GO: gmp('B', GO) } }, root)))]).toEqual([name, message]);
    }
  });

  it('[meta] the initial state must name a child state (XState resolves "toString" to an inherited function)', () => {
    const machine = looseMachine({ id: 'demo', initial: 'toString', states: { A: { on: { GO: gmp('B', GO) } }, B: { type: 'final' } } });
    expect(refusal(describeMachine(machine))).toBe('machine demo: exactly one initial state is required');
  });
});

describe('extractDefinition: states', () => {
  it('[meta] state names must be UPPER_SNAKE_CASE', () => {
    const machine = looseMachine({ id: 'demo', initial: 'draft', states: { draft: { on: { GO: gmp('DONE', GO) } }, DONE: { type: 'final' } } });
    expect(refusal(describeMachine(machine))).toBe('machine demo: state draft must be UPPER_SNAKE_CASE');
  });

  it('[meta] only flat atomic and final states are allowed: nested and history states are refused', () => {
    const nested = machineWith({ initial: 'X', states: { X: {} }, on: { GO: gmp('B', GO) } });
    expect(refusal(describeMachine(nested))).toBe('machine demo: state A is compound; only flat atomic and final states are supported');
    const history = looseMachine({ id: 'demo', initial: 'A', states: { H: { type: 'history' }, A: { on: { GO: gmp('B', GO) } }, B: { type: 'final' } } });
    expect(refusal(describeMachine(history))).toBe('machine demo: state H is history; only flat atomic and final states are supported');
  });

  it('[meta] a state may have no entry or exit actions or invocations, each on its own', () => {
    const message = 'machine demo: state A may not have actions or invocations';
    const states: [string, object][] = [
      ['entry action', { entry: () => undefined }],
      ['exit action', { exit: () => undefined }],
      ['invocation', { invoke: { src: 'worker' } }],
      // XState schedules a delayed transition with entry and exit actions.
      ['delayed transition', { after: { 1000: gmp('B', GO) } }],
    ];
    for (const [name, extra] of states) {
      expect([name, refusal(describeMachine(machineWith({ on: { GO: gmp('B', GO) }, ...extra })))]).toEqual([name, message]);
    }
  });

  it('[meta] a state may have no eventless (always) transitions', () => {
    expect(refusal(describeMachine(machineWith({ always: gmp('B', GO), on: { GO: gmp('B', GO) } })))).toBe(
      'machine demo: state A may not have eventless (always) transitions',
    );
  });
});

describe('extractDefinition: transitions', () => {
  it('[meta] event names must be UPPER_SNAKE_CASE; wildcard events are refused', () => {
    for (const event of ['go', '*']) {
      expect(refusal(describeMachine(machineWith({ on: { [event]: gmp('B', GO) } })))).toBe(
        `machine demo: event ${event} in A must be UPPER_SNAKE_CASE (delayed, wildcard and internal events are not supported)`,
      );
    }
  });

  it('[meta] exactly one transition per state and event: alternatives and empty lists are refused', () => {
    const alternatives = looseMachine({ id: 'demo', initial: 'A', states: { A: { on: { GO: [gmp('B', GO), gmp('C', GO)] } }, B: { type: 'final' }, C: { type: 'final' } } });
    expect(refusal(describeMachine(alternatives))).toBe('machine demo: A has 2 transitions for GO; a GMP machine has exactly one');
    expect(refusal(describeMachine(machineWith({ on: { GO: [] } })))).toBe('machine demo: A has 0 transitions for GO; a GMP machine has exactly one');
  });

  it('[meta] an XState guard is refused even when the transition carries GMP metadata', () => {
    expect(refusal(describeMachine(machineWith({ on: { GO: { ...gmp('B', GO), guard: () => true } } })))).toBe(
      'machine demo: A GO: put guard codes in meta.guards via gmp(), not in an XState guard',
    );
  });

  it('[meta] transition actions are refused even when the transition carries GMP metadata', () => {
    expect(refusal(describeMachine(machineWith({ on: { GO: { ...gmp('B', GO), actions: () => undefined } } })))).toBe(
      'machine demo: A GO: transitions may not have actions',
    );
  });

  it('[meta] a transition needs exactly one target, and it must be a sibling state', () => {
    const message = 'machine demo: A GO: exactly one sibling target state is required';
    const meta = { permission: 'demo.go' };
    const targets: [string, object][] = [
      ['no target', { meta }],
      ['two targets', { target: ['B', 'C'], meta }],
      ['an undefined target', { target: [undefined], meta }],
      ['the root itself', { target: '#demo', meta }],
    ];
    for (const [name, go] of targets) {
      const machine = looseMachine({ id: 'demo', initial: 'A', states: { A: { on: { GO: go } }, B: { type: 'final' }, C: { type: 'final' } } });
      expect([name, refusal(describeMachine(machine))]).toEqual([name, message]);
    }
    const intoNested = looseMachine({ id: 'demo', initial: 'A', states: { A: { on: { GO: gmp('B.X', GO) } }, B: { initial: 'X', states: { X: {} } } } });
    expect(refusal(describeMachine(intoNested))).toBe(message);
  });
});

describe('extractDefinition: transition metadata', () => {
  it('[DI-17] a transition without GMP metadata is refused: it names no permission', () => {
    expect(refusal(describeMachine(machineWith({ on: { GO: 'B' } })))).toBe('machine demo: A GO: every transition needs a permission (DI-17); write it with gmp()');
  });

  it('[meta] metadata that is not an object is refused', () => {
    for (const meta of ['demo.go', 7, null]) {
      expect([meta, refusal(describeMachine(machineWith({ on: { GO: { target: 'B', meta } } })))]).toEqual([meta, 'machine demo: A GO: meta must come from gmp()']);
    }
  });

  it('[meta] unknown metadata keys are refused and all of them are named', () => {
    expect(refusal(describeMachine(machineWith({ on: { GO: { target: 'B', meta: { permission: 'demo.go', role: 'QA' } } } })))).toBe(
      'machine demo: A GO: unknown meta keys role',
    );
    expect(refusal(describeMachine(machineWith({ on: { GO: { target: 'B', meta: { permission: 'demo.go', role: 'QA', note: 'x' } } } })))).toBe(
      'machine demo: A GO: unknown meta keys role, note',
    );
  });

  it('[meta] guards and signature may be left out: no guards and no signature', () => {
    const def = extractDefinition(describeMachine(machineWith({ on: { GO: { target: 'B', meta: { permission: 'demo.go' } } } })));
    expect(def.transitions).toEqual([{ from: 'A', event: 'GO', to: 'B', guards: [], signature: null, permission: 'demo.go' }]);
  });

  it('[meta] guard codes must be a list of dotted lower_snake strings', () => {
    const message = 'machine demo: A GO: guard codes must be dotted lower_snake names';
    for (const guards of ['demo.check', ['Check'], ['demo'], [1], [['demo.check']]]) {
      const meta = { guards, permission: 'demo.go' };
      expect([guards, refusal(describeMachine(machineWith({ on: { GO: { target: 'B', meta } } })))]).toEqual([guards, message]);
    }
  });

  it('[meta] a guard listed twice is refused; distinct guards keep the order written', () => {
    expect(refusal(describeMachine(machineWith({ on: { GO: gmp('B', { guards: ['demo.check', 'demo.check'], permission: 'demo.go' }) } })))).toBe(
      'machine demo: A GO: a guard is listed twice',
    );
    const def = extractDefinition(describeMachine(machineWith({ on: { GO: gmp('B', { guards: ['demo.z_last', 'demo.a_first'], permission: 'demo.go' }) } })));
    expect(def.transitions[0]?.guards).toEqual(['demo.z_last', 'demo.a_first']);
  });

  it('[meta] the signature meaning must be an UPPER_SNAKE_CASE string', () => {
    const message = 'machine demo: A GO: the signature meaning must be UPPER_SNAKE_CASE';
    for (const signature of ['approved', 'Approved', 7, ['APPROVED']]) {
      const meta = { signature, permission: 'demo.go' };
      expect([signature, refusal(describeMachine(machineWith({ on: { GO: { target: 'B', meta } } })))]).toEqual([signature, message]);
    }
    const def = extractDefinition(describeMachine(machineWith({ on: { GO: gmp('B', { signature: 'APPROVED', permission: 'demo.go' }) } })));
    expect(def.transitions[0]?.signature).toBe('APPROVED');
  });

  it('[DI-17] every transition names its permission', () => {
    expect(refusal(describeMachine(machineWith({ on: { GO: gmp('B') } })))).toBe('machine demo: A GO: every transition needs a permission (DI-17)');
    expect(refusal(describeMachine(machineWith({ on: { GO: { target: 'B', meta: { guards: [] } } } })))).toBe(
      'machine demo: A GO: every transition needs a permission (DI-17)',
    );
  });

  it('[DI-17] the permission must be a dotted lower_snake string', () => {
    const message = 'machine demo: A GO: the permission must be a dotted lower_snake name';
    for (const permission of ['Approve', 'demo', 'demo.Go', ['demo.go'], 7]) {
      expect([permission, refusal(describeMachine(machineWith({ on: { GO: { target: 'B', meta: { permission } } } })))]).toEqual([permission, message]);
    }
  });
});

describe('extractDefinition: the extracted definition', () => {
  it('[meta] states, final states and transitions come out in code-unit order with their metadata', () => {
    const machine = looseMachine({
      id: 'demo',
      initial: 'DRAFT',
      states: {
        REVIEW: {
          on: {
            RETURN: { target: 'DRAFT', meta: { permission: 'demo.submit' } },
            APPROVE: gmp('APPROVED', { guards: ['demo.z_last', 'demo.a_first'], signature: 'APPROVED', permission: 'demo.approve' }),
          },
        },
        DRAFT: { on: { SUBMIT: gmp('REVIEW', { permission: 'demo.submit' }), CANCEL: gmp('CANCELLED', { permission: 'demo.cancel' }) } },
        RE_OPENED: { on: { SUBMIT: gmp('REVIEW', { permission: 'demo.submit' }) } },
        REOPEN: { on: { GO: gmp('RE_OPENED', { permission: 'demo.go' }) } },
        CANCELLED: { type: 'final' },
        APPROVED: { type: 'final' },
      },
    });
    expect(extractDefinition(describeMachine(machine, { version: 3, description: 'review flow' }))).toEqual({
      machine: 'demo',
      version: 3,
      aggregate_type: 'demo_record',
      description: 'review flow',
      create_permission: 'demo.create',
      initial: 'DRAFT',
      // '_' (0x5F) sorts after every capital letter in code-unit order (COLLATE "C").
      states: ['APPROVED', 'CANCELLED', 'DRAFT', 'REOPEN', 'REVIEW', 'RE_OPENED'],
      final_states: ['APPROVED', 'CANCELLED'],
      transitions: [
        { from: 'DRAFT', event: 'CANCEL', to: 'CANCELLED', guards: [], signature: null, permission: 'demo.cancel' },
        { from: 'DRAFT', event: 'SUBMIT', to: 'REVIEW', guards: [], signature: null, permission: 'demo.submit' },
        { from: 'REOPEN', event: 'GO', to: 'RE_OPENED', guards: [], signature: null, permission: 'demo.go' },
        { from: 'REVIEW', event: 'APPROVE', to: 'APPROVED', guards: ['demo.z_last', 'demo.a_first'], signature: 'APPROVED', permission: 'demo.approve' },
        { from: 'REVIEW', event: 'RETURN', to: 'DRAFT', guards: [], signature: null, permission: 'demo.submit' },
        { from: 'RE_OPENED', event: 'SUBMIT', to: 'REVIEW', guards: [], signature: null, permission: 'demo.submit' },
      ],
    });
  });
});

describe('canonicalText and definitionHash', () => {
  // Hand-built, in no particular order: canonicalText must sort exactly as the SQL function does
  // (states, final states, then transitions by from-state and event, all in code-unit order) and
  // write a missing signature or permission as an empty field, as SQL's coalesce does.
  const shuffled: MachineDefinition = {
    machine: 'demo',
    version: 3,
    aggregate_type: 'demo_record',
    description: 'not part of the canonical text',
    create_permission: 'demo.create',
    initial: 'DRAFT',
    states: ['REVIEW', 'RE_OPENED', 'DRAFT', 'REOPEN', 'APPROVED', 'CANCELLED'],
    final_states: ['CANCELLED', 'APPROVED'],
    transitions: [
      { from: 'REVIEW', event: 'RETURN', to: 'DRAFT', guards: [], signature: null, permission: 'demo.submit' },
      { from: 'RE_OPENED', event: 'SUBMIT', to: 'REVIEW', guards: [], signature: null, permission: null },
      { from: 'DRAFT', event: 'SUBMIT', to: 'REVIEW', guards: [], signature: null, permission: 'demo.submit' },
      { from: 'REVIEW', event: 'APPROVE', to: 'APPROVED', guards: ['demo.z_last', 'demo.a_first'], signature: 'APPROVED', permission: 'demo.approve' },
      { from: 'REOPEN', event: 'GO', to: 'RE_OPENED', guards: [], signature: null, permission: 'demo.go' },
      { from: 'DRAFT', event: 'CANCEL', to: 'CANCELLED', guards: [], signature: null, permission: 'demo.cancel' },
    ],
  };
  const expected = [
    'machine=demo',
    'version=3',
    'aggregate_type=demo_record',
    'initial=DRAFT',
    'states=APPROVED,CANCELLED,DRAFT,REOPEN,REVIEW,RE_OPENED',
    'final=APPROVED,CANCELLED',
    'create=demo.create',
    'transition=DRAFT|CANCEL|CANCELLED|||demo.cancel',
    'transition=DRAFT|SUBMIT|REVIEW|||demo.submit',
    'transition=REOPEN|GO|RE_OPENED|||demo.go',
    'transition=REVIEW|APPROVE|APPROVED|demo.z_last,demo.a_first|APPROVED|demo.approve',
    'transition=REVIEW|RETURN|DRAFT|||demo.submit',
    'transition=RE_OPENED|SUBMIT|REVIEW|||',
  ].join('\n');

  it('[meta] the canonical text is sorted in code-unit order whatever the input order, with empty fields for a missing signature or permission', () => {
    expect(canonicalText(shuffled)).toBe(expected);
    expect(canonicalText({ ...shuffled, transitions: [...shuffled.transitions].reverse(), states: [...shuffled.states].reverse() })).toBe(expected);
  });

  it('[meta] canonicalText leaves the definition it reads unchanged', () => {
    const copy = structuredClone(shuffled);
    canonicalText(shuffled);
    expect(shuffled).toEqual(copy);
  });

  it('[meta] the definition hash is the SHA-256 (hex) of the UTF-8 canonical text and changes with any field', () => {
    // Expected values computed outside Node (sha256sum over the expected text above).
    expect(definitionHash(shuffled)).toBe('b672ce952164ee035c9b6567f488b955625896414bc98227f7f91707e7d58d75');
    expect(definitionHash({ ...shuffled, aggregate_type: 'démo_record' })).toBe('6f3973f7350954f255de481d47f537f3b02d5fe0f02ec859213f3d14121ec100');
    expect(definitionHash({ ...shuffled, description: 'another description' })).toBe(definitionHash(shuffled));
    expect(definitionHash({ ...shuffled, version: 4 })).not.toBe(definitionHash(shuffled));
  });
});
