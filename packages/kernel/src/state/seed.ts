/**
 * Generates the migration that publishes a machine version from its XState definition. The
 * committed migration must equal this output (test/platform/machine-consistency.test.ts), so the
 * database transition table can never drift from the XState machine.
 */
import { definitionHash, extractDefinition } from './extract.ts';
import type { MachineDescriptor } from './definition.ts';

const TAG = '$machine$';

export function machineSeedSql(descriptor: MachineDescriptor, sourcePath: string): string {
  const def = extractDefinition(descriptor);
  const body = JSON.stringify({ ...def, definition_hash: definitionHash(def) }, null, 2);
  if (body.includes(TAG)) throw new Error(`the definition of ${descriptor.code} contains ${TAG}`);
  return [
    `-- GENERATED from ${sourcePath} by packages/kernel/src/state/write-seeds.ts. Do not edit.`,
    `-- Publishes machine ${def.machine} version ${def.version} (aggregate type ${def.aggregate_type}).`,
    '-- A published version is immutable: change the machine by adding a new version and a new migration.',
    'set local role ebmr_owner;',
    '',
    `select platform.publish_machine_version(${TAG}`,
    body,
    `${TAG}::jsonb);`,
    '',
    'reset role;',
    '',
  ].join('\n');
}
