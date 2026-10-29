/**
 * TB-03@1 Solution and suspension preparation with use-by: binder, film coat, enteric and sugar syrup (tablets spec
 * B.2 TB-03; Phase 3 slice 3b). Controls IN-36 (f), IN-13, PR-30, IN-37.
 *
 * The MBR sets the kind of solution, the solvent, the maximum hold from the end of preparation to the end of its use
 * (the use-by, mandatory: from hold-time data) and the appearance criterion. The solution is made for this batch only.
 *
 * Entries:
 *   PREPARED  once: the quantity prepared and the appearance. The use-by timer starts here, at the server's time:
 *             the block writes preparedAtUs (the entry's database time) and useByUs (preparedAtUs + the MBR's use-by).
 *             An appearance that does not comply raises SOLUTION_APPEARANCE (the steps after it wait for a deviation).
 *   DISCARD   the remainder disposed of, with the method (after PREPARED, in the prepared unit).
 * Every use of the solution names its PREPARED entry (TB-04 BINDER_ADDITION) and is refused once the use-by has passed
 * at the time of the use's own row (database time, tablets 0850), and the total used never exceeds what was prepared.
 * Before PERFORMED: the solution was prepared. The MBR's hold time of the solution intermediate (G-15, the engine's
 * TIME_MAX_BREACH that stops the consuming step until QA decides) applies as well when the step produces one.
 *
 * The database holds the same rules (tablets 0850).
 */
import { Dec } from '@ebmr/expr';
import {
  DURATION,
  durationUs,
  POSITIVE_QUANTITY,
  problem,
  quantityOf,
  refuse,
  type BlockVersion,
  type Config,
  type ConfigProblem,
  type EntryResult,
  type HandlerView,
  type Entry,
} from './granulation/common.ts';
import { S } from './summaries.ts';

const CONTROLS = ['IN-36', 'IN-13', 'PR-30', 'IN-37'];

/** The use-by of a TB-03 step's configuration, in microseconds. */
export function useByUs(config: Config): bigint | undefined {
  return durationUs(config['useBy']);
}

function acceptPrepared(view: HandlerView, entry: Entry): EntryResult {
  if (view.entries('PREPARED').length > 0) return refuse('TB03-TWICE', `${view.stepKey} already records its preparation`, ['IN-36']);
  const limit = useByUs(view.config);
  if (limit === undefined) return refuse('TB03-NO-USE-BY', `${view.phase.id} has no use-by in its MBR`, ['IN-36', 'PR-30']);
  const quantity = quantityOf(entry['quantity']);
  const complies = entry['appearance'] === 'COMPLIES';
  return {
    ok: true,
    data: {
      quantity,
      appearance: entry['appearance'],
      preparedAtUs: view.nowUs.toString(),
      useByUs: (view.nowUs + limit).toString(),
      preparedBy: view.actor.id,
    },
    ...(complies
      ? {}
      : {
          exceptions: [
            {
              type: 'SOLUTION_APPEARANCE',
              title: `The ${(typeof view.config['solutionType'] === 'string' ? view.config['solutionType'] : 'prepared').toLowerCase().replace('_', ' ')} solution of ${view.stepKey} does not meet its appearance criterion: the steps after it wait for a deviation`,
              controls: ['IN-36', 'PR-29'],
              severity: 'ACTION',
              category: 'OUT_OF_LIMIT',
              blocks: 'DOWNSTREAM',
              until: 'DEVIATION',
              deviationRequired: true,
            },
          ],
        }),
  };
}

function acceptDiscard(view: HandlerView, entry: Entry): EntryResult {
  const prepared = view.entries('PREPARED')[0];
  if (!prepared) return refuse('TB03-NOT-PREPARED', `${view.stepKey} has no preparation yet`, ['IN-36']);
  const q = quantityOf(entry['quantity']);
  const p = quantityOf(prepared.data['quantity']);
  const discarded = view.entries('DISCARD').map((e) => quantityOf(e.data['quantity']));
  if (!q || !p || q.unit !== p.unit || discarded.reduce((acc, d) => acc.plus(Dec.parse(d?.value ?? '0')), Dec.parse(q.value)).gt(Dec.parse(p.value))) {
    return refuse('TB03-DISCARD', `What is discarded is in the prepared unit (${p?.unit ?? '-'}) and never more than was prepared`, ['IN-36', 'PR-30']);
  }
  return { ok: true, data: { quantity: q, method: entry['method'], discardedBy: view.actor.id } };
}

function checkConfig(phase: Parameters<NonNullable<BlockVersion['checkConfig']>>[0], config: Config): ConfigProblem[] {
  const us = useByUs(config);
  return us === undefined || us <= 0n
    ? [{ code: 'TB03-USE-BY', severity: 'ERROR', message: `Solution step ${phase.id} needs a positive use-by, a whole number of microseconds (from hold-time data)`, controls: ['IN-36', 'PR-30'] }]
    : [];
}

export const TB03: BlockVersion = {
  type: 'TB-03',
  version: '1',
  title: 'Solution preparation with use-by',
  edition: 'tablets',
  aliases: { tablets: 'TB-03' },
  level: 'PHASE',
  controls: CONTROLS,
  configSchema: {
    type: 'object',
    description: 'Kind of solution, solvent, the use-by from the end of preparation and the appearance criterion',
    fields: {
      solutionType: { type: 'string', enum: ['BINDER', 'FILM_COAT', 'ENTERIC', 'SUGAR_SYRUP'], description: 'Binder, film coat, enteric or sugar syrup' },
      solvent: { type: 'string', enum: ['PURIFIED_WATER', 'ORGANIC'], description: 'Purified water or an organic solvent (flameproof area)' },
      useBy: { ...DURATION, description: 'Maximum hold from the end of preparation to the end of use (from hold-time data)' },
      appearance: { type: 'string', optional: true, description: 'Appearance criterion' },
    },
  },
  entrySummaries: {
    PREPARED: (d) => `Prepared ${S.qty(d['quantity'])}, appearance ${S.words(d['appearance'])}`,
    DISCARD: (d) => `Discarded ${S.qty(d['quantity'])}: ${S.val(d['method'])}`,
  },
  dataSchema: {
    entries: {
      PREPARED: {
        type: 'object',
        description: 'The solution is prepared; the use-by timer starts',
        fields: { quantity: POSITIVE_QUANTITY, appearance: { type: 'string', enum: ['COMPLIES', 'DOES_NOT_COMPLY'], description: 'Against the MBR criterion' } },
      },
      DISCARD: {
        type: 'object',
        description: 'The remainder disposed of',
        fields: { quantity: POSITIVE_QUANTITY, method: { type: 'string', description: 'How it was disposed of' } },
      },
    },
  },
  checkConfig,
  handler: {
    acceptEntry: (view, entry) => {
      if (entry.kind === 'PREPARED') return acceptPrepared(view, entry);
      if (entry.kind === 'DISCARD') return acceptDiscard(view, entry);
      return refuse('TB03-ENTRY', `${entry.kind} is not an entry of a solution step`, ['IN-36']);
    },
    beforePerform: (view) => (view.entries('PREPARED').length === 0 ? [problem('TB03-NOT-PREPARED', `${view.stepKey} has no preparation yet`, ['IN-36'])] : []),
  },
  exceptionRules: [{ type: 'SOLUTION_APPEARANCE', category: 'OUT_OF_LIMIT', severity: 'ACTION', summary: 'A solution that does not meet its appearance criterion', controls: ['IN-36', 'PR-29'] }],
  simulatorModel: {
    exceptionTypes: () => ['SOLUTION_APPEARANCE'],
    nominalEntries: () => [{ kind: 'PREPARED', quantity: { value: '12.000', unit: 'kg' }, appearance: 'COMPLIES' }],
  },
  goldenFixture: {
    description: 'A binder solution of 12.000 kg prepared (use-by 4 h from preparation, at the server time), 0.300 kg remainder discarded; performed and verified',
    controls: ['IN-36', 'PR-30'],
    phase: {
      block: { type: 'TB-03', version: '1' },
      config: { solutionType: 'BINDER', solvent: 'PURIFIED_WATER', useBy: { value: '4', unit: 'h' }, appearance: 'Clear, colourless' },
    },
    script: [
      { entry: { kind: 'PREPARED', quantity: { value: '12.000', unit: 'kg' }, appearance: 'COMPLIES' } },
      { advanceUs: 3_600_000_000n },
      { entry: { kind: 'DISCARD', quantity: { value: '0.300', unit: 'kg' }, method: 'Drain to effluent treatment' } },
    ],
    expect: { exceptions: [], status: 'COMPLETED' },
  },
  tests: ['apps/tablets-server/test/blocks/granulation/blocks.test.ts', 'apps/tablets-server/test/blocks/granulation/db-guards.test.ts'],
};
