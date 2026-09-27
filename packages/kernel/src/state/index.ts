/** State-machine engine: XState definitions, generated DB transition tables, transitions. See README.md. */
export { gmp, type GmpTransitionMeta, type GmpTransitionOptions, type MachineDescriptor } from './definition.ts';
export {
  canonicalText,
  definitionHash,
  extractDefinition,
  MachineDefinitionError,
  type MachineDefinition,
  type TransitionRow,
} from './extract.ts';
export { machineSeedSql } from './seed.ts';
export {
  createAggregateState,
  getAggregateState,
  transition,
  type AggregateRef,
  type AggregateState,
  type GuardResult,
  type TransitionRequest,
  type TransitionResult,
} from './engine.ts';
export { KERNEL_MACHINES, SAMPLE_RECORD_V1, sampleRecordMachine, type PublishedMachine } from './machines/index.ts';
