/**
 * Every published machine version of the kernel, with the source file its seed is generated
 * from. Add a new entry (never edit a published one) when a machine changes.
 */
import type { MachineDescriptor } from '../definition.ts';
import { SAMPLE_RECORD_V1 } from './sample-record.ts';

export interface PublishedMachine {
  descriptor: MachineDescriptor;
  /** Repository-relative path of the TypeScript source, written into the generated header. */
  source: string;
}

export const KERNEL_MACHINES: readonly PublishedMachine[] = [
  { descriptor: SAMPLE_RECORD_V1, source: 'packages/kernel/src/state/machines/sample-record.ts' },
];

export { SAMPLE_RECORD_V1, sampleRecordMachine } from './sample-record.ts';
