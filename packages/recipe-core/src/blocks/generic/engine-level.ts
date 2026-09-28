/**
 * Generic blocks that are not flow phases, version 1: the engine itself implements them (outline 6.6;
 * flow/blocks.ts marks them "not a phase"). The registry holds their contract so their controls,
 * exception rules and missing rendering parts are reported like any other block version.
 *   G-01 issuance and header (batch level), G-02 stage frame and summary (stage level), G-17 QA hold
 *   point (hold points), G-18 exception and deviation link (service), G-19 flow control (constructs).
 */
import { ENGINE_EXCEPTION_RULES } from '../../engine/exceptions.ts';
import type { BlockVersion, ExceptionRule } from '../contract.ts';

const rules = (...types: string[]): ExceptionRule[] => ENGINE_EXCEPTION_RULES.filter((r) => types.includes(r.type));
const none = { exceptionTypes: () => [], nominalEntries: () => [] };

export const G01: BlockVersion = {
  type: 'G-01',
  version: '1',
  title: 'Issuance and header',
  edition: 'generic',
  aliases: { tablets: 'K-01', injectables: 'KB-01' },
  level: 'BATCH',
  controls: ['PR-01', 'PR-10', 'IN-18', 'IN-30', 'IN-52', 'DI-42'],
  configSchema: {
    type: 'object',
    description: 'The issue request (engine IssueRequest): batch number, approved batch size, market set, variants, header and master-data inputs',
    fields: {
      batchNumber: { type: 'string', description: 'From the allocation register (never reused, IN-18)' },
      batchSize: { type: 'string', description: 'One of the approved discrete batch sizes (PR-01)' },
      marketSet: { type: 'array', items: { type: 'string', description: 'Market code' }, minItems: 1, description: 'India always included (IN-52)' },
    },
  },
  dataSchema: { entries: {} },
  engineImplementation: ['engine/engine.ts issue()', 'engine/batch.ts initialState()'],
  exceptionRules: [],
  simulatorModel: none,
  tests: ['packages/recipe-core/test/engine/issue.test.ts'],
};

export const G02: BlockVersion = {
  type: 'G-02',
  version: '1',
  title: 'Stage frame and summary',
  edition: 'generic',
  aliases: { tablets: 'K-02' },
  level: 'STAGE',
  controls: ['PR-16', 'IN-15', 'PR-08'],
  configSchema: { type: 'object', description: 'Stage binding and responsible role come from the MBR stage', fields: {} },
  dataSchema: { entries: {} },
  engineImplementation: ['engine/advance.ts (stage closer waits for sign-off)', 'engine/steps.ts signOffStage() (derived summary, never typed)'],
  exceptionRules: [],
  simulatorModel: none,
  tests: ['packages/recipe-core/test/engine/stage.test.ts'],
};

export const G17: BlockVersion = {
  type: 'G-17',
  version: '1',
  title: 'QA hold point',
  edition: 'generic',
  aliases: { tablets: 'K-16', injectables: 'KB-12' },
  level: 'HOLD_POINT',
  controls: ['PR-45', 'IN-37'],
  configSchema: { type: 'object', description: 'Role and dispositions come from the MBR hold point', fields: {} },
  dataSchema: { entries: {} },
  engineImplementation: ['engine/steps.ts dispositionHoldPoint()'],
  exceptionRules: rules('HOLD_POINT_NOT_APPROVED'),
  simulatorModel: { exceptionTypes: () => ['HOLD_POINT_NOT_APPROVED'], nominalEntries: () => [] },
  tests: ['packages/recipe-core/test/engine/hold-point.test.ts'],
};

export const G18: BlockVersion = {
  type: 'G-18',
  version: '1',
  title: 'Exception and deviation link',
  edition: 'generic',
  aliases: { tablets: 'S-4', injectables: 'KB-13' },
  level: 'SERVICE',
  controls: ['PR-13', 'PR-49', 'PR-50', 'PR-51', 'DI-26'],
  configSchema: { type: 'object', description: 'Exceptions are raised by blocks and the engine; no configuration', fields: {} },
  dataSchema: { entries: {} },
  engineImplementation: ['engine/batch.ts raiseException(), attachDeviation(), dispositionException()', 'engine/exceptions.ts (tiers, blocking)'],
  exceptionRules: rules('OPERATOR_RAISED'),
  simulatorModel: none,
  tests: ['packages/recipe-core/test/engine/exceptions.test.ts'],
};

export const G19: BlockVersion = {
  type: 'G-19',
  version: '1',
  title: 'Flow control (incl. replicate)',
  edition: 'generic',
  aliases: { tablets: 'K-17/K-25', injectables: 'KB-14' },
  level: 'CONSTRUCT',
  controls: ['DI-34', 'PR-13', 'INV-19'],
  configSchema: { type: 'object', description: 'Constructs come from the MBR flow (parallel, alternative, loop, replicate)', fields: {} },
  dataSchema: { entries: {} },
  engineImplementation: ['engine/advance.ts (token advance, decisions, not-applicable branches, sub-lots)', 'engine/steps.ts chooseAlternative(), chooseReplicateCount(), completeLoopIteration()'],
  exceptionRules: rules('LOOP_EXHAUSTED', 'REPLICATE_COUNT_INVALID', 'DECISION_NOT_EVALUABLE', 'DECISION_AFFECTING_CORRECTION'),
  simulatorModel: { exceptionTypes: () => ['LOOP_EXHAUSTED', 'DECISION_NOT_EVALUABLE'], nominalEntries: () => [] },
  tests: ['packages/recipe-core/test/engine/flow.test.ts', 'packages/recipe-core/test/engine/model.test.ts'],
};

export const ENGINE_LEVEL_BLOCKS: readonly BlockVersion[] = [G01, G02, G17, G18, G19];
